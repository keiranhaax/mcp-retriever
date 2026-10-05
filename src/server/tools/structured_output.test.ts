import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { config } from '../../config/env.js';
import { create_server } from '../create_server.js';

const url = 'https://example.test/report?edition=2';
const settings = Object.values(config).flatMap(Object.values);
const keys = settings.map((item) => item.api_key);
const fetch_mock = vi.fn();
let directory: string;
let server: ReturnType<typeof create_server>;
let sequence = 0;
const call = async (name: string, args: Record<string, unknown>) => {
	const response: any = await server.receive({
		jsonrpc: '2.0',
		id: ++sequence,
		method: 'tools/call',
		params: { name, arguments: args },
	});
	expect(response.error).toBeUndefined();
	return response.result;
};
const listing = async () => {
	const response: any = await server.receive({
		jsonrpc: '2.0',
		id: ++sequence,
		method: 'tools/list',
	});
	expect(response.error).toBeUndefined();
	return response.result.tools;
};
const respond = (text = 'Evidence [1].') => {
	fetch_mock.mockImplementation(async (target, options) => {
		expect(String(target)).toMatch(
			/^https:\/\/api\.tavily\.com\/(search|extract)$/,
		);
		expect(options.method).toBe('POST');
		return new Response(
			JSON.stringify({
				results: [
					{
						url,
						title: 'Fixture',
						content: text,
						raw_content: text,
						score: 0.5,
					},
				],
				failed_results: [],
			}),
			{ headers: { 'content-type': 'application/json' } },
		);
	});
};
beforeEach(() => {
	directory = mkdtempSync(join(tmpdir(), 'retriever-structured-'));
	vi.stubEnv('HOME', directory);
	vi.stubEnv('RETRIEVER_RESULT_DIR', join(directory, 'results'));
	for (const item of settings) item.api_key = undefined;
	config.search.tavily.api_key = 'structured-fixture-key';
	config.processing.tavily_extract.api_key = 'structured-fixture-key';
	fetch_mock.mockReset();
	fetch_mock.mockImplementation(async () => {
		throw new Error('Unexpected fixture networking');
	});
	vi.stubGlobal('fetch', fetch_mock);
	vi.spyOn(console, 'error').mockImplementation(() => {});
	vi.spyOn(console, 'warn').mockImplementation(() => {});
	server = create_server({
		name: 'structured-fixture',
		version: '1',
	});
});
afterEach(() => {
	settings.forEach((item, i) => {
		item.api_key = keys[i];
	});
	vi.unstubAllGlobals();
	vi.unstubAllEnvs();
	vi.restoreAllMocks();
	rmSync(directory, { recursive: true, force: true });
});

const reconstruct = async (id: string) => {
	let offset = 1;
	let byte_offset = 0;
	let output = '';
	for (let pages = 0; pages < 500; pages++) {
		const result = await call('result_read', {
			result_id: id,
			offset,
			byte_offset,
			limit: 500,
		});
		expect(result.isError).not.toBe(true);
		const chunk = JSON.parse(result.content[0].text);
		output += chunk.content;
		if (chunk.next_offset === undefined) return output;
		if (chunk.next_byte_offset === undefined) output += '\n';
		offset = chunk.next_offset;
		byte_offset = chunk.next_byte_offset ?? 0;
	}
	throw new Error('Reconstruction exceeded page bound');
};

// Characterize the installed tmcp boundary: schema rejection happens
// before either handler and is deliberately not rewritten by this layer.
it.each(['web_search', 'web_extract'])(
	'leaves %s pre-handler schema rejection text-only and private',
	async (name) => {
		const result = await call(name, {
			provider: 'tavily',
			query: 'evidence',
			url,
			response_mode: 'PRIVATE_INVALID_MODE',
		});
		expect(result.isError).toBe(true);
		expect(result.structuredContent).toBeUndefined();
		expect(JSON.stringify(result)).not.toContain(
			'PRIVATE_INVALID_MODE',
		);
		expect(fetch_mock).not.toHaveBeenCalled();
	},
);

