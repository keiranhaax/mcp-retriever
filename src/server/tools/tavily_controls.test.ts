import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
	beforeEach,
	afterEach,
	describe,
	expect,
	it,
	vi,
} from 'vitest';
import { config } from '../../config/env.js';
import { create_server } from '../create_server.js';

// Synthetic upstream fixture only; unexpected calls never reach a provider.
const settings = Object.values(config).flatMap((category) =>
	Object.values(category),
);
const keys = settings.map((value) => value.api_key);
const fetch_mock = vi.fn();
let server: ReturnType<typeof create_server>;
let result_dir: string;
const request = async (
	name: string,
	args: Record<string, unknown>,
) => {
	const response: any = await server.receive({
		jsonrpc: '2.0',
		id: 1,
		method: 'tools/call',
		params: { name, arguments: args },
	});
	return response.result;
};
beforeEach(() => {
	result_dir = mkdtempSync(join(tmpdir(), 'retriever-p1a-'));
	vi.stubEnv('RETRIEVER_RESULT_DIR', result_dir);
	for (const value of settings) value.api_key = 'p1a-fixture-key';
	fetch_mock.mockReset();
	fetch_mock.mockImplementation(async () => {
		throw new Error('Unexpected P1A networking');
	});
	vi.stubGlobal('fetch', fetch_mock);
	vi.spyOn(console, 'error').mockImplementation(() => {});
	vi.spyOn(console, 'warn').mockImplementation(() => {});
	server = create_server({ name: 'p1a-fixture', version: '1' });
});
afterEach(() => {
	settings.forEach((value, index) => {
		value.api_key = keys[index];
	});
	vi.unstubAllGlobals();
	vi.unstubAllEnvs();
	vi.restoreAllMocks();
	rmSync(result_dir, { recursive: true, force: true });
});

describe('P1A Tavily extraction public contract', () => {
	it.each([1, 5])(
		'forwards query and chunk boundary %s without overriding depth',
		async (chunks_per_source) => {
			fetch_mock.mockResolvedValue(
				new Response(
					JSON.stringify({
						results: [
							{
								url: 'https://example.test',
								raw_content: 'Evidence',
							},
						],
						failed_results: [],
					}),
				),
			);
			const result = await request('web_extract', {
				provider: 'tavily',
				url: 'https://example.test',
				extract_depth: 'advanced',
				query: 'evidence',
				chunks_per_source,
				format: 'text',
			});
			expect(result.isError).not.toBe(true);
			expect(fetch_mock).toHaveBeenCalledTimes(1);
			expect(JSON.parse(fetch_mock.mock.calls[0][1].body)).toEqual({
				urls: ['https://example.test'],
				include_images: false,
				extract_depth: 'advanced',
				query: 'evidence',
				chunks_per_source,
				format: 'text',
			});
		},
	);
	it.each(['markdown', 'text'])(
		'allows format %s without a reranking query',
		async (format) => {
			fetch_mock.mockResolvedValue(
				new Response(
					JSON.stringify({
						results: [
							{
								url: 'https://example.test',
								raw_content: 'Evidence',
							},
						],
						failed_results: [],
					}),
				),
			);
			const result = await request('web_extract', {
				provider: 'tavily',
				url: 'https://example.test',
				format,
			});
			expect(result.isError).not.toBe(true);
			expect(
				JSON.parse(fetch_mock.mock.calls[0][1].body).format,
			).toBe(format);
		},
	);
	it.each([
		{ chunks_per_source: 2 },
		{ query: ' ', chunks_per_source: 2 },
		{ query: 'x', chunks_per_source: 0 },
		{ query: 'x', chunks_per_source: 6 },
		{ query: 'x', chunks_per_source: 1.5 },
		{ query: 'x', chunks_per_source: '2' },
		{ query: 'x', chunks_per_source: null },
		{ format: 'html' },
		{ format: null },
	])(
		'rejects invalid extraction controls before networking: %o',
		async (controls) => {
			const result = await request('web_extract', {
				provider: 'tavily',
				url: 'https://example.test',
				...controls,
			});
			expect(result.isError).toBe(true);
			expect(fetch_mock).not.toHaveBeenCalled();
		},
	);
	it.each(['firecrawl', 'exa'])(
		'rejects Tavily-only extraction controls for %s',
		async (provider) => {
			for (const controls of [
				{ format: 'markdown' },
				{ query: 'x', chunks_per_source: 1 },
			]) {
				const result = await request('web_extract', {
					provider,
					url: 'https://example.test',
					...controls,
				});
				expect(result.isError).toBe(true);
				expect(result.content[0].text).toContain(
					'Tavily extraction controls require provider=tavily',
				);
			}
			expect(fetch_mock).not.toHaveBeenCalled();
		},
	);
});

describe('P1A Tavily search public contract', () => {
	it('dispatches supported search controls through MCP to Tavily', async () => {
		fetch_mock.mockResolvedValue(new Response('{"results":[]}'));
		const result = await request('web_search', {
			query: 'report',
			provider: 'tavily',
			search_depth: 'fast',
			topic: 'news',
			time_range: 'day',
		});
		expect(result.isError).not.toBe(true);
		expect(fetch_mock).toHaveBeenCalledTimes(1);
		expect(fetch_mock.mock.calls[0][0]).toBe(
			'https://api.tavily.com/search',
		);
		expect(
			JSON.parse(fetch_mock.mock.calls[0][1].body),
		).toMatchObject({
			search_depth: 'fast',
			topic: 'news',
			time_range: 'day',
		});
	});
	it.each(['brave', 'exa', 'you'])(
		'rejects Tavily-only controls for %s before dispatch',
		async (provider) => {
			for (const controls of [
				{ search_depth: 'basic' },
				{ topic: 'general' },
				{ time_range: 'week' },
			]) {
				const result = await request('web_search', {
					query: 'report',
					provider,
					...controls,
				});
				expect(result.isError).toBe(true);
				expect(result.content[0].text).toContain(
					'Tavily search controls require provider=tavily',
				);
			}
			expect(fetch_mock).not.toHaveBeenCalled();
		},
	);
	it.each([
		{ search_depth: 'extreme' },
		{ topic: null },
		{ time_range: 'decade' },
	])('rejects invalid public controls: %o', async (controls) => {
		const result = await request('web_search', {
			query: 'report',
			provider: 'tavily',
			...controls,
		});
		expect(result.isError).toBe(true);
		expect(fetch_mock).not.toHaveBeenCalled();
	});
	it.each([
		{
			query: 'report after:2024',
			time_range: 'week',
			message: 'Tavily time_range cannot be combined',
		},
		{
			query: 'report loc:us',
			topic: 'news',
			message: 'Tavily country operators require topic=general',
		},
	])(
		'returns safe guidance for control conflict: $query',
		async ({ message, ...args }) => {
			const result = await request('web_search', {
				provider: 'tavily',
				...args,
			});
			expect(result.isError).toBe(true);
			expect(result.content[0].text).toContain(message);
			expect(fetch_mock).not.toHaveBeenCalled();
		},
	);
});
