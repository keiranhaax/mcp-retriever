import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { config } from '../../config/env.js';
import { create_server } from '../create_server.js';
import { reset_provider_cooldowns } from '../provider_cooldown.js';
import {
	get_provider_health_snapshot,
	reset_provider_health,
} from '../provider_health.js';
import { get_provider_metrics_snapshot } from '../provider_metrics.js';

/**
 * A provider whose call ends in a rate limit or a 5xx is refused new
 * paid work for a bounded window, before any request leaves the
 * process. Every case here runs offline against a mocked fetch.
 */

const settings = Object.values(config).flatMap(Object.values);
const keys = settings.map((item) => item.api_key);
const fetch_mock = vi.fn();
const now = Date.parse('2026-10-01T12:00:00.000Z');
const at = (seconds: number) =>
	new Date(now + seconds * 1000).toISOString();
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
const read_status = async () =>
	JSON.parse(
		(
			await server.receive(
				{
					jsonrpc: '2.0',
					id: ++sequence,
					method: 'resources/read',
					params: { uri: 'retriever://providers/status' },
				},
				{} as any,
			)
		).result.contents[0].text,
	);
const hit = {
	title: 'Hit',
	url: 'https://example.test/a',
	content: 'needle',
	score: 1,
};
const search_ok = () =>
	Response.json({ usage: { credits: 1 }, results: [hit] });
const failing = (status: number, retry_after?: string) =>
	new Response('{}', {
		status,
		headers: retry_after ? { 'Retry-After': retry_after } : {},
	});
const search = (provider = 'tavily') =>
	call('web_search', { query: 'needle', provider });

beforeEach(() => {
	directory = mkdtempSync(join(tmpdir(), 'retriever-cooldown-'));
	vi.stubEnv('RETRIEVER_RESULT_DIR', directory);
	vi.stubEnv('RETRIEVER_HTTP_CACHE_BYTES', '0');
	for (const item of settings) item.api_key = undefined;
	config.search.tavily.api_key = 'cooldown-fixture-key';
	config.search.exa.api_key = 'cooldown-fixture-key';
	config.processing.tavily_extract.api_key = 'cooldown-fixture-key';
	config.processing.firecrawl_agent.api_key = 'cooldown-fixture-key';
	config.ai_response.tavily_research.api_key = 'cooldown-fixture-key';
	vi.stubGlobal('fetch', fetch_mock);
	fetch_mock.mockReset();
	vi.spyOn(console, 'error').mockImplementation(() => {});
	vi.spyOn(console, 'warn').mockImplementation(() => {});
	vi.setSystemTime(now);
	reset_provider_health();
	reset_provider_cooldowns();
	server = create_server({ name: 'cooldown-offline', version: '1' });
});

afterEach(() => {
	settings.forEach((item, i) => {
		item.api_key = keys[i];
	});
	reset_provider_health();
	reset_provider_cooldowns();
	vi.useRealTimers();
	vi.unstubAllGlobals();
	vi.unstubAllEnvs();
	vi.restoreAllMocks();
	rmSync(directory, { recursive: true, force: true });
});

const expect_refusal = (
	response: any,
	provider: string,
	retry_at: string,
	trigger_status: number,
) => {
	expect(response.result).toMatchObject({
		isError: true,
		structuredContent: {
			ok: false,
			error: {
				kind: 'provider_cooldown',
				retryable: false,
				provider,
				retry_at,
				trigger_status,
			},
		},
	});
	expect(response.result.content[0].text).toBe(
		`${provider} error [PROVIDER_ERROR]: Provider ${provider} is cooling down after HTTP ${trigger_status}; retry at ${retry_at}`,
	);
};

