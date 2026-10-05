import { Resolver } from 'node:dns/promises';
import { request as http_request } from 'node:http';
import type { ClientRequest, IncomingMessage } from 'node:http';
import { request as https_request } from 'node:https';
import type { RequestOptions } from 'node:https';
import { isIP } from 'node:net';
import type { Socket } from 'node:net';
import { checkServerIdentity } from 'node:tls';
import { finished } from 'node:stream/promises';
import {
	createBrotliDecompress,
	createGunzip,
	createInflate,
} from 'node:zlib';
import { local_fetch_error } from './errors.js';
import {
	is_public_address,
	parse_public_url,
} from './public_address.js';
import {
	combine_request_signal,
	consume_response_bytes,
	throw_if_aborted,
} from './request_context.js';
import { with_local_fetch_slot } from './resource_limits.js';
import { ProviderError } from './types.js';

// Conservative P3A candidates. No public configuration/registration exists.
// Callers may lower limits, never raise them beyond this reviewed envelope.
export const SAFE_FETCH_LIMITS = Object.freeze({
	encoded_bytes: 5 * 1024 * 1024,
	decoded_bytes: 5 * 1024 * 1024,
	text_bytes: 5 * 1024 * 1024,
	http_bytes: 6 * 1024 * 1024,
	header_bytes: 16 * 1024,
	redirects: 5,
	total_ms: 20000,
	dns_ms: 3000,
	connect_ms: 5000,
	headers_ms: 5000,
	body_idle_ms: 3000,
	dns_answers: 32,
});
type Limits = {
	-readonly [K in keyof typeof SAFE_FETCH_LIMITS]: number;
};
export interface SafeFetchOptions {
	signal?: AbortSignal;
	limits?: Partial<Limits>;
}
export interface SafeHtmlPage {
	requested_url: string;
	final_url: string;
	content_type: 'text/html' | 'application/xhtml+xml';
	charset: string;
	html: string;
	redirects: number;
	encoded_bytes: number;
	decoded_bytes: number;
	text_bytes: number;
	http_bytes: number;
}
export interface ResolvedAddress {
	address: string;
	family: 4 | 6;
}
export interface SafeFetchDependencies {
	resolve: (
		host: string,
		signal: AbortSignal,
		timeout_ms: number,
	) => Promise<ResolvedAddress[]>;
	request: (
		url: URL,
		options: RequestOptions & { autoSelectFamily: false },
		response: (res: IncomingMessage) => void,
	) => ClientRequest;
}

const deadline = (ms: number, parent?: AbortSignal) => {
	const controller = new AbortController();
	const abort = () => controller.abort(parent?.reason);
	if (parent?.aborted) abort();
	else parent?.addEventListener('abort', abort, { once: true });
	const timer = setTimeout(
		() =>
			controller.abort(
				new DOMException('Operation timed out', 'TimeoutError'),
			),
		ms,
	);
	return {
		signal: controller.signal,
		dispose: () => {
			clearTimeout(timer);
			parent?.removeEventListener('abort', abort);
		},
	};
};

// A resolver belongs to one operation so cancellation cannot affect another.
export const resolve_public_host: SafeFetchDependencies['resolve'] =
	async (host, signal, timeout_ms) => {
		throw_if_aborted(signal);
		const resolver = new Resolver({ timeout: timeout_ms, tries: 1 });
		const abort = () => resolver.cancel();
		signal.addEventListener('abort', abort, { once: true });
		try {
			const results = await Promise.allSettled([
				resolver.resolve4(host),
				resolver.resolve6(host),
			]);
			throw_if_aborted(signal);
			const addresses: ResolvedAddress[] = [];
			for (const [index, result] of results.entries()) {
				if (result.status === 'fulfilled') {
					addresses.push(
						...result.value.map((address) => ({
							address,
							family: index === 0 ? (4 as const) : (6 as const),
						})),
					);
				} else if (
					!['ENODATA', 'ENOTFOUND'].includes(
						(result.reason as { code?: string })?.code ?? '',
					)
				) {
					throw local_fetch_error('dns_failure');
				}
			}
			return addresses;
		} finally {
			signal.removeEventListener('abort', abort);
			resolver.cancel();
		}
	};

