import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ValibotJsonSchemaAdapter } from '@tmcp/adapter-valibot';
import type { GenericSchema } from 'valibot';
import {
	afterEach,
	beforeEach,
	describe,
	expect,
	it,
	vi,
} from 'vitest';
import { store_result } from '../common/result_store.js';
import { search_read_data_schema } from '../common/search_read_result.js';
import {
	create_output_schema,
	output_schema,
} from '../common/tool_output.js';
import { fused_output_schema } from './tools/web_search_fused.js';
// Synthetic configuration only. Fresh modules model a cold process, not a
// credential hot reload. No live entitlement or tenant isolation is implied.
let create_server: typeof import('./create_server.js').create_server;
let register_tools: typeof import('./tools/index.js').register_tools;
let configurations: Array<{
	name: string;
	settings: { api_key: string | undefined };
}>;
const all_tool_names = [
	'ai_search',
	'brave_llm_context',
	'brave_media_search',
	'brave_news_search',
	'context_brand_intel',
	'context_classify',
	'context_styleguide',
	'context_transaction_identify',
	'context_web_extract',
	'firecrawl_agent',
	'github_search',
	'result_read',
	'search_and_read',
	'web_crawl',
	'web_extract',
	'web_map',
	'web_read',
	'web_search',
	'web_search_fused',
];
let home: string;
const fetch_mock = vi.fn(() => {
	throw new Error('P0_UNEXPECTED_PROVIDER_NETWORK');
});
const configure = (enabled: (name: string) => boolean) => {
	for (const { name, settings } of configurations)
		settings.api_key = enabled(name)
			? 'p0-offline-fixture-key'
			: undefined;
};
const make_server = () =>
	create_server({ name: 'p0-offline-fixture', version: '1' });
const p1a_additions = JSON.parse(
	readFileSync(
		new URL(
			'./fixtures/evolution-p1a/schema-additions.json',
			import.meta.url,
		),
		'utf8',
	),
) as Record<string, Record<string, unknown>>;
const p1b_additions = JSON.parse(
	readFileSync(
		new URL(
			'./fixtures/evolution-p1b/schema-additions.json',
			import.meta.url,
		),
		'utf8',
	),
) as Record<string, Record<string, unknown>>;
const p4_additions = JSON.parse(
	readFileSync(
		new URL(
			'./fixtures/evolution-p4/schema-additions.json',
			import.meta.url,
		),
		'utf8',
	),
) as Record<string, Record<string, unknown>>;
const reviewed_additions = [
	p1a_additions,
	p1b_additions,
	p4_additions,
];
const snapshot = (name: string) =>
	JSON.parse(
		readFileSync(
			new URL(
				`./fixtures/evolution-discovery/${name}.json`,
				import.meta.url,
			),
			'utf8',
		),
	);
