// P0 fixture verification; --p1a/--p1b allow reviewed optional additions.
// --p1b includes P1A. Phase flags cannot be combined with each other or
// --update, which refreshes P0 snapshots only.
// --workflow verifies P1B plus structured output and search_and_read,
// without changing any historical schema fixture. --focused includes
// workflow plus the three focused tools, with unchanged historic schemas.
// Run only in an approved isolated worktree,
// after building the exact source revision being recorded. No provider calls.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../../../', import.meta.url));
assert(
	process.argv
		.slice(2)
		.every((argument) =>
			[
				'--update',
				'--p1a',
				'--p1b',
				'--workflow',
				'--focused',
			].includes(argument),
		),
);
const update = process.argv.includes('--update');
const p1a = process.argv.includes('--p1a');
const p1b = process.argv.includes('--p1b');
const focused = process.argv.includes('--focused');
const workflow = process.argv.includes('--workflow') || focused;
assert(
	!(focused && update),
	'Focused verification must not overwrite P0 fixtures',
);
assert(
	!(focused && (p1a || p1b || process.argv.includes('--workflow'))),
	'Use --focused without other phase flags',
);
assert(!(p1a && p1b), 'Choose only one phase: --p1a or --p1b');
assert(
	!(workflow && (p1a || p1b)),
	'Use --workflow without --p1a or --p1b',
);
assert(
	!(workflow && update),
	'Workflow verification must not overwrite P0 fixtures',
);
assert(
	!(update && p1a),
	'P1A verification must not overwrite P0 fixtures',
);
assert(
	!(update && p1b),
	'P1B verification must not overwrite P0 fixtures',
);
// Workflow and focused verification run against the current server, so
// they also subtract the later reviewed P4 additions.
const phases =
	p1b || workflow
		? ['p1a', 'p1b', ...(workflow ? ['p4'] : [])]
		: p1a
			? ['p1a']
			: [];
const additions = await Promise.all(
	phases.map(async (phase) =>
		JSON.parse(
			await readFile(
				new URL(
					`../evolution-${phase}/schema-additions.json`,
					import.meta.url,
				),
				'utf8',
			),
		),
	),
);
if (p1b || workflow) {
	const delta = additions[1];
	assert.deepEqual(Object.keys(delta).sort(), [
		'web_extract',
		'web_search',
	]);
	for (const fields of Object.values(delta))
		assert.deepEqual(Object.keys(fields).sort(), [
			'output_budget_bytes',
			'response_mode',
		]);
}
const keys = [
	'TAVILY_API_KEY',
	'BRAVE_API_KEY',
	'BRAVE_ANSWERS_API_KEY',
	'EXA_API_KEY',
	'GITHUB_API_KEY',
	'YOU_API_KEY',
	'LINKUP_API_KEY',
	'FIRECRAWL_API_KEY',
	'CONTEXT_DEV_API_KEY',
];
const profiles = [
	{ name: 'all-providers', enabled: keys, count: 14, workflow: true },
	{ name: 'no-providers', enabled: [], count: 1 },
	{
		name: 'no-github',
		enabled: keys.filter((key) => key !== 'GITHUB_API_KEY'),
		count: 13,
		workflow: true,
	},
	{
		name: 'tavily-only',
		enabled: ['TAVILY_API_KEY'],
		count: 4,
		workflow: true,
	},
];
const deny_network = `
import net from 'node:net';
import {syncBuiltinESMExports} from 'node:module';
const deny = () => {process.stderr.write('P0_NETWORK_ATTEMPT\\n'); throw new Error('P0_NETWORK_BLOCKED');};
globalThis.fetch = deny;
net.Socket.prototype.connect = deny;
syncBuiltinESMExports();
`;

