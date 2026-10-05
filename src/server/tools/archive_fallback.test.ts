import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
	afterEach,
	beforeEach,
	describe,
	expect,
	it,
	vi,
} from 'vitest';
import {
	gone_urls_of,
	is_gone_message,
	parse_wayback_snapshot,
} from '../../common/archive_fallback.js';
import { ErrorType, ProviderError } from '../../common/types.js';
import { config } from '../../config/env.js';
import { create_server } from '../create_server.js';
import {
	get_provider_health_snapshot,
	reset_provider_health,
} from '../provider_health.js';
import { get_provider_metrics_snapshot } from '../provider_metrics.js';

/**
 * Opt-in Wayback Machine recovery for pages a provider reports gone.
 * Every case runs offline: fetch is mocked per host, and the test
 * asserts that archive.org is the only host added to the normal
 * provider traffic, that it is only contacted when asked, and that the
 * snapshot is read by the same provider.
 */

const settings = Object.values(config).flatMap(Object.values);
const keys = settings.map((item) => item.api_key);
const fetch_mock = vi.fn();
let server: ReturnType<typeof create_server>;
let directory: string;
let sequence = 0;

const gone = 'https://example.com/gone';
const live = 'https://example.com/live';
const stamp = '20240102030405';
const snapshot_url = `https://web.archive.org/web/${stamp}/${gone}`;
const extract_url = `https://web.archive.org/web/${stamp}id_/${gone}`;
const availability = (closest?: Record<string, unknown>) =>
	Response.json({
		url: gone,
		archived_snapshots: closest ? { closest } : {},
	});
const found = {
	available: true,
	url: `http://web.archive.org/web/${stamp}/${gone}`,
	timestamp: stamp,
	status: '200',
};

interface Call {
	url: string;
	method: string;
	body: any;
	headers: Record<string, string>;
}
const calls: Call[] = [];
const dispatch = (
	handler: (call: Call) => Response | Promise<Response>,
) =>
	fetch_mock.mockImplementation(
		async (target: string | URL, init: RequestInit = {}) => {
			const call: Call = {
				url: String(target),
				method: init.method ?? 'GET',
				body:
					typeof init.body === 'string'
						? JSON.parse(init.body)
						: undefined,
				headers: (init.headers ?? {}) as Record<string, string>,
			};
			calls.push(call);
			return handler(call);
		},
	);
const hosts = () => [
	...new Set(calls.map((call) => new URL(call.url).host)),
];

const call = async (args: Record<string, unknown>) =>
	(await server.receive(
		{
			jsonrpc: '2.0',
			id: ++sequence,
			method: 'tools/call',
			params: { name: 'web_extract', arguments: args },
		},
		{} as any,
	)) as any;

beforeEach(() => {
	directory = mkdtempSync(join(tmpdir(), 'retriever-archive-'));
	vi.stubEnv('RETRIEVER_RESULT_DIR', directory);
	vi.stubEnv('RETRIEVER_HTTP_CACHE_BYTES', '0');
	for (const item of settings) item.api_key = undefined;
	config.processing.tavily_extract.api_key = 'archive-fixture-key';
	config.processing.firecrawl_scrape.api_key = 'archive-fixture-key';
	config.processing.exa_contents.api_key = 'archive-fixture-key';
	vi.stubGlobal('fetch', fetch_mock);
	fetch_mock.mockReset();
	calls.length = 0;
	vi.spyOn(console, 'error').mockImplementation(() => {});
	vi.spyOn(console, 'warn').mockImplementation(() => {});
	reset_provider_health();
	server = create_server({ name: 'archive-offline', version: '1' });
});

afterEach(() => {
	settings.forEach((item, i) => {
		item.api_key = keys[i];
	});
	reset_provider_health();
	vi.unstubAllGlobals();
	vi.unstubAllEnvs();
	vi.restoreAllMocks();
	rmSync(directory, { recursive: true, force: true });
});

const tavily = (call: Call) => {
	if (call.body.urls[0] === gone)
		return Response.json({
			results: [],
			failed_results: [
				{ url: gone, error: 'Failed to fetch: 404 Client Error' },
			],
			usage: { credits: 1 },
		});
	return Response.json({
		results: [
			{ url: call.body.urls[0], raw_content: 'Archived body' },
		],
		failed_results: [],
		usage: { credits: 1 },
	});
};

