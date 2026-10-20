import { McpServer } from 'tmcp';
import * as v from 'valibot';
import {
	input_error,
	public_error_metadata,
	type PublicErrorMetadata,
} from '../../common/errors.js';
import {
	create_output_schema,
	tool_success,
	tool_error,
	tool_success_bytes,
} from '../../common/tool_output.js';
import {
	present_search_read,
	search_read_data_schema,
	type SearchReadResult,
} from '../../common/search_read_result.js';
import {
	combine_request_signal,
	run_with_request_context,
} from '../../common/request_context.js';
import { get_response_metadata } from '../../common/response_metadata.js';
import { ErrorType, ProviderError } from '../../common/types.js';
import { is_valid_url } from '../../common/validation.js';
import {
	mark_provider_error,
	mark_provider_success,
} from '../provider_health.js';
import { assert_provider_not_cooling } from '../provider_cooldown.js';
import { assert_spend_within_cap } from '../spend_caps.js';
import {
	get_available_providers as search_providers,
	get_search_provider,
} from './web_search.js';
import {
	get_available_providers as extract_providers,
	get_extract_provider,
} from './web_extract.js';

const modes: Record<string, string> = {
	tavily: 'extract',
	exa: 'contents',
	firecrawl: 'scrape',
	context: 'highlights',
};
// Context.dev highlights need a relevance query; its limit is 2000.
const HIGHLIGHT_QUERY_CHARS = 2000;
// Matches the per-provider slot limit; more would only queue in http.ts.
const READ_CONCURRENCY = 4;
const workflow_output_schema: v.GenericSchema<{
	ok: boolean;
	data?: unknown;
	error?: PublicErrorMetadata;
}> = create_output_schema(search_read_data_schema);
const integer = (
	min: number,
	max: number,
	value: number,
	description: string,
) =>
	v.optional(
		v.pipe(
			v.number(),
			v.integer(),
			v.minValue(min),
			v.maxValue(max),
			v.description(description),
		),
		value,
	);

