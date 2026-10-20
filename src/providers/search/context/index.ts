import * as v from 'valibot';
import {
	input_error,
	sanitize_query,
} from '../../../common/errors.js';
import { provider_json_request } from '../../../common/provider_request.js';
import {
	BaseSearchParams,
	SearchProvider,
	SearchResult,
} from '../../../common/types.js';
import { validate_api_key } from '../../../common/validation.js';
import { config } from '../../../config/env.js';

const MAX_QUERY_CHARS = 500;
const DEFAULT_RESULTS = 10;
const HIGHLIGHT_MAX_CHARACTERS = 1500;

type ContextFreshness =
	| 'last_24_hours'
	| 'last_week'
	| 'last_month'
	| 'last_year';

interface ContextSearchRequest {
	query: string;
	numResults: number;
	includeDomains?: string[];
	excludeDomains?: string[];
	freshness?: ContextFreshness;
	highlightsOptions: { enabled: true; maxCharacters: number };
}

const FRESHNESS: Record<
	NonNullable<BaseSearchParams['time_range']>,
	ContextFreshness
> = {
	day: 'last_24_hours',
	week: 'last_week',
	month: 'last_month',
	year: 'last_year',
};

// Every field is optional or nullable: result shapes and per-page
// outcome codes change, and one odd entry must not drop the rest.
const context_search_response_schema = v.object({
	results: v.nullish(
		v.array(
			v.object({
				url: v.nullish(v.string()),
				title: v.nullish(v.string()),
				description: v.nullish(v.string()),
				relevance: v.nullish(v.string()),
				highlights: v.nullish(
					v.object({
						code: v.nullish(v.string()),
						highlights: v.nullish(v.array(v.unknown())),
					}),
				),
			}),
		),
	),
	partial: v.nullish(v.boolean()),
});

const build_search_body = (
	params: BaseSearchParams,
): ContextSearchRequest => {
	const query = sanitize_query(params.query);
	if (!query || query.length > MAX_QUERY_CHARS) {
		throw input_error(
			`Context.dev search requires a query of 1-${MAX_QUERY_CHARS} characters`,
			'context',
		);
	}
	const body: ContextSearchRequest = {
		query,
		numResults: params.limit ?? DEFAULT_RESULTS,
		highlightsOptions: {
			enabled: true,
			maxCharacters: HIGHLIGHT_MAX_CHARACTERS,
		},
	};
	if (params.include_domains?.length)
		body.includeDomains = params.include_domains;
	if (params.exclude_domains?.length)
		body.excludeDomains = params.exclude_domains;
	if (params.time_range)
		body.freshness = FRESHNESS[params.time_range];
	return body;
};

const passages = (value: unknown[] | null | undefined): string[] =>
	(value ?? []).filter(
		(item): item is string =>
			typeof item === 'string' && item.trim().length > 0,
	);

export class ContextSearchProvider implements SearchProvider {
	name = 'context';
	description =
		'Context.dev web search returning query-relevant page passages with each result. Supports domain filters and up to 100 results.';

	async search(params: BaseSearchParams): Promise<SearchResult[]> {
		const api_key = validate_api_key(
			config.search.context_dev.api_key,
			this.name,
		);

		return provider_json_request(
			this.name,
			{
				url: `${config.search.context_dev.base_url}/web/search`,
				method: 'POST',
				headers: {
					Authorization: `Bearer ${api_key}`,
					'Content-Type': 'application/json',
				},
				body: build_search_body(params),
				timeout_ms: config.search.context_dev.timeout,
				schema: context_search_response_schema,
				operation: 'fetch search results',
			},
			(data) =>
				(data.results ?? []).flatMap((result): SearchResult[] => {
					const url = result.url?.trim();
					if (!url) return [];
					const code = result.highlights?.code ?? undefined;
					const selected =
						code === 'SUCCESS'
							? passages(result.highlights?.highlights)
							: [];
					const description = result.description?.trim();
					return [
						{
							title: result.title?.trim() || url,
							url,
							snippet:
								selected.length > 0
									? selected.join('\n\n')
									: description || 'No content available',
							source_provider: this.name,
							metadata: {
								highlights_code: code,
								highlights_count: selected.length,
								relevance: result.relevance ?? undefined,
								...(data.partial ? { partial: true } : {}),
							},
						},
					];
				}),
		);
	}
}

export const __private__ = {
	build_search_body,
};
