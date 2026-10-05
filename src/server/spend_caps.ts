import {
	readFileSync,
	renameSync,
	unlinkSync,
	writeFileSync,
} from 'node:fs';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { ensure_result_dir } from '../common/result_store.js';
import { ErrorType, ProviderError } from '../common/types.js';

/**
 * Optional per-account spending caps over a UTC day or month, enforced
 * before a paid provider call and fed by provider-reported usage after
 * it. Off unless RETRIEVER_SPEND_CAPS is set; then running totals
 * persist in the private result directory so a restart does not reset
 * them. USD and credits are separate units and are never converted.
 *
 * An account is either a provider family (exa, tavily, firecrawl,
 * brave), which covers every provider sharing that credential, or one
 * exact provider name. A provider is refused when any matching cap is
 * reached. The refusal is a typed error; nothing is rerouted.
 */

export type SpendUnit = 'usd' | 'credits';
export type SpendPeriod = 'daily' | 'monthly';

export interface SpendCap {
	account: string;
	period: SpendPeriod;
	unit: SpendUnit;
	amount: number;
}

export interface SpendUsage {
	usd?: number;
	credits?: number;
}

interface PeriodTotals {
	period: string;
	usd: number;
	credits: number;
}

interface ProviderTotals {
	day: PeriodTotals;
	month: PeriodTotals;
}

interface JobRecord {
	id: string;
	provider: string;
	usd: number;
	credits: number;
}

interface Ledger {
	version: 1;
	providers: Record<string, ProviderTotals>;
	/** High-water marks so repeated job observations add only increments. */
	jobs: JobRecord[];
}

const LEDGER_FILE = 'spend-ledger.json';
const MAX_JOB_RECORDS = 256;
const MAX_CAP_AMOUNT = 1_000_000_000;
const FAMILIES = ['firecrawl', 'brave', 'tavily', 'exa'];
const ACCOUNT_PATTERN = /^[a-z0-9_]{1,64}$/;
const AMOUNT_PATTERN = /^\d{1,10}(\.\d{1,6})?$/;

export const spend_family = (provider: string): string => {
	for (const family of FAMILIES) {
		if (provider === family || provider.startsWith(`${family}_`))
			return family;
	}
	return provider;
};

const cap_matches = (account: string, provider: string) =>
	account === provider || account === spend_family(provider);

/**
 * Parse RETRIEVER_SPEND_CAPS: comma-separated
 * `account:daily|monthly:usd|credits=amount` entries. Malformed input
 * throws so a mistyped cap fails startup instead of silently not
 * applying; the message only echoes the operator's own setting.
 */
export const parse_spend_caps = (
	raw: string | undefined,
): SpendCap[] => {
	if (raw === undefined || raw.trim() === '') return [];
	const caps: SpendCap[] = [];
	const seen = new Set<string>();
	for (const entry of raw.split(',')) {
		const text = entry.trim();
		if (!text) continue;
		const match =
			/^([^:=]+):(daily|monthly):(usd|credits)=([^=]+)$/.exec(text);
		if (!match)
			throw new Error(
				`Invalid RETRIEVER_SPEND_CAPS entry "${text}": expected account:daily|monthly:usd|credits=amount`,
			);
		const [, account, period, unit, amount_text] = match;
		if (!ACCOUNT_PATTERN.test(account))
			throw new Error(
				`Invalid RETRIEVER_SPEND_CAPS account "${account}": use lowercase letters, digits and underscores`,
			);
		if (!AMOUNT_PATTERN.test(amount_text))
			throw new Error(
				`Invalid RETRIEVER_SPEND_CAPS amount "${amount_text}" for ${account}: use a non-negative decimal number`,
			);
		const amount = Number(amount_text);
		if (!Number.isFinite(amount) || amount > MAX_CAP_AMOUNT)
			throw new Error(
				`Invalid RETRIEVER_SPEND_CAPS amount "${amount_text}" for ${account}: exceeds ${MAX_CAP_AMOUNT}`,
			);
		const key = `${account}:${period}:${unit}`;
		if (seen.has(key))
			throw new Error(
				`Duplicate RETRIEVER_SPEND_CAPS entry for ${key}`,
			);
		seen.add(key);
		caps.push({
			account,
			period: period as SpendPeriod,
			unit: unit as SpendUnit,
			amount,
		});
	}
	return caps;
};

