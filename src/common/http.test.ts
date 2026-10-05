import {
	afterEach,
	beforeEach,
	describe,
	expect,
	it,
	vi,
} from 'vitest';
import { http_json, safe_endpoint } from './http.js';
import { reset_http_cache } from './http_cache.js';
import {
	consume_response_bytes,
	MAX_REQUEST_RESPONSE_BYTES,
	release_response_bytes,
	run_with_request_context,
} from './request_context.js';
import { ErrorType } from './types.js';
import {
	create_error_response,
	public_error_metadata,
} from './errors.js';
import { is_retryable_error } from './retry.js';

const fetch_mock = vi.fn();

describe('http_json', () => {
	it.each([
		[
			'https://user:password@api.example.com/private-token?signature=SECRET#fragment',
			'https://api.example.com',
		],
		['not a URL?SECRET', '[redacted endpoint]'],
		['data:text/plain,SECRET', '[redacted endpoint]'],
	])('redacts unsafe endpoint components from %s', (url, safe) => {
		expect(safe_endpoint(url)).toBe(safe);
	});
	beforeEach(() => {
		fetch_mock.mockReset();
		vi.stubGlobal('fetch', fetch_mock);
	});

	afterEach(() => {
		vi.unstubAllGlobals();
		vi.restoreAllMocks();
	});

	it.each([
		[400, 'bad request', ErrorType.API_ERROR, 'bad_input', false],
		[
			401,
			'not authorized',
			ErrorType.API_ERROR,
			'authentication',
			false,
		],
		[
			403,
			'forbidden',
			ErrorType.ENTITLEMENT_REQUIRED,
			'entitlement',
			false,
		],
		[
			404,
			'Cannot POST /private-route',
			ErrorType.ENDPOINT_NOT_FOUND,
			'endpoint_mismatch',
			false,
		],
		[
			404,
			'document missing',
			ErrorType.API_ERROR,
			'upstream_failure',
			false,
		],
		[408, 'request timeout', ErrorType.API_ERROR, 'timeout', true],
		[422, 'invalid request', ErrorType.API_ERROR, 'bad_input', false],
		[425, 'too early', ErrorType.API_ERROR, 'upstream_failure', true],
		[429, 'slow down', ErrorType.RATE_LIMIT, 'rate_limit', true],
		[
			500,
			'server error',
			ErrorType.PROVIDER_ERROR,
			'upstream_failure',
			false,
		],
		[
			501,
			'not implemented',
			ErrorType.PROVIDER_ERROR,
			'upstream_failure',
			false,
		],
		[
			502,
			'bad gateway',
			ErrorType.PROVIDER_ERROR,
			'upstream_failure',
			true,
		],
		[
			503,
			'unavailable',
			ErrorType.PROVIDER_ERROR,
			'upstream_failure',
			true,
		],
		[
			504,
			'gateway timeout',
			ErrorType.PROVIDER_ERROR,
			'timeout',
			true,
		],
		[
			400,
			'requires a subscription',
			ErrorType.ENTITLEMENT_REQUIRED,
			'entitlement',
			false,
		],
	] as const)(
		'exposes safe HTTP %s metadata for %s while preserving the raw enum',
		async (status, message, type, kind, retryable) => {
			fetch_mock.mockResolvedValueOnce(
				new Response(
					JSON.stringify({ message, private: 'PRIVATE_BODY' }),
					{
						status,
						headers: { 'X-Private': 'SECRET_HEADER' },
					},
				),
			);
			const error = await http_json(
				'test_provider',
				'https://user:password@api.example.com/PRIVATE_PATH?token=SECRET',
			).catch((failure: unknown) => failure);
			expect(fetch_mock).toHaveBeenCalledTimes(1);
			expect(error).toMatchObject({ type, details: { status } });
			expect(public_error_metadata(error)).toEqual({
				kind,
				retryable,
				provider: 'test_provider',
				http_status: status,
			});
			expect(is_retryable_error(error)).toBe(retryable);
			expect(
				JSON.stringify({
					error,
					metadata: public_error_metadata(error),
					response: create_error_response(error),
				}),
			).not.toMatch(/PRIVATE|SECRET|password|private-route/);
		},
	);

	it('preserves Retry-After overflow as a non-retryable rate limit', async () => {
		fetch_mock.mockResolvedValueOnce(
			new Response('PRIVATE_BODY', {
				status: 429,
				headers: { 'Retry-After': '9'.repeat(100) },
			}),
		);
		const error = await http_json(
			'test_provider',
			'https://api.example.com',
		).catch((failure: unknown) => failure);
		expect(public_error_metadata(error)).toEqual({
			kind: 'rate_limit',
			retryable: false,
			provider: 'test_provider',
			http_status: 429,
		});
		expect(is_retryable_error(error)).toBe(false);
	});

	it.each(['request', 'call'] as const)(
		'aborts a pending fetch from the %s signal without exposing its reason',
		async (source) => {
			const request = new AbortController();
			const call = new AbortController();
			let fetch_signal: AbortSignal | null | undefined;
			fetch_mock.mockImplementation((_url, options) => {
				fetch_signal = options.signal;
				return new Promise(() => {});
			});
			const result = run_with_request_context(request.signal, () =>
				http_json('test_provider', 'https://api.example.com', {
					signal: call.signal,
				}),
			);
			const rejected = expect(result).rejects.toMatchObject({
				name: 'AbortError',
				message: 'Operation cancelled',
			});
			// Provider-slot acquisition is asynchronous; cancel an in-flight
			// fetch here rather than a request that has not acquired a slot.
			await Promise.resolve();
			expect(fetch_mock).toHaveBeenCalledTimes(1);
			(source === 'request' ? request : call).abort(
				new Error('private signed URL reason'),
			);
			expect(fetch_signal?.aborted).toBe(true);
			await rejected;
		},
	);

	it.each(['headers', 'body'])(
		'normalizes %s network failures without retaining private data',
		async (phase) => {
			const failure = new TypeError('file:///PRIVATE_PATH?SECRET');
			if (phase === 'headers') {
				fetch_mock.mockRejectedValueOnce(failure);
			} else {
				fetch_mock.mockResolvedValueOnce(
					new Response(
						new ReadableStream({
							start(controller) {
								controller.error(failure);
							},
						}),
					),
				);
			}
			const error = await http_json(
				'test_provider',
				'https://api.example.com',
			).catch((error: unknown) => error);
			expect(error).toMatchObject({
				type: ErrorType.API_ERROR,
				message: 'Network request failed',
				provider: 'test_provider',
				details: { retryable: true, cause: 'network' },
			});
			expect(public_error_metadata(error)).toEqual({
				kind: 'upstream_failure',
				retryable: true,
				provider: 'test_provider',
			});
			expect(JSON.stringify(error)).not.toMatch(
				/PRIVATE_PATH|SECRET/,
			);
		},
	);

	it.each([0, -1, NaN, Infinity, 0.5, 26 * 1024 * 1024])(
		'rejects an unsafe response limit %s before fetching',
		async (max_response_bytes) => {
			fetch_mock.mockResolvedValue(new Response('{}'));
			await expect(
				http_json('test_provider', 'https://api.example.com', {
					max_response_bytes,
				}),
			).rejects.toThrow(RangeError);
			expect(fetch_mock).not.toHaveBeenCalled();
		},
	);

	it('allows the bounded 25 MiB response ceiling', async () => {
		fetch_mock.mockResolvedValue(new Response('{}'));
		await expect(
			http_json('test_provider', 'https://api.example.com', {
				max_response_bytes: 25 * 1024 * 1024,
			}),
		).resolves.toEqual({});
	});

	it('cancels the body stream as soon as its byte limit is exceeded', async () => {
		const cancel = vi.fn();
		let reads = 0;
		const body = new ReadableStream<Uint8Array>(
			{
				pull(controller) {
					reads++;
					controller.enqueue(new TextEncoder().encode('😀'));
					if (reads === 10) controller.close();
				},
				cancel,
			},
			{ highWaterMark: 0 },
		);
		fetch_mock.mockResolvedValue(new Response(body));
		await expect(
			http_json('test_provider', 'https://api.example.com', {
				max_response_bytes: 5,
			}),
		).rejects.toMatchObject({
			type: ErrorType.PROVIDER_ERROR,
			details: { retryable: false, cause: 'response_too_large' },
		});
		expect(reads).toBe(2);
		expect(cancel).toHaveBeenCalledTimes(1);
	});

	it('returns parsed JSON for successful responses', async () => {
		fetch_mock.mockResolvedValue(
			new Response(JSON.stringify({ ok: true, value: 42 }), {
				status: 200,
				headers: { 'Content-Type': 'application/json' },
			}),
		);

		await expect(
			http_json('exa', 'https://api.example.com'),
		).resolves.toEqual({ ok: true, value: 42 });
	});

	it.each(['plain text body', '{"unterminated":', ''])(
		'rejects malformed successful JSON: %s',
		async (body) => {
			fetch_mock.mockResolvedValue(
				new Response(body, { status: 200 }),
			);

			await expect(
				http_json('exa', 'https://api.example.com'),
			).rejects.toMatchObject({
				type: ErrorType.PROVIDER_ERROR,
				message: 'Provider returned invalid JSON',
				details: {
					retryable: false,
					cause: 'invalid_json',
					status: 200,
				},
			});
		},
	);

	it('allows configured non-2xx statuses', async () => {
		fetch_mock.mockResolvedValue(
			new Response('{"found":false}', { status: 404 }),
		);

		await expect(
			http_json('exa', 'https://api.example.com', {
				expectedStatuses: [404],
			}),
		).resolves.toEqual({ found: false });
	});

	it('preserves valid JSON null instead of returning the raw text', async () => {
		fetch_mock.mockResolvedValue(new Response('null'));
		await expect(
			http_json('test_provider', 'https://api.example.com'),
		).resolves.toBeNull();
	});

	it('throws a specific error for 401 responses', async () => {
		fetch_mock.mockResolvedValue(
			new Response('nope', { status: 401 }),
		);

		await expect(
			http_json('test_provider', 'https://api.example.com'),
		).rejects.toMatchObject({
			type: ErrorType.API_ERROR,
			provider: 'test_provider',
			message: 'Invalid API key',
		});
	});

	it('throws a specific error for 403 responses', async () => {
		fetch_mock.mockResolvedValue(
			new Response('forbidden', { status: 403 }),
		);

		await expect(
			http_json('test_provider', 'https://api.example.com'),
		).rejects.toMatchObject({
			type: ErrorType.ENTITLEMENT_REQUIRED,
			provider: 'test_provider',
			message: 'API key does not have access to this endpoint',
		});
	});

	it('classifies endpoint-missing responses when the body indicates a missing route', async () => {
		fetch_mock.mockResolvedValue(
			new Response('<pre>Cannot POST /v1/agent</pre>', {
				status: 404,
			}),
		);

		await expect(
			http_json(
				'firecrawl_agent',
				'https://api.firecrawl.dev/v1/agent',
				{
					method: 'POST',
				},
			),
		).rejects.toMatchObject({
			type: ErrorType.ENDPOINT_NOT_FOUND,
			provider: 'firecrawl_agent',
			message: 'Endpoint not found',
			details: {
				status: 404,
				url: 'https://api.firecrawl.dev',
				method: 'POST',
			},
		});
	});

	it('surfaces rate limit errors for 429 responses', async () => {
		fetch_mock.mockResolvedValue(
			new Response('slow down', { status: 429 }),
		);

		await expect(
			http_json('brave', 'https://api.example.com'),
		).rejects.toMatchObject({
			type: ErrorType.RATE_LIMIT,
			provider: 'brave',
			message: 'Rate limit exceeded for brave',
		});
	});

	it('converts 5xx responses into provider errors', async () => {
		fetch_mock.mockResolvedValue(
			new Response('server error', { status: 503 }),
		);

		await expect(
			http_json('tavily', 'https://api.example.com'),
		).rejects.toMatchObject({
			type: ErrorType.PROVIDER_ERROR,
			provider: 'tavily',
			message: 'tavily API internal error',
		});
	});

	it('does not retain upstream validation inputs in HTTP errors', async () => {
		fetch_mock.mockResolvedValue(
			new Response(
				JSON.stringify({
					detail: [
						{ input: 'PRIVATE_INPUT', msg: 'bad request body' },
					],
				}),
				{
					status: 400,
					headers: { 'Content-Type': 'application/json' },
				},
			),
		);

		const error = await http_json(
			'exa',
			'https://api.example.com',
		).catch((failure: unknown) => failure);
		expect(error).toMatchObject({
			type: ErrorType.API_ERROR,
			provider: 'exa',
			message: 'Provider rejected the request (HTTP 400)',
		});
		expect(JSON.stringify(error)).not.toContain('PRIVATE_INPUT');
		expect(error).not.toHaveProperty('details.response');
	});

	it('serves an identical cacheable request from the cache only when enabled', async () => {
		reset_http_cache();
		fetch_mock.mockImplementation(async () =>
			Response.json({ value: fetch_mock.mock.calls.length }),
		);
		const options = {
			method: 'POST',
			headers: {
				Authorization: 'Bearer secret',
				Accept: 'application/json',
			},
			body: '{"q":"needle"}',
			cacheable: true,
		};
		// Off by default: two calls, two fetches.
		await http_json(
			'fixture',
			'https://api.example.com/search',
			options,
		);
		await http_json(
			'fixture',
			'https://api.example.com/search',
			options,
		);
		expect(fetch_mock).toHaveBeenCalledTimes(2);

		vi.stubEnv('RETRIEVER_HTTP_CACHE_BYTES', '1048576');
		try {
			const first = await http_json(
				'fixture',
				'https://api.example.com/search',
				options,
			);
			expect(fetch_mock).toHaveBeenCalledTimes(3);
			// A hit returns an equal body and makes no provider call, but
			// still counts against the response byte budget.
			await run_with_request_context(
				undefined,
				async () => {
					await expect(
						http_json(
							'fixture',
							'https://api.example.com/search',
							options,
						),
					).resolves.toEqual(first);
					expect(() =>
						consume_response_bytes(MAX_REQUEST_RESPONSE_BYTES),
					).toThrow();
				},
				{ http_budget: { limit: 0, used: 0 } },
			);
			expect(fetch_mock).toHaveBeenCalledTimes(3);
			// The credential header is not part of the key.
			await http_json('fixture', 'https://api.example.com/search', {
				...options,
				headers: {
					...options.headers,
					Authorization: 'Bearer other',
				},
			});
			expect(fetch_mock).toHaveBeenCalledTimes(3);
			// Different body, provider, or an opted-out call all miss.
			await http_json('fixture', 'https://api.example.com/search', {
				...options,
				body: '{"q":"other"}',
			});
			await http_json(
				'other',
				'https://api.example.com/search',
				options,
			);
			await http_json('fixture', 'https://api.example.com/search', {
				...options,
				cacheable: false,
			});
			expect(fetch_mock).toHaveBeenCalledTimes(6);
			// The boolean never reaches fetch as a RequestCache value.
			expect(fetch_mock.mock.calls[0][1]).not.toHaveProperty(
				'cacheable',
			);
			expect(fetch_mock.mock.calls[0][1]).not.toHaveProperty('cache');
		} finally {
			vi.unstubAllEnvs();
			reset_http_cache();
		}
	});

	it('does not cache failed responses', async () => {
		reset_http_cache();
		vi.stubEnv('RETRIEVER_HTTP_CACHE_BYTES', '1048576');
		try {
			fetch_mock.mockImplementation(async () =>
				fetch_mock.mock.calls.length === 1
					? new Response('', { status: 503 })
					: Response.json({ ok: true }),
			);
			await expect(
				http_json('fixture', 'https://api.example.com/x', {
					cacheable: true,
				}),
			).rejects.toMatchObject({ details: { status: 503 } });
			await expect(
				http_json('fixture', 'https://api.example.com/x', {
					cacheable: true,
				}),
			).resolves.toEqual({ ok: true });
			expect(fetch_mock).toHaveBeenCalledTimes(2);
		} finally {
			vi.unstubAllEnvs();
			reset_http_cache();
		}
	});

	it('classifies a 5xx as transient even when its body mentions upgrades', async () => {
		fetch_mock.mockResolvedValue(
			new Response(
				'<html>We are upgrading our systems; subscription services are forbidden during maintenance.</html>',
				{ status: 503, headers: { 'Content-Type': 'text/html' } },
			),
		);
		const error = await http_json(
			'test_provider',
			'https://api.example.com',
		).catch((failure: unknown) => failure);
		expect(error).toMatchObject({
			type: ErrorType.PROVIDER_ERROR,
			message: 'test_provider API internal error',
			details: { status: 503 },
		});
		expect(is_retryable_error(error)).toBe(true);
		expect(public_error_metadata(error).kind).toBe(
			'upstream_failure',
		);
	});

	it('does not infer entitlement from an unstructured 4xx body', async () => {
		// A raw body may echo the caller's own query text.
		fetch_mock.mockResolvedValue(
			new Response(
				'query "how to upgrade my subscription" is invalid',
				{
					status: 400,
					headers: { 'Content-Type': 'text/plain' },
				},
			),
		);
		await expect(
			http_json('test_provider', 'https://api.example.com'),
		).rejects.toMatchObject({
			type: ErrorType.API_ERROR,
			message: 'Provider rejected the request (HTTP 400)',
		});
	});

	it('refunds a rejected oversized body so later calls keep their aggregate budget', async () => {
		const chunk = new Uint8Array(6);
		const body = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(chunk);
				controller.enqueue(chunk);
				controller.close();
			},
		});
		fetch_mock
			.mockResolvedValueOnce(new Response(body, { status: 200 }))
			.mockResolvedValueOnce(Response.json({ ok: true }));
		await run_with_request_context(undefined, async () => {
			await expect(
				http_json('test_provider', 'https://api.example.com', {
					max_response_bytes: 8,
				}),
			).rejects.toMatchObject({
				message: 'Provider response exceeds byte limit',
			});
			// The whole aggregate budget is still available afterwards.
			expect(() =>
				consume_response_bytes(MAX_REQUEST_RESPONSE_BYTES),
			).not.toThrow();
			release_response_bytes(MAX_REQUEST_RESPONSE_BYTES);
			await expect(
				http_json('test_provider', 'https://api.example.com'),
			).resolves.toEqual({ ok: true });
		});
	});

	it('classifies entitlement errors from provider response text', async () => {
		fetch_mock.mockResolvedValue(
			new Response(
				JSON.stringify({
					error: 'API key does not have access to this endpoint',
				}),
				{
					status: 400,
					headers: { 'Content-Type': 'application/json' },
				},
			),
		);

		await expect(
			http_json('test_provider', 'https://api.example.com'),
		).rejects.toMatchObject({
			type: ErrorType.ENTITLEMENT_REQUIRED,
			provider: 'test_provider',
			message: 'API key does not have access to this endpoint',
		});
	});
});
