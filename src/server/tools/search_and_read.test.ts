import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { config } from '../../config/env.js';
import { create_server } from '../create_server.js';

const settings = Object.values(config).flatMap(Object.values);
const keys = settings.map((item) => item.api_key);
let server: ReturnType<typeof create_server>;
let directory: string;
let sequence = 0;
const fetch_mock = vi.fn();
const first = 'https://example.test/report?edition=2';
const second = 'https://example.test/guide';
const args = {
	query: 'needle',
	search_provider: 'tavily',
	extract_provider: 'tavily',
};
const call = async (
	name: string,
	arguments_: Record<string, unknown> = args,
	signal?: AbortSignal,
) => {
	return (await server.receive(
		{
			jsonrpc: '2.0',
			id: ++sequence,
			method: 'tools/call',
			params: { name, arguments: arguments_ },
		},
		{ signal } as any,
	)) as any;
};
const parsed = (response: any) =>
	JSON.parse(response.result.content[0].text);
const respond = (urls = [first, first, second]) => {
	fetch_mock.mockImplementation(async (target, options) => {
		const body = JSON.parse(options.body);
		if (String(target) === 'https://api.tavily.com/search')
			return Response.json({
				results: urls.map((url, i) => ({
					url,
					title: `Result ${i}`,
					content: 'needle search evidence',
					score: 0.8,
				})),
			});
		expect(String(target)).toBe('https://api.tavily.com/extract');
		return Response.json({
			results: body.urls.map((url: string) => ({
				url,
				raw_content: `# Report\nneedle evidence from ${url}`,
			})),
			failed_results: [],
		});
	});
};
beforeEach(() => {
	directory = mkdtempSync(join(tmpdir(), 'retriever-workflow-'));
	vi.stubEnv('RETRIEVER_RESULT_DIR', directory);
	for (const item of settings) item.api_key = undefined;
	config.search.tavily.api_key = 'workflow-fixture-key';
	config.processing.tavily_extract.api_key = 'workflow-fixture-key';
	vi.stubGlobal('fetch', fetch_mock);
	fetch_mock.mockReset();
	vi.spyOn(console, 'error').mockImplementation(() => {});
	vi.spyOn(console, 'warn').mockImplementation(() => {});
	server = create_server({ name: 'workflow-offline', version: '1' });
});
afterEach(() => {
	settings.forEach((item, i) => {
		item.api_key = keys[i];
	});
	vi.unstubAllGlobals();
	vi.unstubAllEnvs();
	vi.restoreAllMocks();
	rmSync(directory, { recursive: true, force: true });
});

it.each(['tavily', 'brave', 'exa', 'you'] as const)(
	'dispatches %s search through its existing adapter without fallback',
	async (provider) => {
		config.search[provider].api_key = 'workflow-fixture-key';
		server = create_server({
			name: 'workflow-offline',
			version: '1',
		});
		const calls: Array<{ host: string; path: string }> = [];
		fetch_mock.mockImplementation(async (target, _options) => {
			const url = new URL(String(target));
			calls.push({ host: url.hostname, path: url.pathname });
			if (url.pathname.endsWith('/extract'))
				return Response.json({
					results: [{ url: first, raw_content: 'page evidence' }],
					failed_results: [],
				});
			const hit = {
				url: first,
				title: 'fixture',
				content: 'search evidence',
				text: 'search evidence',
				description: 'search evidence',
				score: 0.8,
			};
			if (provider === 'brave')
				return Response.json({ web: { results: [hit] } });
			if (provider === 'you')
				return Response.json({ results: { web: [hit] } });
			return Response.json({
				results: [hit],
				requestId: 'fixture-id',
				costDollars: { total: 0.001 },
			});
		});
		const result = parsed(
			await call('search_and_read', {
				...args,
				search_provider: provider,
				max_sources: 1,
			}),
		);
		expect(result.sources[0]).toMatchObject({
			status: 'ok',
			content: 'page evidence',
			search_provider: provider,
		});
		expect(calls).toHaveLength(2);
		expect(calls[0].host).toBe(
			new URL(config.search[provider].base_url).hostname,
		);
		expect(calls[1].path).toBe('/extract');
	},
);

