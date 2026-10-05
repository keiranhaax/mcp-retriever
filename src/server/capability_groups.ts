export const capability_groups = [
	'research',
	'media',
	'business',
	'automation',
] as const;
export type CapabilityGroup = (typeof capability_groups)[number];

// Mixed-purpose legacy tools require every group they can invoke.
// Result retrieval remains available so retained evidence stays recoverable.
export const tool_groups: Record<string, readonly CapabilityGroup[]> =
	{
		result_read: [],
		web_search: ['research'],
		web_search_fused: ['research'],
		github_search: ['research'],
		ai_search: ['research'],
		search_and_read: ['research'],
		brave_llm_context: ['research'],
		brave_news_search: ['research'],
		brave_media_search: ['media'],
		web_extract: ['research', 'media', 'automation'],
		context_web_extract: ['research', 'media', 'automation'],
		firecrawl_agent: ['automation'],
		context_brand_intel: ['business'],
		context_styleguide: ['business'],
		context_classify: ['business'],
		context_transaction_identify: ['business'],
		web_read: ['research'],
		web_crawl: ['automation'],
		web_map: ['automation'],
	};

export const configured_tool_groups = (
	raw = process.env.RETRIEVER_TOOL_GROUPS,
): ReadonlySet<CapabilityGroup> => {
	if (raw === undefined || raw === 'all')
		return new Set(capability_groups);
	if (raw === 'none') return new Set();
	const groups = raw.split(',').map((group) => group.trim());
	if (
		raw.length > 256 ||
		!groups.length ||
		groups.some(
			(group) =>
				!(capability_groups as readonly string[]).includes(group),
		)
	)
		throw new Error(
			'Invalid RETRIEVER_TOOL_GROUPS: use all, none, or a comma-separated list of research, media, business, automation',
		);
	return new Set(groups as CapabilityGroup[]);
};

export const tool_allowed = (
	name: string,
	enabled: ReadonlySet<CapabilityGroup>,
): boolean => {
	const required = Object.hasOwn(tool_groups, name)
		? tool_groups[name]
		: undefined;
	return (
		required !== undefined &&
		required.every((group) => enabled.has(group))
	);
};
