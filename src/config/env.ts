// Environment variable configuration for the MCP Retriever server

// Search provider API keys
export const TAVILY_API_KEY = process.env.TAVILY_API_KEY;
export const BRAVE_API_KEY = process.env.BRAVE_API_KEY;
export const BRAVE_ANSWERS_API_KEY =
	process.env.BRAVE_ANSWERS_API_KEY;
export const GITHUB_API_KEY = process.env.GITHUB_API_KEY;
export const EXA_API_KEY = process.env.EXA_API_KEY;
export const YOU_API_KEY = process.env.YOU_API_KEY;
export const LINKUP_API_KEY = process.env.LINKUP_API_KEY;
export const CONTEXT_DEV_API_KEY = process.env.CONTEXT_DEV_API_KEY;
// A self-hosted SearXNG instance; no key, the operator's URL enables it.
export const SEARXNG_URL = process.env.SEARXNG_URL;

// Content processing API keys
export const FIRECRAWL_API_KEY = process.env.FIRECRAWL_API_KEY;
export const FIRECRAWL_BASE_URL = process.env.FIRECRAWL_BASE_URL;
export const FIRECRAWL_AGENT_URL = process.env.FIRECRAWL_AGENT_URL;

// Provider configuration
export const config = {
	search: {
		tavily: {
			api_key: TAVILY_API_KEY,
			base_url: 'https://api.tavily.com',
			timeout: 30000, // 30 seconds
		},
		brave: {
			api_key: BRAVE_API_KEY,
			base_url: 'https://api.search.brave.com/res/v1',
			timeout: 10000, // 10 seconds
		},
		github: {
			api_key: GITHUB_API_KEY,
			base_url: 'https://api.github.com',
			timeout: 20000, // 20 seconds
		},
		exa: {
			api_key: EXA_API_KEY,
			base_url: 'https://api.exa.ai',
			timeout: 30000, // 30 seconds
		},
		you: {
			api_key: YOU_API_KEY,
			base_url: 'https://api.you.com',
			timeout: 10000, // 10 seconds
		},
		context_dev: {
			api_key: CONTEXT_DEV_API_KEY,
			base_url: 'https://api.context.dev/v1',
			timeout: 60000,
		},
		brave_media: {
			api_key: BRAVE_API_KEY,
			base_url: 'https://api.search.brave.com/res/v1',
			timeout: 15000,
		},
		brave_news: {
			api_key: BRAVE_API_KEY,
			base_url: 'https://api.search.brave.com/res/v1',
			timeout: 15000,
		},
		searxng: {
			// Registered only when base_url is set; there is no credential.
			api_key: undefined as string | undefined,
			base_url: SEARXNG_URL,
			timeout: 15000,
		},
	},
	ai_response: {
		exa_answer: {
			api_key: EXA_API_KEY,
			base_url: 'https://api.exa.ai',
			timeout: 30000, // 30 seconds
		},
		exa_deep_research: {
			api_key: EXA_API_KEY,
			base_url: 'https://api.exa.ai',
			timeout: 70000, // Exa deep-reasoning can take up to ~60 seconds
		},
		linkup: {
			api_key: LINKUP_API_KEY,
			base_url: 'https://api.linkup.so/v1',
			timeout: 30000, // 30 seconds
		},
		brave_answers: {
			api_key: BRAVE_ANSWERS_API_KEY || BRAVE_API_KEY,
			base_url:
				'https://api.search.brave.com/res/v1/chat/completions',
			timeout: 30000,
		},
		tavily_research: {
			api_key: TAVILY_API_KEY,
			base_url: 'https://api.tavily.com',
			timeout: 120000, // 2 minutes for deep research
		},
	},
	processing: {
		tavily_extract: {
			api_key: TAVILY_API_KEY,
			base_url: 'https://api.tavily.com',
			timeout: 30000, // 30 seconds
		},
		firecrawl_scrape: {
			api_key: FIRECRAWL_API_KEY,
			base_url: FIRECRAWL_BASE_URL
				? `${FIRECRAWL_BASE_URL}/v2/scrape`
				: 'https://api.firecrawl.dev/v2/scrape',
			timeout: 60000, // 60 seconds - web scraping can take longer
		},
		firecrawl_crawl: {
			api_key: FIRECRAWL_API_KEY,
			base_url: FIRECRAWL_BASE_URL
				? `${FIRECRAWL_BASE_URL}/v2/crawl`
				: 'https://api.firecrawl.dev/v2/crawl',
			timeout: 120000, // 120 seconds - crawling can take even longer
		},
		firecrawl_map: {
			api_key: FIRECRAWL_API_KEY,
			base_url: FIRECRAWL_BASE_URL
				? `${FIRECRAWL_BASE_URL}/v2/map`
				: 'https://api.firecrawl.dev/v2/map',
			timeout: 60000, // 60 seconds
		},
		firecrawl_extract: {
			api_key: FIRECRAWL_API_KEY,
			base_url: FIRECRAWL_BASE_URL
				? `${FIRECRAWL_BASE_URL}/v2/extract`
				: 'https://api.firecrawl.dev/v2/extract',
			timeout: 60000, // 60 seconds
		},
		firecrawl_actions: {
			api_key: FIRECRAWL_API_KEY,
			base_url: FIRECRAWL_BASE_URL
				? `${FIRECRAWL_BASE_URL}/v2/scrape`
				: 'https://api.firecrawl.dev/v2/scrape',
			timeout: 90000, // 90 seconds - actions can take longer
		},
		exa_contents: {
			api_key: EXA_API_KEY,
			base_url: 'https://api.exa.ai',
			timeout: 30000, // 30 seconds
		},
		exa_similar: {
			api_key: EXA_API_KEY,
			base_url: 'https://api.exa.ai',
			timeout: 30000, // 30 seconds
		},
		brave_llm_context: {
			api_key: BRAVE_API_KEY,
			base_url: 'https://api.search.brave.com/res/v1/llm/context',
			timeout: 30000,
		},
		firecrawl_agent: {
			api_key: FIRECRAWL_API_KEY,
			override_url: FIRECRAWL_AGENT_URL,
			base_url: FIRECRAWL_BASE_URL
				? `${FIRECRAWL_BASE_URL}/v2/agent`
				: 'https://api.firecrawl.dev/v2/agent',
			timeout: 180000, // 3 minutes for agent tasks
		},
		firecrawl_search: {
			api_key: FIRECRAWL_API_KEY,
			base_url: FIRECRAWL_BASE_URL
				? `${FIRECRAWL_BASE_URL}/v2/search`
				: 'https://api.firecrawl.dev/v2/search',
			timeout: 60000,
		},
	},
};

