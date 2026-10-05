import {
	afterAll,
	afterEach,
	beforeAll,
	describe,
	expect,
	it,
	vi,
} from 'vitest';
import {
	createServer as http_server,
	request as http_request,
} from 'node:http';
import type { RequestListener, Server } from 'node:http';
import {
	createServer as https_server,
	request as https_request,
} from 'node:https';
import { createServer as tcp_server } from 'node:net';
import type {
	AddressInfo,
	Socket,
	Server as TcpServer,
} from 'node:net';
import { Resolver } from 'node:dns/promises';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash, pbkdf2 } from 'node:crypto';
import { createHook } from 'node:async_hooks';
import type { Transform } from 'node:stream';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import {
	brotliCompressSync,
	BrotliDecompress,
	deflateSync,
	Inflate,
	gzipSync,
	Gunzip,
} from 'node:zlib';
import {
	create_safe_fetch,
	resolve_public_host,
	SAFE_FETCH_LIMITS,
} from './safe_fetch.js';
import type {
	SafeFetchDependencies,
	SafeHtmlPage,
	ResolvedAddress,
} from './safe_fetch.js';
import {
	get_local_fetch_snapshot,
	LOCAL_FETCH_RESERVATION_BYTES,
} from './resource_limits.js';
import {
	consume_response_bytes,
	MAX_REQUEST_RESPONSE_BYTES,
	run_with_request_context,
} from './request_context.js';
import {
	create_error_response,
	public_error_metadata,
} from './errors.js';

const PUBLIC = '93.184.216.34';
const addresses: ResolvedAddress[] = [{ address: PUBLIC, family: 4 }];
const keep = async (page: SafeHtmlPage) => page;
const servers: (Server | TcpServer)[] = [];
const sockets = new Set<Socket>();
let cert: Buffer;
let key: Buffer;
let certificate_dir: string;

beforeAll(() => {
	certificate_dir = mkdtempSync(join(tmpdir(), 'retriever-p3a-tls-'));
	// Synthetic, ephemeral fixture key, never a production credential.
	execFileSync(
		'openssl',
		[
			'req',
			'-x509',
			'-newkey',
			'rsa:2048',
			'-nodes',
			'-keyout',
			join(certificate_dir, 'key.pem'),
			'-out',
			join(certificate_dir, 'cert.pem'),
			'-days',
			'1',
			'-subj',
			'/CN=example.com',
			'-addext',
			'subjectAltName=DNS:example.com',
		],
		{ stdio: 'ignore' },
	);
	cert = readFileSync(join(certificate_dir, 'cert.pem'));
	key = readFileSync(join(certificate_dir, 'key.pem'));
});
afterAll(() => {
	if (certificate_dir)
		rmSync(certificate_dir, { recursive: true, force: true });
});
afterEach(async () => {
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
	vi.unstubAllEnvs();
	for (const socket of sockets) socket.destroy();
	sockets.clear();
	await Promise.all(
		servers
			.splice(0)
			.map(
				(server) =>
					new Promise<void>((resolve) =>
						server.close(() => resolve()),
					),
			),
	);
	expect(get_local_fetch_snapshot()).toMatchObject({
		active: 0,
		queued: 0,
		reserved_bytes: 0,
	});
});

const listen = async (server: Server | TcpServer) => {
	servers.push(server);
	server.on('connection', (socket) => {
		sockets.add(socket);
		socket.on('close', () => sockets.delete(socket));
	});
	await new Promise<void>((resolve) =>
		server.listen(0, '127.0.0.1', resolve),
	);
	return (server.address() as AddressInfo).port;
};

const fixture = async (
	handler: RequestListener,
	tls = false,
	trust = true,
) => {
	const port = await listen(
		tls ? https_server({ key, cert }, handler) : http_server(handler),
	);
	const pins: string[] = [];
	const urls: string[] = [];
	const resolve = vi.fn(async () => addresses);
	const request: SafeFetchDependencies['request'] = (
		url,
		options,
		response,
	) => {
		urls.push(url.href);
		expect(options).toMatchObject({
			method: 'GET',
			agent: false,
			autoSelectFamily: false,
			rejectUnauthorized: true,
			insecureHTTPParser: false,
		});
		expect(Object.keys(options.headers ?? {})).toEqual([
			'User-Agent',
			'Accept',
			'Accept-Encoding',
			'Connection',
		]);
		let pin = '';
		(
			options.lookup as (
				host: string,
				options: object,
				cb: (error: unknown, address: string, family: number) => void,
			) => void
		)(url.hostname, {}, (error, address, family) => {
			expect(error).toBeNull();
			expect(family).toBe(4);
			pin = address;
		});
		pins.push(pin);
		// Only this test seam maps a validated public destination to loopback.
		// Present the synthetic peer identity; production has no bypass option.
		const req = (tls ? https_request : http_request)(
			{
				...options,
				hostname: '127.0.0.1',
				port,
				path: url.pathname + url.search,
				...(tls && trust ? { ca: cert } : {}),
			},
			response,
		);
		req.on('socket', (socket) =>
			Object.defineProperty(socket, 'remoteAddress', {
				configurable: true,
				value: pin,
			}),
		);
		return req;
	};
	return {
		fetch: create_safe_fetch({ resolve, request }),
		resolve,
		request,
		pins,
		urls,
	};
};
const html: RequestListener = (_req, res) => {
	res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
	res.end('<p>Hello 世界</p>');
};

