import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { describe, expect, it } from 'vitest';

const source = `
import { McpServer } from 'tmcp';
import { StdioTransport } from '@tmcp/transport-stdio';
const server = new McpServer({name:'stdio-audit',version:'1'}, {capabilities:{tools:{}}});
let started = 0;
const waiting = [];
process.on('message', message => {
  if (message === 'release') waiting.splice(0).forEach(resolve => resolve());
});
server.tool({name:'blocked',description:'Offline backend'}, async () => {
  const index = ++started;
  process.stderr.write('started:' + index + '\\n');
  server.ctx.signal?.addEventListener('abort', () => process.stderr.write('aborted:' + index + '\\n'), {once:true});
  await new Promise(resolve => waiting.push(resolve));
  process.stderr.write('settled:' + index + '\\n');
  return {content:[{type:'text',text:'done'}]};
});
server.tool({name:'large',description:'Offline output'}, () => ({content:[{type:'text',text:'x'.repeat(8192)}]}));
server.tool({name:'flood',description:'Offline progress'}, () => {
  for (let index = 0; index < Number(process.env.FIXTURE_OUTPUT_COUNT || 512); index++) server.progress(index,512,'x'.repeat(8192));
  return {content:[]};
});
new StdioTransport(server).listen();
process.stderr.write('ready\\n');
`;

type Response = {
	id: number;
	result?: unknown;
	error?: { code: number };
};
const line = (message: unknown) => `${JSON.stringify(message)}\n`;
const call = (id: number, name = 'blocked') => ({
	jsonrpc: '2.0',
	id,
	method: 'tools/call',
	params: { name },
});
const ping = (id: number) => ({ jsonrpc: '2.0', id, method: 'ping' });

const start = async (env: Record<string, string> = {}) => {
	const child = spawn(
		process.execPath,
		['--input-type=module', '-e', source],
		{
			cwd: process.cwd(),
			env: { ...process.env, RETRIEVER_MAX_INFLIGHT: '2', ...env },
			stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
		},
	);
	// The fixture requires pipe stdio plus IPC; validate once before narrowing.
	assert(child.stdin && child.stdout && child.stderr);
	const { stdin, stdout } = child;
	const responses: Response[] = [];
	let pending = '';
	let stderr = '';
	child.stdin.on('error', () => {});
	child.stdout.setEncoding('utf8');
	child.stderr.setEncoding('utf8');
	child.stdout.on('data', (chunk: string) => {
		pending += chunk;
		const lines = pending.split('\n');
		pending = lines.pop() ?? '';
		for (const text of lines) responses.push(JSON.parse(text));
	});
	child.stderr.on('data', (chunk: string) => {
		stderr += chunk;
	});
	const close = async () => {
		if (child.exitCode === null && child.signalCode === null) {
			const exited = once(child, 'exit');
			child.kill('SIGKILL');
			await exited;
		}
	};
	try {
		await expect
			.poll(() => stderr, { timeout: 3000 })
			.toContain('ready');
	} catch (error) {
		await close();
		throw error;
	}
	return {
		child,
		stdin,
		stdout,
		responses,
		close,
		stderr: () => stderr,
	};
};

