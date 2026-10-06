/**
 * Provider catalog and key checks for the setup TUI. Checks use the
 * cheapest documented call per provider. Free checks run
 * automatically; checks that spend a billable request only run after
 * explicit consent. Responses are classified by status code only:
 * bodies and keys are never echoed.
 */

export type CheckStatus =
	| 'ok'
	| 'invalid'
	| 'no_credits'
	| 'rate_limited'
	| 'unreachable'
	| 'error'
	| 'unchecked';

export interface CheckResult {
	status: CheckStatus;
	detail: string;
	warning?: string;
}

type Values = ReadonlyMap<string, string>;

export interface ProviderSpec {
	id: string;
	name: string;
	env: string;
	kind: 'key' | 'url';
	unlocks: string;
	signup: string;
	/** `free`, or a description of what the check costs. */
	check_cost?: string;
	check?: (
		value: string,
		values: Values,
		fetcher: typeof fetch,
	) => Promise<CheckResult>;
}

const TIMEOUT_MS = 10_000;

const classify = (status: number): CheckResult => {
	if (status >= 200 && status < 300)
		return { status: 'ok', detail: 'key accepted' };
	if (status === 401)
		return { status: 'invalid', detail: 'key rejected (401)' };
	if (status === 403)
		return {
			status: 'invalid',
			detail: 'key not allowed for this API (403)',
		};
	if (status === 402)
		return {
			status: 'no_credits',
			detail: 'key valid but out of credits or no plan (402)',
		};
	if (status === 429)
		return {
			status: 'rate_limited',
			detail: 'rate limited (429); the key is probably fine',
		};
	if (status >= 500)
		return {
			status: 'error',
			detail: `provider error (${status}); try again later`,
		};
	return { status: 'error', detail: `unexpected status ${status}` };
};

const probe = async (
	fetcher: typeof fetch,
	url: string,
	init: RequestInit,
): Promise<{ result: CheckResult; response?: Response }> => {
	try {
		const response = await fetcher(url, {
			...init,
			redirect: 'error',
			signal: AbortSignal.timeout(TIMEOUT_MS),
		});
		// Drain without reading the body into any message.
		await response.body?.cancel().catch(() => {});
		return { result: classify(response.status), response };
	} catch (error) {
		const timed_out =
			error instanceof Error && error.name === 'TimeoutError';
		return {
			result: {
				status: 'unreachable',
				detail: timed_out
					? 'no response within 10 s'
					: 'could not connect',
			},
		};
	}
};

const bearer = (key: string) => ({
	Authorization: `Bearer ${key}`,
	Accept: 'application/json',
});

/** Accepts only http(s) origins without credentials or paths. */
export const normalize_origin = (raw: string): string => {
	let url: URL;
	try {
		url = new URL(raw.trim());
	} catch {
		throw new Error('enter a full URL, e.g. http://127.0.0.1:8080');
	}
	if (url.protocol !== 'http:' && url.protocol !== 'https:')
		throw new Error('use an http:// or https:// URL');
	if (url.username || url.password)
		throw new Error('do not put credentials in the URL');
	const path = url.pathname.replace(/\/+$/, '');
	return `${url.origin}${path}`;
};

