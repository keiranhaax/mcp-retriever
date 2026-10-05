import { afterEach, describe, expect, it } from 'vitest';
import * as v from 'valibot';
import { ValibotJsonSchemaAdapter } from '@tmcp/adapter-valibot';
import { config } from '../../config/env.js';
import {
	initialize_brave_llm_context,
	register_brave_llm_context,
} from './brave_llm_context.js';
import {
	initialize_ai_search,
	register_ai_search,
} from './ai_search.js';
import {
	describe_ai_search,
	tool_descriptions,
} from './descriptions.js';
import {
	initialize_web_search,
	register_web_search,
} from './web_search.js';

const max_description_length = 300;

const routing_contracts = [
	{ name: 'web_search', words: ['Search'] },
	{ name: 'github_search', words: ['Search', 'GitHub'] },
	{ name: 'ai_search', words: ['Answer', 'Research'] },
	{ name: 'web_extract', words: ['Extract', 'Process'] },
	{ name: 'brave_llm_context', words: ['context', 'RAG'] },
	{ name: 'brave_news_search', words: ['News', 'Search'] },
	{ name: 'brave_media_search', words: ['Media', 'Search'] },
	{ name: 'firecrawl_agent', words: ['Credit-sensitive'] },
	{ name: 'context_web_extract', words: ['Context.dev Web'] },
	{ name: 'context_brand_intel', words: ['Brand'] },
	{ name: 'context_styleguide', words: ['Design'] },
	{ name: 'context_classify', words: ['Business'] },
	{ name: 'context_transaction_identify', words: ['Transactions'] },
] as const;

const search_keys = ['tavily', 'brave', 'exa', 'you'] as const;
const original_search_keys = Object.fromEntries(
	search_keys.map((provider) => [
		provider,
		config.search[provider].api_key,
	]),
) as Record<(typeof search_keys)[number], string | undefined>;

const ai_search_keys = [
	'exa_answer',
	'exa_deep_research',
	'linkup',
	'brave_answers',
	'tavily_research',
] as const;
const original_ai_search_keys = Object.fromEntries(
	ai_search_keys.map((provider) => [
		provider,
		config.ai_response[provider].api_key,
	]),
) as Record<(typeof ai_search_keys)[number], string | undefined>;

const capture_schema = (
	register: (server: any) => void,
	tool_name: string,
) => {
	let schema: v.GenericSchema | undefined;
	register({
		tool: (definition: { name: string; schema: v.GenericSchema }) => {
			if (definition.name === tool_name) schema = definition.schema;
		},
	});

	expect(schema).toBeDefined();
	return schema!;
};

afterEach(() => {
	for (const provider of search_keys) {
		config.search[provider].api_key = original_search_keys[provider];
	}
	for (const provider of ai_search_keys) {
		config.ai_response[provider].api_key =
			original_ai_search_keys[provider];
	}
	initialize_web_search();
	initialize_ai_search();
});

describe('Retriever tool descriptions', () => {
	it('does not promise citations from plain-text Brave Answers', () => {
		const description = describe_ai_search(['brave_answers']);
		expect(description).not.toContain('with citations');
		expect(description).toContain('plain-text');
	});

	it('describes Firecrawl start, status and cancel without repeat-start advice', () => {
		expect(tool_descriptions.firecrawl_agent).toContain('job_id');
		expect(tool_descriptions.firecrawl_agent).toContain('100');
		expect(tool_descriptions.firecrawl_agent).toContain('cancel');
	});

	it('keeps descriptions concise and single-line', () => {
		for (const [name, description] of Object.entries(
			tool_descriptions,
		)) {
			expect(description.trim()).toBe(description);
			expect(description).not.toContain('\n');
			if (description.length > max_description_length) {
				throw new Error(
					`${name} description is ${description.length} chars; keep it <= ${max_description_length}`,
				);
			}
		}
	});

	it('keeps explicit routing words for agent tool selection', () => {
		for (const contract of routing_contracts) {
			const description = tool_descriptions[contract.name];
			const normalized = description.toLowerCase();
			const has_routing_word = contract.words.some((word) =>
				normalized.includes(word.toLowerCase()),
			);

			expect(has_routing_word).toBe(true);
		}
	});

	it('keeps exactly 13 routed MCP tool names', () => {
		expect(Object.keys(tool_descriptions)).toHaveLength(13);
	});
});