export const configured_spend_caps = (): SpendCap[] =>
	parse_spend_caps(process.env.RETRIEVER_SPEND_CAPS);

const day_key = (now: Date) => now.toISOString().slice(0, 10);
const month_key = (now: Date) => now.toISOString().slice(0, 7);

export const period_reset = (period: SpendPeriod, now: Date): Date =>
	period === 'daily'
		? new Date(
				Date.UTC(
					now.getUTCFullYear(),
					now.getUTCMonth(),
					now.getUTCDate() + 1,
				),
			)
		: new Date(
				Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1),
			);

const is_amount = (value: unknown): value is number =>
	typeof value === 'number' && Number.isFinite(value) && value >= 0;

const fresh_totals = (period: string): PeriodTotals => ({
	period,
	usd: 0,
	credits: 0,
});

const empty_ledger = (): Ledger => ({
	version: 1,
	providers: {},
	jobs: [],
});

const ledger_path = () => join(ensure_result_dir(), LEDGER_FILE);

// Last state this process wrote or read; the fallback when the file
// cannot be read, so caps keep applying within the process regardless.
let memory: Ledger | undefined;
const warned = new Set<string>();
const warn_once = (what: string, error: unknown) => {
	const code = (error as NodeJS.ErrnoException)?.code ?? 'unknown';
	const key = `${what}:${code}`;
	if (warned.has(key)) return;
	warned.add(key);
	console.warn(`Spend ledger ${what} failed (${code})`);
};

const read_totals = (value: unknown): PeriodTotals | undefined => {
	if (!value || typeof value !== 'object') return undefined;
	const { period, usd, credits } = value as Record<string, unknown>;
	if (
		typeof period !== 'string' ||
		!/^\d{4}-\d{2}(-\d{2})?$/.test(period)
	)
		return undefined;
	return {
		period,
		usd: is_amount(usd) ? usd : 0,
		credits: is_amount(credits) ? credits : 0,
	};
};

const parse_ledger = (text: string): Ledger | undefined => {
	let raw: unknown;
	try {
		raw = JSON.parse(text);
	} catch {
		return undefined;
	}
	if (!raw || typeof raw !== 'object') return undefined;
	const { version, providers, jobs } = raw as Record<string, unknown>;
	if (version !== 1 || !providers || typeof providers !== 'object')
		return undefined;
	const ledger = empty_ledger();
	for (const [provider, totals] of Object.entries(
		providers as Record<string, unknown>,
	)) {
		if (!ACCOUNT_PATTERN.test(provider)) continue;
		if (!totals || typeof totals !== 'object') continue;
		const day = read_totals((totals as Record<string, unknown>).day);
		const month = read_totals(
			(totals as Record<string, unknown>).month,
		);
		if (!day || !month) continue;
		ledger.providers[provider] = { day, month };
	}
	if (Array.isArray(jobs)) {
		for (const job of jobs.slice(-MAX_JOB_RECORDS)) {
			if (!job || typeof job !== 'object') continue;
			const { id, provider, usd, credits } = job as Record<
				string,
				unknown
			>;
			if (
				typeof id !== 'string' ||
				id.length > 200 ||
				typeof provider !== 'string' ||
				!ACCOUNT_PATTERN.test(provider)
			)
				continue;
			ledger.jobs.push({
				id,
				provider,
				usd: is_amount(usd) ? usd : 0,
				credits: is_amount(credits) ? credits : 0,
			});
		}
	}
	return ledger;
};

