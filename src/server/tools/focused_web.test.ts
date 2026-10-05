import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ValibotJsonSchemaAdapter } from '@tmcp/adapter-valibot';
import { McpServer } from 'tmcp';
import type { GenericSchema } from 'valibot';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { output_schema } from '../../common/tool_output.js';
import { run_with_request_context } from '../../common/request_context.js';
import { config } from '../../config/env.js';
import {
	get_provider_health_snapshot,
	reset_provider_health,
} from '../provider_health.js';
import { initialize_web_extract } from './web_extract.js';
import {
	register_web_read,
	register_web_map,
	register_web_crawl,
} from './focused_web.js';
import { register_result_read } from './result_read.js';

const settings = Object.values(config).flatMap(Object.values);
const keys = settings.map((item) => item.api_key);
const fixture_key = 'focused-web-fixture-key';
const url =
	'https://example.test/report?edition=2&part=a%2Fb#section';
const fetch_mock = vi.fn();
let server: McpServer<GenericSchema>;
let directory: string;
let sequence = 0;

const build_server = () => {
	initialize_web_extract();
	server = new McpServer<GenericSchema>(
		{ name: 'focused-web-offline', version: '1' },
		{
			adapter: new ValibotJsonSchemaAdapter(),
			capabilities: { tools: { listChanged: true } },
		},
	);
	register_web_read(server);
	register_web_map(server);
	register_web_crawl(server);
	register_result_read(server);
};
const call = async (
	name: string,
	arguments_: Record<string, unknown>,
	signal?: AbortSignal,
) =>
	(await run_with_request_context(signal, () =>
		server.receive({
			jsonrpc: '2.0',
			id: ++sequence,
			method: 'tools/call',
			params: { name, arguments: arguments_ },
		}),
	)) as any;
const parsed = (response: any) =>
	JSON.parse(response.result.content[0].text);
const listing = async () => {
	const response: any = await server.receive({
		jsonrpc: '2.0',
		id: ++sequence,
		method: 'tools/list',
	});
	expect(response.error).toBeUndefined();
	return response.result.tools as any[];
};
const recover = async (result_id: string) => {
	let offset = 1;
	let byte_offset = 0;
	let text = '';
	for (let page = 0; page < 100; page++) {
		const response = await call('result_read', {
			result_id,
			offset,
			byte_offset,
			limit: 500,
		});
		expect(response.result.isError).not.toBe(true);
		const chunk = parsed(response);
		text += chunk.content;
		if (chunk.next_offset === undefined) return JSON.parse(text);
		if (chunk.next_byte_offset === undefined) text += '\n';
		offset = chunk.next_offset;
		byte_offset = chunk.next_byte_offset ?? 0;
	}
	throw new Error('Fixture evidence exceeded pagination bound');
};
const enable_read = (provider: 'tavily' | 'exa' | 'firecrawl') => {
	config.processing[
		provider === 'tavily'
			? 'tavily_extract'
			: provider === 'exa'
				? 'exa_contents'
				: 'firecrawl_scrape'
	].api_key = fixture_key;
	build_server();
};
const respond_read = (content = 'Original page evidence') => {
	fetch_mock.mockImplementation(async (target, options) => {
		const path = new URL(String(target)).pathname;
		const body = JSON.parse(options.body);
		if (path === '/extract')
			return Response.json({
				results: body.urls.map((url: string) => ({
					url,
					raw_content: content,
				})),
				failed_results: [],
			});
		if (path === '/contents')
			return Response.json({
				results: body.urls.map((url: string) => ({
					url,
					text: content,
				})),
			});
		expect(path).toBe('/v2/scrape');
		return Response.json({
			success: true,
			data: { markdown: content },
		});
	});
};

const enable_firecrawl = () => {
	for (const key of [
		'firecrawl_scrape',
		'firecrawl_crawl',
		'firecrawl_map',
	] as const)
		config.processing[key].api_key = fixture_key;
	build_server();
};

beforeEach(() => {
	directory = mkdtempSync(join(tmpdir(), 'retriever-focused-web-'));
	vi.stubEnv('HOME', directory);
	vi.stubEnv('RETRIEVER_RESULT_DIR', directory);
	vi.stubEnv('RETRIEVER_RESULT_MAX_BYTES', '10000000');
	vi.stubEnv('RETRIEVER_RESULT_STORE_MAX_BYTES', '20000000');
	for (const item of settings) item.api_key = undefined;
	config.processing.tavily_extract.api_key = fixture_key;
	vi.stubGlobal('fetch', fetch_mock);
	fetch_mock.mockReset();
	fetch_mock.mockRejectedValue(
		new Error('Unexpected fixture request'),
	);
	vi.spyOn(console, 'error').mockImplementation(() => {});
	vi.spyOn(console, 'warn').mockImplementation(() => {});
	reset_provider_health();
	build_server();
});
afterEach(() => {
	settings.forEach((item, i) => {
		item.api_key = keys[i];
	});
	reset_provider_health();
	vi.useRealTimers();
	vi.unstubAllGlobals();
	vi.unstubAllEnvs();
	vi.restoreAllMocks();
	rmSync(directory, { recursive: true, force: true });
});

