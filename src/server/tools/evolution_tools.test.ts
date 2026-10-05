import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createHash } from 'node:crypto';
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

// Synthetic upstream responses exercise real MCP dispatch, adapters, HTTP
// errors and result storage. They are not live-provider readiness evidence.
const source_url = 'https://example.test/report?edition=2';
const job_id = '12345678-1234-4234-8234-123456789abc';
const request_id = 'p0-research-request';
const canary = 'P0_UPSTREAM_PRIVATE_CANARY';
const content = 'Fixture evidence [1], code `array[2]`, math [x+y].';
const cases = [
	{
		name: 'web_search',
		args: { provider: 'tavily', query: 'fixture evidence' },
		method: 'POST',
		path: '/search',
		upstream: (text: string) => ({
			results: [
				{
					title: 'Fixture report',
					url: source_url,
					content: text,
					score: 0.8,
				},
			],
			response_time: 0.25,
		}),
		extracted: (value: any) => value[0].snippet,
	},
	{
		name: 'web_extract',
		args: {
			provider: 'tavily',
			url: source_url,
			query: 'fixture evidence',
		},
		method: 'POST',
		path: '/extract',
		upstream: (text: string) => ({
			results: [{ url: source_url, raw_content: text }],
			failed_results: [],
			response_time: 0.25,
		}),
		extracted: (value: any) => value.content,
	},
	{
		name: 'ai_search',
		args: {
			provider: 'tavily_research',
			action: 'status',
			request_id,
		},
		method: 'GET',
		path: `/research/${request_id}`,
		upstream: (text: string) => ({
			status: 'completed',
			request_id,
			content: text,
			sources: [
				{
					title: 'Fixture report',
					url: source_url,
					content: 'Source evidence',
				},
			],
			response_time: 0.25,
		}),
		extracted: (value: any) => value[0].snippet,
	},
	{
		name: 'firecrawl_agent',
		args: { action: 'status', job_id },
		method: 'GET',
		path: `/v2/agent/${job_id}`,
		upstream: (text: string) => ({
			success: true,
			status: 'completed',
			data: text,
			model: 'spark-2',
			creditsUsed: 0,
		}),
		extracted: (value: any) => value.content,
	},
];
const settings = Object.values(config).flatMap((category) =>
	Object.values(category),
);
const original_keys = settings.map((item) => item.api_key);
let server: ReturnType<typeof create_server>;
let home: string;
let sequence: number;
let unexpected: number;
const attempts: Array<{
	method: string;
	path: string;
	body: unknown;
}> = [];
const fetch_mock = vi.fn<(...args: any[]) => Promise<Response>>();
const call = async (
	name: string,
	args: Record<string, unknown>,
	signal?: AbortSignal,
) => {
	const response: any = await server.receive(
		{
			jsonrpc: '2.0',
			id: ++sequence,
			method: 'tools/call',
			params: { name, arguments: args },
		},
		{ signal },
	);
	return response;
};
const text_of = (response: any) =>
	response.result?.content?.[0]?.text ?? '';
const parsed = (response: any) => JSON.parse(text_of(response));
// The P2 request sidecar is additive; compare unchanged successful legacy
// bodies against P0 without rewriting that historical fixture. Changed
// lifecycle/error payloads below use explicit P2 assertions instead.
const without_request_metadata = (result: any) => {
	const { _meta, ...legacy } = result;
	return legacy;
};
// Check the entire new wire envelope before removing only the approved
// additive field. The historical snapshots still guard the exact text.
const without_structured_content = (
	result: any,
	expected: Record<string, unknown>,
) => {
	expect(
		JSON.parse(JSON.stringify(result.structuredContent)),
	).toStrictEqual(expected);
	const { structuredContent: _structuredContent, ...legacy } = result;
	return legacy;
};
// Only call after the replacement P2 assertions pass. These P0 snapshots
// document superseded error/lifecycle behavior, not a current contract.
// Guard their bytes and keep Vitest from treating them as deletable debris;
// unchanged success snapshots still use the ordinary matcher.
const preserve_historical_snapshot = () => {
	expect(
		createHash('sha256')
			.update(
				readFileSync(
					new URL(
						'./__snapshots__/evolution_tools.test.ts.snap',
						import.meta.url,
					),
				),
			)
			.digest('hex'),
	).toBe(
		'8f1bd0f833e1590964c79c19079c9529da0eec30413b74935ed4453ae31ac2be',
	);
	const state = expect.getState();
	state.snapshotState.markSnapshotsAsCheckedForTest(
		state.currentTestName!,
	);
};
const failed = (response: any) =>
	response.result?.isError === true || response.error !== undefined;
