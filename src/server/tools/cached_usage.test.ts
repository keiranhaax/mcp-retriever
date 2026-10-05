import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { reset_http_cache } from '../../common/http_cache.js';
import { config } from '../../config/env.js';
import { create_server } from '../create_server.js';
import {
	get_provider_health_snapshot,
	reset_provider_health,
} from '../provider_health.js';
import { get_provider_metrics_snapshot } from '../provider_metrics.js';
import { reset_spend_ledger } from '../spend_caps.js';

/**
 * A response served from the in-process HTTP cache made no provider
 * call, so the provider-reported cost inside the replayed body must not
 * be counted again. Spending caps and the metrics both depend on this.
 */

const settings = Object.values(config).flatMap(Object.values);
const keys = settings.map((item) => item.api_key);
const fetch_mock = vi.fn();
let server: ReturnType<typeof create_server>;
let directory: string;
let sequence = 0;

const call = async (name: string, args: Record<string, unknown>) =>
	(await server.receive(
		{
			jsonrpc: '2.0',
			id: ++sequence,
			method: 'tools/call',
			params: { name, arguments: args },
		},
		{} as any,
	)) as any;

beforeEach(() => {
	directory = mkdtempSync(join(tmpdir(), 'retriever-cached-usage-'));
	vi.stubEnv('RETRIEVER_RESULT_DIR', directory);
	vi.stubEnv('RETRIEVER_HTTP_CACHE_BYTES', '1048576');
	for (const item of settings) item.api_key = undefined;
	config.search.exa.api_key = 'cached-usage-fixture-key';
	config.search.tavily.api_key = 'cached-usage-fixture-key';
	vi.stubGlobal('fetch', fetch_mock);
	fetch_mock.mockReset();
	vi.spyOn(console, 'error').mockImplementation(() => {});
	vi.spyOn(console, 'warn').mockImplementation(() => {});
	reset_http_cache();
	reset_provider_health();
	reset_spend_ledger();
	server = create_server({
		name: 'cached-usage-offline',
		version: '1',
	});
});

const read_resource = async (uri: string) =>
	JSON.parse(
		(
			await server.receive(
				{
					jsonrpc: '2.0',
					id: ++sequence,
					method: 'resources/read',
					params: { uri },
				},
				{} as any,
			)
		).result.contents[0].text,
	);

afterEach(() => {
	settings.forEach((item, i) => {
		item.api_key = keys[i];
	});
	reset_http_cache();
	reset_provider_health();
	reset_spend_ledger();
	vi.unstubAllGlobals();
	vi.unstubAllEnvs();
	vi.restoreAllMocks();
	rmSync(directory, { recursive: true, force: true });
});

it.each([
	{
		provider: 'exa',
		body: {
			requestId: 'req-1',
			costDollars: { total: 0.007 },
			results: [
				{
					id: 'doc:1',
					title: 'Hit',
					url: 'https://example.test/a',
					text: 'needle',
				},
			],
		},
		usage: { usd: 0.007, credits: 0 },
	},
	{
		provider: 'tavily',
		body: {
			request_id: 'req-1',
			usage: { credits: 2 },
			results: [
				{
					title: 'Hit',
					url: 'https://example.test/a',
					content: 'needle',
					score: 0.9,
				},
			],
		},
		usage: { usd: 0, credits: 2 },
	},
])(
	'records $provider cost once when the second call is an HTTP cache hit',
	async ({ provider, body, usage }) => {
		fetch_mock.mockImplementation(async () => Response.json(body));
		const args = { query: 'needle', provider, response_mode: 'full' };

		const first = await call('web_search', args);
		expect(first.result.isError).not.toBe(true);
		expect(
			first.result.structuredContent.data.metadata,
		).toMatchObject({
			usage_source: 'provider_reported',
		});

		const second = await call('web_search', args);
		expect(second.result.isError).not.toBe(true);
		// Only one request left the process; the second body was replayed.
		expect(fetch_mock).toHaveBeenCalledTimes(1);

		const snapshot = get_provider_metrics_snapshot();
		expect(snapshot.providers[`search:${provider}`]).toMatchObject({
			calls: 2,
			ok: 2,
			cache_hits: 1,
			usage: { ...usage, reported_calls: 1 },
		});
		expect(snapshot.tools.web_search).toMatchObject({
			calls: 2,
			cache_hits: 1,
			usage: { ...usage, reported_calls: 1 },
		});
		expect(
			second.result.structuredContent.data.metadata,
		).toMatchObject({ usage: null, usage_source: 'cache' });
	},
);

