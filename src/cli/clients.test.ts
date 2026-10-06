import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
	detect_clients,
	inline_settings,
	launch_command,
	merge_json_config,
	snippet,
	write_json_config,
	type Client,
	type Launch,
} from './clients.js';

const LAUNCH: Launch = {
	command: 'node',
	args: ['/opt/app/dist/index.js'],
};

let home: string;

beforeEach(() => {
	home = mkdtempSync(join(tmpdir(), 'retriever-clients-test-'));
});

afterEach(() => {
	rmSync(home, { recursive: true, force: true });
});

const client = (kind: Client['kind']): Client => ({
	id: 'test',
	name: 'Test',
	kind,
	detected: true,
});

describe('launch_command', () => {
	it.each([
		'/home/me/.npm/_npx/1a2b3c/node_modules/mcp-retriever/dist/index.js',
		'/usr/lib/node_modules/mcp-retriever/dist/index.js',
	])('uses npx for the installed package at %s', (entry) => {
		expect(launch_command(entry)).toEqual({
			command: 'npx',
			args: ['-y', 'mcp-retriever'],
		});
	});

	it('launches a local build by its own entry file', () => {
		expect(launch_command('/opt/app/dist/index.js')).toEqual(LAUNCH);
	});
});

describe('snippet', () => {
	it('builds a quoted claude mcp add command', () => {
		expect(
			snippet(client('command'), {
				command: 'node',
				args: ["/opt/my app/it's/index.js"],
			}),
		).toBe(
			`claude mcp add --scope user mcp-retriever -- node '/opt/my app/it'\\''s/index.js'`,
		);
	});

	it('builds a Codex TOML table', () => {
		expect(snippet(client('toml'), LAUNCH)).toBe(
			[
				'[mcp_servers.mcp_retriever]',
				'command = "node"',
				'args = ["/opt/app/dist/index.js"]',
			].join('\n'),
		);
	});

	it('builds a JSON entry that carries no keys', () => {
		expect(JSON.parse(snippet(client('json'), LAUNCH))).toEqual({
			mcpServers: { 'mcp-retriever': LAUNCH },
		});
	});
});

describe('merge_json_config', () => {
	it('adds the entry to an empty or missing config', () => {
		for (const existing of [undefined, '', '  \n']) {
			const result = merge_json_config(existing, LAUNCH);
			expect(result.status).toBe('added');
			expect(JSON.parse(result.text)).toEqual({
				mcpServers: { 'mcp-retriever': LAUNCH },
			});
		}
	});

	it('keeps other servers and unrelated top-level settings', () => {
		const result = merge_json_config(
			JSON.stringify({
				theme: 'dark',
				mcpServers: { other: { command: 'other-server' } },
			}),
			LAUNCH,
		);
		expect(JSON.parse(result.text)).toEqual({
			theme: 'dark',
			mcpServers: {
				other: { command: 'other-server' },
				'mcp-retriever': LAUNCH,
			},
		});
	});

	it('moves provider settings out but keeps controls and other env', () => {
		const result = merge_json_config(
			JSON.stringify({
				mcpServers: {
					'mcp-retriever': {
						command: 'npx',
						args: ['-y', 'mcp-omnisearch'],
						disabled: false,
						env: {
							TAVILY_API_KEY: 'tvly-inline',
							SEARXNG_URL: 'http://127.0.0.1:8080',
							RETRIEVER_TOOL_GROUPS: 'search',
							HTTPS_PROXY: 'http://proxy:3128',
						},
					},
				},
			}),
			LAUNCH,
		);
		expect(result.status).toBe('updated');
		expect(
			JSON.parse(result.text).mcpServers['mcp-retriever'],
		).toEqual({
			...LAUNCH,
			disabled: false,
			env: {
				RETRIEVER_TOOL_GROUPS: 'search',
				HTTPS_PROXY: 'http://proxy:3128',
			},
		});
		expect(result.text).not.toContain('tvly-inline');
	});

	it('drops an env block that only held provider settings', () => {
		const result = merge_json_config(
			JSON.stringify({
				mcpServers: {
					'mcp-retriever': {
						...LAUNCH,
						env: { EXA_API_KEY: 'exa-inline' },
					},
				},
			}),
			LAUNCH,
		);
		expect(
			JSON.parse(result.text).mcpServers['mcp-retriever'],
		).toEqual(LAUNCH);
	});

	it('reports an entry that already matches as unchanged', () => {
		const existing = merge_json_config(undefined, LAUNCH).text;
		expect(merge_json_config(existing, LAUNCH).status).toBe(
			'unchanged',
		);
	});

	it.each([
		['[]', 'not a JSON object'],
		['"text"', 'not a JSON object'],
		['{"mcpServers": []}', 'mcpServers is not an object'],
	])('refuses to rewrite %s', (existing, message) => {
		expect(() => merge_json_config(existing, LAUNCH)).toThrow(
			message,
		);
	});

	it('refuses to rewrite a config that is not valid JSON', () => {
		expect(() => merge_json_config('{ // comment', LAUNCH)).toThrow();
	});
});