const json_response = (body: unknown, status = 200) =>
	new Response(JSON.stringify(body), {
		status,
		headers: { 'content-type': 'application/json' },
	});
const respond = (
	scenario: (typeof cases)[number],
	body: unknown,
	status = 200,
) => {
	fetch_mock.mockImplementation(async (url, options) => {
		const destination = new URL(String(url));
		const path = destination.pathname;
		const method = options?.method ?? 'GET';
		attempts.push({
			method,
			path,
			body: options.body ? JSON.parse(options.body) : null,
		});
		const expected_origin =
			scenario.name === 'firecrawl_agent'
				? 'https://api.firecrawl.dev'
				: 'https://api.tavily.com';
		if (
			destination.origin !== expected_origin ||
			path !== scenario.path ||
			method !== scenario.method
		) {
			unexpected++;
			throw new Error('P0_UNEXPECTED_PROVIDER_NETWORK');
		}
		return json_response(body, status);
	});
};
const reconstruct = async (id: string) => {
	let offset = 1;
	let byte_offset = 0;
	let output = '';
	for (let pages = 1; pages <= 200; pages++) {
		const result = await call('result_read', {
			result_id: id,
			offset,
			byte_offset,
			limit: 500,
		});
		expect(failed(result)).toBe(false);
		const chunk = parsed(result);
		output += chunk.content;
		if (chunk.next_offset === undefined) {
			const marker = '\nFULL RESULT JSON\n';
			const start = output.lastIndexOf(marker);
			return {
				canonical: JSON.parse(
					start < 0 ? output : output.slice(start + marker.length),
				),
				pages,
			};
		}
		if (chunk.next_byte_offset === undefined) output += '\n';
		offset = chunk.next_offset;
		byte_offset = chunk.next_byte_offset ?? 0;
	}
	throw new Error('P0 result reconstruction exceeded page bound');
};

beforeEach(() => {
	home = mkdtempSync(join(tmpdir(), 'retriever-p0-tools-'));
	vi.stubEnv('RETRIEVER_RESULT_DIR', join(home, 'results'));
	sequence = 0;
	unexpected = 0;
	attempts.length = 0;
	fetch_mock.mockReset();
	fetch_mock.mockImplementation(async () => {
		unexpected++;
		throw new Error('P0_UNEXPECTED_PROVIDER_NETWORK');
	});
	vi.stubGlobal('fetch', fetch_mock);
	vi.spyOn(console, 'error').mockImplementation(() => {});
	vi.spyOn(console, 'warn').mockImplementation(() => {});
	for (const item of settings)
		item.api_key = 'p0-offline-fixture-key';
	server = create_server({ name: 'p0-offline-tools', version: '1' });
});
afterEach(() => {
	for (const [index, item] of settings.entries())
		item.api_key = original_keys[index];
	vi.useRealTimers();
	vi.unstubAllGlobals();
	vi.unstubAllEnvs();
	vi.restoreAllMocks();
	rmSync(home, { recursive: true, force: true });
	expect(unexpected).toBe(0);
});

