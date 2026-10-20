import {
	afterEach,
	beforeEach,
	describe,
	expect,
	it,
	vi,
} from 'vitest';
import { run_with_request_context } from '../../../common/request_context.js';
import { config } from '../../../config/env.js';
import { ContextHighlightsProvider } from './index.js';

const fetch_mock = vi.fn();
const previous = { ...config.processing.context_highlights };
const first = 'https://example.com/a';
const second = 'https://example.com/b';

const page = (overrides: Record<string, unknown> = {}) => ({
	url: first,
	highlights: {
		requested: true,
		success: true,
		data: ['[Intro] First passage.', 'Second passage.'],
	},
	markdown: { requested: false, success: null, data: null },
	metadata: { title: 'Example Page' },
	...overrides,
});
const respond = (body: unknown) =>
	fetch_mock.mockImplementation(
		async () => new Response(JSON.stringify(body), { status: 200 }),
	);
const respond_by_url = (
	pages: Record<string, unknown>,
	fallback: unknown = page(),
) =>
	fetch_mock.mockImplementation(async (_target, init) => {
		const { url } = JSON.parse(init.body);
		return new Response(JSON.stringify(pages[url] ?? fallback), {
			status: 200,
		});
	});
const bodies = () =>
	fetch_mock.mock.calls
		.map(([, init]) => JSON.parse(init.body))
		.sort((a, b) => a.url.localeCompare(b.url));

