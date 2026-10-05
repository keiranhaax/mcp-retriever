import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import * as v from 'valibot';
import { config } from '../../config/env.js';
import { create_server } from '../create_server.js';
import { reset_provider_cooldowns } from '../provider_cooldown.js';
import {
	get_provider_health_snapshot,
	reset_provider_health,
} from '../provider_health.js';
import { get_provider_metrics_snapshot } from '../provider_metrics.js';
import { reset_spend_ledger } from '../spend_caps.js';
import { fused_output_schema } from './web_search_fused.js';

/**
 * Explicit multi-provider search through the real server: every
 * provider goes through its ordinary path, so the tests check the
 * fused ranking, the per-provider outcomes, and that caps, cooldowns,
 * health and metrics behave exactly as for single-provider searches.
 */

const settings = Object.values(config).flatMap(Object.values);
const keys = settings.map((item) => item.api_key);
const fetch_mock = vi.fn();
let server: ReturnType<typeof create_server>;
let directory: string;
let sequence = 0;
const now = Date.parse('2026-10-01T12:00:00.000Z');

const call = async (args: Record<string, unknown>) =>
	(await server.receive(
		{
			jsonrpc: '2.0',
			id: ++sequence,
			method: 'tools/call',
			params: { name: 'web_search_fused', arguments: args },
		},
		{} as any,
	)) as any;

const tavily_body = (urls: string[], credits = 1) => ({
	usage: { credits },
	results: urls.map((url, index) => ({
		title: `Tavily ${index + 1}`,
		url,
		content: `tavily snippet ${index + 1}`,
		score: 1 - index / 10,
	})),
});
const exa_body = (urls: string[], usd = 0.005) => ({
	requestId: 'exa-1',
	costDollars: { total: usd },
	results: urls.map((url, index) => ({
		id: `doc:${index}`,
		title: `Exa ${index + 1}`,
		url,
		text: `exa snippet ${index + 1}`,
	})),
});
const brave_body = (urls: string[]) => ({
	web: {
		results: urls.map((url, index) => ({
			title: `Brave ${index + 1}`,
			url,
			description: `brave snippet ${index + 1}`,
		})),
	},
});
const host = (target: string | URL) => new URL(String(target)).host;
const respond = (
	answers: Record<string, () => Response | Promise<Response>>,
) =>
	fetch_mock.mockImplementation(async (target: string | URL) => {
		const answer = answers[host(target)];
		if (!answer) throw new Error(`unexpected host ${host(target)}`);
		return answer();
	});

beforeEach(() => {
	directory = mkdtempSync(join(tmpdir(), 'retriever-fused-'));
	vi.stubEnv('RETRIEVER_RESULT_DIR', directory);
	vi.stubEnv('RETRIEVER_HTTP_CACHE_BYTES', '0');
	for (const item of settings) item.api_key = undefined;
	config.search.tavily.api_key = 'fused-fixture-key';
	config.search.exa.api_key = 'fused-fixture-key';
	config.search.brave.api_key = 'fused-fixture-key';
	vi.stubGlobal('fetch', fetch_mock);
	fetch_mock.mockReset();
	vi.spyOn(console, 'error').mockImplementation(() => {});
	vi.spyOn(console, 'warn').mockImplementation(() => {});
	vi.setSystemTime(now);
	reset_provider_health();
	reset_provider_cooldowns();
	reset_spend_ledger();
	server = create_server({ name: 'fused-offline', version: '1' });
});

afterEach(() => {
	settings.forEach((item, i) => {
		item.api_key = keys[i];
	});
	reset_provider_health();
	reset_provider_cooldowns();
	reset_spend_ledger();
	vi.useRealTimers();
	vi.unstubAllGlobals();
	vi.unstubAllEnvs();
	vi.restoreAllMocks();
	rmSync(directory, { recursive: true, force: true });
});