for (const scenario of cases) {
	describe(`P0 ${scenario.name} legacy contract`, () => {
		it('snapshots success and exact request options without fallback', async () => {
			respond(scenario, scenario.upstream(content));
			const response = await call(scenario.name, scenario.args);
			expect(failed(response)).toBe(false);
			expect(scenario.extracted(parsed(response))).toBe(content);
			expect(attempts).toHaveLength(1);
			expect({
				response:
					scenario.name === 'web_search' ||
					scenario.name === 'web_extract'
						? without_structured_content(response.result, {
								ok: true,
								data: parsed(response),
							})
						: without_request_metadata(response.result),
				requests: attempts,
			}).toMatchSnapshot();
		});

		it('preserves authentication failure without leaking upstream body or switching provider', async () => {
			respond(scenario, { error: canary }, 401);
			const response = await call(scenario.name, scenario.args);
			expect(failed(response)).toBe(true);
			expect(JSON.stringify(response)).not.toContain(canary);
			expect(attempts).toHaveLength(1);
			if (
				scenario.name === 'ai_search' ||
				scenario.name === 'firecrawl_agent'
			) {
				expect(response.result._meta.retriever.error).toMatchObject({
					kind: 'authentication',
					http_status: 401,
					retryable: false,
				});
				expect(parsed(response).job.state).toBe('unknown');
				preserve_historical_snapshot();
			} else
				expect(
					without_structured_content(response.result, {
						ok: false,
						error: {
							kind: 'authentication',
							http_status: 401,
							provider:
								scenario.name === 'web_search'
									? 'tavily'
									: 'tavily_extract',
							retryable: false,
						},
					}),
				).toMatchSnapshot();
		});

		it('reports a transport timeout without fallback', async () => {
			fetch_mock.mockImplementation(async () => {
				throw new DOMException(
					'synthetic upstream timeout',
					'TimeoutError',
				);
			});
			const response = await call(scenario.name, scenario.args);
			expect(failed(response)).toBe(true);
			expect(JSON.stringify(response)).toContain('timed out');
			expect(fetch_mock).toHaveBeenCalledTimes(1);
		});

		it('propagates caller cancellation into the outstanding request', async () => {
			const controller = new AbortController();
			let ready!: () => void;
			const started = new Promise<void>((resolve) => {
				ready = resolve;
			});
			let upstream_signal: AbortSignal;
			fetch_mock.mockImplementation((_url, options) => {
				upstream_signal = options.signal;
				ready();
				return new Promise((_resolve, reject) => {
					upstream_signal.addEventListener(
						'abort',
						() => reject(upstream_signal.reason),
						{ once: true },
					);
				});
			});
			const pending = call(
				scenario.name,
				scenario.args,
				controller.signal,
			);
			await started;
			controller.abort();
			const response = await pending;
			expect(upstream_signal!.aborted).toBe(true);
			expect(failed(response)).toBe(true);
			expect(fetch_mock).toHaveBeenCalledTimes(1);
			if (
				scenario.name === 'ai_search' ||
				scenario.name === 'firecrawl_agent'
			) {
				expect(response.error).toBeUndefined();
				expect(response.result._meta.retriever.error.kind).toBe(
					'cancelled',
				);
				preserve_historical_snapshot();
			} else
				expect(
					without_structured_content(response.result, {
						ok: false,
						error: { kind: 'cancelled', retryable: false },
					}),
				).toMatchSnapshot();
		});

		it('rejects missing required input before any networking', async () => {
			const response = await call(scenario.name, {});
			expect(failed(response)).toBe(true);
			expect(fetch_mock).not.toHaveBeenCalled();
		});

		it('reconstructs oversized canonical evidence losslessly through result_read', async () => {
			const large = 'P0 evidence 😀 漢\n'.repeat(6000);
			respond(scenario, scenario.upstream(large));
			const response = await call(scenario.name, scenario.args);
			expect(failed(response)).toBe(false);
			const handle = parsed(response);
			expect(handle.result_id).toMatch(/^[0-9a-f-]{36}$/);
			expect(
				Buffer.byteLength(JSON.stringify(response)),
			).toBeLessThan(80000);
			const { canonical, pages } = await reconstruct(
				handle.result_id,
			);
			expect(scenario.extracted(canonical)).toBe(large);
			expect(pages).toBeGreaterThan(1);
			expect(attempts).toHaveLength(1);
			if (scenario.name === 'web_extract')
				expect(canonical.raw_contents).toEqual([
					{ url: source_url, content: large },
				]);
			if (scenario.name === 'ai_search')
				expect(canonical[1].url).toBe(source_url);
			console.info(
				JSON.stringify({
					fixture: scenario.name,
					initial_rpc_bytes: Buffer.byteLength(
						JSON.stringify(response),
					),
					canonical_json_bytes: Buffer.byteLength(
						JSON.stringify(canonical, null, 2),
					),
					result_read_calls: pages,
				}),
			);
		});
	});
}

