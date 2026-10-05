import { McpServer } from 'tmcp';
import type { GenericSchema } from 'valibot';
import * as v from 'valibot';
import {
	input_error,
	public_error_metadata,
} from '../../common/errors.js';
import { request_metadata } from '../../common/response_metadata.js';
import { get_job_failure } from '../../common/job_state.js';
import {
	get_request_signal,
	throw_if_aborted,
} from '../../common/request_context.js';
import {
	present_job_result,
	present_job_error,
} from '../../common/results.js';
import {
	ErrorType,
	ProviderError,
	SearchProvider,
} from '../../common/types.js';
import { is_api_key_valid } from '../../common/validation.js';
import { config } from '../../config/env.js';
import {
	mark_provider_error,
	mark_provider_success,
} from '../provider_health.js';
import { assert_provider_not_cooling } from '../provider_cooldown.js';
import { assert_spend_within_cap } from '../spend_caps.js';
import { describe_ai_search } from './descriptions.js';

// Concrete provider imports
import { ExaAnswerProvider } from '../../providers/ai_response/exa_answer/index.js';
import { ExaDeepResearchProvider } from '../../providers/ai_response/exa_deep_research/index.js';
import { LinkupProvider } from '../../providers/ai_response/linkup/index.js';
import { BraveAnswersProvider } from '../../providers/ai_response/brave_answers/index.js';
import {
	TavilyResearchProvider,
	tavily_request_id_schema,
} from '../../providers/ai_response/tavily_research/index.js';

export type AISearchProviderName =
	| 'exa_answer'
	| 'exa_deep_research'
	| 'linkup'
	| 'brave_answers'
	| 'tavily_research';

const providers = new Map<string, SearchProvider>();

export const initialize_ai_search = (): boolean => {
	providers.clear();
	if (
		is_api_key_valid(
			config.ai_response.exa_answer.api_key,
			'exa_answer',
		)
	)
		providers.set('exa_answer', new ExaAnswerProvider());
	if (
		is_api_key_valid(
			config.ai_response.exa_deep_research.api_key,
			'exa_deep_research',
		)
	)
		providers.set('exa_deep_research', new ExaDeepResearchProvider());
	if (is_api_key_valid(config.ai_response.linkup.api_key, 'linkup'))
		providers.set('linkup', new LinkupProvider());
	if (
		is_api_key_valid(
			config.ai_response.brave_answers.api_key,
			'brave_answers',
		)
	)
		providers.set('brave_answers', new BraveAnswersProvider());
	if (
		is_api_key_valid(
			config.ai_response.tavily_research.api_key,
			'tavily_research',
		)
	)
		providers.set('tavily_research', new TavilyResearchProvider());

	return providers.size > 0;
};

export const get_available_providers = () =>
	Array.from(providers.keys());

