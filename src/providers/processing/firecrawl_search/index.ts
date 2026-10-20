import * as v from 'valibot';
import {
	make_firecrawl_request,
	validate_firecrawl_formats,
	validate_firecrawl_response,
} from '../../../common/firecrawl_utils.js';
import {
	ErrorType,
	ProcessingProvider,
	ProcessingResult,
	ProviderError,
} from '../../../common/types.js';
import {
	handle_provider_error,
	input_error,
} from '../../../common/errors.js';
import { retry_with_backoff } from '../../../common/retry.js';
import { validate_api_key } from '../../../common/validation.js';
import { config } from '../../../config/env.js';

type FirecrawlSearchSource = 'web' | 'images' | 'news';
type FirecrawlSearchCategory =
	| 'developer'
	| 'gov'
	| 'research'
	| 'pdf';

type FirecrawlSearchFormat =
	| string
	| {
			type: string;
			[key: string]: unknown;
	  };

export interface FirecrawlSearchOptions {
	limit?: number;
	sources?: FirecrawlSearchSource[];
	categories?: FirecrawlSearchCategory[];
	includeDomains?: string[];
	excludeDomains?: string[];
	tbs?: string;
	location?: string;
	country?: string;
	ignoreInvalidURLs?: boolean;
	scrapeOptions?: {
		formats?: FirecrawlSearchFormat[];
		onlyMainContent?: boolean;
		redactPII?: boolean;
	};
}

const firecrawl_web_result_schema = v.looseObject({
	url: v.string(),
	title: v.optional(v.string()),
	markdown: v.optional(v.string()),
	html: v.optional(v.string()),
	rawHtml: v.optional(v.string()),
	description: v.optional(v.string()),
	category: v.optional(v.string()),
	metadata: v.optional(v.record(v.string(), v.unknown())),
});

const firecrawl_image_result_schema = v.object({
	url: v.string(),
	title: v.optional(v.string()),
	imageUrl: v.optional(v.string()),
	imageWidth: v.optional(v.number()),
	imageHeight: v.optional(v.number()),
	position: v.optional(v.number()),
});

const firecrawl_news_result_schema = v.looseObject({
	url: v.string(),
	title: v.optional(v.string()),
	snippet: v.optional(v.string()),
	date: v.optional(v.string()),
	imageUrl: v.optional(v.string()),
	position: v.optional(v.number()),
	markdown: v.optional(v.string()),
	html: v.optional(v.string()),
	rawHtml: v.optional(v.string()),
	metadata: v.optional(v.record(v.string(), v.unknown())),
});

// Paper records from the Research Index (`categories: ['research']`).
const firecrawl_research_result_schema = v.looseObject({
	paperId: v.optional(v.string()),
	primaryId: v.optional(v.string()),
	ids: v.optional(v.unknown()),
	title: v.nullish(v.string()),
	abstract: v.nullish(v.string()),
	score: v.nullish(v.number()),
	url: v.optional(v.string()),
});

const firecrawl_search_data_schema = v.object({
	web: v.optional(v.array(firecrawl_web_result_schema)),
	images: v.optional(v.array(firecrawl_image_result_schema)),
	news: v.optional(v.array(firecrawl_news_result_schema)),
	research: v.optional(v.array(firecrawl_research_result_schema)),
});

const firecrawl_search_response_schema = v.object({
	success: v.boolean(),
	data: v.optional(
		v.union([firecrawl_search_data_schema, v.array(v.unknown())]),
	),
	warning: v.optional(v.nullable(v.string())),
	warnings: v.optional(v.array(v.unknown())),
	id: v.optional(v.string()),
	creditsUsed: v.optional(v.number()),
	error: v.optional(v.string()),
});

type FirecrawlWebResult = v.InferOutput<
	typeof firecrawl_web_result_schema
>;
type FirecrawlImageResult = v.InferOutput<
	typeof firecrawl_image_result_schema
>;
type FirecrawlNewsResult = v.InferOutput<
	typeof firecrawl_news_result_schema
>;
type FirecrawlResearchResult = v.InferOutput<
	typeof firecrawl_research_result_schema
>;

const max_provider_warnings = 10;
const max_provider_warning_length = 500;

const warning_text = (warning: unknown): string => {
	if (typeof warning === 'string') return warning;
	if (
		warning &&
		typeof warning === 'object' &&
		'message' in warning &&
		typeof warning.message === 'string'
	) {
		return warning.message;
	}
	try {
		return JSON.stringify(warning) ?? String(warning);
	} catch {
		return String(warning);
	}
};

