import * as v from 'valibot';
import {
	handle_provider_error,
	input_error,
} from '../../../common/errors.js';
import { provider_json_request } from '../../../common/provider_request.js';
import {
	aggregate_url_results,
	type ProcessedUrlResult,
} from '../../../common/results.js';
import {
	get_request_signal,
	throw_if_aborted,
} from '../../../common/request_context.js';
import {
	is_non_retryable_provider_error,
	is_retryable_error,
} from '../../../common/retry.js';
import {
	ErrorType,
	ProcessingProvider,
	ProcessingResult,
	ProviderError,
} from '../../../common/types.js';
import {
	validate_api_key,
	validate_processing_urls,
} from '../../../common/validation.js';
import { config } from '../../../config/env.js';

export type ContextReadMode = 'highlights' | 'markdown';

const MAX_QUERY_CHARS = 2000;
// Characters of passages per page; depth only widens the budget.
const HIGHLIGHT_CHARACTERS = {
	basic: 4000,
	advanced: 10000,
} as const;
// At most this many simultaneous paid requests.
const CONCURRENCY = 4;

// Each requested output reports its own outcome. Payload fields stay
// unknown so one unexpected shape cannot discard the other output.
const output_schema = v.nullish(
	v.object({
		requested: v.nullish(v.boolean()),
		success: v.nullish(v.boolean()),
		data: v.optional(v.unknown()),
		error_code: v.nullish(v.string()),
	}),
);
const context_scrape_response_schema = v.object({
	highlights: output_schema,
	markdown: output_schema,
	metadata: v.nullish(
		v.looseObject({ title: v.optional(v.unknown()) }),
	),
});
type ContextScrapeResponse = v.InferOutput<
	typeof context_scrape_response_schema
>;

// Provider error codes are shown to callers, so only well-formed
// upper-case identifiers pass through.
const safe_code = (code: string | null | undefined) =>
	code && /^[A-Z0-9_]{1,64}$/.test(code) ? code : undefined;

const build_scrape_body = (
	url: string,
	mode: ContextReadMode,
	query: string,
	extract_depth: 'basic' | 'advanced',
): Record<string, unknown> =>
	mode === 'highlights'
		? {
				url,
				formats: { highlights: true },
				highlightsParams: {
					query,
					maxCharacters: HIGHLIGHT_CHARACTERS[extract_depth],
				},
			}
		: { url, formats: { markdown: true } };

export class ContextHighlightsProvider implements ProcessingProvider {
	name = 'context_highlights';
	description =
		'Read public pages with Context.dev: query-relevant highlight passages in page order, or plain page markdown.';

	constructor(
		private readonly mode: ContextReadMode = 'highlights',
	) {}

	async process_content(
		url: string | string[],
		extract_depth: 'basic' | 'advanced' = 'basic',
		options?: Record<string, unknown>,
	): Promise<ProcessingResult> {
		const urls = validate_processing_urls(url, this.name);
		const query =
			typeof options?.query === 'string' ? options.query.trim() : '';
		if (this.mode === 'highlights') {
			if (!query)
				throw input_error(
					'A query is required for Context.dev highlights',
					this.name,
				);
			if (query.length > MAX_QUERY_CHARS)
				throw input_error(
					`Context.dev highlights queries are limited to ${MAX_QUERY_CHARS} characters`,
					this.name,
				);
		}
		const api_key = validate_api_key(
			config.processing.context_highlights.api_key,
			this.name,
		);

		try {
			const results: ProcessedUrlResult[] = Array.from({
				length: urls.length,
			});
			let next_index = 0;
			const state: { failed: boolean; error?: unknown } = {
				failed: false,
			};
			await Promise.all(
				Array.from(
					{ length: Math.min(CONCURRENCY, urls.length) },
					async () => {
						while (!state.failed && next_index < urls.length) {
							const index = next_index++;
							try {
								throw_if_aborted(get_request_signal());
								results[index] = await this.read_one(
									urls[index],
									query,
									extract_depth,
									api_key,
								);
							} catch (error) {
								// Stop starting paid requests; in-flight ones finish.
								if (!state.failed) {
									state.failed = true;
									state.error = error;
								}
							}
						}
					},
				),
			);
			if (state.failed) throw state.error;

			const result = aggregate_url_results(
				results,
				this.name,
				urls,
				extract_depth,
			);
			return {
				...result,
				metadata: {
					...result.metadata,
					mode: this.mode,
					documents: results
						.filter((item) => item.success)
						.map((item) => ({ url: item.url, ...item.metadata })),
					...(results.some((item) => !item.success)
						? {
								failures: results
									.filter((item) => !item.success)
									.map((item) => ({
										url: item.url,
										...(item.metadata?.error_code
											? { error_code: item.metadata.error_code }
											: {}),
									})),
							}
						: {}),
				},
			};
		} catch (error) {
			handle_provider_error(error, this.name, 'extract content');
		}
	}

	private async read_one(
		url: string,
		query: string,
		extract_depth: 'basic' | 'advanced',
		api_key: string,
	): Promise<ProcessedUrlResult> {
		try {
			// Paid per request: no automatic retry of a successful charge.
			const data = await provider_json_request(
				this.name,
				{
					url: `${config.processing.context_highlights.base_url}/web/scrape`,
					method: 'POST',
					headers: {
						Authorization: `Bearer ${api_key}`,
						'Content-Type': 'application/json',
					},
					body: build_scrape_body(
						url,
						this.mode,
						query,
						extract_depth,
					),
					timeout_ms: config.processing.context_highlights.timeout,
					schema: context_scrape_response_schema,
					operation: 'extract content',
					max_retries: 0,
				},
				(response) => response,
			);
			return this.map_page(url, data);
		} catch (error) {
			throw_if_aborted(get_request_signal());
			if (
				is_non_retryable_provider_error(error) ||
				(error instanceof ProviderError &&
					(error.type === ErrorType.RATE_LIMIT ||
						!is_retryable_error(error)))
			)
				throw error;
			return {
				url,
				content: '',
				success: false,
				error:
					error instanceof Error ? error.message : 'Unknown error',
			};
		}
	}

	private map_page(
		url: string,
		data: ContextScrapeResponse,
	): ProcessedUrlResult {
		const title =
			typeof data.metadata?.title === 'string' &&
			data.metadata.title.trim()
				? data.metadata.title.trim()
				: undefined;
		const output =
			this.mode === 'highlights' ? data.highlights : data.markdown;
		// success must be explicitly true; a failed or missing output is
		// a failed page, never an empty-but-complete one.
		if (
			output?.success !== true ||
			(this.mode === 'highlights' && !Array.isArray(output.data))
		) {
			return {
				url,
				content: '',
				success: false,
				error: `Context.dev ${this.mode} unavailable`,
				metadata: { error_code: safe_code(output?.error_code) },
			};
		}
		if (this.mode === 'markdown') {
			const markdown =
				typeof output.data === 'string' ? output.data : '';
			if (!markdown.trim())
				return {
					url,
					content: '',
					success: false,
					error: 'No content extracted from URL',
				};
			return {
				url,
				content: markdown,
				success: true,
				metadata: { title },
			};
		}
		const selected = (output.data as unknown[]).filter(
			(item): item is string =>
				typeof item === 'string' && item.trim().length > 0,
		);
		// An empty list is a valid "nothing relevant on this page".
		return {
			url,
			content: selected.join('\n\n'),
			success: true,
			metadata: {
				title,
				highlights_success: true,
				highlights_count: selected.length,
			},
		};
	}
}

export const __private__ = {
	build_scrape_body,
};
