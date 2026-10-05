export const tool_descriptions = {
	web_search:
		'Search: find web pages, articles, or data. Use Brave for operators, Exa for semantic or deep search, Tavily for factual results, and You.com as a fast fallback.',
	github_search:
		'Search GitHub: find code, repositories, or users. Supports filename:, path:, repo:, user:, language:, and in:file syntax.',
	ai_search:
		'Answer/Research: synthesized answers from Exa, Tavily, or Linkup; Brave Answers provides plain-text grounding without inline citations.',
	web_extract:
		'Extract/Process: read or process known URLs. Firecrawl handles scrape/summarize/crawl/map/extract/actions/search; Exa handles contents/similar; Tavily extracts.',
	brave_llm_context:
		'Research Context/RAG: retrieve LLM-ready grounding chunks from Brave. Use for dense context, not ordinary link search.',
	brave_news_search:
		'News Search: find recent news articles with freshness, pagination, country/language, SafeSearch, and snippets.',
	brave_media_search:
		'Media Search: find Brave image or video results with SafeSearch and country/language filters. Use only when visual media results are needed.',
	firecrawl_agent:
		'Autonomous Web Agent: Credit-sensitive; start a web task (default cap 100 credits), then use action=status or cancel with job_id. Repeating start creates a new paid job. Prefer search/extract for simple tasks.',
	context_web_extract:
		'Context.dev Web: scrape markdown/HTML/images/screenshots, crawl pages, get sitemaps, or web-search with optional markdown scraping.',
	context_brand_intel:
		'Context.dev Brand: retrieve brand/company intelligence such as logos, colors, socials, descriptions, industries, and domain/company/ticker matches.',
	context_styleguide:
		'Context.dev Design: extract styleguide signals and optional fonts for a domain or direct URL.',
	context_classify:
		'Context.dev Business: classify companies by NAICS, SIC, or EIC using domain or company name.',
	context_transaction_identify:
		'Context.dev Transactions: identify messy bank/card transaction descriptors as real brands or companies.',
} as const;

export type RetrieverToolName = keyof typeof tool_descriptions;

export const describe_ai_search = (
	provider_names: string[],
): string => {
	const available = new Set(provider_names);
	const hints: string[] = [];
	if (
		available.has('exa_answer') &&
		available.has('exa_deep_research')
	) {
		hints.push('Exa for fast or deep research');
	} else if (available.has('exa_answer')) {
		hints.push('Exa for fast answers');
	} else if (available.has('exa_deep_research')) {
		hints.push('Exa for deep research');
	}
	if (available.has('brave_answers')) {
		hints.push('Brave Answers for plain-text grounded answers');
	}
	if (available.has('tavily_research')) {
		hints.push(
			'Tavily for research; use action=status with request_id to resume without creating another paid job',
		);
	}
	if (available.has('linkup')) {
		hints.push('Linkup for sourced answers');
	}
	const use = hints.length ? ` Use ${hints.join(', ')}.` : '';
	return `Answer/Research: get synthesized answers; citation availability depends on the provider.${use}`;
};
