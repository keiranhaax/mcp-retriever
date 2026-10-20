import {
	afterEach,
	beforeEach,
	describe,
	expect,
	it,
	vi,
} from 'vitest';
import { config } from '../../../config/env.js';
import { ContextSearchProvider } from './index.js';

const fetch_mock = vi.fn();
const previous = { ...config.search.context_dev };

const respond = (body: unknown) =>
	fetch_mock.mockResolvedValue(
		new Response(JSON.stringify(body), { status: 200 }),
	);
const sent = () => {
	const [url, init] = fetch_mock.mock.calls[0];
	return { url, init, body: JSON.parse(init.body) };
};
const hit = (overrides: Record<string, unknown> = {}) => ({
	url: 'https://example.com/a',
	title: 'Example A',
	description: 'Plain description',
	relevance: 'high',
	highlights: {
		code: 'SUCCESS',
		highlights: ['First passage.', 'Second passage.'],
	},
	...overrides,
});

describe('ContextSearchProvider', () => {
	beforeEach(() => {
		fetch_mock.mockReset();
		vi.stubGlobal('fetch', fetch_mock);
		config.search.context_dev.api_key = 'context-test-key';
	});

	afterEach(() => {
		Object.assign(config.search.context_dev, previous);
		vi.unstubAllGlobals();
		vi.restoreAllMocks();
	});

	it('sends the documented search body with highlights enabled', async () => {
		respond({ results: [hit()] });
		await new ContextSearchProvider().search({
			query: '  line one\nline two  ',
		});

		const { url, init, body } = sent();
		expect(url).toBe(`${previous.base_url}/web/search`);
		expect(init.method).toBe('POST');
		expect(init.headers).toMatchObject({
			Authorization: 'Bearer context-test-key',
		});
		expect(body).toEqual({
			query: 'line one line two',
			numResults: 10,
			highlightsOptions: { enabled: true, maxCharacters: 1500 },
		});
		expect(body).not.toHaveProperty('markdownOptions');
	});

	it('maps limit and domain filters', async () => {
		respond({ results: [] });
		await new ContextSearchProvider().search({
			query: 'filters',
			limit: 25,
			include_domains: ['example.com'],
			exclude_domains: ['example.org'],
		});

		expect(sent().body).toMatchObject({
			numResults: 25,
			includeDomains: ['example.com'],
			excludeDomains: ['example.org'],
		});
	});

	it('omits empty domain filters', async () => {
		respond({ results: [] });
		await new ContextSearchProvider().search({
			query: 'filters',
			include_domains: [],
			exclude_domains: [],
		});

		const { body } = sent();
		expect(body).not.toHaveProperty('includeDomains');
		expect(body).not.toHaveProperty('excludeDomains');
		expect(body).not.toHaveProperty('freshness');
	});

	it.each([
		['day', 'last_24_hours'],
		['week', 'last_week'],
		['month', 'last_month'],
		['year', 'last_year'],
	] as const)(
		'maps time_range %s to freshness %s',
		async (time_range, freshness) => {
			respond({ results: [] });
			await new ContextSearchProvider().search({
				query: 'recent',
				time_range,
			});

			expect(sent().body.freshness).toBe(freshness);
		},
	);

	it('uses joined highlight passages as the snippet', async () => {
		respond({ results: [hit()], partial: false });
		const results = await new ContextSearchProvider().search({
			query: 'passages',
		});

		expect(results).toEqual([
			{
				title: 'Example A',
				url: 'https://example.com/a',
				snippet: 'First passage.\n\nSecond passage.',
				source_provider: 'context',
				metadata: {
					highlights_code: 'SUCCESS',
					highlights_count: 2,
					relevance: 'high',
				},
			},
		]);
	});

	it.each([
		'TIMEOUT',
		'CONTENT_TOO_LARGE',
		'WEBSITE_ACCESS_ERROR',
		'WEBSITE_BLOCKED',
		'ERROR',
		'NOT_REQUESTED',
		'UNLISTED_FUTURE_CODE',
	])(
		'falls back to the description when highlights code is %s',
		async (code) => {
			respond({
				results: [
					hit({
						highlights: { code, highlights: ['Must not be used.'] },
					}),
				],
			});
			const [result] = await new ContextSearchProvider().search({
				query: 'fallback',
			});

			expect(result.snippet).toBe('Plain description');
			expect(result.metadata).toMatchObject({
				highlights_code: code,
				highlights_count: 0,
			});
		},
	);

	it.each([
		['an empty passage list', { code: 'SUCCESS', highlights: [] }],
		[
			'only blank passages',
			{ code: 'SUCCESS', highlights: ['  ', ''] },
		],
		[
			'only non-string passages',
			{ code: 'SUCCESS', highlights: [1, null, { text: 'x' }] },
		],
		['missing highlights', undefined],
		['null highlights', null],
	])(
		'falls back to the description for %s',
		async (_label, highlights) => {
			respond({ results: [hit({ highlights })] });
			const [result] = await new ContextSearchProvider().search({
				query: 'fallback',
			});

			expect(result.snippet).toBe('Plain description');
			expect(result.metadata?.highlights_count).toBe(0);
		},
	);

	it('keeps only string passages from a mixed list', async () => {
		respond({
			results: [
				hit({
					highlights: {
						code: 'SUCCESS',
						highlights: ['Kept.', 42, null, ' ', 'Also kept.'],
					},
				}),
			],
		});
		const [result] = await new ContextSearchProvider().search({
			query: 'mixed',
		});

		expect(result.snippet).toBe('Kept.\n\nAlso kept.');
		expect(result.metadata?.highlights_count).toBe(2);
	});

	it('uses a placeholder snippet and URL title when nothing is available', async () => {
		respond({
			results: [
				{ url: 'https://example.com/bare', title: null },
				{ url: 'https://example.com/empty', description: '  ' },
			],
		});
		const results = await new ContextSearchProvider().search({
			query: 'bare',
		});

		expect(results.map((item) => item.title)).toEqual([
			'https://example.com/bare',
			'https://example.com/empty',
		]);
		expect(results.map((item) => item.snippet)).toEqual([
			'No content available',
			'No content available',
		]);
	});

	it('drops results without a URL and tolerates an empty body', async () => {
		respond({
			results: [hit({ url: null }), hit({ url: '  ' }), hit()],
		});
		const results = await new ContextSearchProvider().search({
			query: 'urls',
		});
		expect(results.map((item) => item.url)).toEqual([
			'https://example.com/a',
		]);

		respond({});
		await expect(
			new ContextSearchProvider().search({ query: 'none' }),
		).resolves.toEqual([]);
	});

	it('flags partial responses in result metadata', async () => {
		respond({ results: [hit()], partial: true });
		const [result] = await new ContextSearchProvider().search({
			query: 'partial',
		});

		expect(result.metadata?.partial).toBe(true);
	});

	it.each(['', '   ', 'q'.repeat(501)])(
		'rejects an unusable query before networking: length %#',
		async (query) => {
			await expect(
				new ContextSearchProvider().search({ query }),
			).rejects.toMatchObject({
				type: 'INVALID_INPUT',
				provider: 'context',
			});
			expect(fetch_mock).not.toHaveBeenCalled();
		},
	);

	it('accepts a query of exactly 500 characters', async () => {
		respond({ results: [] });
		await new ContextSearchProvider().search({
			query: 'q'.repeat(500),
		});

		expect(sent().body.query).toHaveLength(500);
	});

	it('requires an API key before networking', async () => {
		config.search.context_dev.api_key = undefined;
		await expect(
			new ContextSearchProvider().search({ query: 'no key' }),
		).rejects.toMatchObject({ type: 'INVALID_INPUT' });
		expect(fetch_mock).not.toHaveBeenCalled();
	});

	it('does not expose the API key in results', async () => {
		respond({ results: [hit()] });
		const results = await new ContextSearchProvider().search({
			query: 'secret',
		});

		expect(JSON.stringify(results)).not.toContain('context-test-key');
	});

	it('rejects a malformed response with a typed provider error', async () => {
		respond({ results: 'not-a-list' });
		await expect(
			new ContextSearchProvider().search({ query: 'malformed' }),
		).rejects.toMatchObject({
			type: 'PROVIDER_ERROR',
			provider: 'context',
		});
	});
});
