import {
	afterEach,
	beforeEach,
	describe,
	expect,
	it,
	vi,
} from 'vitest';
import { config } from '../../../config/env.js';
import { YouSearchProvider } from './index.js';
const fetch_mock = vi.fn();
const previous_key = config.search.you.api_key;
beforeEach(() => {
	fetch_mock.mockReset();
	vi.stubGlobal('fetch', fetch_mock);
	config.search.you.api_key = 'you-test-key';
});
afterEach(() => {
	config.search.you.api_key = previous_key;
	vi.unstubAllGlobals();
});

describe('You response contract', () => {
	it('applies the requested limit to combined web and news results', async () => {
		const hit = (title: string) => ({
			title,
			url: `https://example.com/${title}`,
		});
		fetch_mock.mockResolvedValue(
			new Response(
				JSON.stringify({
					results: {
						web: [hit('one'), hit('two')],
						news: [hit('three'), hit('four')],
					},
				}),
			),
		);
		const result = await new YouSearchProvider().search({
			query: 'test',
			limit: 3,
		});
		expect(result.map((item) => item.title)).toEqual([
			'one',
			'two',
			'three',
		]);
	});

	it.each([
		{ results: { web: 'not an array' } },
		{ results: { news: [{ title: 'Broken' }] } },
		{
			results: {
				web: [
					{
						title: 'Result',
						url: 'https://example.com',
						snippets: 42,
					},
				],
			},
		},
	])(
		'rejects malformed results instead of returning invalid output: %o',
		async (body) => {
			fetch_mock.mockImplementation(
				async () => new Response(JSON.stringify(body)),
			);
			await expect(
				new YouSearchProvider().search({ query: 'test' }),
			).rejects.toMatchObject({
				type: 'PROVIDER_ERROR',
				message: 'Malformed you response',
				details: { retryable: false },
			});
			expect(fetch_mock).toHaveBeenCalledTimes(1);
		},
	);
	it('keeps existing endpoint and auth while mapping web and news snippets', async () => {
		fetch_mock.mockResolvedValue(
			new Response(
				JSON.stringify({
					results: {
						web: [
							{
								title: 'Web',
								url: 'https://example.com',
								snippets: ['One', 'Two'],
							},
						],
						news: [
							{
								title: 'News',
								url: 'https://example.com/news',
								description: 'Description',
							},
						],
					},
				}),
			),
		);
		await expect(
			new YouSearchProvider().search({
				query: 'mcp-retriever C++ OR docs',
			}),
		).resolves.toMatchObject([
			{ snippet: 'One Two' },
			{ snippet: 'Description' },
		]);
		const [url, options] = fetch_mock.mock.calls[0];
		expect(url).toContain(`${config.search.you.base_url}/v1/search?`);
		expect(options.method).toBe('GET');
		expect(options.headers.Authorization).toBe('Bearer you-test-key');
		expect(new URL(url).searchParams.get('query')).toBe(
			'mcp-retriever C++ OR docs',
		);
	});
});
