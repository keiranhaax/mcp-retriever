import {
	get_result_storage_limit,
	store_result,
} from './result_store.js';
import { ErrorType, ProviderError } from './types.js';
import { create_error_response, retention_error } from './errors.js';
import { get_job_failure, set_job_failure } from './job_state.js';
import {
	copy_response_metadata,
	get_response_metadata,
} from './response_metadata.js';

const CHARS_PER_TOKEN = 4;
const MAX_SAFE_TOKENS = 20000;
const MAX_SAFE_BYTES = MAX_SAFE_TOKENS * CHARS_PER_TOKEN;

export interface Section {
	title: string;
	line: number;
}

export interface LargeResultResponse {
	result_id: string;
	total_lines: number;
	estimated_tokens: number;
	expires_at: string;
	sections: Section[];
	sections_truncated: boolean;
	read_hint: string;
	metadata?: Record<string, unknown>;
}

interface FormatResult {
	text: string;
	sections: Section[];
	sections_truncated: boolean;
	total_lines: number;
}

const byte_prefix = (value: string, max_bytes: number): string => {
	const bytes = Buffer.from(value);
	let end = Math.min(bytes.length, max_bytes);
	while (end < bytes.length && (bytes[end] & 0xc0) === 0x80) end--;
	return bytes.toString('utf8', 0, end);
};

const format_as_text = (
	result: Record<string, unknown>,
	json: string,
): FormatResult => {
	const lines: string[] = [];
	const sections: Section[] = [];
	let current_line = 1;
	let section_bytes = 0;
	let sections_truncated = false;
	const add_section = (title: string) => {
		const bounded_title = byte_prefix(title, 256);
		if (bounded_title !== title) sections_truncated = true;
		const section = { title: bounded_title, line: current_line };
		const bytes =
			Buffer.byteLength(JSON.stringify(section, null, 2)) + 32;
		if (section_bytes + bytes > 4000) {
			sections_truncated = true;
			return;
		}
		section_bytes += bytes;
		sections.push(section);
	};

	const add_line = (line: string) => {
		if (line.startsWith('URL: ')) {
			add_section(line);
		} else if (line.startsWith('# ')) {
			add_section(line.slice(2));
		} else if (line.startsWith('## ')) {
			add_section(line.slice(3));
		} else if (line.startsWith('### ')) {
			add_section(line.slice(4));
		}
		lines.push(line);
		current_line++;
	};

	const add_content = (content: string) => {
		const content_lines = content.split('\n');
		for (const line of content_lines) {
			add_line(line);
		}
	};

	const raw_contents = result.raw_contents as
		| Array<{ url: string; content: string }>
		| undefined;

	if (raw_contents?.length && typeof result.content !== 'string') {
		for (const item of raw_contents) {
			add_line('='.repeat(80));
			add_line(`URL: ${item.url}`);
			add_line('='.repeat(80));
			if (item.content) {
				add_content(item.content);
			}
			add_line('');
		}
	}
	if (typeof result.content === 'string') add_content(result.content);

	if (result.metadata) {
		add_line('');
		add_line('='.repeat(80));
		add_section('METADATA');
		add_line('METADATA');
		add_line('='.repeat(80));
		add_content(JSON.stringify(result.metadata, null, 2));
	}

	// The readable view is only an aid; the canonical copy keeps every
	// JSON field (including siblings and per-URL metadata) losslessly.
	add_line('');
	add_section('FULL RESULT JSON');
	add_line('FULL RESULT JSON');
	add_content(json);

	return {
		text: lines.join('\n'),
		sections,
		sections_truncated,
		total_lines: current_line - 1,
	};
};

export const handle_large_result = <T>(
	result: T,
	_provider_name: string,
	options: { force_storage?: boolean } = {},
): T | LargeResultResponse => {
	const json = JSON.stringify(result, null, 2);
	const char_count = json.length;

	// MCP carries this JSON as text inside another JSON envelope.
	const payload = JSON.stringify({
		content: [{ type: 'text', text: json }],
	});
	if (
		!options.force_storage &&
		Buffer.byteLength(payload, 'utf8') <= MAX_SAFE_BYTES
	) {
		return result;
	}

	// Do not construct a second, optional view for already-oversized JSON.
	// Compression stores the exact canonical JSON, not a lossy projection.
	const storage_limit = get_result_storage_limit();
	const canonical_bytes = Buffer.byteLength(json);
	let { text, sections, sections_truncated } =
		canonical_bytes > storage_limit
			? {
					text: json,
					sections: [{ title: 'FULL RESULT JSON', line: 1 }],
					sections_truncated: true,
				}
			: format_as_text(result as Record<string, unknown>, json);
	if (
		canonical_bytes <= storage_limit &&
		Buffer.byteLength(text) > storage_limit
	) {
		// The readable view is optional; never reject a canonical result
		// that fits simply because its content was repeated for navigation.
		text = `\nFULL RESULT JSON\n${json}`;
		const bare_json =
			Buffer.byteLength(text) > get_result_storage_limit();
		if (bare_json) text = json;
		sections = [
			{ title: 'FULL RESULT JSON', line: bare_json ? 1 : 2 },
		];
		sections_truncated = true;
	}
	const stored = store_result(text);

	const result_obj = result as Record<string, unknown>;
	const metadata = result_obj.metadata as
		| Record<string, unknown>
		| undefined;
	const word_count =
		typeof metadata?.word_count === 'number'
			? metadata.word_count
			: 'unknown';
	const urls_processed =
		typeof metadata?.urls_processed === 'number'
			? metadata.urls_processed
			: 'unknown';

	return {
		result_id: stored.result_id,
		total_lines: stored.total_lines,
		estimated_tokens: Math.round(char_count / CHARS_PER_TOKEN),
		expires_at: stored.expires_at,
		sections,
		sections_truncated,
		read_hint: `Call result_read with result_id="${stored.result_id}", offset=LINE_NUMBER, limit=50. Follow next_offset and next_byte_offset (as byte_offset) when present. The stored FULL RESULT JSON preserves every field.`,
		metadata: {
			word_count,
			urls_processed,
			source_provider:
				typeof result_obj.source_provider === 'string'
					? byte_prefix(result_obj.source_provider, 128)
					: undefined,
		},
	};
};

