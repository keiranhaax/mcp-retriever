import {
	afterEach,
	beforeEach,
	describe,
	expect,
	it,
	vi,
} from 'vitest';
import { config } from '../../../config/env.js';
import { get_response_metadata } from '../../../common/response_metadata.js';
import { ExaSearchProvider } from './index.js';

const fetch_mock = vi.fn();
const previous_api_key = config.search.exa.api_key;

describe('ExaSearchProvider', () => {
	beforeEach(() => {
		fetch_mock.mockReset();
		vi.stubGlobal('fetch', fetch_mock);
		config.search.exa.api_key = 'exa-test-key';
	});

	afterEach(() => {
		config.search.exa.api_key = previous_api_key;
		vi.unstubAllGlobals();
		vi.restoreAllMocks();
	});

	it('allowlists costs and output envelopes without filtering extracted evidence', async () => {
		const url = 'https://example.com/docs?token=syntax&q=a%2Bb#math';
		const content = {
			token: 'source-token',
			api_key: 'example',
			nested: { config: { token: 'source' } },
		};
		const citation = {
			id: 'doc:1',
			url,
			text: '~~~js\nconst api_key = "example";\n~~~ $x^2$ [1]',
		};
		fetch_mock.mockResolvedValue(
			new Response(
				JSON.stringify({
					requestId: 'req-1',
					autopromptString: 'token and api_key syntax',
					searchType: 'auto',
					costDollars: {
						total: 0.007,
						search: {
							neural: 0.007,
							config: { api_key: 'CONTROL_CANARY' },
						},
						headers: { authorization: 'CONTROL_CANARY' },
						rawError: { message: 'CONTROL_CANARY' },
					},
					output: {
						content,
						grounding: [
							{
								field: 'token',
								citations: [
									{
										...citation,
										headers: { authorization: 'CONTROL_CANARY' },
									},
								],
								config: { token: 'CONTROL_CANARY' },
							},
						],
						config: { api_key: 'CONTROL_CANARY' },
					},
					results: [{ ...citation, title: 'API key syntax' }],
				}),
			),
		);
		const [result] = await new ExaSearchProvider().search({
			query: 'syntax',
		});
		expect(JSON.stringify(result)).not.toContain('CONTROL_CANARY');
		expect(result).toMatchObject({
			url,
			snippet: citation.text,
			metadata: {
				id: 'doc:1',
				requestId: 'req-1',
				autopromptString: 'token and api_key syntax',
				resolvedSearchType: 'auto',
				costDollars: { total: 0.007, search: { neural: 0.007 } },
				output: {
					content,
					grounding: [{ field: 'token', citations: [citation] }],
				},
			},
		});
	});

	it.each([
		'Bearer CONTROL_CANARY',
		'x'.repeat(129),
		{ config: 'CONTROL_CANARY' },
	])(
		'drops malformed request IDs and control strings: %j',
		async (requestId) => {
			fetch_mock.mockResolvedValue(
				new Response(
					JSON.stringify({
						requestId,
						searchType: 'CONTROL_CANARY',
						autopromptString: 'x'.repeat(4097),
						results: [{ url: 'https://example.com', text: 'source' }],
					}),
				),
			);
			const results = await new ExaSearchProvider().search({
				query: 'test',
			});
			const [result] = results;
			expect(get_response_metadata(results)).toBeUndefined();
			expect(result.metadata?.requestId).toBeUndefined();
			expect(result.metadata?.resolvedSearchType).toBeUndefined();
			expect(result.metadata?.autopromptString).toBeUndefined();
			expect(result.snippet).toBe('source');
		},
	);

	it.each([-1, '0.01', 1e100, null, { token: 'CONTROL_CANARY' }])(
		'drops malformed cost leaves without losing valid measurements: %j',
		async (total) => {
			fetch_mock.mockResolvedValue(
				new Response(
					JSON.stringify({
						costDollars: {
							total,
							contents: { text: 0.001, summary: total },
						},
						results: [{ url: 'https://example.com', text: 'source' }],
					}),
				),
			);
			const results = await new ExaSearchProvider().search({
				query: 'test',
			});
			const [result] = results;
			expect(get_response_metadata(results)).toBeUndefined();
			expect(result.metadata?.costDollars).toEqual({
				contents: { text: 0.001 },
			});
		},
	);

	it('attaches safe response metadata to the root array, including empty results', async () => {
		fetch_mock.mockResolvedValue(
			new Response(
				JSON.stringify({
					requestId: 'req-usage',
					costDollars: { total: 0.007 },
					results: [],
				}),
			),
		);
		const results = await new ExaSearchProvider().search({
			query: 'usage',
		});
		expect(results).toEqual([]);
		expect(get_response_metadata(results)).toEqual({
			request_id: 'req-usage',
			usage: { usd: 0.007 },
		});
	});

	it('uses auto search and text contents by default', async () => {
		fetch_mock.mockResolvedValue(
			new Response(
				JSON.stringify({
					requestId: 'req-1',
					results: [
						{
							id: 'doc-1',
							title: 'Doc',
							url: 'https://example.com',
							text: 'Text content',
						},
					],
				}),
				{
					status: 200,
					headers: { 'Content-Type': 'application/json' },
				},
			),
		);

		const provider = new ExaSearchProvider();
		const results = await provider.search({
			query: '  latest docs  ',
		});

		const body = JSON.parse(fetch_mock.mock.calls[0][1].body);
		expect(body).toEqual({
			query: 'latest docs',
			type: 'auto',
			numResults: 10,
			contents: { text: { maxCharacters: 1500 } },
		});
		expect(results[0]).toMatchObject({
			title: 'Doc',
			url: 'https://example.com',
			snippet: 'Text content',
			metadata: { requestId: 'req-1' },
		});
		expect(get_response_metadata(results)).toEqual({
			request_id: 'req-1',
		});
		expect(get_response_metadata(results[0])).toBeUndefined();
	});

	it('maps modern Exa fields into the search request', async () => {
		fetch_mock.mockResolvedValue(
			new Response(JSON.stringify({ results: [] }), {
				status: 200,
				headers: { 'Content-Type': 'application/json' },
			}),
		);

		const output_schema = {
			type: 'object',
			properties: { answer: { type: 'string' } },
		};

		const provider = new ExaSearchProvider();
		await provider.search({
			query: 'company research',
			limit: 5,
			include_domains: ['example.com'],
			search_type: 'deep-reasoning',
			category: 'company',
			user_location: 'US',
			contents: { summary: true },
			additional_queries: ['funding', 'headquarters'],
			output_schema,
			system_prompt: 'Return concise data.',
		});

		const body = JSON.parse(fetch_mock.mock.calls[0][1].body);
		expect(body).toEqual({
			query: 'company research',
			type: 'deep-reasoning',
			numResults: 5,
			includeDomains: ['example.com'],
			contents: { summary: true },
			additionalQueries: ['funding', 'headquarters'],
			category: 'company',
			userLocation: 'US',
			outputSchema: output_schema,
			systemPrompt: 'Return concise data.',
		});
	});

	it('sends only allowed parameters for lite search', async () => {
		fetch_mock.mockResolvedValue(
			new Response(JSON.stringify({ results: [] }), {
				status: 200,
				headers: { 'Content-Type': 'application/json' },
			}),
		);

		await new ExaSearchProvider().search({
			query: 'cached docs',
			limit: 3,
			search_type: 'lite',
			include_domains: ['example.com'],
			exclude_domains: ['spam.example'],
			category: 'news',
			user_location: 'US',
			contents: {
				highlights: true,
				text: { maxCharacters: 500 },
				snapshotAsOf: '2026-01-01T00:00:00.000Z',
			},
		});

		const body = JSON.parse(fetch_mock.mock.calls[0][1].body);
		expect(body).toEqual({
			query: 'cached docs',
			type: 'lite',
			numResults: 3,
			includeDomains: ['example.com'],
			excludeDomains: ['spam.example'],
			category: 'news',
			userLocation: 'US',
			contents: {
				highlights: true,
				text: { maxCharacters: 500 },
				snapshotAsOf: '2026-01-01T00:00:00.000Z',
			},
		});
	});

	it('keeps the default text contents for lite search', async () => {
		fetch_mock.mockResolvedValue(
			new Response(JSON.stringify({ results: [] }), { status: 200 }),
		);

		await new ExaSearchProvider().search({
			query: 'cached docs',
			search_type: 'lite',
		});

		const body = JSON.parse(fetch_mock.mock.calls[0][1].body);
		expect(body).toEqual({
			query: 'cached docs',
			type: 'lite',
			numResults: 10,
			contents: { text: { maxCharacters: 1500 } },
		});
	});

	it.each([
		['output_schema', { output_schema: { type: 'object' } }],
		['additional_queries', { additional_queries: ['funding'] }],
		['system_prompt', { system_prompt: 'Be brief.' }],
		['contents.summary', { contents: { summary: true } }],
		['contents.livecrawl', { contents: { livecrawl: 'always' } }],
	])(
		'rejects %s for lite search before calling Exa',
		async (parameter, extra) => {
			await expect(
				new ExaSearchProvider().search({
					query: 'cached docs',
					search_type: 'lite',
					...extra,
				}),
			).rejects.toMatchObject({
				type: 'INVALID_INPUT',
				provider: 'exa',
				details: { retryable: false },
				message: expect.stringContaining(parameter),
			});
			expect(fetch_mock).not.toHaveBeenCalled();
		},
	);

	it('names every unsupported lite parameter in one error', async () => {
		await expect(
			new ExaSearchProvider().search({
				query: 'cached docs',
				search_type: 'lite',
				output_schema: { type: 'object' },
				system_prompt: 'Be brief.',
			}),
		).rejects.toMatchObject({
			type: 'INVALID_INPUT',
			message: expect.stringMatching(/output_schema.*system_prompt/),
		});
		expect(fetch_mock).not.toHaveBeenCalled();
	});

	it('still allows lite-restricted parameters on other search types', async () => {
		fetch_mock.mockResolvedValue(
			new Response(JSON.stringify({ results: [] }), { status: 200 }),
		);

		await new ExaSearchProvider().search({
			query: 'deep research',
			search_type: 'deep',
			system_prompt: 'Be brief.',
			contents: { summary: true },
		});

		const body = JSON.parse(fetch_mock.mock.calls[0][1].body);
		expect(body).toMatchObject({
			type: 'deep',
			systemPrompt: 'Be brief.',
			contents: { summary: true },
		});
	});

	it('surfaces Exa notices and warnings in result metadata', async () => {
		fetch_mock.mockResolvedValue(
			new Response(
				JSON.stringify({
					notices: [
						'site: operator matched nothing and was dropped',
						{ message: 'Results came from cache' },
						{ code: 'x', detail: 'no message field' },
						{ message: 'y'.repeat(2000) },
						'',
						42,
					],
					warnings: ['contents.livecrawl was ignored'],
					results: [
						{ url: 'https://example.com/a', text: 'first' },
						{ url: 'https://example.com/b', text: 'second' },
					],
				}),
				{ status: 200 },
			),
		);

		const results = await new ExaSearchProvider().search({
			query: 'notices',
		});

		for (const result of results) {
			expect(result.metadata?.provider_warnings).toEqual([
				'contents.livecrawl was ignored',
			]);
			expect(result.metadata?.provider_notices).toEqual([
				'site: operator matched nothing and was dropped',
				'Results came from cache',
				JSON.stringify({ code: 'x', detail: 'no message field' }),
				'y'.repeat(500),
			]);
		}
	});

	it('caps the number of surfaced notices', async () => {
		fetch_mock.mockResolvedValue(
			new Response(
				JSON.stringify({
					notices: Array.from({ length: 50 }, (_, i) => `note ${i}`),
					results: [{ url: 'https://example.com', text: 'source' }],
				}),
				{ status: 200 },
			),
		);

		const [result] = await new ExaSearchProvider().search({
			query: 'many notices',
		});

		expect(result.metadata?.provider_notices).toHaveLength(10);
		expect(result.metadata?.provider_warnings).toBeUndefined();
	});

	it.each(['a string', { message: 'not an array' }, null])(
		'ignores malformed notices and warnings: %j',
		async (value) => {
			fetch_mock.mockResolvedValue(
				new Response(
					JSON.stringify({
						notices: value,
						warnings: value,
						results: [{ url: 'https://example.com', text: 'source' }],
					}),
					{ status: 200 },
				),
			);

			const [result] = await new ExaSearchProvider().search({
				query: 'malformed notices',
			});

			expect(result.snippet).toBe('source');
			expect(result.metadata?.provider_notices).toBeUndefined();
			expect(result.metadata?.provider_warnings).toBeUndefined();
		},
	);

	it('does not require resolvedSearchType or score in responses', async () => {
		fetch_mock.mockResolvedValue(
			new Response(
				JSON.stringify({
					results: [
						{
							title: 'No score',
							url: 'https://example.com/no-score',
							summary: 'Summary only',
						},
					],
				}),
				{
					status: 200,
					headers: { 'Content-Type': 'application/json' },
				},
			),
		);

		const provider = new ExaSearchProvider();
		const [result] = await provider.search({
			query: 'missing fields',
		});

		expect(result.score).toBeUndefined();
		expect(result.metadata?.resolvedSearchType).toBeUndefined();
		expect(result.snippet).toBe('Summary only');
	});

	it('maps the current searchType field without requiring its retired predecessor', async () => {
		fetch_mock.mockResolvedValue(
			new Response(
				JSON.stringify({
					searchType: 'auto',
					results: [
						{
							title: 'Current response',
							url: 'https://example.com/current',
							text: 'Current content',
						},
					],
				}),
				{
					status: 200,
					headers: { 'Content-Type': 'application/json' },
				},
			),
		);

		const [result] = await new ExaSearchProvider().search({
			query: 'current field',
		});

		expect(result.metadata?.resolvedSearchType).toBe('auto');
	});

	it('rejects a malformed results envelope as a provider error', async () => {
		fetch_mock.mockResolvedValue(
			new Response(
				JSON.stringify({ results: { unexpected: true } }),
				{ status: 200 },
			),
		);

		await expect(
			new ExaSearchProvider().search({ query: 'malformed' }),
		).rejects.toMatchObject({
			type: 'PROVIDER_ERROR',
			provider: 'exa',
			message: 'Malformed exa response',
		});
		expect(fetch_mock).toHaveBeenCalledTimes(1);
	});
});