export const register_ai_search = (
	server: McpServer<GenericSchema>,
) => {
	if (providers.size === 0) return;

	const provider_names = Array.from(
		providers.keys(),
	) as AISearchProviderName[];

	server.tool(
		{
			name: 'ai_search',
			description: describe_ai_search(provider_names),
			annotations: {
				readOnlyHint: true,
				destructiveHint: false,
				idempotentHint: false,
				openWorldHint: true,
			},
			schema: v.object({
				query: v.optional(
					v.pipe(
						v.string(),
						v.minLength(1),
						v.maxLength(10000),
						v.description(
							'Question or search query; required except for Tavily action=status',
						),
					),
				),
				action: v.optional(
					v.pipe(
						v.picklist(['research', 'status']),
						v.description(
							'Default research. status is only for tavily_research and performs a read-only GET.',
						),
					),
					'research',
				),
				request_id: v.optional(
					v.pipe(
						tavily_request_id_schema,
						v.description(
							'Existing Tavily task ID, required only for action=status',
						),
					),
				),
				provider: v.pipe(
					v.picklist(provider_names),
					v.description('AI search provider to use'),
				),
				limit: v.optional(
					v.pipe(
						v.number(),
						v.integer(),
						v.minValue(1),
						v.maxValue(50),
						v.description('Maximum number of results (default: 10)'),
					),
				),
				output_schema: v.optional(
					v.pipe(
						v.record(v.string(), v.any()),
						v.description(
							'JSON schema for structured output. Only used when provider is exa_deep_research.',
						),
					),
				),
				exa_deep_search_type: v.optional(
					v.pipe(
						v.picklist(['deep', 'deep-reasoning']),
						v.description(
							'Exa deep search mode. Only used when provider is exa_deep_research.',
						),
					),
				),
				system_prompt: v.optional(
					v.pipe(
						v.string(),
						v.maxLength(10000),
						v.description(
							'Exa system prompt. Only used when provider is exa_deep_research.',
						),
					),
				),
			}),
		},
		async ({
			query,
			provider,
			action = 'research',
			request_id,
			limit,
			output_schema,
			exa_deep_search_type,
			system_prompt,
		}) => {
			const started = performance.now();
			try {
				throw_if_aborted(get_request_signal());
				if (action === 'status') {
					if (
						provider !== 'tavily_research' ||
						query !== undefined ||
						!v.safeParse(tavily_request_id_schema, request_id).success
					) {
						throw new ProviderError(
							ErrorType.INVALID_INPUT,
							'Tavily status requires request_id only; research requires query only',
							'ai_search',
						);
					}
				} else if (
					action !== 'research' ||
					request_id !== undefined ||
					typeof query !== 'string' ||
					!query.trim() ||
					query.length > 10000
				) {
					throw new ProviderError(
						ErrorType.INVALID_INPUT,
						'Tavily status requires request_id only; research requires query only',
						'ai_search',
					);
				}
				const selected = providers.get(provider);
				if (!selected) {
					throw input_error(
						`Provider "${provider}" is not available. Available: ${Array.from(providers.keys()).join(', ')}`,
						'ai_search',
					);
				}

				// Reading an existing job costs nothing; only new work is capped.
				if (action !== 'status') {
					assert_spend_within_cap(provider);
					assert_provider_not_cooling('ai_response', provider);
				}
				const results =
					action === 'status'
						? await (selected as TavilyResearchProvider).status({
								request_id: request_id!,
								limit,
							})
						: await selected.search({
								query,
								limit,
								output_schema,
								search_type: exa_deep_search_type,
								system_prompt,
							} as any);
				if (provider !== 'tavily_research')
					throw_if_aborted(get_request_signal());
				const metadata = request_metadata(
					results,
					provider,
					action,
					performance.now() - started,
				);
				const presented = present_job_result(
					results,
					provider,
					'ai_search',
					metadata,
				);
				mark_provider_success('ai_response', provider, {
					tool: 'ai_search',
					elapsed_ms: metadata.elapsed_ms,
					usage: metadata.usage,
					cached: metadata.cached === true,
					...(metadata.job ? { job_id: metadata.job.id } : {}),
				});
				return {
					_meta: {
						retriever: {
							...metadata,
							local_completeness: presented.local_completeness,
						},
					},
					content: [
						{
							type: 'text' as const,
							text: presented.text,
						},
					],
				};
			} catch (error) {
				if (!get_job_failure(error))
					throw_if_aborted(get_request_signal());
				mark_provider_error('ai_response', provider, error, {
					tool: 'ai_search',
					elapsed_ms: Math.round(performance.now() - started),
				});
				const metadata = {
					...request_metadata(
						error,
						provider,
						action,
						performance.now() - started,
					),
					error: public_error_metadata(error),
				};
				const error_response = present_job_error(
					error,
					'ai_search',
					metadata,
				);
				return {
					_meta: {
						retriever: {
							...metadata,
							local_completeness: error_response.local_completeness,
						},
					},
					content: [
						{
							type: 'text' as const,
							text: error_response.text,
						},
					],
					isError: true,
				};
			}
		},
	);
};
