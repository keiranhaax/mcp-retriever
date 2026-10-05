import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
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
import { handle_large_result } from './results.js';

let directory: string;
const payload_bytes = (result: unknown) =>
	Buffer.byteLength(
		JSON.stringify({
			content: [
				{ type: 'text', text: JSON.stringify(result, null, 2) },
			],
		}),
	);

beforeEach(() => {
	directory = mkdtempSync(join(tmpdir(), 'retriever-p0-results-'));
	vi.stubEnv('RETRIEVER_RESULT_DIR', directory);
});
afterEach(() => {
	vi.unstubAllEnvs();
	rmSync(directory, { recursive: true, force: true });
});

describe('P0 legacy evidence boundary', () => {
	it('preserves the exact 80000-byte tool-result threshold, excluding JSON-RPC framing', () => {
		const overhead = payload_bytes({ content: '' });
		const at_limit = { content: 'x'.repeat(80000 - overhead) };
		expect(payload_bytes(at_limit)).toBe(80000);
		expect(handle_large_result(at_limit, 'fixture')).toBe(at_limit);
		expect(readdirSync(directory)).toEqual([]);
		const over_limit = { content: at_limit.content + 'x' };
		expect(payload_bytes(over_limit)).toBe(80001);
		const response = handle_large_result(over_limit, 'fixture');
		expect(response).toHaveProperty('result_id');
		expect(payload_bytes(response)).toBeLessThan(80000);
	});

	it('records that below-threshold content has no retained full-result handle', () => {
		const complete = {
			content: 'first passage\nsecond passage',
			source_provider: 'fixture',
		};
		const response = handle_large_result(complete, 'fixture');
		expect(response).toBe(complete);
		expect(response).not.toHaveProperty('result_id');
		expect(readdirSync(directory)).toEqual([]);
		// P1 must retain the complete source before any compact selection.
		// Calling this helper with the selected passage alone is not enough.
		const selected = {
			content: 'first passage',
			source_provider: 'fixture',
		};
		expect(
			handle_large_result(selected, 'fixture'),
		).not.toHaveProperty('result_id');
		expect(readdirSync(directory)).toEqual([]);
	});

	it('fails explicitly instead of issuing a handle when storage cannot retain canonical evidence', () => {
		vi.stubEnv('RETRIEVER_RESULT_MAX_BYTES', '1');
		vi.stubEnv('RETRIEVER_RESULT_STORE_MAX_BYTES', '1');
		expect(() =>
			handle_large_result({ content: 'x'.repeat(90000) }, 'fixture'),
		).toThrow();
		expect(readdirSync(directory)).toEqual([]);
	});
});