it.each(['tavily', 'exa', 'firecrawl'] as const)(
	'dispatches %s URL batches with basic options and no synthesis',
	async (provider) => {
		enable_read(provider);
		respond_read();
		const urls = [url, 'https://example.test/guide?version=1'];
		const response = await call('web_read', {
			provider,
			url: urls,
			query: 'needle',
		});
		expect(response.result).toMatchObject({
			structuredContent: { ok: true },
		});
		const data = parsed(response);
		expect(data.raw_contents).toEqual(
			urls.map((url) => ({ url, content: 'Original page evidence' })),
		);
		expect(response.result.structuredContent.data).toEqual(data);
		const bodies = fetch_mock.mock.calls.map(([target, options]) => {
			expect(options.method).toBe('POST');
			expect(String(target)).toBe(
				provider === 'tavily'
					? 'https://api.tavily.com/extract'
					: provider === 'exa'
						? 'https://api.exa.ai/contents'
						: 'https://api.firecrawl.dev/v2/scrape',
			);
			return JSON.parse(options.body);
		});
		expect(bodies).toEqual(
			provider === 'tavily'
				? [
						{
							urls,
							query: 'needle',
							include_images: false,
							extract_depth: 'basic',
						},
					]
				: provider === 'exa'
					? [{ urls, text: true, highlights: false, summary: false }]
					: urls.map((url) => ({
							url,
							formats: ['markdown'],
							onlyMainContent: true,
						})),
		);
	},
);

it.each(['tavily', 'exa', 'firecrawl'] as const)(
	'accepts the 20-URL and 4096-character read boundaries for %s',
	async (provider) => {
		enable_read(provider);
		respond_read('Bounded fixture');
		const prefix = 'https://example.test/';
		const long_url = prefix + 'a'.repeat(4096 - prefix.length);
		const urls = Array.from({ length: 20 }, (_, index) =>
			index === 0 ? long_url : `${url}-${index}`,
		);
		const response = await call('web_read', { provider, url: urls });
		expect(response.result).toMatchObject({
			structuredContent: { ok: true },
		});
		expect(
			parsed(response).raw_contents.map((item: any) => item.url),
		).toEqual(urls);
		expect(fetch_mock).toHaveBeenCalledTimes(
			provider === 'firecrawl' ? 20 : 1,
		);
	},
);

it.each(['tavily', 'exa', 'firecrawl'] as const)(
	'rejects unsafe or non-URL inputs for %s before dispatch',
	async (provider) => {
		enable_read(provider);
		respond_read();
		for (const target of [
			'exa-result-id',
			'http://localhost/',
			'http://127.0.0.1/',
			'http://169.254.169.254/',
			'http://[::1]/',
			'file:///etc/passwd',
			'https://user:PRIVATE_URL_CANARY@example.test/',
			[url, 'exa-result-id'],
		]) {
			const response = await call('web_read', {
				provider,
				url: target,
			});
			expect(response.result).toMatchObject({
				isError: true,
				structuredContent: {
					ok: false,
					error: { kind: 'bad_input' },
				},
			});
			expect(JSON.stringify(response)).not.toContain(
				'PRIVATE_URL_CANARY',
			);
		}
		expect(fetch_mock).not.toHaveBeenCalled();
		expect(
			get_provider_health_snapshot().processing[provider]
				?.active_error,
		).not.toBe(true);
	},
);

it.each([
	{ url: undefined },
	{ url: '' },
	{ url: [] },
	{ url: [url, ''] },
	{ url: Array.from({ length: 21 }, () => url) },
	{ url: 'https://example.test/' + 'a'.repeat(4096) },
	{ url: ['https://example.test/' + 'a'.repeat(4096)] },
	{ provider: 'missing' },
	{ query: '' },
	{ query: 'a'.repeat(10001) },
	{ query: null },
	{ chunks_per_source: 0 },
	{ chunks_per_source: 6 },
	{ chunks_per_source: 1.5 },
	{ format: 'html' },
	{ response_mode: 'summary' },
	{ output_budget_bytes: 2047 },
	{ output_budget_bytes: 80001 },
	{ output_budget_bytes: 2048.5 },
	{ mode: 'actions' },
	{ extract_depth: 'advanced' },
	{ firecrawl_options: { formats: ['summary'] } },
	{ firecrawl_search_options: { limit: 1 } },
	{ formats: ['summary'] },
	{ actions: [{ type: 'click', selector: '#buy' }] },
	{ headers: { Authorization: 'PRIVATE_UNKNOWN_CANARY' } },
	{ question: 'Synthesize an answer' },
])(
	'rejects unsupported read schema controls %# without networking',
	async (invalid) => {
		respond_read();
		const response = await call('web_read', {
			provider: 'tavily',
			url,
			...invalid,
		});
		expect(response.result).toMatchObject({ isError: true });
		// tmcp rejects schema violations before the handler; preserve that boundary.
		expect(response.result.structuredContent).toBeUndefined();
		expect(JSON.stringify(response)).not.toContain(
			'PRIVATE_UNKNOWN_CANARY',
		);
		expect(fetch_mock).not.toHaveBeenCalled();
	},
);

