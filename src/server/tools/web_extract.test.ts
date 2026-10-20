import {
	afterEach,
	beforeEach,
	describe,
	expect,
	it,
	vi,
} from 'vitest';
import * as v from 'valibot';
import { ValibotJsonSchemaAdapter } from '@tmcp/adapter-valibot';
import { FirecrawlMapProvider } from '../../providers/processing/firecrawl_map/index.js';
import { ContextHighlightsProvider } from '../../providers/processing/context_highlights/index.js';
import { ExaSimilarProvider } from '../../providers/processing/exa_similar/index.js';
import { TavilyExtractProvider } from '../../providers/processing/tavily_extract/index.js';
import { config } from '../../config/env.js';
import {
	get_available_providers,
	initialize_web_extract,
	register_web_extract,
} from './web_extract.js';

const fetch_mock = vi.fn();

const previous_keys = {
	firecrawl: config.processing.firecrawl_scrape.api_key,
	tavily: config.processing.tavily_extract.api_key,
	exa: config.processing.exa_contents.api_key,
	exa_similar: config.processing.exa_similar.api_key,
	context: config.processing.context_highlights.api_key,
};

const create_server = () => {
	const tools: Array<{ definition: any; handler: any }> = [];
	return {
		tools,
		server: {
			tool: (definition: any, handler: any) => {
				tools.push({ definition, handler });
			},
		},
	};
};

const get_provider_options = (schema: any): string[] =>
	schema.entries.provider.options as string[];

const get_mode_options = (schema: any): string[] =>
	schema.entries.mode.wrapped.options as string[];

const get_description = (schema_node: any): string => {
	if (!schema_node) return '';
	if (typeof schema_node.description === 'string') {
		return schema_node.description;
	}
	const pipe = schema_node.pipe || schema_node.wrapped?.pipe;
	if (Array.isArray(pipe)) {
		const desc = pipe.find(
			(item: any) =>
				item?.type === 'description' ||
				typeof item?.description === 'string',
		);
		if (desc?.description) return desc.description;
	}
	if (schema_node.wrapped) {
		return get_description(schema_node.wrapped);
	}
	return '';
};

