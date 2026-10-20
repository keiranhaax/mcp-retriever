import { describe, expect, it } from 'vitest';
import {
	sanitize_exa_control_metadata,
	sanitize_exa_grounding,
	sanitize_exa_output,
	sanitize_exa_statuses,
	sanitize_firecrawl_document,
} from './provider_sanitization.js';

describe('provider control sanitization', () => {
	it('keeps locally observed cost shapes and safe legacy controls', () => {
		expect(
			sanitize_exa_control_metadata({
				requestId: 'req_123-abc',
				autopromptString: 'token economics and api_key examples',
				searchType: 'auto',
				costDollars: {
					total: 0.01,
					search: {
						neural: 0.007,
						keyword: 0,
						config: { token: 'CONTROL_CANARY' },
					},
					contents: {
						text: 0.001,
						highlights: 0.001,
						summary: 0.001,
						rawError: { message: 'CONTROL_CANARY' },
					},
					headers: { authorization: 'CONTROL_CANARY' },
				},
				config: { api_key: 'CONTROL_CANARY' },
			}),
		).toEqual({
			requestId: 'req_123-abc',
			autopromptString: 'token economics and api_key examples',
			resolvedSearchType: 'auto',
			costDollars: {
				total: 0.01,
				search: { neural: 0.007, keyword: 0 },
				contents: { text: 0.001, highlights: 0.001, summary: 0.001 },
			},
		});
	});

	it.each([
		undefined,
		null,
		123,
		'',
		'Bearer CONTROL_CANARY',
		'req\nCONTROL_CANARY',
		'a'.repeat(129),
		{ token: 'CONTROL_CANARY' },
	])('drops malformed operational IDs: %j', (requestId) => {
		expect(
			sanitize_exa_control_metadata({ requestId }).requestId,
		).toBeUndefined();
	});

	it.each([NaN, Infinity, -Infinity, -1, 1e100, '0.1', null, {}, []])(
		'drops malformed cost measurements: %j',
		(value) => {
			const controls = sanitize_exa_control_metadata({
				costDollars: {
					total: value,
					search: { neural: value },
					contents: { text: value },
				},
			});
			expect(controls.costDollars).toBeUndefined();
		},
	);

	it('bounds controls without clipping identifiers or transformed queries', () => {
		const requestId = 'a'.repeat(128);
		const autopromptString = 'q'.repeat(4096);
		expect(
			sanitize_exa_control_metadata({
				requestId,
				autopromptString,
				costDollars: { total: 0 },
				resolvedSearchType: 'deep-reasoning',
			}),
		).toEqual({
			requestId,
			autopromptString,
			costDollars: { total: 0 },
			resolvedSearchType: 'deep-reasoning',
		});
		expect(
			sanitize_exa_control_metadata({
				requestId: requestId + 'a',
				autopromptString: autopromptString + 'q',
				resolvedSearchType: 'raw error CONTROL_CANARY',
				searchType: 'auto',
			}),
		).toEqual({ requestId: undefined, resolvedSearchType: 'auto' });
		expect(
			sanitize_exa_control_metadata({
				requestId,
				resolvedSearchType: 'lite',
			}),
		).toEqual({ requestId, resolvedSearchType: 'lite' });
		expect(
			sanitize_exa_control_metadata({
				requestId,
				searchType: 'deep-lite',
			}),
		).toEqual({ requestId, resolvedSearchType: 'deep-lite' });
	});

	it('projects only known grounding envelopes and preserves citation evidence', () => {
		const url =
			'https://example.com/search?q=a%2Bb&token=syntax#math';
		const citation = {
			id: 'doc:token/1',
			url,
			title: 'api_key = example',
			text: '~~~js\nconst token = 2;\n~~~\n$x^2$ [1]',
			publishedDate: null,
		};
		expect(
			sanitize_exa_grounding([
				{
					field: 'nested.api_key',
					confidence: 0.9,
					citations: [
						{
							...citation,
							headers: { authorization: 'CONTROL_CANARY' },
							config: { token: 'CONTROL_CANARY' },
							error: 'CONTROL_CANARY',
						},
					],
					rawError: { message: 'CONTROL_CANARY' },
				},
			]),
		).toEqual([
			{
				field: 'nested.api_key',
				confidence: 0.9,
				citations: [citation],
			},
		]);
	});

	it('keeps scalar citations and drops malformed grounding controls', () => {
		expect(
			sanitize_exa_grounding([
				{
					field: 'token',
					confidence: Infinity,
					citations: ['doc-1', 1],
				},
			]),
		).toEqual([{ field: 'token', citations: ['doc-1', 1] }]);
		expect(
			sanitize_exa_grounding({ config: 'CONTROL_CANARY' }),
		).toBeUndefined();
	});

	it('does not traverse extracted objects or treat user keys as credentials', () => {
		const content = JSON.parse(
			'{"token":"source","api_key":"example","nested":{"config":{"headers":{"authorization":"source example"}},"__proto__":{"token":"source"}}}',
		);
		const output = sanitize_exa_output({
			content,
			grounding: [],
			config: { token: 'CONTROL_CANARY' },
		});
		expect(output).toEqual({ content, grounding: [] });
		expect((output as { content: unknown }).content).toBe(content);
		// A non-envelope legacy extraction remains source data, not controls.
		expect(sanitize_exa_output(content)).toBe(content);
	});

	it.each([null, false, 0, '', ['token', { api_key: 'source' }]])(
		'preserves structured output values: %j',
		(content) => {
			expect(sanitize_exa_output({ content })).toEqual({ content });
		},
	);

	it('keeps meaningful status identifiers and locally known error codes', () => {
		const id = 'https://example.com/docs?token=syntax&q=a%2Bb';
		expect(
			sanitize_exa_statuses([
				{
					id,
					status: 'error',
					source: 'crawled',
					error: {
						tag: 'CRAWL_NOT_FOUND',
						httpStatusCode: 404,
						rawError: { message: 'CONTROL_CANARY' },
					},
					headers: { authorization: 'CONTROL_CANARY' },
				},
			]),
		).toEqual([
			{
				id,
				status: 'error',
				source: 'crawled',
				error: { tag: 'CRAWL_NOT_FOUND', httpStatusCode: 404 },
			},
		]);
	});

	it.each([NaN, Infinity, -1, 99, 600, 404.5, '404'])(
		'rejects non-HTTP error statuses: %j',
		(httpStatusCode) => {
			expect(
				sanitize_exa_statuses([
					{
						id: 'doc-1',
						status: 'error',
						error: { tag: 'Bearer CONTROL_CANARY', httpStatusCode },
					},
				]),
			).toEqual([{ id: 'doc-1', status: 'error', error: {} }]);
		},
	);

	it('preserves all supported Firecrawl evidence fields and nullable answers', () => {
		const source = {
			token: 'source',
			api_key: 'example',
			headers: { authorization: 'quoted example' },
		};
		const document = {
			markdown: '~~~js\nconst token = 1;\n~~~\n$x^2$ [1]',
			summary: 'API key syntax',
			html: '<code>api_key</code>',
			rawHtml: '<html>token</html>',
			links: ['https://example.com?q=a%2Bb&token=syntax'],
			screenshot: 'https://example.com/image.png?width=800',
			answer: null,
			highlights: null,
			json: source,
			llm_extraction: source,
		};
		const result = sanitize_firecrawl_document({
			...document,
			config: { api_key: 'CONTROL_CANARY' },
			rawError: { message: 'CONTROL_CANARY' },
			documents: [{ headers: { authorization: 'CONTROL_CANARY' } }],
		});
		expect(result).toEqual(document);
		expect(result.json).toBe(source);
		expect(result.llm_extraction).toBe(source);
	});

	it('retains page metadata and bounded operational metadata without raw diagnostics', () => {
		const metadata = {
			title: 'API token syntax',
			description: 'api_key = example',
			author: 'Author',
			language: 'en',
			sourceURL: 'https://example.com?q=a%2Bb&token=syntax',
			statusCode: 200,
			contentType: 'application/pdf',
			scrapeId: 'scrape-1',
			creditsUsed: 0,
			pageCount: 2,
			cacheState: 'hit',
			proxyUsed: 'basic',
			cachedAt: '2026-09-07T00:00:00Z',
		};
		expect(
			sanitize_firecrawl_document({
				metadata: {
					...metadata,
					headers: { authorization: 'CONTROL_CANARY' },
					config: { api_key: 'CONTROL_CANARY' },
					rawError: { message: 'CONTROL_CANARY' },
					arbitrary: 'CONTROL_CANARY',
				},
			}),
		).toEqual({ metadata });
	});

	it.each([
		NaN,
		Infinity,
		-1,
		1.5,
		1e100,
		'200',
		{ token: 'CONTROL_CANARY' },
	])('discards invalid Firecrawl measurements: %j', (value) => {
		expect(
			sanitize_firecrawl_document({
				metadata: {
					statusCode: value,
					creditsUsed: value,
					pageCount: value,
					scrapeId: 'a'.repeat(129),
					proxyUsed: 'Bearer CONTROL_CANARY',
					cacheState: { config: 'CONTROL_CANARY' },
					cachedAt: 'CONTROL_CANARY',
				},
			}),
		).toEqual({ metadata: {} });
	});

	it.each([
		'Authorization: Bearer CONTROL_CANARY',
		'x'.repeat(20000),
		{ config: { api_key: 'CONTROL_CANARY' } },
		['CONTROL_CANARY'],
	])(
		'summarizes provider warnings without copying their payload: %j',
		(warning) => {
			expect(sanitize_firecrawl_document({ warning })).toEqual({
				warning: 'Provider reported a scrape warning',
			});
		},
	);

	it.each([null, ''])(
		'preserves empty and null warning markers: %j',
		(warning) => {
			expect(sanitize_firecrawl_document({ warning })).toEqual({
				warning,
			});
		},
	);
});