it.each([
	{ chunks_per_source: 1 },
	{ query: '  ' },
	{ output_budget_bytes: 2048 },
	{ response_mode: 'legacy', output_budget_bytes: 2048 },
])(
	'returns structured read cross-field rejection %# without networking',
	async (invalid) => {
		respond_read();
		const response = await call('web_read', {
			provider: 'tavily',
			url,
			...invalid,
		});
		expect(response.result).toMatchObject({
			isError: true,
			structuredContent: {
				ok: false,
				error: { kind: 'bad_input', retryable: false },
			},
		});
		expect(fetch_mock).not.toHaveBeenCalled();
	},
);

it.each(['tavily', 'exa', 'firecrawl'] as const)(
	'bounds %s compact output and retains exact source evidence',
	async (provider) => {
		enable_read(provider);
		const evidence =
			'# Background\n' +
			'漢字😀 background text.\n'.repeat(1000) +
			'\n# Findings\nneedle exact citation [1].\n';
		respond_read(evidence);
		const response = await call('web_read', {
			provider,
			url,
			query: 'needle exact citation',
			response_mode: 'compact',
			output_budget_bytes: 6000,
		});
		expect(response.result.isError).not.toBe(true);
		expect(
			Buffer.byteLength(JSON.stringify(response.result)),
		).toBeLessThanOrEqual(6000);
		const data = parsed(response);
		expect(response.result.structuredContent).toEqual({
			ok: true,
			data,
		});
		expect(data.metadata.local_completeness).toBe('selected');
		expect(data.sources[0].url).toBe(url);
		expect(
			data.sources.some((source: any) =>
				source.passages.some((passage: any) =>
					passage.text.includes('needle exact citation'),
				),
			),
		).toBe(true);
		const canonical = await recover(data.result_id);
		const original =
			canonical.result.raw_contents?.[0]?.content ??
			canonical.result.content;
		expect(original).toBe(evidence);
		for (const source of data.sources) {
			const text =
				source.id === '/content'
					? canonical.result.content
					: canonical.result.raw_contents[
							Number(source.id.split('/')[2])
						].content;
			for (const passage of source.passages)
				expect(text.slice(passage.start, passage.end)).toBe(
					passage.text,
				);
		}
		expect(fetch_mock).toHaveBeenCalledTimes(1);
	},
);

it.each(['exa', 'firecrawl'] as const)(
	'rejects Tavily controls for %s before networking',
	async (provider) => {
		enable_read(provider);
		respond_read();
		for (const controls of [
			{ format: 'text' },
			{ chunks_per_source: 1 },
		]) {
			const response = await call('web_read', {
				provider,
				url,
				query: 'needle',
				...controls,
			});
			expect(response.result).toMatchObject({
				isError: true,
				structuredContent: {
					ok: false,
					error: { kind: 'bad_input' },
				},
			});
		}
		expect(fetch_mock).not.toHaveBeenCalled();
	},
);

it.each(['exa', 'firecrawl'] as const)(
	'rejects a blank local query for %s before networking',
	async (provider) => {
		enable_read(provider);
		respond_read();
		const response = await call('web_read', {
			provider,
			url,
			query: '  \t\n',
		});
		expect(response.result).toMatchObject({
			isError: true,
			structuredContent: { ok: false, error: { kind: 'bad_input' } },
		});
		expect(fetch_mock).not.toHaveBeenCalled();
	},
);

it('maps one public URL with the existing Firecrawl basic limit', async () => {
	config.processing.firecrawl_scrape.api_key = fixture_key;
	config.processing.firecrawl_map.api_key = fixture_key;
	build_server();
	fetch_mock.mockResolvedValue(
		Response.json({
			success: true,
			links: [{ url, title: 'Original report' }],
		}),
	);
	const response = await call('web_map', {
		url,
		response_mode: 'full',
	});
	expect(response.error).toBeUndefined();
	expect(response.result).toMatchObject({
		structuredContent: {
			ok: true,
			data: {
				metadata: { provider: 'firecrawl', operation: 'map' },
				result: { source_provider: 'firecrawl_map' },
			},
		},
	});
	expect(parsed(response).result.raw_contents[0].content).toContain(
		url,
	);
	expect(fetch_mock).toHaveBeenCalledTimes(1);
	const [target, options] = fetch_mock.mock.calls[0];
	expect(String(target)).toBe('https://api.firecrawl.dev/v2/map');
	expect(JSON.parse(options.body)).toEqual({
		url,
		limit: 50,
		includeSubdomains: false,
	});
});