describe('web_extract Firecrawl summarize', () => {
	beforeEach(() => {
		fetch_mock.mockReset();
		vi.stubGlobal('fetch', fetch_mock);
		config.processing.firecrawl_scrape.api_key = 'fc-test-key';
		config.processing.tavily_extract.api_key = undefined;
		config.processing.exa_contents.api_key = undefined;
		config.processing.exa_similar.api_key = undefined;
		config.processing.context_highlights.api_key = undefined;
	});

	afterEach(() => {
		config.processing.firecrawl_scrape.api_key =
			previous_keys.firecrawl;
		config.processing.tavily_extract.api_key = previous_keys.tavily;
		config.processing.exa_contents.api_key = previous_keys.exa;
		config.processing.exa_similar.api_key = previous_keys.exa_similar;
		config.processing.context_highlights.api_key =
			previous_keys.context;
		vi.unstubAllGlobals();
		vi.restoreAllMocks();
	});

	it.each(['firecrawl', 'exa'])(
		'rejects multiple single-target inputs before %s dispatch',
		async (provider) => {
			config.processing.exa_contents.api_key = 'exa-test-key';
			const process = vi.spyOn(
				provider === 'exa'
					? ExaSimilarProvider.prototype
					: FirecrawlMapProvider.prototype,
				'process_content',
			);
			const { server, tools } = create_server();
			initialize_web_extract();
			register_web_extract(server as any);
			const response = await tools[0].handler({
				provider,
				mode: provider === 'exa' ? 'similar' : 'map',
				url: ['https://example.com/a', 'https://example.com/b'],
			});
			expect(response.isError).toBe(true);
			expect(process).not.toHaveBeenCalled();
			expect(fetch_mock).not.toHaveBeenCalled();
		},
	);

	it('forwards the Tavily reranking query through provider options', async () => {
		config.processing.tavily_extract.api_key = 'tvly-test-key';
		const process = vi
			.spyOn(TavilyExtractProvider.prototype, 'process_content')
			.mockResolvedValue({
				content: 'chunks',
				metadata: {},
				source_provider: 'tavily_extract',
			});
		const { server, tools } = create_server();
		initialize_web_extract();
		register_web_extract(server as any);
		await tools[0].handler({
			provider: 'tavily',
			url: 'https://example.test',
			query: 'pricing details',
		});
		expect(process).toHaveBeenCalledWith(
			'https://example.test',
			undefined,
			{ query: 'pricing details' },
		);
	});

	it('advertises only supported Firecrawl formats with a convertible schema', async () => {
		const { server, tools } = create_server();
		initialize_web_extract();
		register_web_extract(server as any);
		const schema = tools[0].definition.schema;
		expect(
			v.safeParse(schema, {
				provider: 'firecrawl',
				url: 'https://example.test',
				firecrawl_options: { formats: ['unsupported-format'] },
			}).success,
		).toBe(false);
		expect(
			(await new ValibotJsonSchemaAdapter().toJsonSchema(schema))
				.type,
		).toBe('object');
	});

	it('registers firecrawl:summarize with only configured providers', () => {
		const { server, tools } = create_server();

		expect(initialize_web_extract()).toBe(true);
		register_web_extract(server as any);

		expect(get_available_providers()).toEqual(['firecrawl']);

		const tool = tools.find(
			(item) => item.definition.name === 'web_extract',
		)!;
		expect(tool.definition.annotations).toMatchObject({
			readOnlyHint: false,
			destructiveHint: false,
			idempotentHint: false,
			openWorldHint: true,
		});
		const providers = get_provider_options(tool.definition.schema);
		const modes = get_mode_options(tool.definition.schema);
		const mode_description = get_description(
			tool.definition.schema.entries.mode,
		);

		expect(providers).toEqual(['firecrawl']);
		expect(modes).toContain('summarize');
		expect(mode_description).toContain('summarize');
	});

	it('routes mode=summarize through Firecrawl scrape with formats:["summary"] and returns data.summary', async () => {
		fetch_mock.mockResolvedValue(
			new Response(
				JSON.stringify({
					success: true,
					data: {
						summary: 'Concise page summary from Firecrawl v2.',
						metadata: { title: 'Example Article' },
					},
				}),
				{
					status: 200,
					headers: { 'Content-Type': 'application/json' },
				},
			),
		);

		const { server, tools } = create_server();
		initialize_web_extract();
		register_web_extract(server as any);

		const tool = tools.find(
			(item) => item.definition.name === 'web_extract',
		)!;
		const response = await tool.handler({
			url: 'https://example.com/long-article',
			provider: 'firecrawl',
			mode: 'summarize',
		});

		expect(response.isError).toBeUndefined();
		const body = JSON.parse(fetch_mock.mock.calls[0][1].body);
		expect(body).toMatchObject({
			url: 'https://example.com/long-article',
			formats: ['summary'],
		});

		const result = JSON.parse(response.content[0].text);
		expect(result.content).toBe(
			'Concise page summary from Firecrawl v2.',
		);
		expect(result.metadata).toMatchObject({
			title: 'Example Article',
			successful_extractions: 1,
		});
	});
});

