import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import {
	appendFileSync,
	existsSync,
	mkdtempSync,
	readFileSync,
	rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseEnv } from 'node:util';

// Explicitly invoked live verification, never part of the default test suite.
// The parent reviews pricing and reserves each case's allowance before networking.
// This enforces request counts, not provider billing or automatic top-up policies.
if (process.env.RETRIEVER_LIVE_GUARD === '1') {
	const nativeFetch = globalThis.fetch;
	const rules = JSON.parse(process.env.RETRIEVER_LIVE_RULES);
	const counts = new Map();
	globalThis.fetch = async (input, options = {}) => {
		const url = new URL(
			typeof input === 'string' ? input : (input.url ?? input),
		);
		const method = (options.method ?? 'GET').toUpperCase();
		const key = `${method} ${url.origin}${url.pathname}`;
		const rule = rules.find((item) =>
			new RegExp(item.match).test(key),
		);
		const count = (counts.get(rule?.match) ?? 0) + 1;
		if (!rule || count > rule.limit)
			throw new Error('LIVE_REQUEST_BOUND_REACHED');
		counts.set(rule.match, count);
		const event = {
			method,
			origin: url.origin,
			path: url.pathname,
			attempt: count,
		};
		appendFileSync(
			process.env.RETRIEVER_LIVE_EVENTS,
			`${JSON.stringify({ ...event, phase: 'start' })}\n`,
			{ mode: 0o600 },
		);
		const response = await nativeFetch(input, options);
		const metadata = {};
		try {
			const body = await response.clone().json();
			for (const field of [
				'requestId',
				'request_id',
				'id',
				'status',
				'creditsUsed',
				'costDollars',
				'usage',
			]) {
				if (body?.[field] !== undefined)
					metadata[field] = body[field];
			}
			if (body?.key_metadata) {
				metadata.key_metadata = {
					credits_consumed: body.key_metadata.credits_consumed,
					credits_remaining: body.key_metadata.credits_remaining,
				};
			}
		} catch {
			/* The provider code owns response-shape errors. */
		}
		appendFileSync(
			process.env.RETRIEVER_LIVE_EVENTS,
			`${JSON.stringify({ ...event, phase: 'response', http_status: response.status, metadata })}\n`,
			{ mode: 0o600 },
		);
		return response;
	};
} else {
	await main();
}