it.each(['web_search', 'web_extract'])(
	'returns a structured %s cross-field validation error before networking',
	async (name) => {
		const result = await call(name, {
			provider: 'tavily',
			query: 'evidence',
			url,
			output_budget_bytes: 2048,
		});
		expect(result.isError).toBe(true);
		expect(result.structuredContent).toEqual({
			ok: false,
			error: {
				kind: 'bad_input',
				retryable: false,
				provider: 'presentation',
			},
		});
		expect(result.content[0].text).toBe(
			'presentation error [INVALID_INPUT]: output_budget_bytes requires response_mode=compact or full',
		);
		expect(fetch_mock).not.toHaveBeenCalled();
	},
);

it('keeps helper serialization exact and arbitrary errors bounded', async () => {
	const {
		tool_success,
		tool_success_bytes,
		tool_error,
		output_schema,
	} = await import('../../common/tool_output.js');
	const { safeParse } = await import('valibot');
	const { ProviderError, ErrorType } =
		await import('../../common/types.js');
	const value = {
		content: '漢字😀"\\\n',
		metadata: {},
		source_provider: 'fixture',
	};
	expect(tool_success_bytes(value)).toBe(
		Buffer.byteLength(JSON.stringify(tool_success(value)), 'utf8'),
	);
	for (const error of [
		new Error('PRIVATE_ERROR'.repeat(1000)),
		{ message: 'PRIVATE_ERROR'.repeat(1000) },
		new ProviderError(
			ErrorType.API_ERROR,
			'PRIVATE_ERROR'.repeat(1000),
			'PRIVATE_PROVIDER'.repeat(1000),
			{ secret: 'PRIVATE_DETAILS' },
		),
	]) {
		const result = tool_error(error);
		expect(result.isError).toBe(true);
		expect(
			safeParse(output_schema, result.structuredContent).success,
		).toBe(true);
		expect(JSON.stringify(result)).not.toContain('PRIVATE');
		expect(
			Buffer.byteLength(JSON.stringify(result)),
		).toBeLessThanOrEqual(2048);
	}
});

it.each([
	{ name: 'web_search', mode: undefined, failure: 'quota' },
	{ name: 'web_extract', mode: undefined, failure: 'quota' },
	{ name: 'web_search', mode: 'legacy', failure: 'quota' },
	{ name: 'web_extract', mode: 'legacy', failure: 'quota' },
	{ name: 'web_search', mode: undefined, failure: 'filesystem' },
	{ name: 'web_extract', mode: undefined, failure: 'filesystem' },
	{ name: 'web_search', mode: 'legacy', failure: 'filesystem' },
	{ name: 'web_extract', mode: 'legacy', failure: 'filesystem' },
])(
	'classifies $name $mode retention $failure without provider degradation',
	async ({ name, mode, failure }) => {
		if (failure === 'quota') {
			vi.stubEnv('RETRIEVER_RESULT_MAX_BYTES', '1');
			vi.stubEnv('RETRIEVER_RESULT_STORE_MAX_BYTES', '1');
		} else {
			const file = join(directory, 'PRIVATE_STORAGE_PATH');
			writeFileSync(file, 'fixture');
			vi.stubEnv('RETRIEVER_RESULT_DIR', join(file, 'results'));
		}
		respond('PRIVATE_EVIDENCE_CANARY'.repeat(4000));
		const result = await call(name, {
			provider: 'tavily',
			query: 'evidence',
			url,
			...(mode ? { response_mode: mode } : {}),
		});
		expect(result.isError).toBe(true);
		expect(result.structuredContent).toMatchObject({
			ok: false,
			error: { kind: 'storage_failure', retryable: false },
		});
		expect(result.content[0].text).toBe(
			failure === 'quota'
				? 'result_store error [PROVIDER_ERROR]: Provider request failed'
				: 'Unexpected error: operation failed',
		);
		expect(JSON.stringify(result)).not.toContain('PRIVATE');
		expect(JSON.stringify(result)).not.toContain('result_id');
		expect(
			Buffer.byteLength(JSON.stringify(result)),
		).toBeLessThanOrEqual(2048);
		expect(fetch_mock).toHaveBeenCalledTimes(1);
		const { get_provider_health_snapshot } =
			await import('../provider_health.js');
		const category = name === 'web_search' ? 'search' : 'processing';
		expect(
			get_provider_health_snapshot()[category].tavily.active_error,
		).not.toBe(true);
	},
);