const provider_warnings = (warnings: unknown[] | undefined) =>
	(warnings ?? [])
		.map(warning_text)
		.filter((text) => text.length > 0)
		.slice(0, max_provider_warnings)
		.map((text) => text.slice(0, max_provider_warning_length));

const normalize_options = (
	options?: Record<string, unknown>,
): FirecrawlSearchOptions =>
	(options || {}) as FirecrawlSearchOptions;

const assert_domain_filters = (
	options: FirecrawlSearchOptions,
	provider_name: string,
) => {
	if (
		options.includeDomains?.length &&
		options.excludeDomains?.length
	) {
		throw new ProviderError(
			ErrorType.INVALID_INPUT,
			'includeDomains and excludeDomains cannot both be set',
			provider_name,
		);
	}
};

// Scraping every hit bills one scrape per result. Basic depth returns
// provider snippets only; advanced depth or explicit formats opt in.
const should_scrape_hits = (
	extract_depth: 'basic' | 'advanced',
	options: FirecrawlSearchOptions,
) => {
	const formats = options.scrapeOptions?.formats;
	if (formats !== undefined) return formats.length > 0;
	return extract_depth === 'advanced';
};

const build_search_body = (
	query: string,
	extract_depth: 'basic' | 'advanced',
	options: FirecrawlSearchOptions,
): Record<string, unknown> => {
	const body: Record<string, unknown> = {
		query,
		limit: options.limit ?? (extract_depth === 'advanced' ? 10 : 5),
		sources: options.sources?.length ? options.sources : ['web'],
	};
	if (should_scrape_hits(extract_depth, options)) {
		body.scrapeOptions = {
			formats: ['markdown'],
			onlyMainContent: true,
		};
	}

	if (options.categories?.length)
		body.categories = options.categories;
	if (options.includeDomains?.length)
		body.includeDomains = options.includeDomains;
	if (options.excludeDomains?.length)
		body.excludeDomains = options.excludeDomains;
	if (options.tbs) body.tbs = options.tbs;
	if (options.location) body.location = options.location;
	if (options.country) body.country = options.country;
	if (options.ignoreInvalidURLs !== undefined)
		body.ignoreInvalidURLs = options.ignoreInvalidURLs;
	if (options.scrapeOptions && body.scrapeOptions) {
		body.scrapeOptions = {
			...(body.scrapeOptions as Record<string, unknown>),
			...options.scrapeOptions,
		};
	}

	return body;
};

const scraped_fields = ['markdown', 'html', 'rawHtml'] as const;

const web_content = (result: FirecrawlWebResult) =>
	result.markdown ||
	result.html ||
	result.rawHtml ||
	result.description ||
	'No content extracted';

const news_content = (result: FirecrawlNewsResult) =>
	result.markdown ||
	result.html ||
	result.rawHtml ||
	result.snippet ||
	'No content extracted';

// The scraped body already lives in `raw_contents`; keep `documents`
// to metadata and any additional representations so results are not
// stored twice per hit.
const without_scraped_body = <
	T extends Partial<Record<(typeof scraped_fields)[number], string>>,
>(
	result: T,
): Omit<T, (typeof scraped_fields)[number]> => {
	const copy: Record<string, unknown> = { ...result };
	for (const field of scraped_fields) delete copy[field];
	return copy as Omit<T, (typeof scraped_fields)[number]>;
};

// Paper records often carry no URL; fall back to a stable identifier.
const research_source = (
	result: FirecrawlResearchResult,
	index: number,
) =>
	result.url ||
	(result.primaryId
		? `research:${result.primaryId}`
		: result.paperId
			? `research:${result.paperId}`
			: `research:result-${index + 1}`);

const research_content = (result: FirecrawlResearchResult) =>
	result.abstract || 'No content extracted';

const format_research_result = (
	result: FirecrawlResearchResult,
	index: number,
) => {
	const title = result.title ? `## ${result.title}\n` : '';
	const score =
		typeof result.score === 'number'
			? `Score: ${result.score}\n`
			: '';
	return `${title}Source: ${research_source(result, index)}\n${score}\n${research_content(result)}`;
};

const format_web_result = (result: FirecrawlWebResult) => {
	const title = result.title ? `## ${result.title}\n` : '';
	const category = result.category
		? `Category: ${result.category}\n`
		: '';
	return `${title}Source: ${result.url}\n${category}\n${web_content(result)}`;
};

const format_news_result = (result: FirecrawlNewsResult) => {
	const title = result.title ? `## ${result.title}\n` : '';
	const date = result.date ? `Date: ${result.date}\n` : '';
	return `${title}Source: ${result.url}\n${date}\n${news_content(result)}`;
};

