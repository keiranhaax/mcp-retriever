import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
	afterEach,
	beforeEach,
	describe,
	expect,
	it,
	vi,
} from 'vitest';
import { config } from '../../config/env.js';
import { create_server } from '../create_server.js';

const job_id = '12345678-1234-4234-8234-123456789abc';
const request_id = 'p2-request';
const evidence = 'Evidence [1], `array[2]`, math [x+y], 漢字😀.';
const canary = 'P2_PRIVATE_CONTROL_CANARY';
const settings = [
	config.ai_response.tavily_research,
	config.processing.firecrawl_agent,
];
const previous = settings.map((setting) => ({ ...setting }));
const fetch_mock = vi.fn();
let server: ReturnType<typeof create_server>;
let home: string;
let sequence = 0;
const json = (value: unknown, status = 200) =>
	new Response(JSON.stringify(value), { status });
const call = async (
	name: string,
	args: Record<string, unknown>,
	signal?: AbortSignal,
): Promise<any> =>
	server.receive(
		{
			jsonrpc: '2.0',
			id: ++sequence,
			method: 'tools/call',
			params: { name, arguments: args },
		},
		{ signal },
	);
const value = (response: any) =>
	JSON.parse(response.result.content[0].text);
const meta = (response: any) => response.result?._meta?.retriever;
const reconstruct = async (id: string) => {
	let offset = 1,
		byte_offset = 0,
		output = '';
	for (let reads = 0; reads < 200; reads++) {
		const response = await call('result_read', {
			result_id: id,
			offset,
			byte_offset,
			limit: 500,
		});
		expect(response.result.isError).not.toBe(true);
		const chunk = value(response);
		output += chunk.content;
		if (chunk.next_offset === undefined) {
			const marker = '\nFULL RESULT JSON\n';
			const index = output.lastIndexOf(marker);
			return {
				result: JSON.parse(
					index < 0 ? output : output.slice(index + marker.length),
				),
				output,
			};
		}
		if (chunk.next_byte_offset === undefined) output += '\n';
		offset = chunk.next_offset;
		byte_offset = chunk.next_byte_offset ?? 0;
	}
	throw new Error('P2 reconstruction exceeded read bound');
};
const scenarios = [
	{
		name: 'ai_search',
		args: {
			provider: 'tavily_research',
			action: 'status',
			request_id,
		},
		body: (status: string, text?: string) => ({
			status,
			request_id,
			content: text,
			response_time: 1.5,
		}),
	},
	{
		name: 'firecrawl_agent',
		args: { action: 'status', job_id },
		body: (status: string, text?: string) => ({
			success: true,
			status,
			data: text,
			creditsUsed: 0,
		}),
	},
];

beforeEach(() => {
	vi.useFakeTimers();
	vi.stubGlobal('fetch', fetch_mock);
	fetch_mock.mockReset();
	for (const setting of settings)
		setting.api_key = 'p2-offline-fixture-key';
	home = mkdtempSync(join(tmpdir(), 'retriever-p2-lifecycle-'));
	vi.stubEnv('RETRIEVER_RESULT_DIR', home);
	server = create_server({ name: 'p2-fixture', version: '1' });
});
afterEach(() => {
	settings.forEach((setting, index) =>
		Object.assign(setting, previous[index]),
	);
	vi.unstubAllGlobals();
	vi.unstubAllEnvs();
	vi.restoreAllMocks();
	vi.useRealTimers();
	rmSync(home, { recursive: true, force: true });
});