it('classifies a canonical retention failure without exposing evidence or a false handle', async () => {
	vi.stubEnv('RETRIEVER_RESULT_MAX_BYTES', '1');
	vi.stubEnv('RETRIEVER_RESULT_STORE_MAX_BYTES', '1');
	respond('PRIVATE_EVIDENCE_CANARY'.repeat(1000));
	const result = await call('web_extract', {
		provider: 'tavily',
		url,
		response_mode: 'full',
		output_budget_bytes: 2048,
	});
	expect(result.isError).toBe(true);
	expect(result.structuredContent).toEqual({
		ok: false,
		error: {
			kind: 'storage_failure',
			retryable: false,
			provider: 'presentation',
		},
	});
	expect(result.content[0].text).toBe(
		'presentation error [PROVIDER_ERROR]: Cannot retain complete canonical result; no evidence was returned',
	);
	expect(JSON.stringify(result)).not.toContain(
		'PRIVATE_EVIDENCE_CANARY',
	);
	expect(JSON.stringify(result)).not.toContain('result_id');
	expect(
		Buffer.byteLength(JSON.stringify(result)),
	).toBeLessThanOrEqual(2048);
});

it('declares typed normalized search, extraction and presentation data', async () => {
	const output = await import('../../common/tool_output.js');
	const v = await import('valibot');
	const tools = await listing();
	const data = tools.find((item: any) => item.name === 'web_search')
		.outputSchema.properties.data;
	expect(data).toHaveProperty('anyOf');
	expect(data.anyOf).toEqual(
		expect.arrayContaining([
			expect.objectContaining({
				type: 'array',
				items: expect.objectContaining({
					properties: expect.objectContaining({
						title: { type: 'string' },
						url: { type: 'string' },
						snippet: { type: 'string' },
						source_provider: { type: 'string' },
					}),
				}),
			}),
			expect.objectContaining({
				type: 'object',
				properties: expect.objectContaining({
					content: { type: 'string' },
					raw_contents: expect.any(Object),
					metadata: expect.any(Object),
				}),
			}),
			expect.objectContaining({
				type: 'object',
				properties: expect.objectContaining({
					response_mode: expect.any(Object),
					metadata: expect.any(Object),
					result_id: expect.any(Object),
				}),
			}),
		]),
	);
	expect(
		v.safeParse(output.output_schema, {
			ok: true,
			data: [
				{
					title: 12,
					url,
					snippet: 'bad title',
					source_provider: 'fixture',
				},
			],
		}).success,
	).toBe(false);
	expect(
		v.safeParse(output.output_schema, {
			ok: true,
			data: {
				content: 'Fixture',
				raw_contents: [{ url, content: 12 }],
				metadata: {},
				source_provider: 'fixture',
			},
		}).success,
	).toBe(false);
});

it('allows a workflow-specific data schema without altering the shared envelope', async () => {
	const output = await import('../../common/tool_output.js');
	const v = await import('valibot');
	const { ValibotJsonSchemaAdapter } =
		await import('@tmcp/adapter-valibot');
	expect(output).toHaveProperty('create_output_schema');
	const schema = output.create_output_schema(
		v.object({ count: v.number() }),
	);
	expect(
		v.safeParse(
			schema,
			output.tool_success({ count: 1 }).structuredContent,
		).success,
	).toBe(true);
	expect(
		v.safeParse(schema, { ok: true, data: { count: 'wrong' } })
			.success,
	).toBe(false);
	expect(
		v.safeParse(
			schema,
			output.tool_error(new Error('PRIVATE')).structuredContent,
		).success,
	).toBe(true);
	expect(
		await new ValibotJsonSchemaAdapter().toJsonSchema(schema),
	).toMatchObject({
		type: 'object',
		properties: {
			data: {
				type: 'object',
				properties: { count: { type: 'number' } },
				required: ['count'],
			},
		},
	});
});

