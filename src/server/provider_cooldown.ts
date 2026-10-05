import { ErrorType, ProviderError } from '../common/types.js';

/**
 * Short in-memory cooldown per provider after a call ends, retries
 * exhausted, in a rate limit or a 5xx. New paid work for that provider
 * is refused with a typed error until the window passes, so a client
 * can pick another provider instead of queueing more failures. Job
 * status and cancel reads are exempt; nothing is rerouted. A restart
 * clears every cooldown. The unit is the same `category:provider` pair
 * provider health tracks, so Tavily extraction and Tavily search cool
 * down independently.
 */

export type CooldownCategory =
	| 'search'
	| 'ai_response'
	| 'processing';

const make_key = (category: CooldownCategory, provider: string) =>
	`${category}:${provider}`;

const DEFAULT_COOLDOWN_MS = 60_000;
const MAX_COOLDOWN_MS = 15 * 60_000;

const bounded = (
	raw: string | undefined,
	fallback: number,
	max: number,
) => {
	if (raw === undefined || raw === '') return fallback;
	const value = Number(raw);
	if (!/^\d+$/.test(raw) || !Number.isSafeInteger(value))
		return fallback;
	return Math.min(value, max);
};

/** Default window in ms; 0 disables cooldowns entirely. */
export const cooldown_settings = () => ({
	default_ms: bounded(
		process.env.RETRIEVER_PROVIDER_COOLDOWN_MS,
		DEFAULT_COOLDOWN_MS,
		MAX_COOLDOWN_MS,
	),
	max_ms: MAX_COOLDOWN_MS,
});

export interface CooldownTrigger {
	/** HTTP status that ended the call, when the provider sent one. */
	status?: number;
	/** The provider's Retry-After, already parsed by the HTTP layer. */
	reset_time?: Date;
}

const local_causes = new Set([
	'cancelled',
	'timeout',
	'storage',
	'request_budget',
	'spend_cap',
	'provider_cooldown',
	'network',
	'concurrency_limit',
]);

/**
 * Classify a final provider failure. Only a rate limit (429, or a
 * provider's own rate-limit classification) or a 5xx counts; auth,
 * entitlement, validation, local deadlines, local back-pressure and
 * policy refusals never start a cooldown.
 */
export const cooldown_trigger = (
	error: unknown,
): CooldownTrigger | undefined => {
	if (!(error instanceof ProviderError)) return undefined;
	const details: Record<string, unknown> =
		error.details && typeof error.details === 'object'
			? error.details
			: {};
	if (
		typeof details.cause === 'string' &&
		local_causes.has(details.cause)
	)
		return undefined;
	const status =
		typeof details.status === 'number' &&
		Number.isInteger(details.status)
			? details.status
			: undefined;
	const rate_limited =
		error.type === ErrorType.RATE_LIMIT || status === 429;
	const server_failure =
		status !== undefined && status >= 500 && status <= 599;
	if (!rate_limited && !server_failure) return undefined;
	const reset_time = details.reset_time;
	return {
		...(status !== undefined ? { status } : {}),
		...(reset_time instanceof Date &&
		Number.isFinite(reset_time.getTime())
			? { reset_time }
			: {}),
	};
};

interface Cooldown {
	until: number;
	status?: number;
}

const cooldowns = new Map<string, Cooldown>();

/** Record a final failure; starts a cooldown when it qualifies. */
export const note_provider_failure = (
	category: CooldownCategory,
	provider: string,
	error: unknown,
	now = Date.now(),
): void => {
	const { default_ms, max_ms } = cooldown_settings();
	if (default_ms === 0) return;
	const trigger = cooldown_trigger(error);
	if (!trigger) return;
	// A Retry-After in the past says nothing useful; fall back to the
	// default rather than opening a zero-length window.
	const requested = trigger.reset_time
		? trigger.reset_time.getTime() - now
		: 0;
	const window_ms =
		requested > 0 ? Math.min(requested, max_ms) : default_ms;
	const until = now + window_ms;
	const key = make_key(category, provider);
	const existing = cooldowns.get(key);
	// Never shorten a window that is already running.
	if (existing && existing.until >= until) return;
	cooldowns.set(key, {
		until,
		...(trigger.status !== undefined
			? { status: trigger.status }
			: {}),
	});
};

export interface ActiveCooldown {
	until: Date;
	status?: number;
}

export const get_provider_cooldown = (
	category: CooldownCategory,
	provider: string,
	now = Date.now(),
): ActiveCooldown | undefined => {
	const key = make_key(category, provider);
	const cooldown = cooldowns.get(key);
	if (!cooldown) return undefined;
	if (cooldown.until <= now) {
		cooldowns.delete(key);
		return undefined;
	}
	return {
		until: new Date(cooldown.until),
		...(cooldown.status !== undefined
			? { status: cooldown.status }
			: {}),
	};
};

/**
 * Refuse new paid work for a cooling provider. The message carries only
 * the provider name, the triggering status and the clock, so it is safe
 * to show verbatim.
 */
export const assert_provider_not_cooling = (
	category: CooldownCategory,
	provider: string,
	now = Date.now(),
): void => {
	const cooldown = get_provider_cooldown(category, provider, now);
	if (!cooldown) return;
	const reason =
		cooldown.status !== undefined
			? `HTTP ${cooldown.status}`
			: 'a rate limit';
	throw new ProviderError(
		ErrorType.PROVIDER_ERROR,
		`Provider ${provider} is cooling down after ${reason}; retry at ${cooldown.until.toISOString()}`,
		provider,
		{
			retryable: false,
			cause: 'provider_cooldown',
			public: true,
			retry_time: cooldown.until,
			...(cooldown.status !== undefined
				? { trigger_status: cooldown.status }
				: {}),
		},
	);
};

export const reset_provider_cooldowns = () => {
	cooldowns.clear();
};
