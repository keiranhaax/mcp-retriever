import * as v from 'valibot';
import { sanitize_query } from '../../../common/errors.js';
import { provider_json_request } from '../../../common/provider_request.js';
import {
	sanitize_exa_control_metadata,
	sanitize_exa_output,
} from '../../../common/provider_sanitization.js';
import { set_response_metadata } from '../../../common/response_metadata.js';
import {
	BaseSearchParams,
	ErrorType,
	ProviderError,
	SearchProvider,
	SearchResult,
} from '../../../common/types.js';
import { validate_api_key } from '../../../common/validation.js';
import { config } from '../../../config/env.js';

interface ExaSearchRequest {
	query: string;
	type?: string;
	numResults?: number;
	includeDomains?: string[];
	excludeDomains?: string[];
	contents?: Record<string, unknown>;
	additionalQueries?: string[];
	category?: string;
	userLocation?: string;
	outputSchema?: Record<string, unknown>;
	systemPrompt?: string;
}

const exa_search_response_schema = v.object({
	requestId: v.optional(v.unknown()),
	autopromptString: v.optional(v.unknown()),
	resolvedSearchType: v.optional(v.unknown()),
	searchType: v.optional(v.unknown()),
	results: v.optional(
		v.array(
			v.object({
				id: v.nullish(v.string()),
				title: v.nullish(v.string()),
				url: v.nullish(v.string()),
				publishedDate: v.nullish(v.string()),
				author: v.nullish(v.string()),
				text: v.nullish(v.string()),
				score: v.nullish(v.number()),
				highlights: v.nullish(v.array(v.string())),
				summary: v.nullish(v.string()),
			}),
		),
	),
	output: v.optional(v.unknown()),
	costDollars: v.optional(v.unknown()),
	warnings: v.optional(v.unknown()),
	notices: v.optional(v.unknown()),
});

const MAX_NOTICES = 10;
const MAX_NOTICE_LENGTH = 500;

// Exa warnings and notices describe how results were produced. Entries
// may be strings or objects, so coerce defensively and bound the size.
const sanitize_exa_notes = (value: unknown): string[] => {
	if (!Array.isArray(value)) return [];
	const notes: string[] = [];
	for (const entry of value) {
		let text: string | undefined;
		if (typeof entry === 'string') {
			text = entry;
		} else if (entry !== null && typeof entry === 'object') {
			const message = (entry as { message?: unknown }).message;
			if (typeof message === 'string') {
				text = message;
			} else {
				try {
					text = JSON.stringify(entry);
				} catch {
					text = undefined;
				}
			}
		}
		text = text?.trim();
		if (!text) continue;
		notes.push(text.slice(0, MAX_NOTICE_LENGTH));
		if (notes.length >= MAX_NOTICES) break;
	}
	return notes;
};

const LITE_CONTENT_KEYS = new Set([
	'text',
	'highlights',
	'snapshotAsOf',
]);

// Exa lite serves cached content with a restricted parameter set and
// answers anything else with HTTP 400. Fail locally and name the
// parameter instead of silently dropping it.
const validate_lite_params = (params: BaseSearchParams): void => {
	if (params.search_type !== 'lite') return;
	const unsupported: string[] = [];
	if (params.additional_queries?.length)
		unsupported.push('additional_queries');
	if (params.output_schema) unsupported.push('output_schema');
	if (params.system_prompt) unsupported.push('system_prompt');
	for (const key of Object.keys(params.contents ?? {})) {
		if (!LITE_CONTENT_KEYS.has(key))
			unsupported.push(`contents.${key}`);
	}
	if (unsupported.length === 0) return;
	throw new ProviderError(
		ErrorType.INVALID_INPUT,
		`Exa lite search does not support: ${unsupported.join(', ')}`,
		'exa',
		{ retryable: false },
	);
};

const build_contents = (params: BaseSearchParams) => {
	return params.contents
		? { ...params.contents }
		: { text: { maxCharacters: 1500 } };
};

const build_search_body = (
	params: BaseSearchParams,
): ExaSearchRequest => {
	validate_lite_params(params);
	const request_body: ExaSearchRequest = {
		query: sanitize_query(params.query),
		type: params.search_type ?? 'auto',
		numResults: params.limit ?? 10,
		contents: build_contents(params),
	};

	if (params.include_domains?.length)
		request_body.includeDomains = params.include_domains;
	if (params.exclude_domains?.length)
		request_body.excludeDomains = params.exclude_domains;
	if (params.additional_queries?.length)
		request_body.additionalQueries = params.additional_queries;
	if (params.category) request_body.category = params.category;
	if (params.user_location)
		request_body.userLocation = params.user_location;
	if (params.output_schema)
		request_body.outputSchema = params.output_schema;
	if (params.system_prompt)
		request_body.systemPrompt = params.system_prompt;

	return request_body;
};

export class ExaSearchProvider implements SearchProvider {
	name = 'exa';
	description =
		'AI-powered web search using Exa search modes, categories, content extraction, and optional synthesized structured outputs. Optimized for AI applications with semantic understanding and research capabilities.';

	async search(params: BaseSearchParams): Promise<SearchResult[]> {
		const api_key = validate_api_key(
			config.search.exa.api_key,
			this.name,
		);

		return provider_json_request(
			this.name,
			{
				url: `${config.search.exa.base_url}/search`,
				method: 'POST',
				headers: {
					'x-api-key': api_key,
					Authorization: `Bearer ${api_key}`,
					'Content-Type': 'application/json',
				},
				body: build_search_body(params),
				timeout_ms: config.search.exa.timeout,
				schema: exa_search_response_schema,
				operation: 'fetch search results',
			},
			(data) => {
				const controls = sanitize_exa_control_metadata(data);
				const output = sanitize_exa_output(data.output);
				const provider_warnings = sanitize_exa_notes(data.warnings);
				const provider_notices = sanitize_exa_notes(data.notices);
				const results: SearchResult[] = (data.results ?? []).map(
					(result) => ({
						title: result.title || result.url || 'Untitled result',
						url: result.url || '',
						snippet:
							result.text || result.summary || 'No content available',
						score: result.score ?? undefined,
						source_provider: this.name,
						metadata: {
							id: result.id,
							author: result.author,
							publishedDate: result.publishedDate,
							highlights: result.highlights,
							...controls,
							output,
							...(provider_warnings.length > 0 && {
								provider_warnings,
							}),
							...(provider_notices.length > 0 && {
								provider_notices,
							}),
						},
					}),
				);
				set_response_metadata(results, controls, this.name);
				return results;
			},
		);
	}
}

export const __private__ = {
	build_search_body,
};