describe('ContextHighlightsProvider highlights', () => {
	beforeEach(() => {
		fetch_mock.mockReset();
		vi.stubGlobal('fetch', fetch_mock);
		config.processing.context_highlights.api_key = 'context-test-key';
	});

	afterEach(() => {
		Object.assign(config.processing.context_highlights, previous);
		vi.unstubAllGlobals();
		vi.restoreAllMocks();
	});

	it('sends one documented scrape request per URL', async () => {
		respond(page());
		await new ContextHighlightsProvider().process_content(
			[first, second],
			'basic',
			{ query: '  pricing tiers  ' },
		);

		expect(fetch_mock).toHaveBeenCalledTimes(2);
		for (const [target, init] of fetch_mock.mock.calls) {
			expect(target).toBe(`${previous.base_url}/web/scrape`);
			expect(init.method).toBe('POST');
			expect(init.headers).toMatchObject({
				Authorization: 'Bearer context-test-key',
			});
		}
		expect(bodies()).toEqual([
			{
				url: first,
				formats: { highlights: true },
				highlightsParams: {
					query: 'pricing tiers',
					maxCharacters: 4000,
				},
			},
			{
				url: second,
				formats: { highlights: true },
				highlightsParams: {
					query: 'pricing tiers',
					maxCharacters: 4000,
				},
			},
		]);
	});

	it('widens the highlight budget for advanced depth', async () => {
		respond(page());
		await new ContextHighlightsProvider().process_content(
			first,
			'advanced',
			{ query: 'pricing' },
		);

		expect(bodies()[0].highlightsParams.maxCharacters).toBe(10000);
	});

	it('returns passages as content with highlight metadata', async () => {
		respond_by_url({
			[first]: page(),
			[second]: page({
				url: second,
				highlights: {
					requested: true,
					success: true,
					data: ['Only passage.'],
				},
				metadata: { title: 'Second Page' },
			}),
		});
		const result =
			await new ContextHighlightsProvider().process_content(
				[first, second],
				'basic',
				{ query: 'passages' },
			);

		expect(result.source_provider).toBe('context_highlights');
		expect(result.raw_contents).toEqual([
			{
				url: first,
				content: '[Intro] First passage.\n\nSecond passage.',
			},
			{ url: second, content: 'Only passage.' },
		]);
		expect(result.content).toBe(
			'[Intro] First passage.\n\nSecond passage.\n\nOnly passage.',
		);
		expect(result.metadata).toMatchObject({
			title: 'Example Page',
			mode: 'highlights',
			urls_processed: 2,
			successful_extractions: 2,
			extract_depth: 'basic',
			documents: [
				{
					url: first,
					title: 'Example Page',
					highlights_success: true,
					highlights_count: 2,
				},
				{
					url: second,
					title: 'Second Page',
					highlights_success: true,
					highlights_count: 1,
				},
			],
		});
		expect(result.metadata.failed_urls).toBeUndefined();
		expect(result.metadata.failures).toBeUndefined();
	});

	it('treats an empty passage list as a valid no-match page', async () => {
		respond(
			page({
				highlights: { requested: true, success: true, data: [] },
			}),
		);
		const result =
			await new ContextHighlightsProvider().process_content(
				first,
				'basic',
				{ query: 'unrelated' },
			);

		expect(result.raw_contents).toEqual([
			{ url: first, content: '' },
		]);
		expect(result.metadata.documents).toEqual([
			{
				url: first,
				title: 'Example Page',
				highlights_success: true,
				highlights_count: 0,
			},
		]);
	});

	it('keeps only non-blank string passages', async () => {
		respond(
			page({
				highlights: {
					requested: true,
					success: true,
					data: ['Kept.', 7, null, '  ', { text: 'x' }, 'Also.'],
				},
			}),
		);
		const result =
			await new ContextHighlightsProvider().process_content(
				first,
				'basic',
				{ query: 'mixed' },
			);

		expect(result.content).toBe('Kept.\n\nAlso.');
		expect(result.metadata.documents[0].highlights_count).toBe(2);
	});

	it('reports a page with failed highlights as a failed URL and keeps the others', async () => {
		respond_by_url({
			[first]: page({
				highlights: {
					requested: true,
					success: false,
					data: null,
					error_code: 'WEBSITE_BLOCKED',
				},
			}),
			[second]: page({ url: second }),
		});
		const result =
			await new ContextHighlightsProvider().process_content(
				[first, second],
				'basic',
				{ query: 'blocked' },
			);

		expect(result.raw_contents?.map((item) => item.url)).toEqual([
			second,
		]);
		expect(result.metadata).toMatchObject({
			urls_processed: 2,
			successful_extractions: 1,
			failed_urls: [first],
			failures: [{ url: first, error_code: 'WEBSITE_BLOCKED' }],
		});
	});

	it('drops a provider error code that is not a plain identifier', async () => {
		respond_by_url({
			[first]: page({
				highlights: {
					requested: true,
					success: false,
					data: null,
					error_code: 'Bearer CONTROL_CANARY',
				},
			}),
		});
		const result =
			await new ContextHighlightsProvider().process_content(
				[first, second],
				'basic',
				{ query: 'canary' },
			);

		expect(JSON.stringify(result)).not.toContain('CONTROL_CANARY');
		expect(result.metadata.failures).toEqual([{ url: first }]);
	});

	it.each([
		[
			'success false',
			{ requested: true, success: false, data: null },
		],
		['success null', { requested: true, success: null, data: null }],
		[
			'not requested',
			{ requested: false, success: null, data: null },
		],
		['null output', null],
		['missing output', undefined],
	])(
		'fails when every page has unusable highlights: %s',
		async (_label, highlights) => {
			respond(page({ highlights }));
			await expect(
				new ContextHighlightsProvider().process_content(
					first,
					'basic',
					{ query: 'unusable' },
				),
			).rejects.toMatchObject({
				type: 'PROVIDER_ERROR',
				provider: 'context_highlights',
				message: 'Failed to extract content from all URLs',
			});
		},
	);

	it('treats non-array highlight data as a failed page, not a no-match', async () => {
		respond_by_url({
			[first]: page({
				highlights: {
					requested: true,
					success: true,
					data: 'plain text',
				},
			}),
		});
		const result =
			await new ContextHighlightsProvider().process_content(
				[first, second],
				'basic',
				{ query: 'shape' },
			);

		expect(result.metadata.failed_urls).toEqual([first]);
		expect(result.raw_contents?.map((item) => item.url)).toEqual([
			second,
		]);
	});

	it.each([
		['missing', undefined],
		['blank', '   '],
		['non-string', 42],
	])('requires a query for highlights: %s', async (_label, query) => {
		await expect(
			new ContextHighlightsProvider().process_content(
				first,
				'basic',
				query === undefined ? {} : { query },
			),
		).rejects.toMatchObject({
			type: 'INVALID_INPUT',
			provider: 'context_highlights',
		});
		await expect(
			new ContextHighlightsProvider().process_content(first),
		).rejects.toMatchObject({ type: 'INVALID_INPUT' });
		expect(fetch_mock).not.toHaveBeenCalled();
	});

	it('bounds the query at 2000 characters', async () => {
		await expect(
			new ContextHighlightsProvider().process_content(
				first,
				'basic',
				{ query: 'q'.repeat(2001) },
			),
		).rejects.toMatchObject({ type: 'INVALID_INPUT' });
		expect(fetch_mock).not.toHaveBeenCalled();

		respond(page());
		await new ContextHighlightsProvider().process_content(
			first,
			'basic',
			{ query: 'q'.repeat(2000) },
		);
		expect(bodies()[0].highlightsParams.query).toHaveLength(2000);
	});

	it('requires an API key before networking', async () => {
		config.processing.context_highlights.api_key = undefined;
		await expect(
			new ContextHighlightsProvider().process_content(
				first,
				'basic',
				{ query: 'no key' },
			),
		).rejects.toMatchObject({ type: 'INVALID_INPUT' });
		expect(fetch_mock).not.toHaveBeenCalled();
	});

	it.each([
		'exa-result-id',
		'http://localhost/',
		'http://169.254.169.254/',
		'file:///etc/passwd',
		'https://user:PRIVATE_URL_CANARY@example.com/',
	])(
		'rejects the unsafe target %s before networking',
		async (target) => {
			const failure = await new ContextHighlightsProvider()
				.process_content([first, target], 'basic', { query: 'safe' })
				.catch((error) => error);

			expect(failure).toMatchObject({ type: 'INVALID_INPUT' });
			expect(JSON.stringify(failure.message)).not.toContain(
				'PRIVATE_URL_CANARY',
			);
			expect(fetch_mock).not.toHaveBeenCalled();
		},
	);

	it('accepts 20 URLs and rejects 21 or none', async () => {
		respond(page());
		const urls = Array.from(
			{ length: 20 },
			(_, index) => `https://example.com/${index}`,
		);
		await new ContextHighlightsProvider().process_content(
			urls,
			'basic',
			{ query: 'many' },
		);
		expect(fetch_mock).toHaveBeenCalledTimes(20);

		fetch_mock.mockClear();
		for (const invalid of [[...urls, 'https://example.com/20'], []]) {
			await expect(
				new ContextHighlightsProvider().process_content(
					invalid,
					'basic',
					{ query: 'many' },
				),
			).rejects.toMatchObject({ type: 'INVALID_INPUT' });
		}
		expect(fetch_mock).not.toHaveBeenCalled();
	});

	it('runs at most four scrapes at once', async () => {
		let in_flight = 0;
		let peak = 0;
		fetch_mock.mockImplementation(async () => {
			in_flight++;
			peak = Math.max(peak, in_flight);
			await new Promise((resolve) => setTimeout(resolve, 5));
			in_flight--;
			return new Response(JSON.stringify(page()), { status: 200 });
		});
		const urls = Array.from(
			{ length: 9 },
			(_, index) => `https://example.com/${index}`,
		);
		await new ContextHighlightsProvider().process_content(
			urls,
			'basic',
			{ query: 'concurrency' },
		);

		expect(fetch_mock).toHaveBeenCalledTimes(9);
		expect(peak).toBeGreaterThan(1);
		expect(peak).toBeLessThanOrEqual(4);
	});

	it('records a transient failure for one URL without retrying it', async () => {
		fetch_mock.mockImplementation(async (_target, init) => {
			const { url } = JSON.parse(init.body);
			return url === first
				? new Response('{}', { status: 503 })
				: new Response(JSON.stringify(page({ url })), {
						status: 200,
					});
		});
		const result =
			await new ContextHighlightsProvider().process_content(
				[first, second],
				'basic',
				{ query: 'transient' },
			);

		expect(fetch_mock).toHaveBeenCalledTimes(2);
		expect(result.metadata.failed_urls).toEqual([first]);
		expect(result.raw_contents?.map((item) => item.url)).toEqual([
			second,
		]);
	});

	it.each([
		[401, 'Invalid API key'],
		[402, 'Provider credits exhausted or payment required'],
	])(
		'fails the whole call on HTTP %s without a second request',
		async (status, message) => {
			fetch_mock.mockImplementation(
				async () => new Response('{}', { status }),
			);
			await expect(
				new ContextHighlightsProvider().process_content(
					first,
					'basic',
					{ query: 'auth' },
				),
			).rejects.toMatchObject({ message });
			expect(fetch_mock).toHaveBeenCalledTimes(1);
		},
	);

	it('does not expose the API key in the result', async () => {
		respond(page());
		const result =
			await new ContextHighlightsProvider().process_content(
				first,
				'basic',
				{ query: 'secret' },
			);

		expect(JSON.stringify(result)).not.toContain('context-test-key');
	});

	it('stops before networking when the caller already cancelled', async () => {
		const controller = new AbortController();
		controller.abort();
		await expect(
			run_with_request_context(controller.signal, () =>
				new ContextHighlightsProvider().process_content(
					[first, second],
					'basic',
					{ query: 'cancel' },
				),
			),
		).rejects.toMatchObject({ message: 'Operation cancelled' });
		expect(fetch_mock).not.toHaveBeenCalled();
	});
});

