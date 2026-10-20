import {
	afterEach,
	beforeEach,
	describe,
	expect,
	it,
	vi,
} from 'vitest';
import { config } from '../../../config/env.js';
import { ContextAnswersProvider } from './index.js';

const fetch_mock = vi.fn();
const previous = { ...config.ai_response.context_answers };

const respond = (body: unknown) =>
	fetch_mock.mockResolvedValue(
		new Response(JSON.stringify(body), { status: 200 }),
	);
const sent = () => {
	const [url, init] = fetch_mock.mock.calls[0];
	return { url, init, body: JSON.parse(init.body) };
};

describe('ContextAnswersProvider', () => {
	beforeEach(() => {
		fetch_mock.mockReset();
		vi.stubGlobal('fetch', fetch_mock);
		config.ai_response.context_answers.api_key = 'context-test-key';
		config.ai_response.context_answers.timeout = 60000;
	});

	afterEach(() => {
		Object.assign(config.ai_response.context_answers, previous);
		vi.unstubAllGlobals();
		vi.restoreAllMocks();
	});

	it('sends a fast request by default with return-partial', async () => {
		respond({ json_content: { answer: 'ok' }, sources: [] });
		await new ContextAnswersProvider().search({
			query: '  line one\nline two  ',
		});

		const { url, init, body } = sent();
		expect(url).toBe(`${previous.base_url}/web/answers`);
		expect(init.method).toBe('POST');
		expect(init.headers).toMatchObject({
			Authorization: 'Bearer context-test-key',
		});
		expect(body).toEqual({
			mode: 'fast',
			task: 'line one line two',
			timeoutOpts: {
				milliseconds: 30000,
				behavior: 'return-partial',
			},
		});
		expect(body).not.toHaveProperty('json_format');
	});

	it('sends ultra mode with its longer research budget', async () => {
		respond({ json_content: { answer: 'ok' } });
		await new ContextAnswersProvider().search({
			query: 'deep question',
			context_mode: 'ultra',
		});

		expect(sent().body).toMatchObject({
			mode: 'ultra',
			timeoutOpts: { milliseconds: 50000 },
		});
	});

	it('keeps the research budget inside a short configured timeout', async () => {
		config.ai_response.context_answers.timeout = 8000;
		respond({ json_content: { answer: 'ok' } });
		await new ContextAnswersProvider().search({
			query: 'short budget',
			context_mode: 'ultra',
		});

		expect(sent().body.timeoutOpts).toEqual({
			milliseconds: 3000,
			behavior: 'return-partial',
		});
	});

	it('passes json_format through unchanged', async () => {
		const json_format = {
			name: 'Example Co',
			founded: 1999,
			products: ['one'],
		};
		respond({ json_content: json_format });
		await new ContextAnswersProvider().search({
			query: 'company facts',
			json_format,
		});

		expect(sent().body.json_format).toEqual(json_format);
	});

	it('omits an empty json_format', async () => {
		respond({ json_content: {} });
		await new ContextAnswersProvider().search({
			query: 'empty format',
			json_format: {},
		});

		expect(sent().body).not.toHaveProperty('json_format');
	});

	it('maps the answer and source URLs with descending scores', async () => {
		const json_content = { name: 'Example Co', founded: 1999 };
		respond({
			json_content,
			sources: [
				'https://example.com/about',
				'https://example.org/profile?id=1',
			],
		});
		const results = await new ContextAnswersProvider().search({
			query: 'company facts',
		});

		expect(results).toHaveLength(3);
		expect(results[0]).toMatchObject({
			title: 'Context.dev Answer',
			url: '',
			snippet: JSON.stringify(json_content, null, 2),
			score: 1.0,
			source_provider: 'context_answers',
			metadata: {
				type: 'ai_answer',
				mode: 'fast',
				partial: false,
				credits_mode: 10,
				sources_count: 2,
			},
		});
		expect(results[1]).toMatchObject({
			title: 'https://example.com/about',
			url: 'https://example.com/about',
			source_provider: 'context_answers',
			metadata: { type: 'source' },
		});
		expect(results[2].url).toBe('https://example.org/profile?id=1');
		expect(results[1].score ?? 0).toBeGreaterThan(
			results[2].score ?? 0,
		);
		expect(results[0].score ?? 0).toBeGreaterThan(
			results[1].score ?? 0,
		);
	});

	it('reports the ultra mode and credit cost in metadata', async () => {
		respond({ json_content: { answer: 'ok' } });
		const results = await new ContextAnswersProvider().search({
			query: 'ultra metadata',
			context_mode: 'ultra',
		});

		expect(results[0].metadata).toMatchObject({
			mode: 'ultra',
			credits_mode: 100,
		});
	});

	it('flags a partial answer', async () => {
		respond({
			json_content: { answer: 'incomplete' },
			sources: ['https://example.com/a'],
			partial: true,
		});
		const results = await new ContextAnswersProvider().search({
			query: 'partial answer',
		});

		expect(results[0].metadata?.partial).toBe(true);
	});

	it('tolerates missing or null sources', async () => {
		for (const sources of [undefined, null]) {
			fetch_mock.mockReset();
			respond({ json_content: { answer: 'ok' }, sources });
			const results = await new ContextAnswersProvider().search({
				query: `no sources ${String(sources)}`,
			});

			expect(results).toHaveLength(1);
			expect(results[0].metadata?.sources_count).toBe(0);
		}
	});

	it('keeps non-URL source records with a flag and drops junk entries', async () => {
		respond({
			json_content: { answer: 'ok' },
			sources: [
				'company:Example Co',
				'https://example.com/page',
				'',
				42,
				null,
			],
		});
		const results = await new ContextAnswersProvider().search({
			query: 'mixed sources',
		});

		expect(results).toHaveLength(3);
		expect(results[1]).toMatchObject({
			title: 'company:Example Co',
			url: '',
			metadata: { type: 'source_record' },
		});
		expect(results[2]).toMatchObject({
			url: 'https://example.com/page',
			metadata: { type: 'source' },
		});
	});

	it('does not treat non-http URLs as source links', async () => {
		respond({
			json_content: { answer: 'ok' },
			sources: ['javascript:alert(1)', 'file:///etc/passwd'],
		});
		const results = await new ContextAnswersProvider().search({
			query: 'unsafe sources',
		});

		expect(results.slice(1).map((r) => r.url)).toEqual(['', '']);
	});

	it('limits the number of source results', async () => {
		respond({
			json_content: { answer: 'ok' },
			sources: [
				'https://example.com/1',
				'https://example.com/2',
				'https://example.com/3',
			],
		});
		const results = await new ContextAnswersProvider().search({
			query: 'limited sources',
			limit: 2,
		});

		expect(results).toHaveLength(3);
		expect(results[0].metadata?.sources_count).toBe(3);
	});

	it('bounds very large answers and flags truncation', async () => {
		respond({ json_content: { text: 'x'.repeat(100000) } });
		const results = await new ContextAnswersProvider().search({
			query: 'large answer',
		});

		expect(results[0].snippet.length).toBe(50000);
		expect(results[0].metadata?.truncated).toBe(true);
	});

	it.each([
		{ sources: ['https://example.com'] },
		{ json_content: null },
		{ json_content: { answer: 'ok' }, partial: 'yes' },
		{
			json_content: { answer: 'ok' },
			sources: 'https://example.com',
		},
	])(
		'rejects a malformed response envelope as a provider error: %j',
		async (body) => {
			respond(body);
			await expect(
				new ContextAnswersProvider().search({
					query: `malformed ${JSON.stringify(body)}`,
				}),
			).rejects.toMatchObject({
				type: 'PROVIDER_ERROR',
				provider: 'context_answers',
				message: 'Malformed context_answers response',
			});
			expect(fetch_mock).toHaveBeenCalledTimes(1);
		},
	);

	it('does not retry a failed paid request', async () => {
		fetch_mock.mockResolvedValue(
			new Response(
				JSON.stringify({ code: 'INTERNAL_ERROR', message: 'boom' }),
				{ status: 500 },
			),
		);
		await expect(
			new ContextAnswersProvider().search({
				query: 'upstream failure',
			}),
		).rejects.toBeDefined();
		expect(fetch_mock).toHaveBeenCalledTimes(1);
	});

	it('requires a configured API key', async () => {
		config.ai_response.context_answers.api_key = undefined;
		await expect(
			new ContextAnswersProvider().search({ query: 'no key' }),
		).rejects.toMatchObject({ type: 'INVALID_INPUT' });
		expect(fetch_mock).not.toHaveBeenCalled();
	});
});
