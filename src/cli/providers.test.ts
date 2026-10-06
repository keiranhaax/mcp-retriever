import { describe, expect, it, vi } from 'vitest';
import { LOADABLE_SETTINGS } from '../config/credentials_file.js';
import {
	find_provider,
	mask,
	normalize_origin,
	PROVIDERS,
	run_check,
} from './providers.js';
import { request_url } from './test_terminal.js';

const KEY = 'sk-test-0123456789abcdef';

const responding = (
	status: number,
	headers: Record<string, string> = {},
) =>
	vi.fn<typeof fetch>(
		async () =>
			new Response('{"echo":"body-must-not-leak"}', {
				status,
				headers,
			}),
	);

const provider = (id: string) => {
	const found = find_provider(id);
	if (!found) throw new Error(`no provider ${id}`);
	return found;
};

const request = (fetcher: ReturnType<typeof responding>) => {
	const [input, init] = fetcher.mock.calls[0];
	return { url: request_url(input), init: init ?? {} };
};

describe('provider catalog', () => {
	it('lists the no-cost options first', () => {
		expect(PROVIDERS.slice(0, 2).map((entry) => entry.id)).toEqual([
			'searxng',
			'github',
		]);
	});

	it('uses unique ids and only settings the server can load', () => {
		const ids = PROVIDERS.map((entry) => entry.id);
		expect(new Set(ids).size).toBe(ids.length);
		const loadable: readonly string[] = LOADABLE_SETTINGS;
		for (const entry of PROVIDERS)
			expect(loadable).toContain(entry.env);
	});

	it('states a cost for every check it can run', () => {
		for (const entry of PROVIDERS)
			expect(Boolean(entry.check)).toBe(Boolean(entry.check_cost));
	});

	it('finds providers by id or setting name', () => {
		expect(find_provider('tavily')?.env).toBe('TAVILY_API_KEY');
		expect(find_provider('exa_api_key')?.id).toBe('exa');
		expect(find_provider('nope')).toBeUndefined();
	});
});

describe('mask', () => {
	it('shows at most the last four characters of a key', () => {
		expect(mask(KEY, 'key')).toBe('••••cdef');
		expect(mask('short-key', 'key')).toBe('••••');
	});

	it('shows URLs in full', () => {
		expect(mask('http://127.0.0.1:8080', 'url')).toBe(
			'http://127.0.0.1:8080',
		);
	});
});

describe('normalize_origin', () => {
	it('trims whitespace and trailing slashes and keeps a path', () => {
		expect(normalize_origin('  http://127.0.0.1:8080/ ')).toBe(
			'http://127.0.0.1:8080',
		);
		expect(normalize_origin('https://search.example/searx//')).toBe(
			'https://search.example/searx',
		);
	});

	it.each([
		['not a url', 'full URL'],
		['ftp://example.com', 'http:// or https://'],
		['https://user:pass@example.com', 'credentials'],
	])('rejects %s', (value, message) => {
		expect(() => normalize_origin(value)).toThrow(message);
	});
});

describe('run_check', () => {
	it.each([
		[200, 'ok'],
		[401, 'invalid'],
		[403, 'invalid'],
		[402, 'no_credits'],
		[429, 'rate_limited'],
		[503, 'error'],
		[418, 'error'],
	] as const)(
		'classifies status %i as %s',
		async (status, expected) => {
			const result = await run_check(
				provider('tavily'),
				KEY,
				new Map(),
				responding(status),
			);
			expect(result.status).toBe(expected);
		},
	);

	it('sends the key in a header and echoes neither key nor body', async () => {
		const fetcher = responding(401);
		const result = await run_check(
			provider('tavily'),
			KEY,
			new Map(),
			fetcher,
		);
		const { url, init } = request(fetcher);
		expect(url).toBe('https://api.tavily.com/usage');
		expect(url).not.toContain(KEY);
		expect(new Headers(init.headers).get('authorization')).toBe(
			`Bearer ${KEY}`,
		);
		expect(init.redirect).toBe('error');
		expect(init.signal).toBeInstanceOf(AbortSignal);
		expect(JSON.stringify(result)).not.toContain(KEY);
		expect(JSON.stringify(result)).not.toContain(
			'body-must-not-leak',
		);
	});

	it('reports a failed connection without the cause', async () => {
		const fetcher = vi.fn<typeof fetch>(async () => {
			throw new TypeError(`connect ECONNREFUSED with ${KEY}`);
		});
		expect(
			await run_check(provider('tavily'), KEY, new Map(), fetcher),
		).toEqual({ status: 'unreachable', detail: 'could not connect' });
	});

	it('reports a timeout', async () => {
		const fetcher = vi.fn<typeof fetch>(async () => {
			throw new DOMException('timed out', 'TimeoutError');
		});
		expect(
			await run_check(provider('tavily'), KEY, new Map(), fetcher),
		).toEqual({
			status: 'unreachable',
			detail: 'no response within 10 s',
		});
	});

	it('warns when a GitHub token carries private repo scope', async () => {
		const result = await run_check(
			provider('github'),
			KEY,
			new Map(),
			responding(200, { 'x-oauth-scopes': 'read:user, repo' }),
		);
		expect(result.status).toBe('ok');
		expect(result.warning).toContain('private repo scope');
		const narrow = await run_check(
			provider('github'),
			KEY,
			new Map(),
			responding(200, { 'x-oauth-scopes': 'public_repo' }),
		);
		expect(narrow.warning).toBeUndefined();
	});

	it('asks SearXNG for JSON and explains a refusal', async () => {
		const ok = responding(200);
		expect(
			await run_check(
				provider('searxng'),
				'http://127.0.0.1:8080/',
				new Map(),
				ok,
			),
		).toEqual({ status: 'ok', detail: 'instance answered' });
		expect(request(ok).url).toBe(
			'http://127.0.0.1:8080/search?q=mcp-retriever&format=json',
		);
		const refused = await run_check(
			provider('searxng'),
			'http://127.0.0.1:8080',
			new Map(),
			responding(403),
		);
		expect(refused.status).toBe('error');
		expect(refused.detail).toContain('search.formats');
	});

	it('checks a self-hosted Firecrawl and tolerates a missing endpoint', async () => {
		const fetcher = responding(404);
		const result = await run_check(
			provider('firecrawl'),
			KEY,
			new Map([['FIRECRAWL_BASE_URL', 'http://10.0.0.5:3002/']]),
			fetcher,
		);
		expect(request(fetcher).url).toBe(
			'http://10.0.0.5:3002/v2/team/credit-usage',
		);
		expect(result.status).toBe('unchecked');
	});

	it('does not call out for a provider without a check', async () => {
		const fetcher = responding(200);
		const result = await run_check(
			provider('context_dev'),
			KEY,
			new Map(),
			fetcher,
		);
		expect(result.status).toBe('unchecked');
		expect(fetcher).not.toHaveBeenCalled();
	});

	it('turns a check that throws into an error result', async () => {
		const result = await run_check(
			provider('searxng'),
			'not a url',
			new Map(),
			responding(200),
		);
		expect(result.status).toBe('error');
		expect(result.detail).toContain('full URL');
	});
});