it('creates one Firecrawl crawl and polls that same job to completion', async () => {
	config.processing.firecrawl_scrape.api_key = fixture_key;
	config.processing.firecrawl_crawl.api_key = fixture_key;
	build_server();
	vi.useFakeTimers();
	fetch_mock
		.mockResolvedValueOnce(
			Response.json({ success: true, id: 'fixture-job' }),
		)
		.mockResolvedValueOnce(Response.json({ status: 'scraping' }))
		.mockResolvedValueOnce(
			Response.json({
				status: 'completed',
				total: 1,
				completed: 1,
				data: [{ url, markdown: 'Crawled original evidence' }],
			}),
		);
	const pending = call('web_crawl', { url, response_mode: 'full' });
	await vi.advanceTimersByTimeAsync(10000);
	const response = await pending;
	expect(response.error).toBeUndefined();
	expect(response.result).toMatchObject({
		structuredContent: {
			ok: true,
			data: {
				metadata: { provider: 'firecrawl', operation: 'crawl' },
				result: {
					raw_contents: [
						{ url, content: 'Crawled original evidence' },
					],
					source_provider: 'firecrawl_crawl',
				},
			},
		},
	});
	expect(
		fetch_mock.mock.calls.map(([target, options]) => [
			String(target),
			options.method,
		]),
	).toEqual([
		['https://api.firecrawl.dev/v2/crawl', 'POST'],
		['https://api.firecrawl.dev/v2/crawl/fixture-job', 'GET'],
		['https://api.firecrawl.dev/v2/crawl/fixture-job', 'GET'],
	]);
	expect(JSON.parse(fetch_mock.mock.calls[0][1].body)).toEqual({
		url,
		scrapeOptions: { formats: ['markdown'], onlyMainContent: true },
		maxDiscoveryDepth: 1,
		limit: 20,
	});
});

it.each(['web_map', 'web_crawl'])(
	'keeps %s input narrow and validates the public target before networking',
	async (name) => {
		enable_firecrawl();
		for (const invalid of [
			{ url: undefined },
			{ url: '' },
			{ url: [] },
			{ url: [url] },
			{ url: 'https://example.test/' + 'a'.repeat(4096) },
			{ extract_depth: 'unbounded' },
			{ provider: 'firecrawl' },
			{ mode: 'scrape' },
			{ query: 'needle' },
			{ format: 'text' },
			{ chunks_per_source: 1 },
			{ firecrawl_options: {} },
			{ actions: [] },
			{ headers: {} },
			{ limit: 2000 },
			{ response_mode: 'unknown' },
			{ output_budget_bytes: 2047 },
			{ output_budget_bytes: 80001 },
		]) {
			const response = await call(name, { url, ...invalid });
			expect(response.result).toMatchObject({ isError: true });
			expect(response.result.structuredContent).toBeUndefined();
		}
		for (const target of [
			'exa-id',
			'http://localhost',
			'http://10.0.0.1/',
			'http://[::1]/',
			'file:///etc/passwd',
			'https://user:PRIVATE_URL_CANARY@example.test/',
		]) {
			const response = await call(name, { url: target });
			expect(response.result).toMatchObject({
				isError: true,
				structuredContent: {
					ok: false,
					error: { kind: 'bad_input' },
				},
			});
			expect(JSON.stringify(response)).not.toContain(
				'PRIVATE_URL_CANARY',
			);
		}
		const response = await call(name, {
			url,
			output_budget_bytes: 2048,
		});
		expect(response.result).toMatchObject({
			isError: true,
			structuredContent: { ok: false, error: { kind: 'bad_input' } },
		});
		expect(fetch_mock).not.toHaveBeenCalled();
	},
);

it.each(['web_map', 'web_crawl'])(
	'preserves %s advanced depth limits and exact URL input',
	async (name) => {
		enable_firecrawl();
		vi.useFakeTimers();
		const prefix = 'https://example.test/';
		const target = prefix + 'a'.repeat(4096 - prefix.length);
		if (name === 'web_map')
			fetch_mock.mockResolvedValueOnce(
				Response.json({ success: true, links: [{ url: target }] }),
			);
		else
			fetch_mock
				.mockResolvedValueOnce(
					Response.json({ success: true, id: 'fixture-job' }),
				)
				.mockResolvedValueOnce(
					Response.json({
						status: 'completed',
						data: [{ url: target, markdown: 'Original evidence' }],
					}),
				);
		const pending = call(name, {
			url: target,
			extract_depth: 'advanced',
		});
		await vi.advanceTimersByTimeAsync(5000);
		const response = await pending;
		expect(response.result).toMatchObject({
			structuredContent: { ok: true },
		});
		expect(parsed(response).metadata.extract_depth).toBe('advanced');
		expect(JSON.parse(fetch_mock.mock.calls[0][1].body)).toEqual(
			name === 'web_map'
				? { url: target, limit: 200, includeSubdomains: false }
				: {
						url: target,
						limit: 50,
						maxDiscoveryDepth: 3,
						scrapeOptions: {
							formats: ['markdown'],
							onlyMainContent: true,
						},
					},
		);
		expect(fetch_mock).toHaveBeenCalledTimes(
			name === 'web_map' ? 1 : 2,
		);
	},
);

