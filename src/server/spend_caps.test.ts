import {
	existsSync,
	mkdtempSync,
	readFileSync,
	readdirSync,
	rmSync,
	statSync,
	writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
	afterEach,
	beforeEach,
	describe,
	expect,
	it,
	vi,
} from 'vitest';
import {
	create_error_response,
	public_error_metadata,
} from '../common/errors.js';
import {
	assert_spend_within_cap,
	get_spend_snapshot,
	parse_spend_caps,
	period_reset,
	record_spend,
	reset_spend_ledger,
	spend_cap_reached,
	spend_family,
} from './spend_caps.js';

let directory: string;
const ledger = () => join(directory, 'spend-ledger.json');
const read_ledger = () => JSON.parse(readFileSync(ledger(), 'utf8'));
const noon = new Date('2026-10-01T12:00:00.000Z');

beforeEach(() => {
	directory = mkdtempSync(join(tmpdir(), 'retriever-spend-'));
	vi.stubEnv('RETRIEVER_RESULT_DIR', directory);
	vi.stubEnv('RETRIEVER_SPEND_CAPS', '');
	vi.spyOn(console, 'warn').mockImplementation(() => {});
	reset_spend_ledger();
});

afterEach(() => {
	reset_spend_ledger();
	vi.unstubAllEnvs();
	vi.restoreAllMocks();
	rmSync(directory, { recursive: true, force: true });
});

describe('parse_spend_caps', () => {
	it('is empty when unset or blank', () => {
		expect(parse_spend_caps(undefined)).toEqual([]);
		expect(parse_spend_caps('')).toEqual([]);
		expect(parse_spend_caps(' , ')).toEqual([]);
	});

	it('parses account, period, unit and decimal amounts', () => {
		expect(
			parse_spend_caps(
				' exa:daily:usd=1.50, exa:monthly:usd=20 ,tavily:monthly:credits=1000,firecrawl_agent:daily:credits=0',
			),
		).toEqual([
			{ account: 'exa', period: 'daily', unit: 'usd', amount: 1.5 },
			{ account: 'exa', period: 'monthly', unit: 'usd', amount: 20 },
			{
				account: 'tavily',
				period: 'monthly',
				unit: 'credits',
				amount: 1000,
			},
			{
				account: 'firecrawl_agent',
				period: 'daily',
				unit: 'credits',
				amount: 0,
			},
		]);
	});

	it.each([
		['exa=1', 'expected account'],
		['exa:weekly:usd=1', 'expected account'],
		['exa:daily:dollars=1', 'expected account'],
		['Exa:daily:usd=1', 'account "Exa"'],
		['exa:daily:usd=-1', 'amount "-1"'],
		['exa:daily:usd=1e3', 'amount "1e3"'],
		['exa:daily:usd=', 'expected account'],
		['exa:daily:usd=1.1234567', 'amount "1.1234567"'],
		['exa:daily:usd=10000000000', 'amount "10000000000"'],
		['exa:daily:usd=1,exa:daily:usd=2', 'Duplicate'],
	])('rejects %s', (raw, fragment) => {
		expect(() => parse_spend_caps(raw)).toThrow(fragment);
	});
});

describe('periods', () => {
	it('groups providers by credential family', () => {
		expect(spend_family('exa_deep_research')).toBe('exa');
		expect(spend_family('tavily')).toBe('tavily');
		expect(spend_family('firecrawl_agent')).toBe('firecrawl');
		expect(spend_family('brave_news')).toBe('brave');
		expect(spend_family('you')).toBe('you');
		expect(spend_family('exact')).toBe('exact');
	});

	it('resets at the next UTC midnight or first of next month', () => {
		expect(period_reset('daily', noon).toISOString()).toBe(
			'2026-10-02T00:00:00.000Z',
		);
		expect(period_reset('monthly', noon).toISOString()).toBe(
			'2026-11-01T00:00:00.000Z',
		);
		const year_end = new Date('2026-12-31T23:59:59.999Z');
		expect(period_reset('daily', year_end).toISOString()).toBe(
			'2027-01-01T00:00:00.000Z',
		);
		expect(period_reset('monthly', year_end).toISOString()).toBe(
			'2027-01-01T00:00:00.000Z',
		);
	});
});

