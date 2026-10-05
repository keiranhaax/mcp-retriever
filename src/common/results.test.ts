import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { read_result_chunk } from './result_store.js';
import {
	aggregate_url_results,
	handle_large_result,
} from './results.js';
import { ErrorType } from './types.js';

let result_dir: string;

beforeEach(() => {
	result_dir = mkdtempSync(join(tmpdir(), 'retriever-results-test-'));
	process.env.RETRIEVER_RESULT_DIR = result_dir;
});

afterEach(() => {
	delete process.env.RETRIEVER_RESULT_DIR;
	rmSync(result_dir, { recursive: true, force: true });
});

describe('handle_large_result', () => {
	it('skips optional readable formatting when canonical JSON needs compression', () => {
		process.env.RETRIEVER_RESULT_MAX_BYTES = '10000';
		let raw_reads = 0;
		const original = {
			content: 'body'.repeat(30000),
			get raw_contents() {
				raw_reads++;
				return [];
			},
			citations: ['preserved'],
		};
		try {
			const pointer = handle_large_result(original, 'fixture') as {
				result_id: string;
				sections: Array<{ title: string; line: number }>;
			};
			expect(raw_reads).toBe(1);
			expect(
				statSync(join(result_dir, `${pointer.result_id}.omr`)).size,
			).toBeLessThan(10000);
			expect(pointer.sections).toEqual([
				{ title: 'FULL RESULT JSON', line: 1 },
			]);
			expect(
				read_result_chunk(pointer.result_id).content.startsWith('{'),
			).toBe(true);
		} finally {
			delete process.env.RETRIEVER_RESULT_MAX_BYTES;
		}
	});
	it.each([
		'RETRIEVER_RESULT_MAX_BYTES',
		'RETRIEVER_RESULT_STORE_MAX_BYTES',
	])(
		'uses canonical-only storage when the readable view exceeds %s',
		(setting) => {
			const original = {
				content: 'a'.repeat(90000),
				citations: ['preserved'],
			};
			const canonical = JSON.stringify(original, null, 2);
			const quota = Buffer.byteLength(canonical) + 100;
			process.env[setting] = String(quota);
			try {
				const pointer = handle_large_result(original, 'fixture') as {
					result_id: string;
				};
				const file = join(result_dir, `${pointer.result_id}.txt`);
				expect(statSync(file).size).toBeLessThanOrEqual(quota);
				const stored = readFileSync(file, 'utf8');
				expect(stored).toContain('FULL RESULT JSON\n');
				expect(JSON.parse(stored.slice(stored.indexOf('{')))).toEqual(
					original,
				);
			} finally {
				delete process.env[setting];
			}
		},
	);

	it('retains canonical JSON even when it exactly fills the quota', () => {
		const original = { content: 'a'.repeat(90000) };
		const canonical = JSON.stringify(original, null, 2);
		process.env.RETRIEVER_RESULT_MAX_BYTES = String(
			Buffer.byteLength(canonical),
		);
		try {
			const pointer = handle_large_result(original, 'fixture') as {
				result_id: string;
			};
			expect(
				readFileSync(
					join(result_dir, `${pointer.result_id}.txt`),
					'utf8',
				),
			).toBe(canonical);
		} finally {
			delete process.env.RETRIEVER_RESULT_MAX_BYTES;
		}
	});

	it('returns the original result when it is safely sized', () => {
		const result = {
			content: 'small result',
			metadata: { word_count: 2 },
			source_provider: 'exa',
		};

		expect(handle_large_result(result, 'web_extract')).toBe(result);
	});

	it('preserves multiline content and every semantic field in storage', () => {
		const original = {
			content: `# Rich title\nAuthor: marker-author\n${'body line\n'.repeat(12000)}`,
			raw_contents: [
				{
					url: 'https://example.com',
					content: 'raw-only',
					extra: 'raw-extra',
				},
			],
			citations: [
				{ title: 'citation-marker', url: 'https://example.org' },
			],
			metadata: { summary: 'summary-marker' },
			highlights: ['highlight-marker'],
		};
		const pointer = handle_large_result(original, 'fixture') as {
			result_id: string;
		};
		let offset = 1;
		let byte_offset = 0;
		let stored = '';
		for (let page = 0; page < 200; page++) {
			const chunk = read_result_chunk(
				pointer.result_id,
				offset,
				500,
				byte_offset,
			);
			stored += chunk.content;
			if (chunk.next_offset === undefined) break;
			if (chunk.next_byte_offset === undefined) stored += '\n';
			offset = chunk.next_offset;
			byte_offset = chunk.next_byte_offset ?? 0;
		}
		expect(stored.includes(original.content)).toBe(true);
		const marker = '\nFULL RESULT JSON\n';
		expect(stored).toContain(marker);
		expect(
			JSON.parse(
				stored.slice(stored.lastIndexOf(marker) + marker.length),
			),
		).toEqual(original);
	});

	it('bounds inline outlines and header metadata in UTF-8 bytes', () => {
		const original = {
			content: Array.from(
				{ length: 10000 },
				(_, index) => `# ${index} ${'🙂'.repeat(100)}`,
			).join('\n'),
			metadata: {
				word_count: 'x'.repeat(100000),
				urls_processed: { value: 'x'.repeat(100000) },
			},
			source_provider: 'x'.repeat(100000),
		};
		const pointer = handle_large_result(original, 'fixture') as {
			result_id: string;
			sections_truncated?: boolean;
		};
		expect(
			Buffer.byteLength(JSON.stringify(pointer, null, 2)),
		).toBeLessThanOrEqual(8000);
		expect(pointer.sections_truncated).toBe(true);
		expect(pointer.result_id).toMatch(/^[0-9a-f-]{36}$/);
	});

	it('bounds the escaped MCP text payload, not just the inner JSON', () => {
		const result = { content: '\\'.repeat(35000) };
		const safe = handle_large_result(result, 'fixture');
		expect(safe).toHaveProperty('result_id');
		expect(
			Buffer.byteLength(
				JSON.stringify({
					content: [
						{ type: 'text', text: JSON.stringify(safe, null, 2) },
					],
				}),
			),
		).toBeLessThan(80000);
	});

	it('uses UTF-8 bytes rather than UTF-16 length for inline limits', () => {
		const result = { content: '漢'.repeat(30000) };
		expect(handle_large_result(result, 'fixture')).toHaveProperty(
			'result_id',
		);
	});

	it('does not duplicate the raw readable view when rich content already exists', () => {
		const content = 'readable body\n'.repeat(5000);
		const original = {
			content,
			raw_contents: [{ url: 'https://example.com', content }],
		};
		// The canonical JSON plus one readable view fits; a second view does not.
		const bytes =
			Buffer.byteLength(JSON.stringify(original, null, 2)) +
			Buffer.byteLength(content) +
			1000;
		process.env.RETRIEVER_RESULT_MAX_BYTES = String(bytes);
		try {
			expect(handle_large_result(original, 'fixture')).toHaveProperty(
				'result_id',
			);
		} finally {
			delete process.env.RETRIEVER_RESULT_MAX_BYTES;
		}
	});

	it('stores oversized results behind an opaque paginated result ID', () => {
		const large_result = {
			raw_contents: [
				{
					url: 'https://example.com/article',
					content: '# Heading\nThis is a large extracted page.',
				},
			],
			metadata: {
				word_count: 6,
				urls_processed: 1,
			},
			source_provider: 'tavily',
			padding: 'x'.repeat(90000),
		};

		const result = handle_large_result(
			large_result,
			'web_extract',
		) as {
			result_id: string;
			total_lines: number;
			estimated_tokens: number;
			expires_at: string;
			sections: Array<{ title: string; line: number }>;
			metadata: Record<string, unknown>;
			read_hint: string;
		};

		expect(result.result_id).toMatch(/^[0-9a-f-]{36}$/);
		expect(result.total_lines).toBeGreaterThan(0);
		expect(result.estimated_tokens).toBeGreaterThan(20000);
		expect(new Date(result.expires_at).getTime()).toBeGreaterThan(
			Date.now(),
		);
		expect(result.sections).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					title: 'URL: https://example.com/article',
				}),
				expect.objectContaining({ title: 'Heading' }),
				expect.objectContaining({ title: 'METADATA' }),
			]),
		);
		expect(result.read_hint).toContain(result.result_id);
		expect(result.read_hint).toContain('result_read');
		expect(result.metadata).toEqual({
			word_count: 6,
			urls_processed: 1,
			source_provider: 'tavily',
		});

		const written = read_result_chunk(
			result.result_id,
			1,
			500,
		).content;
		expect(written).toContain('URL: https://example.com/article');
		expect(written).toContain('# Heading');
		expect(written).toContain('METADATA');
	});
});

