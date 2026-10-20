import { describe, expect, it, vi } from 'vitest';
import {
	create_error_response,
	handle_provider_error,
	handle_rate_limit,
	input_error,
	local_fetch_error,
	MAX_PUBLIC_ERROR_LENGTH,
	public_error_metadata,
	retention_error,
	sanitize_query,
} from './errors.js';
import { ErrorType, ProviderError } from './types.js';
import { is_retryable_error } from './retry.js';

describe('local extraction errors', () => {
	it.each([
		'unsafe_address',
		'dns_failure',
		'peer_mismatch',
		'connection_failed',
		'tls_failed',
		'redirect_limit',
		'redirect_downgrade',
		'invalid_redirect',
		'headers_too_large',
		'response_too_large',
		'unsupported_content',
		'unsupported_encoding',
		'invalid_encoding',
		'upstream_status',
	] as const)(
		'keeps %s fixed, typed, non-retryable, and useful publicly',
		(reason) => {
			const error = local_fetch_error(reason);
			expect(error.details).toEqual({
				cause: reason,
				retryable: false,
			});
			expect(error.cause).toBeUndefined();
			expect(create_error_response(error).error).toContain(
				error.message,
			);
			expect(public_error_metadata(error)).toEqual({
				provider: 'defuddle',
				retryable: false,
				kind:
					reason === 'unsafe_address'
						? 'bad_input'
						: 'upstream_failure',
			});
		},
	);
});

it('distinguishes local storage failure from upstream failure', () => {
	expect(
		public_error_metadata(
			new ProviderError(
				ErrorType.PROVIDER_ERROR,
				'private',
				'fixture',
				{ cause: 'storage', retryable: false },
			),
		),
	).toMatchObject({ kind: 'storage_failure', retryable: false });
});

it('classifies a reached spending cap with its reset time and shows the local message', () => {
	const error = new ProviderError(
		ErrorType.PROVIDER_ERROR,
		'Spending cap reached for exa: 1 usd per UTC day; resets at 2026-10-02T00:00:00.000Z',
		'exa',
		{
			cause: 'spend_cap',
			retryable: false,
			public: true,
			reset_time: new Date('2026-10-02T00:00:00.000Z'),
			spent: 1.2,
		},
	);
	expect(public_error_metadata(error)).toEqual({
		kind: 'spend_cap',
		retryable: false,
		provider: 'exa',
		reset_at: '2026-10-02T00:00:00.000Z',
	});
	expect(create_error_response(error)).toEqual({
		error:
			'exa error [PROVIDER_ERROR]: Spending cap reached for exa: 1 usd per UTC day; resets at 2026-10-02T00:00:00.000Z',
	});
	// Without the public marker a provider-side message stays hidden, and
	// an unusable reset time is simply omitted.
	const hidden = new ProviderError(
		ErrorType.PROVIDER_ERROR,
		'PRIVATE upstream text',
		'exa',
		{ cause: 'spend_cap', retryable: false, reset_time: 'soon' },
	);
	expect(public_error_metadata(hidden)).toEqual({
		kind: 'spend_cap',
		retryable: false,
		provider: 'exa',
	});
	expect(create_error_response(hidden).error).not.toContain(
		'PRIVATE',
	);
});

describe('handle_rate_limit', () => {
	it('preserves a safe timeout message from an outer operation deadline', () => {
		expect(
			create_error_response(
				new DOMException('private reason', 'TimeoutError'),
			),
		).toEqual({ error: 'Operation timed out' });
	});
	it('keeps an invalid reset Date typed and disables retry', () => {
		expect(() =>
			handle_rate_limit('test_provider', new Date(NaN)),
		).toThrowError(
			expect.objectContaining({
				type: ErrorType.RATE_LIMIT,
				details: { retryable: false, reset_time: undefined },
			}),
		);
	});
	it('throws a provider error with the reset time in details', () => {
		const reset_time = new Date('2026-04-15T12:00:00.000Z');

		expect(() => handle_rate_limit('brave', reset_time)).toThrowError(
			expect.objectContaining({
				type: ErrorType.RATE_LIMIT,
				provider: 'brave',
				details: { reset_time },
				message:
					'Rate limit exceeded for brave. Reset at 2026-04-15T12:00:00.000Z',
			}),
		);
	});
});

