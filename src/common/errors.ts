import * as v from 'valibot';
import { is_retryable_error } from './retry.js';
import { ErrorType, ProviderError } from './types.js';

export const handle_rate_limit = (
	provider: string,
	reset_time?: Date,
	details: Record<string, unknown> = {},
): never => {
	if (reset_time && !Number.isFinite(reset_time.getTime())) {
		reset_time = undefined;
		details = { ...details, retryable: false };
	}
	throw new ProviderError(
		ErrorType.RATE_LIMIT,
		`Rate limit exceeded for ${provider}${
			reset_time ? `. Reset at ${reset_time.toISOString()}` : ''
		}`,
		provider,
		{ ...details, reset_time },
	);
};

export function handle_provider_error(
	error: unknown,
	provider_name: string,
	operation: string = 'operation',
): never {
	if (error instanceof ProviderError) {
		throw error;
	}
	if (
		error instanceof Error &&
		(error.name === 'AbortError' || error.name === 'TimeoutError')
	) {
		const timeout = error.name === 'TimeoutError';
		throw new ProviderError(
			ErrorType.API_ERROR,
			timeout ? 'Operation timed out' : 'Operation cancelled',
			provider_name,
			{ retryable: false, cause: timeout ? 'timeout' : 'cancelled' },
		);
	}

	throw with_cause(
		new ProviderError(
			ErrorType.API_ERROR,
			`Failed to ${operation}`,
			provider_name,
			{ retryable: false },
		),
		error,
	);
}

/**
 * Attach the original failure for diagnostics. The property is
 * non-enumerable so JSON serialization, logs and public metadata never
 * pick it up; only a debugger or an explicit `error.cause` read sees it.
 */
export const with_cause = <T extends Error>(
	error: T,
	cause: unknown,
): T => {
	if (cause !== undefined)
		Object.defineProperty(error, 'cause', {
			value: cause,
			enumerable: false,
			writable: true,
			configurable: true,
		});
	return error;
};

/**
 * Validation failure whose message is safe to show a client verbatim.
 * Only use fixed text or values drawn from the schema itself (field
 * names, picklist values, numeric bounds); never interpolate caller
 * input into `message`.
 */
export const input_error = (
	message: string,
	provider: string,
	details: Record<string, unknown> = {},
) =>
	new ProviderError(ErrorType.INVALID_INPUT, message, provider, {
		retryable: false,
		public: true,
		...details,
	});

const failure_code = (failure: unknown): string => {
	const code = (failure as { code?: unknown } | null)?.code;
	if (typeof code === 'string' && /^[A-Z0-9_]{1,32}$/.test(code))
		return code;
	return failure instanceof Error ? failure.name : 'unknown';
};

/**
 * Result retention failed (disk full, permissions, quota); the client
 * gets a fixed message while stderr records the failure class so an
 * operator can distinguish ENOSPC from a quota rejection.
 */
export const retention_error = (
	provider: string,
	failure: unknown,
	details: Record<string, unknown> = {},
): ProviderError => {
	console.error(
		`Result retention failed for ${provider}: ${failure_code(failure)}`,
	);
	return with_cause(
		new ProviderError(
			ErrorType.PROVIDER_ERROR,
			'Cannot retain complete canonical result; no evidence was returned',
			provider,
			{ retryable: false, cause: 'storage', ...details },
		),
		failure,
	);
};

export const sanitize_query = (query: string): string => {
	return query.trim().replace(/[\n\r]+/g, ' ');
};

export const MAX_PUBLIC_ERROR_LENGTH = 1024;

// Keep legacy human-readable failure text while exposing the correct
// non-retryable storage classification to clients and provider health.
export class LegacyRetentionError extends ProviderError {
	constructor(public readonly original: unknown) {
		super(
			ErrorType.PROVIDER_ERROR,
			'Cannot retain complete canonical result; no evidence was returned',
			'result_store',
			{ retryable: false, cause: 'storage' },
		);
	}
}

export type PublicErrorKind =
	| 'authentication'
	| 'entitlement'
	| 'rate_limit'
	| 'timeout'
	| 'cancelled'
	| 'endpoint_mismatch'
	| 'bad_input'
	| 'storage_failure'
	| 'request_budget'
	| 'queue_full'
	| 'spend_cap'
	| 'provider_cooldown'
	| 'upstream_failure';