it('queries the listed providers in parallel and merges them with RRF', async () => {
	const releases: Array<() => void> = [];
	respond({
		'api.tavily.com': () =>
			new Promise((resolve) =>
				releases.push(() =>
					resolve(
						Response.json(
							tavily_body([
								'https://docs.test/a',
								'https://docs.test/b?utm_source=x',
								'https://docs.test/c',
							]),
						),
					),
				),
			),
		'api.exa.ai': () =>
			new Promise((resolve) =>
				releases.push(() =>
					resolve(
						Response.json(
							exa_body([
								'https://DOCS.test/b/',
								'https://docs.test/d',
								'https://docs.test/a#top',
							]),
						),
					),
				),
			),
	});
	const pending = call({
		query: 'needle',
		providers: ['tavily', 'exa'],
		limit: 3,
	});
	// Both requests are in flight before either answers.
	await vi.waitFor(() => expect(releases).toHaveLength(2));
	for (const release of releases) release();
	const response = await pending;
	expect(response.result.isError).not.toBe(true);
	expect(
		v.safeParse(
			fused_output_schema,
			response.result.structuredContent,
		).success,
	).toBe(true);
	const data = response.result.structuredContent.data;
	expect(data.results.map((item: any) => item.canonical_url)).toEqual(
		[
			'https://docs.test/b',
			'https://docs.test/a',
			'https://docs.test/d',
		],
	);
	expect(data.results[0]).toMatchObject({
		title: 'Tavily 2',
		url: 'https://docs.test/b?utm_source=x',
		snippet: 'tavily snippet 2',
		source_provider: 'tavily',
		source_providers: ['tavily', 'exa'],
		ranks: { tavily: 2, exa: 1 },
		score: Number((1 / 62 + 1 / 61).toFixed(6)),
	});
	expect(data.results[2]).toMatchObject({
		source_provider: 'exa',
		source_providers: ['exa'],
		ranks: { exa: 2 },
	});
	expect(data.providers).toEqual([
		{
			name: 'tavily',
			status: 'ok',
			results: 3,
			elapsed_ms: expect.any(Number),
			usage: { credits: 1 },
			usage_source: 'provider_reported',
		},
		{
			name: 'exa',
			status: 'ok',
			results: 3,
			elapsed_ms: expect.any(Number),
			usage: { usd: 0.005 },
			usage_source: 'provider_reported',
		},
	]);
	expect(data.metadata).toMatchObject({
		fusion: 'rrf',
		k: 60,
		limit: 3,
		requested: 2,
		answered: 2,
		candidates: 4,
		duplicates_removed: 0,
		complete: true,
	});
	// Each provider is asked for the fused limit, and metrics count both
	// through the normal markers under this tool's name.
	const bodies = fetch_mock.mock.calls.map(([, init]: any) =>
		JSON.parse(init.body),
	);
	expect(
		bodies.map((body) => body.max_results ?? body.numResults),
	).toEqual([3, 3]);
	const metrics = get_provider_metrics_snapshot();
	expect(metrics.tools.web_search_fused).toMatchObject({
		calls: 2,
		ok: 2,
		usage: { credits: 1, usd: 0.005, reported_calls: 2 },
	});
	expect(metrics.providers['search:tavily']).toMatchObject({
		calls: 1,
	});
	expect(metrics.providers['search:exa']).toMatchObject({ calls: 1 });
	expect(get_provider_health_snapshot().search).toMatchObject({
		tavily: { last_runtime_status: 'ok' },
		exa: { last_runtime_status: 'ok' },
	});
});

it("returns partial results with the failing provider's typed error", async () => {
	respond({
		'api.tavily.com': () =>
			Response.json(tavily_body(['https://docs.test/a'])),
		'api.exa.ai': () =>
			new Response('{}', {
				status: 429,
				headers: { 'Retry-After': '120' },
			}),
	});
	const response = await call({
		query: 'needle',
		providers: ['tavily', 'exa', 'brave'],
	}).catch((error) => error);
	// Brave never answers here: its key is set but the mock has no host
	// entry, so it fails like a network error.
	expect(response.result.isError).not.toBe(true);
	const data = response.result.structuredContent.data;
	expect(data.results).toHaveLength(1);
	expect(data.providers).toMatchObject([
		{ name: 'tavily', status: 'ok', results: 1 },
		{
			name: 'exa',
			status: 'error',
			results: 0,
			error: {
				kind: 'rate_limit',
				provider: 'exa',
				http_status: 429,
			},
		},
		{
			name: 'brave',
			status: 'error',
			error: { kind: 'upstream_failure', provider: 'brave' },
		},
	]);
	expect(data.metadata).toMatchObject({
		requested: 3,
		answered: 1,
		complete: false,
	});
	expect(get_provider_health_snapshot().search.exa).toMatchObject({
		last_error_kind: 'rate_limit',
		cooldown_until: new Date(now + 120_000).toISOString(),
	});
	expect(
		get_provider_metrics_snapshot().tools.web_search_fused,
	).toMatchObject({
		calls: 3,
		ok: 1,
		failed: 2,
		errors_by_kind: { rate_limit: 1, upstream_failure: 1 },
	});

	// The cooled provider is refused locally on the next call; the others
	// still run, and the refusal is not a health failure.
	const attempts = fetch_mock.mock.calls.length;
	respond({
		'api.tavily.com': () =>
			Response.json(tavily_body(['https://docs.test/a'])),
	});
	const again = await call({
		query: 'needle',
		providers: ['exa', 'tavily'],
	});
	expect(again.result.isError).not.toBe(true);
	expect(
		again.result.structuredContent.data.providers[0],
	).toMatchObject({
		name: 'exa',
		status: 'error',
		error: {
			kind: 'provider_cooldown',
			retry_at: new Date(now + 120_000).toISOString(),
		},
	});
	expect(fetch_mock.mock.calls.length).toBe(attempts + 1);
});

