import * as v from 'valibot';
import { sanitize_query } from '../../../common/errors.js';
import { provider_json_request } from '../../../common/provider_request.js';
import {
	BaseSearchParams,
	SearchProvider,
	SearchResult,
} from '../../../common/types.js';
import { validate_api_key } from '../../../common/validation.js';
import { config } from '../../../config/env.js';

export type ContextAnswersMode = 'fast' | 'ultra';

export interface ContextAnswersParams extends BaseSearchParams {
	context_mode?: ContextAnswersMode;
	json_format?: Record<string, unknown>;
}

interface ContextAnswersRequest {
	mode: ContextAnswersMode;
	task: string;
	json_format?: Record<string, unknown>;
	timeoutOpts: {
		milliseconds: number;
		behavior: 'return-partial';
	};
}

// Nominal credit cost per mode and the provider's research budget.
const MODE_CREDITS: Record<ContextAnswersMode, number> = {
	fast: 10,
	ultra: 100,
};
const MODE_BUDGET_MS: Record<ContextAnswersMode, number> = {
	fast: 30000,
	ultra: 50000,
};
// Leave room for the response to arrive before the client deadline.
const DEADLINE_HEADROOM_MS = 5000;
const MIN_BUDGET_MS = 1000;
const MAX_CONTENT_CHARS = 50000;
const MAX_TITLE_CHARS = 200;

const context_answers_response_schema = v.object({
	json_content: v.pipe(
		v.unknown(),
		v.check(
			(value) => value !== undefined && value !== null,
			'json_content is required',
		),
	),
	sources: v.nullish(v.array(v.unknown())),
	partial: v.nullish(v.boolean()),
});

const stringify_content = (
	content: unknown,
): { text: string; truncated: boolean } => {
	const text =
		typeof content === 'string'
			? content
			: (JSON.stringify(content, null, 2) ?? '');
	return text.length > MAX_CONTENT_CHARS
		? { text: text.slice(0, MAX_CONTENT_CHARS), truncated: true }
		: { text, truncated: false };
};

const is_http_url = (value: string): boolean => {
	try {
		const { protocol } = new URL(value);
		return protocol === 'http:' || protocol === 'https:';
	} catch {
		return false;
	}
};

export class ContextAnswersProvider implements SearchProvider {
	name = 'context_answers';
	description =
		'Context.dev Answers: researched JSON answer with source URLs. fast (10 credits) by default; ultra (100 credits) for deeper multi-source research.';

	async search(
		params: ContextAnswersParams,
	): Promise<SearchResult[]> {
		const api_key = validate_api_key(
			config.ai_response.context_answers.api_key,
			this.name,
		);
		const mode: ContextAnswersMode =
			params.context_mode === 'ultra' ? 'ultra' : 'fast';
		const budget_ms = Math.min(
			MODE_BUDGET_MS[mode],
			Math.max(
				MIN_BUDGET_MS,
				config.ai_response.context_answers.timeout -
					DEADLINE_HEADROOM_MS,
			),
		);

		const request_body: ContextAnswersRequest = {
			mode,
			task: sanitize_query(params.query),
			timeoutOpts: {
				milliseconds: budget_ms,
				behavior: 'return-partial',
			},
		};
		if (
			params.json_format &&
			Object.keys(params.json_format).length > 0
		) {
			request_body.json_format = params.json_format;
		}

		// A paid research run is never retried automatically.
		return provider_json_request(
			this.name,
			{
				url: `${config.ai_response.context_answers.base_url}/web/answers`,
				method: 'POST',
				headers: {
					Authorization: `Bearer ${api_key}`,
					'Content-Type': 'application/json',
				},
				body: request_body,
				timeout_ms: config.ai_response.context_answers.timeout,
				schema: context_answers_response_schema,
				operation: 'fetch AI response',
				max_retries: 0,
			},
			(data) => {
				const sources = (data.sources ?? []).filter(
					(source): source is string =>
						typeof source === 'string' && source.trim().length > 0,
				);
				const content = stringify_content(data.json_content);
				const results: SearchResult[] = [
					{
						title: 'Context.dev Answer',
						url: '',
						snippet: content.text,
						score: 1.0,
						source_provider: this.name,
						metadata: {
							type: 'ai_answer',
							mode,
							partial: data.partial === true,
							credits_mode: MODE_CREDITS[mode],
							sources_count: sources.length,
							...(content.truncated ? { truncated: true } : {}),
						},
					},
				];

				const limit = params.limit ?? sources.length;
				results.push(
					...sources.slice(0, limit).map((source, index) => {
						const entry = source.trim();
						const is_url = is_http_url(entry);
						return {
							title: entry.slice(0, MAX_TITLE_CHARS),
							url: is_url ? entry : '',
							snippet: 'Source reference',
							score: Math.max(0, 0.9 - index * 0.01),
							source_provider: this.name,
							metadata: {
								type: is_url ? 'source' : 'source_record',
							},
						};
					}),
				);

				return results;
			},
		);
	}
}