describe('handle_provider_error', () => {
	it('does not retry application TypeErrors as network failures', () => {
		try {
			handle_provider_error(
				new TypeError('PRIVATE_MAPPING_INPUT'),
				'test_provider',
				'parse response',
			);
		} catch (error) {
			expect(is_retryable_error(error)).toBe(false);
			expect(error).toMatchObject({ details: { retryable: false } });
			expect((error as Error).message).not.toContain(
				'PRIVATE_MAPPING_INPUT',
			);
		}
	});
	it('rethrows existing provider errors unchanged', () => {
		const error = new ProviderError(
			ErrorType.PROVIDER_ERROR,
			'already wrapped',
			'test_provider',
		);

		expect(() =>
			handle_provider_error(error, 'test_provider', 'fetch results'),
		).toThrow(error);
	});

	it('wraps generic errors without exposing their upstream message', () => {
		expect(() =>
			handle_provider_error(
				new Error('boom'),
				'tavily',
				'fetch search results',
			),
		).toThrowError(
			expect.objectContaining({
				type: ErrorType.API_ERROR,
				provider: 'tavily',
				message: 'Failed to fetch search results',
				details: { retryable: false },
			}),
		);
	});

	it('keeps the original failure reachable as a non-enumerable cause', () => {
		const original = new TypeError('PRIVATE_MAPPING_INPUT');
		let wrapped: unknown;
		try {
			handle_provider_error(original, 'tavily', 'parse response');
		} catch (error) {
			wrapped = error;
		}
		expect((wrapped as Error).cause).toBe(original);
		expect(Object.keys(wrapped as object)).not.toContain('cause');
		expect(JSON.stringify(wrapped)).not.toContain(
			'PRIVATE_MAPPING_INPUT',
		);
		expect(create_error_response(wrapped).error).not.toContain(
			'PRIVATE_MAPPING_INPUT',
		);
	});
});

describe('input_error', () => {
	it('marks schema-derived validation text as safe to show', () => {
		const error = input_error(
			'count must be an integer between 1 and 50',
			'brave_news',
		);
		expect(error).toMatchObject({
			type: ErrorType.INVALID_INPUT,
			details: { retryable: false, public: true },
		});
		expect(is_retryable_error(error)).toBe(false);
		expect(create_error_response(error).error).toBe(
			'brave_news error [INVALID_INPUT]: count must be an integer between 1 and 50',
		);
		expect(public_error_metadata(error).kind).toBe('bad_input');
	});

	it('still hides unmarked validation messages that are not allowlisted', () => {
		const error = new ProviderError(
			ErrorType.INVALID_INPUT,
			'Rejected input: PRIVATE_PATH',
			'test_provider',
		);
		expect(create_error_response(error).error).toBe(
			'test_provider error [INVALID_INPUT]: Invalid input. Check required fields and allowed values in the tool schema.',
		);
	});
});

describe('retention_error', () => {
	it('reports the failure class on stderr and keeps the cause private', () => {
		const stderr = vi
			.spyOn(console, 'error')
			.mockImplementation(() => {});
		const failure = Object.assign(new Error('PRIVATE_PATH'), {
			code: 'ENOSPC',
		});
		const error = retention_error('presentation', failure, {
			job_id: 'job-1',
		});
		expect(error).toMatchObject({
			type: ErrorType.PROVIDER_ERROR,
			provider: 'presentation',
			message:
				'Cannot retain complete canonical result; no evidence was returned',
			details: {
				retryable: false,
				cause: 'storage',
				job_id: 'job-1',
			},
		});
		expect(error.cause).toBe(failure);
		expect(JSON.stringify(error)).not.toContain('PRIVATE_PATH');
		expect(stderr).toHaveBeenCalledWith(
			'Result retention failed for presentation: ENOSPC',
		);
		expect(public_error_metadata(error).kind).toBe('storage_failure');
		stderr.mockRestore();
	});

	it.each(['AbortError', 'TimeoutError'])(
		'preserves %s classification through provider wrapping',
		(name) => {
			expect(() =>
				handle_provider_error(
					new DOMException('PRIVATE_INPUT', name),
					'test_provider',
				),
			).toThrowError(
				expect.objectContaining({
					type: ErrorType.API_ERROR,
					message:
						name === 'TimeoutError'
							? 'Operation timed out'
							: 'Operation cancelled',
					details: {
						retryable: false,
						cause: name === 'TimeoutError' ? 'timeout' : 'cancelled',
					},
				}),
			);
		},
	);
});

describe('sanitize_query', () => {
	it('trims whitespace and collapses newlines into spaces', () => {
		expect(sanitize_query('  hello\nworld\r\nagain  ')).toBe(
			'hello world again',
		);
	});
});

