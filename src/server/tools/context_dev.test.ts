import {
	afterEach,
	beforeEach,
	describe,
	expect,
	it,
	vi,
} from 'vitest';
import { config } from '../../config/env.js';
import * as v from 'valibot';
import { create_server as create_mcp_server } from '../create_server.js';
import {
	get_provider_health_snapshot,
	reset_provider_health,
} from '../provider_health.js';
import { get_provider_metrics_snapshot } from '../provider_metrics.js';
import {
	get_available,
	initialize_context_dev,
	register_context_dev_tools,
} from './context_dev.js';

const fetch_mock = vi.fn();
const previous_key = config.search.context_dev.api_key;

const create_server = () => {
	const tools: Array<{
		definition: { name: string; schema: v.GenericSchema };
		handler: any;
	}> = [];
	return {
		tools,
		server: {
			tool: (
				definition: { name: string; schema: v.GenericSchema },
				handler: any,
			) => {
				tools.push({ definition, handler });
			},
		},
	};
};

describe('Context.dev tools', () => {
	beforeEach(() => {
		fetch_mock.mockReset();
		vi.stubGlobal('fetch', fetch_mock);
		config.search.context_dev.api_key = 'ctx-test-key';
	});

	afterEach(() => {
		config.search.context_dev.api_key = previous_key;
		vi.unstubAllGlobals();
		vi.restoreAllMocks();
	});

	it('does not register tools when CONTEXT_DEV_API_KEY is missing', () => {
		config.search.context_dev.api_key = undefined;
		const { server, tools } = create_server();

		expect(initialize_context_dev()).toBe(false);
		register_context_dev_tools(server as any);

		expect(tools).toHaveLength(0);
	});

	it('registers the expected context tools when configured', () => {
		const { server, tools } = create_server();

		expect(initialize_context_dev()).toBe(true);
		register_context_dev_tools(server as any);

		expect(tools.map((tool) => tool.definition.name)).toEqual([
			'context_web_extract',
			'context_brand_intel',
			'context_styleguide',
			'context_classify',
			'context_transaction_identify',
		]);
	});

	it('maps markdown web extraction to the documented scrape endpoint', async () => {
		fetch_mock.mockResolvedValue(
			new Response(
				JSON.stringify({
					success: true,
					markdown: 'Hello',
					url: 'https://example.com',
				}),
				{
					status: 200,
					headers: { 'Content-Type': 'application/json' },
				},
			),
		);
		const { server, tools } = create_server();
		initialize_context_dev();
		register_context_dev_tools(server as any);

		const tool = tools.find(
			(item) => item.definition.name === 'context_web_extract',
		)!;
		const result = await tool.handler({
			mode: 'markdown',
			url: 'https://example.com',
			maxAgeMs: 0,
			timeoutMS: 1000,
		});

		const [url, options] = fetch_mock.mock.calls[0];
		expect(url).toBe(
			'https://api.context.dev/v1/web/scrape/markdown?url=https%3A%2F%2Fexample.com&timeoutMS=1000&maxAgeMs=0',
		);
		expect(options.headers.Authorization).toBe('Bearer ctx-test-key');
		expect(result.content[0].text).toContain('Hello');
	});

	it('maps brand lookup and transaction tools to documented brand endpoints', async () => {
		fetch_mock.mockResolvedValue(
			new Response(
				JSON.stringify({ status: 'ok', brand: { title: 'Example' } }),
				{
					status: 200,
					headers: { 'Content-Type': 'application/json' },
				},
			),
		);
		const { server, tools } = create_server();
		initialize_context_dev();
		register_context_dev_tools(server as any);

		await tools
			.find((item) => item.definition.name === 'context_brand_intel')!
			.handler({
				lookup_type: 'stock_ticker',
				value: 'AAPL',
			});
		expect(fetch_mock.mock.calls[0][0]).toBe(
			'https://api.context.dev/v1/brand/retrieve-by-ticker?ticker=AAPL',
		);

		await tools
			.find(
				(item) =>
					item.definition.name === 'context_transaction_identify',
			)!
			.handler({
				transaction_info: 'SQ *COFFEE SHOP',
				country_gl: 'us',
			});
		expect(fetch_mock.mock.calls[1][0]).toBe(
			'https://api.context.dev/v1/brand/transaction_identifier?transaction_info=SQ+*COFFEE+SHOP&country_gl=us',
		);
	});

	it('uses brand retrieval for EIC classification data', async () => {
		fetch_mock.mockResolvedValue(
			new Response(
				JSON.stringify({
					status: 'ok',
					brand: { industries: { eic: [{ code: 'software' }] } },
				}),
				{
					status: 200,
					headers: { 'Content-Type': 'application/json' },
				},
			),
		);
		const { server, tools } = create_server();
		initialize_context_dev();
		register_context_dev_tools(server as any);

		const result = await tools
			.find((item) => item.definition.name === 'context_classify')!
			.handler({
				taxonomy: 'eic',
				domain: 'example.com',
			});

		expect(fetch_mock.mock.calls[0][0]).toBe(
			'https://api.context.dev/v1/brand/retrieve?domain=example.com',
		);
		expect(result.content[0].text).toContain('software');
	});

	it.each([
		[
			'context_web_extract',
			{ mode: 'sitemap', domain: '169.254.169.254' },
		],
		[
			'context_web_extract',
			{ mode: 'screenshot', domain: '127.0.0.1' },
		],
		['context_styleguide', { domain: '10.0.0.4' }],
		[
			'context_brand_intel',
			{ lookup_type: 'domain', value: '[ff02::1]' },
		],
		[
			'context_brand_intel',
			{ lookup_type: 'simplified_domain', value: 'localhost' },
		],
		['context_classify', { taxonomy: 'naics', domain: '[fec0::1]' }],
		[
			'context_classify',
			{ taxonomy: 'eic', domain: 'service.internal' },
		],
	])(
		'rejects non-public domain targets for %s before networking',
		async (name, args) => {
			fetch_mock.mockImplementation(
				async () => new Response('{"success":true}'),
			);
			const { server, tools } = create_server();
			initialize_context_dev();
			register_context_dev_tools(server as any);
			const result = await tools
				.find((tool) => tool.definition.name === name)!
				.handler(args);
			expect(result.isError).toBe(true);
			expect(fetch_mock).not.toHaveBeenCalled();
		},
	);

	it.each([
		{ success: false, error: 'fixture failure' },
		{ ok: false },
		{ status: 'error', message: 'fixture failure' },
		{ status: 'failed' },
	])(
		'marks declared Context failures as MCP tool errors',
		async (body) => {
			fetch_mock.mockResolvedValue(
				new Response(JSON.stringify(body)),
			);
			const { server, tools } = create_server();
			initialize_context_dev();
			register_context_dev_tools(server as any);
			const result = await tools[0].handler({
				mode: 'markdown',
				url: 'https://example.com',
			});
			expect(result.isError).toBe(true);
		},
	);

	it.each([
		[
			'context_web_extract',
			{ mode: 'crawl_markdown', url: 'https://example.com' },
			'limit',
			[0, -1, 1.5, 101, 1e12],
		],
		[
			'context_web_extract',
			{ mode: 'markdown', url: 'https://example.com' },
			'timeoutMS',
			[0, -1, 1.5, 60001, 1e12],
		],
		[
			'context_brand_intel',
			{ lookup_type: 'domain', value: 'example.com' },
			'timeoutMS',
			[-1, 60001],
		],
		[
			'context_styleguide',
			{ domain: 'example.com' },
			'timeoutMS',
			[-1, 60001],
		],
		[
			'context_classify',
			{ taxonomy: 'naics', domain: 'example.com' },
			'minResults',
			[0, 1.5, 21, 1e12],
		],
		[
			'context_classify',
			{ taxonomy: 'sic', domain: 'example.com' },
			'maxResults',
			[0, 1.5, 21, 1e12],
		],
		[
			'context_transaction_identify',
			{ transaction_info: 'fixture' },
			'timeoutMS',
			[-1, 60001],
		],
	])(
		'bounds %s %s %s in its public schema',
		(name, args, field, values) => {
			const { server, tools } = create_server();
			initialize_context_dev();
			register_context_dev_tools(server as any);
			const tool = tools.find(
				(item) => item.definition.name === name,
			)!;
			for (const value of values as number[]) {
				expect(
					v.safeParse(tool.definition.schema, {
						...(args as object),
						[field as string]: value,
					}).success,
					`${field}:${value}`,
				).toBe(false);
			}
		},
	);

	it('applies explicit bounded defaults to Context crawl requests', async () => {
		fetch_mock.mockResolvedValue(new Response('{"success":true}'));
		const { server, tools } = create_server();
		initialize_context_dev();
		register_context_dev_tools(server as any);
		const tool = tools[0];
		const args = v.parse(tool.definition.schema, {
			mode: 'crawl_markdown',
			url: 'https://example.com',
		});
		await tool.handler(args);
		const body = JSON.parse(fetch_mock.mock.calls[0][1].body);
		expect(body).toMatchObject({ maxPages: 10, timeoutMS: 60000 });
	});

	it.each([
		{ minResults: 6, maxResults: 5 },
		{ minResults: 20, maxResults: 1 },
	])(
		'rejects contradictory classification ranges before networking',
		async (range) => {
			fetch_mock.mockResolvedValue(new Response('{"success":true}'));
			const { server, tools } = create_server();
			initialize_context_dev();
			register_context_dev_tools(server as any);
			const tool = tools.find(
				(item) => item.definition.name === 'context_classify',
			)!;
			const result = await tool.handler({
				taxonomy: 'naics',
				domain: 'example.com',
				...range,
			});
			expect(result.isError).toBe(true);
			expect(fetch_mock).not.toHaveBeenCalled();
		},
	);

	it('defaults classification to a bounded result range', async () => {
		fetch_mock.mockResolvedValue(new Response('{"success":true}'));
		const { server, tools } = create_server();
		initialize_context_dev();
		register_context_dev_tools(server as any);
		const tool = tools.find(
			(item) => item.definition.name === 'context_classify',
		)!;
		await tool.handler(
			v.parse(tool.definition.schema, {
				taxonomy: 'naics',
				domain: 'example.com',
			}),
		);
		const params = new URL(fetch_mock.mock.calls[0][0]).searchParams;
		expect(params.get('minResults')).toBe('1');
		expect(params.get('maxResults')).toBe('20');
	});

	it('rejects private scrape targets before calling Context.dev', async () => {
		const { server, tools } = create_server();
		initialize_context_dev();
		register_context_dev_tools(server as any);
		const tool = tools.find(
			(candidate) =>
				candidate.definition.name === 'context_web_extract',
		)!;

		const response = await tool.handler({
			mode: 'markdown',
			url: 'http://127.0.0.1/admin',
		});

		expect(response.isError).toBe(true);
		expect(response.content[0].text).toContain(
			'Invalid URL provided',
		);
		expect(fetch_mock).not.toHaveBeenCalled();
	});

	it('rejects private direct styleguide URLs before calling Context.dev', async () => {
		const { server, tools } = create_server();
		initialize_context_dev();
		register_context_dev_tools(server as any);
		const tool = tools.find(
			(candidate) =>
				candidate.definition.name === 'context_styleguide',
		)!;

		const response = await tool.handler({
			directUrl: 'http://10.0.0.4',
		});

		expect(response.isError).toBe(true);
		expect(response.content[0].text).toContain(
			'Invalid URL provided',
		);
		expect(fetch_mock).not.toHaveBeenCalled();
	});
});

