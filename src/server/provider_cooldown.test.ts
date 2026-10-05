import {
	afterEach,
	beforeEach,
	describe,
	expect,
	it,
	vi,
} from 'vitest';
import {
	create_error_response,
	handle_rate_limit,
	input_error,
	public_error_metadata,
} from '../common/errors.js';
import { retry_after_details } from '../common/http.js';
import {
	with_local_fetch_slot,
	with_provider_slot,
	PROVIDER_CONCURRENCY,
	PROVIDER_QUEUE_LIMIT,
	LOCAL_FETCH_CONCURRENCY,
	LOCAL_FETCH_QUEUE_LIMIT,
} from '../common/resource_limits.js';
import { ErrorType, ProviderError } from '../common/types.js';
import {
	assert_provider_not_cooling,
	cooldown_settings,
	cooldown_trigger,
	get_provider_cooldown,
	note_provider_failure,
	reset_provider_cooldowns,
} from './provider_cooldown.js';
import {
	get_provider_health_snapshot,
	get_provider_health_summary,
	mark_provider_error,
	mark_provider_success,
	register_provider,
	reset_provider_health,
} from './provider_health.js';
import { get_provider_metrics_snapshot } from './provider_metrics.js';

const now = Date.parse('2026-10-01T12:00:00.000Z');
const at = (seconds: number) =>
	new Date(now + seconds * 1000).toISOString();
const failure = (
	type: ErrorType,
	details: Record<string, unknown>,
	message = 'private upstream text',
) => new ProviderError(type, message, 'fixture', details);
const rate_limited = (reset_time?: Date) => {
	try {
		handle_rate_limit('fixture', reset_time, { status: 429 });
	} catch (error) {
		return error;
	}
	throw new Error('unreachable');
};

