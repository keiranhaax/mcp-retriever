import {
	chmodSync,
	existsSync,
	mkdtempSync,
	rmSync,
	statSync,
	utimesSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import * as fs from 'node:fs';
import { vi } from 'vitest';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
	cleanup_expired_results,
	read_result_chunk,
	store_result,
} from './result_store.js';

vi.mock('node:fs', async (importOriginal) => ({
	...(await importOriginal<typeof import('node:fs')>()),
}));

let result_dir: string;

beforeEach(() => {
	result_dir = mkdtempSync(join(tmpdir(), 'retriever-result-test-'));
	process.env.RETRIEVER_RESULT_DIR = result_dir;
	process.env.RETRIEVER_RESULT_TTL_MS = '86400000';
	delete process.env.RETRIEVER_RESULT_MAX_BYTES;
	delete process.env.RETRIEVER_RESULT_STORE_MAX_BYTES;
});

afterEach(() => {
	delete process.env.RETRIEVER_RESULT_DIR;
	delete process.env.RETRIEVER_RESULT_TTL_MS;
	delete process.env.RETRIEVER_RESULT_MAX_BYTES;
	delete process.env.RETRIEVER_RESULT_STORE_MAX_BYTES;
	rmSync(result_dir, { recursive: true, force: true });
});