export interface PublicErrorMetadata {
	kind: PublicErrorKind;
	/** Mirrors the existing retry predicate, not a promise to retry. */
	retryable: boolean;
	provider?: string;
	http_status?: number;
	job_id?: string;
	request_id?: string;
	/** When a reached spending cap next resets, ISO 8601 UTC. */
	reset_at?: string;
	/** When a cooling-down provider accepts new work, ISO 8601 UTC. */
	retry_at?: string;
	/** HTTP status that started the cooldown, when the provider sent one. */
	trigger_status?: number;
}

const safe_identifier = (
	value: unknown,
	max_length: number,
): value is string =>
	typeof value === 'string' &&
	value.length > 0 &&
	value.length <= max_length &&
	!/[^a-z0-9_-]/i.test(value);

const job_id_schema = v.pipe(v.string(), v.uuid());

// Only bounded identifiers and classifications cross the public boundary.
// Never infer a kind from arbitrary messages or serialize upstream details.
export const public_error_metadata = (
	error: unknown,
): PublicErrorMetadata => {
	const metadata: PublicErrorMetadata = {
		kind: 'upstream_failure',
		retryable: is_retryable_error(error),
	};
	if (!(error instanceof ProviderError)) {
		if (error instanceof Error) {
			if (error.name === 'TimeoutError') metadata.kind = 'timeout';
			if (error.name === 'AbortError') metadata.kind = 'cancelled';
		}
		return metadata;
	}

	const details: Record<string, unknown> | undefined =
		error.details !== null &&
		typeof error.details === 'object' &&
		!Array.isArray(error.details)
			? error.details
			: undefined;
	if (safe_identifier(error.provider, 64))
		metadata.provider = error.provider;
	const status = details?.status;
	if (
		typeof status === 'number' &&
		Number.isInteger(status) &&
		status >= 100 &&
		status <= 599
	) {
		metadata.http_status = status;
	}

	if (
		details?.cause === 'cancelled' ||
		details?.cause === 'timeout'
	) {
		metadata.kind = details.cause;
	} else if (details?.cause === 'storage') {
		metadata.kind = 'storage_failure';
	} else if (details?.cause === 'request_budget') {
		metadata.kind = 'request_budget';
	} else if (details?.cause === 'concurrency_limit') {
		// This server's own per-provider queue is full; the provider
		// never saw the request.
		metadata.kind = 'queue_full';
	} else if (details?.cause === 'spend_cap') {
		metadata.kind = 'spend_cap';
		const reset_time = details.reset_time;
		if (
			reset_time instanceof Date &&
			Number.isFinite(reset_time.getTime())
		)
			metadata.reset_at = reset_time.toISOString();
	} else if (details?.cause === 'provider_cooldown') {
		metadata.kind = 'provider_cooldown';
		const retry_time = details.retry_time;
		if (
			retry_time instanceof Date &&
			Number.isFinite(retry_time.getTime())
		)
			metadata.retry_at = retry_time.toISOString();
		const trigger_status = details.trigger_status;
		if (
			typeof trigger_status === 'number' &&
			Number.isInteger(trigger_status) &&
			trigger_status >= 100 &&
			trigger_status <= 599
		)
			metadata.trigger_status = trigger_status;
	} else {
		switch (error.type) {
			case ErrorType.ENTITLEMENT_REQUIRED:
				metadata.kind = 'entitlement';
				break;
			case ErrorType.ENDPOINT_NOT_FOUND:
				metadata.kind = 'endpoint_mismatch';
				break;
			case ErrorType.RATE_LIMIT:
				metadata.kind = 'rate_limit';
				break;
			case ErrorType.INVALID_INPUT:
				metadata.kind = 'bad_input';
				break;
			default:
				switch (metadata.http_status) {
					case 401:
						metadata.kind = 'authentication';
						break;
					case 402:
					case 403:
						metadata.kind = 'entitlement';
						break;
					case 429:
						metadata.kind = 'rate_limit';
						break;
					case 408:
					case 504:
						metadata.kind = 'timeout';
						break;
					case 400:
					case 422:
						metadata.kind = 'bad_input';
				}
		}
	}

	const job_id = details?.job_id;
	if (
		(metadata.provider === 'firecrawl_agent' ||
			metadata.provider === 'firecrawl_crawl' ||
			metadata.provider === 'firecrawl_extract') &&
		typeof job_id === 'string' &&
		job_id.length === 36 &&
		v.safeParse(job_id_schema, job_id).success
	) {
		metadata.job_id = job_id;
	}
	if (
		metadata.provider === 'tavily_research' &&
		safe_identifier(details?.request_id, 200)
	) {
		metadata.request_id = details.request_id;
	}
	return metadata;
};