describe('web_extract archive_fallback', () => {
	it('reads the closest Wayback snapshot with the same provider and labels it archived', async () => {
		dispatch((call) =>
			call.url.startsWith('https://archive.org/')
				? availability(found)
				: tavily(call),
		);
		const response = await call({
			url: gone,
			provider: 'tavily',
			archive_fallback: true,
			response_mode: 'full',
		});
		expect(response.result.isError).not.toBe(true);
		const data = response.result.structuredContent.data;
		expect(data.result).toMatchObject({
			raw_contents: [{ url: extract_url, content: 'Archived body' }],
			metadata: {
				urls_processed: 1,
				successful_extractions: 1,
				archived: [
					{
						url: gone,
						snapshot_url,
						extract_url,
						timestamp: '2024-01-02T03:04:05.000Z',
					},
				],
				archive_fallback: {
					attempted: [gone],
					recovered: [gone],
					unavailable: [],
				},
			},
			source_provider: 'tavily_extract',
		});
		expect(data.result.metadata).not.toHaveProperty('failed_urls');
		// Only the real extraction that succeeded is charged and reported.
		expect(data.metadata).toMatchObject({
			usage: { credits: 1 },
			usage_source: 'provider_reported',
		});
		expect(
			calls.map((item) => `${item.method} ${new URL(item.url).host}`),
		).toEqual([
			'POST api.tavily.com',
			'GET archive.org',
			'POST api.tavily.com',
		]);
		const lookup = calls[1];
		expect(lookup.url).toBe(
			`https://archive.org/wayback/available?url=${encodeURIComponent(gone)}`,
		);
		expect(lookup.headers).not.toHaveProperty('Authorization');
		expect(calls[2].body.urls).toEqual([extract_url]);
		expect(
			get_provider_metrics_snapshot().tools.web_extract,
		).toMatchObject({ calls: 1, ok: 1, usage: { credits: 1 } });
		expect(
			get_provider_health_snapshot().processing,
		).not.toHaveProperty('wayback');
	});

	it('never contacts archive.org unless asked', async () => {
		dispatch(tavily);
		const response = await call({ url: gone, provider: 'tavily' });
		expect(response.result).toMatchObject({
			isError: true,
			structuredContent: {
				error: {
					kind: 'upstream_failure',
					provider: 'tavily_extract',
				},
			},
		});
		expect(hosts()).toEqual(['api.tavily.com']);
	});

	it.each([
		['no snapshot', availability()],
		[
			'an unavailable snapshot',
			availability({ ...found, available: false }),
		],
		[
			'a snapshot on another host',
			availability({
				...found,
				url: `https://evil.test/web/${stamp}/${gone}`,
			}),
		],
		[
			'a malformed answer',
			Response.json({ archived_snapshots: 'x' }),
		],
		['an archive.org failure', new Response('busy', { status: 503 })],
	])(
		'keeps the original outcome and reads nothing after %s',
		async (_, answer) => {
			dispatch((call) =>
				call.url.startsWith('https://archive.org/')
					? answer
					: tavily(call),
			);
			const response = await call({
				url: gone,
				provider: 'tavily',
				archive_fallback: true,
			});
			expect(response.result).toMatchObject({
				isError: true,
				structuredContent: {
					error: {
						kind: 'upstream_failure',
						provider: 'tavily_extract',
					},
				},
			});
			expect(response.result.content[0].text).toContain(
				'tavily_extract error [PROVIDER_ERROR]',
			);
			expect(calls.map((item) => new URL(item.url).host)).toEqual([
				'api.tavily.com',
				'archive.org',
			]);
		},
	);

	it('merges a recovered Firecrawl 404 page beside the live pages', async () => {
		dispatch((call) => {
			if (call.url.startsWith('https://archive.org/'))
				return availability(found);
			const url = call.body.url as string;
			return Response.json({
				success: true,
				data: {
					markdown:
						url === live
							? 'Live page'
							: url === gone
								? 'Not found page'
								: 'Archived page',
					metadata: {
						title: url,
						sourceURL: url,
						statusCode: url === gone ? 404 : 200,
					},
				},
			});
		});
		const response = await call({
			url: [live, gone],
			provider: 'firecrawl',
			mode: 'scrape',
			archive_fallback: true,
			response_mode: 'full',
		});
		expect(response.result.isError).not.toBe(true);
		const result = response.result.structuredContent.data.result;
		expect(result.raw_contents).toEqual([
			{ url: live, content: 'Live page' },
			{ url: extract_url, content: 'Archived page' },
		]);
		expect(result.metadata).toMatchObject({
			urls_processed: 2,
			successful_extractions: 2,
			word_count: 4,
			gone_urls: [gone],
			archived: [
				{
					url: gone,
					snapshot_url,
					timestamp: '2024-01-02T03:04:05.000Z',
				},
			],
			archive_fallback: {
				attempted: [gone],
				recovered: [gone],
				unavailable: [],
			},
		});
		expect(
			result.metadata.documents.map((item: any) => item.url),
		).toEqual([live, extract_url]);
		expect(result.metadata).not.toHaveProperty('failed_urls');
		expect(calls.map((item) => item.body?.url ?? 'lookup')).toEqual([
			live,
			gone,
			'lookup',
			extract_url,
		]);
	});

	it('recovers an Exa page reported gone by status and reads the snapshot URL', async () => {
		dispatch((call) => {
			if (call.url.startsWith('https://archive.org/'))
				return availability(found);
			const [url] = call.body.urls as string[];
			return url === gone
				? Response.json({
						requestId: 'r1',
						results: [],
						statuses: [
							{
								id: gone,
								status: 'error',
								error: {
									tag: 'CRAWL_NOT_FOUND',
									httpStatusCode: 410,
								},
							},
						],
						costDollars: { total: 0.001 },
					})
				: Response.json({
						requestId: 'r2',
						results: [
							{
								id: url,
								url,
								title: 'Archived',
								text: 'Archived body',
							},
						],
						statuses: [{ id: url, status: 'success' }],
						costDollars: { total: 0.001 },
					});
		});
		const response = await call({
			url: gone,
			provider: 'exa',
			mode: 'contents',
			archive_fallback: true,
			response_mode: 'full',
		});
		expect(response.result.isError).not.toBe(true);
		const data = response.result.structuredContent.data;
		expect(data.result.raw_contents).toEqual([
			{ url: extract_url, content: 'Archived body' },
		]);
		expect(data.result.metadata.archived[0]).toMatchObject({
			url: gone,
			timestamp: '2024-01-02T03:04:05.000Z',
		});
		expect(data.metadata).toMatchObject({ usage: { usd: 0.001 } });
		expect(calls[2].body.urls).toEqual([extract_url]);
	});

	it('rejects archive_fallback for modes that do not read the given pages', async () => {
		dispatch(() => Response.json({}));
		const response = await call({
			url: gone,
			provider: 'firecrawl',
			mode: 'map',
			archive_fallback: true,
		});
		expect(response.result.isError).toBe(true);
		expect(response.result.content[0].text).toContain(
			'archive_fallback is only supported for tavily extract, firecrawl scrape or summarize, and exa contents',
		);
		expect(fetch_mock).not.toHaveBeenCalled();
	});
});

