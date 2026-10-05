// Score the fixed search evaluation set per provider.
//
//   node scripts/eval-search.mjs --input RUN.json [--out DIR]
//   node scripts/eval-search.mjs --live --providers tavily,exa \
//     --budget-usd 0.50 --budget-credits 50 --env .env [--out DIR] \
//     [--limit 10] [--fuse] [--app DIR]
//
// Offline scoring reads a recorded run and never networks. Live mode is
// explicit: it needs --live and both budgets, drives the built server
// through the ordinary web_search tool (so spending caps, cooldowns,
// metrics and request budgets all apply), stops when the reported spend
// reaches a budget, and bounds raw requests with the guard from
// scripts/verify-live.mjs. Reports go to the ignored reports/ tree.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import {
	appendFileSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseEnv } from 'node:util';
import { render_markdown, score_run } from './eval/scoring.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const default_manifest = join(
	root,
	'src/common/fixtures/eval-queries/manifest.json',
);
// Hard ceilings for one run, on top of the operator's spending caps.
const MAX_BUDGET_USD = 5;
const MAX_BUDGET_CREDITS = 500;
const MAX_FUSED_PROVIDERS = 3;
const provider_keys = {
	tavily: ['TAVILY_API_KEY'],
	brave: ['BRAVE_API_KEY', 'BRAVE_SEARCH_API_KEY'],
	exa: ['EXA_API_KEY'],
	you: ['YOU_API_KEY'],
	searxng: ['SEARXNG_URL'],
};
const provider_rules = {
	tavily: 'POST https://api.tavily.com/search',
	brave: 'GET https://api.search.brave.com/res/v1/web/search',
	exa: 'POST https://api.exa.ai/search',
	you: 'GET https://api.you.com/v1/search',
};

const parse_args = (argv) => {
	const options = { flags: new Set(), values: {} };
	for (let index = 0; index < argv.length; index++) {
		const argument = argv[index];
		assert(
			argument.startsWith('--'),
			`Unexpected argument ${argument}`,
		);
		const name = argument.slice(2);
		if (['live', 'fuse', 'help'].includes(name)) {
			options.flags.add(name);
			continue;
		}
		const value = argv[index + 1];
		assert(
			value !== undefined && !value.startsWith('--'),
			`--${name} needs a value`,
		);
		options.values[name] = value;
		index++;
	}
	return options;
};

const positive_amount = (raw, name, max) => {
	assert(
		typeof raw === 'string' && /^\d{1,6}(\.\d{1,6})?$/.test(raw),
		`--${name} must be a positive decimal number`,
	);
	const value = Number(raw);
	assert(
		value > 0 && value <= max,
		`--${name} must be within (0, ${max}]`,
	);
	return value;
};

const report_dir = (requested) => {
	const directory = requested
		? resolve(requested)
		: join(
				root,
				'reports/eval',
				new Date().toISOString().replace(/[:.]/g, '-'),
			);
	mkdirSync(directory, { recursive: true, mode: 0o700 });
	return directory;
};

const write_reports = (directory, manifest, run) => {
	const report = score_run(manifest, run);
	writeFileSync(
		join(directory, 'run.json'),
		`${JSON.stringify(run, null, '\t')}\n`,
		{ mode: 0o600 },
	);
	writeFileSync(
		join(directory, 'report.json'),
		`${JSON.stringify(report, null, '\t')}\n`,
		{ mode: 0o600 },
	);
	writeFileSync(
		join(directory, 'report.md'),
		render_markdown(report),
		{
			mode: 0o600,
		},
	);
	return report;
};

const print_summary = (report, directory) => {
	for (const [provider, score] of Object.entries(report.providers))
		console.log(
			JSON.stringify({
				provider,
				queries: score.queries,
				answered: score.answered,
				hit_at_1: score.hit_at_1,
				hit_at_5: score.hit_at_5,
				mrr: score.mrr,
				p50_ms: score.latency_ms.p50,
				usd: score.cost.usd,
				credits: score.cost.credits,
			}),
		);
	console.log(`Reports written to ${directory}`);
};

const score_offline = (options) => {
	const manifest = JSON.parse(
		readFileSync(options.values.manifest ?? default_manifest, 'utf8'),
	);
	const run = JSON.parse(
		readFileSync(resolve(options.values.input), 'utf8'),
	);
	assert(
		Array.isArray(run.records),
		'Run file needs a records array',
	);
	const directory = report_dir(options.values.out);
	print_summary(write_reports(directory, manifest, run), directory);
};