const exa_body = (usd: number) => ({
	requestId: 'req-1',
	costDollars: { total: usd },
	results: [
		{
			id: 'doc:1',
			title: 'Hit',
			url: 'https://example.test/a',
			text: 'needle',
		},
	],
});

it('refuses a provider whose family cap is reached, without rerouting', async () => {
	vi.stubEnv('RETRIEVER_HTTP_CACHE_BYTES', '0');
	vi.stubEnv(
		'RETRIEVER_SPEND_CAPS',
		'exa:daily:usd=0.01,tavily:daily:credits=100',
	);
	config.ai_response.exa_answer.api_key = 'cached-usage-fixture-key';
	server = create_server({
		name: 'cached-usage-offline',
		version: '1',
	});
	fetch_mock.mockImplementation(async () =>
		Response.json(exa_body(0.007)),
	);

	const first = await call('web_search', {
		query: 'a',
		provider: 'exa',
	});
	expect(first.result.isError).not.toBe(true);
	const second = await call('web_search', {
		query: 'b',
		provider: 'exa',
	});
	expect(second.result.isError).not.toBe(true);
	expect(fetch_mock).toHaveBeenCalledTimes(2);

	// 0.014 >= 0.01: every Exa-keyed tool is refused before any request.
	const refused = await call('web_search', {
		query: 'c',
		provider: 'exa',
	});
	expect(refused.result).toMatchObject({
		isError: true,
		structuredContent: {
			ok: false,
			error: {
				kind: 'spend_cap',
				retryable: false,
				provider: 'exa',
				reset_at: expect.stringMatching(/T00:00:00\.000Z$/),
			},
		},
	});
	expect(refused.result.content[0].text).toMatch(
		/^exa error \[PROVIDER_ERROR\]: Spending cap reached for exa: 0\.01 usd per UTC day; resets at \d{4}-\d{2}-\d{2}T00:00:00\.000Z$/,
	);
	const answer = await call('ai_search', {
		query: 'c',
		provider: 'exa_answer',
	});
	expect(answer.result.isError).toBe(true);
	expect(answer.result._meta.retriever.error).toMatchObject({
		kind: 'spend_cap',
		provider: 'exa_answer',
	});
	expect(answer.result.content[0].text).toContain(
		'Spending cap reached for exa',
	);
	expect(fetch_mock).toHaveBeenCalledTimes(2);
	// A refusal is a local policy decision, not a provider fault.
	expect(get_provider_health_snapshot().search.exa).toMatchObject({
		last_runtime_status: 'ok',
		active_error: false,
	});
	expect(
		get_provider_metrics_snapshot().tools.web_search,
	).toMatchObject({
		calls: 3,
		failed: 1,
		errors_by_kind: { spend_cap: 1 },
		usage: { usd: 0.014, reported_calls: 2 },
	});

	// Status reads of an existing job are free and stay allowed.
	config.ai_response.tavily_research.api_key =
		'cached-usage-fixture-key';
	config.processing.firecrawl_agent.api_key =
		'cached-usage-fixture-key';
	vi.stubEnv(
		'RETRIEVER_SPEND_CAPS',
		'exa:daily:usd=0.01,tavily:daily:credits=0,firecrawl:daily:credits=0',
	);
	server = create_server({
		name: 'cached-usage-offline',
		version: '1',
	});
	const research = await call('ai_search', {
		query: 'c',
		provider: 'tavily_research',
	});
	expect(research.result._meta.retriever.error).toMatchObject({
		kind: 'spend_cap',
		provider: 'tavily_research',
	});
	const agent = await call('firecrawl_agent', { prompt: 'c' });
	expect(agent.result._meta.retriever.error).toMatchObject({
		kind: 'spend_cap',
		provider: 'firecrawl_agent',
	});
	expect(fetch_mock).toHaveBeenCalledTimes(2);
	fetch_mock.mockImplementation(async () =>
		Response.json({
			success: true,
			status: 'completed',
			data: 'done',
			creditsUsed: 4,
		}),
	);
	const agent_status = await call('firecrawl_agent', {
		action: 'status',
		job_id: '123e4567-e89b-42d3-a456-426614174000',
	});
	expect(agent_status.result.isError).not.toBe(true);
	expect(fetch_mock).toHaveBeenCalledTimes(3);
	vi.stubEnv(
		'RETRIEVER_SPEND_CAPS',
		'exa:daily:usd=0.01,tavily:daily:credits=100',
	);
	fetch_mock.mockImplementation(async () =>
		Response.json(exa_body(0.007)),
	);

	// Other families stay available and the status resource shows both.
	fetch_mock.mockImplementation(async () =>
		Response.json({
			usage: { credits: 1 },
			results: [
				{
					title: 'Hit',
					url: 'https://example.test/a',
					content: 'x',
					score: 1,
				},
			],
		}),
	);
	const tavily = await call('web_search', {
		query: 'c',
		provider: 'tavily',
	});
	expect(tavily.result.isError).not.toBe(true);
	const status = await read_resource('retriever://providers/status');
	expect(status.spend_caps).toMatchObject({
		enabled: true,
		accounts: {
			exa: {
				providers: ['exa'],
				day: { usd: 0.014, cap_usd: 0.01, cap_credits: null },
				blocked: true,
			},
			tavily: {
				day: { credits: 1, cap_credits: 100 },
				blocked: false,
			},
		},
	});
	expect(JSON.stringify(status)).not.toContain(directory);
	expect(JSON.stringify(status)).not.toContain('fixture-key');
});