describe('ContextHighlightsProvider markdown', () => {
	beforeEach(() => {
		fetch_mock.mockReset();
		vi.stubGlobal('fetch', fetch_mock);
		config.processing.context_highlights.api_key = 'context-test-key';
	});

	afterEach(() => {
		Object.assign(config.processing.context_highlights, previous);
		vi.unstubAllGlobals();
		vi.restoreAllMocks();
	});

	const markdown_page = (data: unknown = '# Title\n\nBody text.') =>
		page({
			highlights: { requested: false, success: null, data: null },
			markdown: { requested: true, success: true, data },
		});

	it('requests plain markdown without a query', async () => {
		respond(markdown_page());
		const result = await new ContextHighlightsProvider(
			'markdown',
		).process_content(first);

		expect(bodies()).toEqual([
			{ url: first, formats: { markdown: true } },
		]);
		expect(result.content).toBe('# Title\n\nBody text.');
		expect(result.raw_contents).toEqual([
			{ url: first, content: '# Title\n\nBody text.' },
		]);
		expect(result.metadata).toMatchObject({
			mode: 'markdown',
			title: 'Example Page',
			successful_extractions: 1,
		});
	});

	it('ignores a supplied query', async () => {
		respond(markdown_page());
		await new ContextHighlightsProvider('markdown').process_content(
			first,
			'basic',
			{ query: 'ignored' },
		);

		expect(bodies()[0]).not.toHaveProperty('highlightsParams');
	});

	it.each([
		['blank markdown', markdown_page('  ')],
		['non-string markdown', markdown_page(42)],
		[
			'failed markdown',
			page({
				markdown: {
					requested: true,
					success: false,
					data: null,
					error_code: 'TIMEOUT',
				},
			}),
		],
		['highlights only', page()],
	])(
		'fails the page when markdown is unusable: %s',
		async (_label, body) => {
			respond(body);
			await expect(
				new ContextHighlightsProvider('markdown').process_content(
					first,
				),
			).rejects.toMatchObject({
				type: 'PROVIDER_ERROR',
				message: 'Failed to extract content from all URLs',
			});
		},
	);

	it('still validates URLs and the API key', async () => {
		await expect(
			new ContextHighlightsProvider('markdown').process_content(
				'http://127.0.0.1/',
			),
		).rejects.toMatchObject({ type: 'INVALID_INPUT' });
		config.processing.context_highlights.api_key = undefined;
		await expect(
			new ContextHighlightsProvider('markdown').process_content(
				first,
			),
		).rejects.toMatchObject({ type: 'INVALID_INPUT' });
		expect(fetch_mock).not.toHaveBeenCalled();
	});
});