async function main() {
	assert.equal(
		process.env.RETRIEVER_LIVE_APPROVED,
		'5',
		'Explicit $5 live-test approval required',
	);
	const [appArg, envArg, planArg, ledgerArg] = process.argv.slice(2);
	assert(
		appArg && envArg && planArg && ledgerArg,
		'Usage: verify-live.mjs APP ENV PLAN LEDGER',
	);
	const app = resolve(appArg);
	const ledger = resolve(ledgerArg);
	const plan = JSON.parse(readFileSync(planArg, 'utf8'));
	assert(Array.isArray(plan.cases) && Array.isArray(plan.rules));
	let failures = 0;
	const previous = existsSync(ledger)
		? readFileSync(ledger, 'utf8')
				.trim()
				.split('\n')
				.filter(Boolean)
				.map(JSON.parse)
		: [];
	const reserved = previous
		.filter((item) => item.phase === 'reserved')
		.reduce((sum, item) => sum + item.reserve_usd, 0);
	const cases = plan.cases.filter(
		(item) => !previous.some((event) => event.id === item.id),
	);
	const allowance = cases.reduce((sum, item) => {
		assert(
			Number.isFinite(item.reserve_usd) &&
				item.reserve_usd > 0 &&
				item.price_source,
			'Every case requires a documented cost bound',
		);
		return sum + item.reserve_usd;
	}, reserved);
	assert(allowance <= 5, `Reserved spend ${allowance} exceeds $5`);
	if (!cases.length) {
		console.log('No unattempted cases; no paid calls repeated.');
		return;
	}
	const record = (data) =>
		appendFileSync(
			ledger,
			`${JSON.stringify({ at: new Date().toISOString(), ...data })}\n`,
			{ mode: 0o600 },
		);
	const requireProxy = createRequire(
		createRequire(join(app, 'package.json')).resolve('mcp-proxy'),
	);
	const { Client } = await import(
		requireProxy.resolve('@modelcontextprotocol/client')
	);
	const { StdioClientTransport } = await import(
		requireProxy.resolve('@modelcontextprotocol/client/stdio')
	);
	const credentials = parseEnv(readFileSync(envArg, 'utf8'));
	const home = mkdtempSync(join(tmpdir(), 'retriever-live-home-'));
	const events = `${ledger}.requests.jsonl`;
	const env = {
		HOME: home,
		PATH: `${dirname(process.execPath)}:${process.env.PATH}`,
		NODE_ENV: 'test',
		RETRIEVER_RESULT_DIR: join(home, 'results'),
		RETRIEVER_LIVE_GUARD: '1',
		RETRIEVER_LIVE_RULES: JSON.stringify(plan.rules),
		RETRIEVER_LIVE_EVENTS: events,
		NODE_OPTIONS: `--import=${fileURLToPath(import.meta.url)}`,
	};
	for (const key of [
		'TAVILY_API_KEY',
		'BRAVE_API_KEY',
		'BRAVE_ANSWERS_API_KEY',
		'EXA_API_KEY',
		'YOU_API_KEY',
		'FIRECRAWL_API_KEY',
		'CONTEXT_DEV_API_KEY',
	]) {
		const value =
			key === 'BRAVE_API_KEY'
				? credentials[key] || credentials.BRAVE_SEARCH_API_KEY
				: credentials[key];
		if (value) env[key] = value;
	}
	assert(
		!credentials.FIRECRAWL_BASE_URL &&
			!credentials.FIRECRAWL_AGENT_URL,
		'This public-fixture plan does not authorize private endpoint overrides',
	);
	const transport = new StdioClientTransport({
		command: process.execPath,
		args: [join(app, 'dist/index.js')],
		cwd: app,
		env,
		stderr: 'pipe',
	});
	transport.stderr?.on('data', () => {}); // Never echo provider logs or credentials.
	const client = new Client(
		{ name: 'approved-live-verification', version: '1' },
		{ capabilities: {} },
	);
	try {
		await client.connect(transport);
		const tools = (await client.listTools()).tools;
		record({
			phase: 'discovery',
			node: process.version,
			tools: tools.map((tool) => tool.name),
			reserved_total_usd: allowance,
		});
		const completed = new Map(
			previous
				.filter((item) => item.phase === 'result')
				.map((item) => [item.id, item]),
		);
		for (const test of cases) {
			const args = { ...test.arguments };
			if (test.job_from) {
				const job_id = completed.get(test.job_from)?.job_id;
				assert(
					typeof job_id === 'string' &&
						/^[0-9a-f-]{36}$/i.test(job_id),
					'Required prior job ID missing; no new job created',
				);
				args.job_id = job_id;
			}
			if (test.delay_ms)
				await new Promise((resolve) =>
					setTimeout(resolve, Math.min(test.delay_ms, 5000)),
				);
			const started = performance.now();
			record({
				phase: 'reserved',
				id: test.id,
				reserve_usd: test.reserve_usd,
				price_source: test.price_source,
				tool: test.tool,
				arguments: args,
			});
			try {
				assert(
					tools.some((tool) => tool.name === test.tool),
					'Tool unavailable',
				);
				const result = await client.callTool(
					{ name: test.tool, arguments: args },
					{ timeout: test.timeout_ms ?? 45000 },
				);
				const text = result.content
					.filter((item) => item.type === 'text')
					.map((item) => item.text)
					.join('\n');
				let body;
				try {
					body = JSON.parse(text);
				} catch {
					body = undefined;
				}
				const ok =
					Boolean(result.isError) === Boolean(test.expect_error) &&
					!result.error &&
					text.length > 0 &&
					(!test.expect || new RegExp(test.expect, 'i').test(text));
				const summary = {
					phase: 'result',
					id: test.id,
					outcome: ok ? 'PASS' : 'FAIL',
					isError: result.isError ?? false,
					elapsed_ms: Math.round(performance.now() - started),
					response_bytes: Buffer.byteLength(text),
					response_sha256: createHash('sha256')
						.update(text)
						.digest('hex'),
					result_count: Array.isArray(body) ? body.length : undefined,
					job_id: body?.metadata?.job_id,
					job_status: body?.metadata?.status,
					preview: text.slice(0, 600),
				};
				record(summary);
				if (!ok) failures++;
				completed.set(test.id, summary);
				console.log(JSON.stringify(summary));
			} catch (error) {
				failures++;
				const summary = {
					phase: 'result',
					id: test.id,
					outcome: 'ERROR',
					error_name: error?.name ?? 'Error',
					error_code: error?.code,
					elapsed_ms: Math.round(performance.now() - started),
				};
				record(summary);
				console.log(JSON.stringify(summary));
			}
		}
		if (failures) process.exitCode = 1;
	} finally {
		await client.close();
		rmSync(home, { recursive: true, force: true });
	}
}
