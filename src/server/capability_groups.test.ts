import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { config } from '../config/env.js';
import { create_server } from './create_server.js';

const settings = Object.values(config).flatMap(Object.values);
const keys = settings.map((item) => item.api_key);
let sequence = 0;
const make = () =>
	create_server({ name: 'group-fixture', version: '1' });
const discover = async (server: ReturnType<typeof make>) => {
	const result: any = await server.receive({
		jsonrpc: '2.0',
		id: ++sequence,
		method: 'tools/list',
		params: {},
	});
	return result.result.tools
		.map((tool: any) => tool.name)
		.sort() as string[];
};
const call = async (
	server: ReturnType<typeof make>,
	name: string,
	args = {},
) => {
	return (await server.receive({
		jsonrpc: '2.0',
		id: ++sequence,
		method: 'tools/call',
		params: { name, arguments: args },
	})) as any;
};
const fetch_mock = vi.fn(() => {
	throw new Error('UNEXPECTED_PROVIDER_NETWORK');
});
beforeEach(() => {
	for (const item of settings) item.api_key = 'group-fixture-key';
	vi.stubEnv('RETRIEVER_TOOL_GROUPS', undefined);
	vi.stubGlobal('fetch', fetch_mock);
	fetch_mock.mockClear();
	vi.spyOn(console, 'warn').mockImplementation(() => {});
	vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
	settings.forEach((item, index) => {
		item.api_key = keys[index];
	});
	vi.unstubAllEnvs();
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
	expect(fetch_mock).not.toHaveBeenCalled();
});

it.each([
	'',
	' ',
	'research,',
	'none,research',
	'all,media',
	'unknown',
	'RESEARCH',
	'x'.repeat(300),
])(
	'rejects invalid group configuration without echoing its value: %j',
	async (value) => {
		vi.stubEnv('RETRIEVER_TOOL_GROUPS', value);
		expect(make).toThrow('Invalid RETRIEVER_TOOL_GROUPS');
		if (value === 'unknown') expect(make).not.toThrow(value);
	},
);

it('requires an explicit capability classification for every registered tool', async () => {
	const { tool_groups, tool_allowed, configured_tool_groups } =
		await import('./capability_groups.js');
	for (const name of await discover(make()))
		expect(Object.hasOwn(tool_groups, name)).toBe(true);
	for (const name of [
		'unknown_future_tool',
		'__proto__',
		'constructor',
	])
		expect(tool_allowed(name, configured_tool_groups())).toBe(false);
});

it('none leaves only retained-result retrieval and rejects every provider call', async () => {
	const all = await discover(make());
	vi.stubEnv('RETRIEVER_TOOL_GROUPS', 'none');
	const restricted = make();
	expect(await discover(restricted)).toEqual(['result_read']);
	for (const name of all.filter((name) => name !== 'result_read'))
		expect((await call(restricted, name)).error?.code).toBe(-32602);
});

it('routes focused tools into research and automation without mixed legacy entry points', async () => {
	vi.stubEnv('RETRIEVER_TOOL_GROUPS', 'research');
	const research = make();
	expect(await discover(research)).toContain('web_read');
	for (const name of ['web_crawl', 'web_map']) {
		expect(await discover(research)).not.toContain(name);
		expect((await call(research, name)).error?.code).toBe(-32602);
	}
	vi.stubEnv('RETRIEVER_TOOL_GROUPS', 'automation');
	const automation = make();
	expect(await discover(automation)).toEqual([
		'firecrawl_agent',
		'result_read',
		'web_crawl',
		'web_map',
	]);
	expect((await call(automation, 'web_read')).error?.code).toBe(
		-32602,
	);
	expect((await call(automation, 'web_extract')).error?.code).toBe(
		-32602,
	);
});

it('explicit all matches unset and group selections are fixed for each server instance', async () => {
	const original = make();
	const all = await discover(original);
	vi.stubEnv('RETRIEVER_TOOL_GROUPS', 'all');
	expect(await discover(make())).toEqual(all);
	vi.stubEnv('RETRIEVER_TOOL_GROUPS', 'none');
	const empty = make();
	expect(await discover(original)).toEqual(all);
	vi.stubEnv('RETRIEVER_TOOL_GROUPS', 'all');
	expect(await discover(empty)).toEqual(['result_read']);
	expect((await call(empty, 'web_search')).error?.code).toBe(-32602);
});

it('mixed groups require all declared capabilities rather than any overlap', async () => {
	vi.stubEnv(
		'RETRIEVER_TOOL_GROUPS',
		' research, automation,research ',
	);
	const names = await discover(make());
	expect(names).not.toContain('web_extract');
	expect(names).not.toContain('context_web_extract');
	vi.stubEnv('RETRIEVER_TOOL_GROUPS', 'research,automation,media');
	const mixed = await discover(make());
	expect(mixed).toContain('context_web_extract');
	expect(mixed).toContain('web_extract');
});

it.each([
	{ group: 'media', allowed: ['result_read', 'brave_media_search'] },
	{
		group: 'business',
		allowed: [
			'result_read',
			'context_brand_intel',
			'context_styleguide',
			'context_classify',
			'context_transaction_identify',
		],
	},
])(
	'$group only exposes its explicit operations',
	async ({ group, allowed }) => {
		vi.stubEnv('RETRIEVER_TOOL_GROUPS', group);
		expect(await discover(make())).toEqual(allowed.sort());
	},
);

it('cold startup without provider credentials cannot enable tools through a group', async () => {
	vi.resetModules();
	const fresh_config = (await import('../config/env.js')).config;
	for (const item of Object.values(fresh_config).flatMap(
		Object.values,
	))
		item.api_key = undefined;
	vi.stubEnv('RETRIEVER_TOOL_GROUPS', 'research');
	const fresh_create = (await import('./create_server.js'))
		.create_server;
	expect(
		await discover(
			fresh_create({ name: 'cold-fixture', version: '1' }),
		),
	).toEqual(['result_read']);
});

it('research-only omits mixed-purpose and other groups from discovery and direct calls', async () => {
	vi.stubEnv('RETRIEVER_TOOL_GROUPS', 'research');
	const server = make();
	const names = await discover(server);
	expect(names).toContain('web_search');
	expect(names).toContain('search_and_read');
	for (const name of [
		'web_extract',
		'context_web_extract',
		'firecrawl_agent',
		'brave_media_search',
		'context_brand_intel',
	]) {
		expect(names).not.toContain(name);
		const result = await call(server, name);
		expect(result.error?.code).toBe(-32602);
	}
});
