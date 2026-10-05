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
import { TavilySearchProvider } from './index.js';

const fetch_mock = vi.fn();
const previous_api_key = config.search.tavily.api_key;

describe('TavilySearchProvider', () => {
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
						results: [],
						request_id: 'https://private-canary.test',
						response_time,
						usage: { credits: 'private-canary' },
					}),
				),
			);
			const result = await new TavilySearchProvider().search({
				query: 'evidence',
			});
			expect(JSON.stringify(result)).toBe('[]');
			expect(get_response_metadata(result)).toBeUndefined();
		},
	);

	it('keeps reported metadata on the request result only', async () => {
		const entries = [
			{
				title: 'First',
				url: 'https://example.test/first',
				content: 'Evidence one',
				score: 0.8,
			},
			{
				title: 'Second',
				url: 'https://example.test/second',
				content: 'Evidence two',
				score: 0.5,
			},
		];
		fetch_mock.mockResolvedValue(
			new Response(
				JSON.stringify({
					results: entries,
					request_id: 'search-request-123',
					response_time: 0.75,
					usage: { credits: 2, private_canary: 'secret' },
					private_canary: 'secret',
				}),
			),
		);

		const result = await new TavilySearchProvider().search({
			query: 'evidence',
		});
		expect(get_response_metadata(result)).toEqual({
			request_id: 'search-request-123',
			response_time_seconds: 0.75,
			usage: { credits: 2 },
		});
		expect(JSON.stringify(result)).toBe(
			JSON.stringify(
				entries.map(({ title, url, content, score }) => ({
					title,
					url,
					snippet: content,
					score,
					source_provider: 'tavily',
				})),
			),
		);
		expect(Reflect.ownKeys(result)).toEqual(['0', '1', 'length']);
		for (const entry of result) {
			expect(get_response_metadata(entry)).toBeUndefined();
			expect(Reflect.ownKeys(entry)).toEqual([
				'title',
				'url',
				'snippet',
				'score',
				'source_provider',
			]);
		}
		expect(JSON.parse(fetch_mock.mock.calls[0][1].body)).toEqual({
			query: 'evidence',
			max_results: 5,
			include_domains: [],
			exclude_domains: [],
			search_depth: 'basic',
			topic: 'general',
		});
	});

	it.each([
		{ search_depth: 'extreme' },
		{ search_depth: null },
		{ topic: 'unsupported' },
		{ topic: 1 },
		{ time_range: 'decade' },
		{ time_range: '' },
	])(
		'rejects invalid direct search controls before networking: %o',
		async (controls) => {
			await expect(
				new TavilySearchProvider().search({
					query: 'report',
					...controls,
				} as any),
			).rejects.toMatchObject({
				type: 'INVALID_INPUT',
				details: { retryable: false },
			});
			expect(fetch_mock).not.toHaveBeenCalled();
		},
	);

	it.each([
		{ query: 'report after:2024', time_range: 'week' },
		{ query: 'report before:2024-01-01', time_range: 'day' },
		{
			query: 'report after:2024 OR before:2023',
			time_range: 'month',
		},
		{ query: 'report loc:us', topic: 'news' },
		{ query: 'report location:uk', topic: 'finance' },
	])(
		'rejects incompatible explicit controls without discarding query constraints: %o',
		async (params) => {
			await expect(
				new TavilySearchProvider().search(params as any),
			).rejects.toMatchObject({
				type: 'INVALID_INPUT',
				details: { retryable: false },
			});
			expect(fetch_mock).not.toHaveBeenCalled();
		},
	);

	it.each(['basic', 'advanced', 'fast', 'ultra-fast'] as const)(
		'accepts supported depth %s',
		async (search_depth) => {
			fetch_mock.mockResolvedValue(new Response('{"results":[]}'));
			await new TavilySearchProvider().search({
				query: 'report',
				search_depth,
			});
			expect(
				JSON.parse(fetch_mock.mock.calls[0][1].body).search_depth,
			).toBe(search_depth);
		},
	);

	it('retains unmapped quoted date text and Boolean country alternatives', async () => {
		fetch_mock.mockResolvedValue(new Response('{"results":[]}'));
		const query = '"after:2024" loc:us OR loc:uk';
		await new TavilySearchProvider().search({
			query,
			topic: 'news',
			time_range: 'week',
		});
		const request = JSON.parse(fetch_mock.mock.calls[0][1].body);
		expect(request.query).toBe(query);
		expect(request).not.toHaveProperty('country');
		expect(request).not.toHaveProperty('start_date');
	});
	it('forwards explicit depth, topic, and recency without changing result shape', async () => {
		fetch_mock.mockResolvedValue(
			new Response(
				JSON.stringify({
					results: [
						{
							title: 'Report',
							url: 'https://example.test/report',
							content: 'Evidence',
							score: 0.5,
						},
					],
				}),
			),
		);
		const result = await new TavilySearchProvider().search({
			query: 'latest market report',
			search_depth: 'advanced',
			topic: 'finance',
			time_range: 'week',
		});
		expect(
			JSON.parse(fetch_mock.mock.calls[0][1].body),
		).toMatchObject({
			search_depth: 'advanced',
			topic: 'finance',
			time_range: 'week',
			max_results: 5,
		});
		expect(result).toEqual([
			{
				title: 'Report',
				url: 'https://example.test/report',
				snippet: 'Evidence',
				score: 0.5,
				source_provider: 'tavily',
			},
		]);
	});
	it('does not turn Boolean phrase alternatives into a global exact match requirement', async () => {
		fetch_mock.mockResolvedValue(
			new Response(JSON.stringify({ results: [] })),
		);
		await new TavilySearchProvider().search({
			query: '"cats" OR "dogs"',
		});
		expect(
			JSON.parse(fetch_mock.mock.calls[0][1].body),
		).not.toHaveProperty('exact_match');
	});
	it('caps direct provider requests at twenty results', async () => {
		fetch_mock.mockResolvedValue(
			new Response(JSON.stringify({ results: [] })),
		);
		await new TavilySearchProvider().search({
			query: 'test',
			limit: 100,
		});
		expect(
			JSON.parse(fetch_mock.mock.calls[0][1].body).max_results,
		).toBe(20);
	});
	it.each([
		'mcp-retriever C++ filetype:pdf -outdated +manual intitle:guide lang:en',
		'"cats AND dogs" OR birds NOT fish site:example.com',
	])('preserves all unmapped query syntax in %s', async (query) => {
		fetch_mock.mockResolvedValue(
			new Response(JSON.stringify({ results: [] })),
		);
		await new TavilySearchProvider().search({ query });
		expect(JSON.parse(fetch_mock.mock.calls[0][1].body).query).toBe(
			query,
		);
	});

	beforeEach(() => {
		fetch_mock.mockReset();
		vi.stubGlobal('fetch', fetch_mock);
		config.search.tavily.api_key = 'tavily-test-key';
	});

	afterEach(() => {
		config.search.tavily.api_key = previous_api_key;
		vi.unstubAllGlobals();
		vi.restoreAllMocks();
	});

	it('applies the configured abort timeout to search requests', async () => {
		fetch_mock.mockResolvedValue(
			new Response(
				JSON.stringify({ results: [], response_time: '0.1' }),
				{
					status: 200,
					headers: { 'Content-Type': 'application/json' },
				},
			),
		);

		await new TavilySearchProvider().search({ query: 'test' });
		expect(fetch_mock.mock.calls[0][1].signal).toBeInstanceOf(
			AbortSignal,
		);
	});

	it('normalizes date and country operators for Tavily API fields', async () => {
		fetch_mock.mockResolvedValue(
			new Response(
				JSON.stringify({ results: [], response_time: '0.1' }),
				{
					status: 200,
					headers: { 'Content-Type': 'application/json' },
				},
			),
		);

		await new TavilySearchProvider().search({
			query:
				'example after:2024-05 before:2024-05-10 loc:United-Kingdom',
		});

		expect(
			JSON.parse(fetch_mock.mock.calls[0][1].body),
		).toMatchObject({
			start_date: '2024-05-01',
			end_date: '2024-05-10',
			country: 'united kingdom',
		});
	});

	it.each(['1.67', 1.67])(
		'accepts response_time as %o',
		async (response_time) => {
			fetch_mock.mockResolvedValue(
				new Response(
					JSON.stringify({
						results: [
							{
								title: 'Result',
								url: 'https://example.com',
								content: 'Snippet',
								score: 0.5,
							},
						],
						response_time,
					}),
					{ status: 200 },
				),
			);

			await expect(
				new TavilySearchProvider().search({ query: 'timing' }),
			).resolves.toHaveLength(1);
		},
	);

	it('accepts an omitted results array as an empty current response', async () => {
		fetch_mock.mockResolvedValue(
			new Response(JSON.stringify({ response_time: '0.1' }), {
				status: 200,
			}),
		);

		await expect(
			new TavilySearchProvider().search({ query: 'no results' }),
		).resolves.toEqual([]);
	});

	it('rejects a malformed results envelope as a provider error', async () => {
		fetch_mock.mockResolvedValue(
			new Response(
				JSON.stringify({ results: { unexpected: true } }),
				{ status: 200 },
			),
		);

		await expect(
			new TavilySearchProvider().search({ query: 'malformed' }),
		).rejects.toMatchObject({
			type: 'PROVIDER_ERROR',
			provider: 'tavily',
			message: 'Malformed tavily response',
		});
		expect(fetch_mock).toHaveBeenCalledTimes(1);
	});
});
