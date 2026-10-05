// Common type definitions for the MCP Retriever server

export interface SearchResult {
	title: string;
	url: string;
	snippet: string;
	score?: number;
	source_provider: string;
	metadata?: Record<string, any>;
}

export interface BaseSearchParams {
	query: string;
	limit?: number;
	include_domains?: string[];
	exclude_domains?: string[];
	search_depth?: 'basic' | 'advanced' | 'fast' | 'ultra-fast';
	topic?: 'general' | 'news' | 'finance';
	time_range?: 'day' | 'week' | 'month' | 'year';
	output_schema?: Record<string, unknown>;
	search_type?: string;
	category?: string;
	user_location?: string;
	system_prompt?: string;
	additional_queries?: string[];
	contents?: Record<string, unknown>;
}

export interface ProcessingResult {
	content: string;
	raw_contents?: Array<{
		url: string;
		content: string;
	}>;
	metadata: {
		[key: string]: any;
		title?: string;
		author?: string;
		date?: string;
		word_count?: number;
		failed_urls?: string[];
		urls_processed?: number;
		successful_extractions?: number;
		extract_depth?: 'basic' | 'advanced';
	};
	source_provider: string;
}

// Provider interfaces
export interface SearchProvider {
	search(params: BaseSearchParams): Promise<SearchResult[]>;
	name: string;
	description: string;
}

export interface ProcessingProvider {
	process_content(
		url: string | string[],
		extract_depth?: 'basic' | 'advanced',
		options?: Record<string, unknown>,
	): Promise<ProcessingResult>;
	name: string;
	description: string;
}

// Error types
export enum ErrorType {
	API_ERROR = 'API_ERROR',
	RATE_LIMIT = 'RATE_LIMIT',
	INVALID_INPUT = 'INVALID_INPUT',
	PROVIDER_ERROR = 'PROVIDER_ERROR',
	ENTITLEMENT_REQUIRED = 'ENTITLEMENT_REQUIRED',
	ENDPOINT_NOT_FOUND = 'ENDPOINT_NOT_FOUND',
}

export class ProviderError extends Error {
	constructor(
		public type: ErrorType,
		message: string,
		public provider: string,
		public details?: any,
	) {
		super(message);
		this.name = 'ProviderError';
	}
}