// Paths can also contain bearer tokens; retain only the API origin.
export const safe_endpoint = (url: string): string => {
	try {
		const parsed = new URL(url);
		if (!['http:', 'https:'].includes(parsed.protocol))
			return '[redacted endpoint]';
		return parsed.origin.slice(0, 256);
	} catch {
		return '[redacted endpoint]';
	}
};

const local_fetch_messages = {
	unsafe_address: 'Local extraction destination is not public',
	dns_failure: 'Local extraction DNS resolution failed',
	peer_mismatch:
		'Local extraction connection did not match its approved address',
	connection_failed: 'Local extraction connection failed',
	tls_failed: 'Local extraction TLS verification failed',
	redirect_limit: 'Local extraction redirect limit exceeded',
	redirect_downgrade:
		'Local extraction HTTPS downgrade is not allowed',
	invalid_redirect: 'Local extraction redirect is invalid',
	headers_too_large:
		'Local extraction response headers exceed limits',
	response_too_large: 'Local extraction response exceeds byte limits',
	unsupported_content: 'Local extraction requires HTML or XHTML',
	unsupported_encoding: 'Local extraction encoding is unsupported',
	invalid_encoding: 'Local extraction response could not be decoded',
	upstream_status:
		'Local extraction target returned an unsuccessful status',
} as const;

export type LocalFetchFailure = keyof typeof local_fetch_messages;

// No URL, address, page text, or upstream exception is attached.
export const local_fetch_error = (reason: LocalFetchFailure) =>
	new ProviderError(
		reason === 'unsafe_address'
			? ErrorType.INVALID_INPUT
			: ErrorType.PROVIDER_ERROR,
		local_fetch_messages[reason],
		'defuddle',
		{ retryable: false, cause: reason },
	);

const safe_messages = new Set([
	...Object.values(local_fetch_messages),
	'Cannot retain complete canonical result; no evidence was returned',
	'Invalid API key',
	'Provider credits exhausted or payment required',
	'Network request failed',
	'Operation timed out',
	'Operation cancelled',
	'Provider response exceeds byte limit',
	'Aggregate provider response exceeds byte limit',
	'Provider returned invalid JSON',
]);

const safe_validation_messages = new Set([
	local_fetch_messages.unsafe_address,
	'output_budget_bytes requires response_mode=compact or full',
	'Invalid presentation controls',
	'Output budget cannot fit required result provenance',
	'Invalid URL provided; use a public HTTP(S) URL without credentials',
	'Invalid public domain provided',
	'At least one URL is required',
	'This mode requires exactly one URL',
	'A maximum of 20 URLs is allowed per request',
	'Result not found or expired',
	'Invalid result ID',
	'Offset must be a positive integer',
	'Limit must be an integer between 1 and 500',
	'Byte offset must be a non-negative safe integer',
	'Byte offset exceeds the selected line',
	'Byte offset must be on a UTF-8 character boundary',
	'Tavily supports at most 20 results',
	'Invalid Tavily search controls',
	'Tavily search controls require provider=tavily',
	'Tavily time_range cannot be combined with before:/after: operators',
	'Tavily country operators require topic=general',
	'Tavily extraction controls require provider=tavily',
	'Tavily extraction format must be markdown or text',
	'url is required',
	'domain is required',
	'query is required',
	'URL is required',
	'Query is required for search mode',
	'Search query is required',
	'Query is required for LLM context',
	'minResults must not exceed maxResults',
	'Unsupported Firecrawl formats',
	'A valid job_id is required',
	'A valid request_id is required',
	'Tavily status requires request_id only; research requires query only',
	'Prompt must contain 1 to 10000 characters',
	'max_credits must be a positive safe integer',
	'start requires prompt only; status/cancel require job_id only',
	'formats cannot be combined with question or highlights_query',
	'question and highlights_query cannot both be set',
	'storeInCache cannot be true when zeroDataRetention is enabled',
	'onlyCleanContent is not supported with zeroDataRetention',
	'includeDomains and excludeDomains cannot both be set',
	'firecrawl_options can only be used with provider=firecrawl and mode=scrape',
	'firecrawl_search_options can only be used with provider=firecrawl and mode=search',
	'At least one ID must be provided',
	'Do not mix Exa result IDs and URLs in one contents request',
	'A URL must be provided',
	'loc_lat must be between -90 and 90',
	'loc_long must be between -180 and 180',
	'Tavily chunk reranking requires a non-empty query and chunks_per_source must be an integer from 1 to 5',
	'Invalid GitHub search query',
	'Brave query exceeds API limits (400 characters / 50 words). Shorten the query.',
]);