const load = (): Ledger => {
	let text: string;
	try {
		text = readFileSync(ledger_path(), 'utf8');
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
			warn_once('read', error);
		return memory ?? empty_ledger();
	}
	const parsed = parse_ledger(text);
	if (!parsed) {
		warn_once('parse', { code: 'malformed' });
		return memory ?? empty_ledger();
	}
	memory = parsed;
	return parsed;
};

// Write to a sibling temp file and rename so readers never see a torn
// ledger. All ledger work is synchronous, so concurrent tool calls in
// this process serialize naturally; a second process sharing the
// directory re-reads before each update, which keeps lost updates to
// the rename window.
const save = (ledger: Ledger) => {
	memory = ledger;
	const path = ledger_path();
	const temp = `${path}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
	try {
		writeFileSync(temp, JSON.stringify(ledger), { mode: 0o600 });
		renameSync(temp, path);
	} catch (error) {
		warn_once('write', error);
		try {
			unlinkSync(temp);
		} catch {
			// The temp file was never created or already moved.
		}
	}
};

const current = (
	ledger: Ledger,
	provider: string,
	now: Date,
): ProviderTotals => {
	const day = day_key(now);
	const month = month_key(now);
	const existing = ledger.providers[provider];
	const totals: ProviderTotals = {
		day:
			existing?.day.period === day ? existing.day : fresh_totals(day),
		month:
			existing?.month.period === month
				? existing.month
				: fresh_totals(month),
	};
	ledger.providers[provider] = totals;
	return totals;
};

const account_totals = (
	ledger: Ledger,
	account: string,
	period: SpendPeriod,
	unit: SpendUnit,
	now: Date,
): number => {
	const key = period === 'daily' ? day_key(now) : month_key(now);
	let total = 0;
	for (const [provider, totals] of Object.entries(ledger.providers)) {
		if (!cap_matches(account, provider)) continue;
		const bucket = period === 'daily' ? totals.day : totals.month;
		if (bucket.period === key) total += bucket[unit];
	}
	return total;
};

/**
 * Add provider-reported usage from a real (uncached) request. Job
 * usage is cumulative per job, so only the increment above the last
 * observation for that job id is added.
 */
export const record_spend = (
	provider: string,
	usage: SpendUsage | null | undefined,
	options: { job_id?: string; now?: Date } = {},
): void => {
	if (!usage || !configured_spend_caps().length) return;
	if (!ACCOUNT_PATTERN.test(provider)) return;
	let usd = is_amount(usage.usd) ? usage.usd : 0;
	let credits = is_amount(usage.credits) ? usage.credits : 0;
	if (usd === 0 && credits === 0 && !options.job_id) return;
	const now = options.now ?? new Date();
	const ledger = load();
	if (options.job_id) {
		const index = ledger.jobs.findIndex(
			(job) => job.id === options.job_id && job.provider === provider,
		);
		const previous = index >= 0 ? ledger.jobs[index] : undefined;
		const observed = { usd, credits };
		usd = Math.max(0, usd - (previous?.usd ?? 0));
		credits = Math.max(0, credits - (previous?.credits ?? 0));
		const record: JobRecord = {
			id: options.job_id,
			provider,
			usd: Math.max(previous?.usd ?? 0, observed.usd),
			credits: Math.max(previous?.credits ?? 0, observed.credits),
		};
		if (index >= 0) ledger.jobs.splice(index, 1);
		ledger.jobs.push(record);
		if (ledger.jobs.length > MAX_JOB_RECORDS)
			ledger.jobs.splice(0, ledger.jobs.length - MAX_JOB_RECORDS);
		if (usd === 0 && credits === 0) {
			save(ledger);
			return;
		}
	}
	const totals = current(ledger, provider, now);
	totals.day.usd += usd;
	totals.day.credits += credits;
	totals.month.usd += usd;
	totals.month.credits += credits;
	save(ledger);
};

export interface SpendCapHit extends SpendCap {
	spent: number;
	reset_at: Date;
}

/** The first configured cap the provider has reached, if any. */
export const spend_cap_reached = (
	provider: string,
	now = new Date(),
): SpendCapHit | undefined => {
	const caps = configured_spend_caps().filter((cap) =>
		cap_matches(cap.account, provider),
	);
	if (!caps.length) return undefined;
	const ledger = load();
	for (const cap of caps) {
		const spent = account_totals(
			ledger,
			cap.account,
			cap.period,
			cap.unit,
			now,
		);
		if (spent >= cap.amount)
			return {
				...cap,
				spent,
				reset_at: period_reset(cap.period, now),
			};
	}
	return undefined;
};

/**
 * Refuse a provider whose cap is reached. The message is built only
 * from the operator's own cap setting and the clock, so it is safe to
 * show a client verbatim.
 */
export const assert_spend_within_cap = (
	provider: string,
	now = new Date(),
): void => {
	const hit = spend_cap_reached(provider, now);
	if (!hit) return;
	throw new ProviderError(
		ErrorType.PROVIDER_ERROR,
		`Spending cap reached for ${hit.account}: ${hit.amount} ${hit.unit} per ${hit.period === 'daily' ? 'UTC day' : 'UTC month'}; resets at ${hit.reset_at.toISOString()}`,
		provider,
		{
			retryable: false,
			cause: 'spend_cap',
			public: true,
			reset_time: hit.reset_at,
			account: hit.account,
			period: hit.period,
			unit: hit.unit,
			cap: hit.amount,
			spent: hit.spent,
		},
	);
};

export interface SpendPeriodSnapshot {
	period: string;
	reset_at: string;
	usd: number;
	credits: number;
	cap_usd: number | null;
	cap_credits: number | null;
}

export interface SpendAccountSnapshot {
	providers: string[];
	day: SpendPeriodSnapshot;
	month: SpendPeriodSnapshot;
	blocked: boolean;
}

/** Usage against caps for the status resource; no paths or secrets. */
export const get_spend_snapshot = (now = new Date()) => {
	const caps = configured_spend_caps();
	if (!caps.length) return { enabled: false as const };
	const ledger = load();
	const accounts = new Set(caps.map((cap) => cap.account));
	for (const provider of Object.keys(ledger.providers))
		accounts.add(spend_family(provider));
	const cap_for = (
		account: string,
		period: SpendPeriod,
		unit: SpendUnit,
	) =>
		caps.find(
			(cap) =>
				cap.account === account &&
				cap.period === period &&
				cap.unit === unit,
		)?.amount ?? null;
	const period_snapshot = (
		account: string,
		period: SpendPeriod,
	): SpendPeriodSnapshot => ({
		period: period === 'daily' ? day_key(now) : month_key(now),
		reset_at: period_reset(period, now).toISOString(),
		usd: account_totals(ledger, account, period, 'usd', now),
		credits: account_totals(ledger, account, period, 'credits', now),
		cap_usd: cap_for(account, period, 'usd'),
		cap_credits: cap_for(account, period, 'credits'),
	});
	const snapshot: Record<string, SpendAccountSnapshot> = {};
	for (const account of [...accounts].sort()) {
		const providers = Object.keys(ledger.providers)
			.filter((provider) => cap_matches(account, provider))
			.sort();
		const day = period_snapshot(account, 'daily');
		const month = period_snapshot(account, 'monthly');
		const blocked = caps.some(
			(cap) =>
				cap.account === account &&
				(cap.period === 'daily' ? day : month)[cap.unit] >=
					cap.amount,
		);
		snapshot[account] = { providers, day, month, blocked };
	}
	return {
		enabled: true as const,
		caps: caps.map((cap) => ({ ...cap })),
		accounts: snapshot,
	};
};

/** Test support: forget the in-process copy; the file is left alone. */
export const reset_spend_ledger = () => {
	memory = undefined;
	warned.clear();
};