it.each(['failed', 'error', 'cancelled'])(
	'reports a terminal %s crawl without starting another job',
	async (status) => {
		enable_firecrawl();
		vi.useFakeTimers();
		fetch_mock
			.mockResolvedValueOnce(
				Response.json({ success: true, id: 'fixture-job' }),
			)
			.mockResolvedValueOnce(
				Response.json({ status, error: 'PRIVATE_PROVIDER_CANARY' }),
			);
		const pending = call('web_crawl', { url });
		await vi.advanceTimersByTimeAsync(5000);
		const response = await pending;
		expect(response.result).toMatchObject({
			isError: true,
			structuredContent: {
				ok: false,
				error: {
					kind: 'upstream_failure',
					provider: 'firecrawl_crawl',
				},
			},
		});
		expect(JSON.stringify(response)).not.toContain(
			'PRIVATE_PROVIDER_CANARY',
		);
		expect(fetch_mock).toHaveBeenCalledTimes(2);
		expect(
			fetch_mock.mock.calls.filter(
				([, options]) => options.method === 'POST',
			),
		).toHaveLength(1);
		expect(
			get_provider_health_snapshot().processing.firecrawl
				.active_error,
		).toBe(true);
	},
);

it('retries a transient crawl status failure by polling, never by recreating', async () => {
	enable_firecrawl();
	vi.useFakeTimers();
	fetch_mock
		.mockResolvedValueOnce(
			Response.json({ success: true, id: 'fixture-job' }),
		)
		.mockResolvedValueOnce(Response.json({}, { status: 503 }))
		.mockResolvedValueOnce(
			Response.json({
				status: 'completed',
				data: [{ url, markdown: 'Recovered evidence' }],
			}),
		);
	const pending = call('web_crawl', { url });
	await vi.advanceTimersByTimeAsync(10000);
	const response = await pending;
	expect(response.result).toMatchObject({
		structuredContent: { ok: true },
	});
	expect(
		fetch_mock.mock.calls.map(([, options]) => options.method),
	).toEqual(['POST', 'GET', 'GET']);
	expect(fetch_mock.mock.calls[1][0]).toBe(
		fetch_mock.mock.calls[2][0],
	);
});

it.each(['web_map', 'web_crawl'])(
	'does not retry a failed %s creation request',
	async (name) => {
		enable_firecrawl();
		fetch_mock.mockImplementation(async () =>
			Response.json({}, { status: 503 }),
		);
		const response = await call(name, { url });
		expect(response.result).toMatchObject({
			isError: true,
			structuredContent: {
				ok: false,
				error: { kind: 'upstream_failure', http_status: 503 },
			},
		});
		expect(fetch_mock).toHaveBeenCalledTimes(1);
	},
);

it.each([
	['web_read', 'tavily'],
	['web_read', 'exa'],
	['web_read', 'firecrawl'],
	['web_map', 'firecrawl'],
	['web_crawl', 'firecrawl'],
])(
	'classifies %s %s entitlement errors without leaking upstream text',
	async (name, provider) => {
		enable_firecrawl();
		config.processing.exa_contents.api_key = fixture_key;
		build_server();
		fetch_mock.mockImplementation(async () =>
			Response.json(
				{ error: 'PRIVATE_PROVIDER_CANARY' },
				{ status: 403 },
			),
		);
		const response = await call(name, {
			url,
			...(name === 'web_read' ? { provider } : {}),
		});
		expect(response.result).toMatchObject({
			isError: true,
			structuredContent: {
				ok: false,
				error: {
					kind: 'entitlement',
					retryable: false,
					http_status: 403,
				},
			},
		});
		expect(JSON.stringify(response)).not.toContain(
			'PRIVATE_PROVIDER_CANARY',
		);
		expect(
			get_provider_health_snapshot().processing[provider],
		).toMatchObject({
			active_error: true,
			last_runtime_status: 'entitlement_required',
		});
		expect(fetch_mock).toHaveBeenCalledTimes(1);
	},
);