it('fails the call only when every provider failed', async () => {
	respond({
		'api.tavily.com': () => new Response('{}', { status: 401 }),
		'api.exa.ai': () => new Response('{}', { status: 503 }),
	});
	const response = await call({
		query: 'needle',
		providers: ['tavily', 'exa'],
	});
	expect(response.result).toMatchObject({
		isError: true,
		structuredContent: {
			ok: false,
			error: { kind: 'authentication', provider: 'tavily' },
		},
	});
});

it('refuses a capped provider before any request and keeps the others', async () => {
	vi.stubEnv('RETRIEVER_SPEND_CAPS', 'exa:daily:usd=0');
	server = create_server({ name: 'fused-offline', version: '1' });
	respond({
		'api.tavily.com': () =>
			Response.json(tavily_body(['https://docs.test/a'])),
	});
	const response = await call({
		query: 'needle',
		providers: ['tavily', 'exa'],
	});
	expect(response.result.isError).not.toBe(true);
	expect(
		response.result.structuredContent.data.providers[1],
	).toMatchObject({
		name: 'exa',
		status: 'error',
		error: { kind: 'spend_cap', provider: 'exa' },
	});
	expect(
		fetch_mock.mock.calls.map(([target]: any) => host(target)),
	).toEqual(['api.tavily.com']);
	expect(get_provider_health_snapshot().search.exa).toMatchObject({
		last_runtime_status: 'unknown',
	});
});

it('rejects duplicate providers and bad limits before networking', async () => {
	respond({});
	const duplicate = await call({
		query: 'needle',
		providers: ['tavily', 'tavily'],
	});
	expect(duplicate.result).toMatchObject({
		isError: true,
		structuredContent: { error: { kind: 'bad_input' } },
	});
	expect(duplicate.result.content[0].text).toContain(
		'providers must be distinct',
	);
	for (const args of [
		{ query: 'needle', providers: ['tavily'] },
		{ query: 'needle', providers: ['tavily', 'exa', 'brave', 'you'] },
		{ query: 'needle', providers: ['tavily', 'exa'], limit: 0 },
		{ query: 'needle', providers: ['tavily', 'exa'], mode: 'x' },
	]) {
		const response = await call(args);
		expect(response.error ?? response.result?.isError).toBeTruthy();
	}
	expect(fetch_mock).not.toHaveBeenCalled();
});

it('reports a provider that misses the deadline as a timeout without failing the rest', async () => {
	vi.useRealTimers();
	respond({
		'api.tavily.com': () =>
			Response.json(tavily_body(['https://docs.test/a'])),
		'api.exa.ai': () =>
			new Promise(() => {
				// Never answers; the whole-call deadline ends it.
			}),
	});
	const response = await call({
		query: 'needle',
		providers: ['tavily', 'exa'],
		timeout_ms: 200,
	});
	expect(response.result.isError).not.toBe(true);
	const data = response.result.structuredContent.data;
	expect(data.providers).toMatchObject([
		{ name: 'tavily', status: 'ok' },
		{ name: 'exa', status: 'error', error: { kind: 'timeout' } },
	]);
	expect(data.results).toHaveLength(1);
	// A local deadline is not a provider fault.
	expect(get_provider_health_snapshot().search.exa).toMatchObject({
		last_runtime_status: 'unknown',
	});
});

it('offloads an oversized fused result to the result store', async () => {
	const urls = Array.from(
		{ length: 20 },
		(_, index) => `https://docs.test/${index}`,
	);
	const long = 'x'.repeat(6000);
	respond({
		'api.tavily.com': () =>
			Response.json({
				results: urls.map((url) => ({
					title: 't',
					url,
					content: long,
					score: 1,
				})),
			}),
		'api.search.brave.com': () => Response.json(brave_body(urls)),
	});
	const response = await call({
		query: 'needle',
		providers: ['tavily', 'brave'],
		limit: 20,
	});
	expect(response.result.isError).not.toBe(true);
	expect(response.result.structuredContent.data).toMatchObject({
		result_id: expect.any(String),
		read_hint: expect.stringContaining('result_read'),
	});
	expect(
		v.safeParse(
			fused_output_schema,
			response.result.structuredContent,
		).success,
	).toBe(true);
});