describe('P2 public job lifecycle', () => {
	it('does not invent a running provider status from a start acknowledgement', async () => {
		fetch_mock.mockResolvedValue(json({ success: true, id: job_id }));
		const response = await call('firecrawl_agent', {
			prompt: 'offline',
		});
		expect(response.result.isError).not.toBe(true);
		expect(meta(response).job).toMatchObject({
			id: job_id,
			state: 'unknown',
			resumable: true,
		});
		expect(meta(response).job.provider_status).toBeUndefined();
		expect(fetch_mock).toHaveBeenCalledTimes(1);
	});
	it.each(['failed', 'completed'])(
		'retains the last report text when a Tavily %s observation contains only sources',
		async (status) => {
			fetch_mock
				.mockResolvedValueOnce(
					json({ request_id, status: 'pending' }),
				)
				.mockResolvedValueOnce(
					json({
						request_id,
						status: 'in_progress',
						content: evidence,
					}),
				)
				.mockResolvedValueOnce(
					json({
						request_id,
						status,
						sources: [
							{
								url: 'https://example.test/source',
								content: 'Source [1]',
							},
						],
					}),
				);
			const pending = call('ai_search', {
				provider: 'tavily_research',
				query: 'offline',
			});
			await vi.advanceTimersByTimeAsync(10001);
			const response = await pending;
			expect(response.result.isError).toBe(true);
			expect(value(response).result[0].snippet).toBe(evidence);
			expect(value(response).result[1].snippet).toBe('Source [1]');
			expect(meta(response).job).toMatchObject({
				state: status === 'failed' ? 'failed' : 'unknown',
				partial: true,
			});
			expect(
				fetch_mock.mock.calls.map(([, init]) => init.method),
			).toEqual(['POST', 'GET', 'GET']);
		},
	);
	it.each(scenarios)(
		'$name preserves accepted job recovery when completed evidence cannot be stored',
		async (scenario) => {
			vi.stubEnv('RETRIEVER_RESULT_MAX_BYTES', '1');
			vi.stubEnv('RETRIEVER_RESULT_STORE_MAX_BYTES', '1');
			fetch_mock.mockResolvedValue(
				json(scenario.body('completed', evidence.repeat(4000))),
			);
			const response = await call(scenario.name, scenario.args);
			expect(response.result.isError).toBe(true);
			expect(meta(response)).toMatchObject({
				local_completeness: 'unavailable',
				job: {
					id: scenario.name === 'ai_search' ? request_id : job_id,
				},
				error: { retryable: false },
			});
			expect(JSON.stringify(response)).not.toContain('result_id');
			expect(JSON.stringify(response)).not.toContain(evidence);
		},
	);
	it.each(['tavily', 'firecrawl'])(
		'retains a valid %s start identifier even if another response field is malformed',
		async (provider) => {
			const tavily = provider === 'tavily';
			fetch_mock.mockResolvedValue(
				json(
					tavily
						? { request_id, status: 42 }
						: {
								success: true,
								id: job_id,
								error: { private: canary },
							},
				),
			);
			const response = await call(
				tavily ? 'ai_search' : 'firecrawl_agent',
				tavily
					? { provider: 'tavily_research', query: 'offline' }
					: { prompt: 'offline' },
			);
			expect(response.result.isError).toBe(true);
			expect(meta(response).job).toMatchObject({
				id: tavily ? request_id : job_id,
				state: 'unknown',
				resumable: true,
			});
			expect(
				fetch_mock.mock.calls.map(([, init]) => init.method),
			).toEqual(['POST']);
			expect(JSON.stringify(response)).not.toContain(canary);
		},
	);
	it('does not leak rejected Tavily status text when retaining earlier partial evidence', async () => {
		fetch_mock
			.mockResolvedValueOnce(json({ request_id, status: 'pending' }))
			.mockResolvedValueOnce(
				json({
					request_id,
					status: 'in_progress',
					content: evidence,
				}),
			)
			.mockResolvedValueOnce(
				json({
					request_id,
					status: 'https://private.test/' + canary,
				}),
			);
		const pending = call('ai_search', {
			provider: 'tavily_research',
			query: 'offline',
		});
		await vi.advanceTimersByTimeAsync(10001);
		const response = await pending;
		expect(meta(response).job).toMatchObject({
			state: 'unknown',
			partial: true,
		});
		expect(JSON.stringify(response)).toContain(evidence);
		expect(JSON.stringify(response)).not.toContain(canary);
	});
	it.each(['completed', 'future_state'])(
		'retains Firecrawl partial evidence if later %s cannot supply a valid completion',
		async (status) => {
			fetch_mock
				.mockResolvedValueOnce(json({ success: true, id: job_id }))
				.mockResolvedValueOnce(
					json({ status: 'processing', data: evidence }),
				)
				.mockResolvedValueOnce(json({ status }));
			const pending = call('firecrawl_agent', {
				prompt: 'offline',
				wait_for_completion: true,
			});
			await vi.advanceTimersByTimeAsync(6001);
			const response = await pending;
			expect(response.result.isError).toBe(true);
			expect(meta(response).job).toMatchObject({
				state: 'unknown',
				partial: true,
			});
			expect(JSON.stringify(value(response).result)).toContain(
				evidence,
			);
		},
	);
	it.each([78000, 78500, 79000, 79500])(
		'bounds the full async error envelope including metadata near %i bytes',
		async (length) => {
			fetch_mock.mockResolvedValue(
				json({
					request_id,
					status: 'failed',
					content: 'x'.repeat(length),
				}),
			);
			const response = await call('ai_search', scenarios[0].args);
			expect(response.result.isError).toBe(true);
			expect(
				Buffer.byteLength(JSON.stringify(response.result)),
			).toBeLessThanOrEqual(80000);
		},
	);
	it.each(scenarios)(
		'$name reconstructs large partial failure evidence exactly through result_read',
		async (scenario) => {
			const text = (evidence + '\n').repeat(4000);
			fetch_mock.mockResolvedValue(
				json({
					...scenario.body('failed', text),
					error: canary,
					config: { key: canary },
				}),
			);
			const response = await call(scenario.name, scenario.args);
			expect(response.result.isError).toBe(true);
			expect(meta(response)).toMatchObject({
				local_completeness: 'retained',
				job: { partial: true, state: 'failed' },
			});
			const payload = value(response);
			expect(payload.result.result_id).toEqual(expect.any(String));
			const recovered = await reconstruct(payload.result.result_id);
			expect(
				scenario.name === 'ai_search'
					? recovered.result[0].snippet
					: recovered.result.content,
			).toBe(text);
			expect(recovered.output).not.toContain(canary);
			expect(JSON.stringify(response)).not.toContain(canary);
			expect(fetch_mock).toHaveBeenCalledTimes(1);
		},
	);

	it.each(scenarios)(
		'$name keeps recovery when partial storage fails, without a false handle',
		async (scenario) => {
			vi.stubEnv('RETRIEVER_RESULT_MAX_BYTES', '1');
			vi.stubEnv('RETRIEVER_RESULT_STORE_MAX_BYTES', '1');
			fetch_mock.mockResolvedValue(
				json(scenario.body('failed', evidence.repeat(4000))),
			);
			const response = await call(scenario.name, scenario.args);
			expect(response.result.isError).toBe(true);
			expect(meta(response).local_completeness).toBe('unavailable');
			expect(value(response).job.id).toBe(
				scenario.name === 'ai_search' ? request_id : job_id,
			);
			expect(JSON.stringify(response)).not.toContain('result_id');
			expect(JSON.stringify(response)).not.toContain(evidence);
		},
	);
	it.each(scenarios)(
		'$name preserves partial failure evidence without exposing controls',
		async (scenario) => {
			fetch_mock.mockResolvedValue(
				json({
					...scenario.body('failed', evidence),
					error: canary,
					headers: { authorization: canary },
				}),
			);
			const response = await call(scenario.name, scenario.args);
			expect(response.result.isError).toBe(true);
			expect(value(response)).toMatchObject({
				job: { state: 'failed', partial: true },
			});
			expect(JSON.stringify(value(response).result)).toContain(
				evidence,
			);
			expect(meta(response)).toMatchObject({
				job: { state: 'failed', partial: true },
				error: { kind: 'upstream_failure', retryable: false },
			});
			expect(JSON.stringify(response)).not.toContain(canary);
			expect(
				fetch_mock.mock.calls.map(([, init]) => init.method),
			).toEqual(['GET']);
		},
	);

	it.each(scenarios)(
		'$name exposes honest unknown usage and current job state',
		async (scenario) => {
			const body: any = scenario.body('completed', evidence);
			delete body.creditsUsed;
			body.response_time = '1.5';
			body.usage = { credits: '99', private: canary };
			fetch_mock.mockResolvedValue(json(body));
			const response = await call(scenario.name, scenario.args);
			expect(response.result.isError).not.toBe(true);
			expect(meta(response)).toMatchObject({
				usage: null,
				usage_source: 'unknown',
				job: { state: 'completed', partial: false },
			});
			expect(meta(response).elapsed_ms).toBeGreaterThanOrEqual(0);
			expect(meta(response).response_time_seconds).toBeUndefined();
			expect(JSON.stringify(response)).not.toContain(canary);
		},
	);

	it('Tavily running results retain partial report and source text', async () => {
		fetch_mock.mockResolvedValue(
			json({
				request_id,
				status: 'in_progress',
				content: evidence,
				sources: [
					{
						url: 'https://example.test/report?edition=2',
						content: 'Source [7]',
					},
				],
			}),
		);
		const response = await call('ai_search', scenarios[0].args);
		expect(value(response)[0].snippet).toBe(evidence);
		expect(value(response)[1].snippet).toBe('Source [7]');
		expect(meta(response).job).toMatchObject({
			state: 'running',
			partial: true,
			resumable: true,
		});
	});

	it.each(['failed', 'cancelled'])(
		'Firecrawl bounded polling retains earlier partial data on %s',
		async (status) => {
			fetch_mock
				.mockResolvedValueOnce(json({ success: true, id: job_id }))
				.mockResolvedValueOnce(
					json({ status: 'processing', data: evidence }),
				)
				.mockResolvedValueOnce(json({ status }));
			const pending = call('firecrawl_agent', {
				prompt: 'offline',
				wait_for_completion: true,
			});
			await vi.advanceTimersByTimeAsync(6001);
			const response = await pending;
			expect(meta(response).job).toMatchObject({
				state: status,
				partial: true,
			});
			expect(JSON.stringify(value(response))).toContain(evidence);
			expect(response.result.isError === true).toBe(
				status === 'failed',
			);
			expect(
				fetch_mock.mock.calls.map(([, init]) => init.method),
			).toEqual(['POST', 'GET', 'GET']);
		},
	);

	it('Tavily polling retains earlier partial data through terminal failure', async () => {
		fetch_mock
			.mockResolvedValueOnce(json({ request_id, status: 'pending' }))
			.mockResolvedValueOnce(
				json({
					request_id,
					status: 'in_progress',
					content: evidence,
				}),
			)
			.mockResolvedValueOnce(json({ request_id, status: 'failed' }));
		const pending = call('ai_search', {
			provider: 'tavily_research',
			query: 'offline',
		});
		await vi.advanceTimersByTimeAsync(10001);
		const response = await pending;
		expect(response.result.isError).toBe(true);
		expect(value(response).job).toMatchObject({
			state: 'failed',
			partial: true,
		});
		expect(JSON.stringify(value(response).result)).toContain(
			evidence,
		);
		expect(
			fetch_mock.mock.calls.map(([, init]) => init.method),
		).toEqual(['POST', 'GET', 'GET']);
	});

	it('accepted Tavily caller cancellation retains recovery without claiming remote cancellation', async () => {
		fetch_mock.mockResolvedValueOnce(
			json({ request_id, status: 'pending' }),
		);
		const controller = new AbortController();
		const pending = call(
			'ai_search',
			{ provider: 'tavily_research', query: 'offline' },
			controller.signal,
		);
		await vi.advanceTimersByTimeAsync(1);
		controller.abort();
		const response = await pending;
		expect(response.error).toBeUndefined();
		expect(response.result.isError).toBe(true);
		expect(meta(response)).toMatchObject({
			error: { kind: 'cancelled' },
			job: {
				id: request_id,
				state: 'unknown',
				wait_interrupted: 'cancelled',
				resumable: true,
			},
		});
		await vi.advanceTimersByTimeAsync(30000);
		expect(fetch_mock).toHaveBeenCalledTimes(1);
	});

	it('rejected cancellation is unconfirmed and never starts replacement work', async () => {
		fetch_mock.mockResolvedValue(json({ error: canary }, 409));
		const response = await call('firecrawl_agent', {
			action: 'cancel',
			job_id,
		});
		expect(response.result.isError).toBe(true);
		expect(meta(response).job).toMatchObject({
			id: job_id,
			state: 'unknown',
			cancellation: 'unconfirmed',
		});
		expect(JSON.stringify(response)).not.toContain(canary);
		expect(
			fetch_mock.mock.calls.map(([, init]) => init.method),
		).toEqual(['DELETE']);
	});

	it.each(scenarios)(
		'$name returns unknown for an unrecognized state, never completed',
		async (scenario) => {
			fetch_mock.mockResolvedValue(
				json(scenario.body('future_state', evidence)),
			);
			const response = await call(scenario.name, scenario.args);
			expect(response.result.isError).toBe(true);
			expect(meta(response).job).toMatchObject({ state: 'unknown' });
			expect(JSON.stringify(response)).not.toContain(evidence);
		},
	);
});
