import { timingSafeEqual } from 'node:crypto';
import {
	createServer,
	request as http_request,
	type IncomingMessage,
	type Server,
	type ServerResponse,
} from 'node:http';

/**
 * Narrow HTTP security boundary that sits in front of mcp-proxy.
 *
 * The pinned proxy (6.7.3) speaks the 2026-07-28 protocol but does not
 * enforce the strict edge checks this deployment requires:
 *   - SDK issue #2589: a modern envelope without the
 *     MCP-Protocol-Version header is accepted instead of rejected.
 *   - SDK issue #2489: Host/Origin values containing userinfo are not
 *     rejected cleanly (observed HTTP 500).
 *   - No Host allowlist, no Origin allowlist, and a wildcard CORS
 *     preflight combined with Access-Control-Allow-Credentials.
 *
 * This guard fails closed on all of the above, limits routes to the
 * MCP endpoint and health check, and bounds request bodies before
 * anything reaches the proxy. The guard repeats the proxy's constant-time
 * API key check before reading bodies; the proxy still authenticates too.
 */

export const modern_protocol_version_key =
	'io.modelcontextprotocol/protocolVersion';

export interface GuardConfig {
	upstream_host: string;
	upstream_port: number;
	/** Exact `host[:port]` values clients may send, compared lowercase. */
	allowed_hosts: readonly string[];
	api_key: string;
	max_connections: number;
	max_inflight_requests: number;
	rate_limit_requests: number;
	rate_limit_window_ms: number;
	max_body_bytes: number;
	/** Deadline for receiving the full request body once it starts. */
	body_read_timeout_ms: number;
	mcp_path: string;
	ping_path: string;
	ready_path: string;
}

export const default_guard_config = (
	overrides: Partial<GuardConfig> = {},
): GuardConfig => ({
	upstream_host: '127.0.0.1',
	upstream_port: 8002,
	allowed_hosts: [],
	api_key: '',
	max_connections: 256,
	max_inflight_requests: 64,
	rate_limit_requests: 600,
	rate_limit_window_ms: 60_000,
	max_body_bytes: 4 * 1024 * 1024,
	body_read_timeout_ms: 30_000,
	mcp_path: '/mcp',
	ping_path: '/ping',
	ready_path: '/ready',
	...overrides,
});

/** Positive, finite integer settings; unlike ports, byte counts may exceed 65535. */
export const parse_guard_integer = (
	raw: string | undefined,
	fallback: number,
	name: string,
	maximum = Number.MAX_SAFE_INTEGER,
): number => {
	if (raw === undefined) return fallback;
	const value = Number(raw);
	if (
		!/^\d+$/.test(raw) ||
		!Number.isSafeInteger(value) ||
		value < 1 ||
		value > maximum
	) {
		throw new Error(
			`guard: ${name} must be a positive integer no greater than ${maximum}`,
		);
	}
	return value;
};

export type HostCheck =
	| { ok: true; host: string }
	| {
			ok: false;
			reason: 'missing' | 'malformed' | 'userinfo' | 'not_allowed';
	  };