it('cools a provider down for its Retry-After after a 429 and lets other providers through', async () => {
	fetch_mock.mockImplementation(async () => failing(429, '120'));
	const limited = await search();
	expect(limited.result.structuredContent.error).toMatchObject({
		kind: 'rate_limit',
		http_status: 429,
	});
	const attempts = fetch_mock.mock.calls.length;

	const refused = await search();
	expect_refusal(refused, 'tavily', at(120), 429);
	expect(fetch_mock).toHaveBeenCalledTimes(attempts);

	// Explicit provider choice is honoured: Exa is not affected.
	fetch_mock.mockImplementation(async () =>
		Response.json({
			requestId: 'r',
			results: [{ title: 'Hit', url: hit.url, text: 'needle' }],
		}),
	);
	const exa = await search('exa');
	expect(exa.result.isError).not.toBe(true);

	expect(get_provider_health_snapshot().search.tavily).toMatchObject({
		last_error_kind: 'rate_limit',
		cooldown_until: at(120),
		cooldown_status: 429,
	});
	expect(
		get_provider_metrics_snapshot().tools.web_search,
	).toMatchObject({
		calls: 3,
		failed: 2,
		errors_by_kind: { rate_limit: 1, provider_cooldown: 1 },
	});
	const status = await read_status();
	expect(status.provider_health.search.tavily.cooldown_until).toBe(
		at(120),
	);
	expect(status.provider_health.search.exa).not.toHaveProperty(
		'cooldown_until',
	);
	expect(JSON.stringify(status)).not.toContain('fixture-key');

	// The window ends exactly at retry_at and requests flow again.
	vi.setSystemTime(now + 119_000);
	expect_refusal(await search(), 'tavily', at(120), 429);
	vi.setSystemTime(now + 120_000);
	fetch_mock.mockImplementation(async () => search_ok());
	const recovered = await search();
	expect(recovered.result.isError).not.toBe(true);
	expect(
		get_provider_health_snapshot().search.tavily,
	).not.toHaveProperty('cooldown_until');
});

it('uses the default minute without Retry-After, the HTTP-date form, and the clamp', async () => {
	fetch_mock.mockImplementation(async () => failing(429));
	await search();
	expect_refusal(await search(), 'tavily', at(60), 429);

	reset_provider_cooldowns();
	fetch_mock.mockImplementation(async () =>
		failing(429, 'Thu, 01 Oct 2026 12:05:00 GMT'),
	);
	await search();
	expect_refusal(await search(), 'tavily', at(300), 429);

	reset_provider_cooldowns();
	fetch_mock.mockImplementation(async () => failing(429, '86400'));
	await search();
	expect_refusal(await search(), 'tavily', at(900), 429);
});

it('cools down after a 5xx but not after a 401', async () => {
	fetch_mock.mockImplementation(async () => failing(503));
	const failed = await search();
	expect(failed.result.structuredContent.error).toMatchObject({
		kind: 'upstream_failure',
		http_status: 503,
	});
	expect_refusal(await search(), 'tavily', at(60), 503);

	fetch_mock.mockImplementation(async () => failing(401));
	const denied = await search('exa');
	expect(denied.result.structuredContent.error).toMatchObject({
		kind: 'authentication',
		http_status: 401,
	});
	const attempts = fetch_mock.mock.calls.length;
	const again = await search('exa');
	expect(again.result.structuredContent.error).toMatchObject({
		kind: 'authentication',
	});
	expect(fetch_mock.mock.calls.length).toBeGreaterThan(attempts);
	expect(
		get_provider_health_snapshot().search.exa,
	).not.toHaveProperty('cooldown_until');
});

it('follows the environment default and is disabled by zero', async () => {
	vi.stubEnv('RETRIEVER_PROVIDER_COOLDOWN_MS', '5000');
	fetch_mock.mockImplementation(async () => failing(502));
	await search();
	expect_refusal(await search(), 'tavily', at(5), 502);
	vi.setSystemTime(now + 5000);
	fetch_mock.mockImplementation(async () => search_ok());
	expect((await search()).result.isError).not.toBe(true);

	vi.stubEnv('RETRIEVER_PROVIDER_COOLDOWN_MS', '0');
	reset_provider_cooldowns();
	fetch_mock.mockImplementation(async () => failing(429, '120'));
	await search();
	const attempts = fetch_mock.mock.calls.length;
	const retried = await search();
	expect(retried.result.structuredContent.error.kind).toBe(
		'rate_limit',
	);
	expect(fetch_mock.mock.calls.length).toBeGreaterThan(attempts);
});