describe('direct stdio resource admission', () => {
	it('holds cancelled backend capacity until real settlement, not abort', async () => {
		const fixture = await start();
		try {
			fixture.stdin.write(line(call(1)) + line(call(2)));
			await expect.poll(fixture.stderr).toContain('started:2');
			fixture.stdin.write(
				line(call(3)) +
					line({
						jsonrpc: '2.0',
						method: 'notifications/cancelled',
						params: { requestId: 1 },
					}) +
					line(call(4)) +
					line(ping(5)),
			);
			await expect
				.poll(() => fixture.responses.find(({ id }) => id === 5))
				.toMatchObject({ result: {} });
			expect(
				fixture.responses.find(({ id }) => id === 3),
			).toMatchObject({ error: { code: -32000 } });
			expect(
				fixture.responses.find(({ id }) => id === 4),
			).toMatchObject({ error: { code: -32000 } });
			expect(fixture.stderr()).toContain('aborted:1');
			expect(fixture.stderr()).not.toContain('started:3');
			fixture.child.send('release');
			await expect
				.poll(() => fixture.responses.find(({ id }) => id === 2))
				.toMatchObject({ result: {} });
			fixture.stdin.write(line(call(6)));
			await expect.poll(fixture.stderr).toContain('started:3');
			expect(fixture.responses.some(({ id }) => id === 1)).toBe(
				false,
			);
		} finally {
			await fixture.close();
		}
	});

	it('does not bypass work admission using tool notifications', async () => {
		const fixture = await start();
		try {
			fixture.stdin.write(line(call(1)) + line(call(2)));
			await expect.poll(fixture.stderr).toContain('started:2');
			fixture.stdin.write(
				line({
					jsonrpc: '2.0',
					method: 'tools/call',
					params: { name: 'blocked' },
				}) + line(ping(3)),
			);
			await expect.poll(() => fixture.responses.length).toBe(1);
			expect(fixture.responses[0]).toMatchObject({
				id: 3,
				result: {},
			});
			expect(fixture.stderr()).not.toContain('started:3');
		} finally {
			await fixture.close();
		}
	});

	describe('bounded output', () => {
		it('does not multiply output listeners on repeated initialization', async () => {
			const fixture = await start({ FIXTURE_OUTPUT_COUNT: '1' });
			try {
				for (let id = 0; id < 3; id++)
					fixture.stdin.write(
						line({
							jsonrpc: '2.0',
							id,
							method: 'initialize',
							params: {
								protocolVersion: '2025-11-25',
								capabilities: {},
								clientInfo: { name: 'fixture', version: '1' },
							},
						}),
					);
				await expect.poll(() => fixture.responses.length).toBe(3);
				fixture.stdin.write(
					line({
						...call(9, 'flood'),
						params: {
							name: 'flood',
							_meta: { progressToken: 'fixture-progress' },
						},
					}),
				);
				await expect
					.poll(() => fixture.responses.some(({ id }) => id === 9))
					.toBe(true);
				expect(
					fixture.responses.filter(({ id }) => id === undefined),
				).toHaveLength(1);
			} finally {
				await fixture.close();
			}
		});

		it('fails closed instead of queueing an oversized response', async () => {
			const fixture = await start({
				RETRIEVER_STDIO_MAX_OUTPUT_BYTES: '4096',
			});
			try {
				fixture.stdin.write(line(call(1, 'large')));
				await expect
					.poll(() => fixture.child.exitCode, { timeout: 1000 })
					.toBe(1);
				expect(fixture.responses).toEqual([]);
			} finally {
				await fixture.close();
			}
		});

		it('bounds queued notifications when stdout is stalled', async () => {
			const fixture = await start({
				RETRIEVER_STDIO_MAX_OUTPUT_BYTES: '32768',
			});
			try {
				fixture.stdin.write(
					line({
						jsonrpc: '2.0',
						id: 0,
						method: 'initialize',
						params: {
							protocolVersion: '2025-11-25',
							capabilities: {},
							clientInfo: { name: 'fixture', version: '1' },
						},
					}),
				);
				await expect.poll(() => fixture.responses.length).toBe(1);
				fixture.stdout.pause();
				fixture.stdin.write(
					line({
						...call(1, 'flood'),
						params: {
							name: 'flood',
							_meta: { progressToken: 'fixture-progress' },
						},
					}),
				);
				await expect
					.poll(() => fixture.child.exitCode, { timeout: 1000 })
					.toBe(1);
			} finally {
				await fixture.close();
			}
		});

		it('keeps cancellation dispatch live while bounded output awaits drain', async () => {
			const fixture = await start({
				RETRIEVER_STDIO_MAX_OUTPUT_BYTES: '1048576',
				FIXTURE_OUTPUT_COUNT: '48',
			});
			try {
				fixture.stdin.write(
					line({
						jsonrpc: '2.0',
						id: 0,
						method: 'initialize',
						params: {
							protocolVersion: '2025-11-25',
							capabilities: {},
							clientInfo: { name: 'fixture', version: '1' },
						},
					}),
				);
				await expect.poll(() => fixture.responses.length).toBe(1);
				fixture.stdout.pause();
				fixture.stdin.write(
					line(call(1)) +
						line({
							...call(2, 'flood'),
							params: {
								name: 'flood',
								_meta: { progressToken: 'fixture-progress' },
							},
						}) +
						line({
							jsonrpc: '2.0',
							method: 'notifications/cancelled',
							params: { requestId: 1 },
						}),
				);
				await expect.poll(fixture.stderr).toContain('aborted:1');
				expect(fixture.child.exitCode).toBe(null);
				fixture.stdout.resume();
				await expect
					.poll(() => fixture.responses.find(({ id }) => id === 2))
					.toMatchObject({ result: {} });
			} finally {
				await fixture.close();
			}
		});
	});

	describe('bounded framing', () => {
		it.each([false, true])(
			'closes on oversized frame (newline=%s)',
			async (newline) => {
				const fixture = await start({
					RETRIEVER_STDIO_MAX_FRAME_BYTES: '1024',
				});
				try {
					fixture.stdin.write(
						' '.repeat(1025) + (newline ? '\n' : ''),
					);
					await expect
						.poll(() => fixture.child.exitCode, { timeout: 1000 })
						.toBe(1);
				} finally {
					await fixture.close();
				}
			},
		);

		it('counts fragmented UTF-8 bytes, not JavaScript characters', async () => {
			const fixture = await start({
				RETRIEVER_STDIO_MAX_FRAME_BYTES: '1024',
			});
			try {
				fixture.stdin.write(Buffer.from('é'.repeat(300)));
				fixture.stdin.write(Buffer.from('é'.repeat(300)));
				await expect
					.poll(() => fixture.child.exitCode, { timeout: 1000 })
					.toBe(1);
			} finally {
				await fixture.close();
			}
		});

		it('accepts an exact-boundary frame split inside a UTF-8 code point', async () => {
			const fixture = await start({
				RETRIEVER_STDIO_MAX_FRAME_BYTES: '1024',
			});
			try {
				const text = JSON.stringify({
					...ping(7),
					params: { label: 'é' },
				});
				const bytes = Buffer.from(
					text + ' '.repeat(1024 - Buffer.byteLength(text)) + '\n',
				);
				const split = bytes.indexOf(Buffer.from('é')) + 1;
				fixture.stdin.write(bytes.subarray(0, split));
				fixture.stdin.write(bytes.subarray(split));
				await expect
					.poll(() => fixture.responses)
					.toEqual([{ jsonrpc: '2.0', id: 7, result: {} }]);
			} finally {
				await fixture.close();
			}
		});
	});
});