it('refuses search_and_read providers per step with the typed source error', async () => {
	vi.stubEnv('RETRIEVER_HTTP_CACHE_BYTES', '0');
	vi.stubEnv('RETRIEVER_SPEND_CAPS', 'exa:daily:usd=0');
	config.processing.exa_contents.api_key = 'cached-usage-fixture-key';
	config.processing.tavily_extract.api_key =
		'cached-usage-fixture-key';
	server = create_server({
		name: 'cached-usage-offline',
		version: '1',
	});
	fetch_mock.mockImplementation(async (target: string) =>
		String(target).endsWith('/search')
			? Response.json({
					results: [
						{
							title: 'Hit',
							url: 'https://example.test/a',
							content: 'needle',
							score: 1,
						},
					],
				})
			: Response.json({
					results: [
						{
							url: 'https://example.test/a',
							raw_content: 'needle text',
						},
					],
					failed_results: [],
				}),
	);
	const blocked_search = await call('search_and_read', {
		query: 'needle',
		search_provider: 'exa',
		extract_provider: 'tavily',
	});
	expect(blocked_search.result).toMatchObject({
		isError: true,
		structuredContent: {
			ok: false,
			error: { kind: 'spend_cap', provider: 'exa' },
		},
	});
	expect(fetch_mock).not.toHaveBeenCalled();

	const blocked_read = await call('search_and_read', {
		query: 'needle',
		search_provider: 'tavily',
		extract_provider: 'exa',
	});
	expect(blocked_read.result.isError).not.toBe(true);
	expect(
		blocked_read.result.structuredContent.data.sources[0],
	).toMatchObject({
		status: 'error',
		error: {
			kind: 'spend_cap',
			retryable: false,
			provider: 'exa',
			reset_at: expect.stringMatching(/T00:00:00\.000Z$/),
		},
	});
	expect(fetch_mock).toHaveBeenCalledTimes(1);
});

it('fails startup on a malformed cap instead of running without it', () => {
	vi.stubEnv('RETRIEVER_SPEND_CAPS', 'exa:daily:usd=lots');
	expect(() =>
		create_server({ name: 'cached-usage-offline', version: '1' }),
	).toThrow('Invalid RETRIEVER_SPEND_CAPS amount "lots" for exa');
});