it('applies caller measurement to the retained full envelope as well as inline data', async () => {
	const { present_result } =
		await import('../../common/presentation.js');
	const { tool_success_bytes } =
		await import('../../common/tool_output.js');
	expect(() =>
		present_result(
			{ content: 'Evidence'.repeat(1000) },
			{
				provider: 'fixture',
				operation: 'extract',
				elapsed_ms: 0,
				response_mode: 'full',
				output_budget_bytes: 2048,
				measure_bytes: (value) => tool_success_bytes(value) + 1500,
			},
		),
	).toThrow('Output budget cannot fit required result provenance');
});

it.each([2048, 4096, 12000])(
	'fits compact structured evidence within %i bytes without losing canonical text',
	async (budget) => {
		const text =
			'Background.\n'.repeat(100) +
			'Needle evidence [1].\n' +
			'Following.\n'.repeat(100);
		respond(text);
		const result = await call('web_extract', {
			provider: 'tavily',
			query: 'needle',
			url,
			response_mode: 'compact',
			output_budget_bytes: budget,
		});
		expect(result.isError).not.toBe(true);
		expect(
			Buffer.byteLength(JSON.stringify(result)),
		).toBeLessThanOrEqual(budget);
		const presented = JSON.parse(result.content[0].text);
		expect(result.structuredContent).toEqual({
			ok: true,
			data: presented,
		});
		if (presented.metadata.local_completeness === 'complete') {
			expect(presented.result.raw_contents[0].content).toBe(text);
		} else {
			const canonical = JSON.parse(
				await reconstruct(presented.result_id),
			);
			expect(canonical.result.raw_contents[0].content).toBe(text);
			if (presented.metadata.local_completeness === 'selected') {
				expect(presented.sources[0].url).toBe(url);
				for (const source of presented.sources)
					for (const passage of source.passages)
						expect(passage.text).toBe(
							text.slice(passage.start, passage.end),
						);
			} else {
				expect(presented.metadata.local_completeness).toBe(
					'retained',
				);
			}
		}
	},
);

it.each(['web_search', 'web_extract'])(
	'retains %s full evidence when structure alone crosses the budget',
	async (name) => {
		const text = 'Needle 😀 evidence [1]. '.repeat(90);
		respond(text);
		const result = await call(name, {
			provider: 'tavily',
			query: 'needle',
			url,
			response_mode: 'full',
			output_budget_bytes: 4000,
		});
		expect(result.isError).not.toBe(true);
		expect(
			Buffer.byteLength(JSON.stringify(result)),
		).toBeLessThanOrEqual(4000);
		const handle = JSON.parse(result.content[0].text);
		expect(handle.metadata.local_completeness).toBe('retained');
		expect(result.structuredContent).toEqual({
			ok: true,
			data: handle,
		});
		const canonical = JSON.parse(await reconstruct(handle.result_id));
		expect(canonical.metadata.local_completeness).toBe('complete');
		expect(
			name === 'web_search'
				? canonical.result[0].snippet
				: canonical.result.raw_contents[0].content,
		).toBe(text);
	},
);

it.each(['web_search', 'web_extract'])(
	'budgets both copies of %s legacy results before offloading',
	async (name) => {
		const text = '漢字😀\\\" evidence [1]. '.repeat(
			name === 'web_search' ? 1800 : 900,
		);
		respond(text);
		const result = await call(name, {
			provider: 'tavily',
			query: 'evidence',
			url,
		});
		expect(
			Buffer.byteLength(JSON.stringify(result)),
		).toBeLessThanOrEqual(80000);
		const handle = JSON.parse(result.content[0].text);
		expect(handle.result_id).toEqual(expect.any(String));
		expect(result.structuredContent).toEqual({
			ok: true,
			data: handle,
		});
		const canonical = await reconstruct(handle.result_id);
		const parsed = JSON.parse(
			canonical.slice(
				canonical.indexOf('FULL RESULT JSON\n') +
					'FULL RESULT JSON\n'.length,
			),
		);
		expect(
			name === 'web_search'
				? parsed[0].snippet
				: parsed.raw_contents[0].content,
		).toBe(text);
		expect(fetch_mock).toHaveBeenCalledTimes(1);
	},
);

