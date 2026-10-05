import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { config } from '../../config/env.js';
import { create_server } from '../create_server.js';

const url = 'https://example.test/report?edition=2';
// Selection must fit provenance plus both text and structured copies.
// These fixtures still exceed this cap, so they exercise selection, not full.
const selection_budget = 4096;
const settings = Object.values(config).flatMap(Object.values);
const keys = settings.map((item) => item.api_key);
let server: ReturnType<typeof create_server>;
let directory: string;
let sequence = 0;
const fetch_mock = vi.fn();
const call = async (name: string, args: Record<string, unknown>) => {
	const response: any = await server.receive({
		jsonrpc: '2.0',
		id: ++sequence,
		method: 'tools/call',
		params: { name, arguments: args },
	});
	if (
		name !== 'result_read' &&
		response.result?.isError !== true &&
		!response.error
	)
		expect(
			JSON.parse(JSON.stringify(response.result.structuredContent)),
		).toStrictEqual({
			ok: true,
			data: JSON.parse(response.result.content[0].text),
		});
	return response;
};
const parsed = (response: any) =>
	JSON.parse(response.result.content[0].text);
const respond = (text: string) => {
	fetch_mock.mockImplementation(async (target, options) => {
		expect(String(target)).toBe('https://api.tavily.com/extract');
		expect(options.method).toBe('POST');
		return new Response(
			JSON.stringify({
				results: [{ url, raw_content: text }],
				failed_results: [],
				response_time: 0.25,
			}),
			{ headers: { 'content-type': 'application/json' } },
		);
	});
};
beforeEach(() => {
	directory = mkdtempSync(join(tmpdir(), 'retriever-p1b-tools-'));
	vi.stubEnv('RETRIEVER_RESULT_DIR', directory);
	for (const item of settings) item.api_key = undefined;
	config.search.tavily.api_key = 'p1b-fixture-key';
	config.processing.tavily_extract.api_key = 'p1b-fixture-key';
	vi.stubGlobal('fetch', fetch_mock);
	fetch_mock.mockReset();
	vi.spyOn(console, 'error').mockImplementation(() => {});
	vi.spyOn(console, 'warn').mockImplementation(() => {});
	server = create_server({
		name: 'p1b-offline-fixture',
		version: '1',
	});
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

const reconstruct = async (id: string) => {
	let offset = 1;
	let byte_offset = 0;
	let output = '';
	for (let pages = 1; pages <= 500; pages++) {
		const response = await call('result_read', {
			result_id: id,
			offset,
			byte_offset,
			limit: 500,
		});
		expect(response.result.isError).not.toBe(true);
		const chunk = parsed(response);
		output += chunk.content;
		if (chunk.next_offset === undefined) {
			const marker = '\nFULL RESULT JSON\n';
			const start = output.lastIndexOf(marker);
			return {
				canonical: JSON.parse(
					start < 0 ? output : output.slice(start + marker.length),
				),
				pages,
			};
		}
		if (chunk.next_byte_offset === undefined) output += '\n';
		offset = chunk.next_offset;
		byte_offset = chunk.next_byte_offset ?? 0;
	}
	throw new Error('Reconstruction exceeded page bound');
};

it('retains canonical full evidence under a small UTF-8 tool-result budget', async () => {
	const text = '漢字😀 [1] "\\n evidence\n'.repeat(500);
	respond(text);
	const legacy = parsed(
		await call('web_extract', { provider: 'tavily', url }),
	);
	const response = await call('web_extract', {
		provider: 'tavily',
		url,
		response_mode: 'full',
		output_budget_bytes: 2048,
	});
	expect(
		Buffer.byteLength(JSON.stringify(response.result)),
	).toBeLessThanOrEqual(2048);
	const full = parsed(response);
	expect(full.result_id).toEqual(expect.any(String));
	expect(full.metadata.local_completeness).toBe('retained');
	const { canonical, pages } = await reconstruct(full.result_id);
	const { content: _content, ...expected } = legacy;
	expect(canonical.result).toEqual(expected);
	expect(canonical.result.raw_contents[0].content).toBe(text);
	expect(canonical.metadata.local_completeness).toBe('complete');
	expect(pages).toBeGreaterThan(1);
	expect(readdirSync(directory)).toHaveLength(1);
});

it('selects relevant compact evidence and retains below-threshold canonical content', async () => {
	const text =
		'# Intro\n' +
		'Background filler.\n'.repeat(100) +
		'\n# Findings\nNeedle evidence [2] at https://example.test/cite?a=1.\n' +
		'Later filler.\n'.repeat(100);
	respond(text);
	const response = await call('web_extract', {
		provider: 'tavily',
		url,
		response_mode: 'compact',
		output_budget_bytes: selection_budget,
		query: 'Needle',
	});
	const compact = parsed(response);
	expect(compact.response_mode).toBe('compact');
	expect(
		Buffer.byteLength(JSON.stringify(response.result)),
	).toBeLessThanOrEqual(selection_budget);
	expect(compact.sources[0].url).toBe(url);
	expect(compact.sources[0].selection_method).toBe('query');
	expect(
		compact.sources[0].passages.some((p: any) =>
			p.text.includes('Needle evidence [2]'),
		),
	).toBe(true);
	for (const passage of compact.sources[0].passages)
		expect(passage.text).toBe(text.slice(passage.start, passage.end));
	expect(compact.metadata.local_completeness).toBe('selected');
	const recovered = await reconstruct(compact.result_id);
	expect(recovered.canonical.result.raw_contents[0].content).toBe(
		text,
	);
	expect(recovered.canonical.result).not.toHaveProperty('content');
	expect(readdirSync(directory)).toHaveLength(1);
	expect(fetch_mock).toHaveBeenCalledTimes(1);
});

it('returns recoverable compact retention when both copies cannot fit selection at 2048 bytes', async () => {
	const text = 'Needle evidence [2].\n'.repeat(500);
	respond(text);
	const response = await call('web_extract', {
		provider: 'tavily',
		url,
		response_mode: 'compact',
		output_budget_bytes: 2048,
		query: 'Needle',
	});
	expect(response.result.isError).not.toBe(true);
	expect(
		Buffer.byteLength(JSON.stringify(response.result)),
	).toBeLessThanOrEqual(2048);
	const retained = parsed(response);
	expect(retained.response_mode).toBe('compact');
	expect(retained.metadata.local_completeness).toBe('retained');
	expect(retained).not.toHaveProperty('sources');
	const { canonical } = await reconstruct(retained.result_id);
	expect(canonical.result.raw_contents).toEqual([
		{ url, content: text },
	]);
	expect(canonical.metadata.local_completeness).toBe('complete');
	expect(readdirSync(directory)).toHaveLength(1);
	expect(fetch_mock).toHaveBeenCalledTimes(1);
});

it.each([
	{ output_budget_bytes: 2048 },
	{ response_mode: 'legacy', output_budget_bytes: 2048 },
	{ response_mode: 'compact', output_budget_bytes: 2047 },
	{ response_mode: 'full', output_budget_bytes: 80001 },
	{ response_mode: 'compact', output_budget_bytes: 2048.5 },
	{ response_mode: 'compact', output_budget_bytes: null },
	{ response_mode: 'invalid' },
])(
	'rejects invalid presentation controls before networking: %j',
	async (controls) => {
		respond('Fixture');
		const response = await call('web_extract', {
			provider: 'tavily',
			url,
			...controls,
		});
		expect(
			response.error !== undefined ||
				response.result?.isError === true,
		).toBe(true);
		expect(fetch_mock).not.toHaveBeenCalled();
		expect(readdirSync(directory)).toEqual([]);
	},
);

it('reports bounded retention failure without returning a false handle', async () => {
	vi.stubEnv('RETRIEVER_RESULT_MAX_BYTES', '1');
	vi.stubEnv('RETRIEVER_RESULT_STORE_MAX_BYTES', '1');
	respond('Private canonical evidence.\n'.repeat(1000));
	const response = await call('web_extract', {
		provider: 'tavily',
		url,
		response_mode: 'compact',
		output_budget_bytes: 2048,
	});
	expect(response.result.isError).toBe(true);
	expect(response.result.content[0].text).toContain(
		'Cannot retain complete canonical result',
	);
	expect(JSON.stringify(response)).not.toContain(
		'Private canonical evidence',
	);
	expect(JSON.stringify(response)).not.toContain('result_id');
	expect(
		Buffer.byteLength(JSON.stringify(response.result)),
	).toBeLessThanOrEqual(2048);
	expect(readdirSync(directory)).toEqual([]);
});

it.each(['web_search', 'web_extract'])(
	'exposes reported request metadata once in %s opt-in output',
	async (name) => {
		fetch_mock.mockImplementation(
			async () =>
				new Response(
					JSON.stringify({
						results: [
							{
								url,
								title: 'Fixture',
								content: 'Evidence',
								raw_content: 'Evidence',
								score: 0.5,
							},
						],
						failed_results: [],
						request_id: 'fixture-request-123',
						response_time: 0.25,
						usage: { credits: 0 },
						private_field: 'P1B_PRIVATE_CANARY',
					}),
					{ headers: { 'content-type': 'application/json' } },
				),
		);
		const args =
			name === 'web_search'
				? { provider: 'tavily', query: 'evidence' }
				: { provider: 'tavily', url };
		const response = await call(name, {
			...args,
			response_mode: 'full',
		});
		const full = parsed(response);
		expect(full.metadata).toMatchObject({
			request_id: 'fixture-request-123',
			response_time_seconds: 0.25,
			usage: { credits: 0 },
			usage_source: 'provider_reported',
		});
		expect(
			JSON.stringify(full).match(/fixture-request-123/g),
		).toHaveLength(1);
		expect(JSON.stringify(full.result)).not.toContain(
			'response_time',
		);
		expect(JSON.stringify(full)).not.toContain('P1B_PRIVATE_CANARY');
		const legacy = parsed(await call(name, args));
		expect(JSON.stringify(legacy)).not.toContain(
			'fixture-request-123',
		);
	},
);

it.each(['tavily', 'exa', 'brave', 'you'])(
	'keeps compact search provider %s explicit and reconstructs its canonical result',
	async (provider) => {
		const text = 'Evidence needle [1].\n'.repeat(1500);
		for (const name of ['tavily', 'exa', 'brave', 'you'] as const)
			config.search[name].api_key = 'p1b-fixture-key';
		server = create_server({
			name: 'p1b-search-fixture',
			version: '1',
		});
		fetch_mock.mockImplementation(async (target, init) => {
			const destination = new URL(String(target));
			expect(destination.hostname).toBe(
				{
					tavily: 'api.tavily.com',
					exa: 'api.exa.ai',
					brave: 'api.search.brave.com',
					you: 'api.you.com',
				}[provider],
			);
			const body =
				provider === 'tavily'
					? {
							results: [
								{ title: 'Fixture', url, content: text, score: 0.8 },
							],
						}
					: provider === 'exa'
						? {
								results: [
									{ title: 'Fixture', url, text, score: 0.8 },
								],
							}
						: provider === 'brave'
							? {
									web: {
										results: [
											{ title: 'Fixture', url, description: text },
										],
									},
								}
							: {
									results: {
										web: [
											{ title: 'Fixture', url, snippets: [text] },
										],
									},
								};
			if (init.body)
				expect(JSON.parse(init.body)).not.toHaveProperty(
					'response_mode',
				);
			return new Response(JSON.stringify(body), {
				headers: { 'content-type': 'application/json' },
			});
		});
		const legacy = parsed(
			await call('web_search', { provider, query: 'needle' }),
		);
		const response = await call('web_search', {
			provider,
			query: 'needle',
			response_mode: 'compact',
			output_budget_bytes: selection_budget,
		});
		expect(response.result.isError).not.toBe(true);
		expect(
			Buffer.byteLength(JSON.stringify(response.result)),
		).toBeLessThanOrEqual(selection_budget);
		const compact = parsed(response);
		expect(compact.metadata.local_completeness).toBe('selected');
		expect(compact.metadata.provider).toBe(provider);
		expect(compact.sources[0].url).toBe(url);
		expect(
			(await reconstruct(compact.result_id)).canonical.result,
		).toEqual(legacy);
		expect(fetch_mock).toHaveBeenCalledTimes(2);
	},
);

it.each(['firecrawl', 'exa'])(
	'retains %s extraction evidence without changing upstream defaults',
	async (provider) => {
		const text = 'Needle citation [3].\n'.repeat(1000);
		config.processing.firecrawl_scrape.api_key = 'p1b-fixture-key';
		config.processing.exa_contents.api_key = 'p1b-fixture-key';
		server = create_server({
			name: 'p1b-extract-fixture',
			version: '1',
		});
		fetch_mock.mockImplementation(async (target, init) => {
			expect(new URL(String(target)).hostname).toBe(
				provider === 'firecrawl' ? 'api.firecrawl.dev' : 'api.exa.ai',
			);
			const body = JSON.parse(init.body);
			expect(body).not.toHaveProperty('output_budget_bytes');
			expect(body).not.toHaveProperty('response_mode');
			return new Response(
				JSON.stringify(
					provider === 'firecrawl'
						? {
								success: true,
								data: {
									markdown: text,
									metadata: { title: 'Fixture' },
								},
							}
						: { results: [{ url, title: 'Fixture', text }] },
				),
				{ headers: { 'content-type': 'application/json' } },
			);
		});
		const legacy_response = await call('web_extract', {
			provider,
			url,
		});
		const legacy_handle = parsed(legacy_response);
		expect(legacy_handle.result_id).toEqual(expect.any(String));
		expect(
			Buffer.byteLength(JSON.stringify(legacy_response.result)),
		).toBeLessThanOrEqual(80000);
		const legacy = (await reconstruct(legacy_handle.result_id))
			.canonical;
		const text_only = {
			content: [
				{ type: 'text', text: JSON.stringify(legacy, null, 2) },
			],
		};
		// The old text-only result fit; only the additive copy causes offload.
		expect(
			Buffer.byteLength(JSON.stringify(text_only)),
		).toBeLessThanOrEqual(80000);
		expect(
			Buffer.byteLength(
				JSON.stringify({
					...text_only,
					structuredContent: { ok: true, data: legacy },
				}),
			),
		).toBeGreaterThan(80000);
		const response = await call('web_extract', {
			provider,
			url,
			response_mode: 'compact',
			output_budget_bytes: 2048,
			query: 'Needle',
		});
		expect(response.result.isError).not.toBe(true);
		const compact = parsed(response);
		expect(compact.metadata.local_completeness).toBe('retained');
		expect(
			Buffer.byteLength(JSON.stringify(response.result)),
		).toBeLessThanOrEqual(2048);
		const canonical = (await reconstruct(compact.result_id))
			.canonical;
		if (
			legacy.raw_contents &&
			legacy.content ===
				legacy.raw_contents.map((x: any) => x.content).join('\n\n')
		)
			delete legacy.content;
		expect(canonical.result).toEqual(legacy);
		expect(compact.metadata.provider).toBe(provider);
		expect(readdirSync(directory)).toHaveLength(2);
		expect(fetch_mock).toHaveBeenCalledTimes(2);
	},
);

it.each([
	{
		name: 'long-report',
		text:
			'# Overview\n' +
			'Background detail.\n'.repeat(500) +
			'\n# Finding\nNeedle citation [7].\n' +
			'Appendix detail.\n'.repeat(200),
		query: 'Needle',
		anchor: 'Needle citation [7]',
	},
	{
		name: 'cjk',
		text:
			'背景資料。\n'.repeat(500) +
			'\n精密校準證據 [7]。\n' +
			'附錄資料。\n'.repeat(200),
		query: '校準',
		anchor: '校準證據 [7]',
	},
	{
		name: 'code',
		text:
			'Background.\n'.repeat(500) +
			'\n```ts\nconst needle = "citation [7]";\n```\n' +
			'Appendix.\n'.repeat(100),
		query: 'needle',
		anchor: 'const needle',
	},
	{
		name: 'no-hit',
		text: 'Leading evidence [7].\n' + 'Background.\n'.repeat(800),
		query: 'absent',
		anchor: 'Leading evidence [7]',
	},
])(
	'measures fixture evidence, payload bytes and reconstruction reads: $name',
	async ({ name, text, query, anchor }) => {
		respond(text);
		const legacy_started = performance.now();
		const legacy = await call('web_extract', {
			provider: 'tavily',
			url,
			query,
		});
		const legacy_ms = performance.now() - legacy_started;
		const compact_started = performance.now();
		const compact_response = await call('web_extract', {
			provider: 'tavily',
			url,
			query,
			response_mode: 'compact',
			output_budget_bytes: selection_budget,
		});
		const compact_ms = performance.now() - compact_started;
		const compact = parsed(compact_response);
		expect(compact.metadata.local_completeness).toBe('selected');
		const { canonical, pages } = await reconstruct(compact.result_id);
		expect(canonical.result.raw_contents[0].content).toBe(text);
		const selected = compact.sources
			.flatMap((source: any) =>
				source.passages.map((passage: any) => passage.text),
			)
			.join('\n');
		expect(selected).toContain(anchor);
		expect(
			Buffer.byteLength(JSON.stringify(compact_response.result)),
		).toBeLessThanOrEqual(selection_budget);
		console.log(
			'P1B_MEASUREMENT ' +
				JSON.stringify({
					name,
					legacy_bytes: Buffer.byteLength(
						JSON.stringify(legacy.result),
					),
					compact_bytes: Buffer.byteLength(
						JSON.stringify(compact_response.result),
					),
					canonical_reads: pages,
					anchor_retained: selected.includes(anchor),
					legacy_ms,
					compact_ms,
				}),
		);
	},
);

it('opts into complete full output without changing legacy or duplicating extraction text', async () => {
	respond('Fixture evidence [1].');
	const legacy = parsed(
		await call('web_extract', { provider: 'tavily', url }),
	);
	const response = await call('web_extract', {
		provider: 'tavily',
		url,
		response_mode: 'full',
	});
	const full = parsed(response);
	expect(full.response_mode).toBe('full');
	expect(full.metadata).toMatchObject({
		provider: 'tavily',
		operation: 'extract',
		local_completeness: 'complete',
		provider_page_completeness: 'unknown',
		usage: null,
	});
	expect(full.metadata.elapsed_ms).toBeGreaterThanOrEqual(0);
	const { content, ...canonical } = legacy;
	expect(full.result).toEqual(canonical);
	expect(full.result.raw_contents[0].content).toBe(content);
	expect(full).not.toHaveProperty('result_id');
	expect(readdirSync(directory)).toEqual([]);
	expect(
		Buffer.byteLength(JSON.stringify(response.result)),
	).toBeLessThanOrEqual(80000);
	expect(fetch_mock).toHaveBeenCalledTimes(2);
});
