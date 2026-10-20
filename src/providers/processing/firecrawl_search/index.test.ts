import {
	afterEach,
	beforeEach,
	describe,
	expect,
	it,
	vi,
} from 'vitest';
import { ErrorType } from '../../../common/types.js';
import { config } from '../../../config/env.js';
import { FirecrawlSearchProvider } from './index.js';

const fetch_mock = vi.fn();
const previous_api_key = config.processing.firecrawl_search.api_key;
const previous_base_url = config.processing.firecrawl_search.base_url;

describe('FirecrawlSearchProvider', () => {
	beforeEach(() => {
		fetch_mock.mockReset();
		vi.stubGlobal('fetch', fetch_mock);
		config.processing.firecrawl_search.api_key = 'fc-test-key';
		config.processing.firecrawl_search.base_url =
			'https://api.firecrawl.dev/v2/search';
	});

	afterEach(() => {
		config.processing.firecrawl_search.api_key = previous_api_key;
		config.processing.firecrawl_search.base_url = previous_base_url;
		vi.unstubAllGlobals();
		vi.restoreAllMocks();
	});

	it('sends a v2 search request with compatible defaults', async () => {
		fetch_mock.mockResolvedValue(
			new Response(
				JSON.stringify({
					success: true,
					id: 'search-1',
					creditsUsed: 2,
					data: {
						web: [
							{
								title: 'Result',
								url: 'https://example.com',
								markdown: 'Example markdown',
							},
						],
					},
				}),
				{
					status: 200,
					headers: { 'Content-Type': 'application/json' },
				},
			),
		);

		const provider = new FirecrawlSearchProvider();
		const result = await provider.process_content(
			'current search APIs',
		);

		const [url, options] = fetch_mock.mock.calls[0];
		const body = JSON.parse(options.body);
		expect(url).toBe('https://api.firecrawl.dev/v2/search');
		// Basic depth returns provider snippets; it must not bill a scrape
		// per hit unless the caller opts in.
		expect(body).toEqual({
			query: 'current search APIs',
			limit: 5,
			sources: ['web'],
		});
		expect(result.content).toContain('Example markdown');
		expect(result.metadata).toMatchObject({
			search_id: 'search-1',
			creditsUsed: 2,
			source_counts: { web: 1, images: 0, news: 0 },
		});
	});

	it('scrapes hits only for advanced depth or explicit formats', async () => {
		fetch_mock.mockImplementation(
			async () =>
				new Response(
					JSON.stringify({
						success: true,
						data: {
							web: [{ url: 'https://example.com', markdown: 'Body' }],
						},
					}),
				),
		);
		const provider = new FirecrawlSearchProvider();
		const sent = () =>
			JSON.parse(fetch_mock.mock.calls.at(-1)![1].body);

		await provider.process_content('q', 'advanced');
		expect(sent().scrapeOptions).toEqual({
			formats: ['markdown'],
			onlyMainContent: true,
		});

		await provider.process_content('q', 'basic', {
			scrapeOptions: { formats: ['html'], onlyMainContent: false },
		});
		expect(sent().scrapeOptions).toEqual({
			formats: ['html'],
			onlyMainContent: false,
		});

		await provider.process_content('q', 'advanced', {
			scrapeOptions: { formats: [] },
		});
		expect(sent()).not.toHaveProperty('scrapeOptions');

		// Scrape-only settings without formats do not trigger scraping.
		await provider.process_content('q', 'basic', {
			scrapeOptions: { redactPII: true },
		});
		expect(sent()).not.toHaveProperty('scrapeOptions');
	});

	it('keeps scraped bodies in raw_contents rather than duplicating them in documents', async () => {
		fetch_mock.mockImplementation(
			async () =>
				new Response(
					JSON.stringify({
						success: true,
						data: {
							web: [
								{
									url: 'https://example.com',
									title: 'Page',
									description: 'Snippet',
									markdown: 'Full page body',
									metadata: { statusCode: 200 },
								},
							],
							news: [
								{
									url: 'https://example.com/news',
									snippet: 'News snippet',
									html: '<p>News body</p>',
								},
							],
						},
					}),
				),
		);
		const result =
			await new FirecrawlSearchProvider().process_content(
				'q',
				'advanced',
			);
		expect(result.raw_contents).toEqual([
			{ url: 'https://example.com', content: 'Full page body' },
			{
				url: 'https://example.com/news',
				content: '<p>News body</p>',
			},
		]);
		expect(result.metadata.documents).toEqual({
			web: [
				{
					url: 'https://example.com',
					title: 'Page',
					description: 'Snippet',
					metadata: { statusCode: 200 },
				},
			],
			images: [],
			news: [
				{ url: 'https://example.com/news', snippet: 'News snippet' },
			],
		});
	});

	it('passes documented v2 options and normalizes images and news', async () => {
		fetch_mock.mockResolvedValue(
			new Response(
				JSON.stringify({
					success: true,
					id: 'search-2',
					creditsUsed: 4,
					data: {
						web: [],
						images: [
							{
								title: 'Image result',
								url: 'https://example.com/image-page',
								imageUrl: 'https://example.com/image.png',
								imageWidth: 640,
								imageHeight: 480,
							},
						],
						news: [
							{
								title: 'News result',
								url: 'https://example.com/news',
								snippet: 'News snippet',
								date: '2026-06-17',
							},
						],
					},
				}),
				{
					status: 200,
					headers: { 'Content-Type': 'application/json' },
				},
			),
		);

		const provider = new FirecrawlSearchProvider();
		const result = await provider.process_content(
			'agent search',
			'advanced',
			{
				limit: 7,
				sources: ['web', 'images', 'news'],
				categories: ['developer', 'research'],
				country: 'US',
				location: 'San Francisco,California,United States',
				tbs: 'qdr:w',
				includeDomains: ['example.com'],
				ignoreInvalidURLs: true,
				scrapeOptions: { redactPII: true },
			},
		);

		const body = JSON.parse(fetch_mock.mock.calls[0][1].body);
		expect(body).toMatchObject({
			limit: 7,
			sources: ['web', 'images', 'news'],
			categories: ['developer', 'research'],
			country: 'US',
			location: 'San Francisco,California,United States',
			tbs: 'qdr:w',
			includeDomains: ['example.com'],
			ignoreInvalidURLs: true,
			scrapeOptions: {
				formats: ['markdown'],
				onlyMainContent: true,
				redactPII: true,
			},
		});
		expect(result.content).toContain('News snippet');
		expect(result.content).toContain('https://example.com/image.png');
		expect(result.metadata.source_counts).toEqual({
			web: 0,
			images: 1,
			news: 1,
		});
	});

	it('parses current highlight and plain-description web results', async () => {
		fetch_mock.mockResolvedValue(
			new Response(
				JSON.stringify({
					success: true,
					data: {
						web: [
							{
								title: 'Highlighted result',
								url: 'https://example.com/highlights',
								description:
									'# Relevant heading\nRelevant highlighted passage.',
							},
							{
								title: 'Plain result',
								url: 'https://example.com/plain',
								description: 'Plain search description.',
								category: 'research',
							},
						],
					},
				}),
				{
					status: 200,
					headers: { 'Content-Type': 'application/json' },
				},
			),
		);

		const result =
			await new FirecrawlSearchProvider().process_content(
				'academic websites',
				'basic',
				{
					categories: ['research'],
					scrapeOptions: { formats: [], onlyMainContent: false },
				},
			);

		expect(result.raw_contents).toEqual([
			{
				url: 'https://example.com/highlights',
				content: '# Relevant heading\nRelevant highlighted passage.',
			},
			{
				url: 'https://example.com/plain',
				content: 'Plain search description.',
			},
		]);
		expect(result.content).toContain('Category: research');
		expect(result.metadata.source_counts).toEqual({
			web: 2,
			images: 0,
			news: 0,
		});
	});

	it('sends developer and gov categories in the request body', async () => {
		fetch_mock.mockImplementation(
			async () =>
				new Response(
					JSON.stringify({
						success: true,
						data: {
							web: [
								{
									url: 'https://example.com/issue',
									description: 'Issue text',
									category: 'developer',
								},
							],
						},
					}),
				),
		);

		await new FirecrawlSearchProvider().process_content(
			'client bug',
			'basic',
			{ categories: ['developer'] },
		);
		expect(
			JSON.parse(fetch_mock.mock.calls.at(-1)![1].body).categories,
		).toEqual(['developer']);

		await new FirecrawlSearchProvider().process_content(
			'privacy statute',
			'basic',
			{ categories: ['gov'] },
		);
		expect(
			JSON.parse(fetch_mock.mock.calls.at(-1)![1].body).categories,
		).toEqual(['gov']);
	});

	it('normalizes research index paper records into results', async () => {
		fetch_mock.mockResolvedValue(
			new Response(
				JSON.stringify({
					success: true,
					data: {
						research: [
							{
								paperId: 'paper-1',
								primaryId: 'arxiv:2401.00001',
								ids: { arxiv: '2401.00001' },
								title: 'Retrieval Paper',
								abstract: 'We study retrieval.',
								score: 0.91,
								extra_field: 'kept',
							},
							{
								paperId: 'paper-2',
								title: null,
								abstract: null,
								score: null,
								url: 'https://example.com/paper-2',
							},
							{ title: 'Anonymous record' },
						],
					},
				}),
			),
		);

		const result =
			await new FirecrawlSearchProvider().process_content(
				'retrieval',
				'basic',
				{ categories: ['research'] },
			);

		expect(result.raw_contents).toEqual([
			{
				url: 'research:arxiv:2401.00001',
				content: 'We study retrieval.',
			},
			{
				url: 'https://example.com/paper-2',
				content: 'No content extracted',
			},
			{
				url: 'research:result-3',
				content: 'No content extracted',
			},
		]);
		expect(result.content).toContain('## Retrieval Paper');
		expect(result.content).toContain(
			'Source: research:arxiv:2401.00001',
		);
		expect(result.content).toContain('Score: 0.91');
		expect(result.metadata).toMatchObject({
			urls_processed: 3,
			source_counts: { web: 0, images: 0, news: 0, research: 3 },
		});
		expect(result.metadata.documents.research).toHaveLength(3);
		expect(result.metadata.documents.research[0]).toMatchObject({
			paperId: 'paper-1',
			ids: { arxiv: '2401.00001' },
			score: 0.91,
			extra_field: 'kept',
		});
		expect(result.metadata).not.toHaveProperty('provider_warnings');
	});

	it('surfaces provider warnings as bounded metadata strings', async () => {
		fetch_mock.mockResolvedValue(
			new Response(
				JSON.stringify({
					success: true,
					warnings: [
						'The research category will change on 2026-11-16.',
						{ message: 'Object warning message' },
						{ code: 'deprecated', detail: 42 },
						'x'.repeat(2000),
						...Array.from({ length: 20 }, (_, i) => `extra ${i}`),
					],
					data: {
						web: [
							{ url: 'https://example.com', description: 'Body' },
						],
					},
				}),
			),
		);

		const result =
			await new FirecrawlSearchProvider().process_content(
				'query',
				'basic',
				{ categories: ['research'] },
			);

		const warnings = result.metadata.provider_warnings;
		expect(warnings).toHaveLength(10);
		expect(warnings.slice(0, 3)).toEqual([
			'The research category will change on 2026-11-16.',
			'Object warning message',
			'{"code":"deprecated","detail":42}',
		]);
		expect(warnings[3]).toHaveLength(500);
		expect(
			warnings.every((w: unknown) => typeof w === 'string'),
		).toBe(true);
	});

	it('rejects malformed web collections without exposing payload values', async () => {
		const sentinel = 'search-payload-secret-must-not-leak';
		fetch_mock.mockResolvedValue(
			new Response(
				JSON.stringify({
					success: true,
					data: { web: { sentinel } },
				}),
				{
					status: 200,
					headers: { 'Content-Type': 'application/json' },
				},
			),
		);

		let thrown: unknown;
		try {
			await new FirecrawlSearchProvider().process_content('query');
		} catch (error) {
			thrown = error;
		}

		expect(thrown).toMatchObject({
			type: ErrorType.PROVIDER_ERROR,
			provider: 'firecrawl_search',
			message: 'Malformed firecrawl_search response',
			details: { retryable: false },
		});
		expect(JSON.stringify(thrown)).not.toContain(sentinel);
		expect(fetch_mock).toHaveBeenCalledTimes(1);
	});

	it('preserves screenshot and structured formats for search hits', async () => {
		const web = [
			{
				url: 'https://example.test',
				json: { nested: [null, false, 42] },
				screenshot: 'https://images.test/shot.png',
			},
		];
		fetch_mock.mockImplementation(
			async () =>
				new Response(
					JSON.stringify({ success: true, data: { web } }),
				),
		);
		const result =
			await new FirecrawlSearchProvider().process_content(
				'query',
				'basic',
				{
					scrapeOptions: {
						formats: ['screenshot', { type: 'json' }],
					},
				},
			);
		expect(result.metadata.documents.web).toEqual(web);
	});

	it('rejects unsupported scrape formats before searching', async () => {
		await expect(
			new FirecrawlSearchProvider().process_content(
				'query',
				'basic',
				{ scrapeOptions: { formats: ['unsupported-format'] } },
			),
		).rejects.toMatchObject({ type: 'INVALID_INPUT' });
		expect(fetch_mock).not.toHaveBeenCalled();
	});

	it('rejects mutually exclusive domain filters', async () => {
		const provider = new FirecrawlSearchProvider();
		await expect(
			provider.process_content('query', 'basic', {
				includeDomains: ['example.com'],
				excludeDomains: ['example.org'],
			}),
		).rejects.toThrow(
			'includeDomains and excludeDomains cannot both be set',
		);
		expect(fetch_mock).not.toHaveBeenCalled();
	});
});
