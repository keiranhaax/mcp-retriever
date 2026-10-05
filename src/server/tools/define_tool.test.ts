import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as v from 'valibot';
import { McpServer } from 'tmcp';
import { ValibotJsonSchemaAdapter } from '@tmcp/adapter-valibot';
import {
	afterEach,
	beforeEach,
	describe,
	expect,
	it,
	vi,
} from 'vitest';
import { presentation_schema } from '../../common/presentation.js';
import { ErrorType, ProviderError } from '../../common/types.js';
import {
	get_provider_health_snapshot,
	register_provider,
	reset_provider_health,
} from '../provider_health.js';
import {
	define_legacy_tool,
	define_presented_tool,
} from './define_tool.js';

let sequence = 0;
let directory: string;
const make_server = () =>
	new McpServer<v.GenericSchema>(
		{ name: 'define-tool-fixture', version: '1' },
		{
			adapter: new ValibotJsonSchemaAdapter(),
			capabilities: { tools: { listChanged: true } },
		},
	);
const receive = async (
	server: McpServer<v.GenericSchema>,
	method: string,
	params: Record<string, unknown> = {},
) =>
	(await server.receive(
		{ jsonrpc: '2.0', id: ++sequence, method, params },
		{} as any,
	)) as any;
const call = (
	server: McpServer<v.GenericSchema>,
	name: string,
	args: Record<string, unknown>,
) => receive(server, 'tools/call', { name, arguments: args });
const annotations = {
	readOnlyHint: true,
	destructiveHint: false,
	idempotentHint: true,
	openWorldHint: true,
};

beforeEach(() => {
	directory = mkdtempSync(join(tmpdir(), 'retriever-define-tool-'));
	vi.stubEnv('RETRIEVER_RESULT_DIR', directory);
	reset_provider_health();
	register_provider('search', 'fixture');
	vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
	vi.unstubAllEnvs();
	vi.restoreAllMocks();
	rmSync(directory, { recursive: true, force: true });
});

describe('define_presented_tool', () => {
	const schema = v.object({
		...presentation_schema.entries,
		query: v.pipe(v.string(), v.description('Query')),
		provider: v.picklist(['fixture']),
	});

	it('forwards the public contract unchanged and renders the structured envelope', async () => {
		const server = make_server();
		define_presented_tool(
			server,
			{
				name: 'fixture_search',
				description: 'Fixture search tool',
				annotations,
				category: 'search',
				provider: (input) => input.provider,
				schema,
			},
			async ({ query }) => ({
				result: [
					{
						title: 'Hit',
						url: 'https://example.test',
						snippet: query,
						source_provider: 'fixture',
					},
				],
				operation: 'search',
				query,
			}),
		);
		const listed = (await receive(server, 'tools/list')).result.tools;
		expect(listed).toHaveLength(1);
		expect(listed[0]).toMatchObject({
			name: 'fixture_search',
			description: 'Fixture search tool',
			annotations,
		});
		expect(listed[0].inputSchema.properties).toHaveProperty('query', {
			type: 'string',
			description: 'Query',
		});
		expect(listed[0].outputSchema.properties).toHaveProperty('ok');

		const response = await call(server, 'fixture_search', {
			query: 'needle',
			provider: 'fixture',
			response_mode: 'full',
		});
		expect(response.result.isError).not.toBe(true);
		expect(response.result.structuredContent).toMatchObject({
			ok: true,
			data: {
				response_mode: 'full',
				metadata: { provider: 'fixture', operation: 'search' },
				result: [{ snippet: 'needle' }],
			},
		});
		expect(
			get_provider_health_snapshot().search.fixture
				.last_runtime_status,
		).toBe('ok');
	});

	it('rejects presentation controls before running and reports errors through the envelope', async () => {
		const server = make_server();
		const run = vi.fn(async () => {
			throw new ProviderError(
				ErrorType.PROVIDER_ERROR,
				'fixture API internal error',
				'fixture',
				{ status: 503 },
			);
		});
		define_presented_tool(
			server,
			{
				name: 'fixture_search',
				description: 'Fixture search tool',
				annotations,
				category: 'search',
				provider: 'fixture',
				schema,
			},
			run,
		);
		const invalid = await call(server, 'fixture_search', {
			query: 'needle',
			provider: 'fixture',
			output_budget_bytes: 4096,
		});
		expect(invalid.result).toMatchObject({
			isError: true,
			structuredContent: { ok: false, error: { kind: 'bad_input' } },
		});
		expect(run).not.toHaveBeenCalled();

		const failed = await call(server, 'fixture_search', {
			query: 'needle',
			provider: 'fixture',
		});
		expect(failed.result).toMatchObject({
			isError: true,
			structuredContent: {
				ok: false,
				error: {
					kind: 'upstream_failure',
					provider: 'fixture',
					http_status: 503,
				},
			},
		});
		expect(
			get_provider_health_snapshot().search.fixture,
		).toMatchObject({
			last_runtime_status: 'provider_error',
			active_error: true,
		});
	});
});

describe('define_legacy_tool', () => {
	const schema = v.object({ query: v.string() });

	it('keeps the text-only envelope for results and errors', async () => {
		const server = make_server();
		define_legacy_tool(
			server,
			{
				name: 'fixture_legacy',
				description: 'Legacy fixture tool',
				annotations,
				category: 'search',
				provider: 'fixture',
				schema,
			},
			async ({ query }) => {
				if (query === 'fail')
					throw new ProviderError(
						ErrorType.API_ERROR,
						'Invalid API key',
						'fixture',
						{ status: 401 },
					);
				return [{ title: query }];
			},
		);
		const listed = (await receive(server, 'tools/list')).result.tools;
		expect(listed[0]).not.toHaveProperty('outputSchema');

		const ok = await call(server, 'fixture_legacy', { query: 'hit' });
		expect(ok.result).toEqual({
			content: [
				{
					type: 'text',
					text: JSON.stringify([{ title: 'hit' }], null, 2),
				},
			],
		});
		expect(ok.result).not.toHaveProperty('structuredContent');

		const failed = await call(server, 'fixture_legacy', {
			query: 'fail',
		});
		expect(failed.result).toEqual({
			content: [
				{
					type: 'text',
					text: 'fixture error [API_ERROR]: Invalid API key',
				},
			],
			isError: true,
		});
		expect(
			get_provider_health_snapshot().search.fixture,
		).toMatchObject({
			last_runtime_status: 'provider_error',
			last_error_kind: 'authentication',
		});
	});
});
