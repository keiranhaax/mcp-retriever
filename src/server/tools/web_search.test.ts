import {
	afterEach,
	beforeEach,
	describe,
	expect,
	it,
	vi,
} from 'vitest';
import { ValibotJsonSchemaAdapter } from '@tmcp/adapter-valibot';
import * as v from 'valibot';
import { config } from '../../config/env.js';
import {
	get_available_providers,
	initialize_web_search,
	register_web_search,
} from './web_search.js';

const original_keys = {
	tavily: config.search.tavily.api_key,
	exa: config.search.exa.api_key,
};
afterEach(() => {
	config.search.tavily.api_key = original_keys.tavily;
	config.search.exa.api_key = original_keys.exa;
	initialize_web_search();
});

describe('web_search provider-aware limits', () => {
	it('keeps discovery convertible and rejects excessive Tavily limits before networking', async () => {
		config.search.tavily.api_key = 'tavily-test-key';
		config.search.exa.api_key = 'exa-test-key';
		initialize_web_search();
		let schema: v.GenericSchema;
		let handler: (input: any) => Promise<any>;
		register_web_search({
			tool: (
				definition: { schema: v.GenericSchema },
				callback: typeof handler,
			) => {
				schema = definition.schema;
				handler = callback;
			},
		} as any);
		await expect(
			new ValibotJsonSchemaAdapter().toJsonSchema(schema!),
		).resolves.toMatchObject({ type: 'object' });
		expect(
			v.safeParse(schema!, {
				query: 'test',
				provider: 'tavily',
				limit: 20,
			}).success,
		).toBe(true);
		await expect(
			handler!({ query: 'test', provider: 'tavily', limit: 21 }),
		).resolves.toMatchObject({
			isError: true,
			content: [{ text: expect.stringContaining('at most 20') }],
		});
		expect(
			v.safeParse(schema!, {
				query: 'test',
				provider: 'exa',
				limit: 100,
			}).success,
		).toBe(true);
	});
});

describe('web_search Context.dev', () => {
	const fetch_mock = vi.fn();
	const search_keys = [
		'tavily',
		'brave',
		'exa',
		'you',
		'context_dev',
	] as const;
	const saved = Object.fromEntries(
		search_keys.map((key) => [key, config.search[key].api_key]),
	);

	const register = () => {
		let schema: v.GenericSchema;
		let handler: (input: any) => Promise<any>;
		initialize_web_search();
		register_web_search({
			tool: (
				definition: { schema: v.GenericSchema },
				callback: typeof handler,
			) => {
				schema = definition.schema;
				handler = callback;
			},
		} as any);
		return { schema: schema!, handler: handler! };
	};

	beforeEach(() => {
		fetch_mock.mockReset();
		vi.stubGlobal('fetch', fetch_mock);
		for (const key of search_keys)
			config.search[key].api_key = undefined;
		config.search.context_dev.api_key = 'context-test-key';
	});

	afterEach(() => {
		for (const key of search_keys)
			config.search[key].api_key = saved[key];
		initialize_web_search();
		vi.unstubAllGlobals();
		vi.restoreAllMocks();
	});

	it('registers context only when a Context.dev key is configured', () => {
		initialize_web_search();
		expect(get_available_providers()).toEqual(['context']);

		config.search.context_dev.api_key = undefined;
		expect(initialize_web_search()).toBe(false);
		expect(get_available_providers()).toEqual([]);
	});

	it('lists context beside other configured providers', async () => {
		config.search.exa.api_key = 'exa-test-key';
		const { schema } = register();
		expect(get_available_providers()).toEqual(['exa', 'context']);
		for (const provider of ['exa', 'context'])
			expect(
				v.safeParse(schema, { query: 'test', provider }).success,
			).toBe(true);
		expect(
			v.safeParse(schema, { query: 'test', provider: 'you' }).success,
		).toBe(false);
		await expect(
			new ValibotJsonSchemaAdapter().toJsonSchema(schema),
		).resolves.toMatchObject({ type: 'object' });
	});

	it('accepts limits up to 100 for context', () => {
		const { schema } = register();
		for (const [limit, accepted] of [
			[100, true],
			[101, false],
		] as const)
			expect(
				v.safeParse(schema, {
					query: 'test',
					provider: 'context',
					limit,
				}).success,
			).toBe(accepted);
	});

	it('dispatches a context search with filters and returns highlight snippets', async () => {
		fetch_mock.mockResolvedValue(
			new Response(
				JSON.stringify({
					results: [
						{
							url: 'https://example.com/a',
							title: 'Example A',
							description: 'Plain description',
							relevance: 'high',
							highlights: {
								code: 'SUCCESS',
								highlights: ['First passage.'],
							},
						},
					],
				}),
			),
		);
		const { handler } = register();
		const response = await handler({
			query: 'example query',
			provider: 'context',
			limit: 3,
			include_domains: ['example.com'],
			exclude_domains: ['example.org'],
		});

		expect(response.isError).toBeUndefined();
		expect(response.content[0].text).toContain('First passage.');
		expect(response.content[0].text).not.toContain(
			'context-test-key',
		);
		expect(fetch_mock).toHaveBeenCalledTimes(1);
		const [target, init] = fetch_mock.mock.calls[0];
		expect(target).toBe('https://api.context.dev/v1/web/search');
		expect(JSON.parse(init.body)).toEqual({
			query: 'example query',
			numResults: 3,
			includeDomains: ['example.com'],
			excludeDomains: ['example.org'],
			highlightsOptions: { enabled: true, maxCharacters: 1500 },
		});
	});

	it('keeps Tavily-only controls Tavily-only', async () => {
		const { handler } = register();
		const response = await handler({
			query: 'test',
			provider: 'context',
			time_range: 'week',
		});

		expect(response.isError).toBe(true);
		expect(response.content[0].text).toContain(
			'Tavily search controls require provider=tavily',
		);
		expect(fetch_mock).not.toHaveBeenCalled();
	});

	it('rejects a context query over 500 characters before networking', async () => {
		const { handler } = register();
		const response = await handler({
			query: 'q'.repeat(501),
			provider: 'context',
		});

		expect(response.isError).toBe(true);
		expect(response.content[0].text).toContain('1-500 characters');
		expect(fetch_mock).not.toHaveBeenCalled();
	});
});