type ToolDefinition = {
	name: string;
	schema: GenericSchema;
	outputSchema?: GenericSchema;
};
const registered_definitions = () => {
	const definitions: ToolDefinition[] = [];
	register_tools({
		tool: (definition: ToolDefinition) =>
			definitions.push(definition),
	} as any);
	return definitions;
};
// Preserve P0 fixtures; permit only reviewed P1A/P1B input additions,
// the two web output schemas and the separately checked workflow tool.
const expect_p0_compatibility = async (
	tools: Awaited<ReturnType<typeof discover>>,
	profile: string,
) => {
	const adapter = new ValibotJsonSchemaAdapter();
	const workflow = tools.find(
		({ name }) => name === 'search_and_read',
	);
	expect(Boolean(workflow)).toBe(
		tools.some(({ name }) => name === 'web_search') &&
			tools.some(({ name }) => name === 'web_extract'),
	);
	if (workflow) {
		const definition = registered_definitions().find(
			({ name }) => name === workflow.name,
		)!;
		expect(workflow.inputSchema).toEqual(
			await adapter.toJsonSchema(definition.schema),
		);
		expect(workflow.outputSchema).toEqual(
			await adapter.toJsonSchema(
				create_output_schema(search_read_data_schema),
			),
		);
	}
	// The fused search tool exists only beside two or more providers and
	// carries its own output schema, like the workflow tool.
	const fused = tools.find(({ name }) => name === 'web_search_fused');
	const search_providers =
		(
			tools.find(({ name }) => name === 'web_search')?.inputSchema
				.properties as Record<string, any> | undefined
		)?.provider.enum ?? [];
	expect(Boolean(fused)).toBe(search_providers.length >= 2);
	if (fused) {
		const definition = registered_definitions().find(
			({ name }) => name === fused.name,
		)!;
		expect(fused.inputSchema).toEqual(
			await adapter.toJsonSchema(definition.schema),
		);
		expect(fused.outputSchema).toEqual(
			await adapter.toJsonSchema(fused_output_schema),
		);
		expect(fused.inputSchema.required).toEqual([
			'query',
			'providers',
		]);
		expect(
			(fused.inputSchema.properties as Record<string, any>).providers
				.items.enum,
		).toEqual(search_providers);
		expect(fused.inputSchema.additionalProperties).toBe(false);
	}
	const focused_names = ['web_read', 'web_crawl', 'web_map'];
	for (const tool of tools.filter(({ name }) =>
		focused_names.includes(name),
	)) {
		const definition = registered_definitions().find(
			({ name }) => name === tool.name,
		)!;
		expect(tool.inputSchema).toEqual(
			await adapter.toJsonSchema(definition.schema),
		);
		expect(tool.outputSchema).toEqual(
			await adapter.toJsonSchema(output_schema),
		);
		expect(tool.inputSchema.additionalProperties).toBe(false);
		expect(tool.inputSchema.properties).not.toHaveProperty('mode');
	}
	const legacy = structuredClone(
		tools.filter(
			({ name }) =>
				name !== 'search_and_read' &&
				name !== 'web_search_fused' &&
				!focused_names.includes(name),
		),
	);
	for (const tool of legacy) {
		if (tool.name === 'web_search' || tool.name === 'web_extract') {
			expect(tool.outputSchema).toEqual(
				await adapter.toJsonSchema(output_schema),
			);
			delete tool.outputSchema;
		}
		const properties = tool.inputSchema.properties as Record<
			string,
			unknown
		>;
		for (const additions of reviewed_additions) {
			for (const [field, schema] of Object.entries(
				additions[tool.name] ?? {},
			)) {
				expect(properties[field]).toEqual(schema);
				expect(tool.inputSchema.required).not.toContain(field);
				delete properties[field];
			}
		}
	}
	expect(legacy).toEqual(snapshot(profile));
};
const discover = async () => {
	const response: any = await make_server().receive({
		jsonrpc: '2.0',
		id: 1,
		method: 'tools/list',
		params: {},
	});
	expect(response.error).toBeUndefined();
	return response.result.tools as Array<{
		name: string;
		description: string;
		inputSchema: Record<string, unknown>;
		outputSchema?: Record<string, unknown>;
	}>;
};

beforeEach(async () => {
	vi.resetModules();
	const { config } = await import('../config/env.js');
	({ create_server } = await import('./create_server.js'));
	({ register_tools } = await import('./tools/index.js'));
	configurations = Object.values(config).flatMap((category) =>
		Object.entries(category).map(([name, settings]) => ({
			name,
			settings,
		})),
	);
	home = mkdtempSync(join(tmpdir(), 'retriever-p0-discovery-'));
	vi.stubEnv('RETRIEVER_RESULT_DIR', join(home, 'results'));
	vi.stubGlobal('fetch', fetch_mock);
	fetch_mock.mockClear();
	vi.spyOn(console, 'error').mockImplementation(() => {});
	vi.spyOn(console, 'warn').mockImplementation(() => {});
	configure(() => true);
});
afterEach(() => {
	const calls = fetch_mock.mock.calls.length;
	configure(() => false);
	vi.unstubAllGlobals();
	vi.unstubAllEnvs();
	vi.restoreAllMocks();
	rmSync(home, { recursive: true, force: true });
	expect(calls).toBe(0);
});

