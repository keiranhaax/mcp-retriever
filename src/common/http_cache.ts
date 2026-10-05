import { createHash } from 'node:crypto';

/**
 * Optional in-memory cache for idempotent provider responses. Off unless
 * RETRIEVER_HTTP_CACHE_BYTES is set; identical requests within
 * RETRIEVER_HTTP_CACHE_TTL_MS then reuse the stored body instead of
 * spending another paid call. Only callers that opt in per request are
 * cached, never job creation, status or cancel calls. Keys never include
 * credential headers, and the cache lives only in this process.
 */

const MAX_CACHE_BYTES = 256 * 1024 * 1024;
const MAX_TTL_MS = 24 * 60 * 60 * 1000;
const DEFAULT_TTL_MS = 5 * 60 * 1000;

const bounded = (
	raw: string | undefined,
	fallback: number,
	max: number,
) => {
	if (raw === undefined || raw === '') return fallback;
	const value = Number(raw);
	if (!/^\d+$/.test(raw) || !Number.isSafeInteger(value))
		return fallback;
	return Math.min(value, max);
};

export const cache_settings = () => ({
	bytes: bounded(
		process.env.RETRIEVER_HTTP_CACHE_BYTES,
		0,
		MAX_CACHE_BYTES,
	),
	ttl_ms: bounded(
		process.env.RETRIEVER_HTTP_CACHE_TTL_MS,
		DEFAULT_TTL_MS,
		MAX_TTL_MS,
	),
});

const credential_header =
	/^(authorization|proxy-authorization|cookie|x-api-key|x-subscription-token)$|key|token|secret/i;

export const cache_key = (
	provider: string,
	method: string,
	url: string,
	body: string | undefined,
	headers: Record<string, string> | undefined,
): string => {
	// Non-credential headers can change the answer (Brave location
	// headers, Accept); credentials never belong in a key.
	const relevant = Object.entries(headers ?? {})
		.filter(([name]) => !credential_header.test(name))
		.map(([name, value]) => `${name.toLowerCase()}=${value}`)
		.sort();
	return createHash('sha256')
		.update(
			[
				provider,
				method.toUpperCase(),
				url,
				body ?? '',
				...relevant,
			].join('\n'),
		)
		.digest('hex');
};

interface Entry {
	raw: string;
	bytes: number;
	expires_at: number;
}

const entries = new Map<string, Entry>();
let stored_bytes = 0;
let hits = 0;
let misses = 0;

// A replayed body carries the provider's original usage figures, which
// were paid for once already. Tag the parsed object so the request
// layer can strip that usage before it is reported or counted.
const replayed = new WeakSet<object>();

export const mark_served_from_cache = (body: unknown): void => {
	if (body !== null && typeof body === 'object') replayed.add(body);
};

export const was_served_from_cache = (body: unknown): boolean =>
	body !== null && typeof body === 'object' && replayed.has(body);

const evict = (key: string) => {
	const entry = entries.get(key);
	if (!entry) return;
	entries.delete(key);
	stored_bytes -= entry.bytes;
};

export const cache_get = (
	key: string,
	now = Date.now(),
): string | undefined => {
	const entry = entries.get(key);
	if (!entry) {
		misses++;
		return undefined;
	}
	if (entry.expires_at <= now) {
		evict(key);
		misses++;
		return undefined;
	}
	// Refresh recency: Map iteration order is the eviction order.
	entries.delete(key);
	entries.set(key, entry);
	hits++;
	return entry.raw;
};

export const cache_set = (
	key: string,
	raw: string,
	now = Date.now(),
): void => {
	const { bytes: capacity, ttl_ms } = cache_settings();
	const bytes = Buffer.byteLength(raw, 'utf8');
	if (capacity <= 0 || bytes > capacity) return;
	evict(key);
	for (const oldest of entries.keys()) {
		if (stored_bytes + bytes <= capacity) break;
		evict(oldest);
	}
	entries.set(key, { raw, bytes, expires_at: now + ttl_ms });
	stored_bytes += bytes;
};

export const get_http_cache_snapshot = () => {
	const { bytes, ttl_ms } = cache_settings();
	return {
		enabled: bytes > 0,
		capacity_bytes: bytes,
		ttl_ms,
		entries: entries.size,
		stored_bytes,
		hits,
		misses,
	};
};

export const reset_http_cache = () => {
	entries.clear();
	stored_bytes = 0;
	hits = 0;
	misses = 0;
};