const run_live = async (options) => {
	const manifest = JSON.parse(
		readFileSync(options.values.manifest ?? default_manifest, 'utf8'),
	);
	const providers = (options.values.providers ?? '')
		.split(',')
		.map((name) => name.trim())
		.filter(Boolean);
	assert(
		providers.length,
		'--providers lists the providers to score',
	);
	for (const provider of providers)
		assert(
			Object.hasOwn(provider_keys, provider),
			`Unknown provider ${provider}`,
		);
	const budget = {
		usd: positive_amount(
			options.values['budget-usd'],
			'budget-usd',
			MAX_BUDGET_USD,
		),
		credits: positive_amount(
			options.values['budget-credits'],
			'budget-credits',
			MAX_BUDGET_CREDITS,
		),
	};
	const limit = Number(options.values.limit ?? 10);
	assert(
		Number.isInteger(limit) && limit >= 1 && limit <= 20,
		'--limit must be an integer from 1 to 20',
	);
	assert(options.values.env, '--env names the credentials file');
	const fuse = options.flags.has('fuse');
	assert(
		!fuse ||
			(providers.length >= 2 &&
				providers.length <= MAX_FUSED_PROVIDERS),
		`--fuse needs 2 to ${MAX_FUSED_PROVIDERS} providers`,
	);
	const app = resolve(options.values.app ?? root);
	const credentials = parseEnv(
		readFileSync(options.values.env, 'utf8'),
	);
	const directory = report_dir(options.values.out);
	const home = mkdtempSync(join(tmpdir(), 'retriever-eval-home-'));
	const events = join(directory, 'requests.jsonl');
	// One attempt plus the request helper's single retry per call, for
	// every single-provider call and every fused call that includes it.
	const calls_per_provider = manifest.queries.length * (fuse ? 2 : 1);
	const rules = providers
		.filter((provider) => provider_rules[provider])
		.map((provider) => ({
			match: `^${provider_rules[provider].replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`,
			limit: calls_per_provider * 2,
		}));
	const env = {
		HOME: home,
		PATH: `${dirname(process.execPath)}:${process.env.PATH}`,
		NODE_ENV: 'test',
		RETRIEVER_RESULT_DIR: join(home, 'results'),
		RETRIEVER_HTTP_CACHE_BYTES: '0',
		RETRIEVER_LIVE_GUARD: '1',
		RETRIEVER_LIVE_RULES: JSON.stringify(rules),
		RETRIEVER_LIVE_EVENTS: events,
		NODE_OPTIONS: `--import=${fileURLToPath(new URL('./verify-live.mjs', import.meta.url))}`,
	};
	// The operator's own caps and cooldown settings travel with the run.
	for (const name of [
		'RETRIEVER_SPEND_CAPS',
		'RETRIEVER_PROVIDER_COOLDOWN_MS',
	]) {
		const value = process.env[name] ?? credentials[name];
		if (value) env[name] = value;
	}
	for (const provider of providers) {
		const [primary, ...aliases] = provider_keys[provider];
		const value =
			credentials[primary] ??
			aliases.map((alias) => credentials[alias]).find(Boolean);
		assert(
			value,
			`${provider} has no credential in ${options.values.env}`,
		);
		env[primary] = value;
	}
	const requireProxy = createRequire(
		createRequire(join(app, 'package.json')).resolve('mcp-proxy'),
	);
	const { Client } = await import(
		requireProxy.resolve('@modelcontextprotocol/client')
	);
	const { StdioClientTransport } = await import(
		requireProxy.resolve('@modelcontextprotocol/client/stdio')
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
		{ name: 'search-evaluation', version: '1' },
		{ capabilities: {} },
	);
	const run = {
		version: 1,
		mode: 'live',
		started_at: new Date().toISOString(),
		top_k: limit,
		providers,
		fuse,
		budget,
		spent: { usd: 0, credits: 0 },
		records: [],
	};
	// Single providers go through web_search; the fused column calls
	// web_search_fused, whose per-provider outcomes carry the usage.
	const columns = [
		...providers.map((provider) => ({
			label: provider,
			tool: 'web_search',
			arguments: { provider, response_mode: 'full' },
		})),
		...(fuse
			? [
					{
						label: `fused:${providers.join('+')}`,
						tool: 'web_search_fused',
						arguments: { providers },
					},
				]
			: []),
	];
	const usage_of = (body) => {
		if (Array.isArray(body.data?.providers)) {
			const total = { usd: 0, credits: 0 };
			for (const outcome of body.data.providers) {
				if (outcome.usage?.usd) total.usd += outcome.usage.usd;
				if (outcome.usage?.credits)
					total.credits += outcome.usage.credits;
			}
			return total.usd || total.credits ? total : null;
		}
		return body.data?.metadata?.usage ?? null;
	};
	const stopped = new Set();
	let exhausted = false;
	try {
		await client.connect(transport);
		const tools = (await client.listTools()).tools;
		const search = tools.find((tool) => tool.name === 'web_search');
		assert(search, 'web_search is not registered');
		const advertised = search.inputSchema.properties.provider.enum;
		for (const provider of providers)
			assert(
				advertised.includes(provider),
				`web_search does not advertise ${provider}`,
			);
		assert(
			!fuse || tools.some((tool) => tool.name === 'web_search_fused'),
			'web_search_fused is not registered',
		);
		for (const query of manifest.queries) {
			for (const column of columns) {
				const record = {
					query_id: query.id,
					provider: column.label,
					status: 'skipped',
					urls: [],
					latency_ms: null,
					usage: null,
				};
				run.records.push(record);
				if (exhausted) {
					record.error_kind = 'run_budget';
					continue;
				}
				if (stopped.has(column.label)) {
					record.error_kind = 'provider_stopped';
					continue;
				}
				const started = performance.now();
				try {
					const result = await client.callTool(
						{
							name: column.tool,
							arguments: {
								query: query.query,
								limit,
								...column.arguments,
							},
						},
						{ timeout: 60000 },
					);
					record.latency_ms = Math.round(performance.now() - started);
					const body = result.structuredContent;
					if (!body?.ok) {
						record.status = 'error';
						record.error_kind = body?.error?.kind ?? 'unknown';
						if (
							['spend_cap', 'authentication', 'entitlement'].includes(
								record.error_kind,
							)
						)
							stopped.add(column.label);
						continue;
					}
					const items = body.data?.result ?? body.data?.results;
					if (!Array.isArray(items)) {
						record.status = 'error';
						record.error_kind = 'retained';
						continue;
					}
					record.status = 'ok';
					record.urls = items
						.map((item) => item.url)
						.filter((url) => typeof url === 'string');
					record.usage = usage_of(body);
					if (record.usage?.usd) run.spent.usd += record.usage.usd;
					if (record.usage?.credits)
						run.spent.credits += record.usage.credits;
					if (
						run.spent.usd >= budget.usd ||
						run.spent.credits >= budget.credits
					)
						exhausted = true;
				} catch (error) {
					// A client-side failure (timeout, transport); the guard's
					// request bound surfaces inside the server as a tool error.
					record.latency_ms = Math.round(performance.now() - started);
					record.status = 'error';
					record.error_kind = error?.name ?? 'Error';
				}
			}
		}
	} finally {
		await client.close();
		rmSync(home, { recursive: true, force: true });
		appendFileSync(
			events,
			`${JSON.stringify({ phase: 'finished', at: new Date().toISOString(), spent: run.spent, exhausted })}\n`,
			{ mode: 0o600 },
		);
	}
	run.finished_at = new Date().toISOString();
	run.exhausted = exhausted;
	print_summary(write_reports(directory, manifest, run), directory);
	if (exhausted)
		console.log(
			`Stopped early: reported spend reached the run budget (${JSON.stringify(run.spent)}).`,
		);
};

const options = parse_args(process.argv.slice(2));
if (
	options.flags.has('help') ||
	(!options.values.input && !options.flags.has('live'))
) {
	console.log(
		[
			'Usage:',
			'  node scripts/eval-search.mjs --input RUN.json [--out DIR] [--manifest PATH]',
			'  node scripts/eval-search.mjs --live --providers tavily,exa --budget-usd 0.50 --budget-credits 50 --env .env [--out DIR] [--limit 10] [--fuse] [--app DIR]',
		].join('\n'),
	);
	process.exitCode = options.flags.has('help') ? 0 : 2;
} else if (options.flags.has('live')) {
	assert(!options.values.input, 'Use either --input or --live');
	await run_live(options);
} else {
	score_offline(options);
}