describe('aggregate_url_results', () => {
	it('combines successful results and reports failures in metadata', () => {
		const result = aggregate_url_results(
			[
				{
					url: 'https://example.com/a',
					content: 'hello world',
					metadata: { title: 'Article A' },
					success: true,
				},
				{
					url: 'https://example.com/b',
					content: 'another article',
					success: true,
				},
				{
					url: 'https://example.com/c',
					content: '',
					success: false,
					error: 'failed',
				},
			],
			'firecrawl',
			[
				'https://example.com/a',
				'https://example.com/b',
				'https://example.com/c',
			],
			'advanced',
		);

		expect(result).toEqual({
			content: 'hello world\n\nanother article',
			raw_contents: [
				{ url: 'https://example.com/a', content: 'hello world' },
				{ url: 'https://example.com/b', content: 'another article' },
			],
			metadata: {
				title: 'Article A',
				word_count: 4,
				failed_urls: ['https://example.com/c'],
				urls_processed: 3,
				successful_extractions: 2,
				extract_depth: 'advanced',
			},
			source_provider: 'firecrawl',
		});
	});

	it('throws when every URL fails', () => {
		expect(() =>
			aggregate_url_results(
				[
					{
						url: 'https://example.com/a',
						content: '',
						success: false,
						error: 'failed',
					},
				],
				'firecrawl',
				['https://example.com/a'],
				'basic',
			),
		).toThrowError(
			expect.objectContaining({
				type: ErrorType.PROVIDER_ERROR,
				provider: 'firecrawl',
				message: 'Failed to extract content from all URLs',
				// Every URL already failed; never repeat the paid calls.
				details: { retryable: false },
			}),
		);
	});
});