describe('public_error_metadata', () => {
	it.each([
		[ErrorType.API_ERROR, { status: 401 }, 'authentication', false],
		[ErrorType.API_ERROR, { status: 402 }, 'entitlement', false],
		[
			ErrorType.ENTITLEMENT_REQUIRED,
			{ status: 400 },
			'entitlement',
			false,
		],
		[ErrorType.RATE_LIMIT, {}, 'rate_limit', true],
		[ErrorType.RATE_LIMIT, { retryable: false }, 'rate_limit', false],
		[
			ErrorType.ENDPOINT_NOT_FOUND,
			{ status: 404 },
			'endpoint_mismatch',
			false,
		],
		[ErrorType.INVALID_INPUT, {}, 'bad_input', false],
		[
			ErrorType.API_ERROR,
			{ cause: 'timeout', retryable: false },
			'timeout',
			false,
		],
		[
			ErrorType.API_ERROR,
			{ cause: 'cancelled', retryable: false },
			'cancelled',
			false,
		],
		[
			ErrorType.API_ERROR,
			{ cause: 'network', retryable: true },
			'upstream_failure',
			true,
		],
		[
			ErrorType.API_ERROR,
			{ retryable: true },
			'upstream_failure',
			false,
		],
		[ErrorType.PROVIDER_ERROR, {}, 'upstream_failure', true],
		[
			ErrorType.PROVIDER_ERROR,
			{ status: 503, retryable: false },
			'upstream_failure',
			false,
		],
		[
			ErrorType.PROVIDER_ERROR,
			{ cause: 'request_budget', retryable: false },
			'request_budget',
			false,
		],
		[
			ErrorType.PROVIDER_ERROR,
			{ cause: 'concurrency_limit', retryable: false },
			'queue_full',
			false,
		],
	] as const)(
		'classifies %s with %j without changing retry policy',
		(type, details, kind, retryable) => {
			const error = new ProviderError(
				type,
				'PRIVATE_BODY',
				'test_provider',
				details,
			);
			const metadata = public_error_metadata(error);
			expect(metadata).toMatchObject({
				kind,
				retryable,
				provider: 'test_provider',
			});
			expect(metadata.retryable).toBe(is_retryable_error(error));
		},
	);

	it.each([
		'401',
		'403',
		'429',
		NaN,
		Infinity,
		-1,
		0,
		99,
		600,
		401.5,
		{},
		null,
		undefined,
	])(
		'ignores malformed HTTP status %j without changing legacy retry semantics',
		(status) => {
			for (const type of [
				ErrorType.API_ERROR,
				ErrorType.PROVIDER_ERROR,
			]) {
				const error = new ProviderError(
					type,
					'Invalid API key',
					'test_provider',
					{ status },
				);
				expect(public_error_metadata(error)).toEqual({
					kind: 'upstream_failure',
					retryable: is_retryable_error(error),
					provider: 'test_provider',
				});
			}
		},
	);

	it.each([100, 200, 599])(
		'retains valid HTTP status %s',
		(status) => {
			expect(
				public_error_metadata(
					new ProviderError(
						ErrorType.PROVIDER_ERROR,
						'PRIVATE_BODY',
						'test_provider',
						{ status },
					),
				),
			).toEqual({
				kind: 'upstream_failure',
				retryable: false,
				provider: 'test_provider',
				http_status: status,
			});
		},
	);

	it.each([
		null,
		undefined,
		'PRIVATE_BODY',
		new Error('PRIVATE_BODY'),
		{ name: 'TimeoutError', status: 401 },
	])('does not trust arbitrary thrown values: %j', (error) =>
		expect(public_error_metadata(error)).toEqual({
			kind: 'upstream_failure',
			retryable: false,
		}),
	);

	it.each([
		['AbortError', 'cancelled'],
		['TimeoutError', 'timeout'],
	] as const)(
		'classifies a native %s without exposing its reason',
		(name, kind) =>
			expect(
				public_error_metadata(
					new DOMException('PRIVATE_REASON', name),
				),
			).toEqual({ kind, retryable: false }),
	);

	it.each([
		'',
		'a'.repeat(65),
		'../PRIVATE_PATH',
		'test_provider\n',
		401,
		null,
		{},
	])('omits an invalid provider identifier: %j', (provider) => {
		const error = Object.assign(
			new ProviderError(
				ErrorType.API_ERROR,
				'private',
				'test_provider',
			),
			{ provider },
		);
		expect(public_error_metadata(error)).not.toHaveProperty(
			'provider',
		);
	});

	it('returns only bounded, provider-specific recovery IDs and safe fields', () => {
		const job_id = '12345678-1234-4234-8234-123456789abc';
		const details = {
			status: 503,
			job_id,
			request_id: 'a'.repeat(200),
			url: 'https://user:password@api.example.com/PRIVATE_PATH?token=SECRET',
			response: 'PRIVATE_BODY'.repeat(10_000),
			headers: { authorization: 'SECRET' },
			recovery: 'PRIVATE_RECOVERY',
		};
		const job_providers = [
			'firecrawl_agent',
			'firecrawl_crawl',
			'firecrawl_extract',
		];
		for (const provider of [
			...job_providers,
			'tavily_research',
			'test_provider',
		]) {
			const metadata = public_error_metadata(
				new ProviderError(
					ErrorType.PROVIDER_ERROR,
					'PRIVATE_MESSAGE',
					provider,
					details,
				),
			);
			expect(metadata).toEqual({
				kind: 'upstream_failure',
				retryable: true,
				provider,
				http_status: 503,
				...(job_providers.includes(provider) ? { job_id } : {}),
				...(provider === 'tavily_research'
					? { request_id: details.request_id }
					: {}),
			});
			expect(JSON.stringify(metadata).length).toBeLessThanOrEqual(
				MAX_PUBLIC_ERROR_LENGTH,
			);
		}
	});

	it.each([
		'',
		'../PRIVATE_PATH',
		'id with spaces',
		'id\n',
		'a'.repeat(201),
		12,
		null,
		{},
	])('omits invalid recovery IDs: %j', (id) => {
		for (const provider of ['firecrawl_agent', 'tavily_research']) {
			const metadata = public_error_metadata(
				new ProviderError(ErrorType.API_ERROR, 'private', provider, {
					job_id: id,
					request_id: id,
				}),
			);
			expect(metadata).not.toHaveProperty('job_id');
			expect(metadata).not.toHaveProperty('request_id');
		}
	});

	it('does not accept a malformed Firecrawl UUID or a trailing newline', () => {
		for (const job_id of [
			'job-1',
			'12345678-1234-4234-8234-123456789abc\n',
		]) {
			expect(
				public_error_metadata(
					new ProviderError(
						ErrorType.API_ERROR,
						'private',
						'firecrawl_agent',
						{ job_id },
					),
				),
			).not.toHaveProperty('job_id');
		}
	});
});

