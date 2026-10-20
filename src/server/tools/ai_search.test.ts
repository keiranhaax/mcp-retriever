import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import * as v from 'valibot';
import { ValibotJsonSchemaAdapter } from '@tmcp/adapter-valibot';
import { config } from '../../config/env.js';
import { run_with_request_context } from '../../common/request_context.js';
import {
	initialize_ai_search,
	register_ai_search,
} from './ai_search.js';

const fetch_mock = vi.fn();
const previous = { ...config.ai_response.tavily_research };
const previous_context = { ...config.ai_response.context_answers };
const registered = () => {
	let tool: { definition: any; handler: any };
	initialize_ai_search();
	register_ai_search({
		tool: (definition: any, handler: any) => {
			tool = { definition, handler };
		},
	} as any);
	return tool!;
};
beforeEach(() => {
	vi.useFakeTimers();
	vi.stubGlobal('fetch', fetch_mock);
	fetch_mock.mockReset();
	config.ai_response.tavily_research.api_key = 'tavily-fixture-key';
	config.ai_response.tavily_research.timeout = 100;
	vi.spyOn(AbortSignal, 'timeout').mockImplementation((ms) => {
		const controller = new AbortController();
		setTimeout(
			() =>
				controller.abort(
					new DOMException('Timed out', 'TimeoutError'),
				),
			ms,
		);
		return controller.signal;
	});
});
afterEach(() => {
	Object.assign(config.ai_response.tavily_research, previous);
	Object.assign(config.ai_response.context_answers, previous_context);
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
	vi.useRealTimers();
});

it('returns the accepted ID at the wait deadline and resumes via GET-only status', async () => {
	fetch_mock.mockResolvedValueOnce(
		new Response('{"status":"pending","request_id":"job-1"}'),
	);
	const tool = registered();
	const pending = tool.handler(
		v.parse(tool.definition.schema, {
			provider: 'tavily_research',
			query: 'private prompt',
		}),
	);
	await vi.advanceTimersByTimeAsync(100);
	const first = await pending;
	expect(first.isError).toBeUndefined();
	expect(JSON.parse(first.content[0].text)[0].metadata).toMatchObject(
		{ request_id: 'job-1', resumable: true },
	);
	fetch_mock.mockResolvedValueOnce(
		new Response(
			'{"status":"completed","request_id":"job-1","content":"Report"}',
		),
	);
	const result = await tool.handler(
		v.parse(tool.definition.schema, {
			provider: 'tavily_research',
			action: 'status',
			request_id: 'job-1',
		}),
	);
	expect(result.isError).toBeUndefined();
	expect(JSON.parse(result.content[0].text)[0].snippet).toBe(
		'Report',
	);
	expect(
		fetch_mock.mock.calls.map(([url, init]) => [url, init.method]),
	).toEqual([
		[`${previous.base_url}/research`, 'POST'],
		[`${previous.base_url}/research/job-1`, 'GET'],
	]);
});

it('returns a pending status from one GET and never creates a task', async () => {
	fetch_mock.mockResolvedValueOnce(
		new Response('{"status":"in_progress","request_id":"job-1"}'),
	);
	const tool = registered();
	const response = await tool.handler(
		v.parse(tool.definition.schema, {
			provider: 'tavily_research',
			action: 'status',
			request_id: 'job-1',
		}),
	);
	expect(
		JSON.parse(response.content[0].text)[0].metadata,
	).toMatchObject({
		request_id: 'job-1',
		status: 'in_progress',
		resumable: true,
	});
	expect(
		fetch_mock.mock.calls.map(([, options]) => options.method),
	).toEqual(['GET']);
});

it.each([
	'exa_answer',
	'exa_deep_research',
	'linkup',
	'context_answers',
	'brave_answers',
	'tavily_research',
] as const)(
	'still requires a query for configured %s research calls',
	async (provider) => {
		const old_key = config.ai_response[provider].api_key;
		try {
			config.ai_response[provider].api_key = 'fixture-valid-key';
			const response = await registered().handler({ provider });
			expect(response.isError).toBe(true);
			expect(fetch_mock).not.toHaveBeenCalled();
		} finally {
			config.ai_response[provider].api_key = old_key;
		}
	},
);

it.each(['AbortError', 'TimeoutError'])(
	'retains accepted task recovery for caller %s',
	async (name) => {
		fetch_mock.mockImplementation(
			(_url, init) =>
				new Promise((_resolve, reject) => {
					init.signal.addEventListener(
						'abort',
						() => reject(init.signal.reason),
						{ once: true },
					);
				}),
		);
		const caller = new AbortController();
		const pending = run_with_request_context(caller.signal, () =>
			registered().handler({
				provider: 'tavily_research',
				action: 'status',
				request_id: 'job-1',
			}),
		).catch((error: unknown) => error);
		await vi.advanceTimersByTimeAsync(0);
		expect(fetch_mock).toHaveBeenCalledTimes(1);
		caller.abort(new DOMException('private cancellation', name));
		expect(await pending).toMatchObject({
			isError: true,
			_meta: {
				retriever: {
					error: {
						kind: name === 'TimeoutError' ? 'timeout' : 'cancelled',
						retryable: false,
					},
					job: { id: 'job-1', state: 'unknown', resumable: true },
				},
			},
		});
		await vi.advanceTimersByTimeAsync(100);
		expect(fetch_mock).toHaveBeenCalledTimes(1);
	},
);

it('converts its additive schema using the actual MCP adapter', async () => {
	const schema = await new ValibotJsonSchemaAdapter().toJsonSchema(
		registered().definition.schema,
	);
	expect(schema.type).toBe('object');
	expect(schema.properties).toHaveProperty('action');
	expect(schema.properties).toHaveProperty('request_id');
	expect(schema.required).not.toContain('query');
});

