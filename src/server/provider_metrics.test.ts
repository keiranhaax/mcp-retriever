import {
	afterEach,
	beforeEach,
	describe,
	expect,
	it,
	vi,
} from 'vitest';
import { ErrorType, ProviderError } from '../common/types.js';
import { config } from '../config/env.js';
import {
	mark_provider_error,
	mark_provider_success,
	reset_provider_health,
} from './provider_health.js';
import {
	initialize_firecrawl_agent,
	register_firecrawl_agent,
} from './tools/firecrawl_agent.js';
import {
	get_provider_metrics_snapshot,
	record_provider_outcome,
	reset_provider_metrics,
} from './provider_metrics.js';

describe('provider metrics', () => {
	beforeEach(() => {
		reset_provider_metrics();
		vi.spyOn(console, 'error').mockImplementation(() => {});
		vi.spyOn(console, 'warn').mockImplementation(() => {});
	});

	afterEach(() => {
		vi.unstubAllEnvs();
		vi.restoreAllMocks();
	});

	it('counts outcomes per provider and per tool with latency and usage', () => {
		for (const elapsed_ms of [10, 20, 30, 40, 100]) {
			record_provider_outcome({
				category: 'search',
				provider: 'fixture',
				tool: 'web_search',
				ok: true,
				elapsed_ms,
				usage: { credits: 2 },
			});
		}
		record_provider_outcome({
			category: 'search',
			provider: 'fixture',
			tool: 'search_and_read',
			ok: false,
			kind: 'rate_limit',
			elapsed_ms: 5,
		});
		const snapshot = get_provider_metrics_snapshot();
		expect(snapshot.providers['search:fixture']).toMatchObject({
			calls: 6,
			ok: 5,
			failed: 1,
			errors_by_kind: { rate_limit: 1 },
			latency_ms: { samples: 6, p50: 20, p95: 100, max: 100 },
			usage: { credits: 10, usd: 0, reported_calls: 5 },
		});
		expect(snapshot.tools.web_search).toMatchObject({
			calls: 5,
			ok: 5,
			usage: { credits: 10 },
		});
		expect(snapshot.tools.search_and_read).toMatchObject({
			calls: 1,
			failed: 1,
			errors_by_kind: { rate_limit: 1 },
		});
		expect(snapshot.providers['search:fixture'].last_call_at).toMatch(
			/^\d{4}-/,
		);
	});

	it('counts a cache hit as a call but never as spend', () => {
		record_provider_outcome({
			category: 'search',
			provider: 'fixture',
			tool: 'web_search',
			ok: true,
			elapsed_ms: 1,
			usage: { usd: 0.007 },
		});
		record_provider_outcome({
			category: 'search',
			provider: 'fixture',
			tool: 'web_search',
			ok: true,
			elapsed_ms: 1,
			usage: { usd: 0.007 },
			cached: true,
		});
		mark_provider_success('search', 'fixture', {
			tool: 'web_search',
			usage: { usd: 0.007 },
			cached: true,
		});
		const snapshot = get_provider_metrics_snapshot();
		expect(snapshot.providers['search:fixture']).toMatchObject({
			calls: 3,
			ok: 3,
			cache_hits: 2,
			usage: { usd: 0.007, credits: 0, reported_calls: 1 },
		});
		expect(snapshot.tools.web_search).toMatchObject({
			calls: 3,
			cache_hits: 2,
			usage: { usd: 0.007, reported_calls: 1 },
		});
		vi.stubEnv('RETRIEVER_CALL_LOG', '1');
		record_provider_outcome({
			category: 'search',
			provider: 'fixture',
			tool: 'web_search',
			ok: true,
			elapsed_ms: 2,
			cached: true,
		});
		expect(console.error).toHaveBeenCalledWith(
			'retriever call tool=web_search provider=search/fixture outcome=ok ms=2 cached=1',
		);
	});

	it('reports null latency when nothing was measured and ignores bad numbers', () => {
		record_provider_outcome({
			category: 'processing',
			provider: 'fixture',
			ok: true,
			elapsed_ms: Number.NaN,
			usage: { usd: -1 },
		});
		expect(
			get_provider_metrics_snapshot().providers['processing:fixture'],
		).toMatchObject({
			calls: 1,
			latency_ms: { samples: 0, mean: null, p50: null, p95: null },
			usage: { usd: 0, reported_calls: 0 },
		});
	});

	it('is fed by the health markers, including failures health ignores', () => {
		reset_provider_health();
		mark_provider_success('search', 'fixture', {
			tool: 'web_search',
			elapsed_ms: 12,
			usage: { usd: 0.5 },
		});
		mark_provider_error(
			'search',
			'fixture',
			new ProviderError(
				ErrorType.INVALID_INPUT,
				'bad input',
				'fixture',
			),
			{ tool: 'web_search', elapsed_ms: 1 },
		);
		mark_provider_error(
			'search',
			'fixture',
			new DOMException('cancelled', 'AbortError'),
			{ tool: 'web_search' },
		);
		expect(
			get_provider_metrics_snapshot().tools.web_search,
		).toMatchObject({
			calls: 3,
			ok: 1,
			failed: 2,
			errors_by_kind: { bad_input: 1, cancelled: 1 },
			usage: { usd: 0.5, reported_calls: 1 },
		});
	});

	it("adds only the increment of a job's cumulative usage, like the spend ledger", () => {
		reset_provider_health();
		const observe = (credits: number, job_id = 'job-1') =>
			mark_provider_success('processing', 'firecrawl_agent', {
				tool: 'firecrawl_agent',
				usage: { credits },
				job_id,
			});
		observe(4);
		observe(4); // a repeated status read of the same running total
		observe(6);
		observe(5); // a lower figure never subtracts
		observe(3, 'job-2');
		const snapshot = get_provider_metrics_snapshot();
		const expected = { credits: 9, usd: 0, reported_calls: 3 };
		expect(
			snapshot.providers['processing:firecrawl_agent'],
		).toMatchObject({ calls: 5, ok: 5, usage: expected });
		expect(snapshot.tools.firecrawl_agent).toMatchObject({
			calls: 5,
			usage: expected,
		});
		// Marks are per provider and job; a plain request still adds.
		mark_provider_success('ai_response', 'tavily_research', {
			tool: 'ai_search',
			usage: { credits: 4 },
			job_id: 'job-1',
		});
		mark_provider_success('ai_response', 'tavily_research', {
			tool: 'ai_search',
			usage: { credits: 4 },
		});
		expect(
			get_provider_metrics_snapshot().providers[
				'ai_response:tavily_research'
			].usage,
		).toEqual({ credits: 8, usd: 0, reported_calls: 2 });
		reset_provider_metrics();
		observe(4);
		expect(
			get_provider_metrics_snapshot().tools.firecrawl_agent.usage,
		).toEqual({ credits: 4, usd: 0, reported_calls: 1 });
	});

	it('counts firecrawl_agent status reads of one job once in the metrics', async () => {
		reset_provider_health();
		const previous_key = config.processing.firecrawl_agent.api_key;
		config.processing.firecrawl_agent.api_key = 'metrics-fixture-key';
		const fetch_mock = vi.fn(async () =>
			Response.json({
				success: true,
				status: 'completed',
				data: 'done',
				creditsUsed: 4,
			}),
		);
		vi.stubGlobal('fetch', fetch_mock);
		try {
			let handler!: (input: unknown) => Promise<unknown>;
			initialize_firecrawl_agent();
			register_firecrawl_agent({
				tool: (_definition: unknown, callback: typeof handler) => {
					handler = callback;
				},
			} as any);
			const status = {
				action: 'status',
				job_id: '12345678-1234-4123-8123-123456789abc',
			};
			await handler(status);
			await handler(status);
			expect(fetch_mock).toHaveBeenCalledTimes(2);
			expect(
				get_provider_metrics_snapshot().tools.firecrawl_agent,
			).toMatchObject({
				calls: 2,
				ok: 2,
				usage: { credits: 4, usd: 0, reported_calls: 1 },
			});
		} finally {
			config.processing.firecrawl_agent.api_key = previous_key;
			vi.unstubAllGlobals();
		}
	});

	it('emits one structured stderr line per call only when enabled', () => {
		record_provider_outcome({
			category: 'search',
			provider: 'fixture',
			tool: 'web_search',
			ok: true,
			elapsed_ms: 12.4,
		});
		expect(console.error).not.toHaveBeenCalled();
		vi.stubEnv('RETRIEVER_CALL_LOG', '1');
		record_provider_outcome({
			category: 'search',
			provider: 'fixture',
			tool: 'web_search',
			ok: false,
			kind: 'timeout',
			elapsed_ms: 12.4,
			usage: { credits: 3 },
		});
		expect(console.error).toHaveBeenCalledWith(
			'retriever call tool=web_search provider=search/fixture outcome=timeout ms=12 credits=3',
		);
	});
});
