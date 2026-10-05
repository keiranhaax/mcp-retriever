import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';

// Cold-process group enforcement with synthetic keys and blocked provider
// networking. Never inherit production configuration or result storage.
const names = {
	research: [
		'ai_search',
		'brave_llm_context',
		'brave_news_search',
		'github_search',
		'search_and_read',
		'web_read',
		'web_search',
		'web_search_fused',
	],
	media: ['brave_media_search'],
	business: [
		'context_brand_intel',
		'context_classify',
		'context_styleguide',
		'context_transaction_identify',
	],
	automation: ['firecrawl_agent', 'web_crawl', 'web_map'],
};
const all = [
	...Object.values(names).flat(),
	'web_extract',
	'context_web_extract',
	'result_read',
].sort();
const keys = [
	'TAVILY_API_KEY',
	'BRAVE_API_KEY',
	'BRAVE_ANSWERS_API_KEY',
	'GITHUB_API_KEY',
	'EXA_API_KEY',
	'YOU_API_KEY',
	'LINKUP_API_KEY',
	'FIRECRAWL_API_KEY',
	'CONTEXT_DEV_API_KEY',
];
const deny = `import net from 'node:net'; import {syncBuiltinESMExports} from 'node:module'; net.Socket.prototype.connect=()=>{throw new Error('GROUP_SOCKET_BLOCKED')}; syncBuiltinESMExports(); globalThis.fetch=async()=>{process.stderr.write('GROUP_NETWORK_ATTEMPT\\n');throw new Error('GROUP_NETWORK_BLOCKED')};`;
const results = [];
for (const groups of [
	undefined,
	'all',
	'',
	'PRIVATE_INVALID_GROUP',
	'none',
	'research',
	'media',
	'business',
	'automation',
	'research,automation',
]) {
	const home = await mkdtemp(
		join(tmpdir(), 'retriever-groups-smoke-'),
	);
	const child = spawn(process.execPath, ['dist/index.js'], {
		env: {
			PATH: process.env.PATH,
			HOME: home,
			NODE_ENV: 'test',
			RETRIEVER_RESULT_DIR: join(home, 'results'),
			NODE_OPTIONS: `--import=data:text/javascript,${encodeURIComponent(deny)}`,
			...Object.fromEntries(
				keys.map((key) => [key, 'group-offline-fixture']),
			),
			...(groups === undefined
				? {}
				: { RETRIEVER_TOOL_GROUPS: groups }),
		},
		stdio: ['pipe', 'pipe', 'pipe'],
	});
	let logs = '',
		sequence = 0;
	child.stderr.on('data', (chunk) => {
		logs = (logs + chunk).slice(-5000);
	});
	const exit = new Promise((resolve) => {
		child.once('exit', (code, signal) => resolve({ code, signal }));
		child.once('error', resolve);
	});
	const waiting = new Map();
	const lines = createInterface({ input: child.stdout });
	lines.on('line', (line) => {
		try {
			const message = JSON.parse(line);
			waiting.get(message.id)?.(message);
		} catch {
			for (const done of waiting.values())
				done({ error: { message: 'Invalid protocol output' } });
		}
	});
	const rpc = (method, params = {}) =>
		new Promise((resolve, reject) => {
			const id = ++sequence;
			const timer = setTimeout(() => {
				waiting.delete(id);
				reject(new Error('Group RPC timed out'));
			}, 5000);
			waiting.set(id, (message) => {
				clearTimeout(timer);
				waiting.delete(id);
				resolve(message);
			});
			child.stdin.write(
				JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n',
			);
		});
	try {
		if (groups === '' || groups === 'PRIVATE_INVALID_GROUP') {
			const watchdog = setTimeout(() => child.kill('SIGKILL'), 5000);
			const stopped = await exit;
			clearTimeout(watchdog);
			assert.equal(stopped.code, 1);
			assert(logs.includes('Invalid RETRIEVER_TOOL_GROUPS'));
			assert(!logs.includes('PRIVATE_INVALID_GROUP'));
			assert(!logs.includes('GROUP_NETWORK_ATTEMPT'));
			results.push({
				groups: groups === '' ? 'empty' : 'invalid',
				rejected_startup: true,
				provider_requests: 0,
			});
			continue;
		}
		const initialized = await rpc('initialize', {
			protocolVersion: '2025-11-25',
			capabilities: {},
			clientInfo: { name: 'groups-offline', version: '1' },
		});
		assert.equal(initialized.result.protocolVersion, '2025-06-18');
		const listing = await rpc('tools/list');
		const actual = listing.result.tools
			.map((tool) => tool.name)
			.sort();
		const expected =
			groups === undefined || groups === 'all'
				? all
				: groups === 'none'
					? ['result_read']
					: [
							...groups.split(',').flatMap((group) => names[group]),
							'result_read',
						].sort((left, right) => left.localeCompare(right));
		assert.deepEqual(actual, expected);
		let denied = 0;
		for (const name of all.filter((name) => !actual.includes(name))) {
			const response = await rpc('tools/call', {
				name,
				arguments: {},
			});
			assert.equal(response.error?.code, -32602);
			denied++;
		}
		assert(!logs.includes('GROUP_NETWORK_ATTEMPT'));
		results.push({
			groups: groups ?? 'unset',
			tools: actual.length,
			denied_calls: denied,
			provider_requests: 0,
		});
	} finally {
		lines.close();
		child.stdin.end();
		child.kill('SIGTERM');
		const timer = setTimeout(() => child.kill('SIGKILL'), 2000);
		await exit;
		clearTimeout(timer);
		await rm(home, { recursive: true, force: true });
	}
}
console.log(
	JSON.stringify({ passed: true, profiles: results }, null, 2),
);