describe('Context.dev provider health key', () => {
	const settings = Object.values(config).flatMap(Object.values);
	const keys = settings.map((item) => item.api_key);
	let sequence = 0;

	beforeEach(() => {
		fetch_mock.mockReset();
		vi.stubGlobal('fetch', fetch_mock);
		vi.spyOn(console, 'error').mockImplementation(() => {});
		vi.spyOn(console, 'warn').mockImplementation(() => {});
		for (const item of settings) item.api_key = undefined;
		config.search.context_dev.api_key = 'ctx-test-key';
		reset_provider_health();
	});

	afterEach(() => {
		settings.forEach((item, i) => {
			item.api_key = keys[i];
		});
		reset_provider_health();
		vi.unstubAllGlobals();
		vi.restoreAllMocks();
	});

	it('tracks every Context.dev tool under the one context_dev provider, like other providers', async () => {
		expect(initialize_context_dev()).toBe(true);
		expect(get_available()).toEqual(['context_dev']);
		const server = create_mcp_server({
			name: 'context-health-offline',
			version: '1',
		});
		const call = async (
			name: string,
			args: Record<string, unknown>,
		) =>
			(await server.receive(
				{
					jsonrpc: '2.0',
					id: ++sequence,
					method: 'tools/call',
					params: { name, arguments: args },
				},
				{} as any,
			)) as any;
		fetch_mock.mockResolvedValue(
			new Response('{}', {
				status: 429,
				headers: { 'Retry-After': '120' },
			}),
		);
		const limited = await call('context_brand_intel', {
			lookup_type: 'domain',
			value: 'example.com',
		});
		expect(limited.result.isError).toBe(true);
		const attempts = fetch_mock.mock.calls.length;

		// The sibling tool shares the credential, so it shares the
		// health state and the cooldown that followed the rate limit.
		const refused = await call('context_classify', {
			taxonomy: 'naics',
			domain: 'example.com',
		});
		expect(refused.result.isError).toBe(true);
		expect(refused.result.content[0].text).toContain(
			'Provider context_dev is cooling down after HTTP 429',
		);
		expect(fetch_mock).toHaveBeenCalledTimes(attempts);

		const health = get_provider_health_snapshot().processing;
		expect(Object.keys(health)).toEqual(['context_dev']);
		expect(health.context_dev).toMatchObject({
			registered: true,
			last_runtime_status: 'provider_error',
			last_error_kind: 'rate_limit',
			cooldown_status: 429,
		});
		expect(
			get_provider_metrics_snapshot().providers[
				'processing:context_dev'
			],
		).toMatchObject({
			calls: 2,
			failed: 2,
			errors_by_kind: { rate_limit: 1, provider_cooldown: 1 },
		});
		expect(
			get_provider_metrics_snapshot().tools.context_classify,
		).toMatchObject({ calls: 1, failed: 1 });

		const status = JSON.parse(
			(
				await server.receive(
					{
						jsonrpc: '2.0',
						id: ++sequence,
						method: 'resources/read',
						params: { uri: 'retriever://providers/status' },
					},
					{} as any,
				)
			).result.contents[0].text,
		);
		expect(status.providers.processing).toEqual(['context_dev']);
		expect(
			status.provider_health.processing.context_dev,
		).toMatchObject({ cooldown_status: 429 });
		expect(JSON.stringify(status)).not.toContain('ctx-test-key');
	});
});
