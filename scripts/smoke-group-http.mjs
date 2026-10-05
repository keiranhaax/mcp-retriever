import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const unusedPort = async () => {
	const server = createServer();
	await new Promise((resolve) =>
		server.listen(0, '127.0.0.1', resolve),
	);
	const port = server.address().port;
	await new Promise((resolve) => server.close(resolve));
	return port;
};
const home = await mkdtemp(join(tmpdir(), 'retriever-group-http-'));
const port = await unusedPort();
const upstream = await unusedPort();
assert.notEqual(port, upstream);
const env = {
	PATH: process.env.PATH,
	HOME: home,
	NODE_ENV: 'test',
	GUARD_LISTEN_HOST: '127.0.0.1',
	GUARD_LISTEN_PORT: String(port),
	GUARD_UPSTREAM_PORT: String(upstream),
	GUARD_ALLOWED_HOSTS: `127.0.0.1:${port}`,
	MCP_API_KEY: 'group-transport-fixture',
	RETRIEVER_TOOL_GROUPS: 'research',
	RETRIEVER_RESULT_DIR: join(home, 'results'),
	NODE_OPTIONS:
		'--import=data:text/javascript,globalThis.fetch=async()=>{console.error("GROUP_PROVIDER_ATTEMPT");throw%20new%20Error("GROUP_PROVIDER_BLOCKED")}',
};
for (const key of [
	'TAVILY_API_KEY',
	'BRAVE_API_KEY',
	'BRAVE_ANSWERS_API_KEY',
	'GITHUB_API_KEY',
	'EXA_API_KEY',
	'YOU_API_KEY',
	'LINKUP_API_KEY',
	'FIRECRAWL_API_KEY',
	'CONTEXT_DEV_API_KEY',
])
	env[key] = 'group-provider-fixture';
const child = spawn(process.execPath, ['dist/guard.js'], {
	env,
	stdio: ['ignore', 'ignore', 'pipe'],
});
let logs = '',
	sequence = 0;
child.stderr.on('data', (chunk) => {
	logs = (logs + chunk).slice(-8000);
});
const exit = new Promise((resolve) => {
	child.once('exit', resolve);
	child.once('error', resolve);
});
const meta = {
	'io.modelcontextprotocol/protocolVersion': '2026-07-28',
	'io.modelcontextprotocol/clientInfo': {
		name: 'group-http',
		version: '1',
	},
	'io.modelcontextprotocol/clientCapabilities': {},
};
const rpc = async (method, params, modern) => {
	const response = await fetch(`http://127.0.0.1:${port}/mcp`, {
		method: 'POST',
		headers: {
			'Content-Type': 'application/json',
			Accept: 'application/json, text/event-stream',
			'X-API-Key': env.MCP_API_KEY,
			'MCP-Protocol-Version': modern ? '2026-07-28' : '2025-11-25',
			...(modern
				? {
						'Mcp-Method': method,
						...(params.name ? { 'Mcp-Name': params.name } : {}),
					}
				: {}),
		},
		body: JSON.stringify({
			jsonrpc: '2.0',
			id: ++sequence,
			method,
			params: { ...params, ...(modern ? { _meta: meta } : {}) },
		}),
		signal: AbortSignal.timeout(5000),
	});
	assert.equal(response.status, 200);
	const text = await response.text();
	return response.headers
		.get('content-type')
		?.includes('text/event-stream')
		? text
				.split('\n')
				.filter((line) => line.startsWith('data:'))
				.map((line) => JSON.parse(line.slice(5)))
				.at(-1)
		: JSON.parse(text);
};
try {
	let ready = false;
	for (let n = 0; n < 60; n++) {
		if (child.exitCode !== null)
			throw new Error('Group guard exited');
		try {
			const r = await fetch(`http://127.0.0.1:${port}/ping`, {
				signal: AbortSignal.timeout(300),
			});
			ready = r.ok;
		} catch {
			/* Bounded temporary startup only. */
		}
		if (ready) break;
		await delay(100);
	}
	assert(ready);
	const initialized = await rpc(
		'initialize',
		{
			protocolVersion: '2025-11-25',
			capabilities: {},
			clientInfo: { name: 'group-http', version: '1' },
		},
		false,
	);
	assert.equal(initialized.result.protocolVersion, '2025-11-25');
	const observed = [];
	for (const modern of [false, true]) {
		const listing = await rpc('tools/list', {}, modern);
		const tools = listing.result.tools
			.map((tool) => tool.name)
			.sort();
		for (const name of [
			'web_search',
			'search_and_read',
			'result_read',
			'web_read',
		])
			assert(tools.includes(name));
		let denied = 0;
		for (const name of [
			'web_extract',
			'context_web_extract',
			'firecrawl_agent',
			'brave_media_search',
			'context_brand_intel',
			'web_crawl',
			'web_map',
		]) {
			assert(!tools.includes(name));
			const result = await rpc(
				'tools/call',
				{ name, arguments: {} },
				modern,
			);
			assert.equal(result.error?.code, -32602);
			denied++;
		}
		const allowed_error = await rpc(
			'tools/call',
			{
				name: 'search_and_read',
				arguments: {
					query: 'fixture',
					search_provider: 'tavily',
					extract_provider: 'tavily',
					search_limit: 1,
					max_sources: 2,
				},
			},
			modern,
		);
		assert.equal(
			allowed_error.result.structuredContent.error.kind,
			'bad_input',
		);
		observed.push({
			protocol: modern ? '2026-07-28' : '2025-11-25',
			tools,
			denied_calls: denied,
		});
	}
	assert(!logs.includes('GROUP_PROVIDER_ATTEMPT'));
	console.log(
		JSON.stringify(
			{
				passed: true,
				group: 'research',
				protocols: observed,
				provider_requests: 0,
			},
			null,
			2,
		),
	);
} finally {
	child.kill('SIGTERM');
	const timer = setTimeout(() => child.kill('SIGKILL'), 2000);
	await exit;
	clearTimeout(timer);
	await rm(home, { recursive: true, force: true });
}