it('keeps job status and cancel available while a start is refused', async () => {
	const job_id = '12345678-1234-4123-8123-123456789abc';
	fetch_mock.mockImplementation(async () => failing(429, '120'));
	const start = await call('firecrawl_agent', { prompt: 'gather' });
	expect(start.result.isError).toBe(true);
	expect(start.result._meta.retriever.error.kind).toBe('rate_limit');
	const attempts = fetch_mock.mock.calls.length;

	const refused = await call('firecrawl_agent', { prompt: 'gather' });
	expect(refused.result.isError).toBe(true);
	expect(refused.result._meta.retriever.error).toMatchObject({
		kind: 'provider_cooldown',
		provider: 'firecrawl_agent',
		retry_at: at(120),
		trigger_status: 429,
	});
	expect(fetch_mock).toHaveBeenCalledTimes(attempts);

	fetch_mock.mockImplementation(async () =>
		Response.json({
			success: true,
			status: 'completed',
			data: 'done',
		}),
	);
	const status = await call('firecrawl_agent', {
		action: 'status',
		job_id,
	});
	expect(status.result.isError).not.toBe(true);
	fetch_mock.mockImplementation(async () =>
		Response.json({ success: true }),
	);
	const cancel = await call('firecrawl_agent', {
		action: 'cancel',
		job_id,
	});
	expect(cancel.result.isError).not.toBe(true);
	expect(fetch_mock).toHaveBeenCalledTimes(attempts + 2);

	// Tavily research: a cooling provider still answers status reads.
	fetch_mock.mockImplementation(async () => failing(503));
	await call('ai_search', {
		query: 'q',
		provider: 'tavily_research',
	});
	const research_refused = await call('ai_search', {
		query: 'q',
		provider: 'tavily_research',
	});
	expect(research_refused.result._meta.retriever.error).toMatchObject(
		{
			kind: 'provider_cooldown',
			trigger_status: 503,
		},
	);
	fetch_mock.mockImplementation(
		async () =>
			new Response(
				'{"status":"completed","request_id":"job-1","content":"Report"}',
			),
	);
	const research_status = await call('ai_search', {
		provider: 'tavily_research',
		action: 'status',
		request_id: 'job-1',
	});
	expect(research_status.result.isError).not.toBe(true);
});

it('treats a cooling extract provider as one failed source in search_and_read', async () => {
	fetch_mock.mockImplementation(async (target: string) =>
		String(target).endsWith('/extract')
			? failing(429, '120')
			: search_ok(),
	);
	await call('web_extract', {
		url: hit.url,
		provider: 'tavily',
		mode: 'extract',
	});
	const attempts = fetch_mock.mock.calls.length;

	const workflow = await call('search_and_read', {
		query: 'needle',
		search_provider: 'tavily',
		extract_provider: 'tavily',
	});
	expect(workflow.result.isError).not.toBe(true);
	expect(workflow.result.structuredContent.data).toMatchObject({
		metadata: { complete: false },
		sources: [
			{
				status: 'error',
				error: {
					kind: 'provider_cooldown',
					retryable: false,
					provider: 'tavily',
					retry_at: at(120),
					trigger_status: 429,
				},
			},
		],
	});
	// Only the search left the process; the read was refused locally.
	expect(fetch_mock).toHaveBeenCalledTimes(attempts + 1);

	// A cooling search provider fails the whole call, as before.
	fetch_mock.mockImplementation(async () => failing(503));
	await search();
	const blocked = await call('search_and_read', {
		query: 'needle',
		search_provider: 'tavily',
		extract_provider: 'tavily',
	});
	expect(blocked.result).toMatchObject({
		isError: true,
		structuredContent: {
			ok: false,
			error: { kind: 'provider_cooldown', provider: 'tavily' },
		},
	});
});