// Validate required environment variables
export const validate_config = () => {
	const missing_keys: string[] = [];
	const available_keys: string[] = [];

	// Check search provider keys
	if (!TAVILY_API_KEY) missing_keys.push('TAVILY_API_KEY');
	else available_keys.push('TAVILY_API_KEY');

	if (!BRAVE_API_KEY) missing_keys.push('BRAVE_API_KEY');
	else available_keys.push('BRAVE_API_KEY');

	if (!GITHUB_API_KEY) missing_keys.push('GITHUB_API_KEY');
	else available_keys.push('GITHUB_API_KEY');

	if (!FIRECRAWL_API_KEY) missing_keys.push('FIRECRAWL_API_KEY');
	else available_keys.push('FIRECRAWL_API_KEY');

	if (!EXA_API_KEY) missing_keys.push('EXA_API_KEY');
	else available_keys.push('EXA_API_KEY');

	if (!LINKUP_API_KEY) missing_keys.push('LINKUP_API_KEY');
	else available_keys.push('LINKUP_API_KEY');

	if (!CONTEXT_DEV_API_KEY) missing_keys.push('CONTEXT_DEV_API_KEY');
	else available_keys.push('CONTEXT_DEV_API_KEY');

	// Log available keys
	if (available_keys.length > 0) {
		console.error(`Found API keys for: ${available_keys.join(', ')}`);
	} else {
		console.error(
			'Warning: No API keys found. No providers will be available.',
		);
	}

	// Log missing keys as informational
	if (missing_keys.length > 0) {
		console.warn(
			`Missing API keys for: ${missing_keys.join(
				', ',
			)}. Some providers will not be available.`,
		);
	}
};