for (const profile of profiles) {
	const home = await mkdtemp(join(tmpdir(), 'retriever-p0-schema-'));
	const env = {
		PATH: process.env.PATH,
		HOME: home,
		RETRIEVER_RESULT_DIR: join(home, 'results'),
		NODE_OPTIONS: `--import=data:text/javascript,${encodeURIComponent(deny_network)}`,
	};
	for (const key of profile.enabled)
		env[key] = 'p0-offline-fixture-key';
	const child = spawn(process.execPath, ['dist/index.js'], {
		cwd: root,
		env,
		stdio: ['pipe', 'pipe', 'pipe'],
	});
	let logs = '';
	let pending = '';
	let bytes = 0;
	let sequence = 0;
	const requests = new Map();
	const exit = new Promise((resolve) => {
		child.once('exit', resolve);
		child.once('error', resolve);
	});
	child.stderr.setEncoding('utf8');
	child.stderr.on('data', (chunk) => {
		logs = (logs + chunk).slice(-8000);
	});
	child.stdout.setEncoding('utf8');
	child.stdout.on('data', (chunk) => {
		bytes += Buffer.byteLength(chunk);
		if (bytes > 1024 * 1024) {
			child.kill('SIGTERM');
			return;
		}
		pending += chunk;
		const lines = pending.split('\n');
		pending = lines.pop();
		for (const line of lines) {
			try {
				const message = JSON.parse(line);
				requests.get(message.id)?.(message);
			} catch {
				child.kill('SIGTERM');
			}
		}
	});
	const rpc = (method, params) =>
		new Promise((resolve, reject) => {
			const id = ++sequence;
			const timer = setTimeout(() => {
				requests.delete(id);
				reject(new Error(`P0 ${method} deadline`));
			}, 5000);
			requests.set(id, (message) => {
				clearTimeout(timer);
				requests.delete(id);
				if (message.error)
					reject(new Error(`P0 ${method} RPC failure`));
				else resolve(message.result);
			});
			child.stdin.write(
				JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n',
			);
		});
	try {
		const initialized = await rpc('initialize', {
			protocolVersion: '2025-11-25',
			capabilities: {},
			clientInfo: { name: 'p0-offline-schema-capture', version: '1' },
		});
		// Direct tmcp stdio negotiates this older revision at the P0 baseline.
		// The proxy supplies the separate legacy/modern HTTP contracts.
		assert.equal(initialized.protocolVersion, '2025-06-18');
		child.stdin.write(
			JSON.stringify({
				jsonrpc: '2.0',
				method: 'notifications/initialized',
			}) + '\n',
		);
		const { tools } = await rpc('tools/list', {});
		const count =
			profile.count +
			(workflow && profile.workflow ? 1 : 0) +
			(focused && profile.workflow
				? profile.name === 'tavily-only'
					? 1
					: 3
				: 0);
		assert.equal(tools.length, count);
		assert.equal(new Set(tools.map((tool) => tool.name)).size, count);
		assert(!logs.includes('P0_NETWORK_ATTEMPT'));
		const target = new URL(`${profile.name}.json`, import.meta.url);
		if (update)
			await writeFile(
				target,
				JSON.stringify(tools, null, '	') + '\n',
			);
		else {
			const legacy = structuredClone(tools);
			if (focused) {
				const expected = profile.workflow
					? profile.name === 'tavily-only'
						? ['web_read']
						: ['web_crawl', 'web_map', 'web_read']
					: [];
				const added = legacy.filter((tool) =>
					['web_read', 'web_crawl', 'web_map'].includes(tool.name),
				);
				assert.deepEqual(
					added.map((tool) => tool.name).sort(),
					expected,
				);
				for (const tool of added) {
					assert.deepEqual(
						tool.outputSchema,
						legacy.find((item) => item.name === 'web_extract')
							.outputSchema,
					);
					assert.equal(tool.inputSchema.additionalProperties, false);
					assert(!Object.hasOwn(tool.inputSchema.properties, 'mode'));
					assert.deepEqual(
						tool.inputSchema.required,
						tool.name === 'web_read' ? ['provider', 'url'] : ['url'],
					);
					legacy.splice(legacy.indexOf(tool), 1);
				}
			}
			if (workflow) {
				const index = legacy.findIndex(
					(tool) => tool.name === 'search_and_read',
				);
				assert.equal(index >= 0, Boolean(profile.workflow));
				const outputNames = legacy
					.filter((tool) => tool.outputSchema !== undefined)
					.map((tool) => tool.name)
					.sort();
				assert.deepEqual(
					outputNames,
					profile.workflow
						? ['search_and_read', 'web_extract', 'web_search']
						: [],
				);
				if (index >= 0) {
					const search = legacy.find(
						(tool) => tool.name === 'web_search',
					);
					const extract = legacy.find(
						(tool) => tool.name === 'web_extract',
					);
					const combined = legacy[index];
					assert.deepEqual(search.outputSchema, extract.outputSchema);
					assert.notDeepEqual(
						combined.outputSchema,
						search.outputSchema,
					);
					for (const tool of [search, extract, combined]) {
						assert.equal(tool.outputSchema.type, 'object');
						assert.deepEqual(
							Object.keys(tool.outputSchema.properties).sort(),
							['data', 'error', 'ok'],
						);
						assert(tool.outputSchema.required.includes('ok'));
					}
					assert.deepEqual(
						combined.inputSchema.properties.search_provider.enum,
						search.inputSchema.properties.provider.enum,
					);
					assert.deepEqual(
						combined.inputSchema.properties.extract_provider.enum,
						extract.inputSchema.properties.provider.enum,
					);
					assert.deepEqual(combined.inputSchema.required, [
						'query',
						'search_provider',
						'extract_provider',
					]);
					assert.equal(
						combined.inputSchema.additionalProperties,
						false,
					);
					assert(
						!Object.hasOwn(combined.inputSchema.properties, 'mode'),
					);
					delete search.outputSchema;
					delete extract.outputSchema;
					legacy.splice(index, 1);
				}
			}
			for (const tool of legacy) {
				for (const delta of additions) {
					for (const [field, schema] of Object.entries(
						delta[tool.name] ?? {},
					)) {
						assert.deepEqual(
							tool.inputSchema.properties[field],
							schema,
						);
						assert(!tool.inputSchema.required.includes(field));
						delete tool.inputSchema.properties[field];
					}
				}
			}
			assert.deepEqual(
				legacy,
				JSON.parse(await readFile(target, 'utf8')),
			);
		}
		console.log(
			JSON.stringify({
				profile: profile.name,
				tools: tools.map((tool) => tool.name),
				count: tools.length,
				protocol: initialized.protocolVersion,
				network_attempted: false,
			}),
		);
	} finally {
		if (child.exitCode === null) child.kill('SIGTERM');
		const timer = setTimeout(() => child.kill('SIGKILL'), 2000);
		await exit;
		clearTimeout(timer);
		await rm(home, { recursive: true, force: true });
	}
}
