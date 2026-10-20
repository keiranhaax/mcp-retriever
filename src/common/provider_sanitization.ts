// These projections apply only to provider-owned envelopes. Source text,
// extracted JSON, and source URLs are evidence, not credential dictionaries.
const is_record = (
	value: unknown,
): value is Record<string, unknown> =>
	typeof value === 'object' &&
	value !== null &&
	!Array.isArray(value);

const bounded_number = (
	value: unknown,
	max = Number.MAX_SAFE_INTEGER,
): value is number =>
	typeof value === 'number' &&
	Number.isFinite(value) &&
	value >= 0 &&
	value <= max;

const safe_id = (value: unknown): string | undefined =>
	typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value)
		? value
		: undefined;

const http_status = (value: unknown): value is number =>
	bounded_number(value, 599) &&
	Number.isInteger(value) &&
	value >= 100;

const pick_strings = (
	raw: Record<string, unknown>,
	keys: readonly string[],
) => {
	const result: Record<string, string | null> = {};
	for (const key of keys) {
		if (
			Object.hasOwn(raw, key) &&
			(typeof raw[key] === 'string' || raw[key] === null)
		)
			result[key] = raw[key];
	}
	return result;
};

export interface ExaControlMetadata {
	requestId?: string;
	autopromptString?: string;
	resolvedSearchType?: string;
	costDollars?: {
		total?: number;
		search?: Partial<Record<'neural' | 'keyword', number>>;
		contents?: Partial<
			Record<'text' | 'highlights' | 'summary', number>
		>;
	};
}

const exa_search_types = new Set([
	'auto',
	'lite',
	'neural',
	'keyword',
	'fast',
	'instant',
	'deep-lite',
	'deep',
	'deep-reasoning',
]);

export const sanitize_exa_control_metadata = (
	value: unknown,
): ExaControlMetadata => {
	const raw = is_record(value) ? value : {};
	// Keep the legacy optional property; JSON still omits undefined IDs.
	const result: ExaControlMetadata = {
		requestId: safe_id(raw.requestId),
	};
	if (
		typeof raw.autopromptString === 'string' &&
		raw.autopromptString.length > 0 &&
		raw.autopromptString.length <= 4096
	) {
		result.autopromptString = raw.autopromptString;
	}
	for (const mode of [raw.resolvedSearchType, raw.searchType]) {
		if (typeof mode === 'string' && exa_search_types.has(mode)) {
			result.resolvedSearchType = mode;
			break;
		}
	}
	if (is_record(raw.costDollars)) {
		const cost: NonNullable<ExaControlMetadata['costDollars']> = {};
		if (bounded_number(raw.costDollars.total))
			cost.total = raw.costDollars.total;
		// The local provider fixtures report search.neural and contents.text;
		// preserve their related numeric cost categories, never raw diagnostics.
		for (const [key, fields] of [
			['search', ['neural', 'keyword']],
			['contents', ['text', 'highlights', 'summary']],
		] as const) {
			const raw_group = raw.costDollars[key];
			if (!is_record(raw_group)) continue;
			const group: Record<string, number> = {};
			for (const field of fields) {
				if (bounded_number(raw_group[field]))
					group[field] = raw_group[field];
			}
			if (Object.keys(group).length) cost[key] = group;
		}
		if (Object.keys(cost).length) result.costDollars = cost;
	}
	return result;
};

// Citation strings are source evidence, just like the corresponding Exa
// result fields. Do not strip queries, tokens in examples, or citation IDs.
const exa_citation_fields = [
	'id',
	'url',
	'title',
	'text',
	'author',
	'publishedDate',
	'image',
	'favicon',
] as const;

export const sanitize_exa_grounding = (
	value: unknown,
): unknown[] | undefined => {
	if (!Array.isArray(value)) return undefined;
	return value.filter(is_record).map((raw) => {
		const result: Record<string, unknown> = {};
		if (typeof raw.field === 'string') result.field = raw.field;
		if (bounded_number(raw.confidence, 1))
			result.confidence = raw.confidence;
		if (Array.isArray(raw.citations)) {
			result.citations = raw.citations.flatMap<unknown>(
				(citation) => {
					if (
						typeof citation === 'string' ||
						(bounded_number(citation) && Number.isInteger(citation))
					)
						return [citation];
					return is_record(citation)
						? [pick_strings(citation, exa_citation_fields)]
						: [];
				},
			);
		}
		return result;
	});
};