export interface ProcessedUrlResult {
	url: string;
	content: string;
	metadata?: any;
	success: boolean;
	error?: string;
}

const async_result_bytes = (
	text: string,
	metadata: Record<string, unknown>,
	local_completeness: string,
	failed: boolean,
) =>
	Buffer.byteLength(
		JSON.stringify({
			_meta: { retriever: { ...metadata, local_completeness } },
			content: [{ type: 'text', text }],
			...(failed ? { isError: true } : {}),
		}),
	);

export const present_job_result = (
	result: object,
	provider: string,
	operation: string,
	metadata: Record<string, unknown>,
) => {
	try {
		let presented = handle_large_result(result, operation);
		let local_completeness =
			'result_id' in presented ? 'retained' : 'complete';
		let text = JSON.stringify(presented, null, 2);
		if (
			async_result_bytes(text, metadata, local_completeness, false) >
			MAX_SAFE_BYTES
		) {
			presented = handle_large_result(result, operation, {
				force_storage: true,
			});
			local_completeness = 'retained';
			text = JSON.stringify(presented, null, 2);
		}
		return { text, local_completeness };
	} catch (failure) {
		const reported = get_response_metadata(result);
		const job = reported?.job;
		const error = retention_error(
			provider,
			failure,
			job
				? provider === 'tavily_research'
					? { request_id: job.id }
					: { job_id: job.id }
				: {},
		);
		copy_response_metadata(result, error);
		if (job) set_job_failure(error, job);
		throw error;
	}
};

export const present_job_error = (
	error: unknown,
	operation: string,
	metadata: Record<string, unknown> = {},
) => {
	const message = create_error_response(error, {
		include_recovery: true,
	}).error;
	const failure = get_job_failure(error);
	const storage_failed =
		error instanceof ProviderError &&
		error.details?.cause === 'storage';
	if (!failure)
		return {
			text: message,
			local_completeness: storage_failed ? 'unavailable' : 'complete',
		};
	try {
		if (storage_failed) throw error;
		let result =
			failure.result === undefined
				? undefined
				: handle_large_result(failure.result, operation);
		let retained =
			result && typeof result === 'object' && 'result_id' in result;
		const render = () =>
			JSON.stringify(
				{
					error: message,
					job: failure.job,
					...(result !== undefined ? { result } : {}),
				},
				null,
				2,
			);
		let text = render();
		if (
			failure.result !== undefined &&
			async_result_bytes(
				text,
				metadata,
				retained ? 'retained' : 'complete',
				true,
			) > MAX_SAFE_BYTES
		) {
			result = handle_large_result(failure.result, operation, {
				force_storage: true,
			});
			retained = true;
			text = render();
		}
		return {
			text,
			local_completeness: retained ? 'retained' : 'complete',
		};
	} catch {
		return {
			text: JSON.stringify(
				{
					error: message,
					job: failure.job,
					warning:
						'Partial evidence could not be retained; no result handle was issued.',
				},
				null,
				2,
			),
			local_completeness: 'unavailable',
		};
	}
};

export const aggregate_url_results = (
	results: ProcessedUrlResult[],
	provider_name: string,
	urls: string[],
	extract_depth: 'basic' | 'advanced',
) => {
	const successful_results = results.filter((r) => r.success);
	const failed_urls = results
		.filter((r) => !r.success)
		.map((r) => r.url);

	if (successful_results.length === 0) {
		// Every URL already failed once; an automatic retry would only
		// repeat the paid calls with the same outcome.
		throw new ProviderError(
			ErrorType.PROVIDER_ERROR,
			'Failed to extract content from all URLs',
			provider_name,
			{ retryable: false },
		);
	}

	const raw_contents = successful_results.map((result) => ({
		url: result.url,
		content: result.content,
	}));

	const combined_content = raw_contents
		.map((result) => result.content)
		.join('\n\n');

	const word_count = combined_content
		.split(/\s+/)
		.filter(Boolean).length;

	const title = successful_results[0]?.metadata?.title;

	return {
		content: combined_content,
		raw_contents,
		metadata: {
			title,
			word_count,
			failed_urls: failed_urls.length > 0 ? failed_urls : undefined,
			urls_processed: urls.length,
			successful_extractions: successful_results.length,
			extract_depth,
		},
		source_provider: provider_name,
	};
};