const native_request: SafeFetchDependencies['request'] = (
	url,
	options,
	response,
) =>
	(url.protocol === 'https:' ? https_request : http_request)(
		url,
		options,
		response,
	);

const hostname = (url: URL) => url.hostname.replace(/^\[|\]$/g, '');
const canonical_address = (value: string) =>
	isIP(value) === 6 ? new URL(`http://[${value}]/`).hostname : value;

const resolve_target = async (
	url: URL,
	signal: AbortSignal,
	limits: Limits,
	resolve: SafeFetchDependencies['resolve'],
) => {
	const host = hostname(url);
	const family = isIP(host);
	const dns = deadline(limits.dns_ms, signal);
	let addresses: ResolvedAddress[];
	try {
		addresses = family
			? [{ address: host, family: family as 4 | 6 }]
			: await resolve(host, dns.signal, limits.dns_ms);
		throw_if_aborted(dns.signal);
	} catch (error) {
		throw_if_aborted(dns.signal);
		if (error instanceof ProviderError) throw error;
		throw local_fetch_error('dns_failure');
	} finally {
		dns.dispose();
	}
	if (
		!Array.isArray(addresses) ||
		addresses.length === 0 ||
		addresses.length > limits.dns_answers
	)
		throw local_fetch_error('dns_failure');
	if (
		addresses.some(
			(item) =>
				!item ||
				![4, 6].includes(item.family) ||
				isIP(item.address) !== item.family ||
				!is_public_address(item.address),
		)
	)
		throw local_fetch_error('unsafe_address');
	// No Happy Eyeballs, implicit re-resolution, connection reuse, or fallback.
	return addresses[0];
};

const checked_limits = (
	overrides: SafeFetchOptions['limits'],
): Limits => {
	const limits: Limits = { ...SAFE_FETCH_LIMITS };
	for (const [key, value] of Object.entries(overrides ?? {})) {
		if (
			!(key in limits) ||
			!Number.isSafeInteger(value) ||
			value! < (key === 'redirects' ? 0 : 1) ||
			value! > limits[key as keyof Limits]
		)
			throw new RangeError('Invalid local fetch limit');
		limits[key as keyof Limits] = value!;
	}
	return limits;
};

