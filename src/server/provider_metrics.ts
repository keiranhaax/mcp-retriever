import type { PublicErrorKind } from '../common/errors.js';
import type { ProviderCategory } from './provider_health.js';

/**
 * In-process counters per provider and per tool: calls, outcomes by
 * public error kind, latency distribution and provider-reported usage.
 * Fed by the health markers so every tool records the same way; read
 * through the `retriever://providers/status` resource.
 */

export interface ProviderUsage {
	credits?: number;
	usd?: number;
}

export interface ProviderOutcome {
	category: ProviderCategory;
	provider: string;
	/** Registered tool name, when the call came through a tool. */
	tool?: string;
	ok: boolean;
	elapsed_ms?: number;
	kind?: PublicErrorKind;
	usage?: ProviderUsage | null;
	/** Served from the HTTP cache: counted as a call, never as spend. */
	cached?: boolean;
	/**
	 * Usage is cumulative for this job (agent or research status reads
	 * repeat the running total), so only the increment above the last
	 * observation counts.
	 */
	job_id?: string;
}

interface Counter {
	calls: number;
	ok: number;
	failed: number;
	cache_hits: number;
	errors_by_kind: Partial<Record<PublicErrorKind, number>>;
	latency_samples: number[];
	latency_total_ms: number;
	latency_max_ms: number;
	usage: { credits: number; usd: number; reported_calls: number };
	last_call_at?: string;
}

export interface MetricsSnapshot {
	calls: number;
	ok: number;
	failed: number;
	cache_hits: number;
	errors_by_kind: Partial<Record<PublicErrorKind, number>>;
	latency_ms: {
		samples: number;
		mean: number | null;
		p50: number | null;
		p95: number | null;
		max: number | null;
	};
	usage: { credits: number; usd: number; reported_calls: number };
	last_call_at?: string;
}

// A bounded reservoir keeps percentile estimates cheap and memory flat.
const MAX_LATENCY_SAMPLES = 256;
// High-water marks per job, like the spend ledger keeps, so repeated
// status reads add only what the job consumed since the last read.
const MAX_JOB_MARKS = 256;

const providers = new Map<string, Counter>();
const tools = new Map<string, Counter>();
const job_marks = new Map<string, { credits: number; usd: number }>();

const counter = (
	store: Map<string, Counter>,
	key: string,
): Counter => {
	let state = store.get(key);
	if (!state) {
		state = {
			calls: 0,
			ok: 0,
			failed: 0,
			cache_hits: 0,
			errors_by_kind: {},
			latency_samples: [],
			latency_total_ms: 0,
			latency_max_ms: 0,
			usage: { credits: 0, usd: 0, reported_calls: 0 },
		};
		store.set(key, state);
	}
	return state;
};

const is_measurement = (value: unknown): value is number =>
	typeof value === 'number' && Number.isFinite(value) && value >= 0;

interface Spend {
	credits: number;
	usd: number;
	/** The call reported usage that the totals had not seen before. */
	reported: boolean;
}

// What this outcome adds to the totals. A cached replay and malformed
// figures add nothing; a job observation adds only its increment above
// the high-water mark, and counts as reported when it is the first
// observation of that job or raised the mark.
const spend_of = (outcome: ProviderOutcome): Spend => {
	const none = { credits: 0, usd: 0, reported: false };
	if (!outcome.usage || outcome.cached) return none;
	const credits = is_measurement(outcome.usage.credits)
		? outcome.usage.credits
		: undefined;
	const usd = is_measurement(outcome.usage.usd)
		? outcome.usage.usd
		: undefined;
	if (credits === undefined && usd === undefined) return none;
	if (!outcome.job_id)
		return { credits: credits ?? 0, usd: usd ?? 0, reported: true };
	const key = `${outcome.category}:${outcome.provider}:${outcome.job_id}`;
	const previous = job_marks.get(key);
	const increment = {
		credits: Math.max(0, (credits ?? 0) - (previous?.credits ?? 0)),
		usd: Math.max(0, (usd ?? 0) - (previous?.usd ?? 0)),
	};
	job_marks.delete(key);
	job_marks.set(key, {
		credits: Math.max(previous?.credits ?? 0, credits ?? 0),
		usd: Math.max(previous?.usd ?? 0, usd ?? 0),
	});
	if (job_marks.size > MAX_JOB_MARKS)
		job_marks.delete(job_marks.keys().next().value!);
	return {
		...increment,
		reported: !previous || increment.credits > 0 || increment.usd > 0,
	};
};