describe('archive fallback helpers', () => {
	it.each([
		[found, snapshot_url],
		[
			{
				...found,
				url: `https://web.archive.org/web/${stamp}id_/${gone}`,
			},
			snapshot_url,
		],
		[{ ...found, available: false }, undefined],
		[
			{ ...found, url: `https://evil.test/web/${stamp}/${gone}` },
			undefined,
		],
		[
			{ ...found, url: `https://web.archive.org/web/2024/${gone}` },
			undefined,
		],
		[
			{
				...found,
				url: `https://web.archive.org/web/${stamp}/ftp://x`,
			},
			undefined,
		],
		[{ ...found, url: 'not a url' }, undefined],
		[undefined, undefined],
	])('validates snapshot %j', (closest, expected) => {
		const snapshot = parse_wayback_snapshot(gone, {
			archived_snapshots: closest ? { closest } : {},
		});
		expect(snapshot?.snapshot_url).toBe(expected);
		if (expected)
			expect(snapshot).toMatchObject({
				url: gone,
				extract_url,
				timestamp: '2024-01-02T03:04:05.000Z',
			});
	});

	it('reads gone URLs only from a result or a provider error, public URLs only', () => {
		expect(
			gone_urls_of({
				metadata: {
					gone_urls: [gone, gone, 'nope', 'http://127.0.0.1/x'],
				},
			}),
		).toEqual([gone]);
		expect(
			gone_urls_of(
				new ProviderError(ErrorType.PROVIDER_ERROR, 'x', 'p', {
					gone_urls: [gone],
				}),
			),
		).toEqual([gone]);
		expect(gone_urls_of(new Error('x'))).toEqual([]);
		expect(gone_urls_of({ metadata: {} })).toEqual([]);
		expect(is_gone_message('HTTP 404 Not Found')).toBe(true);
		expect(is_gone_message('Page gone')).toBe(true);
		expect(is_gone_message('Timed out after 4040 ms')).toBe(false);
		expect(is_gone_message(undefined)).toBe(false);
	});
});