describe('controlled fetch transport', () => {
	it('pins actual request options, keeps URL queries, and sends no credentials or proxy request', async () => {
		vi.stubEnv('HTTP_PROXY', 'http://127.0.0.1:1');
		vi.stubEnv('HTTPS_PROXY', 'http://127.0.0.1:1');
		vi.stubGlobal(
			'fetch',
			vi.fn(() => {
				throw new Error('uncontrolled fetch');
			}),
		);
		const f = await fixture((req, res) => {
			expect(req.url).toBe('/page?edition=2');
			expect(req.headers.authorization).toBeUndefined();
			expect(req.headers.cookie).toBeUndefined();
			html(req, res);
		});
		const page = await f.fetch(
			'http://example.com/page?edition=2#part',
			async (value) => {
				expect(get_local_fetch_snapshot().reserved_bytes).toBe(
					LOCAL_FETCH_RESERVATION_BYTES,
				);
				return value;
			},
		);
		expect(f.pins).toEqual([PUBLIC]);
		expect(f.resolve).toHaveBeenCalledTimes(1);
		expect(page).toMatchObject({
			html: '<p>Hello 世界</p>',
			requested_url: 'http://example.com/page?edition=2#part',
			final_url: 'http://example.com/page?edition=2#part',
			charset: 'utf-8',
			redirects: 0,
			encoded_bytes: 19,
			decoded_bytes: 19,
			text_bytes: 19,
		});
		expect(fetch).not.toHaveBeenCalled();
	});
	it.each(
		[
			[],
			[{ address: '10.0.0.1', family: 4 }],
			[...addresses, { address: '::ffff:127.0.0.1', family: 6 }],
			[...addresses, { address: '169.254.169.254', family: 4 }],
			Array.from({ length: 33 }, () => addresses[0]),
		].map((answers) => ({ answers })),
	)(
		'rejects empty, nonpublic, mixed or oversized DNS answers before connecting: $answers',
		async ({ answers }) => {
			const request = vi.fn();
			const fetch = create_safe_fetch({
				resolve: async () => answers as ResolvedAddress[],
				request,
			});
			await expect(
				fetch('https://example.com', keep),
			).rejects.toMatchObject({
				provider: 'defuddle',
				details: { retryable: false },
			});
			expect(request).not.toHaveBeenCalled();
		},
	);
	it('revalidates every redirect and rejects a rebinding answer without a second connection', async () => {
		const f = await fixture((_req, res) => {
			res.writeHead(302, { location: '/next' });
			res.end();
		});
		f.resolve
			.mockResolvedValueOnce(addresses)
			.mockResolvedValueOnce([{ address: '127.0.0.1', family: 4 }]);
		await expect(
			f.fetch('http://example.com', keep),
		).rejects.toMatchObject({ details: { cause: 'unsafe_address' } });
		expect(f.resolve).toHaveBeenCalledTimes(2);
		expect(f.urls).toHaveLength(1);
	});
	it.each([
		'http://169.254.169.254/latest',
		'http://user:pass@example.com',
		'//user@example.com',
		'http://@example.com',
		'http://0x5db8d822/',
		'http://156?secret=1',
		'http://example.com:8000/',
		'file:///etc/passwd',
	])(
		'rejects unsafe redirect %s without following',
		async (location) => {
			const f = await fixture((_req, res) => {
				res.writeHead(302, { location });
				res.end();
			});
			await expect(
				f.fetch('http://example.com', keep),
			).rejects.toMatchObject({
				details: { cause: 'invalid_redirect' },
			});
			expect(f.urls).toHaveLength(1);
		},
	);
	it('preserves the final URL and relative redirect query', async () => {
		const f = await fixture((req, res) => {
			if (req.url === '/start') {
				res.writeHead(302, { location: '/article?version=2#code' });
				res.end();
			} else html(req, res);
		});
		const page = await f.fetch('http://example.com/start', keep);
		expect(page.final_url).toBe(
			'http://example.com/article?version=2#code',
		);
		expect(page.redirects).toBe(1);
		expect(f.resolve).toHaveBeenCalledTimes(2);
	});
	it('bounds redirect loops without reading redirect bodies', async () => {
		const f = await fixture((_req, res) => {
			res.writeHead(302, { location: '/loop' });
			res.write('x');
		});
		await expect(
			f.fetch('http://example.com', keep, {
				limits: { redirects: 2 },
			}),
		).rejects.toMatchObject({ details: { cause: 'redirect_limit' } });
		expect(f.urls).toHaveLength(3);
	});
	it('keeps TLS verification and SNI with the original name', async () => {
		const f = await fixture(html, true);
		await expect(
			f.fetch('https://example.com', keep),
		).resolves.toMatchObject({ content_type: 'text/html' });
	});
	it('rejects an untrusted certificate', async () => {
		const f = await fixture(html, true, false);
		await expect(
			f.fetch('https://example.com', keep),
		).rejects.toMatchObject({ details: { cause: 'tls_failed' } });
	});
	it('rejects a trusted certificate for a different hostname', async () => {
		const f = await fixture(html, true);
		await expect(
			f.fetch('https://other.example.com', keep),
		).rejects.toMatchObject({ details: { cause: 'tls_failed' } });
	});
	it('rejects HTTPS downgrade before the next fetch', async () => {
		const f = await fixture((_req, res) => {
			res.writeHead(302, { location: 'http://example.com' });
			res.end();
		}, true);
		await expect(
			f.fetch('https://example.com', keep),
		).rejects.toMatchObject({
			details: { cause: 'redirect_downgrade' },
		});
		expect(f.urls).toHaveLength(1);
	});
	it('rejects a socket whose actual peer does not match the pin', async () => {
		const f = await fixture(html);
		const request: SafeFetchDependencies['request'] = (
			url,
			options,
			response,
		) => {
			const req = f.request(url, options, response);
			req.on('socket', (socket) =>
				Object.defineProperty(socket, 'remoteAddress', {
					configurable: true,
					value: '8.8.8.8',
				}),
			);
			return req;
		};
		await expect(
			create_safe_fetch({ resolve: f.resolve, request })(
				'http://example.com',
				keep,
			),
		).rejects.toMatchObject({ details: { cause: 'peer_mismatch' } });
	});
});

