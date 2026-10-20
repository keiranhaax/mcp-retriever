import { McpServer } from 'tmcp';
import type { GenericSchema } from 'valibot';
import * as v from 'valibot';
import { presentation_schema } from '../../common/presentation.js';
import { input_error } from '../../common/errors.js';
import { ErrorType, ProviderError } from '../../common/types.js';
import { validate_processing_urls } from '../../common/validation.js';
import { define_presented_tool } from './define_tool.js';
import { get_extract_provider } from './web_extract.js';

const read_modes = {
	tavily: 'extract',
	exa: 'contents',
	firecrawl: 'scrape',
	context: 'highlights',
} as const;
const url_schema = v.pipe(
	v.string(),
	v.minLength(1),
	v.maxLength(4096),
	v.description('Public HTTP(S) URL without credentials.'),
);

export const register_web_read = (
	server: McpServer<GenericSchema>,
) => {
	const available = (
		Object.keys(read_modes) as Array<keyof typeof read_modes>
	).filter((provider) =>
		get_extract_provider(provider, read_modes[provider]),
	);
	if (!available.length) return;
	define_presented_tool(
		server,
		{
			name: 'web_read',
			description:
				'Read 1-20 public URLs with basic Tavily extraction, Exa contents, Firecrawl scraping, or Context.dev query highlights (query required). Returns source evidence, not synthesis. No crawl, actions, or advanced provider options.',
			annotations: {
				readOnlyHint: true,
				destructiveHint: false,
				idempotentHint: true,
				openWorldHint: true,
			},
			category: 'processing',
			provider: (input) => input.provider,
			schema: v.strictObject({
				...presentation_schema.entries,
				provider: v.picklist(available),
				query: v.optional(
					v.pipe(
						v.string(),
						v.minLength(1),
						v.maxLength(10000),
						v.description(
							'Query for local evidence passages and Tavily chunk reranking. Required for provider=context (Context.dev highlights).',
						),
					),
				),
				chunks_per_source: v.optional(
					v.pipe(
						v.number(),
						v.integer(),
						v.minValue(1),
						v.maxValue(5),
						v.description('Tavily only; requires a non-empty query.'),
					),
				),
				format: v.optional(
					v.pipe(
						v.picklist(['markdown', 'text']),
						v.description('Tavily only; defaults to markdown.'),
					),
				),
				url: v.union([
					url_schema,
					v.pipe(
						v.array(url_schema),
						v.minLength(1),
						v.maxLength(20),
					),
				]),
			}),
		},
		async ({ provider, url, query, chunks_per_source, format }) => {
			if (
				provider !== 'tavily' &&
				(chunks_per_source !== undefined || format !== undefined)
			)
				throw new ProviderError(
					ErrorType.INVALID_INPUT,
					'Tavily extraction controls require provider=tavily',
					'web_read',
					{ retryable: false },
				);
			if (
				(query !== undefined && !query.trim()) ||
				(chunks_per_source !== undefined && !query?.trim())
			)
				throw input_error(
					'A non-empty query is required when supplied or using chunks_per_source',
					'web_read',
				);
			if (provider === 'context' && !query?.trim())
				throw input_error(
					'A non-empty query is required for provider=context highlights',
					'web_read',
				);
			validate_processing_urls(url, 'web_read');
			const operation = read_modes[provider];
			const selected = get_extract_provider(provider, operation);
			if (!selected)
				throw input_error(
					'Selected read provider is not available',
					'web_read',
				);
			const result = await selected.process_content(
				url,
				'basic',
				provider === 'tavily'
					? { query, chunks_per_source, format }
					: provider === 'context'
						? { query }
						: undefined,
			);
			return { result, operation, urls: url, query };
		},
	);
};

const register_site_tool = (
	server: McpServer<GenericSchema>,
	operation: 'crawl' | 'map',
) => {
	const selected = get_extract_provider('firecrawl', operation);
	if (!selected) return;
	define_presented_tool(
		server,
		{
			name: `web_${operation}`,
			description:
				operation === 'crawl'
					? 'Start an expensive Firecrawl crawl from one public URL and wait for page content. Basic: up to 20 pages; advanced: up to 50. Creates a paid job; do not repeat this tool call to retry an existing job.'
					: 'Discover URLs using Firecrawl without reading page content. One public starting URL; basic returns up to 50 links, advanced up to 200. Use web_read to read selected URLs.',
			annotations: {
				readOnlyHint: operation === 'map',
				destructiveHint: false,
				idempotentHint: operation === 'map',
				openWorldHint: true,
			},
			category: 'processing',
			provider: 'firecrawl',
			schema: v.strictObject({
				...presentation_schema.entries,
				url: url_schema,
				extract_depth: v.optional(
					v.pipe(
						v.picklist(['basic', 'advanced']),
						v.description('Extraction depth; defaults to basic.'),
					),
				),
			}),
		},
		async ({ url, extract_depth }) => {
			validate_processing_urls(url, `web_${operation}`);
			const result = await selected.process_content(
				url,
				extract_depth,
			);
			return { result, operation, urls: url };
		},
	);
};

export const register_web_crawl = (
	server: McpServer<GenericSchema>,
) => register_site_tool(server, 'crawl');

export const register_web_map = (server: McpServer<GenericSchema>) =>
	register_site_tool(server, 'map');
