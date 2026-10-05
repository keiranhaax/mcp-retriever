import { McpServer } from 'tmcp';
import type { GenericSchema } from 'valibot';
import * as v from 'valibot';
import { public_error_metadata } from '../../common/errors.js';
import { request_metadata } from '../../common/response_metadata.js';
import { ErrorType, ProviderError } from '../../common/types.js';
import {
	present_job_result,
	present_job_error,
} from '../../common/results.js';
import { is_api_key_valid } from '../../common/validation.js';
import { config } from '../../config/env.js';
import { FirecrawlAgentProvider } from '../../providers/processing/firecrawl_agent/index.js';
import {
	mark_provider_error,
	mark_provider_success,
} from '../provider_health.js';
import { assert_provider_not_cooling } from '../provider_cooldown.js';
import { assert_spend_within_cap } from '../spend_caps.js';
import { tool_descriptions } from './descriptions.js';

let provider: FirecrawlAgentProvider | null = null;

export const initialize_firecrawl_agent = (): boolean => {
	if (
		is_api_key_valid(
			config.processing.firecrawl_agent.api_key,
			'firecrawl_agent',
		)
	) {
		provider = new FirecrawlAgentProvider();
		return true;
	}
	return false;
};

export const get_available = () =>
	provider ? ['firecrawl_agent'] : [];

export const register_firecrawl_agent = (
	server: McpServer<GenericSchema>,
) => {
	if (!provider) return;

	server.tool(
		{
			name: 'firecrawl_agent',
			description: tool_descriptions.firecrawl_agent,
			annotations: {
				readOnlyHint: true,
				destructiveHint: false,
				idempotentHint: false,
				openWorldHint: true,
			},
			schema: v.object({
				action: v.optional(
					v.picklist(['start', 'status', 'cancel']),
					'start',
				),
				job_id: v.optional(
					v.pipe(
						v.string(),
						v.uuid(),
						v.description(
							'Existing job ID for status/cancel; never starts a new job.',
						),
					),
				),
				prompt: v.optional(
					v.pipe(
						v.string(),
						v.minLength(1),
						v.maxLength(10000),
						v.description(
							'Natural-language prompt for a new paid job. Start returns immediately; use status with job_id to retrieve results.',
						),
					),
				),
				wait_for_completion: v.optional(
					v.pipe(
						v.boolean(),
						v.description(
							'Opt into a bounded wait on start. Default false; status never creates a new job.',
						),
					),
				),
				model: v.optional(
					v.pipe(
						v.picklist(['spark-2', 'spark-1-mini', 'spark-1-pro']),
						v.description('Firecrawl agent model'),
					),
				),
				max_credits: v.optional(
					v.pipe(
						v.number(),
						v.integer(),
						v.minValue(1),
						v.maxValue(Number.MAX_SAFE_INTEGER),
						v.description(
							'Maximum credits to spend; positive integer. Defaults to 100, not the provider default.',
						),
					),
				),
			}),
		},
		async ({
			action = 'start',
			job_id,
			prompt,
			model,
			max_credits,
			wait_for_completion,
		}) => {
			const started = performance.now();
			try {
				const valid =
					action === 'start'
						? Boolean(prompt?.trim()) && job_id === undefined
						: (action === 'status' || action === 'cancel') &&
							Boolean(job_id) &&
							prompt === undefined &&
							model === undefined &&
							max_credits === undefined &&
							wait_for_completion === undefined;
				if (!valid)
					throw new ProviderError(
						ErrorType.INVALID_INPUT,
						'start requires prompt only; status/cancel require job_id only',
						'firecrawl_agent',
					);
				// Managing an existing job costs nothing; only a start is capped.
				if (action === 'start') {
					assert_spend_within_cap('firecrawl_agent');
					assert_provider_not_cooling(
						'processing',
						'firecrawl_agent',
					);
				}
				const result =
					action === 'status' || action === 'cancel'
						? await provider!.manage_job(action, job_id!)
						: await provider!.run_agent(prompt!, {
								model,
								max_credits,
								wait_for_completion: wait_for_completion ?? false,
							});
				const metadata = request_metadata(
					result,
					'firecrawl_agent',
					action,
					performance.now() - started,
				);
				const presented = present_job_result(
					result,
					'firecrawl_agent',
					'firecrawl_agent',
					metadata,
				);
				mark_provider_success('processing', 'firecrawl_agent', {
					tool: 'firecrawl_agent',
					elapsed_ms: metadata.elapsed_ms,
					usage: metadata.usage,
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
				mark_provider_error('processing', 'firecrawl_agent', error, {
					tool: 'firecrawl_agent',
					elapsed_ms: Math.round(performance.now() - started),
				});
				const metadata = {
					...request_metadata(
						error,
						'firecrawl_agent',
						action,
						performance.now() - started,
					),
					error: public_error_metadata(error),
				};
				const error_response = present_job_error(
					error,
					'firecrawl_agent',
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