const format_image_result = (result: FirecrawlImageResult) => {
	const title = result.title ? `## ${result.title}\n` : '';
	const image = result.imageUrl ? `Image: ${result.imageUrl}\n` : '';
	const dimensions =
		result.imageWidth && result.imageHeight
			? `Dimensions: ${result.imageWidth}x${result.imageHeight}\n`
			: '';
	return `${title}Source: ${result.url}\n${image}${dimensions}`.trim();
};

export class FirecrawlSearchProvider implements ProcessingProvider {
	name = 'firecrawl_search';
	description =
		'Web search combined with content scraping in a single call using Firecrawl v2. Returns normalized web, image, and news search results with optional scraped content.';

	async process_content(
		query: string | string[],
		extract_depth: 'basic' | 'advanced' = 'basic',
		options?: Record<string, unknown>,
	): Promise<ProcessingResult> {
		const search_query = Array.isArray(query) ? query[0] : query;

		if (!search_query || search_query.trim().length === 0) {
			throw new ProviderError(
				ErrorType.INVALID_INPUT,
				'Search query is required',
				this.name,
			);
		}

		const search_options = normalize_options(options);
		if (
			search_options.limit !== undefined &&
			(!Number.isInteger(search_options.limit) ||
				search_options.limit < 1 ||
				search_options.limit > 100)
		) {
			throw input_error(
				'limit must be an integer between 1 and 100',
				this.name,
			);
		}
		assert_domain_filters(search_options, this.name);
		if (search_options.scrapeOptions?.formats?.length !== 0)
			validate_firecrawl_formats(
				search_options.scrapeOptions?.formats,
				this.name,
			);

		const search_request = async () => {
			const api_key = validate_api_key(
				config.processing.firecrawl_search.api_key,
				this.name,
			);

			try {
				const request_body = build_search_body(
					search_query,
					extract_depth,
					search_options,
				);

				const data = await make_firecrawl_request(
					this.name,
					config.processing.firecrawl_search.base_url,
					api_key,
					request_body,
					config.processing.firecrawl_search.timeout,
					firecrawl_search_response_schema,
					undefined,
					// Search is an idempotent lookup; identical queries may reuse.
					{ cacheable: true },
				);

				validate_firecrawl_response(data, this.name, 'Search failed');

				if (Array.isArray(data.data)) {
					throw new ProviderError(
						ErrorType.PROVIDER_ERROR,
						'Firecrawl returned legacy v1 search data for a v2 request',
						this.name,
					);
				}

				const web = data.data?.web || [];
				const images = data.data?.images || [];
				const news = data.data?.news || [];
				const research = data.data?.research || [];
				const warnings = provider_warnings(data.warnings);
				const total_results =
					web.length + images.length + news.length + research.length;

				if (total_results === 0) {
					throw new ProviderError(
						ErrorType.PROVIDER_ERROR,
						'No search results returned',
						this.name,
					);
				}

				const raw_contents = [
					...web.map((result) => ({
						url: result.url,
						content: web_content(result),
					})),
					...news.map((result) => ({
						url: result.url,
						content: news_content(result),
					})),
					...images.map((result) => ({
						url: result.imageUrl || result.url,
						content: format_image_result(result),
					})),
					...research.map((result, index) => ({
						url: research_source(result, index),
						content: research_content(result),
					})),
				];

				const combined_content = [
					...web.map(format_web_result),
					...news.map(format_news_result),
					...images.map(format_image_result),
					...research.map(format_research_result),
				].join('\n\n---\n\n');

				const word_count = combined_content
					.split(/\s+/)
					.filter(Boolean).length;

				return {
					content: combined_content,
					raw_contents,
					metadata: {
						word_count,
						documents: {
							web: web.map(without_scraped_body),
							images,
							news: news.map(without_scraped_body),
							...(research.length > 0 && { research }),
						},
						urls_processed: total_results,
						successful_extractions: total_results,
						extract_depth,
						search_id: data.id,
						creditsUsed: data.creditsUsed,
						warning: data.warning,
						...(warnings.length > 0 && {
							provider_warnings: warnings,
						}),
						source_counts: {
							web: web.length,
							images: images.length,
							news: news.length,
							...(research.length > 0 && {
								research: research.length,
							}),
						},
					},
					source_provider: this.name,
				};
			} catch (error) {
				handle_provider_error(error, this.name, 'search and extract');
			}
		};

		return retry_with_backoff(search_request, { max_retries: 0 });
	}
}

export const __private__ = {
	build_search_body,
	should_scrape_hits,
};