export const sanitize_exa_output = (value: unknown): unknown => {
	// Legacy non-envelope output is extracted user data. Only the known
	// {content, grounding} envelope has provider-owned siblings to project.
	if (!is_record(value) || !Object.hasOwn(value, 'content'))
		return value;
	const result: Record<string, unknown> = { content: value.content };
	const grounding = sanitize_exa_grounding(value.grounding);
	if (grounding !== undefined) result.grounding = grounding;
	return result;
};

interface ExaContentStatus {
	id: string;
	status: 'success' | 'error';
	source?: 'cached' | 'crawled';
	error?: { tag?: string; httpStatusCode?: number | null } | null;
}

export const sanitize_exa_statuses = (
	value: unknown,
): ExaContentStatus[] | undefined => {
	if (!Array.isArray(value)) return undefined;
	return value.flatMap((raw) => {
		if (
			!is_record(raw) ||
			typeof raw.id !== 'string' ||
			(raw.status !== 'success' && raw.status !== 'error')
		)
			return [];
		// IDs here identify evidence (often URLs), not transport requests.
		const result: ExaContentStatus = {
			id: raw.id,
			status: raw.status,
		};
		if (raw.source === 'cached' || raw.source === 'crawled')
			result.source = raw.source;
		if (raw.error === null) result.error = null;
		else if (is_record(raw.error)) {
			result.error = {};
			if (
				typeof raw.error.tag === 'string' &&
				/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(raw.error.tag)
			)
				result.error.tag = raw.error.tag;
			if (
				raw.error.httpStatusCode === null ||
				http_status(raw.error.httpStatusCode)
			)
				result.error.httpStatusCode = raw.error.httpStatusCode;
		}
		return [result];
	});
};

export interface SanitizedFirecrawlDocument {
	markdown?: string;
	summary?: string;
	html?: string;
	rawHtml?: string;
	screenshot?: string;
	answer?: string | null;
	highlights?: string | null;
	links?: string[];
	json?: unknown;
	llm_extraction?: unknown;
	metadata?: Record<string, unknown>;
	warning?: string | null;
}

const firecrawl_page_fields = [
	'title',
	'description',
	'author',
	'language',
	'sourceURL',
	'url',
	'contentType',
	'keywords',
	'robots',
	'favicon',
	'ogTitle',
	'ogDescription',
	'ogUrl',
	'ogImage',
	'ogSiteName',
	'publishedTime',
	'modifiedTime',
] as const;

const sanitize_firecrawl_metadata = (
	raw: Record<string, unknown>,
) => {
	const result: Record<string, unknown> = pick_strings(
		raw,
		firecrawl_page_fields,
	);
	if (http_status(raw.statusCode)) result.statusCode = raw.statusCode;
	const scrape_id = safe_id(raw.scrapeId);
	if (scrape_id !== undefined) result.scrapeId = scrape_id;
	for (const key of ['creditsUsed', 'pageCount'] as const) {
		if (bounded_number(raw[key]) && Number.isInteger(raw[key]))
			result[key] = raw[key];
	}
	if (raw.cacheState === 'hit' || raw.cacheState === 'miss')
		result.cacheState = raw.cacheState;
	if (raw.proxyUsed === 'basic' || raw.proxyUsed === 'stealth')
		result.proxyUsed = raw.proxyUsed;
	if (
		typeof raw.cachedAt === 'string' &&
		/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(
			raw.cachedAt,
		) &&
		Number.isFinite(Date.parse(raw.cachedAt))
	)
		result.cachedAt = raw.cachedAt;
	return result;
};

export const sanitize_firecrawl_document = (
	value: unknown,
): SanitizedFirecrawlDocument => {
	const raw = is_record(value) ? value : {};
	const result: SanitizedFirecrawlDocument = {};
	for (const key of [
		'markdown',
		'summary',
		'html',
		'rawHtml',
		'screenshot',
	] as const) {
		if (typeof raw[key] === 'string') result[key] = raw[key];
	}
	for (const key of ['answer', 'highlights'] as const) {
		if (typeof raw[key] === 'string' || raw[key] === null)
			result[key] = raw[key];
	}
	if (Array.isArray(raw.links))
		result.links = raw.links.filter(
			(link): link is string => typeof link === 'string',
		);
	for (const key of ['json', 'llm_extraction'] as const) {
		if (Object.hasOwn(raw, key)) result[key] = raw[key];
	}
	if (is_record(raw.metadata))
		result.metadata = sanitize_firecrawl_metadata(raw.metadata);
	// Arbitrary warning/error text may echo credentials or request config.
	// Preserve the warning signal, never the diagnostic payload.
	if (raw.warning === null || raw.warning === '')
		result.warning = raw.warning;
	else if (raw.warning !== undefined)
		result.warning = 'Provider reported a scrape warning';
	return result;
};