it.each(['web_map', 'web_crawl'])(
	'bounds %s full output and recovers complete evidence without refetching',
	async (name) => {
		enable_firecrawl();
		vi.useFakeTimers();
		const evidence = 'Original 漢字😀 evidence.\n'.repeat(2000);
		if (name === 'web_map')
			fetch_mock.mockResolvedValueOnce(
				Response.json({
					success: true,
					links: [{ url, title: evidence }],
				}),
			);
		else
			fetch_mock
				.mockResolvedValueOnce(
					Response.json({ success: true, id: 'fixture-job' }),
				)
				.mockResolvedValueOnce(
					Response.json({
						status: 'completed',
						data: [{ url, markdown: evidence }],
					}),
				);
		const pending = call(name, {
			url,
			response_mode: 'full',
			output_budget_bytes: 2048,
		});
		await vi.advanceTimersByTimeAsync(5000);
		const response = await pending;
		expect(response.result.isError).not.toBe(true);
		expect(
			Buffer.byteLength(JSON.stringify(response.result)),
		).toBeLessThanOrEqual(2048);
		const data = parsed(response);
		expect(data.metadata.local_completeness).toBe('retained');
		expect(response.result.structuredContent).toEqual({
			ok: true,
			data,
		});
		const canonical = await recover(data.result_id);
		const content = canonical.result.raw_contents[0].content;
		if (name === 'web_crawl') expect(content).toBe(evidence);
		else expect(content).toContain(evidence);
		expect(fetch_mock).toHaveBeenCalledTimes(
			name === 'web_map' ? 1 : 2,
		);
	},
);

it.each(['web_read', 'web_map', 'web_crawl'])(
	'keeps %s evidence-retention failure local instead of blaming the provider',
	async (name) => {
		enable_firecrawl();
		vi.stubEnv('RETRIEVER_RESULT_MAX_BYTES', '1');
		vi.stubEnv('RETRIEVER_RESULT_STORE_MAX_BYTES', '1');
		vi.useFakeTimers();
		const evidence = 'PRIVATE_FULL_EVIDENCE'.repeat(1000);
		if (name === 'web_read') respond_read(evidence);
		else if (name === 'web_map')
			fetch_mock.mockResolvedValueOnce(
				Response.json({
					success: true,
					links: [{ url, title: evidence }],
				}),
			);
		else
			fetch_mock
				.mockResolvedValueOnce(
					Response.json({ success: true, id: 'fixture-job' }),
				)
				.mockResolvedValueOnce(
					Response.json({
						status: 'completed',
						data: [{ url, markdown: evidence }],
					}),
				);
		const pending = call(name, {
			url,
			...(name === 'web_read' ? { provider: 'tavily' } : {}),
			response_mode: 'compact',
			output_budget_bytes: 2048,
		});
		await vi.advanceTimersByTimeAsync(5000);
		const response = await pending;
		expect(response.result).toMatchObject({
			isError: true,
			structuredContent: {
				ok: false,
				error: { kind: 'storage_failure', retryable: false },
			},
		});
		expect(JSON.stringify(response)).not.toContain(
			'PRIVATE_FULL_EVIDENCE',
		);
		expect(JSON.stringify(response)).not.toContain('result_id');
		expect(
			Buffer.byteLength(JSON.stringify(response.result)),
		).toBeLessThanOrEqual(2048);
		const provider = name === 'web_read' ? 'tavily' : 'firecrawl';
		expect(
			get_provider_health_snapshot().processing[provider]
				?.active_error,
		).not.toBe(true);
	},
);

it.each(['tavily', 'exa', 'firecrawl'] as const)(
	'advertises only the configured %s simple read pair',
	async (provider) => {
		for (const item of settings) item.api_key = undefined;
		enable_read(provider);
		const tools = await listing();
		const read = tools.find((tool) => tool.name === 'web_read');
		expect(read.inputSchema.properties.provider.enum).toEqual([
			provider,
		]);
		expect(tools.some((tool) => tool.name === 'web_crawl')).toBe(
			provider === 'firecrawl',
		);
		expect(tools.some((tool) => tool.name === 'web_map')).toBe(
			provider === 'firecrawl',
		);
		expect(fetch_mock).not.toHaveBeenCalled();
	},
);

it('omits focused tools when simple read registry modes are unconfigured', async () => {
	for (const item of settings) item.api_key = undefined;
	config.processing.exa_similar.api_key = fixture_key;
	config.processing.firecrawl_extract.api_key = fixture_key;
	config.processing.firecrawl_map.api_key = fixture_key;
	build_server();
	expect((await listing()).map((tool) => tool.name)).toEqual([
		'result_read',
	]);
	expect(fetch_mock).not.toHaveBeenCalled();
});

