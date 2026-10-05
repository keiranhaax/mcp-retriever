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
import { config } from '../config/env.js';
import { create_server } from './create_server.js';

const original_key = config.search.brave.api_key;
let result_dir: string;
beforeEach(() => {
	result_dir = mkdtempSync(join(tmpdir(), 'retriever-server-test-'));
	vi.stubEnv('RETRIEVER_RESULT_DIR', result_dir);
});
afterEach(() => {
	config.search.brave.api_key = original_key;
	vi.unstubAllGlobals();
	vi.unstubAllEnvs();
	rmSync(result_dir, { recursive: true, force: true });
});

describe('Retriever request context', () => {
	it('propagates a request cancellation to the provider fetch', async () => {
		config.search.brave.api_key = 'offline-test-key';
		const server = create_server({ name: 'audit', version: '1' });
		const controller = new AbortController();
		let resolve_started!: () => void;
		const started = new Promise<void>((resolve) => {
			resolve_started = resolve;
		});
		let provider_signal: AbortSignal | undefined;
		vi.stubGlobal('fetch', (_url: string, options: RequestInit) => {
			provider_signal = options.signal ?? undefined;
			resolve_started();
			return new Promise((_resolve, reject) => {
				provider_signal?.addEventListener(
					'abort',
					() => reject(provider_signal?.reason),
					{ once: true },
				);
			});
		});
		const pending = server.receive(
			{
				jsonrpc: '2.0',
				id: 1,
				method: 'tools/call',
				params: {
					name: 'web_search',
					arguments: { provider: 'brave', query: 'offline probe' },
				},
			},
			{ signal: controller.signal },
		);
		await started;
		controller.abort();
		expect(provider_signal?.aborted).toBe(true);
		await expect(pending).resolves.toMatchObject({
			id: 1,
			result: { isError: true },
		});
	});
});