describe('P0 research and Agent lifecycle gaps', () => {
	it.each(cases.slice(2))(
		'reports unknown job IDs for $name without creating a replacement',
		async (scenario) => {
			respond(scenario, { error: canary }, 404);
			const response = await call(scenario.name, scenario.args);
			expect(failed(response)).toBe(true);
			expect(attempts).toHaveLength(1);
			expect(attempts[0].method).toBe('GET');
			expect(JSON.stringify(response)).not.toContain(canary);
			expect(response.result._meta.retriever).toMatchObject({
				error: { http_status: 404 },
				job: { state: 'unknown' },
			});
			preserve_historical_snapshot();
		},
	);

	it('resumes Tavily pending to completion with GETs and keeps citation-like source text intact', async () => {
		const scenario = cases[2];
		respond(scenario, {
			status: 'in_progress',
			request_id,
			content: 'partial source text',
		});
		const pending = await call(scenario.name, scenario.args);
		expect(parsed(pending)[0].metadata.status).toBe('in_progress');
		expect(parsed(pending)[0].metadata.resumable).toBe(true);
		// P2 closes the recorded P0 gap without refreshing its snapshot.
		expect(text_of(pending)).toContain('partial source text');
		respond(scenario, scenario.upstream(content));
		const done = await call(scenario.name, scenario.args);
		expect(parsed(done)[0].snippet).toBe(content);
		expect(attempts.map(({ method }) => method)).toEqual([
			'GET',
			'GET',
		]);
		expect(pending.result._meta.retriever.job).toMatchObject({
			state: 'running',
			partial: true,
		});
		preserve_historical_snapshot();
	});

	it.each(cases.slice(2))(
		'records discarded partial failure evidence for $name',
		async (scenario) => {
			respond(scenario, {
				status: 'failed',
				success: true,
				request_id,
				content: 'P0_PARTIAL_EVIDENCE',
				data: 'P0_PARTIAL_EVIDENCE',
				error: canary,
			});
			const response = await call(scenario.name, scenario.args);
			expect(failed(response)).toBe(true);
			expect(JSON.stringify(response)).toContain(
				'P0_PARTIAL_EVIDENCE',
			);
			expect(JSON.stringify(response)).not.toContain(canary);
			expect(text_of(response)).toContain(
				scenario.name === 'ai_search' ? request_id : job_id,
			);
			expect(attempts).toHaveLength(1);
			expect(parsed(response).job).toMatchObject({
				state: 'failed',
				partial: true,
			});
			preserve_historical_snapshot();
		},
	);

	it('rejects a mismatched Tavily request ID rather than reporting completion', async () => {
		respond(cases[2], {
			...cases[2].upstream(content),
			request_id: 'p0-other-request',
		});
		const response = await call('ai_search', cases[2].args);
		expect(failed(response)).toBe(true);
		expect(text_of(response)).not.toContain(content);
		expect(attempts).toHaveLength(1);
	});

	it.each(cases.slice(2))(
		'does not interpret an unknown upstream state as completed for $name',
		async (scenario) => {
			respond(scenario, {
				...scenario.upstream(content),
				status: 'ambiguous-new-state',
			});
			const response = await call(scenario.name, scenario.args);
			expect(failed(response)).toBe(true);
			expect(text_of(response)).not.toContain(content);
		},
	);

	it('creates a Firecrawl job once with bounded default credits, then reads status', async () => {
		fetch_mock.mockImplementation(async (url, options) => {
			const method = options.method;
			const destination = new URL(String(url));
			const path = destination.pathname;
			if (destination.origin !== 'https://api.firecrawl.dev') {
				unexpected++;
				throw new Error('P0_UNEXPECTED_PROVIDER_NETWORK');
			}
			attempts.push({
				method,
				path,
				body: options.body ? JSON.parse(options.body) : null,
			});
			if (method === 'POST' && path === '/v2/agent')
				return json_response({ success: true, id: job_id });
			if (method === 'GET' && path === cases[3].path)
				return json_response(cases[3].upstream(content));
			unexpected++;
			throw new Error('P0_UNEXPECTED_PROVIDER_NETWORK');
		});
		const start = await call('firecrawl_agent', {
			prompt: 'offline synthetic task',
		});
		expect(parsed(start).metadata).toMatchObject({
			job_id,
			status: 'processing',
		});
		const done = await call('firecrawl_agent', cases[3].args);
		expect(parsed(done).content).toBe(content);
		expect(attempts.map(({ method }) => method)).toEqual([
			'POST',
			'GET',
		]);
		expect(attempts[0].body).toEqual({
			prompt: 'offline synthetic task',
			model: 'spark-2',
			maxCredits: 100,
		});
	});

	it('records cancellation acknowledgement followed by failed Firecrawl status without inventing normalization', async () => {
		const cancel_scenario = { ...cases[3], method: 'DELETE' };
		respond(cancel_scenario, { success: true });
		const cancelled = await call('firecrawl_agent', {
			action: 'cancel',
			job_id,
		});
		expect(parsed(cancelled).metadata.status).toBe('cancelled');
		respond(cases[3], {
			success: true,
			status: 'failed',
			error: 'Refusal: Error: Agent was cancelled',
			creditsUsed: 0,
		});
		const readback = await call('firecrawl_agent', cases[3].args);
		expect(failed(readback)).toBe(true);
		expect(attempts.map(({ method }) => method)).toEqual([
			'DELETE',
			'GET',
		]);
		expect(cancelled.result._meta.retriever.job).toMatchObject({
			state: 'cancelled',
			cancellation: 'confirmed',
		});
		expect(readback.result._meta.retriever.job).toMatchObject({
			state: 'failed',
		});
		preserve_historical_snapshot();
	});

	it('does not report rejected cancellation as success', async () => {
		respond(
			{ ...cases[3], method: 'DELETE' },
			{ error: canary },
			409,
		);
		const response = await call('firecrawl_agent', {
			action: 'cancel',
			job_id,
		});
		expect(failed(response)).toBe(true);
		expect(text_of(response)).toContain('409');
		expect(text_of(response)).not.toContain(canary);
	});
});