export const register_search_and_read = (
	server: McpServer<v.GenericSchema>,
) => {
	const searches = search_providers();
	const extracts = extract_providers().filter(
		(name) => name in modes,
	);
	if (!searches.length || !extracts.length) return;
	server.tool(
		{
			name: 'search_and_read',
			outputSchema: workflow_output_schema,
			description:
				'Search and read: retrieve top-ranked public pages with explicit providers, bounded requests and per-source evidence. No synthesis, crawling or fallback. Use separate search/extract when selecting sources needs judgment.',
			annotations: {
				readOnlyHint: true,
				destructiveHint: false,
				idempotentHint: false,
				openWorldHint: true,
			},
			schema: v.strictObject({
				query: v.pipe(v.string(), v.minLength(1), v.maxLength(5000)),
				search_provider: v.picklist(searches),
				extract_provider: v.picklist(extracts),
				max_sources: integer(
					1,
					5,
					3,
					'Maximum unique search hits to attempt reading; default 3.',
				),
				search_limit: integer(
					1,
					20,
					5,
					'Maximum search hits considered; must be at least max_sources; default 5.',
				),
				max_requests: integer(
					2,
					20,
					8,
					'Maximum provider HTTP attempts including retries, not credits; default 8.',
				),
				timeout_ms: integer(
					100,
					60000,
					30000,
					'Whole workflow deadline in milliseconds; default 30000.',
				),
				output_budget_bytes: integer(
					2048,
					80000,
					12000,
					'UTF-8 budget for the complete MCP result, excluding JSON-RPC framing; default 12000.',
				),
			}),
		},
		async ({
			query,
			search_provider,
			extract_provider,
			max_sources = 3,
			search_limit = 5,
			max_requests = 8,
			timeout_ms = 30000,
			output_budget_bytes = 12000,
		}) => {
			const started = performance.now();
			const budget = { limit: max_requests, used: 0 };
			const deadline = new AbortController();
			const timer = setTimeout(
				() =>
					deadline.abort(
						new DOMException('Operation timed out', 'TimeoutError'),
					),
				timeout_ms,
			);
			timer.unref();
			const signal = combine_request_signal(deadline.signal);
			try {
				if (!query.trim() || search_limit < max_sources)
					throw input_error(
						'Invalid search/read limits',
						'search_and_read',
					);
				const search = get_search_provider(search_provider);
				const extract = get_extract_provider(
					extract_provider,
					modes[extract_provider],
				);
				if (!search || !extract)
					throw input_error(
						'Provider is not available',
						'search_and_read',
					);
				const result = await run_with_request_context(
					signal,
					async () => {
						let hits;
						try {
							assert_spend_within_cap(search_provider);
							assert_provider_not_cooling('search', search_provider);
							hits = await search.search({
								query,
								limit: search_limit,
							});
							mark_provider_success('search', search_provider, {
								tool: 'search_and_read',
								usage: get_response_metadata(hits)?.usage,
								cached: get_response_metadata(hits)?.cached === true,
							});
						} catch (error) {
							if (
								!signal?.aborted &&
								public_error_metadata(error).kind !== 'request_budget'
							)
								mark_provider_error(
									'search',
									search_provider,
									error,
									{
										tool: 'search_and_read',
									},
								);
							throw error;
						}
						const seen = new Set<string>();
						let duplicates_removed = 0;
						const sources: SearchReadResult['sources'] = [];
						// Indexes of sources still to read, in ranked order.
						const pending: number[] = [];
						for (const hit of hits.slice(0, search_limit)) {
							if (seen.has(hit.url)) {
								duplicates_removed++;
								continue;
							}
							seen.add(hit.url);
							if (sources.length >= max_sources) continue;
							const source: SearchReadResult['sources'][number] = {
								id: `/sources/${sources.length}`,
								url: hit.url,
								title: hit.title,
								snippet: hit.snippet,
								status: 'ok',
								search_provider,
								extract_provider,
							};
							sources.push(source);
							if (!is_valid_url(hit.url) || hit.url.length > 4096) {
								delete source.url;
								delete source.title;
								delete source.snippet;
								source.status = 'error';
								source.error = {
									kind: 'bad_input',
									retryable: false,
								};
								continue;
							}
							pending.push(sources.length - 1);
						}
						const skip = (
							source: SearchReadResult['sources'][number],
							kind: 'timeout' | 'cancelled' | 'request_budget',
						) => {
							source.status = 'skipped';
							source.error = { kind, retryable: false };
						};
						const abort_kind = () =>
							signal?.reason?.name === 'TimeoutError'
								? 'timeout'
								: 'cancelled';
						const read = async (
							source: SearchReadResult['sources'][number],
						) => {
							try {
								assert_spend_within_cap(extract_provider);
								assert_provider_not_cooling(
									'processing',
									extract_provider,
								);
								const extracted = await extract.process_content(
									source.url!,
									'basic',
									extract_provider === 'context'
										? {
												query: query
													.trim()
													.slice(0, HIGHLIGHT_QUERY_CHARS),
											}
										: undefined,
								);
								source.content = extracted.content;
								// Provider metadata only: the page text is already in
								// `content`, and repeating it inflates the stored result.
								source.extraction = {
									source_provider: extracted.source_provider,
									metadata: extracted.metadata,
								};
								const request_metadata =
									get_response_metadata(extracted);
								source.request_metadata = request_metadata
									? { ...request_metadata }
									: null;
								if (
									!extracted.content.trim() ||
									extracted.metadata.failed_urls?.length
								)
									throw new ProviderError(
										ErrorType.PROVIDER_ERROR,
										'No complete content extracted',
										extract_provider,
										{ retryable: false },
									);
								mark_provider_success(
									'processing',
									extract_provider,
									{
										tool: 'search_and_read',
										usage: request_metadata?.usage,
										cached: request_metadata?.cached === true,
									},
								);
							} catch (error) {
								source.status = 'error';
								source.error = public_error_metadata(error);
								if (
									!signal?.aborted &&
									source.error.kind !== 'request_budget'
								)
									mark_provider_error(
										'processing',
										extract_provider,
										error,
										{ tool: 'search_and_read' },
									);
							}
						};
						// Bounded parallel reads. Each in-flight read reserves one
						// request of the remaining budget, so a read only starts
						// when at least one attempt is guaranteed to fit; the rest
						// wait for a completion and re-check, or are skipped once
						// nothing is in flight. Source order stays ranked.
						let in_flight = 0;
						const waiters: Array<() => void> = [];
						const wait_for_capacity = () =>
							new Promise<void>((resolve) => waiters.push(resolve));
						const worker = async () => {
							while (pending.length) {
								if (signal?.aborted) {
									skip(sources[pending.shift()!], abort_kind());
									continue;
								}
								if (budget.used + in_flight >= budget.limit) {
									if (in_flight === 0) {
										skip(sources[pending.shift()!], 'request_budget');
										continue;
									}
									await wait_for_capacity();
									continue;
								}
								const source = sources[pending.shift()!];
								in_flight++;
								try {
									await read(source);
								} finally {
									in_flight--;
									for (const wake of waiters.splice(0)) wake();
								}
							}
						};
						await Promise.all(
							Array.from(
								{
									length: Math.min(READ_CONCURRENCY, pending.length),
								},
								worker,
							),
						);
						return {
							presentation: 'complete' as const,
							sources,
							metadata: {
								search_provider,
								extract_provider,
								http_requests: budget.used,
								max_requests,
								max_sources,
								search_limit,
								duplicates_removed,
								considered_hits: Math.min(hits.length, search_limit),
								sources_omitted: seen.size - sources.length,
								complete: sources.every(
									(source) => source.status === 'ok',
								),
								elapsed_ms: Math.round(performance.now() - started),
								search_request_metadata: get_response_metadata(hits)
									? { ...get_response_metadata(hits) }
									: null,
							},
						};
					},
					{ http_budget: budget },
				);
				return tool_success(
					present_search_read(
						result,
						query,
						output_budget_bytes,
						tool_success_bytes,
					),
				);
			} catch (error) {
				return tool_error(error);
			} finally {
				clearTimeout(timer);
			}
		},
	);
};