export const check_host = (
	host_header: string | undefined,
	allowed_hosts: readonly string[],
): HostCheck => {
	if (host_header === undefined)
		return { ok: false, reason: 'missing' };
	const trimmed = host_header.trim();
	if (trimmed.length === 0 || trimmed.length > 255)
		return { ok: false, reason: 'malformed' };
	if (/[\s/?#\\]/.test(trimmed))
		return { ok: false, reason: 'malformed' };
	if (trimmed.includes('@')) return { ok: false, reason: 'userinfo' };
	let url: URL;
	try {
		url = new URL(`http://${trimmed}`);
	} catch {
		return { ok: false, reason: 'malformed' };
	}
	if (url.username || url.password)
		return { ok: false, reason: 'userinfo' };
	if (url.pathname !== '/' || url.search || url.hash)
		return { ok: false, reason: 'malformed' };
	if (!allowed_hosts.includes(url.host))
		return { ok: false, reason: 'not_allowed' };
	return { ok: true, host: url.host };
};

export type OriginCheck =
	| { ok: true }
	| {
			ok: false;
			reason: 'malformed' | 'userinfo' | 'scheme' | 'not_allowed';
	  };

export const check_origin = (
	origin_header: string | undefined,
	allowed_hosts: readonly string[],
): OriginCheck => {
	// Non-browser MCP clients send no Origin; only validate when present.
	if (origin_header === undefined) return { ok: true };
	const trimmed = origin_header.trim();
	if (
		trimmed.length === 0 ||
		trimmed.length > 255 ||
		/\s/.test(trimmed)
	)
		return { ok: false, reason: 'malformed' };
	if (trimmed.includes('@')) return { ok: false, reason: 'userinfo' };
	let url: URL;
	try {
		url = new URL(trimmed);
	} catch {
		return { ok: false, reason: 'malformed' };
	}
	if (url.username || url.password)
		return { ok: false, reason: 'userinfo' };
	if (url.protocol !== 'http:' && url.protocol !== 'https:')
		return { ok: false, reason: 'scheme' };
	if (url.pathname !== '/' || url.search || url.hash)
		return { ok: false, reason: 'malformed' };
	if (!allowed_hosts.includes(url.host))
		return { ok: false, reason: 'not_allowed' };
	return { ok: true };
};

export interface BodyClassification {
	modern_envelope: boolean;
	id: string | number | null;
	batch?: true;
}

/** Detects modern envelopes and disallowed multi-message bodies. */
export const classify_body = (body: Buffer): BodyClassification => {
	let parsed: unknown;
	try {
		parsed = JSON.parse(body.toString('utf8'));
	} catch {
		return { modern_envelope: false, id: null };
	}
	if (Array.isArray(parsed))
		return { modern_envelope: false, id: null, batch: true };
	if (parsed === null || typeof parsed !== 'object')
		return { modern_envelope: false, id: null };
	const record = parsed as Record<string, unknown>;
	const id =
		typeof record.id === 'string' || typeof record.id === 'number'
			? record.id
			: null;
	const params = record.params;
	if (
		params === null ||
		typeof params !== 'object' ||
		Array.isArray(params)
	)
		return { modern_envelope: false, id };
	const meta = (params as Record<string, unknown>)._meta;
	if (
		meta === null ||
		typeof meta !== 'object' ||
		Array.isArray(meta)
	)
		return { modern_envelope: false, id };
	return {
		modern_envelope: Object.prototype.hasOwnProperty.call(
			meta,
			modern_protocol_version_key,
		),
		id,
	};
};

export type BodyRead =
	| { status: 'ok'; body: Buffer }
	| { status: 'too_large' }
	| { status: 'aborted' }
	| { status: 'timeout' };

export const read_bounded_body = (
	req: IncomingMessage,
	max_body_bytes: number,
	timeout_ms: number,
): Promise<BodyRead> => {
	return new Promise((resolve) => {
		const declared = Number(req.headers['content-length']);
		if (Number.isFinite(declared) && declared > max_body_bytes) {
			resolve({ status: 'too_large' });
			return;
		}
		const chunks: Buffer[] = [];
		let received = 0;
		let settled = false;
		const finish = (result: BodyRead) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			resolve(result);
		};
		const timer = setTimeout(() => {
			req.pause();
			finish({ status: 'timeout' });
		}, timeout_ms);
		req.on('data', (chunk: Buffer) => {
			if (settled) return;
			received += chunk.length;
			if (received > max_body_bytes) {
				finish({ status: 'too_large' });
				req.pause();
				return;
			}
			chunks.push(chunk);
		});
		req.on('end', () =>
			finish({ status: 'ok', body: Buffer.concat(chunks) }),
		);
		req.on('aborted', () => finish({ status: 'aborted' }));
		req.on('error', () => finish({ status: 'aborted' }));
	});
};

const json_rpc_error = (
	id: string | number | null,
	code: number,
	message: string,
	data?: unknown,
) => ({
	jsonrpc: '2.0' as const,
	error: { code, message, ...(data !== undefined ? { data } : {}) },
	id,
});

const send_json = (
	res: ServerResponse,
	status: number,
	payload: unknown,
): void => {
	const body = JSON.stringify(payload);
	res.writeHead(status, {
		'content-type': 'application/json',
		'content-length': Buffer.byteLength(body),
		// Rejections can arrive while the client is still uploading;
		// close after the response so unread data cannot keep the
		// socket open.
		connection: 'close',
	});
	res.end(body, () => {
		if (!res.req.complete) res.req.destroy();
	});
};

const reject = (
	res: ServerResponse,
	status: number,
	message: string,
): void => {
	if (status === 401)
		res.setHeader('www-authenticate', 'ApiKey realm="retriever"');
	send_json(res, status, json_rpc_error(null, -32000, message));
};

const hop_by_hop_headers = [
	'connection',
	'keep-alive',
	'proxy-authenticate',
	'proxy-authorization',
	'te',
	'trailer',
	'transfer-encoding',
	'upgrade',
	'expect',
];

const forward_to_upstream = (
	config: GuardConfig,
	req: IncomingMessage,
	res: ServerResponse,
	body: Buffer,
): void => {
	const headers: Record<string, string | string[] | undefined> = {
		...req.headers,
	};
	for (const name of hop_by_hop_headers) delete headers[name];
	headers['host'] = `${config.upstream_host}:${config.upstream_port}`;
	headers['content-length'] = String(body.length);

	const upstream = http_request(
		{
			host: config.upstream_host,
			port: config.upstream_port,
			path: req.url,
			method: req.method,
			headers,
		},
		(upstream_res) => {
			const response_headers = { ...upstream_res.headers };
			for (const name of Object.keys(response_headers)) {
				if (name.startsWith('access-control-'))
					delete response_headers[name];
			}
			res.writeHead(upstream_res.statusCode ?? 502, response_headers);
			upstream_res.pipe(res);
			upstream_res.on('error', () => {
				upstream_res.destroy();
				res.destroy();
			});
		},
	);
	upstream.on('error', () => {
		if (res.headersSent) {
			res.destroy();
			return;
		}
		send_json(
			res,
			502,
			json_rpc_error(
				null,
				-32000,
				'Bad Gateway: upstream unavailable',
			),
		);
	});
	if (req.method === 'GET') {
		upstream.setTimeout(5000, () =>
			upstream.destroy(new Error('Health probe deadline')),
		);
	}
	// Propagate client-close cancellation to the upstream request.
	res.on('close', () => {
		if (!res.writableEnded) upstream.destroy();
	});
	upstream.end(body);
};

const has_api_key = (
	config: GuardConfig,
	req: IncomingMessage,
): boolean => {
	const supplied = req.headers['x-api-key'];
	const expected = Buffer.from(config.api_key);
	const actual = Buffer.from(
		typeof supplied === 'string' ? supplied : '',
	);
	return (
		expected.length > 0 &&
		actual.length === expected.length &&
		timingSafeEqual(actual, expected)
	);
};

const is_cancellation = (body: Buffer): boolean => {
	if (body.length > 8192) return false;
	try {
		const message = JSON.parse(body.toString('utf8'));
		return (
			message?.jsonrpc === '2.0' &&
			message.method === 'notifications/cancelled' &&
			message.id === undefined &&
			(typeof message.params?.requestId === 'string' ||
				typeof message.params?.requestId === 'number')
		);
	} catch {
		return false;
	}
};

const handle_request = async (
	config: GuardConfig,
	req: IncomingMessage,
	res: ServerResponse,
	admit_body: (body: Buffer) => boolean = () => true,
): Promise<void> => {
	const host_check = check_host(
		req.headers.host,
		config.allowed_hosts,
	);
	if (!host_check.ok) {
		reject(
			res,
			403,
			`Forbidden: Host rejected (${host_check.reason})`,
		);
		return;
	}

	const origin_check = check_origin(
		req.headers.origin,
		config.allowed_hosts,
	);
	if (!origin_check.ok) {
		reject(
			res,
			403,
			`Forbidden: Origin rejected (${origin_check.reason})`,
		);
		return;
	}

	let pathname: string;
	try {
		pathname = new URL(req.url ?? '/', 'http://guard.local').pathname;
	} catch {
		reject(res, 400, 'Bad Request: unparseable target');
		return;
	}

	if (
		pathname === config.ping_path ||
		pathname === config.ready_path
	) {
		if (req.method !== 'GET') {
			res.setHeader('allow', 'GET');
			reject(res, 405, 'Method Not Allowed');
			return;
		}
		if (
			req.headers['transfer-encoding'] !== undefined ||
			Number(req.headers['content-length'] ?? 0) !== 0
		) {
			reject(res, 400, 'Bad Request: ping must not include a body');
			return;
		}
		forward_to_upstream(config, req, res, Buffer.alloc(0));
		return;
	}

	if (pathname !== config.mcp_path) {
		reject(res, 404, 'Not Found');
		return;
	}
	if (req.method !== 'POST') {
		res.setHeader('allow', 'POST');
		reject(res, 405, 'Method Not Allowed');
		return;
	}

	if (!has_api_key(config, req)) {
		reject(res, 401, 'Unauthorized: Invalid or missing API key');
		return;
	}

	const read = await read_bounded_body(
		req,
		config.max_body_bytes,
		config.body_read_timeout_ms,
	);
	if (read.status === 'too_large') {
		reject(res, 413, 'Payload Too Large');
		return;
	}
	if (read.status === 'timeout') {
		reject(res, 408, 'Request Timeout: body not received in time');
		return;
	}
	if (read.status === 'aborted') {
		res.destroy();
		return;
	}

	const classification = classify_body(read.body);
	if (classification.batch) {
		send_json(
			res,
			400,
			json_rpc_error(
				null,
				-32600,
				'A single JSON-RPC message is required',
			),
		);
		return;
	}
	const has_version_header =
		req.headers['mcp-protocol-version'] !== undefined;
	if (classification.modern_envelope && !has_version_header) {
		send_json(
			res,
			400,
			json_rpc_error(
				classification.id,
				-32020,
				'Bad Request: MCP-Protocol-Version header is required when the body carries a modern protocol envelope',
				{ issue: 'missing_protocol_version_header' },
			),
		);
		return;
	}

	if (admit_body(read.body))
		forward_to_upstream(config, req, res, read.body);
};

export const create_guard_server = (config: GuardConfig): Server => {
	if (config.allowed_hosts.length === 0) {
		throw new Error(
			'guard requires a non-empty allowed_hosts allowlist',
		);
	}
	const normalized: GuardConfig = {
		...config,
		allowed_hosts: config.allowed_hosts.map((host) =>
			host.toLowerCase(),
		),
	};
	let inflight = 0;
	let control_inflight = 0;
	let health_inflight = 0;
	let window_started = Date.now();
	const accepted = { rejected: 0, work: 0, control: 0, health: 0 };
	const throttle = (res: ServerResponse, seconds: number) => {
		res.setHeader('retry-after', String(Math.max(1, seconds)));
		reject(res, 429, 'Too Many Requests');
	};
	const take_rate = (
		lane: keyof typeof accepted,
		res: ServerResponse,
	): boolean => {
		const limit =
			lane === 'health' || lane === 'control'
				? Math.min(120, config.rate_limit_requests)
				: config.rate_limit_requests;
		if (accepted[lane] >= limit) {
			throttle(
				res,
				Math.ceil(
					(window_started +
						config.rate_limit_window_ms -
						Date.now()) /
						1000,
				),
			);
			return false;
		}
		accepted[lane]++;
		return true;
	};
	const server = createServer((req, res) => {
		const now = Date.now();
		if (now - window_started >= config.rate_limit_window_ms) {
			window_started = now;
			for (const lane of Object.keys(
				accepted,
			) as (keyof typeof accepted)[])
				accepted[lane] = 0;
		}
		let pathname = '';
		try {
			pathname = new URL(req.url ?? '/', 'http://guard.local')
				.pathname;
		} catch {
			/* Rejected by the normal route validation. */
		}
		const valid_edge =
			check_host(req.headers.host, normalized.allowed_hosts).ok &&
			check_origin(req.headers.origin, normalized.allowed_hosts).ok;
		const health =
			valid_edge &&
			req.method === 'GET' &&
			(pathname === config.ping_path ||
				pathname === config.ready_path);
		const authenticated =
			valid_edge &&
			pathname === config.mcp_path &&
			req.method === 'POST' &&
			has_api_key(config, req);
		let request_config = normalized;
		let admit_body = (_body: Buffer) => true;
		if (health) {
			if (!take_rate('health', res)) return;
			if (health_inflight >= 4) {
				throttle(res, 1);
				return;
			}
			health_inflight++;
			res.once('close', () => health_inflight--);
		} else if (!authenticated) {
			if (!take_rate('rejected', res)) return;
		} else {
			const reserved_control =
				inflight >= config.max_inflight_requests ||
				accepted.work >= config.rate_limit_requests;
			if (reserved_control) {
				if (control_inflight >= 4) {
					throttle(res, 1);
					return;
				}
				control_inflight++;
				res.once('close', () => control_inflight--);
				request_config = {
					...normalized,
					max_body_bytes: Math.min(config.max_body_bytes, 8192),
					body_read_timeout_ms: Math.min(
						config.body_read_timeout_ms,
						1000,
					),
				};
			} else {
				inflight++;
				res.once('close', () => inflight--);
			}
			admit_body = (body) => {
				if (is_cancellation(body)) return take_rate('control', res);
				if (reserved_control) {
					throttle(res, 1);
					return false;
				}
				return take_rate('work', res);
			};
		}
		handle_request(request_config, req, res, admit_body).catch(() => {
			if (res.headersSent) {
				res.destroy();
				return;
			}
			reject(res, 500, 'Internal guard error');
		});
	});
	// Tool calls can legitimately stream for minutes; the global
	// request timeout is disabled and slow senders are bounded by
	// body_read_timeout_ms instead.
	server.requestTimeout = 0;
	server.maxConnections = config.max_connections;
	server.on('clientError', (_error, socket) => {
		socket.end(
			'HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n',
		);
	});
	return server;
};
