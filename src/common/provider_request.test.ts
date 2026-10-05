import * as v from 'valibot';
import {
	afterEach,
	beforeEach,
	describe,
	expect,
	it,
	vi,
} from 'vitest';
import { reset_http_cache } from './http_cache.js';
import { provider_json_request } from './provider_request.js';
import {
	get_response_metadata,
	set_response_metadata,
} from './response_metadata.js';
import { ErrorType, ProviderError } from './types.js';

const fetch_mock = vi.fn();
const schema = v.object({ value: v.number() });
const request = (overrides: Record<string, unknown> = {}) => ({
	url: 'https://api.example.test/items',
	headers: { Authorization: 'Bearer fixture-key' },
	timeout_ms: 5000,
	schema,
	operation: 'fetch items',
	...overrides,
});

describe('provider_json_request', () => {
	beforeEach(() => {
		fetch_mock.mockReset();
		vi.stubGlobal('fetch', fetch_mock);
	});

	afterEach(() => {
		vi.useRealTimers();
		vi.unstubAllGlobals();
		vi.unstubAllEnvs();
		vi.restoreAllMocks();
		reset_http_cache();
	});

	it('marks a mapped result as cached and drops its replayed usage', async () => {
		vi.stubEnv('RETRIEVER_HTTP_CACHE_BYTES', '1048576');
		reset_http_cache();
		fetch_mock.mockImplementation(async () =>
			Response.json({ value: 1, usage: { credits: 3 } }),
		);
		const map = (data: { value: number }) => {
			const result = { value: data.value };
			set_response_metadata(result, { usage: { credits: 3 } });
			return result;
		};
		const first = await provider_json_request(
			'fixture',
			request({ schema: v.looseObject({ value: v.number() }) }),
			map,
		);
		expect(get_response_metadata(first)).toEqual({
			usage: { credits: 3 },
		});
		const second = await provider_json_request(
			'fixture',
			request({ schema: v.looseObject({ value: v.number() }) }),
			map,
		);
		expect(fetch_mock).toHaveBeenCalledTimes(1);
		expect(second).toEqual({ value: 1 });
		expect(get_response_metadata(second)).toEqual({ cached: true });
		// An opted-out request is never a replay.
		const third = await provider_json_request(
			'fixture',
			request({
				schema: v.looseObject({ value: v.number() }),
				cacheable: false,
			}),
			map,
		);
		expect(fetch_mock).toHaveBeenCalledTimes(2);
		expect(get_response_metadata(third)).toEqual({
			usage: { credits: 3 },
		});
	});

	it('sends the request, validates the body and maps it', async () => {
		fetch_mock.mockResolvedValue(Response.json({ value: 7 }));
		await expect(
			provider_json_request(
				'fixture',
				request({ method: 'POST', body: { query: 'q' } }),
				(data) => data.value * 2,
			),
		).resolves.toBe(14);
		const [url, options] = fetch_mock.mock.calls[0];
		expect(url).toBe('https://api.example.test/items');
		expect(options).toMatchObject({
			method: 'POST',
			headers: { Authorization: 'Bearer fixture-key' },
			body: JSON.stringify({ query: 'q' }),
		});
		expect(options.signal).toBeInstanceOf(AbortSignal);
	});

	it('defaults to GET without a body and passes string bodies through', async () => {
		// A Response body reads once; hand out a fresh one per call.
		fetch_mock.mockImplementation(async () =>
			Response.json({ value: 1 }),
		);
		await provider_json_request('fixture', request(), (data) => data);
		expect(fetch_mock.mock.calls[0][1]).toMatchObject({
			method: 'GET',
		});
		expect(fetch_mock.mock.calls[0][1]).not.toHaveProperty('body');
		await provider_json_request(
			'fixture',
			request({ method: 'POST', body: '{"raw":true}' }),
			(data) => data,
		);
		expect(fetch_mock.mock.calls[1][1].body).toBe('{"raw":true}');
	});

	it('retries one transient failure and keeps the mapping inside the attempt', async () => {
		vi.useFakeTimers();
		vi.spyOn(Math, 'random').mockReturnValue(0);
		fetch_mock
			.mockResolvedValueOnce(new Response('', { status: 503 }))
			.mockResolvedValueOnce(Response.json({ value: 3 }));
		const map = vi.fn((data: { value: number }) => data.value);
		const pending = provider_json_request('fixture', request(), map);
		await vi.advanceTimersByTimeAsync(10);
		await expect(pending).resolves.toBe(3);
		expect(fetch_mock).toHaveBeenCalledTimes(2);
		expect(map).toHaveBeenCalledTimes(1);
	});

	it('never retries when max_retries is 0', async () => {
		fetch_mock.mockResolvedValue(new Response('', { status: 503 }));
		await expect(
			provider_json_request(
				'fixture',
				request({ max_retries: 0 }),
				(data) => data,
			),
		).rejects.toMatchObject({
			type: ErrorType.PROVIDER_ERROR,
			details: { status: 503 },
		});
		expect(fetch_mock).toHaveBeenCalledTimes(1);
	});

	it('rejects a malformed body as a non-retryable provider error', async () => {
		fetch_mock.mockResolvedValue(Response.json({ value: 'text' }));
		await expect(
			provider_json_request('fixture', request(), (data) => data),
		).rejects.toMatchObject({
			type: ErrorType.PROVIDER_ERROR,
			provider: 'fixture',
			message: 'Malformed fixture response',
			details: { retryable: false },
		});
		expect(fetch_mock).toHaveBeenCalledTimes(1);
	});

	it('wraps mapping failures without exposing their text and does not retry them', async () => {
		fetch_mock.mockResolvedValue(Response.json({ value: 1 }));
		await expect(
			provider_json_request('fixture', request(), () => {
				throw new TypeError('PRIVATE_MAPPING_DETAIL');
			}),
		).rejects.toMatchObject({
			type: ErrorType.API_ERROR,
			message: 'Failed to fetch items',
			details: { retryable: false },
		});
		expect(fetch_mock).toHaveBeenCalledTimes(1);
	});

	it('rethrows provider errors raised by the mapping unchanged', async () => {
		fetch_mock.mockResolvedValue(Response.json({ value: 0 }));
		const empty = new ProviderError(
			ErrorType.PROVIDER_ERROR,
			'No items returned',
			'fixture',
			{ retryable: false },
		);
		await expect(
			provider_json_request('fixture', request(), () => {
				throw empty;
			}),
		).rejects.toBe(empty);
		expect(fetch_mock).toHaveBeenCalledTimes(1);
	});

	it('applies timeout_ms per attempt and as the whole-call budget', async () => {
		vi.useFakeTimers();
		fetch_mock.mockImplementation(
			(_url: string, options: RequestInit) =>
				new Promise((_resolve, reject) => {
					options.signal?.addEventListener('abort', () =>
						reject(options.signal?.reason),
					);
				}),
		);
		let settled = false;
		const pending = provider_json_request(
			'fixture',
			request({ timeout_ms: 100 }),
			(data) => data,
		).catch((error: unknown) => {
			settled = true;
			return error;
		});
		await vi.advanceTimersByTimeAsync(100);
		expect(settled).toBe(true);
		expect(await pending).toMatchObject({ name: 'TimeoutError' });
		expect(fetch_mock).toHaveBeenCalledTimes(1);
		expect(fetch_mock.mock.calls[0][1].signal.aborted).toBe(true);
	});
});