const apply = (
	state: Counter,
	outcome: ProviderOutcome,
	spend: Spend,
) => {
	state.calls++;
	if (outcome.ok) state.ok++;
	else {
		state.failed++;
		const kind = outcome.kind ?? 'upstream_failure';
		state.errors_by_kind[kind] =
			(state.errors_by_kind[kind] ?? 0) + 1;
	}
	if (is_measurement(outcome.elapsed_ms)) {
		const elapsed = Math.round(outcome.elapsed_ms);
		state.latency_total_ms += elapsed;
		state.latency_max_ms = Math.max(state.latency_max_ms, elapsed);
		if (state.latency_samples.length >= MAX_LATENCY_SAMPLES)
			state.latency_samples.shift();
		state.latency_samples.push(elapsed);
	}
	if (outcome.cached) state.cache_hits++;
	if (spend.reported) {
		state.usage.credits += spend.credits;
		state.usage.usd += spend.usd;
		state.usage.reported_calls++;
	}
	state.last_call_at = new Date().toISOString();
};

const call_log_enabled = () =>
	process.env.RETRIEVER_CALL_LOG === '1' ||
	process.env.RETRIEVER_CALL_LOG === 'true';

export const record_provider_outcome = (
	outcome: ProviderOutcome,
): void => {
	// Resolve the increment once so both counters add the same amount.
	const spend = spend_of(outcome);
	apply(
		counter(providers, `${outcome.category}:${outcome.provider}`),
		outcome,
		spend,
	);
	if (outcome.tool)
		apply(counter(tools, outcome.tool), outcome, spend);
	if (call_log_enabled()) {
		// One structured line per call; names and numbers only.
		const fields = [
			`tool=${outcome.tool ?? '-'}`,
			`provider=${outcome.category}/${outcome.provider}`,
			`outcome=${outcome.ok ? 'ok' : (outcome.kind ?? 'upstream_failure')}`,
			`ms=${is_measurement(outcome.elapsed_ms) ? Math.round(outcome.elapsed_ms) : '-'}`,
		];
		if (is_measurement(outcome.usage?.credits))
			fields.push(`credits=${outcome.usage!.credits}`);
		if (is_measurement(outcome.usage?.usd))
			fields.push(`usd=${outcome.usage!.usd}`);
		if (outcome.cached) fields.push('cached=1');
		console.error(`retriever call ${fields.join(' ')}`);
	}
};

const percentile = (
	sorted: number[],
	fraction: number,
): number | null =>
	sorted.length
		? sorted[
				Math.min(
					sorted.length - 1,
					Math.max(0, Math.ceil(sorted.length * fraction) - 1),
				)
			]
		: null;

const snapshot_of = (state: Counter): MetricsSnapshot => {
	const sorted = [...state.latency_samples].sort((a, b) => a - b);
	return {
		calls: state.calls,
		ok: state.ok,
		failed: state.failed,
		cache_hits: state.cache_hits,
		errors_by_kind: { ...state.errors_by_kind },
		latency_ms: {
			samples: sorted.length,
			mean: sorted.length
				? Math.round(state.latency_total_ms / state.calls)
				: null,
			p50: percentile(sorted, 0.5),
			p95: percentile(sorted, 0.95),
			max: sorted.length ? state.latency_max_ms : null,
		},
		usage: { ...state.usage },
		...(state.last_call_at
			? { last_call_at: state.last_call_at }
			: {}),
	};
};

export const get_provider_metrics_snapshot = () => ({
	providers: Object.fromEntries(
		[...providers].map(([key, state]) => [key, snapshot_of(state)]),
	),
	tools: Object.fromEntries(
		[...tools].map(([key, state]) => [key, snapshot_of(state)]),
	),
});

export const reset_provider_metrics = () => {
	providers.clear();
	tools.clear();
	job_marks.clear();
};