describe('ledger', () => {
	it('does nothing at all when no cap is configured', () => {
		record_spend('exa', { usd: 0.5 }, { now: noon });
		expect(existsSync(ledger())).toBe(false);
		expect(spend_cap_reached('exa', noon)).toBeUndefined();
		expect(() => assert_spend_within_cap('exa', noon)).not.toThrow();
		expect(get_spend_snapshot(noon)).toEqual({ enabled: false });
	});

	it('persists per-provider UTC day and month totals in a private file', () => {
		vi.stubEnv('RETRIEVER_SPEND_CAPS', 'exa:monthly:usd=20');
		record_spend('exa', { usd: 0.007 }, { now: noon });
		record_spend('exa_answer', { usd: 0.01 }, { now: noon });
		record_spend('tavily', { credits: 2 }, { now: noon });
		expect(statSync(ledger()).mode & 0o777).toBe(0o600);
		expect(readdirSync(directory)).toEqual(['spend-ledger.json']);
		expect(read_ledger()).toEqual({
			version: 1,
			providers: {
				exa: {
					day: { period: '2026-10-01', usd: 0.007, credits: 0 },
					month: { period: '2026-10', usd: 0.007, credits: 0 },
				},
				exa_answer: {
					day: { period: '2026-10-01', usd: 0.01, credits: 0 },
					month: { period: '2026-10', usd: 0.01, credits: 0 },
				},
				tavily: {
					day: { period: '2026-10-01', usd: 0, credits: 2 },
					month: { period: '2026-10', usd: 0, credits: 2 },
				},
			},
			jobs: [],
		});
		// A fresh process reads the same totals back.
		reset_spend_ledger();
		expect(get_spend_snapshot(noon)).toMatchObject({
			enabled: true,
			accounts: {
				exa: {
					providers: ['exa', 'exa_answer'],
					month: { usd: 0.017, credits: 0, cap_usd: 20 },
				},
			},
		});
	});

	it('rolls the day and month windows over without touching the other', () => {
		vi.stubEnv('RETRIEVER_SPEND_CAPS', 'exa:daily:usd=1');
		record_spend('exa', { usd: 0.4 }, { now: noon });
		const next_day = new Date('2026-10-02T01:00:00.000Z');
		record_spend('exa', { usd: 0.3 }, { now: next_day });
		expect(read_ledger().providers.exa).toEqual({
			day: { period: '2026-10-02', usd: 0.3, credits: 0 },
			month: { period: '2026-10', usd: 0.7, credits: 0 },
		});
		const next_month = new Date('2026-11-01T00:00:00.000Z');
		record_spend('exa', { usd: 0.2 }, { now: next_month });
		expect(read_ledger().providers.exa).toEqual({
			day: { period: '2026-11-01', usd: 0.2, credits: 0 },
			month: { period: '2026-11', usd: 0.2, credits: 0 },
		});
	});

	it('adds only the increment of cumulative job usage', () => {
		vi.stubEnv(
			'RETRIEVER_SPEND_CAPS',
			'firecrawl:monthly:credits=100',
		);
		const job = { job_id: 'job-1', now: noon };
		record_spend('firecrawl_agent', { credits: 5 }, job);
		record_spend('firecrawl_agent', { credits: 5 }, job);
		record_spend('firecrawl_agent', { credits: 12 }, job);
		record_spend('firecrawl_agent', { credits: 12 }, job);
		// A different job with the same id namespace on another provider.
		record_spend('tavily_research', { credits: 3 }, job);
		expect(read_ledger().providers.firecrawl_agent.month).toEqual({
			period: '2026-10',
			usd: 0,
			credits: 12,
		});
		expect(read_ledger().jobs).toEqual([
			{
				id: 'job-1',
				provider: 'firecrawl_agent',
				usd: 0,
				credits: 12,
			},
			{
				id: 'job-1',
				provider: 'tavily_research',
				usd: 0,
				credits: 3,
			},
		]);
		for (let i = 0; i < 300; i++)
			record_spend(
				'firecrawl_agent',
				{ credits: 1 },
				{ job_id: `bulk-${i}`, now: noon },
			);
		expect(read_ledger().jobs).toHaveLength(256);
	});

	it('refuses a provider whose family or exact cap is reached', () => {
		vi.stubEnv(
			'RETRIEVER_SPEND_CAPS',
			'exa:daily:usd=0.02,tavily_extract:monthly:credits=3,brave:daily:credits=0',
		);
		record_spend('exa', { usd: 0.007 }, { now: noon });
		record_spend('exa_answer', { usd: 0.013 }, { now: noon });
		record_spend('tavily', { credits: 10 }, { now: noon });
		record_spend('tavily_extract', { credits: 2 }, { now: noon });

		expect(spend_cap_reached('exa_contents', noon)).toEqual({
			account: 'exa',
			period: 'daily',
			unit: 'usd',
			amount: 0.02,
			spent: 0.02,
			reset_at: new Date('2026-10-02T00:00:00.000Z'),
		});
		// The exact cap counts only its own provider, not the family.
		expect(spend_cap_reached('tavily_extract', noon)).toBeUndefined();
		expect(spend_cap_reached('tavily', noon)).toBeUndefined();
		record_spend('tavily_extract', { credits: 1 }, { now: noon });
		expect(spend_cap_reached('tavily_extract', noon)).toMatchObject({
			account: 'tavily_extract',
			spent: 3,
		});
		expect(spend_cap_reached('tavily', noon)).toBeUndefined();
		// A zero cap blocks a provider that never reports usage.
		expect(spend_cap_reached('brave_news', noon)).toMatchObject({
			account: 'brave',
			spent: 0,
		});
		expect(spend_cap_reached('you', noon)).toBeUndefined();
		// The window rolls over and the provider is usable again.
		expect(
			spend_cap_reached('exa', new Date('2026-10-02T00:00:00.000Z')),
		).toBeUndefined();

		let error: unknown;
		try {
			assert_spend_within_cap('exa_answer', noon);
		} catch (thrown) {
			error = thrown;
		}
		expect(public_error_metadata(error)).toEqual({
			kind: 'spend_cap',
			retryable: false,
			provider: 'exa_answer',
			reset_at: '2026-10-02T00:00:00.000Z',
		});
		expect(create_error_response(error)).toEqual({
			error:
				'exa_answer error [PROVIDER_ERROR]: Spending cap reached for exa: 0.02 usd per UTC day; resets at 2026-10-02T00:00:00.000Z',
		});
		expect(get_spend_snapshot(noon)).toMatchObject({
			enabled: true,
			caps: [
				{
					account: 'exa',
					period: 'daily',
					unit: 'usd',
					amount: 0.02,
				},
				{
					account: 'tavily_extract',
					period: 'monthly',
					unit: 'credits',
					amount: 3,
				},
				{
					account: 'brave',
					period: 'daily',
					unit: 'credits',
					amount: 0,
				},
			],
			accounts: {
				exa: {
					providers: ['exa', 'exa_answer'],
					day: {
						period: '2026-10-01',
						reset_at: '2026-10-02T00:00:00.000Z',
						usd: 0.02,
						credits: 0,
						cap_usd: 0.02,
						cap_credits: null,
					},
					month: { usd: 0.02, cap_usd: null },
					blocked: true,
				},
				tavily: {
					providers: ['tavily', 'tavily_extract'],
					blocked: false,
				},
				tavily_extract: {
					providers: ['tavily_extract'],
					month: { credits: 3, cap_credits: 3 },
					blocked: true,
				},
				brave: { providers: [], blocked: true },
			},
		});
		expect(JSON.stringify(get_spend_snapshot(noon))).not.toContain(
			directory,
		);
	});

	it('ignores malformed usage, cached-only and empty reports', () => {
		vi.stubEnv('RETRIEVER_SPEND_CAPS', 'exa:daily:usd=1');
		record_spend('exa', null, { now: noon });
		record_spend(
			'exa',
			{ usd: -1, credits: Number.NaN },
			{ now: noon },
		);
		record_spend('exa', {}, { now: noon });
		record_spend('Not Safe', { usd: 1 }, { now: noon });
		expect(existsSync(ledger())).toBe(false);
	});

	it('survives a malformed or unreadable ledger file by keeping in-process totals', () => {
		vi.stubEnv('RETRIEVER_SPEND_CAPS', 'exa:daily:usd=1');
		writeFileSync(ledger(), '{not json');
		record_spend('exa', { usd: 0.5 }, { now: noon });
		expect(read_ledger().providers.exa.day.usd).toBe(0.5);
		expect(console.warn).toHaveBeenCalledWith(
			'Spend ledger parse failed (malformed)',
		);
		// Foreign shapes are not trusted; counted fields are re-validated.
		writeFileSync(
			ledger(),
			JSON.stringify({
				version: 1,
				providers: {
					exa: {
						day: { period: '2026-10-01', usd: '9', credits: -4 },
						month: { period: '2026-10', usd: 0.25, credits: 0 },
					},
					'../escape': {
						day: { period: '2026-10-01', usd: 9, credits: 0 },
						month: { period: '2026-10', usd: 9, credits: 0 },
					},
				},
				jobs: [{ id: 'x'.repeat(201), provider: 'exa' }],
			}),
		);
		reset_spend_ledger();
		expect(get_spend_snapshot(noon)).toMatchObject({
			accounts: {
				exa: { day: { usd: 0, credits: 0 }, month: { usd: 0.25 } },
			},
		});
		expect(read_ledger().providers).toHaveProperty('../escape');
		record_spend('exa', { usd: 0.1 }, { now: noon });
		expect(read_ledger()).toEqual({
			version: 1,
			providers: {
				exa: {
					day: { period: '2026-10-01', usd: 0.1, credits: 0 },
					month: { period: '2026-10', usd: 0.35, credits: 0 },
				},
			},
			jobs: [],
		});
	});

	it('merges with totals another process wrote between calls', () => {
		vi.stubEnv('RETRIEVER_SPEND_CAPS', 'exa:daily:usd=1');
		record_spend('exa', { usd: 0.1 }, { now: noon });
		const other = read_ledger();
		other.providers.exa.day.usd = 0.6;
		other.providers.exa.month.usd = 0.6;
		writeFileSync(ledger(), JSON.stringify(other));
		record_spend('exa', { usd: 0.1 }, { now: noon });
		expect(read_ledger().providers.exa.day.usd).toBeCloseTo(0.7);
		expect(spend_cap_reached('exa', noon)).toBeUndefined();
		writeFileSync(
			ledger(),
			JSON.stringify({
				...other,
				providers: {
					exa: {
						day: { period: '2026-10-01', usd: 1, credits: 0 },
						month: { period: '2026-10', usd: 1, credits: 0 },
					},
				},
			}),
		);
		expect(spend_cap_reached('exa', noon)).toMatchObject({
			spent: 1,
		});
	});
});