it('advertises strict focused schemas, byte bounds, output contracts and safety annotations', async () => {
	enable_firecrawl();
	config.processing.exa_contents.api_key = fixture_key;
	build_server();
	const tools = (await listing()).filter(
		(tool) => tool.name !== 'result_read',
	);
	expect(tools.map((tool) => String(tool.name)).sort()).toEqual([
		'web_crawl',
		'web_map',
		'web_read',
	]);
	const output = await new ValibotJsonSchemaAdapter().toJsonSchema(
		output_schema,
	);
	for (const tool of tools) {
		expect(tool.description.length).toBeLessThanOrEqual(300);
		expect(tool.inputSchema.additionalProperties).toBe(false);
		expect(tool.outputSchema).toEqual(output);
		expect(
			tool.inputSchema.properties.output_budget_bytes,
		).toMatchObject({
			type: 'integer',
			minimum: 2048,
			maximum: 80000,
		});
		expect(tool.annotations).toEqual({
			readOnlyHint: tool.name !== 'web_crawl',
			destructiveHint: false,
			idempotentHint: tool.name !== 'web_crawl',
			openWorldHint: true,
		});
		if (tool.name === 'web_read') {
			expect(tool.inputSchema.required).toEqual(['provider', 'url']);
			expect(tool.inputSchema.properties.provider.enum).toEqual([
				'tavily',
				'exa',
				'firecrawl',
			]);
			expect(Object.keys(tool.inputSchema.properties).sort()).toEqual(
				[
					'chunks_per_source',
					'format',
					'output_budget_bytes',
					'provider',
					'query',
					'response_mode',
					'url',
				],
			);
			expect(tool.inputSchema.properties.url.anyOf).toEqual([
				expect.objectContaining({
					type: 'string',
					minLength: 1,
					maxLength: 4096,
				}),
				expect.objectContaining({
					type: 'array',
					minItems: 1,
					maxItems: 20,
					items: expect.objectContaining({
						type: 'string',
						maxLength: 4096,
					}),
				}),
			]);
		} else {
			expect(tool.inputSchema.required).toEqual(['url']);
			expect(Object.keys(tool.inputSchema.properties).sort()).toEqual(
				[
					'extract_depth',
					'output_budget_bytes',
					'response_mode',
					'url',
				],
			);
			expect(tool.inputSchema.properties.url).toMatchObject({
				type: 'string',
				maxLength: 4096,
			});
			expect(tool.description).toContain('Firecrawl');
			if (tool.name === 'web_crawl') {
				expect(tool.description).toMatch(/20.*50/);
				expect(tool.description).toContain('do not repeat');
			} else expect(tool.description).toMatch(/50.*200/);
		}
	}
	expect(fetch_mock).not.toHaveBeenCalled();
});

it.each(['web_read', 'web_map', 'web_crawl'])(
	'honors pre-request cancellation for %s without networking',
	async (name) => {
		enable_firecrawl();
		const controller = new AbortController();
		controller.abort();
		const response = await call(
			name,
			{ url, ...(name === 'web_read' ? { provider: 'tavily' } : {}) },
			controller.signal,
		);
		expect(response.result).toMatchObject({
			isError: true,
			structuredContent: { ok: false, error: { kind: 'cancelled' } },
		});
		expect(fetch_mock).not.toHaveBeenCalled();
	},
);

it('preserves the crawl deadline and stops without recreating the job', async () => {
	enable_firecrawl();
	vi.useFakeTimers();
	const original_timeout = config.processing.firecrawl_crawl.timeout;
	config.processing.firecrawl_crawl.timeout = 6000;
	try {
		fetch_mock
			.mockResolvedValueOnce(
				Response.json({ success: true, id: 'fixture-job' }),
			)
			.mockResolvedValueOnce(Response.json({ status: 'scraping' }));
		const pending = call('web_crawl', { url });
		await vi.advanceTimersByTimeAsync(6000);
		const response = await pending;
		expect(response.result).toMatchObject({
			isError: true,
			structuredContent: { ok: false, error: { kind: 'timeout' } },
		});
		// The abandoned job is cancelled remotely instead of recreated.
		expect(
			fetch_mock.mock.calls.map(([, options]) => options.method),
		).toEqual(['POST', 'GET', 'DELETE']);
	} finally {
		config.processing.firecrawl_crawl.timeout = original_timeout;
	}
});

it.each(['web_read', 'web_crawl'])(
	'retains partial %s evidence with explicit source failure metadata',
	async (name) => {
		enable_firecrawl();
		vi.useFakeTimers();
		const failed_url = 'https://example.test/failed';
		if (name === 'web_read')
			fetch_mock.mockResolvedValueOnce(
				Response.json({
					results: [{ url, raw_content: 'Partial evidence' }],
					failed_results: [
						{ url: failed_url, error: 'upstream unavailable' },
					],
				}),
			);
		else
			fetch_mock
				.mockResolvedValueOnce(
					Response.json({ success: true, id: 'fixture-job' }),
				)
				.mockResolvedValueOnce(
					Response.json({
						status: 'completed',
						data: [
							{ url, markdown: 'Partial evidence' },
							{ url: failed_url, error: 'upstream unavailable' },
						],
					}),
				);
		const pending = call(name, {
			url,
			...(name === 'web_read' ? { provider: 'tavily' } : {}),
			response_mode: 'full',
		});
		await vi.advanceTimersByTimeAsync(5000);
		const response = await pending;
		expect(response.result).toMatchObject({
			structuredContent: {
				ok: true,
				data: {
					metadata: { provider_partial: true },
					result: {
						raw_contents: [{ url, content: 'Partial evidence' }],
						metadata: { failed_urls: [failed_url] },
					},
				},
			},
		});
		expect(parsed(response).warnings).toContain(
			'Provider reported failed sources; retained content includes successful sources only.',
		);
	},
);

