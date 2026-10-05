import { spawnSync } from 'node:child_process';
import {
	existsSync,
	mkdtempSync,
	readFileSync,
	rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import {
	anchor_hit,
	canonical_url,
	first_hit_rank,
	render_markdown,
	score_run,
	type EvalManifest,
	type EvalRun,
} from '../../scripts/eval/scoring.mjs';
import { is_valid_url } from './validation.js';

/**
 * The fixed search evaluation set and its scorer, entirely offline.
 * The synthetic run is generated data with known ranks, so every
 * expected figure below is arithmetic on the manifest, not a claim
 * about any provider.
 */

const directory = new URL(
	'./fixtures/eval-queries/',
	import.meta.url,
);
const manifest = JSON.parse(
	readFileSync(new URL('manifest.json', directory), 'utf8'),
) as EvalManifest & { license: string; authored_at: string };
const synthetic = JSON.parse(
	readFileSync(new URL('synthetic-run.json', directory), 'utf8'),
) as EvalRun;
const script = fileURLToPath(
	new URL('../../scripts/eval-search.mjs', import.meta.url),
);
const categories = ['docs', 'code', 'news', 'general'];

describe('fixed evaluation query set', () => {
	it('has about 25 human-authored queries spread across the four categories', () => {
		expect(manifest.version).toBe(1);
		expect(manifest.license).toBe('MIT');
		expect(manifest.authored_at).toMatch(/^\d{4}-\d{2}-\d{2}$/);
		expect(manifest.queries.length).toBeGreaterThanOrEqual(24);
		expect(manifest.queries.length).toBeLessThanOrEqual(30);
		expect(
			new Set(manifest.queries.map((query) => query.id)).size,
		).toBe(manifest.queries.length);
		for (const category of categories)
			expect(
				manifest.queries.filter(
					(query) => query.category === category,
				).length,
			).toBeGreaterThanOrEqual(5);
	});

	it.each(manifest.queries)(
		'$id names its category and resolvable public anchors',
		(query) => {
			expect(categories).toContain(query.category);
			expect(query.id.startsWith(`${query.category}-`)).toBe(true);
			expect(query.query.trim().length).toBeGreaterThan(0);
			expect(query.query.length).toBeLessThanOrEqual(200);
			const urls = query.anchors.urls ?? [];
			const domains = query.anchors.domains ?? [];
			expect(urls.length + domains.length).toBeGreaterThan(0);
			for (const anchor of urls) {
				expect(anchor.startsWith('https://')).toBe(true);
				expect(is_valid_url(anchor.replaceAll('*', 'x'))).toBe(true);
				// Each URL anchor accepts itself, so a provider returning the
				// anchor verbatim can never be scored as a miss.
				expect(
					anchor_hit(anchor.replaceAll('*', 'x'), query.anchors),
				).toBe(true);
			}
			for (const domain of domains) {
				expect(domain).toMatch(/^[a-z0-9.-]+\.[a-z]{2,}$/);
				expect(anchor_hit(`https://${domain}/`, query.anchors)).toBe(
					true,
				);
			}
		},
	);
});

describe('URL canonicalisation and anchor matching', () => {
	it.each([
		[
			'https://Example.COM:443/Path/?utm_source=x#frag',
			'https://example.com/Path',
		],
		['http://example.com:80/a/b/', 'http://example.com/a/b'],
		['https://example.com/', 'https://example.com'],
		[
			'https://example.com/p?keep=1&fbclid=abc&gclid=1&utm_campaign=c&_ga=2',
			'https://example.com/p?keep=1',
		],
		['https://example.com:8443/x', 'https://example.com:8443/x'],
		['ftp://example.com/x', undefined],
		['not a url', undefined],
		[42, undefined],
	])('canonicalises %j', (raw, expected) => {
		expect(canonical_url(raw)).toBe(expected);
	});

	it('matches anchors as whole URLs, at path boundaries, by wildcard and by domain', () => {
		const anchors = {
			urls: [
				'https://nodejs.org/api/fs.html',
				'https://www.postgresql.org/docs/*/sql-createindex.html',
			],
			domains: ['unicode.org'],
		};
		expect(
			anchor_hit('https://nodejs.org/api/fs.html#readfile', anchors),
		).toBe(true);
		expect(
			anchor_hit('https://nodejs.org/api/fs.html?x=1', anchors),
		).toBe(true);
		expect(
			anchor_hit('https://nodejs.org/api/fs.htmlx', anchors),
		).toBe(false);
		expect(anchor_hit('https://nodejs.org/api/fs', anchors)).toBe(
			false,
		);
		expect(
			anchor_hit('https://nodejs.org.evil.test/api/fs.html', anchors),
		).toBe(false);
		expect(
			anchor_hit(
				'https://www.postgresql.org/docs/17/sql-createindex.html',
				anchors,
			),
		).toBe(true);
		expect(
			anchor_hit(
				'https://www.postgresql.org/docs/a/b/sql-createindex.html',
				anchors,
			),
		).toBe(false);
		expect(anchor_hit('https://home.unicode.org/', anchors)).toBe(
			true,
		);
		expect(anchor_hit('https://UNICODE.org/x', anchors)).toBe(true);
		expect(anchor_hit('https://notunicode.org/', anchors)).toBe(
			false,
		);
		expect(anchor_hit('javascript:alert(1)', anchors)).toBe(false);
		expect(
			first_hit_rank(
				[
					'https://a.test/',
					'https://b.test/',
					'https://unicode.org/',
				],
				anchors,
			),
		).toBe(3);
		expect(first_hit_rank(['https://a.test/'], anchors)).toBeNull();
		expect(first_hit_rank([], anchors)).toBeNull();
	});
});

describe('scoring a recorded run', () => {
	it('scores hit@1, hit@5, MRR, latency and reported cost per provider and category', () => {
		const report = score_run(manifest, synthetic);
		expect(report.manifest).toEqual({
			version: 1,
			queries: 25,
			categories: { docs: 7, code: 6, news: 6, general: 6 },
		});
		expect(report.run).toEqual({
			mode: 'synthetic',
			started_at: '2026-10-01T00:00:00.000Z',
			records: 74,
		});
		// alpha: docs rank 1 (7), code rank 3 (6), news miss (6), general
		// rank 2 (6): hit@1 7/25, hit@5 19/25, MRR (7 + 2 + 3)/25.
		expect(report.providers.fixture_alpha).toMatchObject({
			queries: 25,
			answered: 25,
			failed: 0,
			skipped: 0,
			missing: 0,
			hit_at_1: 0.28,
			hit_at_5: 0.76,
			mrr: 0.48,
			latency_ms: { samples: 25, mean: 100, p50: 100, max: 100 },
			cost: {
				usd: 0,
				credits: 25,
				reported_calls: 25,
				unreported_calls: 0,
			},
		});
		expect(report.providers.fixture_alpha.by_category).toMatchObject({
			docs: { queries: 7, hit_at_1: 1, hit_at_5: 1, mrr: 1 },
			code: { queries: 6, hit_at_1: 0, hit_at_5: 1, mrr: 0.3333 },
			news: { queries: 6, hit_at_1: 0, hit_at_5: 0, mrr: 0 },
			general: { queries: 6, hit_at_1: 0, hit_at_5: 1, mrr: 0.5 },
		});
		// beta: rank 1 on 21 queries; two errors, one skipped, one never
		// recorded. Misses count against every manifest query.
		expect(report.providers.fixture_beta).toMatchObject({
			queries: 25,
			answered: 21,
			failed: 2,
			skipped: 1,
			missing: 1,
			hit_at_1: 0.84,
			hit_at_5: 0.84,
			mrr: 0.84,
			latency_ms: { samples: 21, p50: 200, max: 400 },
			cost: { usd: 0.105, credits: 0, reported_calls: 21 },
		});
		expect(
			report.providers['fused:fixture_alpha+fixture_beta'],
		).toMatchObject({
			hit_at_1: 1,
			hit_at_5: 1,
			mrr: 1,
			cost: { usd: 0.125, credits: 25, reported_calls: 25 },
		});
		expect(report.queries).toHaveLength(75);
		expect(
			report.queries.find(
				(row) =>
					row.provider === 'fixture_beta' &&
					row.query_id === 'docs-mcp-specification',
			),
		).toMatchObject({ status: 'missing', rank: null });
		expect(
			report.queries.find(
				(row) =>
					row.provider === 'fixture_beta' &&
					row.query_id === 'news-log4shell',
			),
		).toMatchObject({
			status: 'error',
			error_kind: 'rate_limit',
			rank: null,
		});
		expect(
			report.queries.find(
				(row) =>
					row.provider === 'fixture_alpha' &&
					row.query_id === 'code-valibot',
			),
		).toMatchObject({ rank: 3, hit_at_1: false, hit_at_5: true });
	});

	it('honours top_k, ignores duplicate and unknown records, and counts unreported usage', () => {
		const run: EvalRun = {
			mode: 'test',
			top_k: 2,
			records: [
				{
					query_id: 'docs-git-rebase',
					provider: 'p',
					status: 'ok',
					urls: [
						'https://a.test/',
						'https://b.test/',
						'https://git-scm.com/docs/git-rebase',
					],
					latency_ms: 10,
					usage: null,
				},
				{
					query_id: 'docs-git-rebase',
					provider: 'p',
					status: 'ok',
					urls: ['https://git-scm.com/docs/git-rebase'],
					latency_ms: 1,
				},
				{
					query_id: 'no-such-query',
					provider: 'p',
					status: 'ok',
					urls: ['https://git-scm.com/docs/git-rebase'],
				},
			],
		};
		const report = score_run(manifest, run);
		expect(report.top_k).toBe(2);
		expect(report.providers.p).toMatchObject({
			queries: 25,
			answered: 1,
			missing: 24,
			hit_at_1: 0,
			hit_at_5: 0,
			mrr: 0,
			cost: { reported_calls: 0, unreported_calls: 1 },
		});
		expect(
			score_run(manifest, run, { top_k: 3 }).providers.p,
		).toMatchObject({
			hit_at_5: 0.04,
			mrr: 0.0133,
		});
	});

	it('renders a Markdown table per provider and per category with the misses', () => {
		const markdown = render_markdown(score_run(manifest, synthetic));
		expect(markdown).toContain(
			'| fixture_alpha | 25 | 25 | 0.28 | 0.76 | 0.48 | 100 | 100 | 0 | 25 | 25/25 |',
		);
		expect(markdown).toContain(
			'| fixture_beta | 25 | 21 | 0.84 | 0.84 | 0.84 | 200 | 248 | 0.1050 | 0 | 21/21 |',
		);
		expect(markdown).toContain(
			'| fixture_alpha | news | 6 | 6 | 0 | 0 | 0 |',
		);
		expect(markdown).toContain('## Misses (10)');
		expect(markdown).toContain(
			'| fixture_beta | news-log4shell | error (rate_limit) | - |',
		);
	});
});

describe('eval-search script', () => {
	let out: string | undefined;
	afterEach(() => {
		if (out) rmSync(out, { recursive: true, force: true });
		out = undefined;
	});
	const run_script = (args: string[]) =>
		spawnSync(process.execPath, [script, ...args], {
			encoding: 'utf8',
			timeout: 15000,
			env: { PATH: process.env.PATH, HOME: tmpdir() },
		});

	it('scores a recorded run offline into the requested report directory', () => {
		out = mkdtempSync(join(tmpdir(), 'retriever-eval-report-'));
		const result = run_script([
			'--input',
			fileURLToPath(new URL('synthetic-run.json', directory)),
			'--out',
			out,
		]);
		expect(result.status, result.stderr).toBe(0);
		const lines = result.stdout.trim().split('\n');
		expect(JSON.parse(lines[0])).toMatchObject({
			provider: 'fixture_alpha',
			hit_at_1: 0.28,
			mrr: 0.48,
			credits: 25,
		});
		expect(lines.at(-1)).toBe(`Reports written to ${out}`);
		const report = JSON.parse(
			readFileSync(join(out, 'report.json'), 'utf8'),
		);
		expect(report.providers.fixture_beta.mrr).toBe(0.84);
		expect(readFileSync(join(out, 'report.md'), 'utf8')).toContain(
			'# Search evaluation report',
		);
		expect(
			JSON.parse(readFileSync(join(out, 'run.json'), 'utf8')).records,
		).toHaveLength(74);
	});

	it('refuses live mode without explicit budgets and prints usage otherwise', () => {
		out = mkdtempSync(join(tmpdir(), 'retriever-eval-report-'));
		const live = run_script([
			'--live',
			'--providers',
			'tavily',
			'--env',
			join(out, 'absent.env'),
			'--out',
			join(out, 'live'),
		]);
		expect(live.status).not.toBe(0);
		expect(live.stderr).toContain(
			'--budget-usd must be a positive decimal number',
		);
		expect(existsSync(join(out, 'live'))).toBe(false);
		const over = run_script([
			'--live',
			'--providers',
			'tavily',
			'--budget-usd',
			'6',
			'--budget-credits',
			'1',
			'--env',
			join(out, 'absent.env'),
		]);
		expect(over.status).not.toBe(0);
		expect(over.stderr).toContain(
			'--budget-usd must be within (0, 5]',
		);
		const usage = run_script([]);
		expect(usage.status).toBe(2);
		expect(usage.stdout).toContain('--live --providers');
		expect(run_script(['--help']).status).toBe(0);
	});
});