describe('bounded response decoding', () => {
	it.each([
		['gzip', gzipSync],
		['deflate', deflateSync],
		['br', brotliCompressSync],
	] as const)(
		'counts encoded and decoded %s bytes independently',
		async (encoding, compress) => {
			const text = '<p>世界 café</p>'.repeat(100);
			const body = compress(Buffer.from(text));
			const f = await fixture((_req, res) => {
				res.writeHead(200, {
					'content-type': 'application/xhtml+xml',
					'content-encoding': encoding,
				});
				res.end(body);
			});
			const page = await f.fetch('http://example.com', keep);
			expect(page).toMatchObject({
				html: text,
				encoded_bytes: body.length,
				decoded_bytes: Buffer.byteLength(text),
				text_bytes: Buffer.byteLength(text),
			});
		},
	);
	it.each(['length', 'chunked', 'bomb', 'text-expansion'])(
		'stops oversized %s before invoking the consumer',
		async (kind) => {
			const f = await fixture((_req, res) => {
				res.writeHead(200, {
					'content-type':
						kind === 'text-expansion'
							? 'text/html; charset=windows-1252'
							: 'text/html',
					...(kind === 'length'
						? { 'content-length': '100000000' }
						: {}),
					...(kind === 'bomb' ? { 'content-encoding': 'gzip' } : {}),
				});
				res.end(
					kind === 'bomb'
						? gzipSync(Buffer.alloc(100000, 65))
						: kind === 'text-expansion'
							? Buffer.alloc(80, 128)
							: Buffer.alloc(1000, 65),
				);
			});
			const consume = vi.fn(keep);
			await expect(
				f.fetch('http://example.com', consume, {
					limits: {
						encoded_bytes: kind === 'bomb' ? 1000 : 100,
						decoded_bytes: 100,
						text_bytes: 100,
					},
				}),
			).rejects.toMatchObject({
				details: { cause: 'response_too_large' },
			});
			expect(consume).not.toHaveBeenCalled();
		},
	);
	it.each(['application/pdf', 'image/png', 'text/plain', ''])(
		'rejects unsupported content type %s',
		async (type) => {
			const f = await fixture((_req, res) => {
				res.writeHead(200, { 'content-type': type });
				res.end('not HTML');
			});
			await expect(
				f.fetch('http://example.com', keep),
			).rejects.toMatchObject({
				details: { cause: 'unsupported_content' },
			});
		},
	);
	it.each(['gzip, br', 'unknown'])(
		'rejects unsupported content encoding %s',
		async (encoding) => {
			const f = await fixture((_req, res) => {
				res.writeHead(200, {
					'content-type': 'text/html',
					'content-encoding': encoding,
				});
				res.end('x');
			});
			await expect(
				f.fetch('http://example.com', keep),
			).rejects.toMatchObject({
				details: { cause: 'unsupported_encoding' },
			});
		},
	);
	it.each([
		'text/html; charset=nonsense',
		'text/html; charset=utf-8; charset=windows-1252',
		'text/html; charset=',
	])('rejects unsupported or ambiguous charset %s', async (type) => {
		const f = await fixture((_req, res) => {
			res.writeHead(200, { 'content-type': type });
			res.end('x');
		});
		await expect(
			f.fetch('http://example.com', keep),
		).rejects.toMatchObject({
			details: { cause: 'unsupported_encoding' },
		});
	});
	it('decodes declared legacy charset and Unicode BOM', async () => {
		const f = await fixture((req, res) => {
			res.writeHead(200, {
				'content-type':
					req.url === '/latin'
						? 'text/html; charset=iso-8859-1'
						: 'text/html',
			});
			res.end(
				req.url === '/latin'
					? Buffer.from([0x63, 0x61, 0x66, 0xe9])
					: Buffer.from('﻿<p>世界</p>', 'utf16le'),
			);
		});
		await expect(
			f.fetch('http://example.com/latin', keep),
		).resolves.toMatchObject({
			html: 'café',
			charset: 'windows-1252',
		});
		await expect(
			f.fetch('http://example.com/bom', keep),
		).resolves.toMatchObject({
			html: '<p>世界</p>',
			charset: 'utf-16le',
		});
	});
	it.each(['gzip', 'utf8'])(
		'rejects malformed %s without exposing response text',
		async (kind) => {
			const f = await fixture((_req, res) => {
				res.writeHead(200, {
					'content-type': 'text/html',
					...(kind === 'gzip' ? { 'content-encoding': 'gzip' } : {}),
				});
				res.end(
					kind === 'gzip'
						? 'secret-canary'
						: Buffer.from([0xff, 0xff, 0xff]),
				);
			});
			const error = await f
				.fetch('http://example.com/private-path?token=canary', keep)
				.catch((error) => error);
			expect(error.details.cause).toBe('invalid_encoding');
			expect(
				JSON.stringify(create_error_response(error)),
			).not.toMatch(/canary|private-path|93\.184/);
		},
	);
	it('rejects oversized headers and non-success status', async () => {
		const f = await fixture((req, res) => {
			if (req.url === '/headers') {
				res.writeHead(200, {
					'content-type': 'text/html',
					'x-extra': 'x'.repeat(2000),
				});
				res.end();
			} else {
				res.writeHead(403);
				res.end('secret');
			}
		});
		await expect(
			f.fetch('http://example.com/headers', keep, {
				limits: { header_bytes: 1000 },
			}),
		).rejects.toMatchObject({
			details: { cause: 'headers_too_large' },
		});
		await expect(
			f.fetch('http://example.com/blocked', keep),
		).rejects.toMatchObject({
			details: { cause: 'upstream_status' },
		});
	});
	it('shares the existing request byte budget across operations', async () => {
		const f = await fixture(html);
		await expect(
			run_with_request_context(undefined, async () => {
				consume_response_bytes(MAX_REQUEST_RESPONSE_BYTES - 1);
				return f.fetch('http://example.com', keep);
			}),
		).rejects.toThrow(
			'Aggregate provider response exceeds byte limit',
		);
	});
	it('rejects limit increases before DNS', async () => {
		const resolve = vi.fn();
		await expect(
			create_safe_fetch({ resolve })('http://example.com', keep, {
				limits: {
					decoded_bytes: SAFE_FETCH_LIMITS.decoded_bytes + 1,
				},
			}),
		).rejects.toThrow('Invalid local fetch limit');
		expect(resolve).not.toHaveBeenCalled();
	});
});