it.each([undefined, 'legacy', 'full', 'compact'] as const)(
	'keeps read retention failure local for response mode %s',
	async (response_mode) => {
		vi.stubEnv('RETRIEVER_RESULT_MAX_BYTES', '1');
		vi.stubEnv('RETRIEVER_RESULT_STORE_MAX_BYTES', '1');
		respond_read('PRIVATE_FULL_EVIDENCE'.repeat(5000));
		const response = await call('web_read', {
			url,
			provider: 'tavily',
			...(response_mode ? { response_mode } : {}),
		});
		expect(response.result).toMatchObject({
			isError: true,
			structuredContent: {
				ok: false,
				error: { kind: 'storage_failure' },
			},
		});
		expect(JSON.stringify(response)).not.toContain(
			'PRIVATE_FULL_EVIDENCE',
		);
		expect(
			get_provider_health_snapshot().processing.tavily?.active_error,
		).not.toBe(true);
	},
);

it('reports an unavailable read adapter after registry reinitialization without networking', async () => {
	config.processing.tavily_extract.api_key = undefined;
	initialize_web_extract();
	const response = await call('web_read', {
		provider: 'tavily',
		url,
	});
	expect(response.result).toMatchObject({
		isError: true,
		structuredContent: { ok: false, error: { kind: 'bad_input' } },
	});
	expect(fetch_mock).not.toHaveBeenCalled();
});

it.each([
	{ chunks_per_source: 1, query: 'needle', format: 'markdown' },
	{ query: 'q'.repeat(10000) },
])('accepts valid Tavily boundary controls %#', async (controls) => {
	respond_read();
	const response = await call('web_read', {
		provider: 'tavily',
		url,
		...controls,
	});
	expect(response.result).toMatchObject({
		structuredContent: { ok: true },
	});
	expect(JSON.parse(fetch_mock.mock.calls[0][1].body)).toEqual({
		urls: [url],
		include_images: false,
		extract_depth: 'basic',
		...controls,
	});
});

it('forwards only explicit Tavily reranking controls with basic extraction', async () => {
	fetch_mock.mockResolvedValue(
		Response.json({
			results: [{ url, raw_content: 'Focused evidence' }],
			failed_results: [],
		}),
	);
	const query = ' needle exact evidence ';
	const response = await call('web_read', {
		provider: 'tavily',
		url,
		query,
		chunks_per_source: 5,
		format: 'text',
	});
	expect(response.error).toBeUndefined();
	expect(response.result).toMatchObject({
		structuredContent: { ok: true },
	});
	expect(JSON.parse(fetch_mock.mock.calls[0][1].body)).toEqual({
		urls: [url],
		include_images: false,
		extract_depth: 'basic',
		query,
		chunks_per_source: 5,
		format: 'text',
	});
});

it('reads a URL through Tavily basic extraction with structured evidence', async () => {
	fetch_mock.mockResolvedValue(
		Response.json({
			results: [{ url, raw_content: 'Original page evidence' }],
			failed_results: [],
		}),
	);
	const response = await call('web_read', {
		provider: 'tavily',
		url,
		response_mode: 'full',
	});
	expect(response.error).toBeUndefined();
	expect(response.result).toMatchObject({
		structuredContent: {
			ok: true,
			data: {
				response_mode: 'full',
				metadata: { provider: 'tavily', operation: 'extract' },
				result: {
					raw_contents: [{ url, content: 'Original page evidence' }],
					source_provider: 'tavily_extract',
				},
			},
		},
	});
	expect(response.result.structuredContent.data).toEqual(
		parsed(response),
	);
	expect(fetch_mock).toHaveBeenCalledTimes(1);
	const [target, options] = fetch_mock.mock.calls[0];
	expect(String(target)).toBe('https://api.tavily.com/extract');
	expect(options.method).toBe('POST');
	expect(JSON.parse(options.body)).toEqual({
		urls: [url],
		include_images: false,
		extract_depth: 'basic',
	});
	expect(
		get_provider_health_snapshot().processing.tavily,
	).toMatchObject({ last_runtime_status: 'ok', active_error: false });
});