describe('web_extract Firecrawl actions screenshot', () => {
	beforeEach(() => {
		fetch_mock.mockReset();
		vi.stubGlobal('fetch', fetch_mock);
		config.processing.firecrawl_scrape.api_key = 'fc-test-key';
		config.processing.firecrawl_actions.api_key = 'fc-test-key';
		config.processing.tavily_extract.api_key = 'tvly-test-key';
		config.processing.exa_contents.api_key = undefined;
		config.processing.exa_similar.api_key = undefined;
		config.processing.context_highlights.api_key = undefined;
	});

	afterEach(() => {
		config.processing.firecrawl_scrape.api_key =
			previous_keys.firecrawl;
		config.processing.firecrawl_actions.api_key =
			previous_keys.firecrawl;
		config.processing.tavily_extract.api_key = previous_keys.tavily;
		config.processing.exa_contents.api_key = previous_keys.exa;
		config.processing.exa_similar.api_key = previous_keys.exa_similar;
		config.processing.context_highlights.api_key =
			previous_keys.context;
		vi.unstubAllGlobals();
		vi.restoreAllMocks();
	});

	const registered = () => {
		const { server, tools } = create_server();
		initialize_web_extract();
		register_web_extract(server as any);
		return tools[0];
	};

	it.each([
		{ screenshot: undefined, formats: ['markdown'] },
		{ screenshot: false, formats: ['markdown'] },
		{ screenshot: true, formats: ['markdown', 'screenshot'] },
	])(
		'requests a screenshot only when asked: $screenshot',
		async ({ screenshot, formats }) => {
			fetch_mock.mockResolvedValue(
				new Response(
					JSON.stringify({
						success: true,
						data: {
							markdown: 'Loaded content',
							...(screenshot
								? { screenshot: 'data:image/png;base64,AAAA' }
								: {}),
						},
					}),
				),
			);
			const tool = registered();
			expect(
				v.safeParse(tool.definition.schema, {
					provider: 'firecrawl',
					mode: 'actions',
					url: 'https://example.com/app',
					...(screenshot === undefined ? {} : { screenshot }),
				}).success,
			).toBe(true);
			const response = await tool.handler({
				provider: 'firecrawl',
				mode: 'actions',
				url: 'https://example.com/app',
				...(screenshot === undefined ? {} : { screenshot }),
			});
			expect(response.isError).toBeUndefined();
			const body = JSON.parse(fetch_mock.mock.calls[0][1].body);
			expect(body.formats).toEqual(formats);
			const result = JSON.parse(response.content[0].text);
			expect(result.metadata.screenshot).toBe(
				screenshot ? 'data:image/png;base64,AAAA' : undefined,
			);
		},
	);

	it.each([
		{ provider: 'firecrawl', mode: 'scrape' },
		{ provider: 'tavily', mode: 'extract' },
	])(
		'rejects screenshot for $provider $mode before networking',
		async ({ provider, mode }) => {
			const tool = registered();
			const response = await tool.handler({
				provider,
				mode,
				url: 'https://example.com/app',
				screenshot: true,
			});
			expect(response.isError).toBe(true);
			expect(response.content[0].text).toContain(
				'screenshot can only be used with provider=firecrawl and mode=actions',
			);
			expect(fetch_mock).not.toHaveBeenCalled();
		},
	);
});

