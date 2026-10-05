import {
	mkdtempSync,
	readdirSync,
	rmSync,
	statSync,
	utimesSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import {
	canonical_result,
	present_result,
	tool_result_bytes,
} from './presentation.js';
import { read_result_chunk } from './result_store.js';

let directory: string;
const options = {
	response_mode: 'compact' as const,
	provider: 'fixture',
	operation: 'extract',
	elapsed_ms: 0,
	output_budget_bytes: 2048,
};
const fixture = (text = 'evidence😀漢字\n'.repeat(1000)) => ({
	content: text,
	raw_contents: [{ url: 'https://example.test/?a=1', content: text }],
	metadata: {},
	source_provider: 'fixture',
});
beforeEach(() => {
	directory = mkdtempSync(
		join(tmpdir(), 'retriever-p1b-presentation-'),
	);
	vi.stubEnv('RETRIEVER_RESULT_DIR', directory);
});
afterEach(() => {
	vi.unstubAllEnvs();
	rmSync(directory, { recursive: true, force: true });
});

it('reports provider partial extraction separately from local selection', () => {
	const result = fixture();
	const response: any = present_result(
		{
			...result,
			metadata: { failed_urls: ['https://example.test/failed'] },
		},
		options,
	);
	expect(response.metadata.provider_partial).toBe(true);
	expect(response.warnings).toContain(
		'Provider reported failed sources; retained content includes successful sources only.',
	);
	expect(tool_result_bytes(response)).toBeLessThanOrEqual(2048);
});

it('keeps useful passages when many source identities exceed a small budget', () => {
	const result = Array.from({ length: 20 }, (_, index) => ({
		title: `Source ${index}`,
		url: `https://example.test/${index}`,
		snippet: 'Needle evidence [1].\n'.repeat(50),
		source_provider: 'fixture',
	}));
	const response: any = present_result(result, {
		...options,
		query: 'Needle',
	});
	expect(
		response.sources.some((source: any) =>
			source.passages.some((passage: any) =>
				passage.text.includes('Needle evidence [1]'),
			),
		),
	).toBe(true);
	expect(response.sources.length + response.omitted_sources).toBe(20);
	expect(tool_result_bytes(response)).toBeLessThanOrEqual(2048);
});

it.each(['similar', 'crawl', 'map', 'search'])(
	'never labels %s aggregate content with the input seed URL',
	(operation) => {
		const response: any = present_result(
			{
				content: 'Aggregate evidence.\n'.repeat(1000),
				raw_contents: [
					{
						url: 'https://example.test/returned',
						content: 'Returned source.\n'.repeat(500),
					},
				],
				metadata: {},
			},
			{ ...options, operation, urls: 'https://example.test/seed' },
		);
		for (const source of response.sources) {
			if (source.id === '/content')
				expect(source.url).toBeUndefined();
			else expect(source.url).toBe('https://example.test/returned');
		}
		expect(JSON.stringify(response.sources)).not.toContain(
			'https://example.test/seed',
		);
	},
);

it('normalizes only an exact duplicate aggregate without mutating input', () => {
	const source = fixture('One\nTwo');
	const original = JSON.stringify(source);
	expect(canonical_result(source)).not.toHaveProperty('content');
	expect(JSON.stringify(source)).toBe(original);
	expect(
		canonical_result({ ...source, content: 'Distinct summary' }),
	).toHaveProperty('content', 'Distinct summary');
});

it.each([2048, 2049, 4096, 12000, 80000])(
	'fits actual UTF-8 serialized budgets of %i with escaping and multibyte sources',
	(budget) => {
		for (const response_mode of ['compact', 'full'] as const) {
			const response: any = present_result(
				fixture('"\\\n😀漢字 [1]\t'.repeat(5000)),
				{ ...options, response_mode, output_budget_bytes: budget },
			);
			expect(tool_result_bytes(response)).toBeLessThanOrEqual(budget);
			expect(response.result_id).toEqual(expect.any(String));
		}
	},
);

it('keeps small complete compact results inline without storage', () => {
	const result: any = present_result(
		fixture('Small citation [1].'),
		options,
	);
	expect(result.metadata.local_completeness).toBe('complete');
	expect(result.result_id).toBeUndefined();
	expect(readdirSync(directory)).toEqual([]);
});

it('honors the exact boundary for the complete escaped tool result', () => {
	const source = fixture('"\\😀'.repeat(600));
	const complete = present_result(source, {
		...options,
		response_mode: 'full',
		output_budget_bytes: 80000,
	});
	const exact = tool_result_bytes(complete);
	expect(exact).toBeGreaterThan(2048);
	expect(
		present_result(source, {
			...options,
			response_mode: 'full',
			output_budget_bytes: exact,
		}),
	).not.toHaveProperty('result_id');
	expect(
		present_result(source, {
			...options,
			response_mode: 'full',
			output_budget_bytes: exact - 1,
		}),
	).toHaveProperty('result_id');
});

it('retains bounded provenance when source identities alone exceed the budget', () => {
	const result = Array.from({ length: 100 }, (_, index) => ({
		title: '漢字'.repeat(1000),
		url: `https://example.test/${index}?q=${'x'.repeat(2000)}`,
		snippet: 'Needle evidence.'.repeat(100),
		source_provider: 'fixture',
	}));
	const response: any = present_result(result, options);
	expect(tool_result_bytes(response)).toBeLessThanOrEqual(2048);
	expect(response.source_count).toBe(100);
	expect(response.omitted_sources + response.sources.length).toBe(
		100,
	);
	expect(response.result_id).toEqual(expect.any(String));
});

it('retains existing private-file permissions and expiry for compact handles', () => {
	vi.stubEnv('RETRIEVER_RESULT_TTL_MS', '1000');
	const response: any = present_result(fixture(), options);
	const path = join(directory, `${response.result_id}.txt`);
	expect(statSync(directory).mode & 0o777).toBe(0o700);
	expect(statSync(path).mode & 0o777).toBe(0o600);
	expect(read_result_chunk(response.result_id).content).toContain(
		'response_mode',
	);
	utimesSync(path, new Date(0), new Date(0));
	expect(() => read_result_chunk(response.result_id)).toThrow(
		'Result not found or expired',
	);
});

it('retains aggregate-quota eviction and separate-directory isolation', () => {
	const source = fixture('evidence\n'.repeat(700));
	const first: any = present_result(source, options);
	const size = statSync(
		join(directory, `${first.result_id}.txt`),
	).size;
	vi.stubEnv('RETRIEVER_RESULT_STORE_MAX_BYTES', String(size + 512));
	const second: any = present_result(source, options);
	expect(() => read_result_chunk(first.result_id)).toThrow(
		'Result not found or expired',
	);
	expect(read_result_chunk(second.result_id).content).toContain(
		'response_mode',
	);
	vi.stubEnv('RETRIEVER_RESULT_DIR', join(directory, 'other'));
	expect(() => read_result_chunk(second.result_id)).toThrow(
		'Result not found or expired',
	);
});