it.each([
	{ provider: 'tavily_research' },
	{ provider: 'tavily_research', query: '  ' },
	{ provider: 'tavily_research', action: 'status' },
	{
		provider: 'tavily_research',
		action: 'status',
		request_id: '../bad',
	},
	{
		provider: 'tavily_research',
		action: 'status',
		request_id: 'job-1',
		query: 'start?',
	},
	{
		provider: 'tavily_research',
		query: 'start?',
		request_id: 'job-1',
	},
	{ provider: 'exa_answer', action: 'status', request_id: 'job-1' },
])(
	'rejects invalid lifecycle inputs before networking: %j',
	async (input) => {
		const result = await registered().handler(input);
		expect(result.isError).toBe(true);
		expect(fetch_mock).not.toHaveBeenCalled();
	},
);

it('propagates caller cancellation instead of returning a tool response', async () => {
	fetch_mock.mockImplementation(() => new Promise(() => {}));
	const caller = new AbortController();
	const pending = run_with_request_context(caller.signal, () =>
		registered().handler({
			provider: 'tavily_research',
			query: 'private prompt',
		}),
	).catch((error: unknown) => error);
	caller.abort();
	expect(await pending).toMatchObject({ name: 'AbortError' });
});

it('registers context_answers only when its key is configured', () => {
	config.ai_response.context_answers.api_key = undefined;
	let provider_schema =
		registered().definition.schema.entries.provider;
	expect(
		v.safeParse(provider_schema, 'context_answers').success,
	).toBe(false);

	config.ai_response.context_answers.api_key = 'context-fixture-key';
	provider_schema = registered().definition.schema.entries.provider;
	expect(
		v.safeParse(provider_schema, 'context_answers').success,
	).toBe(true);
});

it('exposes context_mode and json_format with provider-scoped descriptions', async () => {
	config.ai_response.context_answers.api_key = 'context-fixture-key';
	const schema = await new ValibotJsonSchemaAdapter().toJsonSchema(
		registered().definition.schema,
	);
	const properties = schema.properties as Record<
		string,
		{ enum?: unknown; description?: string }
	>;
	expect(properties.context_mode).toMatchObject({
		enum: ['fast', 'ultra'],
	});
	expect(properties.context_mode.description).toContain(
		'Only used when provider is context_answers',
	);
	expect(properties.json_format.description).toContain(
		'Only used when provider is context_answers',
	);
	expect(properties.exa_deep_search_type.description).toContain(
		'legacy',
	);
	expect(schema.required).not.toContain('context_mode');
	expect(schema.required).not.toContain('json_format');
});

it('dispatches context_answers with the fast default', async () => {
	config.ai_response.context_answers.api_key = 'context-fixture-key';
	fetch_mock.mockResolvedValueOnce(
		new Response(
			JSON.stringify({
				json_content: { answer: 'ok' },
				sources: ['https://example.com/a'],
			}),
		),
	);
	const tool = registered();
	const response = await tool.handler(
		v.parse(tool.definition.schema, {
			provider: 'context_answers',
			query: 'context question',
		}),
	);
	expect(response.isError).toBeUndefined();
	const results = JSON.parse(response.content[0].text);
	expect(results[0].snippet).toBe(
		JSON.stringify({ answer: 'ok' }, null, 2),
	);
	expect(results[1].url).toBe('https://example.com/a');
	const [url, init] = fetch_mock.mock.calls[0];
	expect(url).toBe(`${previous_context.base_url}/web/answers`);
	expect(JSON.parse(init.body)).toMatchObject({
		mode: 'fast',
		task: 'context question',
		timeoutOpts: { behavior: 'return-partial' },
	});
	expect(JSON.parse(init.body)).not.toHaveProperty('json_format');
});

it('forwards context_mode and json_format to context_answers', async () => {
	config.ai_response.context_answers.api_key = 'context-fixture-key';
	fetch_mock.mockResolvedValueOnce(
		new Response(JSON.stringify({ json_content: { name: 'x' } })),
	);
	const tool = registered();
	const json_format = { name: 'Example Co' };
	const response = await tool.handler(
		v.parse(tool.definition.schema, {
			provider: 'context_answers',
			query: 'context question',
			context_mode: 'ultra',
			json_format,
		}),
	);
	expect(response.isError).toBeUndefined();
	expect(JSON.parse(fetch_mock.mock.calls[0][1].body)).toMatchObject({
		mode: 'ultra',
		json_format,
	});
});

it('rejects an invalid context_mode at the schema', () => {
	config.ai_response.context_answers.api_key = 'context-fixture-key';
	const tool = registered();
	expect(
		v.safeParse(tool.definition.schema, {
			provider: 'context_answers',
			query: 'q',
			context_mode: 'balanced',
		}).success,
	).toBe(false);
});

it('ignores context_answers parameters for other providers', async () => {
	const old_key = config.ai_response.exa_answer.api_key;
	try {
		config.ai_response.exa_answer.api_key = 'exa-fixture-key';
		fetch_mock.mockResolvedValueOnce(
			new Response(JSON.stringify({ answer: 'Exa answer' })),
		);
		const tool = registered();
		const response = await tool.handler(
			v.parse(tool.definition.schema, {
				provider: 'exa_answer',
				query: 'plain question',
				context_mode: 'ultra',
				json_format: { name: 'Example Co' },
			}),
		);
		expect(response.isError).toBeUndefined();
		expect(JSON.parse(fetch_mock.mock.calls[0][1].body)).toEqual({
			query: 'plain question',
		});
	} finally {
		config.ai_response.exa_answer.api_key = old_key;
	}
});