describe('remote result store', () => {
	it.each(['txt', 'omr'])(
		'rejects oversized on-disk %s before allocation or scanning',
		(extension) => {
			const id = randomUUID();
			const path = join(result_dir, `${id}.${extension}`);
			fs.writeFileSync(path, '');
			fs.truncateSync(path, 101 * 1024 * 1024);
			const spy = vi.spyOn(fs, 'readSync');
			try {
				expect(() => read_result_chunk(id)).toThrow('logical limit');
				expect(spy).not.toHaveBeenCalled();
			} finally {
				spy.mockRestore();
			}
		},
	);

	it.each(['txt', 'omr'])(
		'preserves indexed random access and byte validation for %s',
		(extension) => {
			if (extension === 'omr')
				process.env.RETRIEVER_RESULT_MAX_BYTES = '50000';
			const lines = [
				'header',
				'🙂'.repeat(40000),
				...Array.from({ length: 10000 }, (_, i) => `line ${i}`),
				'',
			];
			const stored = store_result(lines.join('\n'));
			for (const line of [1, 2, 3, 4096, 8000, lines.length]) {
				const chunk = read_result_chunk(stored.result_id, line, 1);
				expect(chunk.content).toBe(
					line === 2 ? '🙂'.repeat(3000) : lines[line - 1],
				);
				expect(chunk.total_lines).toBe(lines.length);
			}
			expect(
				read_result_chunk(stored.result_id, lines.length + 1).content,
			).toBe('');
			expect(() =>
				read_result_chunk(stored.result_id, 2, 1, 1),
			).toThrow('UTF-8 character boundary');
			expect(() =>
				read_result_chunk(stored.result_id, 2, 1, 160001),
			).toThrow('exceeds the selected line');
		},
	);

	it('does not re-inflate compressed pages and keeps only one decoded result', () => {
		process.env.RETRIEVER_RESULT_MAX_BYTES = '1000';
		const first = store_result('🙂'.repeat(20000));
		const second = store_result('b'.repeat(80000));
		read_result_chunk(first.result_id);
		const spy = vi.spyOn(fs, 'readSync');
		try {
			read_result_chunk(first.result_id, 1, 500, 12000);
			expect(spy).not.toHaveBeenCalled();
			read_result_chunk(second.result_id);
			spy.mockClear();
			read_result_chunk(first.result_id);
			expect(spy).toHaveBeenCalled();
		} finally {
			spy.mockRestore();
		}
	});

	it('bounds the index cache and reindexes evicted legacy files', () => {
		const ids = Array.from(
			{ length: 17 },
			() => store_result('a\nb').result_id,
		);
		for (const id of ids) read_result_chunk(id);
		const spy = vi.spyOn(fs, 'readSync');
		try {
			read_result_chunk(ids[16]);
			const cached_reads = spy.mock.calls.length;
			spy.mockClear();
			read_result_chunk(ids[0]);
			expect(spy.mock.calls.length).toBeGreaterThan(cached_reads);
		} finally {
			spy.mockRestore();
		}
	});

	it.each(['txt', 'omr'])(
		'invalidates cached %s content when replaced',
		(extension) => {
			if (extension === 'omr')
				process.env.RETRIEVER_RESULT_MAX_BYTES = '100';
			const first = store_result('a'.repeat(10000));
			const second = store_result('b'.repeat(10000));
			read_result_chunk(first.result_id);
			fs.renameSync(
				join(result_dir, `${second.result_id}.${extension}`),
				join(result_dir, `${first.result_id}.${extension}`),
			);
			expect(read_result_chunk(first.result_id).content).toBe(
				'b'.repeat(10000),
			);
		},
	);

	it.each([
		'header',
		'length',
		'inflate',
		'checksum',
		'truncated',
		'oversized',
	])(
		'rejects %s corruption without returning partial content',
		(kind) => {
			const id = randomUUID();
			const payload = gzipSync('a'.repeat(100000));
			const header = Buffer.alloc(8);
			header.write('OMR1');
			header.writeUInt32LE(100000, 4);
			if (kind === 'header') header.write('OMR2');
			if (kind === 'length') header.writeUInt32LE(100001, 4);
			if (kind === 'inflate') header.writeUInt32LE(1, 4);
			if (kind === 'oversized')
				header.writeUInt32LE(100 * 1024 * 1024 + 1, 4);
			if (kind === 'checksum') payload[payload.length - 8] ^= 1;
			const bytes = Buffer.concat([header, payload]);
			fs.writeFileSync(
				join(result_dir, `${id}.omr`),
				kind === 'truncated' ? bytes.subarray(0, -1) : bytes,
			);
			expect(() => read_result_chunk(id)).toThrow(
				'Stored result is corrupt or exceeds the logical limit',
			);
		},
	);

	it('enforces the independent logical cap even for compressible content', () => {
		expect(() =>
			store_result('a'.repeat(100 * 1024 * 1024 + 1)),
		).toThrow('logical limit');
		expect(fs.readdirSync(result_dir)).toEqual([]);
	});

	it.each(['cleanup', 'read'])(
		'expires compressed results through %s',
		(mode) => {
			process.env.RETRIEVER_RESULT_MAX_BYTES = '100';
			const stored = store_result('a'.repeat(10000));
			const path = join(result_dir, `${stored.result_id}.omr`);
			expect(statSync(path).mode & 0o777).toBe(0o600);
			read_result_chunk(stored.result_id);
			const old = new Date(Date.now() - 90000000);
			utimesSync(path, old, old);
			if (mode === 'cleanup')
				expect(cleanup_expired_results()).toBe(1);
			expect(() => read_result_chunk(stored.result_id)).toThrow(
				'Result not found or expired',
			);
			expect(existsSync(path)).toBe(false);
		},
	);

	it('counts plain and compressed sizes together and evicts the oldest format', () => {
		process.env.RETRIEVER_RESULT_MAX_BYTES = '100';
		process.env.RETRIEVER_RESULT_STORE_MAX_BYTES = '180';
		const compressed = store_result('a'.repeat(10000));
		const compressed_path = join(
			result_dir,
			`${compressed.result_id}.omr`,
		);
		read_result_chunk(compressed.result_id);
		const old = new Date(Date.now() - 5000);
		utimesSync(compressed_path, old, old);
		const plain = store_result('b'.repeat(80));
		const plain_path = join(result_dir, `${plain.result_id}.txt`);
		expect(existsSync(compressed_path)).toBe(true);
		store_result('c'.repeat(30));
		expect(existsSync(compressed_path)).toBe(false);
		expect(() => read_result_chunk(compressed.result_id)).toThrow(
			'Result not found or expired',
		);
		expect(existsSync(plain_path)).toBe(true);
		utimesSync(plain_path, old, old);
		store_result('d'.repeat(10000));
		expect(existsSync(plain_path)).toBe(false);
		const size = fs
			.readdirSync(result_dir)
			.reduce(
				(sum, name) => sum + statSync(join(result_dir, name)).size,
				0,
			);
		expect(size).toBeLessThanOrEqual(180);
	});

	it('uses compression when the total quota is smaller than the per-result quota', () => {
		process.env.RETRIEVER_RESULT_STORE_MAX_BYTES = '100';
		const stored = store_result('a'.repeat(10000));
		expect(
			statSync(join(result_dir, `${stored.result_id}.omr`)).size,
		).toBeLessThanOrEqual(100);
		process.env.RETRIEVER_RESULT_STORE_MAX_BYTES = '10';
		expect(() => store_result('a'.repeat(10000))).toThrow(
			'total storage quota',
		);
		expect(read_result_chunk(stored.result_id).content).toBe(
			'a'.repeat(10000),
		);
	});

	it.each([
		'a'.repeat(25 * 1024 * 1024),
		'🙂 short line\n'.repeat(100000),
	])(
		'indexes legacy files once rather than rescanning on every page',
		(text) => {
			const id = randomUUID();
			fs.writeFileSync(join(result_dir, `${id}.txt`), text);
			const spy = vi.spyOn(fs, 'readSync');
			try {
				const first = read_result_chunk(id, 1, 500);
				spy.mockClear();
				const second = read_result_chunk(
					id,
					first.next_offset,
					500,
					first.next_byte_offset,
				);
				expect(second.content.length).toBeGreaterThan(0);
				const bytes = spy.mock.results.reduce(
					(sum, call) => sum + Number(call.value),
					0,
				);
				expect(bytes).toBeLessThan(150000);
			} finally {
				spy.mockRestore();
			}
		},
	);
	it('stores repeated logical content above the physical quota losslessly', () => {
		process.env.RETRIEVER_RESULT_MAX_BYTES = '10000';
		const text = '🙂 repeated content\n'.repeat(10000);
		const stored = store_result(text);
		const path = join(result_dir, `${stored.result_id}.omr`);
		expect(statSync(path).size).toBeLessThanOrEqual(10000);
		let offset = 1;
		let byte_offset = 0;
		let reconstructed = '';
		for (;;) {
			const chunk = read_result_chunk(
				stored.result_id,
				offset,
				500,
				byte_offset,
			);
			reconstructed += chunk.content;
			if (chunk.next_offset === undefined) break;
			if (chunk.next_byte_offset === undefined) reconstructed += '\n';
			offset = chunk.next_offset;
			byte_offset = chunk.next_byte_offset ?? 0;
		}
		expect(reconstructed).toBe(text);
	});
	it('stores private files and reads them by opaque ID with pagination', () => {
		const stored = store_result('line one\nline two\nline three');
		const path = join(result_dir, `${stored.result_id}.txt`);

		expect(existsSync(path)).toBe(true);
		expect(statSync(result_dir).mode & 0o777).toBe(0o700);
		expect(statSync(path).mode & 0o777).toBe(0o600);

		const first = read_result_chunk(stored.result_id, 1, 2);
		expect(first.content).toBe('line one\nline two');
		expect(first.total_lines).toBe(3);
		expect(first.next_offset).toBe(3);

		const second = read_result_chunk(stored.result_id, 3, 2);
		expect(second.content).toBe('line three');
		expect(second.next_offset).toBeUndefined();
	});

	it.each([
		'🙂é漢'.repeat(20000),
		`first\n${'🙂'.repeat(10000)}\n\nlast\n`,
		`${'a'.repeat(11999)}\n${'b'.repeat(24001)}`,
	])(
		'reconstructs byte-bounded pages without skipping UTF-8 data',
		(text) => {
			const stored = store_result(text);
			let offset = 1;
			let byte_offset = 0;
			let reconstructed = '';
			const visited = new Set<string>();
			for (let page = 0; page < 100; page++) {
				const cursor = `${offset}:${byte_offset}`;
				expect(visited.has(cursor)).toBe(false);
				visited.add(cursor);
				const chunk = read_result_chunk(
					stored.result_id,
					offset,
					2,
					byte_offset,
				);
				expect(Buffer.byteLength(chunk.content)).toBeLessThanOrEqual(
					12000,
				);
				expect(chunk.content).not.toContain('\uFFFD');
				reconstructed += chunk.content;
				if (chunk.next_offset === undefined) break;
				// Legacy line pages omit their separating LF. Byte continuations do not.
				if (chunk.next_byte_offset === undefined)
					reconstructed += '\n';
				offset = chunk.next_offset;
				byte_offset = chunk.next_byte_offset ?? 0;
			}
			expect(reconstructed).toBe(text);
		},
	);

	it('rejects malformed IDs and invalid pagination bounds', () => {
		expect(() => read_result_chunk('../secret', 1, 10)).toThrow(
			'Invalid result ID',
		);
		const stored = store_result('content');
		expect(() => read_result_chunk(stored.result_id, 0, 10)).toThrow(
			'Offset must be a positive integer',
		);
		expect(() => read_result_chunk(stored.result_id, 1, 501)).toThrow(
			'Limit must be an integer between 1 and 500',
		);
	});

	it('removes expired files and refuses to return expired content', () => {
		process.env.RETRIEVER_RESULT_TTL_MS = '1000';
		const stored = store_result('expired');
		const path = join(result_dir, `${stored.result_id}.txt`);
		const old = new Date(Date.now() - 5000);
		utimesSync(path, old, old);

		expect(cleanup_expired_results()).toBe(1);
		expect(existsSync(path)).toBe(false);
		expect(() => read_result_chunk(stored.result_id, 1, 10)).toThrow(
			'Result not found or expired',
		);
	});

	it('enforces a per-result size cap', () => {
		process.env.RETRIEVER_RESULT_MAX_BYTES = '10';
		expect(() => store_result('12345678901')).toThrow(
			'Result exceeds the configured 10-byte storage limit',
		);
	});

	it('evicts the oldest result before exceeding the total store quota', () => {
		process.env.RETRIEVER_RESULT_MAX_BYTES = '20';
		process.env.RETRIEVER_RESULT_STORE_MAX_BYTES = '20';
		const first = store_result('123456789012');
		const first_path = join(result_dir, `${first.result_id}.txt`);
		const old = new Date(Date.now() - 5000);
		utimesSync(first_path, old, old);

		const second = store_result('abcdefghijkl');
		const second_path = join(result_dir, `${second.result_id}.txt`);

		expect(existsSync(first_path)).toBe(false);
		expect(existsSync(second_path)).toBe(true);
	});

	it('repairs overly broad directory permissions before storing data', () => {
		chmodSync(result_dir, 0o755);
		store_result('private');
		expect(statSync(result_dir).mode & 0o777).toBe(0o700);
	});
});