it.each(['exa', 'firecrawl'] as const)(
	'uses only the simple %s read operation without synthesis',
	async (provider) => {
		config.processing[
			provider === 'exa' ? 'exa_contents' : 'firecrawl_scrape'
		].api_key = 'workflow-fixture-key';
		server = create_server({
			name: 'workflow-offline',
			version: '1',
		});
		respond([first]);
		const ordinary = fetch_mock.getMockImplementation()!;
		fetch_mock.mockImplementation(async (target, options) => {
			const path = new URL(String(target)).pathname;
			if (path.endsWith('/search')) return ordinary(target, options);
			const body = JSON.parse(options.body);
			if (provider === 'exa') {
				expect(path).toBe('/contents');
				expect(body).toMatchObject({
					urls: [first],
					text: true,
					highlights: false,
					summary: false,
				});
				return Response.json({
					results: [{ url: first, text: 'read evidence' }],
					costDollars: { total: 0.002 },
				});
			}
			expect(path).toBe('/v2/scrape');
			expect(body.formats).toEqual(['markdown']);
			return Response.json({
				success: true,
				data: { markdown: 'read evidence' },
			});
		});
		const result = parsed(
			await call('search_and_read', {
				...args,
				extract_provider: provider,
				max_sources: 1,
			}),
		);
		expect(result.sources[0]).toMatchObject({
			status: 'ok',
			extract_provider: provider,
		});
		expect(result.sources[0].content).toContain('read evidence');
		expect(result.metadata.http_requests).toBe(2);
	},
);

it('selects query passages with offsets into retained canonical content', async () => {
	respond([first]);
	const ordinary = fetch_mock.getMockImplementation()!;
	const text =
		'# Background\n' +
		'ordinary background text.\n'.repeat(600) +
		'\n# Findings\nneedle citation [1].\n';
	fetch_mock.mockImplementation(async (target, options) =>
		String(target).endsWith('/extract')
			? Response.json({
					results: [{ url: first, raw_content: text }],
					failed_results: [],
				})
			: ordinary(target, options),
	);
	const response = await call('search_and_read', {
		...args,
		output_budget_bytes: 4096,
	});
	const data = parsed(response);
	expect(data.presentation).toBe('selected');
	expect(
		data.sources[0].passages.some((p: any) =>
			p.text.includes('needle citation'),
		),
	).toBe(true);
	for (const p of data.sources[0].passages)
		expect(p.text).toBe(text.slice(p.start, p.end));
	expect(
		Buffer.byteLength(JSON.stringify(response.result)),
	).toBeLessThanOrEqual(4096);
	expect(response.result.structuredContent.data).toEqual(data);
});