const content_headers = (res: IncomingMessage) => {
	const singular = new Set([
		'content-type',
		'content-encoding',
		'content-length',
		'location',
	]);
	const seen = new Set<string>();
	for (let i = 0; i < res.rawHeaders.length; i += 2) {
		const name = res.rawHeaders[i].toLowerCase();
		if (singular.has(name) && seen.has(name))
			throw local_fetch_error('unsupported_encoding');
		seen.add(name);
	}
	const raw = res.headers['content-type'] ?? '';
	const mime = raw.split(';', 1)[0].trim().toLowerCase();
	if (mime !== 'text/html' && mime !== 'application/xhtml+xml')
		throw local_fetch_error('unsupported_content');
	const parameters = raw.includes(';')
		? raw.slice(raw.indexOf(';'))
		: '';
	// Parse every parameter with a sticky cursor. Quoted semicolons are data,
	// and junk after a quoted value cannot silently become a valid charset.
	const parameter =
		/;[ \t]*([a-z0-9!#$%&'*+.^_`|~-]+)[ \t]*=[ \t]*(?:"([^"\\\r\n]*)"|([a-z0-9!#$%&'*+.^_`|~-]+))[ \t]*(?=;|$)/giy;
	let declared: string | undefined;
	while (parameter.lastIndex < parameters.length) {
		const match = parameter.exec(parameters);
		if (!match) throw local_fetch_error('unsupported_encoding');
		if (match[1].toLowerCase() === 'charset') {
			if (declared !== undefined)
				throw local_fetch_error('unsupported_encoding');
			declared = match[2] ?? match[3];
			if (!declared) throw local_fetch_error('unsupported_encoding');
		}
	}
	let charset: string | undefined;
	try {
		charset =
			declared === undefined
				? undefined
				: new TextDecoder(declared, { fatal: true }).encoding;
	} catch {
		throw local_fetch_error('unsupported_encoding');
	}
	return { mime, charset } as const;
};

const read_html = async (
	res: IncomingMessage,
	limits: Limits,
	signal: AbortSignal,
) => {
	const { mime, charset: declared_charset } = content_headers(res);
	const length = res.headers['content-length'];
	if (
		length !== undefined &&
		(!/^\d+$/.test(length) ||
			!Number.isSafeInteger(Number(length)) ||
			Number(length) > limits.encoded_bytes)
	)
		throw local_fetch_error('response_too_large');
	const encoding = (res.headers['content-encoding'] ?? 'identity')
		.trim()
		.toLowerCase();
	const decompress =
		encoding === 'gzip'
			? createGunzip({ chunkSize: 16384 })
			: encoding === 'deflate'
				? createInflate({ chunkSize: 16384 })
				: encoding === 'br'
					? createBrotliDecompress({ chunkSize: 16384 })
					: undefined;
	if (encoding !== 'identity' && !decompress)
		throw local_fetch_error('unsupported_encoding');
	// One bounded UTF-8 allocation prevents millions of tiny response chunks
	// from becoming an unbounded array of strings/buffers.
	const output = Buffer.alloc(limits.text_bytes);
	const encoder = new TextEncoder();
	let decoder: TextDecoder | undefined;
	let prefix = Buffer.alloc(0);
	let charset = declared_charset ?? 'utf-8';
	let encoded_bytes = 0;
	let decoded_bytes = 0;
	let text_bytes = 0;
	const append = (text: string) => {
		const encoded = encoder.encodeInto(
			text,
			output.subarray(text_bytes),
		);
		if (encoded.read !== text.length)
			throw local_fetch_error('response_too_large');
		text_bytes += encoded.written;
	};
	const decode = (chunk: Buffer, final = false) => {
		if (!decoder) {
			const input = prefix.length
				? Buffer.concat([prefix, chunk])
				: chunk;
			if (input.length < 3 && !final) {
				prefix = Buffer.from(input);
				return;
			}
			const bom =
				input[0] === 0xff && input[1] === 0xfe
					? 'utf-16le'
					: input[0] === 0xfe && input[1] === 0xff
						? 'utf-16be'
						: input[0] === 0xef &&
							  input[1] === 0xbb &&
							  input[2] === 0xbf
							? 'utf-8'
							: undefined;
			if (bom && declared_charset && bom !== declared_charset)
				throw local_fetch_error('unsupported_encoding');
			charset = bom ?? charset;
			decoder = new TextDecoder(charset, { fatal: true });
			prefix = Buffer.alloc(0);
			chunk = input;
		}
		append(decoder.decode(chunk, { stream: !final }));
	};
	let interrupted: Error | undefined;
	let decoding_failure: Error | undefined;
	let inflight: Promise<void> | undefined;
	let reject_write: ((error: Error) => void) | undefined;
	// Register before writes and handle rejection immediately. Writable end
	// can precede native final flush; only natural readable completion/error
	// is the end-of-input barrier under this decoder's ownership rules.
	const decoder_finished = decompress
		? finished(decompress, { cleanup: true }).catch(
				(error: Error) => {
					decoding_failure ??= error;
				},
			)
		: undefined;
	const check = () => {
		throw_if_aborted(signal);
		if (interrupted) throw interrupted;
		if (decoding_failure) throw decoding_failure;
	};
	const accept_decoded = (chunk: Buffer) => {
		check();
		decoded_bytes += chunk.length;
		if (decoded_bytes > limits.decoded_bytes)
			throw local_fetch_error('response_too_large');
		consume_response_bytes(chunk.length);
		decode(chunk);
	};
	// Do NOT connect this decoder to a cancellation-destroying pipeline.
	// Node may emit close/write errors before outstanding native work returns.
	// Only one write/end is issued at a time. External interruption closes
	// the HTTP source but waits for that write/end callback. A flowing data
	// callback is a native-output checkpoint: destroying HERE prevents the
	// decoder from submitting the next native output step. There is no
	// downstream async/backpressured stream and no private zlib API access.
	decompress?.on('data', (chunk: Buffer) => {
		try {
			accept_decoded(chunk);
		} catch (error) {
			decoding_failure =
				error instanceof Error
					? error
					: local_fetch_error('invalid_encoding');
			decompress.destroy(decoding_failure);
		}
	});
	decompress?.on('error', (error: Error) => {
		decoding_failure ??= error;
		// Native format errors need not invoke the pending write callback.
		// This decoder receives no external destroy/error forwarding: errors
		// originate in native completion or our synchronous data checkpoint.
		reject_write?.(error);
	});
	const write_decoder = (chunk?: Buffer) =>
		new Promise<void>((resolve, reject) => {
			reject_write = reject;
			const callback = (error?: Error | null) =>
				error ? reject(error) : resolve();
			if (chunk) decompress!.write(chunk, callback);
			else decompress!.end(callback);
		});
	const input_error = (error: Error) => {
		interrupted ??= error;
	};
	res.on('error', input_error);
	const timeout = () => {
		interrupted = new DOMException(
			'Operation timed out',
			'TimeoutError',
		);
		res.destroy(interrupted);
	};
	let idle = setTimeout(timeout, limits.body_idle_ms);
	const activity = () => {
		clearTimeout(idle);
		idle = setTimeout(timeout, limits.body_idle_ms);
	};
	res.on('data', activity);
	try {
		for await (const chunk of res) {
			check();
			encoded_bytes += (chunk as Buffer).length;
			if (encoded_bytes > limits.encoded_bytes)
				throw local_fetch_error('response_too_large');
			if (decompress) {
				inflight = write_decoder(chunk as Buffer);
				await inflight;
				inflight = undefined;
			} else accept_decoded(chunk as Buffer);
		}
		clearTimeout(idle);
		check();
		if (decompress) {
			inflight = write_decoder();
			await inflight;
			inflight = undefined;
			await decoder_finished;
		}
		check();
		decode(Buffer.alloc(0), true);
		// Older Node 22 releases lack rejectGarbageAfterEnd. The public
		// consumed-byte counter also detects ignored trailing compressed data.
		if (decompress && decompress.bytesWritten !== encoded_bytes)
			throw local_fetch_error('invalid_encoding');
		return {
			html: output.toString('utf8', 0, text_bytes),
			content_type: mime,
			charset,
			encoded_bytes,
			decoded_bytes,
			text_bytes,
		};
	} catch (error) {
		throw_if_aborted(signal);
		if (interrupted?.name === 'TimeoutError') throw interrupted;
		if (
			error instanceof ProviderError ||
			(error instanceof Error && error.name === 'TimeoutError')
		)
			throw error;
		throw local_fetch_error('invalid_encoding');
	} finally {
		clearTimeout(idle);
		res.removeListener('data', activity);
		res.removeListener('error', input_error);
		// Not a race: capacity remains reserved through the last native step.
		await inflight?.catch(() => {});
		reject_write = undefined;
		if (decompress) {
			decompress.destroy();
			await decoder_finished;
		}
	}
};

const redirect_statuses = new Set([301, 302, 303, 307, 308]);

const request_page = async (
	url: URL,
	pin: ResolvedAddress,
	signal: AbortSignal,
	limits: Limits,
	request: SafeFetchDependencies['request'],
) => {
	throw_if_aborted(signal);
	let res: IncomingMessage | undefined;
	let req: ClientRequest | undefined;
	let closed: Promise<void> | undefined;
	let connected = false;
	let socket: Socket | undefined;
	let http_bytes = 0;
	let transport_failure: Error | undefined;
	let fail_transport: (error: Error) => void = () => {};
	// Count plaintext HTTP bytes before parsing removes headers/chunk framing.
	// TLS handshake/record overhead and TCP/IP overhead are not this counter.
	const count_http_bytes = (chunk: Buffer) => {
		http_bytes += chunk.length;
		if (http_bytes > limits.http_bytes)
			fail_transport(local_fetch_error('response_too_large'));
	};
	let timer: ReturnType<typeof setTimeout> | undefined;
	const timeout = () =>
		req?.destroy(
			new DOMException('Operation timed out', 'TimeoutError'),
		);
	const abort = () => {
		try {
			throw_if_aborted(signal);
		} catch (error) {
			req?.destroy(error as Error);
		}
	};
	try {
		res = await new Promise<IncomingMessage>((resolve, reject) => {
			fail_transport = (error) => {
				transport_failure ??= error;
				reject(error);
				req?.destroy(error);
			};
			req = request(
				url,
				{
					method: 'GET',
					agent: false,
					family: pin.family,
					autoSelectFamily: false,
					lookup: (_host, _options, callback) =>
						callback(null, pin.address, pin.family),
					servername: isIP(hostname(url)) ? undefined : hostname(url),
					rejectUnauthorized: true,
					checkServerIdentity,
					maxHeaderSize: limits.header_bytes,
					insecureHTTPParser: false,
					headers: {
						'User-Agent': 'Retriever-LocalExtract/1.0',
						Accept: 'text/html, application/xhtml+xml',
						'Accept-Encoding': 'gzip, deflate, br',
						Connection: 'close',
					},
				},
				(response) => {
					res = response;
					response.on('error', () => {});
					clearTimeout(timer);
					if (!connected) {
						req?.destroy(local_fetch_error('peer_mismatch'));
						reject(local_fetch_error('peer_mismatch'));
					} else resolve(response);
				},
			);
			closed = new Promise<void>((done) => req!.once('close', done));
			// The byte cap bounds allocation. Disable Node's silent 1000-header
			// cutoff so conflicting late Content-Type/Encoding/Location survive
			// into rawHeaders and can actually be rejected.
			req.maxHeadersCount = 0;
			req.on('error', reject);
			let informational = 0;
			req.on('information', () => {
				if (++informational > 4) {
					const error = local_fetch_error('headers_too_large');
					// Reject now: a final response in this same parser turn can
					// otherwise resolve before destroy emits its async error.
					reject(error);
					req?.destroy(error);
				}
			});
			req.on('upgrade', (_response, socket) => {
				socket.destroy();
				req?.destroy(local_fetch_error('unsupported_content'));
				reject(local_fetch_error('unsupported_content'));
			});
			timer = setTimeout(timeout, limits.connect_ms);
			req.once('socket', (connection) => {
				socket = connection;
				socket.prependListener('data', count_http_bytes);
				socket.once(
					url.protocol === 'https:' ? 'secureConnect' : 'connect',
					() => {
						const address = connection.remoteAddress;
						if (
							!address ||
							!is_public_address(address) ||
							canonical_address(address) !==
								canonical_address(pin.address)
						) {
							req?.destroy(local_fetch_error('peer_mismatch'));
							return;
						}
						connected = true;
						clearTimeout(timer);
						timer = setTimeout(timeout, limits.headers_ms);
					},
				);
			});
			signal.addEventListener('abort', abort, { once: true });
			if (signal.aborted) abort();
			req.end();
		});
		throw_if_aborted(signal);
		if (transport_failure) throw transport_failure;
		if (redirect_statuses.has(res.statusCode ?? 0)) {
			const location = res.headers.location;
			if (
				!location ||
				location.length > 4096 ||
				/[\s\p{Cc}\\]/u.test(location) ||
				res.rawHeaders.filter(
					(_value, index) =>
						index % 2 === 0 &&
						res!.rawHeaders[index].toLowerCase() === 'location',
				).length !== 1
			)
				throw local_fetch_error('invalid_redirect');
			let target: URL;
			try {
				// Validate raw authorities before URL normalization can erase empty
				// credentials or non-canonical numeric addresses.
				const absolute = /^[a-z][a-z0-9+.-]*:/i.test(location)
					? location
					: location.startsWith('//')
						? url.protocol + location
						: new URL(location, url).href;
				target = parse_public_url(absolute);
			} catch {
				throw local_fetch_error('invalid_redirect');
			}
			if (url.protocol === 'https:' && target.protocol !== 'https:')
				throw local_fetch_error('redirect_downgrade');
			return { redirect: target } as const;
		}
		if (res.statusCode !== 200)
			throw local_fetch_error('upstream_status');
		const page = await read_html(res, limits, signal);
		if (transport_failure) throw transport_failure;
		return { page: { ...page, http_bytes } } as const;
	} catch (error) {
		throw_if_aborted(signal);
		if (transport_failure) throw transport_failure;
		if (
			error instanceof ProviderError ||
			(error instanceof Error && error.name === 'TimeoutError')
		)
			throw error;
		const code = (error as { code?: string })?.code ?? '';
		throw local_fetch_error(
			code === 'HPE_HEADER_OVERFLOW'
				? 'headers_too_large'
				: /CERT|TLS|SSL|SELF_SIGNED|UNABLE_TO_VERIFY/.test(code)
					? 'tls_failed'
					: 'connection_failed',
		);
	} finally {
		clearTimeout(timer);
		signal.removeEventListener('abort', abort);
		res?.destroy();
		req?.destroy();
		await closed;
		socket?.removeListener('data', count_http_bytes);
	}
};

// Dependency injection is an internal offline-test seam, never a tool option
// or an allow-private setting. The normal export always uses native transport.
export const create_safe_fetch = (
	dependencies: Partial<SafeFetchDependencies> = {},
) => {
	const resolve = dependencies.resolve ?? resolve_public_host;
	const request = dependencies.request ?? native_request;
	return async <T>(
		input: string,
		consume: (page: SafeHtmlPage, signal: AbortSignal) => Promise<T>,
		options: SafeFetchOptions = {},
	): Promise<T> => {
		const requested = parse_public_url(input);
		const limits = checked_limits(options.limits);
		const overall = deadline(
			limits.total_ms,
			combine_request_signal(options.signal),
		);
		try {
			return await with_local_fetch_slot(overall.signal, async () => {
				let url = requested;
				for (let redirects = 0; ; redirects++) {
					throw_if_aborted(overall.signal);
					const pin = await resolve_target(
						url,
						overall.signal,
						limits,
						resolve,
					);
					const result = await request_page(
						url,
						pin,
						overall.signal,
						limits,
						request,
					);
					if (result.redirect) {
						if (redirects >= limits.redirects)
							throw local_fetch_error('redirect_limit');
						url = result.redirect;
						continue;
					}
					throw_if_aborted(overall.signal);
					return consume(
						{
							...result.page,
							requested_url: requested.href,
							final_url: url.href,
							redirects,
						},
						overall.signal,
					);
				}
			});
		} finally {
			overall.dispose();
		}
	};
};

// The callback keeps the reservation through processing. It must cooperate
// with cancellation and must not retain input beyond its lease. P3B supplies
// a terminable parser; P3A does not import, install, or enable a parser.
export const safe_fetch_html = create_safe_fetch();
