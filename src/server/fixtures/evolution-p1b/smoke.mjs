// Built-server positive-path proof. Synthetic upstream fetch only; sockets
// blocked. No paid provider request, production state, or fixture refresh.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline';

const root = fileURLToPath(new URL('../../../../', import.meta.url));
const home = await mkdtemp(join(tmpdir(), 'retriever-p1b-built-'));
const url = 'https://example.test/report?edition=2';
const text =
	'# Introduction\n' +
	'Background 漢字😀.\n'.repeat(500) +
	'\n# Finding\nNeedle citation [7].\n' +
	'Appendix.\n'.repeat(500);
const upstream = {
	results: [{ url, raw_content: text }],
	failed_results: [],
	request_id: 'p1b-built-request',
	response_time: 0.25,
	usage: { credits: 0 },
};
const mock = `
import net from 'node:net';
import {syncBuiltinESMExports} from 'node:module';
net.Socket.prototype.connect = () => { throw new Error('P1B_SOCKET_BLOCKED'); };
syncBuiltinESMExports();
globalThis.fetch = async (url, init) => {
 if (String(url) !== 'https://api.tavily.com/extract' || init?.method !== 'POST') throw new Error('P1B_UNEXPECTED_FETCH');
 const body = JSON.parse(init.body);
 if ('response_mode' in body || 'output_budget_bytes' in body || 'include_usage' in body) throw new Error('P1B_LOCAL_CONTROLS_LEAKED');
 process.stderr.write('P1B_MOCK_FETCH\\n');
 return new Response(${JSON.stringify(JSON.stringify(upstream))}, {headers:{'content-type':'application/json'}});
};`;
const child = spawn(process.execPath, ['dist/index.js'], {
	cwd: root,
	env: {
		PATH: process.env.PATH,
		HOME: home,
		RETRIEVER_RESULT_DIR: join(home, 'results'),
		TAVILY_API_KEY: 'p1b-offline-fixture-key',
		NODE_OPTIONS: `--import=data:text/javascript,${encodeURIComponent(mock)}`,
	},
	stdio: ['pipe', 'pipe', 'pipe'],
});
let logs = '';
child.stderr.on('data', (chunk) => {
	logs = (logs + chunk).slice(-16000);
});
const exit = new Promise((resolve) => {
	child.once('exit', resolve);
	child.once('error', resolve);
});
const pending = new Map();
let id = 0;
const lines = createInterface({ input: child.stdout });
lines.on('line', (line) => {
	const message = JSON.parse(line);
	pending.get(message.id)?.(message);
});
const rpc = (method, params) =>
	new Promise((resolve, reject) => {
		const sequence = ++id;
		const timer = setTimeout(() => {
			pending.delete(sequence);
			reject(new Error(`P1B ${method} deadline`));
		}, 5000);
		pending.set(sequence, (response) => {
			clearTimeout(timer);
			pending.delete(sequence);
			resolve(response);
		});
		child.stdin.write(
			JSON.stringify({
				jsonrpc: '2.0',
				id: sequence,
				method,
				params,
			}) + '\n',
		);
	});
const call = async (name, args) => {
	const response = await rpc('tools/call', { name, arguments: args });
	assert.equal(response.error, undefined);
	assert.notEqual(response.result.isError, true);
	return response.result;
};
const parse = (response) => JSON.parse(response.content[0].text);
const reconstruct = async (result_id) => {
	let offset = 1,
		byte_offset = 0,
		output = '';
	for (let reads = 1; reads <= 100; reads++) {
		const chunk = parse(
			await call('result_read', {
				result_id,
				offset,
				byte_offset,
				limit: 500,
			}),
		);
		output += chunk.content;
		if (chunk.next_offset === undefined)
			return { result: JSON.parse(output), reads };
		if (chunk.next_byte_offset === undefined) output += '\n';
		offset = chunk.next_offset;
		byte_offset = chunk.next_byte_offset ?? 0;
	}
	throw new Error('P1B reconstruction exceeded read cap');
};
try {
	const initialized = await rpc('initialize', {
		protocolVersion: '2025-11-25',
		capabilities: {},
		clientInfo: { name: 'p1b-built-smoke', version: '1' },
	});
	assert.equal(initialized.result.protocolVersion, '2025-06-18');
	child.stdin.write(
		JSON.stringify({
			jsonrpc: '2.0',
			method: 'notifications/initialized',
		}) + '\n',
	);
	const observations = [];
	for (const response_mode of ['compact', 'full']) {
		// Include structured content in the measured wire budget. The
		// selection case needs room for both copies; full stays at minimum.
		const output_budget_bytes =
			response_mode === 'compact' ? 4096 : 2048;
		const response = await call('web_extract', {
			provider: 'tavily',
			url,
			query: 'Needle',
			response_mode,
			output_budget_bytes,
		});
		const bytes = Buffer.byteLength(JSON.stringify(response));
		assert(bytes <= output_budget_bytes);
		const value = parse(response);
		assert.deepEqual(response.structuredContent, {
			ok: true,
			data: value,
		});
		assert.equal(value.metadata.request_id, 'p1b-built-request');
		assert.deepEqual(value.metadata.usage, { credits: 0 });
		if (response_mode === 'compact')
			assert(
				value.sources.some((source) =>
					source.passages.some((passage) =>
						passage.text.includes('Needle citation [7].'),
					),
				),
			);
		const recovered = await reconstruct(value.result_id);
		assert.equal(
			recovered.result.result.raw_contents[0].content,
			text,
		);
		assert.equal(recovered.result.result.raw_contents[0].url, url);
		assert.equal(recovered.result.result.content, undefined);
		assert.equal(
			recovered.result.metadata.local_completeness,
			'complete',
		);
		observations.push({
			response_mode,
			output_budget_bytes,
			bytes,
			canonical_reads: recovered.reads,
			exact_reconstruction: true,
		});
	}
	const invalid = await rpc('tools/call', {
		name: 'web_extract',
		arguments: { provider: 'tavily', url, output_budget_bytes: 2048 },
	});
	assert(invalid.error || invalid.result?.isError);
	assert.equal((logs.match(/P1B_MOCK_FETCH/g) ?? []).length, 2);
	assert(!logs.includes('P1B_UNEXPECTED_FETCH'));
	console.log(
		JSON.stringify({
			protocol: initialized.result.protocolVersion,
			observations,
			invalid_before_network: true,
			mock_provider_calls: 2,
			real_provider_calls: 0,
		}),
	);
} finally {
	lines.close();
	child.stdin.end();
	child.kill('SIGTERM');
	let timer;
	await Promise.race([
		exit,
		new Promise((resolve) => {
			timer = setTimeout(resolve, 2000);
		}),
	]);
	clearTimeout(timer);
	if (child.exitCode === null && child.signalCode === null) {
		child.kill('SIGKILL');
		await exit;
	}
	await rm(home, { recursive: true, force: true });
}
