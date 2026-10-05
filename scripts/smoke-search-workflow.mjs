import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

// Built-server behavior probe: every provider response is an offline
// fixture and any unexpected URL fails. No production environment copied.
const home = await mkdtemp(
	join(tmpdir(), 'retriever-workflow-smoke-'),
);
const preload = join(home, 'provider-fixture.mjs');
const text =
	'# Background\n' +
	'漢字😀 background.\n'.repeat(500) +
	'\n# Findings\nneedle citation [1].\n';
await writeFile(
	preload,
	`
const evidence = ${JSON.stringify(text)};
const url = 'https://example.test/report?edition=2';
let attempts = 0;
globalThis.fetch = async (target, options) => {
  if (++attempts > 8) throw new Error('FIXTURE_REQUEST_CAP');
  const path = String(target);
  if (path === 'https://api.tavily.com/search') {
    return Response.json({ results: [
      {title:'Fixture',url,content:'needle',score:0.9},
      {title:'Duplicate',url,content:'needle',score:0.8},
    ]});
  }
  if (path === 'https://api.tavily.com/extract') {
    const body = JSON.parse(options.body);
    if (body.urls.length !== 1 || body.urls[0] !== url) throw new Error('FIXTURE_BAD_URL');
    return Response.json({results:[{url,raw_content:evidence}],failed_results:[]});
  }
  if (path === 'https://api.firecrawl.dev/v2/map') {
    const body = JSON.parse(options.body);
    if (body.url !== url || body.limit !== 50) throw new Error('FIXTURE_BAD_MAP');
    return Response.json({success:true,links:[{url,title:'Mapped fixture'}]});
  }
  if (path === 'https://api.firecrawl.dev/v2/crawl') {
    const body = JSON.parse(options.body);
    if (body.url !== url || body.limit !== 20) throw new Error('FIXTURE_BAD_CRAWL');
    return Response.json({success:true,id:'focused-fixture-job'});
  }
  if (path === 'https://api.firecrawl.dev/v2/crawl/focused-fixture-job') {
    if (options.method !== 'GET') throw new Error('FIXTURE_BAD_POLL');
    return Response.json({status:'completed',total:1,completed:1,data:[{url,markdown:'Crawled fixture'}]});
  }
  throw new Error('FIXTURE_UNEXPECTED_NETWORK');
};
`,
);
const child = spawn(
	process.execPath,
	['--import', pathToFileURL(preload).href, 'dist/index.js'],
	{
		env: {
			PATH: process.env.PATH,
			HOME: home,
			NODE_ENV: 'test',
			RETRIEVER_RESULT_DIR: join(home, 'results'),
			TAVILY_API_KEY: 'workflow-offline-fixture',
			FIRECRAWL_API_KEY: 'focused-offline-fixture',
		},
		stdio: ['pipe', 'pipe', 'pipe'],
	},
);
const pending = new Map();
let buffer = '',
	logs = '',
	sequence = 0;
const exit = once(child, 'exit');
child.stderr.setEncoding('utf8');
child.stderr.on('data', (chunk) => {
	logs = (logs + chunk).slice(-3000);
});
child.stdout.setEncoding('utf8');
child.stdout.on('data', (chunk) => {
	buffer += chunk;
	for (;;) {
		const index = buffer.indexOf('\n');
		if (index < 0) break;
		const line = buffer.slice(0, index);
		buffer = buffer.slice(index + 1);
		try {
			const response = JSON.parse(line);
			const callback = pending.get(response.id);
			if (callback) {
				pending.delete(response.id);
				callback(response);
			}
		} catch {
			for (const callback of pending.values())
				callback({ error: { message: 'Non-protocol stdout' } });
			pending.clear();
		}
	}
});
const rpc = (method, params = {}) =>
	new Promise((resolve, reject) => {
		const id = ++sequence;
		const timer = setTimeout(() => {
			pending.delete(id);
			reject(new Error('Offline RPC deadline'));
		}, 15000);
		pending.set(id, (response) => {
			clearTimeout(timer);
			if (response.error) reject(new Error(response.error.message));
			else resolve(response.result);
		});
		child.stdin.write(
			JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n',
		);
	});