describe('web_extract Context.dev', () => {
	const url = 'https://example.test/pricing';

	beforeEach(() => {
		fetch_mock.mockReset();
		vi.stubGlobal('fetch', fetch_mock);
		config.processing.firecrawl_scrape.api_key = undefined;
		config.processing.tavily_extract.api_key = 'tvly-test-key';
		config.processing.exa_contents.api_key = undefined;
		config.processing.exa_similar.api_key = undefined;
		config.processing.context_highlights.api_key = 'ctx-test-key';
	});

	afterEach(() => {
		config.processing.firecrawl_scrape.api_key =
			previous_keys.firecrawl;
		config.processing.tavily_extract.api_key = previous_keys.tavily;
		config.processing.exa_contents.api_key = previous_keys.exa;
		config.processing.exa_similar.api_key = previous_keys.exa_similar;
		config.processing.context_highlights.api_key =
			previous_keys.context;
		vi.unstubAllGlobals();
		vi.restoreAllMocks();
	});

	const registered = () => {
		const { server, tools } = create_server();
		initialize_web_extract();
		register_web_extract(server as any);
		return tools[0];
	};
	const respond_scrape = () =>
		fetch_mock.mockImplementation(async (_target, init) => {
			const body = JSON.parse(init.body);
			return Response.json({
				highlights: body.formats.highlights
					? {
							requested: true,
							success: true,
							data: [`Passage for ${body.url}`],
						}
					: { requested: false, success: null, data: null },
				markdown: body.formats.markdown
					? {
							requested: true,
							success: true,
							data: `# Page ${body.url}`,
						}
					: { requested: false, success: null, data: null },
				metadata: { title: 'Pricing' },
			});
		});

	it('registers context highlights and markdown only with a Context.dev key', () => {
		config.processing.context_highlights.api_key = undefined;
		expect(initialize_web_extract()).toBe(true);
		expect(get_available_providers()).toEqual(['tavily']);

		config.processing.context_highlights.api_key = 'ctx-test-key';
		const tool = registered();
		expect(get_available_providers()).toEqual(['tavily', 'context']);
		expect(get_provider_options(tool.definition.schema)).toEqual([
			'tavily',
			'context',
		]);
		const modes = get_mode_options(tool.definition.schema);
		expect(modes).toContain('highlights');
		expect(modes).toContain('markdown');
		expect(
			get_description(tool.definition.schema.entries.mode),
		).toContain('context supports highlights');
		expect(
			get_description(tool.definition.schema.entries.query),
		).toContain('Context.dev');
		expect(
			v.safeParse(tool.definition.schema, {
				provider: 'context',
				mode: 'highlights',
				url,
				query: 'pricing',
			}).success,
		).toBe(true);
	});

	it('forwards the query to Context.dev highlights as the relevance query', async () => {
		const process = vi
			.spyOn(ContextHighlightsProvider.prototype, 'process_content')
			.mockResolvedValue({
				content: 'passages',
				metadata: {},
				source_provider: 'context_highlights',
			});
		await registered().handler({
			provider: 'context',
			url,
			query: 'pricing details',
		});
		expect(process).toHaveBeenCalledWith(url, undefined, {
			query: 'pricing details',
		});
	});

	it('defaults to highlights and sends the documented scrape body', async () => {
		respond_scrape();
		const response = await registered().handler({
			provider: 'context',
			url: [url, 'https://example.test/docs'],
			query: 'pricing',
		});

		expect(response.isError).toBeUndefined();
		const [target, init] = fetch_mock.mock.calls[0];
		expect(target).toBe('https://api.context.dev/v1/web/scrape');
		expect(init.headers.Authorization).toBe('Bearer ctx-test-key');
		expect(fetch_mock).toHaveBeenCalledTimes(2);
		expect(
			fetch_mock.mock.calls
				.map(([, call_init]) => JSON.parse(call_init.body))
				.sort((a, b) => a.url.localeCompare(b.url)),
		).toEqual([
			{
				url: 'https://example.test/docs',
				formats: { highlights: true },
				highlightsParams: { query: 'pricing', maxCharacters: 4000 },
			},
			{
				url,
				formats: { highlights: true },
				highlightsParams: { query: 'pricing', maxCharacters: 4000 },
			},
		]);
		const result = JSON.parse(response.content[0].text);
		expect(result.source_provider).toBe('context_highlights');
		expect(result.raw_contents).toEqual([
			{ url, content: `Passage for ${url}` },
			{
				url: 'https://example.test/docs',
				content: 'Passage for https://example.test/docs',
			},
		]);
		expect(result.metadata.mode).toBe('highlights');
	});

	it('reads plain markdown without a query in markdown mode', async () => {
		respond_scrape();
		const response = await registered().handler({
			provider: 'context',
			mode: 'markdown',
			url,
		});

		expect(response.isError).toBeUndefined();
		expect(JSON.parse(fetch_mock.mock.calls[0][1].body)).toEqual({
			url,
			formats: { markdown: true },
		});
		expect(JSON.parse(response.content[0].text).content).toBe(
			`# Page ${url}`,
		);
	});

	it.each([undefined, '   '])(
		'requires a relevance query for highlights before networking: %j',
		async (query) => {
			respond_scrape();
			const response = await registered().handler({
				provider: 'context',
				mode: 'highlights',
				url,
				...(query === undefined ? {} : { query }),
			});

			expect(response.isError).toBe(true);
			expect(response.content[0].text).toContain(
				'A query is required for Context.dev highlights',
			);
			expect(fetch_mock).not.toHaveBeenCalled();
		},
	);

	it('rejects modes Context.dev does not support', async () => {
		respond_scrape();
		const response = await registered().handler({
			provider: 'context',
			mode: 'scrape',
			url,
			query: 'pricing',
		});

		expect(response.isError).toBe(true);
		expect(response.content[0].text).toContain(
			'Valid modes: highlights, markdown',
		);
		expect(fetch_mock).not.toHaveBeenCalled();
	});

	it.each([
		[{ chunks_per_source: 1 }, 'Tavily extraction controls'],
		[{ format: 'text' }, 'Tavily extraction controls'],
		[
			{ archive_fallback: true },
			'archive_fallback is only supported',
		],
		[
			{ firecrawl_options: { question: 'why?' } },
			'firecrawl_options can only be used',
		],
		[{ screenshot: true }, 'screenshot can only be used'],
	])(
		'rejects provider-specific controls for context before networking: %j',
		async (controls, message) => {
			respond_scrape();
			const response = await registered().handler({
				provider: 'context',
				url,
				query: 'pricing',
				...controls,
			});

			expect(response.isError).toBe(true);
			expect(response.content[0].text).toContain(message);
			expect(fetch_mock).not.toHaveBeenCalled();
		},
	);

	it('rejects unsafe URLs before networking', async () => {
		respond_scrape();
		const response = await registered().handler({
			provider: 'context',
			url: 'http://169.254.169.254/latest',
			query: 'pricing',
		});

		expect(response.isError).toBe(true);
		expect(fetch_mock).not.toHaveBeenCalled();
	});
});
