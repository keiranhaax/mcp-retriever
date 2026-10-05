import {
	afterEach,
	beforeEach,
	describe,
	expect,
	it,
	vi,
} from 'vitest';
import * as v from 'valibot';
import { ValibotJsonSchemaAdapter } from '@tmcp/adapter-valibot';
import { config } from '../../config/env.js';
import {
	initialize_firecrawl_agent,
	register_firecrawl_agent,
} from './firecrawl_agent.js';

const fetch_mock = vi.fn();
const previous_key = config.processing.firecrawl_agent.api_key;
const json_response = (body: unknown) =>
	new Response(JSON.stringify(body), { status: 200 });
const registered = () => {
	let tool: { definition: any; handler: any };
	initialize_firecrawl_agent();
	register_firecrawl_agent({
		tool: (definition: any, handler: any) => {
			tool = { definition, handler };
		},
	} as any);
	return tool!;
};

describe('firecrawl_agent job lifecycle', () => {
	beforeEach(() => {
		config.processing.firecrawl_agent.api_key = 'fc-test-key';
		fetch_mock.mockReset();
		vi.stubGlobal('fetch', fetch_mock);
	});
	afterEach(() => {
		config.processing.firecrawl_agent.api_key = previous_key;
		vi.unstubAllGlobals();
		vi.restoreAllMocks();
	});

	it('starts asynchronously then checks and cancels the same job without a second POST', async () => {
		fetch_mock.mockImplementationOnce(async () =>
			json_response({
				success: true,
				id: '12345678-1234-4123-8123-123456789abc',
			}),
		);
		fetch_mock.mockImplementationOnce(async () =>
			json_response({ status: 'processing' }),
		);
		fetch_mock.mockImplementationOnce(async () =>
			json_response({ success: true }),
		);
		const tool = registered();
		const start = await tool.handler(
			v.parse(tool.definition.schema, { prompt: 'gather docs' }),
		);
		expect(start.isError).toBeUndefined();
		const pending = JSON.parse(start.content[0].text);
		expect(pending.metadata).toMatchObject({
			job_id: '12345678-1234-4123-8123-123456789abc',
			status: 'processing',
		});
		expect(pending.content).toContain('status');
		expect(pending.content).not.toContain('Retry the same request');
		const status = await tool.handler(
			v.parse(tool.definition.schema, {
				action: 'status',
				job_id: '12345678-1234-4123-8123-123456789abc',
			}),
		);
		expect(status.isError).toBeUndefined();
		const cancel = await tool.handler(
			v.parse(tool.definition.schema, {
				action: 'cancel',
				job_id: '12345678-1234-4123-8123-123456789abc',
			}),
		);
		expect(cancel.isError).toBeUndefined();
		expect(JSON.parse(cancel.content[0].text).metadata.status).toBe(
			'cancelled',
		);
		expect(
			fetch_mock.mock.calls.map(([, options]) => options.method),
		).toEqual(['POST', 'GET', 'DELETE']);
		expect(
			fetch_mock.mock.calls.slice(1).map(([url]) => url),
		).toEqual([
			'https://api.firecrawl.dev/v2/agent/12345678-1234-4123-8123-123456789abc',
			'https://api.firecrawl.dev/v2/agent/12345678-1234-4123-8123-123456789abc',
		]);
	});

	it.each([404, 409])(
		'does not report cancellation success for DELETE %s',
		async (status) => {
			fetch_mock.mockImplementation(
				async () => new Response('{}', { status }),
			);
			const tool = registered();
			const result = await tool.handler({
				action: 'cancel',
				job_id: '12345678-1234-4123-8123-123456789abc',
			});
			expect(result.isError).toBe(true);
			expect(
				fetch_mock.mock.calls.map(([, options]) => options.method),
			).toEqual(['DELETE']);
		},
	);

	it.each([0, -1, 1.5, Infinity, NaN])(
		'rejects invalid cap %s at schema validation',
		(max_credits) => {
			expect(
				v.safeParse(registered().definition.schema, {
					prompt: 'gather docs',
					max_credits,
				}).success,
			).toBe(false);
		},
	);

	it.each([
		{},
		{ action: 'status' },
		{ action: 'cancel', job_id: '../other' },
		{ action: 'start', prompt: 'docs', job_id: 'existing' },
	])(
		'rejects ambiguous or missing job inputs before networking: %j',
		async (input) => {
			expect((await registered().handler(input)).isError).toBe(true);
			expect(fetch_mock).not.toHaveBeenCalled();
		},
	);

	it('supports an opt-in bounded wait for an existing prompt create', async () => {
		vi.useFakeTimers();
		try {
			fetch_mock.mockImplementationOnce(async () =>
				json_response({
					success: true,
					id: '12345678-1234-4123-8123-123456789abc',
				}),
			);
			fetch_mock.mockImplementationOnce(async () =>
				json_response({ status: 'completed', data: false }),
			);
			const tool = registered();
			const promise = tool.handler(
				v.parse(tool.definition.schema, {
					prompt: 'docs',
					wait_for_completion: true,
				}),
			);
			await vi.advanceTimersByTimeAsync(3000);
			const result = await promise;
			expect(
				JSON.parse(result.content[0].text).metadata,
			).toMatchObject({
				status: 'completed',
				structured_data: false,
			});
			expect(
				fetch_mock.mock.calls.map(([, options]) => options.method),
			).toEqual(['POST', 'GET']);
		} finally {
			vi.useRealTimers();
		}
	});

	it.each([
		{ status: 'invalid' },
		{ status: 'failed', error: 'private-provider-echo' },
		{ status: 'error', error: 'private-provider-echo' },
		{ status: 'cancelled' },
		{ status: 'completed' },
	])(
		'exposes the accepted job ID with a safe polling error: %j',
		async (body) => {
			vi.useFakeTimers();
			try {
				const job_id = '12345678-1234-4123-8123-123456789abc';
				fetch_mock
					.mockResolvedValueOnce(
						json_response({ success: true, id: job_id }),
					)
					.mockResolvedValueOnce(json_response(body));
				const pending = registered().handler({
					prompt: 'private-prompt',
					wait_for_completion: true,
				});
				await vi.advanceTimersByTimeAsync(3000);
				const response = await pending;
				if (body.status === 'cancelled') {
					expect(response.isError).toBeUndefined();
					expect(response._meta.retriever.job).toMatchObject({
						id: job_id,
						state: 'cancelled',
						cancellation: 'confirmed',
						resumable: false,
					});
					expect(fetch_mock).toHaveBeenCalledTimes(2);
					return;
				}
				expect(response.isError).toBe(true);
				const text = JSON.parse(response.content[0].text).error;
				expect(text).toContain(job_id);
				expect(text).toContain('action="status"');
				expect(text).toContain('action="cancel"');
				expect(text).toContain('do not start a new job');
				expect(text).not.toContain('private-');
				expect(fetch_mock).toHaveBeenCalledTimes(2);
			} finally {
				vi.useRealTimers();
			}
		},
	);

	it('converts the advertised schema using the real MCP adapter', async () => {
		const schema = await new ValibotJsonSchemaAdapter().toJsonSchema(
			registered().definition.schema,
		);
		expect(schema.type).toBe('object');
	});

	it('rejects non-UUID job IDs and overlong prompts', () => {
		const schema = registered().definition.schema;
		expect(
			v.safeParse(schema, { action: 'status', job_id: 'job-1' })
				.success,
		).toBe(false);
		expect(
			v.safeParse(schema, { prompt: 'a'.repeat(10001) }).success,
		).toBe(false);
	});

	it.each(['failed', 'error'])(
		'returns an error for terminal %s jobs without echoed provider text',
		async (status) => {
			fetch_mock.mockImplementation(async () =>
				json_response({ status, error: 'private-provider-echo' }),
			);
			const response = await registered().handler({
				action: 'status',
				job_id: '12345678-1234-4123-8123-123456789abc',
			});
			expect(response.isError).toBe(true);
			expect(response.content[0].text).not.toContain(
				'private-provider-echo',
			);
		},
	);

	it('reports cancellation as terminal without a pending-status instruction', async () => {
		fetch_mock.mockImplementation(async () =>
			json_response({ success: true }),
		);
		const response = await registered().handler({
			action: 'cancel',
			job_id: '12345678-1234-4123-8123-123456789abc',
		});
		expect(response.content[0].text).not.toContain(
			'still processing',
		);
		expect(response.content[0].text).not.toContain(
			'Call firecrawl_agent',
		);
	});

	it.each(['spark-2', 'spark-1-mini', 'spark-1-pro'])(
		'retains model %s',
		(model) => {
			expect(
				v.safeParse(registered().definition.schema, {
					prompt: 'docs',
					model,
				}).success,
			).toBe(true);
		},
	);
});