describe('deadlines and cancellation cleanup', () => {
	it.each([
		{ encoding: 'gzip', Stream: Gunzip, compress: gzipSync },
		{ encoding: 'deflate', Stream: Inflate, compress: deflateSync },
		{
			encoding: 'br',
			Stream: BrotliDecompress,
			compress: brotliCompressSync,
		},
	])(
		'holds its lease through native $encoding final flush after abort',
		async ({ encoding, Stream, compress }) => {
			const body = compress(Buffer.from('hello'));
			const f = await fixture((_req, res) => {
				res.writeHead(200, {
					'content-type': 'text/html',
					'content-encoding': encoding,
				});
				res.end(body);
			});
			const controller = new AbortController();
			const native_ids = new Set<number>();
			let flushing = false;
			let active_at_callback: number | undefined;
			const hook = createHook({
				init(id, type) {
					if (type === 'ZLIB') native_ids.add(id);
				},
				before(id) {
					if (flushing && native_ids.has(id))
						active_at_callback ??= get_local_fetch_snapshot().active;
				},
			});
			const fillers: Promise<void>[] = [];
			// Invoked with the real decoder receiver via .call below.
			// oxlint-disable-next-line typescript/unbound-method
			const original = Stream.prototype._flush;
			vi.spyOn(Stream.prototype, '_flush').mockImplementation(
				function (this: Transform, callback) {
					flushing = true;
					for (let i = 0; i < 4; i++)
						fillers.push(
							new Promise<void>((resolve, reject) =>
								pbkdf2(
									'fixture',
									'fixture',
									10000,
									16,
									'sha256',
									(error) => (error ? reject(error) : resolve()),
								),
							),
						);
					original.call(this, callback);
					controller.abort();
				},
			);
			const consume = vi.fn(keep);
			hook.enable();
			try {
				await expect(
					f.fetch('http://example.com', consume, {
						signal: controller.signal,
					}),
				).rejects.toMatchObject({ name: 'AbortError' });
				expect(flushing).toBe(true);
				expect(active_at_callback).toBe(1);
				expect(consume).not.toHaveBeenCalled();
			} finally {
				hook.disable();
				await Promise.all(fillers);
			}
		},
	);
	it.each([
		{ encoding: 'gzip', Stream: Gunzip, compress: gzipSync },
		{ encoding: 'deflate', Stream: Inflate, compress: deflateSync },
		{
			encoding: 'br',
			Stream: BrotliDecompress,
			compress: brotliCompressSync,
		},
	])(
		'holds its lease until pending native $encoding work reaches a callback after abort',
		async ({ encoding, Stream, compress }) => {
			const body = compress(
				Buffer.from('fixture evidence'.repeat(100)),
			);
			const f = await fixture((_req, res) => {
				res.writeHead(200, {
					'content-type': 'text/html',
					'content-encoding': encoding,
				});
				res.end(body);
			});
			const controller = new AbortController();
			const native_ids = new Set<number>();
			let active_at_callback: number | undefined;
			let callbacks = 0;
			const hook = createHook({
				init(id, type) {
					if (type === 'ZLIB') native_ids.add(id);
				},
				before(id) {
					if (native_ids.has(id)) {
						active_at_callback ??= get_local_fetch_snapshot().active;
						callbacks++;
					}
				},
			});
			const fillers: Promise<void>[] = [];
			// Invoked with the real decoder receiver via .call below.
			// oxlint-disable-next-line typescript/unbound-method
			const original = Stream.prototype._transform;
			let submitted = false;
			vi.spyOn(Stream.prototype, '_transform').mockImplementation(
				function (this: Transform, chunk, encoding, callback) {
					if (!submitted) {
						submitted = true;
						// Tiny finite jobs move the decoder callback after cancellation
						// and HTTP close instead of winning a scheduling race.
						for (let i = 0; i < 4; i++)
							fillers.push(
								new Promise<void>((resolve, reject) =>
									pbkdf2(
										'fixture',
										'fixture',
										10000,
										16,
										'sha256',
										(error) => (error ? reject(error) : resolve()),
									),
								),
							);
					}
					original.call(this, chunk, encoding, callback);
					controller.abort();
				},
			);
			hook.enable();
			try {
				await expect(
					f.fetch('http://example.com', keep, {
						signal: controller.signal,
					}),
				).rejects.toMatchObject({ name: 'AbortError' });
				expect(submitted).toBe(true);
				expect(callbacks).toBeGreaterThan(0);
				expect(active_at_callback).toBe(1);
			} finally {
				hook.disable();
				await Promise.all(fillers);
			}
		},
	);
	it('rejects already-cancelled work before DNS and removes expired queued work', async () => {
		const f = await fixture(html);
		const controller = new AbortController();
		controller.abort();
		await expect(
			f.fetch('http://example.com', keep, {
				signal: controller.signal,
			}),
		).rejects.toMatchObject({ name: 'AbortError' });
		expect(f.resolve).not.toHaveBeenCalled();
		let finish!: () => void;
		let entered!: () => void;
		const entered_consumer = new Promise<void>((resolve) => {
			entered = resolve;
		});
		const active = f.fetch('http://example.com', async () => {
			entered();
			await new Promise<void>((resolve) => {
				finish = resolve;
			});
		});
		await entered_consumer;
		try {
			await expect(
				f.fetch('http://example.com/queued', keep, {
					limits: { total_ms: 20 },
				}),
			).rejects.toMatchObject({ name: 'TimeoutError' });
			expect(f.resolve).toHaveBeenCalledTimes(1);
			expect(get_local_fetch_snapshot()).toMatchObject({
				active: 1,
				queued: 0,
				reserved_bytes: LOCAL_FETCH_RESERVATION_BYTES,
			});
		} finally {
			finish();
			await active;
		}
	});
	it.each(['dns', 'headers', 'body', 'consumer'])(
		'cleans up caller cancellation during %s',
		async (stage) => {
			const controller = new AbortController();
			const f = await fixture((_req, res) => {
				if (stage === 'headers') controller.abort();
				else {
					res.writeHead(200, { 'content-type': 'text/html' });
					res.write('x');
					if (stage !== 'body') res.end('y');
				}
			});
			const resolve: SafeFetchDependencies['resolve'] = async () => {
				if (stage === 'dns') controller.abort();
				return addresses;
			};
			const request: SafeFetchDependencies['request'] = (
				url,
				options,
				response,
			) =>
				f.request(url, options, (res) => {
					if (stage === 'body')
						res.once('data', () => controller.abort());
					response(res);
				});
			await expect(
				create_safe_fetch({ resolve, request })(
					'http://example.com',
					async () => {
						if (stage === 'consumer') controller.abort();
					},
					{ signal: controller.signal },
				),
			).rejects.toMatchObject({ name: 'AbortError' });
		},
	);
	it('waits for both native resolver queries to settle on cancellation', async () => {
		let a_reject!: (error: unknown) => void;
		let aaaa_reject!: (error: unknown) => void;
		vi.spyOn(Resolver.prototype, 'resolve4').mockImplementation(
			() =>
				new Promise((_resolve, reject) => {
					a_reject = reject;
				}),
		);
		vi.spyOn(Resolver.prototype, 'resolve6').mockImplementation(
			() =>
				new Promise((_resolve, reject) => {
					aaaa_reject = reject;
				}),
		);
		vi.spyOn(Resolver.prototype, 'cancel').mockImplementation(() => {
			a_reject({ code: 'ECANCELLED' });
			aaaa_reject({ code: 'ECANCELLED' });
		});
		const controller = new AbortController();
		const pending = resolve_public_host(
			'example.com',
			controller.signal,
			100,
		);
		controller.abort();
		await expect(pending).rejects.toMatchObject({
			name: 'AbortError',
		});
	});
	it('cancels DNS under its nested deadline without making a request', async () => {
		const request = vi.fn();
		const resolve: SafeFetchDependencies['resolve'] = (
			_host,
			signal,
		) =>
			new Promise((resolve) =>
				signal.addEventListener('abort', () => resolve(addresses), {
					once: true,
				}),
			);
		await expect(
			create_safe_fetch({ resolve, request })(
				'http://example.com',
				keep,
				{ limits: { dns_ms: 20 } },
			),
		).rejects.toMatchObject({ name: 'TimeoutError' });
		expect(request).not.toHaveBeenCalled();
	});
	it.each(['headers', 'body'])(
		'times out stalled %s and releases the socket',
		async (stage) => {
			const f = await fixture((_req, res) => {
				if (stage === 'body') {
					res.writeHead(200, { 'content-type': 'text/html' });
					res.write('<p>');
				}
			});
			await expect(
				f.fetch('http://example.com', keep, {
					limits: { headers_ms: 25, body_idle_ms: 25 },
				}),
			).rejects.toMatchObject({ name: 'TimeoutError' });
		},
	);
	it('times out a stalled TLS handshake', async () => {
		const port = await listen(tcp_server(() => {}));
		const request: SafeFetchDependencies['request'] = (
			_url,
			options,
			response,
		) =>
			https_request(
				{ ...options, hostname: '127.0.0.1', port },
				response,
			);
		await expect(
			create_safe_fetch({ resolve: async () => addresses, request })(
				'https://example.com',
				keep,
				{ limits: { connect_ms: 25 } },
			),
		).rejects.toMatchObject({ name: 'TimeoutError' });
	});
	it('inherits caller cancellation during body streaming and never calls the consumer', async () => {
		const controller = new AbortController();
		const f = await fixture((_req, res) => {
			res.writeHead(200, { 'content-type': 'text/html' });
			res.write('x');
			controller.abort(new Error('private cancellation reason'));
		});
		const consume = vi.fn(keep);
		const error = await run_with_request_context(
			controller.signal,
			() => f.fetch('http://example.com', consume),
		).catch((error) => error);
		expect(public_error_metadata(error).kind).toBe('cancelled');
		expect(create_error_response(error).error).not.toContain(
			'private',
		);
		expect(consume).not.toHaveBeenCalled();
	});
	it('includes the consumer in the overall deadline and holds its reservation until it settles', async () => {
		const f = await fixture(html);
		await expect(
			f.fetch(
				'http://example.com',
				async (_page, signal) => {
					await new Promise<void>((resolve) =>
						signal.addEventListener(
							'abort',
							() => {
								expect(
									get_local_fetch_snapshot().reserved_bytes,
								).toBe(LOCAL_FETCH_RESERVATION_BYTES);
								resolve();
							},
							{ once: true },
						),
					);
				},
				{ limits: { total_ms: 40 } },
			),
		).rejects.toMatchObject({ name: 'TimeoutError' });
	});
	it('resolves both address families and cancels only its own resolver', async () => {
		const a = vi
			.spyOn(Resolver.prototype, 'resolve4')
			.mockResolvedValue([PUBLIC]);
		const aaaa = vi
			.spyOn(Resolver.prototype, 'resolve6')
			.mockRejectedValue({ code: 'ENODATA' });
		const cancel = vi.spyOn(Resolver.prototype, 'cancel');
		await expect(
			resolve_public_host(
				'example.com',
				new AbortController().signal,
				100,
			),
		).resolves.toEqual(addresses);
		expect(a).toHaveBeenCalledOnce();
		expect(aaaa).toHaveBeenCalledOnce();
		expect(cancel).toHaveBeenCalledOnce();
	});
});

