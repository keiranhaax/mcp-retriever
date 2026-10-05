// Actual built stdio, synthetic upstream fetch, no socket networking.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline';

const root = fileURLToPath(new URL('../../../../', import.meta.url));
const home = await mkdtemp(join(tmpdir(), 'retriever-p2-built-'));
const job_id = '12345678-1234-4234-8234-123456789abc';
const request_id = 'p2-built-request';
const url = 'https://example.test/report?edition=2';
const canary = 'P2_PRIVATE_CONTROL_CANARY';
const evidence_line =
	'Needle evidence [7], `array[2]`, math [x+y], 漢字😀.\n';
const evidence = evidence_line.repeat(4000);
const mock = `
import net from 'node:net';
import {syncBuiltinESMExports} from 'node:module';
net.Socket.prototype.connect = () => { throw new Error('P2_SOCKET_BLOCKED'); };
syncBuiltinESMExports();
const evidence = ${JSON.stringify(evidence_line)}.repeat(4000);
globalThis.fetch = async (url, init) => {
 const key = (init?.method ?? 'GET') + ' ' + String(url);
 process.stderr.write('P2_FETCH ' + key + String.fromCharCode(10));
 let body;
 switch (key) {
  case 'GET https://api.tavily.com/research/${request_id}': body = {request_id: '${request_id}', status:'failed', content:evidence, error:'${canary}'}; break;
  case 'POST https://api.firecrawl.dev/v2/agent': body = {success:true, id:'${job_id}'}; break;
  case 'GET https://api.firecrawl.dev/v2/agent/${job_id}': body = {success:true,status:'failed',data:evidence,creditsUsed:0,error:'${canary}'}; break;
  case 'DELETE https://api.firecrawl.dev/v2/agent/${job_id}': body = {success:true}; break;
  case 'POST https://api.firecrawl.dev/v2/scrape': body = {success:true,data:{markdown:evidence,json:{token:'ordinary source field',api_key:'code example'},metadata:{title:'Fixture',sourceURL:'${url}',headers:{authorization:'${canary}'},requestConfig:{key:'${canary}'}},warning:'${canary}'}}; break;
  case 'POST https://api.exa.ai/search': body = {requestId:'exa-request',results:[{url:'${url}',title:'Fixture',text:evidence}],costDollars:{total:0,headers:{authorization:'${canary}'}}}; break;
  default: throw new Error('P2_UNEXPECTED_FETCH');
 }
 return new Response(JSON.stringify(body), {headers:{'content-type':'application/json'}});
};`;
const child = spawn(process.execPath, ['dist/index.js'], {
	cwd: root,
	env: {
		PATH: process.env.PATH,
		HOME: home,
		RETRIEVER_RESULT_DIR: join(home, 'results'),
		TAVILY_API_KEY: 'p2-offline-fixture-key',
		FIRECRAWL_API_KEY: 'p2-offline-fixture-key',
		EXA_API_KEY: 'p2-offline-fixture-key',
		NODE_OPTIONS: `--import=data:text/javascript,${encodeURIComponent(mock)}`,
	},
	stdio: ['pipe', 'pipe', 'pipe'],
});
let logs = '';
child.stderr.on('data', (chunk) => {
	logs = (logs + chunk).slice(-32000);
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
			reject(new Error(`P2 ${method} deadline`));
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
const call = async (name, args, failed = false) => {
	const response = await rpc('tools/call', { name, arguments: args });
	assert.equal(response.error, undefined);
	assert.equal(response.result.isError === true, failed);
	assert(!JSON.stringify(response).includes(canary));
	return response.result;
};
const parse = (response) => JSON.parse(response.content[0].text);
const reconstruct = async (result_id) => {
	let offset = 1,
		byte_offset = 0,
		output = '';
	for (let reads = 1; reads <= 200; reads++) {
		const chunk = parse(
			await call('result_read', {
				result_id,
				offset,
				byte_offset,
				limit: 500,
			}),
		);
		output += chunk.content;
		assert(!output.includes(canary));
		if (chunk.next_offset === undefined) {
			const marker = '\nFULL RESULT JSON\n';
			const index = output.lastIndexOf(marker);
			return {
				result: JSON.parse(
					index < 0 ? output : output.slice(index + marker.length),
				),
				reads,
			};
		}
		if (chunk.next_byte_offset === undefined) output += '\n';
		offset = chunk.next_offset;
		byte_offset = chunk.next_byte_offset ?? 0;
	}
	throw new Error('P2 reconstruction exceeded read bound');
};
try {
	const initialized = await rpc('initialize', {
		protocolVersion: '2025-11-25',
		capabilities: {},
		clientInfo: { name: 'p2-built-smoke', version: '1' },
	});
	assert.equal(initialized.result.protocolVersion, '2025-06-18');
	child.stdin.write(
		JSON.stringify({
			jsonrpc: '2.0',
			method: 'notifications/initialized',
		}) + '\n',
	);
	const observations = [];
	for (const [name, args] of [
		[
			'ai_search',
			{ provider: 'tavily_research', action: 'status', request_id },
		],
		['firecrawl_agent', { action: 'status', job_id }],
	]) {
		const response = await call(name, args, true);
		assert.equal(response._meta.retriever.job.state, 'failed');
		assert.equal(response._meta.retriever.job.partial, true);
		assert.equal(
			response._meta.retriever.local_completeness,
			'retained',
		);
		const recovered = await reconstruct(
			parse(response).result.result_id,
		);
		assert.equal(
			name === 'ai_search'
				? recovered.result[0].snippet
				: recovered.result.content,
			evidence,
		);
		observations.push({
			name,
			partial_failure: true,
			canonical_reads: recovered.reads,
			exact_reconstruction: true,
		});
	}
	const started = await call('firecrawl_agent', {
		prompt: 'offline fixture',
	});
	assert.equal(started._meta.retriever.job.id, job_id);
	const cancelled = await call('firecrawl_agent', {
		action: 'cancel',
		job_id,
	});
	assert.equal(
		cancelled._meta.retriever.job.cancellation,
		'confirmed',
	);
	for (const [name, args] of [
		['web_search', { provider: 'exa', query: 'Needle' }],
		[
			'web_extract',
			{ provider: 'firecrawl', url, mode: 'scrape', query: 'Needle' },
		],
	]) {
		const response = await call(name, {
			...args,
			response_mode: 'compact',
			output_budget_bytes: 2048,
		});
		const bytes = Buffer.byteLength(JSON.stringify(response));
		assert(bytes <= 2048);
		const compact = parse(response);
		if (name === 'web_search')
			assert.deepEqual(compact.metadata.usage, { usd: 0 });
		const recovered = await reconstruct(compact.result_id);
		const result = recovered.result.result;
		assert.equal(
			name === 'web_search'
				? result[0].snippet
				: result.raw_contents[0].content,
			evidence,
		);
		assert.equal(
			name === 'web_search'
				? result[0].url
				: result.raw_contents[0].url,
			url,
		);
		if (name === 'web_extract')
			assert.equal(
				result.metadata.documents[0].json.token,
				'ordinary source field',
			);
		observations.push({
			name,
			sanitized: true,
			bytes,
			canonical_reads: recovered.reads,
			exact_reconstruction: true,
		});
	}
	assert.equal((logs.match(/P2_FETCH /g) ?? []).length, 6);
	assert.equal(
		logs
			.split('\n')
			.filter((line) =>
				line.startsWith(
					'P2_FETCH POST https://api.firecrawl.dev/v2/agent',
				),
			).length,
		1,
	);
	assert(!logs.includes(canary));
	assert(!logs.includes('P2_UNEXPECTED_FETCH'));
	console.log(
		JSON.stringify({
			protocol: initialized.result.protocolVersion,
			observations,
			mock_provider_calls: 6,
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