describe('P0 configured discovery contract', () => {
	it('snapshots all client-visible schemas and verifies conversion from registration', async () => {
		const tools = await discover();
		expect(tools.map(({ name }) => name).sort()).toEqual(
			all_tool_names,
		);
		const definitions = registered_definitions();
		expect(definitions).toHaveLength(tools.length);
		const adapter = new ValibotJsonSchemaAdapter();
		for (const definition of definitions) {
			const converted = await adapter.toJsonSchema(definition.schema);
			expect(
				tools.find(({ name }) => name === definition.name)
					?.inputSchema,
			).toEqual(converted);
			expect(
				tools.find(({ name }) => name === definition.name)
					?.outputSchema,
			).toEqual(
				definition.outputSchema
					? await adapter.toJsonSchema(definition.outputSchema)
					: undefined,
			);
		}
		await expect_p0_compatibility(tools, 'all-providers');
	});

	it('retains only result_read without any configured provider', async () => {
		configure(() => false);
		const tools = await discover();
		expect(tools.map(({ name }) => name)).toEqual(['result_read']);
		await expect_p0_compatibility(tools, 'no-providers');
	});

	it('removes only github_search when the GitHub key is missing', async () => {
		configure((name) => name !== 'github');
		const tools = await discover();
		expect(tools.map(({ name }) => name).sort()).toEqual(
			all_tool_names.filter((name) => name !== 'github_search'),
		);
		await expect_p0_compatibility(tools, 'no-github');
	});

	it('advertises the Tavily-only provider enums without unrelated tools', async () => {
		configure((name) => name.startsWith('tavily'));
		const tools = await discover();
		expect(tools.map(({ name }) => name).sort()).toEqual([
			'ai_search',
			'result_read',
			'search_and_read',
			'web_extract',
			'web_read',
			'web_search',
		]);
		await expect_p0_compatibility(tools, 'tavily-only');
	});

	it.each([
		{ enabled: ['you'], extract: undefined },
		{ enabled: ['tavily_extract'], extract: undefined },
		{ enabled: ['you', 'tavily_extract'], extract: 'tavily' },
		{ enabled: ['you', 'exa_contents'], extract: 'exa' },
		{ enabled: ['you', 'firecrawl_scrape'], extract: 'firecrawl' },
	])(
		'registers workflow only with both search and supported read providers: $enabled',
		async ({ enabled, extract }) => {
			configure((name) => enabled.includes(name));
			const tools = await discover();
			const workflow = tools.find(
				({ name }) => name === 'search_and_read',
			);
			if (!extract) {
				expect(workflow).toBeUndefined();
				return;
			}
			expect(workflow).toBeDefined();
			const properties = workflow!.inputSchema.properties as Record<
				string,
				any
			>;
			expect(properties.search_provider.enum).toEqual(['you']);
			expect(properties.extract_provider.enum).toEqual([extract]);
			expect(Object.keys(properties).sort()).toEqual([
				'extract_provider',
				'max_requests',
				'max_sources',
				'output_budget_bytes',
				'query',
				'search_limit',
				'search_provider',
				'timeout_ms',
			]);
			expect(workflow!.inputSchema.required).toEqual([
				'query',
				'search_provider',
				'extract_provider',
			]);
			expect(workflow!.inputSchema.additionalProperties).toBe(false);
		},
	);

	it('adds only the two optional P1B presentation fields while retaining P1A chunks and no local extractor', async () => {
		const tools = await discover();
		expect(Object.keys(p1b_additions).sort()).toEqual([
			'web_extract',
			'web_search',
		]);
		for (const name of ['web_search', 'web_extract']) {
			expect(Object.keys(p1b_additions[name]).sort()).toEqual([
				'output_budget_bytes',
				'response_mode',
			]);
			const schema = tools.find(
				(tool) => tool.name === name,
			)!.inputSchema;
			for (const [field, definition] of Object.entries(
				p1b_additions[name],
			)) {
				expect(schema.properties).toHaveProperty(field, definition);
				expect(schema.required).not.toContain(field);
			}
		}
		const extract = tools.find(({ name }) => name === 'web_extract')!;
		expect(extract.inputSchema.properties).toHaveProperty('query');
		expect(extract.inputSchema.properties).toHaveProperty(
			'chunks_per_source',
		);
		expect(JSON.stringify(extract.inputSchema)).not.toContain(
			'defuddle',
		);
	});

	it.each([
		{ enabled: ['tavily'], fused: false },
		{ enabled: ['tavily', 'exa'], fused: true },
		{ enabled: ['tavily', 'brave', 'exa', 'you'], fused: true },
	])(
		'registers the fused search only with at least two providers: $enabled',
		async ({ enabled, fused }) => {
			configure((name) => enabled.includes(name));
			const tools = await discover();
			expect(
				tools.some(({ name }) => name === 'web_search_fused'),
			).toBe(fused);
		},
	);

	it('adds only the reviewed optional P4 fields, each absent from the earlier deltas', async () => {
		const tools = await discover();
		for (const [name, fields] of Object.entries(p4_additions)) {
			const schema = tools.find(
				(tool) => tool.name === name,
			)!.inputSchema;
			for (const [field, definition] of Object.entries(fields)) {
				expect(schema.properties).toHaveProperty(field, definition);
				expect(schema.required).not.toContain(field);
				expect(p1a_additions[name] ?? {}).not.toHaveProperty(field);
				expect(p1b_additions[name] ?? {}).not.toHaveProperty(field);
			}
		}
	});

	it('records stale singleton registration after in-process key removal', async () => {
		await discover();
		configure(() => false);
		const tools = await discover();
		// Baseline gap, not desired hot-reload behavior. These initializers
		// do not clear their existing provider when configuration disappears.
		expect(tools.map(({ name }) => name).sort()).toEqual([
			'brave_llm_context',
			'brave_media_search',
			'brave_news_search',
			'firecrawl_agent',
			'github_search',
			'result_read',
		]);
	});
});