it.each(['web_search', 'web_extract'])(
	'classifies %s handler failures while preserving redacted text',
	async (name) => {
		fetch_mock.mockResolvedValue(
			new Response(
				JSON.stringify({ error: 'PRIVATE_UPSTREAM_BODY' }),
				{ status: 401 },
			),
		);
		const result = await call(name, {
			provider: 'tavily',
			query: 'evidence',
			url,
		});
		expect(result.isError).toBe(true);
		expect(result.structuredContent).toEqual({
			ok: false,
			error: {
				kind: 'authentication',
				retryable: false,
				provider: name === 'web_search' ? 'tavily' : 'tavily_extract',
				http_status: 401,
			},
		});
		expect(result.content[0].text).toBe(
			`${name === 'web_search' ? 'tavily' : 'tavily_extract'} error [API_ERROR]: Invalid API key (endpoint: https://api.tavily.com)`,
		);
		expect(result.structuredContent.error).not.toHaveProperty(
			'message',
		);
		expect(JSON.stringify(result)).not.toContain(
			'PRIVATE_UPSTREAM_BODY',
		);
		expect(
			Buffer.byteLength(JSON.stringify(result)),
		).toBeLessThanOrEqual(2048);
		expect(fetch_mock).toHaveBeenCalledTimes(1);
	},
);

it('declares a structured extraction contract without changing legacy text', async () => {
	respond();
	const result = await call('web_extract', {
		provider: 'tavily',
		url,
	});
	const expected = {
		content: 'Evidence [1].',
		raw_contents: [{ url, content: 'Evidence [1].' }],
		metadata: {
			word_count: 2,
			urls_processed: 1,
			successful_extractions: 1,
			extract_depth: 'basic',
		},
		source_provider: 'tavily_extract',
	};
	expect(result.content).toEqual([
		{ type: 'text', text: JSON.stringify(expected, null, 2) },
	]);
	expect(result.structuredContent).toEqual({
		ok: true,
		data: expected,
	});
	expect(result.isError).not.toBe(true);
	const tools = await listing();
	expect(
		tools.find((item: any) => item.name === 'web_extract')
			.outputSchema,
	).toEqual(
		tools.find((item: any) => item.name === 'web_search')
			.outputSchema,
	);
	expect(fetch_mock).toHaveBeenCalledTimes(1);
});

it('declares a structured search contract without changing legacy text', async () => {
	respond();
	const result = await call('web_search', {
		provider: 'tavily',
		query: 'evidence',
	});
	const expected = [
		{
			title: 'Fixture',
			url,
			snippet: 'Evidence [1].',
			score: 0.5,
			source_provider: 'tavily',
		},
	];
	expect(result.content).toEqual([
		{ type: 'text', text: JSON.stringify(expected, null, 2) },
	]);
	expect(result.structuredContent).toEqual({
		ok: true,
		data: expected,
	});
	expect(result.isError).not.toBe(true);
	const tool = (await listing()).find(
		(item: any) => item.name === 'web_search',
	);
	expect(tool.outputSchema).toMatchObject({
		type: 'object',
		required: ['ok'],
		properties: {
			ok: { type: 'boolean' },
			data: {},
			error: {
				type: 'object',
				required: ['kind', 'retryable'],
				properties: {
					kind: {
						enum: expect.arrayContaining([
							'bad_input',
							'storage_failure',
							'upstream_failure',
						]),
					},
					retryable: { type: 'boolean' },
				},
			},
		},
	});
	expect(fetch_mock).toHaveBeenCalledTimes(1);
});
