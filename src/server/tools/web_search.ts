import { McpServer } from 'tmcp';
import type { GenericSchema } from 'valibot';
import * as v from 'valibot';
import { presentation_schema } from '../../common/presentation.js';
import {
	ErrorType,
	ProviderError,
	SearchProvider,
} from '../../common/types.js';
import { input_error } from '../../common/errors.js';
import { is_api_key_valid } from '../../common/validation.js';
import { define_presented_tool } from './define_tool.js';
import { tool_descriptions } from './descriptions.js';

// Concrete provider imports
import { config } from '../../config/env.js';
import { BraveSearchProvider } from '../../providers/search/brave/index.js';
import { ContextSearchProvider } from '../../providers/search/context/index.js';
import { ExaSearchProvider } from '../../providers/search/exa/index.js';
import {
	TavilySearchProvider,
	tavily_search_controls_schema,
} from '../../providers/search/tavily/index.js';
import {
	SearxngSearchProvider,
	searxng_base_url,
} from '../../providers/search/searxng/index.js';
import { YouSearchProvider } from '../../providers/search/you/index.js';

export type WebSearchProviderName =
	| 'tavily'
	| 'brave'
	| 'exa'
	| 'you'
	| 'context'
	| 'searxng';

const providers = new Map<string, SearchProvider>();

export const initialize_web_search = (): boolean => {
	providers.clear();
	if (is_api_key_valid(config.search.tavily.api_key, 'tavily'))
		providers.set('tavily', new TavilySearchProvider());
	if (is_api_key_valid(config.search.brave.api_key, 'brave'))
		providers.set('brave', new BraveSearchProvider());
	if (is_api_key_valid(config.search.exa.api_key, 'exa'))
		providers.set('exa', new ExaSearchProvider());
	if (is_api_key_valid(config.search.you.api_key, 'you'))
		providers.set('you', new YouSearchProvider());
	if (is_api_key_valid(config.search.context_dev.api_key, 'context'))
		providers.set('context', new ContextSearchProvider());
	// Keyless and off by default: only an operator-set URL enables it.
	if (searxng_base_url())
		providers.set('searxng', new SearxngSearchProvider());

	return providers.size > 0;
};

export const get_search_provider = (name: string) =>
	providers.get(name);

export const get_available_providers = () =>
	Array.from(providers.keys());

export const register_web_search = (
	server: McpServer<GenericSchema>,
) => {
	if (providers.size === 0) return;

	const provider_names = Array.from(
		providers.keys(),
	) as WebSearchProviderName[];

	define_presented_tool(
		server,
		{
			name: 'web_search',
			description: tool_descriptions.web_search,
			annotations: {
				readOnlyHint: true,
				destructiveHint: false,
				idempotentHint: true,
				openWorldHint: true,
			},
			category: 'search',
			provider: (input) => input.provider,
			schema: v.object({
				...presentation_schema.entries,
				...tavily_search_controls_schema.entries,
				query: v.pipe(
					v.string(),
					v.minLength(1),
					v.maxLength(5000),
					v.description('Search query'),
				),
				provider: v.pipe(
					v.picklist(provider_names),
					v.description('Search provider to use'),
				),
				limit: v.optional(
					v.pipe(
						v.number(),
						v.integer(),
						v.minValue(1),
						v.maxValue(100),
						v.description(
							'Maximum results. Tavily max 20; Brave/You cap at 20; Exa and Context.dev max 100. Defaults are provider-specific.',
						),
					),
				),
				include_domains: v.optional(
					v.pipe(
						v.array(v.pipe(v.string(), v.maxLength(253))),
						v.maxLength(50),
						v.description('Only return results from these domains'),
					),
				),
				exclude_domains: v.optional(
					v.pipe(
						v.array(v.pipe(v.string(), v.maxLength(253))),
						v.maxLength(50),
						v.description('Exclude results from these domains'),
					),
				),
				search_type: v.optional(
					v.pipe(
						v.picklist([
							'instant',
							'fast',
							'auto',
							'lite',
							'deep-lite',
							'deep',
							'deep-reasoning',
						]),
						v.description(
							'Exa search type. Default auto. lite is cheapest and cache-only with a restricted parameter set; instant, fast and deep-reasoning are legacy. Only used when provider is exa.',
						),
					),
				),
				category: v.optional(
					v.pipe(
						v.picklist([
							'company',
							'people',
							'publication',
							'news',
							'personal site',
							'financial report',
						]),
						v.description(
							'Exa category filter. Only used when provider is exa.',
						),
					),
				),
				user_location: v.optional(
					v.pipe(
						v.string(),
						v.description(
							'Two-letter Exa user location country code, such as US.',
						),
					),
				),
				contents: v.optional(
					v.pipe(
						v.record(v.string(), v.any()),
						v.description(
							'Exa contents options. Only used when provider is exa.',
						),
					),
				),
				output_schema: v.optional(
					v.pipe(
						v.record(v.string(), v.any()),
						v.description(
							'Exa JSON output schema for synthesized output.',
						),
					),
				),
				system_prompt: v.optional(
					v.pipe(
						v.string(),
						v.maxLength(10000),
						v.description(
							'Exa system prompt for synthesized output.',
						),
					),
				),
				additional_queries: v.optional(
					v.pipe(
						v.array(v.pipe(v.string(), v.maxLength(2000))),
						v.maxLength(10),
						v.description(
							'Additional top-level Exa search queries for multi-query retrieval.',
						),
					),
				),
			}),
		},
		async ({
			query,
			provider,
			limit,
			include_domains,
			exclude_domains,
			search_type,
			category,
			user_location,
			contents,
			output_schema,
			system_prompt,
			additional_queries,
			search_depth,
			topic,
			time_range,
		}) => {
			if (
				provider !== 'tavily' &&
				[search_depth, topic, time_range].some(
					(value) => value !== undefined,
				)
			) {
				throw new ProviderError(
					ErrorType.INVALID_INPUT,
					'Tavily search controls require provider=tavily',
					'web_search',
					{ retryable: false },
				);
			}
			if (
				provider === 'tavily' &&
				limit !== undefined &&
				limit > 20
			) {
				throw new ProviderError(
					ErrorType.INVALID_INPUT,
					'Tavily supports at most 20 results',
					'tavily',
					{ retryable: false },
				);
			}
			const selected = providers.get(provider);
			if (!selected) {
				throw input_error(
					`Provider "${provider}" is not available. Available: ${Array.from(providers.keys()).join(', ')}`,
					'web_search',
				);
			}

			const results = await selected.search({
				query,
				limit,
				include_domains,
				exclude_domains,
				search_type,
				category,
				user_location,
				contents,
				output_schema,
				system_prompt,
				additional_queries,
				...(provider === 'tavily'
					? { search_depth, topic, time_range }
					: {}),
			});
			return { result: results, operation: 'search', query };
		},
	);
};