const call = (name, args) =>
	rpc('tools/call', { name, arguments: args });
try {
	const initialized = await rpc('initialize', {
		protocolVersion: '2025-11-25',
		capabilities: {},
		clientInfo: { name: 'offline-workflow-probe', version: '1' },
	});
	const listing = await rpc('tools/list');
	const workflow = listing.tools.find(
		(tool) => tool.name === 'search_and_read',
	);
	assert(workflow.outputSchema);
	for (const name of [
		'web_search',
		'web_extract',
		'web_read',
		'web_map',
		'web_crawl',
	])
		assert(
			listing.tools.find((tool) => tool.name === name).outputSchema,
		);
	const result = await call('search_and_read', {
		query: 'needle',
		search_provider: 'tavily',
		extract_provider: 'tavily',
		output_budget_bytes: 2048,
	});
	assert(!result.isError);
	const data = JSON.parse(result.content[0].text);
	assert.deepEqual(result.structuredContent, { ok: true, data });
	assert(Buffer.byteLength(JSON.stringify(result)) <= 2048);
	assert(data.result_id);
	let offset = 1,
		byte_offset = 0,
		canonical = '',
		pages = 0;
	for (; pages < 100; ) {
		const response = await call('result_read', {
			result_id: data.result_id,
			offset,
			byte_offset,
			limit: 500,
		});
		assert(!response.isError);
		const page = JSON.parse(response.content[0].text);
		pages++;
		canonical += page.content;
		if (page.next_offset === undefined) break;
		if (page.next_byte_offset === undefined) canonical += '\n';
		offset = page.next_offset;
		byte_offset = page.next_byte_offset ?? 0;
	}
	const recovered = JSON.parse(canonical);
	assert.equal(recovered.sources.length, 1);
	assert.equal(recovered.sources[0].content, text);
	assert.equal(recovered.metadata.http_requests, 2);
	assert.equal(recovered.metadata.duplicates_removed, 1);
	const error = await call('search_and_read', {
		query: 'needle',
		search_provider: 'tavily',
		extract_provider: 'tavily',
		max_sources: 3,
		search_limit: 1,
	});
	assert(error.isError);
	assert.equal(error.structuredContent.error.kind, 'bad_input');
	const search = await call('web_search', {
		provider: 'tavily',
		query: 'needle',
	});
	assert.deepEqual(
		search.structuredContent.data,
		JSON.parse(search.content[0].text),
	);
	const extract = await call('web_extract', {
		provider: 'tavily',
		url: 'https://example.test/report?edition=2',
		response_mode: 'full',
		output_budget_bytes: 2048,
	});
	assert(!extract.isError);
	assert(Buffer.byteLength(JSON.stringify(extract)) <= 2048);
	assert.deepEqual(
		extract.structuredContent.data,
		JSON.parse(extract.content[0].text),
	);
	for (const name of ['web_read', 'web_map', 'web_crawl']) {
		const focused = await call(name, {
			url: 'https://example.test/report?edition=2',
			...(name === 'web_read' ? { provider: 'tavily' } : {}),
			response_mode: 'full',
			output_budget_bytes: 2048,
		});
		assert(!focused.isError);
		assert(Buffer.byteLength(JSON.stringify(focused)) <= 2048);
		assert.deepEqual(
			focused.structuredContent.data,
			JSON.parse(focused.content[0].text),
		);
	}
	console.log(
		JSON.stringify(
			{
				status: 'passed',
				protocol: initialized.protocolVersion,
				checks: [
					'built-discovery',
					'workflow-success',
					'full-result-budget',
					'lossless-evidence-pages',
					'typed-handler-error',
					'structured-primitives',
					'focused-read-map-crawl',
				],
				evidence_pages: pages,
				provider_network: 'fixture-only',
			},
			null,
			2,
		),
	);
} catch (error) {
	console.error(logs);
	throw error;
} finally {
	if (child.exitCode === null) child.kill('SIGTERM');
	const force = setTimeout(() => child.kill('SIGKILL'), 2000);
	await exit;
	clearTimeout(force);
	await rm(home, { recursive: true, force: true });
}