it('fails closed when canonical evidence cannot be retained', async () => {
	vi.stubEnv('RETRIEVER_RESULT_MAX_BYTES', '1');
	vi.stubEnv('RETRIEVER_RESULT_STORE_MAX_BYTES', '1');
	respond([first]);
	const ordinary = fetch_mock.getMockImplementation()!;
	fetch_mock.mockImplementation(async (target, options) =>
		String(target).endsWith('/extract')
			? Response.json({
					results: [
						{
							url: first,
							raw_content: 'PRIVATE_FULL_EVIDENCE'.repeat(1000),
						},
					],
					failed_results: [],
				})
			: ordinary(target, options),
	);
	const response = await call('search_and_read', {
		...args,
		output_budget_bytes: 2048,
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
	expect(JSON.stringify(response)).not.toContain('result_id');
	expect(
		Buffer.byteLength(JSON.stringify(response.result)),
	).toBeLessThanOrEqual(2048);
});

it('compares bundled, per-source and batch primitives on the same offline evidence', async () => {
	respond([first, second]);
	const bundle = await call('search_and_read');
	const bundle_requests = fetch_mock.mock.calls.length;
	fetch_mock.mockClear();
	const search = await call('web_search', {
		provider: 'tavily',
		query: args.query,
		limit: 5,
	});
	const single_reads = [];
	for (const hit of parsed(search))
		single_reads.push(
			await call('web_extract', { provider: 'tavily', url: hit.url }),
		);
	const primitive_requests = fetch_mock.mock.calls.length;
	fetch_mock.mockClear();
	const batch_search = await call('web_search', {
		provider: 'tavily',
		query: args.query,
		limit: 5,
	});
	const batch_read = await call('web_extract', {
		provider: 'tavily',
		url: parsed(batch_search).map((h: any) => h.url),
	});
	const batch_requests = fetch_mock.mock.calls.length;
	expect(parsed(bundle).sources.map((s: any) => s.content)).toEqual(
		single_reads.map((r) => parsed(r).content),
	);
	expect(parsed(bundle).sources.map((s: any) => s.content)).toEqual(
		parsed(batch_read).raw_contents.map((r: any) => r.content),
	);
	expect([
		bundle_requests,
		primitive_requests,
		batch_requests,
	]).toEqual([3, 3, 2]);
	const bytes = (r: any) =>
		Buffer.byteLength(JSON.stringify(r.result));
	console.log(
		'OFFLINE_WORKFLOW_COMPARISON',
		JSON.stringify({
			fixture:
				'two short sources, no failures, no model or live provider',
			bundled: {
				mcp_calls: 1,
				provider_http_requests: bundle_requests,
				result_bytes: bytes(bundle),
			},
			per_source_primitives: {
				mcp_calls: 3,
				provider_http_requests: primitive_requests,
				result_bytes:
					bytes(search) +
					single_reads.reduce((sum, r) => sum + bytes(r), 0),
			},
			batched_primitives: {
				mcp_calls: 2,
				provider_http_requests: batch_requests,
				result_bytes: bytes(batch_search) + bytes(batch_read),
			},
			evidence_equal: true,
		}),
	);
});

it('reports budget exhaustion during an adapter retry and stops later reads', async () => {
	respond([first, second]);
	const ordinary = fetch_mock.getMockImplementation()!;
	fetch_mock.mockImplementation(async (target, options) => {
		if (String(target).endsWith('/extract'))
			return Response.json({}, { status: 503 });
		return ordinary(target, options);
	});
	const result = parsed(
		await call('search_and_read', { ...args, max_requests: 2 }),
	);
	expect(result.sources[0]).toMatchObject({
		status: 'error',
		error: { kind: 'request_budget', retryable: false },
	});
	expect(result.sources[1]).toMatchObject({
		status: 'skipped',
		error: { kind: 'request_budget' },
	});
	expect(result.metadata.http_requests).toBe(2);
	expect(fetch_mock).toHaveBeenCalledTimes(2);
	const { get_provider_health_snapshot } =
		await import('../provider_health.js');
	expect(
		get_provider_health_snapshot().processing.tavily.active_error,
	).not.toBe(true);
});

it('does not advertise an extraction provider that only has a non-read mode', async () => {
	config.processing.exa_similar.api_key = 'workflow-fixture-key';
	config.processing.exa_contents.api_key = undefined;
	server = create_server({ name: 'workflow-offline', version: '1' });
	const response: any = await server.receive({
		jsonrpc: '2.0',
		id: ++sequence,
		method: 'tools/list',
		params: {},
	});
	const workflow = response.result.tools.find(
		(t: any) => t.name === 'search_and_read',
	);
	expect(
		workflow.inputSchema.properties.extract_provider.enum,
	).toEqual(['tavily']);
});

it('reports intentional source-limit omissions without claiming all hits were read', async () => {
	respond([first, first, second, 'https://example.test/third']);
	const data = parsed(
		await call('search_and_read', { ...args, max_sources: 1 }),
	);
	expect(data.sources).toHaveLength(1);
	expect(data.metadata).toMatchObject({
		considered_hits: 4,
		duplicates_removed: 1,
		sources_omitted: 2,
		complete: true,
	});
	expect(fetch_mock).toHaveBeenCalledTimes(2);
});

it('exposes typed per-source errors and evidence passages in discovery', async () => {
	const response: any = await server.receive({
		jsonrpc: '2.0',
		id: ++sequence,
		method: 'tools/list',
		params: {},
	});
	const schema = response.result.tools.find(
		(t: any) => t.name === 'search_and_read',
	).outputSchema;
	const branches = schema.properties.data.oneOf;
	const selected = branches.find(
		(b: any) => b.properties.presentation.const === 'selected',
	);
	expect(selected.properties.sources.items.properties).toMatchObject({
		error: {
			type: 'object',
			properties: {
				kind: expect.any(Object),
				retryable: { type: 'boolean' },
			},
		},
		passages: {
			type: 'array',
			items: {
				properties: {
					start: { type: 'number' },
					end: { type: 'number' },
					text: { type: 'string' },
				},
			},
		},
	});
});

it('bounds structured plus text output and retains exact full evidence for pagination', async () => {
	respond([first]);
	const ordinary = fetch_mock.getMockImplementation()!;
	const text =
		'# Intro\n' +
		'漢字😀 background.\n'.repeat(500) +
		'\n# Findings\nneedle exact evidence [1].\n';
	fetch_mock.mockImplementation(async (target, options) => {
		if (String(target).endsWith('/extract'))
			return Response.json({
				results: [{ url: first, raw_content: text }],
				failed_results: [],
			});
		return ordinary(target, options);
	});
	const response = await call('search_and_read', {
		...args,
		output_budget_bytes: 2048,
	});
	expect(
		Buffer.byteLength(JSON.stringify(response.result)),
	).toBeLessThanOrEqual(2048);
	const compact = parsed(response);
	expect(response.result.structuredContent).toEqual({
		ok: true,
		data: compact,
	});
	expect(compact.result_id).toEqual(expect.any(String));
	let offset = 1,
		byte_offset = 0,
		recovered = '';
	for (let count = 0; count < 100; count++) {
		const page = parsed(
			await call('result_read', {
				result_id: compact.result_id,
				offset,
				byte_offset,
				limit: 500,
			}),
		);
		recovered += page.content;
		if (page.next_offset === undefined) break;
		if (page.next_byte_offset === undefined) recovered += '\n';
		offset = page.next_offset;
		byte_offset = page.next_byte_offset ?? 0;
	}
	const canonical = JSON.parse(recovered);
	expect(canonical.sources[0].content).toBe(text);
	expect(canonical.metadata.complete).toBe(true);
	expect(fetch_mock).toHaveBeenCalledTimes(2);
});

it('retains partial provider evidence while marking that source incomplete', async () => {
	respond([first]);
	const ordinary = fetch_mock.getMockImplementation()!;
	fetch_mock.mockImplementation(async (target, options) => {
		if (String(target).endsWith('/extract'))
			return Response.json({
				results: [{ url: first, raw_content: 'Partial evidence' }],
				failed_results: [
					{ url: first, error: 'unavailable section' },
				],
			});
		return ordinary(target, options);
	});
	const result = parsed(await call('search_and_read'));
	expect(result.sources[0]).toMatchObject({
		status: 'error',
		content: 'Partial evidence',
		error: { kind: 'upstream_failure' },
	});
	expect(result.metadata.complete).toBe(false);
});

it('returns completed evidence on deadline and does not start further reads', async () => {
	respond([first, second, 'https://example.test/third']);
	const ordinary = fetch_mock.getMockImplementation()!;
	fetch_mock.mockImplementation(async (target, options) => {
		if (
			String(target).endsWith('/extract') &&
			JSON.parse(options.body).urls.includes(second)
		)
			return new Promise((_resolve, reject) =>
				options.signal.addEventListener(
					'abort',
					() => reject(options.signal.reason),
					{ once: true },
				),
			);
		return ordinary(target, options);
	});
	const result = parsed(
		await call('search_and_read', { ...args, timeout_ms: 100 }),
	);
	// Reads run in parallel: the third source completes while the second
	// is still hanging, so only the hung read reports the deadline.
	expect(result.sources.map((s: any) => s.status)).toEqual([
		'ok',
		'error',
		'ok',
	]);
	expect(result.sources[1].error.kind).toBe('timeout');
	expect(result.metadata.complete).toBe(false);
	expect(fetch_mock).toHaveBeenCalledTimes(4);
});

it('skips reads still queued at the deadline instead of starting them', async () => {
	const urls = Array.from(
		{ length: 5 },
		(_, i) => `https://example.test/page-${i}`,
	);
	respond(urls);
	const ordinary = fetch_mock.getMockImplementation()!;
	fetch_mock.mockImplementation(async (target, options) => {
		if (String(target).endsWith('/extract'))
			return new Promise((_resolve, reject) =>
				options.signal.addEventListener(
					'abort',
					() => reject(options.signal.reason),
					{ once: true },
				),
			);
		return ordinary(target, options);
	});
	const result = parsed(
		await call('search_and_read', {
			...args,
			max_sources: 5,
			search_limit: 5,
			timeout_ms: 100,
		}),
	);
	// Four reads start together (the concurrency bound); the fifth is
	// still queued when the deadline hits and is never sent.
	expect(result.sources.map((s: any) => s.status)).toEqual([
		'error',
		'error',
		'error',
		'error',
		'skipped',
	]);
	expect(result.sources.map((s: any) => s.error.kind)).toEqual(
		Array(5).fill('timeout'),
	);
	expect(fetch_mock).toHaveBeenCalledTimes(5);
});

it('reads independent sources concurrently in ranked order', async () => {
	const third = 'https://example.test/third';
	respond([first, second, third]);
	const ordinary = fetch_mock.getMockImplementation()!;
	const started: string[] = [];
	const release: Array<() => void> = [];
	fetch_mock.mockImplementation(async (target, options) => {
		if (!String(target).endsWith('/extract'))
			return ordinary(target, options);
		const url = JSON.parse(options.body).urls[0];
		started.push(url);
		await new Promise<void>((resolve) => release.push(resolve));
		return ordinary(target, options);
	});
	const pending = call('search_and_read', {
		...args,
		max_sources: 3,
	});
	await vi.waitFor(() => expect(started).toHaveLength(3));
	// All three reads were issued before any of them completed.
	expect(started).toEqual([first, second, third]);
	// Finish out of order; the result keeps the ranked order.
	release[2]();
	release[0]();
	release[1]();
	const result = parsed(await pending);
	expect(result.sources.map((s: any) => s.url)).toEqual([
		first,
		second,
		third,
	]);
	expect(result.sources.map((s: any) => s.status)).toEqual([
		'ok',
		'ok',
		'ok',
	]);
	expect(result.metadata).toMatchObject({
		http_requests: 4,
		complete: true,
	});
});

it('lets in-flight reads reserve the request budget before starting more', async () => {
	// Budget 3: one search plus two reads. The third source must be
	// skipped as request_budget, not started optimistically.
	const third = 'https://example.test/third';
	respond([first, second, third]);
	const result = parsed(
		await call('search_and_read', {
			...args,
			max_sources: 3,
			max_requests: 3,
		}),
	);
	expect(result.sources.map((s: any) => s.status)).toEqual([
		'ok',
		'ok',
		'skipped',
	]);
	expect(result.sources[2].error.kind).toBe('request_budget');
	expect(result.metadata.http_requests).toBe(3);
	expect(fetch_mock).toHaveBeenCalledTimes(3);
});

it('honors caller cancellation before any provider request', async () => {
	respond();
	const controller = new AbortController();
	controller.abort();
	const response = await call(
		'search_and_read',
		args,
		controller.signal,
	);
	expect(response.result.isError).toBe(true);
	expect(fetch_mock).not.toHaveBeenCalled();
});

it.each([
	{ max_sources: 0 },
	{ max_sources: 6 },
	{ max_requests: 1 },
	{ max_requests: 21 },
	{ max_requests: 2.1 },
	{ timeout_ms: 99 },
	{ timeout_ms: 60001 },
	{ output_budget_bytes: 2047 },
	{ output_budget_bytes: 80001 },
	{ search_limit: 2, max_sources: 3 },
	{ query: '  ' },
	{ search_provider: 'missing' },
	{ extract_provider: 'missing' },
	{ mode: 'crawl' },
	{ max_sources: null },
])(
	'rejects invalid or unsupported controls before networking: %j',
	async (invalid) => {
		respond();
		const response = await call('search_and_read', {
			...args,
			...invalid,
		});
		expect(
			response.result?.isError === true ||
				response.error !== undefined,
		).toBe(true);
		expect(fetch_mock).not.toHaveBeenCalled();
	},
);

it('returns no sources without making extraction calls for empty search results', async () => {
	respond([]);
	const result = parsed(await call('search_and_read'));
	expect(result.sources).toEqual([]);
	expect(result.metadata.http_requests).toBe(1);
	expect(fetch_mock).toHaveBeenCalledTimes(1);
});

it('treats an empty provider extraction as a failed source, not complete evidence', async () => {
	respond([first]);
	const ordinary = fetch_mock.getMockImplementation()!;
	fetch_mock.mockImplementation(async (target, options) => {
		if (String(target).endsWith('/extract'))
			return Response.json({
				results: [{ url: first, raw_content: '' }],
				failed_results: [],
			});
		return ordinary(target, options);
	});
	const result = parsed(await call('search_and_read'));
	expect(result.sources[0]).toMatchObject({
		status: 'error',
		error: { kind: 'upstream_failure' },
	});
	expect(result.metadata.complete).toBe(false);
});

it('keeps successful evidence and records a failed page without fallback', async () => {
	respond([first, second]);
	const ordinary = fetch_mock.getMockImplementation()!;
	fetch_mock.mockImplementation(async (target, options) => {
		if (
			String(target).endsWith('/extract') &&
			JSON.parse(options.body).urls.includes(second)
		)
			return Response.json(
				{ error: 'PRIVATE_PROVIDER_CANARY' },
				{ status: 403 },
			);
		return ordinary(target, options);
	});
	const result = parsed(await call('search_and_read'));
	expect(result.sources[0].status).toBe('ok');
	expect(result.sources[1]).toMatchObject({
		status: 'error',
		error: { kind: 'entitlement', retryable: false },
	});
	expect(result.metadata.complete).toBe(false);
	expect(JSON.stringify(result)).not.toContain(
		'PRIVATE_PROVIDER_CANARY',
	);
	expect(fetch_mock).toHaveBeenCalledTimes(3);
});

it('stops before its request cap and reports unread sources explicitly', async () => {
	respond([first, second]);
	const result = parsed(
		await call('search_and_read', { ...args, max_requests: 2 }),
	);
	expect(result.metadata).toMatchObject({
		http_requests: 2,
		complete: false,
	});
	expect(result.sources[1]).toMatchObject({
		status: 'skipped',
		error: { kind: 'request_budget' },
	});
	expect(fetch_mock).toHaveBeenCalledTimes(2);
});

it('rejects unsafe URLs without leaking credentials or fetching them', async () => {
	respond([
		'https://user:PRIVATE_URL_PASSWORD@127.0.0.1/secret',
		first,
	]);
	const result = parsed(await call('search_and_read'));
	expect(result.sources[0]).toMatchObject({
		status: 'error',
		error: { kind: 'bad_input' },
	});
	expect(result.sources[0]).not.toHaveProperty('url');
	expect(JSON.stringify(result)).not.toContain(
		'PRIVATE_URL_PASSWORD',
	);
	expect(fetch_mock).toHaveBeenCalledTimes(2);
});

it('searches once, deduplicates URLs and returns source-linked evidence without synthesis', async () => {
	respond();
	const response = await call('search_and_read');
	expect(response.error).toBeUndefined();
	expect(response.result.isError).not.toBe(true);
	const result = parsed(response);
	expect(result.sources.map((source: any) => source.url)).toEqual([
		first,
		second,
	]);
	expect(result.sources.map((source: any) => source.status)).toEqual([
		'ok',
		'ok',
	]);
	expect(result.sources[0].content).toContain('needle evidence');
	// The page text appears once; `extraction` carries provider metadata
	// only, so canonical results are not inflated with copies.
	expect(result.sources[0].extraction).toMatchObject({
		source_provider: 'tavily_extract',
		metadata: { successful_extractions: 1 },
	});
	expect(result.sources[0].extraction).not.toHaveProperty('content');
	expect(result.sources[0].extraction).not.toHaveProperty(
		'raw_contents',
	);
	expect(result.metadata).toMatchObject({
		search_provider: 'tavily',
		extract_provider: 'tavily',
		http_requests: 3,
		duplicates_removed: 1,
		complete: true,
	});
	expect(fetch_mock).toHaveBeenCalledTimes(3);
});
