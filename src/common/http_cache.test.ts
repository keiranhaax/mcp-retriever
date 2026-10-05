import {
	afterEach,
	beforeEach,
	describe,
	expect,
	it,
	vi,
} from 'vitest';
import {
	cache_get,
	cache_key,
	cache_set,
	cache_settings,
	get_http_cache_snapshot,
	reset_http_cache,
} from './http_cache.js';

describe('http cache', () => {
	beforeEach(() => reset_http_cache());
	afterEach(() => vi.unstubAllEnvs());

	it('is disabled unless a byte capacity is configured', () => {
		expect(cache_settings()).toEqual({ bytes: 0, ttl_ms: 300_000 });
		cache_set('k', 'v');
		expect(cache_get('k')).toBeUndefined();
		expect(get_http_cache_snapshot()).toMatchObject({
			enabled: false,
			entries: 0,
			misses: 1,
		});
	});

	it('clamps and validates the environment settings', () => {
		vi.stubEnv('RETRIEVER_HTTP_CACHE_BYTES', '-5');
		vi.stubEnv('RETRIEVER_HTTP_CACHE_TTL_MS', 'soon');
		expect(cache_settings()).toEqual({ bytes: 0, ttl_ms: 300_000 });
		vi.stubEnv('RETRIEVER_HTTP_CACHE_BYTES', String(2 ** 40));
		vi.stubEnv('RETRIEVER_HTTP_CACHE_TTL_MS', String(2 ** 40));
		expect(cache_settings()).toEqual({
			bytes: 256 * 1024 * 1024,
			ttl_ms: 24 * 60 * 60 * 1000,
		});
	});

	it('keys on provider, method, url, body and non-credential headers only', () => {
		const base = cache_key(
			'brave',
			'GET',
			'https://a.test/?q=1',
			undefined,
			{
				Accept: 'application/json',
				'X-Subscription-Token': 'secret-a',
			},
		);
		expect(base).toMatch(/^[0-9a-f]{64}$/);
		expect(
			cache_key('brave', 'get', 'https://a.test/?q=1', undefined, {
				'X-Subscription-Token': 'secret-b',
				accept: 'application/json',
			}),
		).toBe(base);
		expect(
			cache_key('brave', 'GET', 'https://a.test/?q=1', undefined, {
				Accept: 'application/json',
				'X-Loc-Country': 'US',
			}),
		).not.toBe(base);
		expect(
			cache_key('tavily', 'GET', 'https://a.test/?q=1', undefined, {
				Accept: 'application/json',
			}),
		).not.toBe(base);
		expect(
			cache_key(
				'brave',
				'POST',
				'https://a.test/?q=1',
				'{"a":1}',
				{},
			),
		).not.toBe(
			cache_key(
				'brave',
				'POST',
				'https://a.test/?q=1',
				'{"a":2}',
				{},
			),
		);
	});

	it('expires entries by ttl and evicts the least recently used by bytes', () => {
		vi.stubEnv('RETRIEVER_HTTP_CACHE_BYTES', '10');
		vi.stubEnv('RETRIEVER_HTTP_CACHE_TTL_MS', '1000');
		cache_set('a', '1234', 0);
		cache_set('b', '5678', 0);
		expect(cache_get('a', 500)).toBe('1234');
		// `b` is now the least recently used; storing three more bytes
		// exceeds the ten-byte capacity, so `b` goes first.
		cache_set('c', '901', 500);
		expect(cache_get('b', 600)).toBeUndefined();
		expect(cache_get('a', 600)).toBe('1234');
		expect(cache_get('c', 600)).toBe('901');
		expect(cache_get('a', 1001)).toBeUndefined();
		// Oversized bodies are never stored.
		cache_set('big', 'x'.repeat(11), 0);
		expect(get_http_cache_snapshot()).toMatchObject({
			enabled: true,
			capacity_bytes: 10,
			entries: 1,
			stored_bytes: 3,
		});
	});
});
