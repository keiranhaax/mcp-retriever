import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import {
	startHTTPServer,
	proxyServer,
	getUpstreamBridge,
	acquireListenSubscriptions,
} from 'mcp-proxy';
import { describe, expect, it } from 'vitest';

// Resolve the proxy's own SDK, including under pnpm strict dependency isolation.
const require_proxy = createRequire(import.meta.resolve('mcp-proxy'));
const { Server } = await import(
	require_proxy.resolve('@modelcontextprotocol/server')
);
const { Client } = await import(
	require_proxy.resolve('@modelcontextprotocol/client')
);
const { StdioClientTransport } = await import(
	require_proxy.resolve('@modelcontextprotocol/client/stdio')
);
const fixture_code = `
import { McpServer } from 'tmcp';
import { StdioTransport } from '@tmcp/transport-stdio';
const server = new McpServer({name:'fixture',version:'1'}, {capabilities:{tools:{listChanged:true},resources:{listChanged:true}}});
server.tool({name:'blocked',description:'Local test'}, async () => {
  process.stderr.write('started\\n');
  const signal = server.ctx.signal;
  await new Promise(resolve => {
    const timer = setTimeout(resolve, 600);
    signal?.addEventListener('abort', () => {clearTimeout(timer); process.stderr.write('aborted\\n'); resolve();}, {once:true});
  });
  return {content:[{type:'text',text:'done'}]};
});
new StdioTransport(server).listen();
`;

const free_port = async () => {
	const probe = createServer();
	await new Promise<void>((resolve) =>
		probe.listen(0, '127.0.0.1', resolve),
	);
	const port = (probe.address() as AddressInfo).port;
	await new Promise<void>((resolve) => probe.close(() => resolve()));
	return port;
};

const start_fixture = async (max_inflight = 16) => {
	const transport = new StdioClientTransport({
		command: process.execPath,
		args: ['--input-type=module', '-e', fixture_code],
		stderr: 'pipe',
		env: {
			PATH: process.env.PATH ?? '',
			RETRIEVER_MAX_INFLIGHT: String(max_inflight),
		},
	});
	let stderr = '';
	transport.stderr?.on('data', (data: Buffer) => {
		stderr += data;
	});
	const client = new Client(
		{ name: 'proxy-fixture', version: '1' },
		{ capabilities: {} },
	);
	await client.connect(transport);
	const port = await free_port();
	const counts = { created: 0, closed: 0 };
	const bridge = getUpstreamBridge({ client });
	const server = await startHTTPServer({
		host: '127.0.0.1',
		port,
		stateless: true,
		eventStore: false,
		sseEndpoint: null,
		apiKey: 'proxy-test-key',
		createServer: async () => {
			const instance = new Server(
				{ name: 'fixture', version: '1' },
				{ capabilities: client.getServerCapabilities() },
			);
			await proxyServer({
				server: instance,
				client,
				serverCapabilities: client.getServerCapabilities(),
				requestTimeout: 2000,
			});
			counts.created++;
			return instance;
		},
		onClose: async () => {
			counts.closed++;
		},
		onListenSubscriptions: (uris) =>
			acquireListenSubscriptions({ client, uris }),
	});
	const send = (
		body: unknown,
		headers: Record<string, string> = {},
		signal?: AbortSignal,
	) =>
		fetch(`http://127.0.0.1:${port}/mcp`, {
			method: 'POST',
			signal,
			headers: {
				'x-api-key': 'proxy-test-key',
				'content-type': 'application/json',
				accept: 'application/json, text/event-stream',
				'mcp-protocol-version': '2025-11-25',
				...headers,
			},
			body: JSON.stringify(body),
		});
	return {
		send,
		counts,
		stderr: () => stderr,
		close: async () => {
			await server.close();
			await bridge.close();
			await client.close();
		},
	};
};
const message = (
	id: string | number,
	method = 'tools/list',
	params = {},
) => ({ jsonrpc: '2.0', id, method, params });

const modern = (
	id: number,
	method: string,
	params: Record<string, unknown> = {},
) =>
	message(id, method, {
		...params,
		_meta: {
			'io.modelcontextprotocol/protocolVersion': '2026-07-28',
			'io.modelcontextprotocol/clientInfo': {
				name: 'proxy-test',
				version: '1',
			},
			'io.modelcontextprotocol/clientCapabilities': {},
		},
	});