describe('built discovery capture phase guards', () => {
	it.each([
		{
			flags: ['--update', '--p1a'],
			error: 'P1A verification must not overwrite P0 fixtures',
		},
		{
			flags: ['--update', '--p1b'],
			error: 'P1B verification must not overwrite P0 fixtures',
		},
		{
			flags: ['--p1a', '--p1b'],
			error: 'Choose only one phase: --p1a or --p1b',
		},
		{
			flags: ['--update', '--workflow'],
			error: 'Workflow verification must not overwrite P0 fixtures',
		},
		{
			flags: ['--p1a', '--workflow'],
			error: 'Use --workflow without --p1a or --p1b',
		},
		{
			flags: ['--p1b', '--workflow'],
			error: 'Use --workflow without --p1a or --p1b',
		},
		{
			flags: ['--focused', '--update'],
			error: 'Focused verification must not overwrite P0 fixtures',
		},
		{
			flags: ['--focused', '--workflow'],
			error: 'Use --focused without other phase flags',
		},
	])(
		'rejects $flags before capture or fixture writes',
		({ flags, error }) => {
			const result = spawnSync(
				process.execPath,
				[
					fileURLToPath(
						new URL(
							'./fixtures/evolution-discovery/capture.mjs',
							import.meta.url,
						),
					),
					...flags,
				],
				{
					env: { PATH: process.env.PATH, HOME: home, CI: 'true' },
					encoding: 'utf8',
					timeout: 5000,
				},
			);
			expect(result.error).toBeUndefined();
			expect(result.status).toBe(1);
			expect(result.stdout).toBe('');
			expect(result.stderr).toContain(error);
		},
	);
});

describe('P0 result privacy boundary, not tenant isolation', () => {
	const read = async (
		server: ReturnType<typeof make_server>,
		id: string,
	) => {
		const response: any = await server.receive({
			jsonrpc: '2.0',
			id: 2,
			method: 'tools/call',
			params: { name: 'result_read', arguments: { result_id: id } },
		});
		return response.result;
	};

	it('uses private filesystem permissions but shares a handle across server instances', async () => {
		configure(() => false);
		const first = make_server();
		const stored = store_result(
			'P0 private fixture, not user content',
		);
		expect(statSync(join(home, 'results')).mode & 0o777).toBe(0o700);
		expect(
			statSync(join(home, 'results', `${stored.result_id}.txt`))
				.mode & 0o777,
		).toBe(0o600);
		const first_result = await read(first, stored.result_id);
		const second_result = await read(make_server(), stored.result_id);
		expect(second_result).toEqual(first_result);
		expect(JSON.parse(second_result.content[0].text).content).toBe(
			'P0 private fixture, not user content',
		);
	});

	it('cannot read the handle from a separate configured result directory', async () => {
		configure(() => false);
		const stored = store_result('P0 directory A');
		vi.stubEnv('RETRIEVER_RESULT_DIR', join(home, 'other-results'));
		const response = await read(make_server(), stored.result_id);
		expect(response.isError).toBe(true);
		expect(response.content[0].text).toContain(
			'Result not found or expired',
		);
		expect(response.content[0].text).not.toContain('P0 directory A');
	});
});
