import {
	afterEach,
	beforeEach,
	describe,
	expect,
	it,
	vi,
} from 'vitest';
import { get_response_metadata } from '../../../common/response_metadata.js';
import { config } from '../../../config/env.js';
import { TavilySearchProvider } from '../../search/tavily/index.js';
import { TavilyExtractProvider } from './index.js';

const fetch_mock = vi.fn();
const previous_api_key = config.processing.tavily_extract.api_key;

describe('TavilyExtractProvider response validation', () => {
	it('isolates metadata across overlapping search and extract requests', async () => {
		const previous_search_key = config.search.tavily.api_key;
		config.search.tavily.api_key = 'tavily-test-key';
		let finish_search!: (response: Response) => void;
		const pending_response = new Promise<Response>((resolve) => {
			finish_search = resolve;
		});
		fetch_mock
			.mockReturnValueOnce(pending_response)
			.mockResolvedValueOnce(
				new Response(
					JSON.stringify({
						results: [
							{
								url: 'https://example.test',
								raw_content: 'Evidence',
							},
						],
						failed_results: [],
						request_id: 'extract-overlap',
						usage: { credits: 1 },
					}),
				),
			)
			.mockResolvedValueOnce(new Response('{"results":[]}'));
		try {
			const search_provider = new TavilySearchProvider();
			const pending_search = search_provider.search({
				query: 'first',
			});
			await vi.waitFor(() => {
				expect(fetch_mock).toHaveBeenCalledTimes(1);
			});
			const extract =
				await new TavilyExtractProvider().process_content(
					'https://example.test',
				);
			const unreported = await search_provider.search({
				query: 'second',
			});
			finish_search(
				new Response(
					JSON.stringify({
						results: [],
						request_id: 'search-overlap',
						usage: { credits: 2 },
					}),
				),
			);
			const search = await pending_search;
			expect(get_response_metadata(search)).toEqual({
				request_id: 'search-overlap',
				usage: { credits: 2 },
			});
			expect(get_response_metadata(extract)).toEqual({
				request_id: 'extract-overlap',
				usage: { credits: 1 },
			});
			expect(get_response_metadata(unreported)).toBeUndefined();
			expect(search).not.toBe(unreported);
		} finally {
			config.search.tavily.api_key = previous_search_key;
		}
	});

	it.each(
		[null, false, { private_canary: 'secret' }, []].map(
			(response_time) => ({ response_time }),
		),
	)(
		'ignores malformed optional metadata without rejecting content: %o',
		async ({ response_time }) => {
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
						request_id: 'https://private-canary.test',
						response_time,
						usage: { credits: 'private-canary' },
					}),
				),
			);
			const result =
				await new TavilyExtractProvider().process_content(
					'https://example.test',
				);
			expect(result.content).toBe('Evidence');
			expect(JSON.stringify(result)).not.toContain('private-canary');
			expect(get_response_metadata(result)).toBeUndefined();
		},
	);

	it('keeps reported metadata on the request result only', async () => {
		const urls = [
			'https://example.test/first',
			'https://example.test/second',
			'https://example.test/failed',
		];
		fetch_mock.mockResolvedValue(
			new Response(
				JSON.stringify({
					results: [
						{ url: urls[0], raw_content: 'Evidence one' },
						{ url: urls[1], raw_content: 'Evidence two' },
					],
					failed_results: [{ url: urls[2], error: 'Unavailable' }],
					request_id: 'extract-request-123',
					response_time: 1.25,
					usage: { credits: 1, private_canary: 'secret' },
					private_canary: 'secret',
				}),
			),
		);
		const result = await new TavilyExtractProvider().process_content(
			urls,
		);
		expect(get_response_metadata(result)).toEqual({
			request_id: 'extract-request-123',
			response_time_seconds: 1.25,
			usage: { credits: 1 },
		});
		const legacy = {
			content: 'Evidence one\n\nEvidence two',
			raw_contents: [
				{ url: urls[0], content: 'Evidence one' },
				{ url: urls[1], content: 'Evidence two' },
			],
			metadata: {
				word_count: 4,
				failed_urls: [urls[2]],
				urls_processed: 3,
				successful_extractions: 2,
				extract_depth: 'basic',
			},
			source_provider: 'tavily_extract',
		};
		expect(JSON.stringify(result)).toBe(JSON.stringify(legacy));
		expect(Reflect.ownKeys(result)).toEqual(Reflect.ownKeys(legacy));
		expect(get_response_metadata(result.metadata!)).toBeUndefined();
		for (const entry of result.raw_contents!) {
			expect(get_response_metadata(entry)).toBeUndefined();
			expect(Reflect.ownKeys(entry)).toEqual(['url', 'content']);
		}
		expect(JSON.parse(fetch_mock.mock.calls[0][1].body)).toEqual({
			urls,
			include_images: false,
			extract_depth: 'basic',
		});
	});

	it.each(['markdown', 'text'] as const)(
		'forwards explicit %s format without changing canonical mapping',
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
			const result =
				await new TavilyExtractProvider().process_content(
					'https://example.test',
					'basic',
					{ format },
				);
			expect(JSON.parse(fetch_mock.mock.calls[0][1].body)).toEqual({
				urls: ['https://example.test'],
				include_images: false,
				extract_depth: 'basic',
				format,
			});
			expect(result.content).toBe('Evidence');
			expect(result.raw_contents).toEqual([
				{ url: 'https://example.test', content: 'Evidence' },
			]);
		},
	);
	it.each(['html', null, 123])(
		'rejects unsupported direct format %o before networking',
		async (format) => {
			await expect(
				new TavilyExtractProvider().process_content(
					'https://example.test',
					'basic',
					{ format } as any,
				),
			).rejects.toMatchObject({
				type: 'INVALID_INPUT',
				details: { retryable: false },
			});
			expect(fetch_mock).not.toHaveBeenCalled();
		},
	);
	it.each([
		{ chunks_per_source: 3 },
		{ query: 'test', chunks_per_source: 0 },
		{ query: 'test', chunks_per_source: 6 },
		{ query: 'test', chunks_per_source: 1.5 },
		{ query: ' ', chunks_per_source: 2 },
	])(
		'rejects invalid reranking options before requesting: %o',
		async (options) => {
			await expect(
				new TavilyExtractProvider().process_content(
					'https://example.com',
					'basic',
					options,
				),
			).rejects.toMatchObject({
				type: 'INVALID_INPUT',
				provider: 'tavily_extract',
			});
			expect(fetch_mock).not.toHaveBeenCalled();
		},
	);
	it('forwards query reranking and chunk count without changing extraction depth', async () => {
		fetch_mock.mockResolvedValue(
			new Response(
				JSON.stringify({
					results: [
						{
							url: 'https://example.com',
							raw_content: 'Relevant chunks',
						},
					],
					failed_results: [],
				}),
			),
		);
		await new TavilyExtractProvider().process_content(
			'https://example.com',
			'basic',
			{ query: 'mcp-retriever C++', chunks_per_source: 5 },
		);
		expect(
			JSON.parse(fetch_mock.mock.calls[0][1].body),
		).toMatchObject({
			query: 'mcp-retriever C++',
			chunks_per_source: 5,
			extract_depth: 'basic',
			include_images: false,
		});
	});
	beforeEach(() => {
		fetch_mock.mockReset();
		vi.stubGlobal('fetch', fetch_mock);
		config.processing.tavily_extract.api_key = 'tavily-test-key';
	});

	afterEach(() => {
		config.processing.tavily_extract.api_key = previous_api_key;
		vi.unstubAllGlobals();
		vi.restoreAllMocks();
	});

	it('accepts a valid extract response', async () => {
		fetch_mock.mockResolvedValue(
			new Response(
				JSON.stringify({
					results: [
						{ url: 'https://example.com', raw_content: 'Content' },
					],
					failed_results: [],
					response_time: 0.1,
				}),
				{ status: 200 },
			),
		);

		await expect(
			new TavilyExtractProvider().process_content(
				'https://example.com',
			),
		).resolves.toMatchObject({
			content: 'Content',
			source_provider: 'tavily_extract',
		});
	});

	it.each(['1.67', 1.67])(
		'accepts response_time as %o',
		async (response_time) => {
			fetch_mock.mockResolvedValue(
				new Response(
					JSON.stringify({
						results: [
							{ url: 'https://example.com', raw_content: 'Content' },
						],
						failed_results: [],
						response_time,
					}),
					{ status: 200 },
				),
			);

			await expect(
				new TavilyExtractProvider().process_content(
					'https://example.com',
				),
			).resolves.toMatchObject({
				content: 'Content',
				source_provider: 'tavily_extract',
			});
		},
	);

	it('rejects a malformed results envelope as a provider error', async () => {
		fetch_mock.mockResolvedValue(
			new Response(
				JSON.stringify({
					results: { unexpected: true },
					failed_results: [],
					response_time: 0.1,
				}),
				{ status: 200 },
			),
		);

		await expect(
			new TavilyExtractProvider().process_content(
				'https://example.com',
			),
		).rejects.toMatchObject({
			type: 'PROVIDER_ERROR',
			provider: 'tavily_extract',
			message: 'Malformed tavily_extract response',
		});
		expect(fetch_mock).toHaveBeenCalledTimes(1);
	});

	it('does not retry an empty extraction, which would bill the same call twice', async () => {
		fetch_mock.mockResolvedValue(
			new Response(
				JSON.stringify({ results: [], failed_results: [] }),
				{
					status: 200,
					headers: { 'Content-Type': 'application/json' },
				},
			),
		);
		await expect(
			new TavilyExtractProvider().process_content(
				'https://example.com',
			),
		).rejects.toMatchObject({
			type: 'PROVIDER_ERROR',
			provider: 'tavily_extract',
			message: 'No content extracted from URL',
			details: { retryable: false },
		});
		expect(fetch_mock).toHaveBeenCalledTimes(1);
	});
});