export const public_error_message = (
	error: ProviderError,
): string => {
	switch (error.type) {
		case ErrorType.ENTITLEMENT_REQUIRED:
			return 'API key does not have access to this endpoint';
		case ErrorType.ENDPOINT_NOT_FOUND:
			return 'Endpoint not found';
		case ErrorType.RATE_LIMIT:
			return 'Rate limit exceeded';
		case ErrorType.INVALID_INPUT:
			// Only fixed local guidance is safe; rejected input may be
			// a path, malformed URL, or query with no recognizable scheme.
			// `input_error` marks messages built solely from schema facts.
			if (
				safe_validation_messages.has(error.message) ||
				error.details?.public === true
			)
				return error.message;
			if (error.message.startsWith('Invalid URL provided:'))
				return 'Invalid URL provided. Use a public HTTP(S) URL without credentials.';
			return 'Invalid input. Check required fields and allowed values in the tool schema.';
		default: {
			// `public` marks text built only from operator configuration and
			// the clock (spending caps), never from provider or caller data.
			if (
				safe_messages.has(error.message) ||
				error.details?.public === true
			)
				return error.message;
			const status = error.details?.status;
			if (
				Number.isInteger(status) &&
				status >= 400 &&
				status <= 599
			) {
				return `Provider rejected the request (HTTP ${status})`;
			}
			return 'Provider request failed';
		}
	}
};

export const create_error_response = (
	error: unknown,
	options: { include_recovery?: boolean } = {},
): { error: string } => {
	if (error instanceof LegacyRetentionError)
		return create_error_response(error.original, options);
	if (error instanceof Error && error.name === 'TimeoutError')
		return { error: 'Operation timed out' };
	if (error instanceof Error && error.name === 'AbortError')
		return { error: 'Operation cancelled' };
	if (error instanceof ProviderError) {
		const detail_suffix =
			typeof error.details?.url === 'string'
				? ` (endpoint: ${safe_endpoint(error.details.url)})`
				: '';
		const guidance =
			error.type === ErrorType.ENTITLEMENT_REQUIRED
				? ' Verify API key plan/entitlement for this endpoint.'
				: error.type === ErrorType.ENDPOINT_NOT_FOUND
					? ' Verify endpoint configuration or set FIRECRAWL_AGENT_URL.'
					: '';
		const metadata = public_error_metadata(error);
		const provider = metadata.provider ?? 'provider';
		// Tavily guidance remains automatic for existing callers. Firecrawl
		// callers opt in when replacing their manual recovery suffix.
		const recovery = metadata.request_id
			? ` Resume with ai_search provider="tavily_research", action="status", request_id="${metadata.request_id}"; do not start a new research task.`
			: options.include_recovery && metadata.job_id
				? ` job_id=${metadata.job_id}. Use firecrawl_agent action="status" or action="cancel" with this job_id; do not start a new job.`
				: '';
		return {
			error:
				`${provider} error [${error.type}]: ${public_error_message(error)}${detail_suffix}${guidance}`.slice(
					0,
					MAX_PUBLIC_ERROR_LENGTH - recovery.length,
				) + recovery,
		};
	}
	return { error: 'Unexpected error: operation failed' };
};