describe('bounded framing and measurement', () => {
	it.each([
		['gzip', gzipSync],
		['deflate', deflateSync],
		['br', brotliCompressSync],
	] as const)(
		'rejects a truncated %s trailer before returning evidence',
		async (encoding, compress) => {
			const body = compress(Buffer.from('hello'));
			const f = await fixture((_req, res) => {
				res.writeHead(200, {
					'content-type': 'text/html',
					'content-encoding': encoding,
				});
				res.end(body.subarray(0, -1));
			});
			const consume = vi.fn(keep);
			await expect(
				f.fetch('http://example.com', consume),
			).rejects.toMatchObject({
				details: { cause: 'invalid_encoding' },
			});
			expect(consume).not.toHaveBeenCalled();
		},
	);
	it('counts chunk framing before HTTP parsing, not only entity bytes', async () => {
		const raw =
			'HTTP/1.1 200 OK\r\nContent-Type: text/html\r\nTransfer-Encoding: chunked\r\n\r\n2;' +
			'x'.repeat(4096) +
			'\r\nok\r\n0\r\n\r\n';
		const f = await fixture((_req, res) => {
			res.socket!.end(raw);
		});
		const consume = vi.fn(keep);
		await expect(
			f.fetch('http://example.com', consume, {
				limits: {
					http_bytes: 512,
					encoded_bytes: 16,
					header_bytes: 256,
				},
			}),
		).rejects.toMatchObject({
			details: { cause: 'response_too_large' },
		});
		expect(consume).not.toHaveBeenCalled();
	});
	it.each(['Content-Type', 'Content-Encoding', 'Location'])(
		'does not truncate a conflicting %s after 1000 headers',
		async (name) => {
			const first =
				name === 'Location'
					? 'HTTP/1.1 302 Found\r\nLocation: /one\r\n'
					: 'HTTP/1.1 200 OK\r\nContent-Type: text/html\r\n' +
						(name === 'Content-Encoding'
							? 'Content-Encoding: identity\r\n'
							: '');
			const conflicting =
				name === 'Content-Type'
					? 'application/pdf'
					: name === 'Content-Encoding'
						? 'gzip'
						: '/two';
			const raw =
				first +
				'X: a\r\n'.repeat(1000) +
				name +
				': ' +
				conflicting +
				'\r\nContent-Length: 1\r\n\r\nx';
			const f = await fixture((_req, res) => {
				res.socket!.end(raw);
			});
			await expect(
				f.fetch('http://example.com', keep),
			).rejects.toMatchObject({
				details: {
					cause:
						name === 'Location'
							? 'invalid_redirect'
							: 'unsupported_encoding',
				},
			});
		},
	);
	it.each([
		['gzip', gzipSync],
		['deflate', deflateSync],
		['br', brotliCompressSync],
	] as const)(
		'rejects trailing compressed junk for %s',
		async (encoding, compress) => {
			const f = await fixture((_req, res) => {
				res.writeHead(200, {
					'content-type': 'text/html',
					'content-encoding': encoding,
				});
				res.end(
					Buffer.concat([
						compress(Buffer.from('ok')),
						Buffer.from('TRAILING'),
					]),
				);
			});
			await expect(
				f.fetch('http://example.com', keep),
			).rejects.toMatchObject({
				details: { cause: 'invalid_encoding' },
			});
		},
	);
	it.each([
		'text/html; charset="utf-8"junk',
		'text/html; charset=utf-8; broken',
	])('rejects malformed MIME parameters %s', async (type) => {
		const f = await fixture((_req, res) => {
			res.writeHead(200, { 'content-type': type });
			res.end('ok');
		});
		await expect(
			f.fetch('http://example.com', keep),
		).rejects.toMatchObject({
			details: { cause: 'unsupported_encoding' },
		});
	});
	it('does not interpret quoted parameter content as another charset', async () => {
		const f = await fixture((_req, res) => {
			res.writeHead(200, {
				'content-type':
					'text/html; charset=utf-8; note="; charset=windows-1252"',
			});
			res.end('ok');
		});
		await expect(
			f.fetch('http://example.com', keep),
		).resolves.toMatchObject({ html: 'ok' });
	});
	it.each([
		[
			'duplicate content type',
			'HTTP/1.1 200 OK\r\nContent-Type: text/html\r\nContent-Type: application/pdf\r\nContent-Length: 1\r\n\r\nx',
			'unsupported_encoding',
		],
		[
			'duplicate redirect location',
			'HTTP/1.1 302 Found\r\nLocation: /one\r\nLocation: /two\r\nContent-Length: 0\r\n\r\n',
			'invalid_redirect',
		],
		[
			'upgrade',
			'HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n',
			'unsupported_content',
		],
		[
			'too many informational responses',
			'HTTP/1.1 100 Continue\r\n\r\n'.repeat(5) +
				'HTTP/1.1 200 OK\r\nContent-Type: text/html\r\nContent-Length: 0\r\n\r\n',
			'headers_too_large',
		],
	])('rejects %s', async (_name, raw, reason) => {
		const f = await fixture((_req, res) => {
			res.socket!.end(raw);
		});
		await expect(
			f.fetch('http://example.com', keep),
		).rejects.toMatchObject({ details: { cause: reason } });
	});
	it('rejects BOM/header conflicts and incomplete multibyte input', async () => {
		const f = await fixture((req, res) => {
			res.writeHead(200, {
				'content-type': 'text/html; charset=utf-8',
			});
			res.end(
				req.url === '/bom'
					? Buffer.from('﻿text', 'utf16le')
					: Buffer.from([0xe4, 0xb8]),
			);
		});
		await expect(
			f.fetch('http://example.com/bom', keep),
		).rejects.toMatchObject({
			details: { cause: 'unsupported_encoding' },
		});
		await expect(
			f.fetch('http://example.com/truncated', keep),
		).rejects.toMatchObject({
			details: { cause: 'invalid_encoding' },
		});
	});
	it('measures bounded near-limit streaming and independent event-loop progress', async () => {
		const body = '<p>' + 'evidence '.repeat(466000) + '</p>';
		const bytes = Buffer.from(body);
		const hash = createHash('sha256').update(bytes).digest('hex');
		const f = await fixture((_req, res) => {
			res.writeHead(200, { 'content-type': 'text/html' });
			let offset = 0;
			const send = () => {
				if (res.destroyed) return;
				if (offset === bytes.length) {
					res.end();
					return;
				}
				const next = Math.min(offset + 16384, bytes.length);
				const ready = res.write(bytes.subarray(offset, next));
				offset = next;
				if (ready) setImmediate(send);
				else res.once('drain', send);
			};
			send();
		});
		const baseline = process.memoryUsage();
		let peak_rss = baseline.rss;
		let peak_external = baseline.external;
		let ticks = 0;
		const delay = monitorEventLoopDelay({ resolution: 10 });
		delay.enable();
		const sample = setInterval(() => {
			const m = process.memoryUsage();
			peak_rss = Math.max(peak_rss, m.rss);
			peak_external = Math.max(peak_external, m.external);
			ticks++;
		}, 1);
		const started = performance.now();
		try {
			const result = await f.fetch(
				'http://example.com/large',
				async (page) => {
					const m = process.memoryUsage();
					peak_rss = Math.max(peak_rss, m.rss);
					peak_external = Math.max(peak_external, m.external);
					return {
						hash: createHash('sha256')
							.update(page.html)
							.digest('hex'),
						decoded_bytes: page.decoded_bytes,
						text_bytes: page.text_bytes,
					};
				},
			);
			expect(result).toEqual({
				hash,
				decoded_bytes: bytes.length,
				text_bytes: bytes.length,
			});
			expect(ticks).toBeGreaterThan(0);
			console.log(
				'P3A_FETCH_MEASUREMENT ' +
					JSON.stringify({
						decoded_bytes: bytes.length,
						elapsed_ms: Math.round(performance.now() - started),
						independent_ticks: ticks,
						event_loop_max_ms: Number((delay.max / 1e6).toFixed(3)),
						sampled_rss_delta: peak_rss - baseline.rss,
						sampled_external_delta: peak_external - baseline.external,
						reservation_bytes: LOCAL_FETCH_RESERVATION_BYTES,
					}),
			);
		} finally {
			clearInterval(sample);
			delay.disable();
		}
	});
});