beforeEach(() => {
	reset_provider_cooldowns();
	reset_provider_health();
	vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => {
	vi.unstubAllEnvs();
	vi.restoreAllMocks();
});

describe('cooldown_settings', () => {
	it('defaults to one minute and clamps the override to fifteen', () => {
		expect(cooldown_settings()).toEqual({
			default_ms: 60_000,
			max_ms: 900_000,
		});
		vi.stubEnv('RETRIEVER_PROVIDER_COOLDOWN_MS', '5000');
		expect(cooldown_settings().default_ms).toBe(5000);
		vi.stubEnv('RETRIEVER_PROVIDER_COOLDOWN_MS', '0');
		expect(cooldown_settings().default_ms).toBe(0);
		vi.stubEnv('RETRIEVER_PROVIDER_COOLDOWN_MS', String(2 ** 40));
		expect(cooldown_settings().default_ms).toBe(900_000);
		for (const raw of ['-1', '1.5', 'soon', '1e3'])
			(vi.stubEnv('RETRIEVER_PROVIDER_COOLDOWN_MS', raw),
				expect(cooldown_settings().default_ms).toBe(60_000));
	});
});

describe('cooldown_trigger', () => {
	it.each([
		['429 rate limit', rate_limited(), { status: 429 }],
		[
			'429 with Retry-After',
			rate_limited(new Date(now + 120_000)),
			{ status: 429, reset_time: new Date(now + 120_000) },
		],
		[
			'rate limit classified by the provider without a status',
			failure(ErrorType.RATE_LIMIT, {}),
			{},
		],
		[
			'GitHub secondary rate limit on a 403 with a reset header',
			failure(ErrorType.RATE_LIMIT, {
				status: 403,
				...retry_after_details('30', now),
			}),
			{ status: 403, reset_time: new Date(now + 30_000) },
		],
		[
			'500',
			failure(ErrorType.PROVIDER_ERROR, { status: 500 }),
			{ status: 500 },
		],
		[
			'503 with Retry-After',
			failure(ErrorType.PROVIDER_ERROR, {
				status: 503,
				...retry_after_details('30', now),
			}),
			{ status: 503, reset_time: new Date(now + 30_000) },
		],
		[
			'504 from the provider',
			failure(ErrorType.PROVIDER_ERROR, { status: 504 }),
			{ status: 504 },
		],
	])('starts on %s', (_, error, expected) => {
		expect(cooldown_trigger(error)).toEqual(expected);
	});

	it.each([
		['401', failure(ErrorType.API_ERROR, { status: 401 })],
		['403', failure(ErrorType.ENTITLEMENT_REQUIRED, { status: 403 })],
		['404', failure(ErrorType.ENDPOINT_NOT_FOUND, { status: 404 })],
		['400', failure(ErrorType.API_ERROR, { status: 400 })],
		['validation', input_error('Invalid input', 'fixture')],
		[
			'local timeout',
			failure(ErrorType.API_ERROR, {
				retryable: false,
				cause: 'timeout',
			}),
		],
		[
			'cancellation',
			failure(ErrorType.API_ERROR, {
				retryable: false,
				cause: 'cancelled',
			}),
		],
		[
			'network failure',
			failure(ErrorType.API_ERROR, {
				retryable: true,
				cause: 'network',
			}),
		],
		[
			'spend cap refusal',
			failure(ErrorType.PROVIDER_ERROR, { cause: 'spend_cap' }),
		],
		[
			'cooldown refusal',
			failure(ErrorType.PROVIDER_ERROR, {
				cause: 'provider_cooldown',
				trigger_status: 429,
			}),
		],
		[
			'local concurrency limit',
			failure(ErrorType.PROVIDER_ERROR, {
				retryable: false,
				cause: 'concurrency_limit',
			}),
		],
		['generic provider error', failure(ErrorType.PROVIDER_ERROR, {})],
		['plain Error', new Error('boom')],
		['TimeoutError', new DOMException('x', 'TimeoutError')],
	])('ignores %s', (_, error) => {
		expect(cooldown_trigger(error)).toBeUndefined();
	});
});

describe('note_provider_failure', () => {
	it('keys the window on the health unit, category plus provider', () => {
		note_provider_failure(
			'processing',
			'tavily',
			rate_limited(),
			now,
		);
		expect(
			get_provider_cooldown('processing', 'tavily', now),
		).toBeDefined();
		expect(
			get_provider_cooldown('search', 'tavily', now),
		).toBeUndefined();
		expect(() =>
			assert_provider_not_cooling('search', 'tavily', now),
		).not.toThrow();
	});

	it('uses the default window when no Retry-After is present', () => {
		note_provider_failure('search', 'fixture', rate_limited(), now);
		expect(get_provider_cooldown('search', 'fixture', now)).toEqual({
			until: new Date(now + 60_000),
			status: 429,
		});
		note_provider_failure(
			'search',
			'other',
			failure(ErrorType.PROVIDER_ERROR, { status: 502 }),
			now,
		);
		expect(get_provider_cooldown('search', 'other', now)).toEqual({
			until: new Date(now + 60_000),
			status: 502,
		});
	});

	it('honours Retry-After in seconds and HTTP-date form, clamped to fifteen minutes', () => {
		note_provider_failure(
			'search',
			'seconds',
			failure(ErrorType.PROVIDER_ERROR, {
				status: 503,
				...retry_after_details('120', now),
			}),
			now,
		);
		expect(
			get_provider_cooldown('search', 'seconds', now)?.until,
		).toEqual(new Date(now + 120_000));
		note_provider_failure(
			'search',
			'date',
			rate_limited(
				retry_after_details('Thu, 01 Oct 2026 12:05:00 GMT', now)
					.reset_time,
			),
			now,
		);
		expect(
			get_provider_cooldown('search', 'date', now)?.until,
		).toEqual(new Date(now + 300_000));
		note_provider_failure(
			'search',
			'long',
			rate_limited(new Date(now + 3_600_000)),
			now,
		);
		expect(
			get_provider_cooldown('search', 'long', now)?.until,
		).toEqual(new Date(now + 900_000));
		// A Retry-After in the past means the default window.
		note_provider_failure(
			'search',
			'past',
			rate_limited(new Date(now - 1000)),
			now,
		);
		expect(
			get_provider_cooldown('search', 'past', now)?.until,
		).toEqual(new Date(now + 60_000));
	});

	it('follows the configured default and never shortens a running window', () => {
		vi.stubEnv('RETRIEVER_PROVIDER_COOLDOWN_MS', '5000');
		note_provider_failure('search', 'fixture', rate_limited(), now);
		expect(
			get_provider_cooldown('search', 'fixture', now)?.until,
		).toEqual(new Date(now + 5000));
		note_provider_failure(
			'search',
			'fixture',
			rate_limited(new Date(now + 90_000)),
			now,
		);
		expect(
			get_provider_cooldown('search', 'fixture', now)?.until,
		).toEqual(new Date(now + 90_000));
		note_provider_failure(
			'search',
			'fixture',
			rate_limited(),
			now + 1000,
		);
		expect(
			get_provider_cooldown('search', 'fixture', now)?.until,
		).toEqual(new Date(now + 90_000));
	});

	it('is disabled entirely by a zero default', () => {
		vi.stubEnv('RETRIEVER_PROVIDER_COOLDOWN_MS', '0');
		note_provider_failure(
			'search',
			'fixture',
			rate_limited(new Date(now + 120_000)),
			now,
		);
		expect(
			get_provider_cooldown('search', 'fixture', now),
		).toBeUndefined();
		expect(() =>
			assert_provider_not_cooling('search', 'fixture', now),
		).not.toThrow();
	});

	it('expires exactly at the window end', () => {
		note_provider_failure('search', 'fixture', rate_limited(), now);
		expect(() =>
			assert_provider_not_cooling('search', 'fixture', now + 59_999),
		).toThrow();
		expect(
			get_provider_cooldown('search', 'fixture', now + 60_000),
		).toBeUndefined();
		expect(() =>
			assert_provider_not_cooling('search', 'fixture', now + 60_000),
		).not.toThrow();
	});
});

describe('assert_provider_not_cooling', () => {
	it('throws a public, typed, non-retryable error with retry_at and the trigger', () => {
		note_provider_failure(
			'search',
			'fixture',
			rate_limited(new Date(now + 120_000)),
			now,
		);
		let error: unknown;
		try {
			assert_provider_not_cooling('search', 'fixture', now);
		} catch (thrown) {
			error = thrown;
		}
		expect(public_error_metadata(error)).toEqual({
			kind: 'provider_cooldown',
			retryable: false,
			provider: 'fixture',
			retry_at: at(120),
			trigger_status: 429,
		});
		expect(create_error_response(error)).toEqual({
			error: `fixture error [PROVIDER_ERROR]: Provider fixture is cooling down after HTTP 429; retry at ${at(120)}`,
		});
		expect(JSON.stringify(error)).not.toContain('private');
	});

	it('names a rate limit when the provider sent no status', () => {
		note_provider_failure(
			'search',
			'fixture',
			failure(ErrorType.RATE_LIMIT, {}),
			now,
		);
		expect(() =>
			assert_provider_not_cooling('search', 'fixture', now),
		).toThrow(
			`Provider fixture is cooling down after a rate limit; retry at ${at(60)}`,
		);
		expect(
			public_error_metadata(
				(() => {
					try {
						assert_provider_not_cooling('search', 'fixture', now);
					} catch (error) {
						return error;
					}
				})(),
			),
		).not.toHaveProperty('trigger_status');
	});
});

describe('local back-pressure', () => {
	const overflow = async (
		run: (fn: () => Promise<void>) => Promise<unknown>,
		capacity: number,
	) => {
		let finish!: () => void;
		const gate = new Promise<void>((resolve) => {
			finish = resolve;
		});
		const held = Array.from({ length: capacity }, () =>
			run(() => gate),
		);
		const rejection = await run(async () => {}).then(
			() => undefined,
			(error: unknown) => error,
		);
		finish();
		await Promise.all(held);
		return rejection;
	};

	it('reports a provider slot rejection as queue_full without a cooldown or a health failure', async () => {
		register_provider('search', 'fixture');
		mark_provider_success('search', 'fixture', {
			tool: 'web_search',
		});
		const healthy = get_provider_health_snapshot().search.fixture;
		const error = await overflow(
			(fn) => with_provider_slot('fixture', undefined, fn),
			PROVIDER_CONCURRENCY + PROVIDER_QUEUE_LIMIT,
		);
		expect(error).toMatchObject({
			type: ErrorType.PROVIDER_ERROR,
			message:
				'Server request queue for fixture is full; retry later',
			details: { retryable: false, cause: 'concurrency_limit' },
		});
		// Its own public kind: not a provider rate limit, not retryable
		// by the shared predicate, and the fixed message is shown as is.
		expect(public_error_metadata(error)).toEqual({
			kind: 'queue_full',
			retryable: false,
			provider: 'fixture',
		});
		expect(create_error_response(error)).toEqual({
			error:
				'fixture error [PROVIDER_ERROR]: Server request queue for fixture is full; retry later',
		});
		expect(cooldown_trigger(error)).toBeUndefined();
		mark_provider_error('search', 'fixture', error, {
			tool: 'web_search',
		});
		// Counted in the metrics, invisible to provider health.
		expect(
			get_provider_metrics_snapshot().tools.web_search,
		).toMatchObject({
			calls: 2,
			failed: 1,
			errors_by_kind: { queue_full: 1 },
		});
		expect(get_provider_health_snapshot().search.fixture).toEqual(
			healthy,
		);
		expect(get_provider_health_summary()).toMatchObject({
			degraded: 0,
		});
		expect(() =>
			assert_provider_not_cooling('search', 'fixture', now),
		).not.toThrow();
	});

	it('reports a local fetch slot rejection the same way', async () => {
		const error = await overflow(
			(fn) => with_local_fetch_slot(undefined, fn),
			LOCAL_FETCH_CONCURRENCY + LOCAL_FETCH_QUEUE_LIMIT,
		);
		expect(error).toMatchObject({
			type: ErrorType.PROVIDER_ERROR,
			details: { cause: 'concurrency_limit' },
		});
		expect(public_error_metadata(error).kind).toBe('queue_full');
		expect(cooldown_trigger(error)).toBeUndefined();
		mark_provider_error('processing', 'defuddle', error);
		expect(
			get_provider_health_snapshot().processing.defuddle,
		).toBeUndefined();
	});
});

describe('health integration', () => {
	it('starts the cooldown from the health marker and shows it in the snapshot', () => {
		vi.useFakeTimers();
		vi.setSystemTime(now);
		try {
			register_provider('search', 'fixture');
			mark_provider_error('search', 'fixture', rate_limited(), {
				tool: 'web_search',
			});
			expect(
				get_provider_health_snapshot().search.fixture,
			).toMatchObject({
				last_runtime_status: 'provider_error',
				last_error_kind: 'rate_limit',
				cooldown_until: at(60),
				cooldown_status: 429,
			});
			// A refusal counts in metrics but is neither a health failure
			// nor a fresh trigger, and a success does not end the window.
			let refusal: unknown;
			try {
				assert_provider_not_cooling('search', 'fixture');
			} catch (error) {
				refusal = error;
			}
			mark_provider_error('search', 'fixture', refusal, {
				tool: 'web_search',
			});
			mark_provider_success('search', 'fixture', {
				tool: 'web_search',
			});
			expect(
				get_provider_metrics_snapshot().tools.web_search,
			).toMatchObject({
				calls: 3,
				failed: 2,
				errors_by_kind: { rate_limit: 1, provider_cooldown: 1 },
			});
			expect(
				get_provider_health_snapshot().search.fixture,
			).toMatchObject({
				last_runtime_status: 'ok',
				active_error: false,
				cooldown_until: at(60),
			});
			expect(get_provider_health_summary()).toMatchObject({
				degraded: 0,
			});
			vi.setSystemTime(now + 60_000);
			expect(
				get_provider_health_snapshot().search.fixture,
			).not.toHaveProperty('cooldown_until');
		} finally {
			vi.useRealTimers();
		}
	});

	it('does not start a cooldown for authentication failures', () => {
		register_provider('search', 'fixture');
		mark_provider_error(
			'search',
			'fixture',
			failure(
				ErrorType.API_ERROR,
				{ status: 401 },
				'Invalid API key',
			),
		);
		expect(
			get_provider_health_snapshot().search.fixture,
		).toMatchObject({
			last_error_kind: 'authentication',
		});
		expect(
			get_provider_health_snapshot().search.fixture,
		).not.toHaveProperty('cooldown_until');
	});
});