describe('Retriever public tool schemas', () => {
	it('advertises distinct total and per-URL Brave snippet limits through JSON Schema', async () => {
		const previous_key = config.processing.brave_llm_context.api_key;
		try {
			config.processing.brave_llm_context.api_key =
				'brave-contract-key';
			expect(initialize_brave_llm_context()).toBe(true);
			const schema = capture_schema(
				register_brave_llm_context,
				'brave_llm_context',
			);
			const json_schema =
				await new ValibotJsonSchemaAdapter().toJsonSchema(schema);
			expect(json_schema.properties).toMatchObject({
				maximum_number_of_snippets: {
					description: expect.stringContaining('max 256'),
				},
				maximum_number_of_snippets_per_url: {
					description: expect.stringContaining('max 100'),
				},
			});
			expect(
				v.safeParse(schema, {
					query: 'snippet contract',
					maximum_number_of_snippets: 256,
					maximum_number_of_snippets_per_url: 100,
				}).success,
			).toBe(true);
		} finally {
			config.processing.brave_llm_context.api_key = previous_key;
		}
	});

	it('advertises configured web search providers only', () => {
		for (const provider of search_keys) {
			config.search[provider].api_key = `${provider}-contract-key`;
		}
		expect(initialize_web_search()).toBe(true);
		const schema = capture_schema(register_web_search, 'web_search');

		for (const provider of search_keys) {
			expect(
				v.safeParse(schema, { query: 'provider contract', provider })
					.success,
			).toBe(true);
		}
		expect(
			v.safeParse(schema, {
				query: 'provider contract',
				provider: 'nonexistent',
			}).success,
		).toBe(false);
	});

	it('advertises configured non-You AI search providers only', () => {
		for (const provider of ai_search_keys) {
			config.ai_response[provider].api_key =
				`${provider}-contract-key`;
		}

		expect(initialize_ai_search()).toBe(true);
		const schema = capture_schema(register_ai_search, 'ai_search');

		for (const provider of ai_search_keys) {
			expect(
				v.safeParse(schema, { query: 'provider contract', provider })
					.success,
			).toBe(true);
		}
		expect(
			v.safeParse(schema, {
				query: 'provider contract',
				provider: 'you_research',
			}).success,
		).toBe(false);
	});

	it('does not expose the retired provider-specific research effort parameter', () => {
		config.ai_response.exa_answer.api_key = 'exa-contract-key';
		expect(initialize_ai_search()).toBe(true);
		const schema = capture_schema(register_ai_search, 'ai_search');
		const entries = (schema as v.ObjectSchema<any, any>).entries;

		expect(entries).not.toHaveProperty('you_research_effort');
	});

	it('advertises the current Exa publication category only', () => {
		for (const provider of search_keys) {
			config.search[provider].api_key =
				provider === 'exa' ? 'exa-contract-key' : undefined;
		}
		expect(initialize_web_search()).toBe(true);

		const schema = capture_schema(register_web_search, 'web_search');
		const input = { query: 'academic work', provider: 'exa' };
		expect(
			v.safeParse(schema, { ...input, category: 'publication' })
				.success,
		).toBe(true);
		for (const retired of [
			'research paper',
			'pdf',
			'github',
			'tweet',
		]) {
			expect(
				v.safeParse(schema, { ...input, category: retired }).success,
			).toBe(false);
		}

		const entries = (schema as v.ObjectSchema<any, any>).entries;
		for (const retired_parameter of [
			'startCrawlDate',
			'endCrawlDate',
		]) {
			expect(entries).not.toHaveProperty(retired_parameter);
		}
	});
});