describe('installed stateless proxy lifecycle', () => {
	it('retains backend admission after a legacy HTTP disconnect', async () => {
		const fixture = await start_fixture(1);
		const controller = new AbortController();
		try {
			const first = fixture
				.send(
					message(101, 'tools/call', { name: 'blocked' }),
					{},
					controller.signal,
				)
				.then((response) => response.text())
				.catch(() => undefined);
			await expect.poll(fixture.stderr).toContain('started');
			controller.abort();
			await first;
			const second = await fixture.send(
				message(102, 'tools/call', { name: 'blocked' }),
			);
			const raw = await second.text();
			expect(raw).toContain('"code":-32000');
			expect(raw).toContain('Server busy');
			expect(fixture.stderr().split('started').length - 1).toBe(1);
			expect(fixture.stderr()).not.toContain('aborted');
			await expect.poll(() => fixture.counts.closed).toBe(2);
			const next = await fixture.send(
				message(103, 'tools/call', { name: 'blocked' }),
			);
			expect(await next.text()).toContain('done');
		} finally {
			controller.abort();
			await fixture.close();
		}
	});
	it('validates modern subscription headers before contacting upstream', async () => {
		const fixture = await start_fixture();
		try {
			const response = await fixture.send(
				modern(1, 'subscriptions/listen', {
					notifications: {
						resourceSubscriptions: ['fixture://test'],
					},
				}),
				{ 'mcp-protocol-version': '2026-07-28' },
			);
			expect(response.status).toBe(400);
			expect(await response.text()).toContain('Mcp-Method');
		} finally {
			await fixture.close();
		}
	});

	it('ignores ambiguous legacy cancellation when clients reuse an active id', async () => {
		const fixture = await start_fixture();
		try {
			const first = fixture.send(
				message(7, 'tools/call', { name: 'blocked' }),
			);
			const second = fixture.send(
				message(7, 'tools/call', { name: 'blocked' }),
			);
			await expect
				.poll(() => fixture.stderr().split('started').length)
				.toBe(3);
			expect(
				(
					await fixture.send({
						jsonrpc: '2.0',
						method: 'notifications/cancelled',
						params: { requestId: 7 },
					})
				).status,
			).toBe(202);
			await Promise.all(
				[first, second].map(async (response) =>
					(await response).text(),
				),
			);
			expect(fixture.stderr()).not.toContain('aborted');
		} finally {
			await fixture.close();
		}
	});
	it('does not treat a legacy HTTP disconnect as explicit cancellation', async () => {
		const fixture = await start_fixture();
		const controller = new AbortController();
		try {
			const pending = fixture
				.send(
					message(8, 'tools/call', { name: 'blocked' }),
					{},
					controller.signal,
				)
				.catch(() => undefined);
			await expect.poll(() => fixture.stderr()).toContain('started');
			controller.abort();
			await pending;
			await new Promise((resolve) => setTimeout(resolve, 100));
			expect(fixture.stderr()).not.toContain('aborted');
			await expect.poll(() => fixture.counts.closed).toBe(1);
		} finally {
			await fixture.close();
		}
	});

	it('routes explicit legacy cancellation to the original in-flight request', async () => {
		const fixture = await start_fixture();
		try {
			const pending = fixture.send(
				message('cancel-me', 'tools/call', { name: 'blocked' }),
			);
			await expect.poll(() => fixture.stderr()).toContain('started');
			const cancelled = await fixture.send({
				jsonrpc: '2.0',
				method: 'notifications/cancelled',
				params: { requestId: 'cancel-me' },
			});
			expect(cancelled.status).toBe(202);
			await expect
				.poll(() => fixture.stderr(), { timeout: 300 })
				.toContain('aborted');
			await (await pending).text();
			await expect
				.poll(() => fixture.counts.closed)
				.toBe(fixture.counts.created);
		} finally {
			await fixture.close();
		}
	});

	it('releases each completed legacy instance including initialization', async () => {
		const fixture = await start_fixture();
		try {
			for (let id = 0; id < 4; id++) {
				const response = await fixture.send(
					id === 0
						? message(id, 'initialize', {
								protocolVersion: '2025-11-25',
								capabilities: {},
								clientInfo: { name: 'legacy', version: '1' },
							})
						: message(id),
				);
				expect(response.status).toBe(200);
				await response.text();
			}
			await expect
				.poll(() => fixture.counts.closed, { timeout: 300 })
				.toBe(4);
			expect(fixture.counts.created).toBe(4);
		} finally {
			await fixture.close();
		}
	});
});