describe('create_error_response', () => {
	it('opts into bounded Firecrawl recovery without trusting upstream guidance', () => {
		const job_id = '12345678-1234-4234-8234-123456789abc';
		const error = new ProviderError(
			ErrorType.PROVIDER_ERROR,
			'PRIVATE_BODY'.repeat(10_000),
			'firecrawl_agent',
			{
				job_id,
				recovery: 'PRIVATE_RECOVERY'.repeat(10_000),
				url: 'https://user:password@api.example.com/PRIVATE_PATH?token=SECRET',
			},
		);
		const legacy = create_error_response(error).error;
		expect(legacy).toBe(
			'firecrawl_agent error [PROVIDER_ERROR]: Provider request failed (endpoint: https://api.example.com)',
		);
		const message = create_error_response(error, {
			include_recovery: true,
		}).error;
		expect(message).toBe(
			`${legacy} job_id=${job_id}. Use firecrawl_agent action="status" or action="cancel" with this job_id; do not start a new job.`,
		);
		expect(message.length).toBeLessThanOrEqual(
			MAX_PUBLIC_ERROR_LENGTH,
		);
		expect(message).not.toMatch(/PRIVATE|SECRET|password/);
	});

	it('does not render invalid or wrong-provider Firecrawl recovery IDs', () => {
		for (const [provider, job_id] of [
			['firecrawl_agent', '../PRIVATE_PATH'],
			['firecrawl_agent', '12345678-1234-4234-8234-123456789abc\n'],
			['test_provider', '12345678-1234-4234-8234-123456789abc'],
		]) {
			const error = new ProviderError(
				ErrorType.API_ERROR,
				'private',
				provider,
				{ job_id },
			);
			expect(
				create_error_response(error, { include_recovery: true }),
			).toEqual(create_error_response(error));
		}
	});

	it('preserves only a validated Tavily task ID in safe recovery guidance', () => {
		const error = new ProviderError(
			ErrorType.RATE_LIMIT,
			'PRIVATE_PROMPT',
			'tavily_research',
			{ request_id: 'job-1' },
		);
		const message = create_error_response(error).error;
		expect(message).toBe(
			'tavily_research error [RATE_LIMIT]: Rate limit exceeded Resume with ai_search provider="tavily_research", action="status", request_id="job-1"; do not start a new research task.',
		);
		expect(
			create_error_response(error, { include_recovery: true }).error,
		).toBe(message);
		expect(message).toContain('job-1');
		expect(message).toContain('action="status"');
		expect(message).not.toContain('PRIVATE_PROMPT');
		for (const request_id of [
			'../PRIVATE_PATH',
			'PRIVATE_QUERY with spaces',
			'a'.repeat(201),
		]) {
			expect(
				create_error_response(
					new ProviderError(
						ErrorType.API_ERROR,
						'private',
						'tavily_research',
						{ request_id },
					),
				).error,
			).not.toContain(request_id);
		}
	});
	it.each([
		'Invalid URL provided: file:///PRIVATE_PATH?SECRET',
		'Invalid URL provided: /PRIVATE_PATH?SECRET',
		'Invalid URL provided: https:broken PRIVATE_QUERY',
		'Invalid query: PRIVATE_QUERY',
	])('does not expose rejected input: %s', (message) => {
		const response = create_error_response(
			new ProviderError(
				ErrorType.INVALID_INPUT,
				message,
				'test_provider',
			),
		).error;
		expect(response).not.toMatch(/PRIVATE_PATH|PRIVATE_QUERY|SECRET/);
		expect(response).toContain('test_provider error [INVALID_INPUT]');
		expect(response).toMatch(
			/Use a public HTTP\(S\) URL|Check required fields/,
		);
	});

	it.each([
		'Result not found or expired',
		'Invalid result ID',
		'Offset must be a positive integer',
		'Limit must be an integer between 1 and 500',
		'Byte offset must be a non-negative safe integer',
		'Byte offset exceeds the selected line',
		'Byte offset must be on a UTF-8 character boundary',
		'Tavily supports at most 20 results',
		'Invalid URL provided; use a public HTTP(S) URL without credentials',
		'At least one URL is required',
		'A valid job_id is required',
		'storeInCache cannot be true when zeroDataRetention is enabled',
	])('preserves safe validation guidance: %s', (message) => {
		expect(
			create_error_response(
				new ProviderError(
					ErrorType.INVALID_INPUT,
					message,
					'test_provider',
				),
			).error,
		).toContain(message);
	});
	it.each([ErrorType.API_ERROR, ErrorType.PROVIDER_ERROR])(
		'never exposes arbitrary upstream %s messages',
		(type) => {
			const error = new ProviderError(
				type,
				'PRIVATE_INPUT '.repeat(30_000),
				'test_provider',
				{
					url: 'https://user:password@api.example.com/private-token?signature=SECRET#fragment',
					response: 'PRIVATE_INPUT',
				},
			);
			const response = create_error_response(error).error;
			expect(response).not.toMatch(
				/PRIVATE_INPUT|SECRET|password|private-token|fragment/,
			);
			expect(response).toContain(type);
			expect(response.length).toBeLessThanOrEqual(1024);
		},
	);
	it('formats provider errors with the provider prefix', () => {
		const error = new ProviderError(
			ErrorType.API_ERROR,
			'Invalid API key',
			'exa',
		);

		expect(create_error_response(error)).toEqual({
			error: 'exa error [API_ERROR]: Invalid API key',
		});
	});

	it('adds endpoint and guidance for entitlement and endpoint errors', () => {
		const entitlement_error = new ProviderError(
			ErrorType.ENTITLEMENT_REQUIRED,
			'API key does not have access to this endpoint',
			'test_provider',
			{ url: 'https://api.example.com/v1/search' },
		);
		expect(create_error_response(entitlement_error)).toEqual({
			error:
				'test_provider error [ENTITLEMENT_REQUIRED]: API key does not have access to this endpoint (endpoint: https://api.example.com) Verify API key plan/entitlement for this endpoint.',
		});

		const endpoint_error = new ProviderError(
			ErrorType.ENDPOINT_NOT_FOUND,
			'Endpoint not found',
			'firecrawl_agent',
			{ url: 'https://api.firecrawl.dev/v1/agent' },
		);
		expect(create_error_response(endpoint_error)).toEqual({
			error:
				'firecrawl_agent error [ENDPOINT_NOT_FOUND]: Endpoint not found (endpoint: https://api.firecrawl.dev) Verify endpoint configuration or set FIRECRAWL_AGENT_URL.',
		});
	});

	it('does not expose unclassified error messages', () => {
		expect(create_error_response(new Error('PRIVATE_INPUT'))).toEqual(
			{
				error: 'Unexpected error: operation failed',
			},
		);
	});
});