describe('write_json_config', () => {
	it('creates a missing config without a backup', () => {
		const path = join(home, '.cursor', 'mcp.json');
		const result = write_json_config(path, LAUNCH);
		expect(result.status).toBe('added');
		expect(result.backup).toBeUndefined();
		expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({
			mcpServers: { 'mcp-retriever': LAUNCH },
		});
		expect(readdirSync(dirname(path))).toEqual(['mcp.json']);
	});

	it('backs up the previous config before replacing it', () => {
		const path = join(home, 'mcp.json');
		const before = JSON.stringify({
			mcpServers: { other: { command: 'other-server' } },
		});
		writeFileSync(path, before);
		const result = write_json_config(path, LAUNCH);
		expect(result).toMatchObject({
			status: 'added',
			backup: `${path}.bak`,
		});
		expect(readFileSync(`${path}.bak`, 'utf8')).toBe(before);
		expect(readdirSync(home).sort()).toEqual([
			'mcp.json',
			'mcp.json.bak',
		]);
		if (process.platform !== 'win32')
			expect(statSync(path).mode & 0o777).toBe(0o600);
	});

	it('writes nothing when the entry is already current', () => {
		const path = join(home, 'mcp.json');
		write_json_config(path, LAUNCH);
		const result = write_json_config(path, LAUNCH);
		expect(result.status).toBe('unchanged');
		expect(existsSync(`${path}.bak`)).toBe(false);
	});

	it('leaves a config it cannot parse untouched', () => {
		const path = join(home, 'mcp.json');
		writeFileSync(path, '{ broken');
		expect(() => write_json_config(path, LAUNCH)).toThrow();
		expect(readFileSync(path, 'utf8')).toBe('{ broken');
		expect(readdirSync(home)).toEqual(['mcp.json']);
	});
});

describe('inline_settings', () => {
	it('finds the provider settings an entry carries inline', () => {
		const path = join(home, 'mcp.json');
		writeFileSync(
			path,
			JSON.stringify({
				mcpServers: {
					other: { env: { EXA_API_KEY: 'not-ours' } },
					'mcp-retriever': {
						env: {
							TAVILY_API_KEY: ' tvly-inline ',
							FIRECRAWL_BASE_URL: 'http://10.0.0.5:3002',
							RETRIEVER_TOOL_GROUPS: 'search',
							HTTPS_PROXY: 'http://proxy:3128',
							BRAVE_API_KEY: '',
							YOU_API_KEY: 42,
						},
					},
				},
			}),
		);
		expect([...inline_settings(path)]).toEqual([
			['TAVILY_API_KEY', 'tvly-inline'],
			['FIRECRAWL_BASE_URL', 'http://10.0.0.5:3002'],
		]);
	});

	it('finds nothing in a missing or broken config', () => {
		expect(inline_settings(join(home, 'absent.json')).size).toBe(0);
		const path = join(home, 'mcp.json');
		writeFileSync(path, '{ broken');
		expect(inline_settings(path).size).toBe(0);
	});
});

describe('detect_clients', () => {
	it('detects clients by their configuration directories', () => {
		expect(
			detect_clients(home).filter((entry) => entry.detected),
		).toEqual([]);
		mkdirSync(join(home, '.claude'));
		mkdirSync(join(home, '.cursor'));
		const detected = detect_clients(home)
			.filter((entry) => entry.detected)
			.map((entry) => entry.id);
		expect(detected).toEqual(['claude-code', 'cursor']);
		expect(
			detect_clients(home).find((entry) => entry.id === 'cursor'),
		).toMatchObject({
			kind: 'json',
			path: join(home, '.cursor/mcp.json'),
		});
	});
});