export const PROVIDERS: readonly ProviderSpec[] = [
	{
		id: 'searxng',
		name: 'SearXNG',
		env: 'SEARXNG_URL',
		kind: 'url',
		unlocks: 'web search through your own SearXNG instance, no key',
		signup: 'https://docs.searxng.org',
		check_cost: 'free',
		check: async (value, _values, fetcher) => {
			const origin = normalize_origin(value);
			const { result, response } = await probe(
				fetcher,
				`${origin}/search?q=mcp-retriever&format=json`,
				{ headers: { Accept: 'application/json' } },
			);
			if (response?.status === 403)
				return {
					status: 'error',
					detail:
						'instance refused JSON output; add json to search.formats',
				};
			if (result.status === 'ok')
				return { status: 'ok', detail: 'instance answered' };
			return result;
		},
	},
	{
		id: 'github',
		name: 'GitHub',
		env: 'GITHUB_API_KEY',
		kind: 'key',
		unlocks: 'code, repository and user search',
		signup: 'https://github.com/settings/personal-access-tokens',
		check_cost: 'free',
		check: async (value, _values, fetcher) => {
			const { result, response } = await probe(
				fetcher,
				'https://api.github.com/rate_limit',
				{
					headers: {
						...bearer(value),
						'X-GitHub-Api-Version': '2022-11-28',
					},
				},
			);
			const scopes = (response?.headers.get('x-oauth-scopes') ?? '')
				.split(',')
				.map((scope) => scope.trim());
			if (result.status === 'ok' && scopes.includes('repo'))
				return {
					...result,
					warning:
						'token has private repo scope; public search only needs public access',
				};
			return result;
		},
	},
	{
		id: 'tavily',
		name: 'Tavily',
		env: 'TAVILY_API_KEY',
		kind: 'key',
		unlocks: 'search, extraction and research',
		signup: 'https://app.tavily.com',
		check_cost: 'free',
		check: async (value, _values, fetcher) =>
			(
				await probe(fetcher, 'https://api.tavily.com/usage', {
					headers: bearer(value),
				})
			).result,
	},
	{
		id: 'brave',
		name: 'Brave Search',
		env: 'BRAVE_API_KEY',
		kind: 'key',
		unlocks: 'web, news, media, LLM context and answers',
		signup: 'https://api-dashboard.search.brave.com',
		check_cost: 'one search query from your plan',
		check: async (value, _values, fetcher) =>
			(
				await probe(
					fetcher,
					'https://api.search.brave.com/res/v1/web/search?q=mcp&count=1',
					{
						headers: {
							'X-Subscription-Token': value,
							Accept: 'application/json',
						},
					},
				)
			).result,
	},
	{
		id: 'exa',
		name: 'Exa',
		env: 'EXA_API_KEY',
		kind: 'key',
		unlocks: 'neural search, answers, deep research, contents',
		signup: 'https://dashboard.exa.ai',
		check_cost: 'one billable Exa search',
		check: async (value, _values, fetcher) =>
			(
				await probe(fetcher, 'https://api.exa.ai/search', {
					method: 'POST',
					headers: {
						'x-api-key': value,
						'Content-Type': 'application/json',
						Accept: 'application/json',
					},
					body: JSON.stringify({ query: 'mcp', numResults: 1 }),
				})
			).result,
	},
	{
		id: 'firecrawl',
		name: 'Firecrawl',
		env: 'FIRECRAWL_API_KEY',
		kind: 'key',
		unlocks: 'scrape, crawl, map, extract and agent tasks',
		signup: 'https://www.firecrawl.dev/app/api-keys',
		check_cost: 'free',
		check: async (value, values, fetcher) => {
			const base = (
				values.get('FIRECRAWL_BASE_URL') ||
				'https://api.firecrawl.dev'
			).replace(/\/+$/, '');
			const { result, response } = await probe(
				fetcher,
				`${base}/v2/team/credit-usage`,
				{ headers: bearer(value) },
			);
			if (response?.status === 404)
				return {
					status: 'unchecked',
					detail: 'this Firecrawl instance has no usage endpoint',
				};
			return result;
		},
	},
	{
		id: 'linkup',
		name: 'Linkup',
		env: 'LINKUP_API_KEY',
		kind: 'key',
		unlocks: 'sourced answers',
		signup: 'https://app.linkup.so',
		check_cost: 'free',
		check: async (value, _values, fetcher) =>
			(
				await probe(
					fetcher,
					'https://api.linkup.so/v1/credits/balance',
					{ headers: bearer(value) },
				)
			).result,
	},
	{
		id: 'you',
		name: 'You.com',
		env: 'YOU_API_KEY',
		kind: 'key',
		unlocks: 'web search fallback',
		signup: 'https://you.com',
		check_cost: 'one billable You.com search',
		check: async (value, _values, fetcher) =>
			(
				await probe(
					fetcher,
					'https://api.you.com/v1/search?query=mcp&count=1',
					{ headers: bearer(value) },
				)
			).result,
	},
	{
		id: 'context_dev',
		name: 'Context.dev',
		env: 'CONTEXT_DEV_API_KEY',
		kind: 'key',
		unlocks: 'scraping, brand intel, style guides, classification',
		signup: 'https://www.context.dev',
	},
	{
		id: 'brave_answers',
		name: 'Brave Answers (separate key)',
		env: 'BRAVE_ANSWERS_API_KEY',
		kind: 'key',
		unlocks: 'only if your Answers plan uses its own key',
		signup: 'https://api-dashboard.search.brave.com',
	},
];

export const find_provider = (id: string): ProviderSpec | undefined =>
	PROVIDERS.find(
		(provider) =>
			provider.id === id || provider.env === id.toUpperCase(),
	);

export const run_check = async (
	provider: ProviderSpec,
	value: string,
	values: Values,
	fetcher: typeof fetch = fetch,
): Promise<CheckResult> => {
	if (!provider.check)
		return {
			status: 'unchecked',
			detail: 'no free check available; saved without testing',
		};
	try {
		return await provider.check(value, values, fetcher);
	} catch (error) {
		return {
			status: 'error',
			detail: error instanceof Error ? error.message : 'check failed',
		};
	}
};

/** Shows at most the last four characters of long secrets. */
export const mask = (value: string, kind: 'key' | 'url'): string => {
	if (kind === 'url') return value;
	if (value.length < 16) return '••••';
	return `••••${value.slice(-4)}`;
};
