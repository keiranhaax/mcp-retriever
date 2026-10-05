import {
	mkdtempSync,
	rmSync,
	statSync,
	readFileSync,
	writeFileSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { handle_large_result } from '../../common/results.js';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { store_result } from '../../common/result_store.js';
import { register_result_read } from './result_read.js';

interface RegisteredTool {
	definition: {
		name: string;
		annotations?: Record<string, boolean>;
	};
	handler: (args: Record<string, unknown>) => Promise<any>;
}

let result_dir: string;

beforeEach(() => {
	result_dir = mkdtempSync(join(tmpdir(), 'result-read-tool-test-'));
	process.env.RETRIEVER_RESULT_DIR = result_dir;
});

afterEach(() => {
	delete process.env.RETRIEVER_RESULT_DIR;
	rmSync(result_dir, { recursive: true, force: true });
});

const create_mock_server = () => {
	const tools: RegisteredTool[] = [];
	return {
		tools,
		server: {
			tool: (
				definition: RegisteredTool['definition'],
				handler: RegisteredTool['handler'],
			) => tools.push({ definition, handler }),
		},
	};
};

describe('result_read tool', () => {
	it('round-trips actual 9 MiB triplicate canonical content through compressed result_read pages', async () => {
		const { server, tools } = create_mock_server();
		register_result_read(server as any);
		const content = '0123456789abcdef'.repeat((9 * 1024 * 1024) / 16);
		const original = {
			content,
			raw_contents: [{ url: 'https://example.com', content }],
			raw_response: {
				data: {
					markdown: content,
					metadata: { marker: 'preserved' },
				},
			},
			citations: [{ url: 'https://example.org', title: 'citation' }],
		};
		const canonical = JSON.stringify(original, null, 2);
		expect(Buffer.byteLength(canonical)).toBeGreaterThan(
			25 * 1024 * 1024,
		);
		const stored = handle_large_result(original, 'fixture') as {
			result_id: string;
			total_lines: number;
		};
		expect(
			statSync(join(result_dir, `${stored.result_id}.omr`)).size,
		).toBeLessThan(25 * 1024 * 1024);
		const hash = createHash('sha256');
		let offset = 1;
		let byte_offset = 0;
		let complete = false;
		for (let page = 0; page < 3000; page++) {
			const response = await tools[0].handler({
				result_id: stored.result_id,
				offset,
				byte_offset,
				limit: 500,
			});
			expect(response.isError).not.toBe(true);
			expect(
				Buffer.byteLength(JSON.stringify(response)),
			).toBeLessThan(100000);
			const chunk = JSON.parse(response.content[0].text);
			expect(chunk.total_lines).toBe(stored.total_lines);
			hash.update(chunk.content);
			if (chunk.next_offset === undefined) {
				complete = true;
				break;
			}
			if (chunk.next_byte_offset === undefined) hash.update('\n');
			offset = chunk.next_offset;
			byte_offset = chunk.next_byte_offset ?? 0;
		}
		expect(complete).toBe(true);
		expect(hash.digest('hex')).toBe(
			createHash('sha256').update(canonical).digest('hex'),
		);
	});

	it('returns a sanitized MCP error for compressed corruption', async () => {
		const { server, tools } = create_mock_server();
		register_result_read(server as any);
		process.env.RETRIEVER_RESULT_MAX_BYTES = '100';
		try {
			const stored = store_result('a'.repeat(10000));
			const path = join(result_dir, `${stored.result_id}.omr`);
			const bytes = readFileSync(path);
			bytes[bytes.length - 8] ^= 1;
			writeFileSync(path, bytes);
			const response = await tools[0].handler({
				result_id: stored.result_id,
			});
			expect(response.isError).toBe(true);
			expect(response.content[0].text).toContain(
				'result_read error [INVALID_INPUT]',
			);
			expect(response.content[0].text).not.toContain(result_dir);
		} finally {
			delete process.env.RETRIEVER_RESULT_MAX_BYTES;
		}
	});
	it('registers as a local read-only tool and returns a requested chunk', async () => {
		const { server, tools } = create_mock_server();
		register_result_read(server as any);
		const tool = tools[0];
		const stored = store_result('first\nsecond\nthird');

		expect(tool.definition.name).toBe('result_read');
		expect(tool.definition.annotations).toMatchObject({
			readOnlyHint: true,
			destructiveHint: false,
			idempotentHint: true,
			openWorldHint: false,
		});

		const response = await tool.handler({
			result_id: stored.result_id,
			offset: 2,
			limit: 1,
		});
		const body = JSON.parse(response.content[0].text);
		expect(body.content).toBe('second');
		expect(body.next_offset).toBe(3);
	});

	it('forwards within-line continuation without oversized MCP text', async () => {
		const { server, tools } = create_mock_server();
		register_result_read(server as any);
		const text = '\u0000🙂'.repeat(10000);
		const stored = store_result(text);
		let offset = 1;
		let byte_offset = 0;
		let reconstructed = '';
		for (let page = 0; page < 20; page++) {
			const response = await tools[0].handler({
				result_id: stored.result_id,
				offset,
				byte_offset,
				limit: 1,
			});
			expect(
				Buffer.byteLength(JSON.stringify(response)),
			).toBeLessThan(100000);
			const chunk = JSON.parse(response.content[0].text);
			reconstructed += chunk.content;
			if (chunk.next_offset === undefined) break;
			offset = chunk.next_offset;
			byte_offset = chunk.next_byte_offset;
		}
		expect(reconstructed === text).toBe(true);
	});

	it('returns an MCP error for missing or expired IDs', async () => {
		const { server, tools } = create_mock_server();
		register_result_read(server as any);
		const response = await tools[0].handler({
			result_id: '123e4567-e89b-12d3-a456-426614174000',
		});

		expect(response.isError).toBe(true);
		expect(response.content[0].text).toContain(
			'Result not found or expired',
		);
	});
});
