import { createServer, request, type Server } from 'node:http';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { describe, expect, it } from 'vitest';
import {
	create_guard_server,
	default_guard_config,
} from './http_guard.js';

const listen = async (server: Server) => {
	server.listen(0, '127.0.0.1');
	await once(server, 'listening');
	return (server.address() as AddressInfo).port;
};
const stop = async (server: Server) => {
	server.closeAllConnections();
	await new Promise<void>((resolve) => server.close(() => resolve()));
};
const send = (
	port: number,
	body = '{}',
	key = 'fixture-key',
	path = '/mcp',
) =>
	new Promise<{
		status: number;
		headers: Record<string, unknown>;
		body: string;
	}>((resolve, reject) => {
		const req = request(
			{
				host: '127.0.0.1',
				port,
				path,
				method: path === '/mcp' ? 'POST' : 'GET',
				headers: {
					host: 'fixture.test',
					'x-api-key': key,
					...(path === '/mcp'
						? { 'content-length': Buffer.byteLength(body) }
						: {}),
				},
			},
			(res) => {
				let result = '';
				res.on('data', (data) => (result += data));
				res.on('end', () =>
					resolve({
						status: res.statusCode!,
						headers: res.headers,
						body: result,
					}),
				);
			},
		);
		req.on('error', reject);
		req.end(path === '/mcp' ? body : undefined);
	});

describe('audited guard admission and headers', () => {
	it('keeps rejected traffic separate from authenticated and health budgets', async () => {
		const upstream = createServer((req, res) => {
			req.resume();
			res.end('ok');
		});
		const upstream_port = await listen(upstream);
		const guard = create_guard_server(
			default_guard_config({
				allowed_hosts: ['fixture.test'],
				api_key: 'fixture-key',
				upstream_port,
				rate_limit_requests: 2,
			}),
		);
		const port = await listen(guard);
		try {
			expect((await send(port, '{}', 'wrong')).status).toBe(401);
			expect((await send(port, '{}', 'wrong')).status).toBe(401);
			expect((await send(port, '{}', 'wrong')).status).toBe(429);
			expect((await send(port)).status).toBe(200);
			expect((await send(port, '', '', '/ping')).status).toBe(200);
		} finally {
			await stop(guard);
			await stop(upstream);
		}
	});
	it('allows authenticated cancellation while normal work is saturated', async () => {
		let started: () => void = () => {};
		const active = new Promise<void>(
			(resolve) => (started = resolve),
		);
		const upstream = createServer((req, res) => {
			let body = '';
			req.on('data', (data) => (body += data));
			req.on('end', () => {
				if (JSON.parse(body).method === 'notifications/cancelled')
					res.writeHead(202).end();
				else started();
			});
		});
		const upstream_port = await listen(upstream);
		const guard = create_guard_server(
			default_guard_config({
				allowed_hosts: ['fixture.test'],
				api_key: 'fixture-key',
				upstream_port,
				max_inflight_requests: 1,
			}),
		);
		const port = await listen(guard);
		const body = JSON.stringify({
			jsonrpc: '2.0',
			id: 1,
			method: 'tools/call',
			params: { name: 'slow' },
		});
		const busy = request({
			host: '127.0.0.1',
			port,
			method: 'POST',
			path: '/mcp',
			headers: {
				host: 'fixture.test',
				'x-api-key': 'fixture-key',
				'content-length': Buffer.byteLength(body),
			},
		});
		busy.on('error', () => {});
		busy.end(body);
		try {
			await active;
			expect((await send(port, body)).status).toBe(429);
			expect(
				(
					await send(
						port,
						JSON.stringify({
							jsonrpc: '2.0',
							method: 'notifications/cancelled',
							params: { requestId: 1 },
						}),
					)
				).status,
			).toBe(202);
			expect(
				(
					await send(
						port,
						JSON.stringify({
							jsonrpc: '2.0',
							method: 'notifications/cancelled',
							id: 2,
							params: { requestId: 1 },
						}),
					)
				).status,
			).toBe(429);
		} finally {
			busy.destroy();
			await stop(guard);
			await stop(upstream);
		}
	});
	it('adds an API-key challenge, strips proxy CORS, and forwards readiness', async () => {
		const upstream = createServer((req, res) => {
			req.resume();
			res.writeHead(req.url === '/ready' ? 503 : 200, {
				'access-control-allow-origin': '*',
				'access-control-allow-credentials': 'true',
			});
			res.end(req.url === '/ready' ? 'not ready' : 'ok');
		});
		const upstream_port = await listen(upstream);
		const guard = create_guard_server(
			default_guard_config({
				allowed_hosts: ['fixture.test'],
				api_key: 'fixture-key',
				upstream_port,
			}),
		);
		const port = await listen(guard);
		try {
			const unauthorized = await send(port, '{}', 'wrong');
			expect(unauthorized.status).toBe(401);
			expect(unauthorized.headers['www-authenticate']).toBe(
				'ApiKey realm="retriever"',
			);
			const response = await send(port);
			expect(
				response.headers['access-control-allow-origin'],
			).toBeUndefined();
			expect(
				response.headers['access-control-allow-credentials'],
			).toBeUndefined();
			expect((await send(port, '', '', '/ready')).status).toBe(503);
		} finally {
			await stop(guard);
			await stop(upstream);
		}
	});
});
