import {
	chmodSync,
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
	credentials_path,
	load_credentials_file,
	parse_credentials,
	read_credentials,
	serialize_credentials,
	too_open,
	write_credentials,
} from './credentials_file.js';

const posix = process.platform !== 'win32';
const mode = (path: string) => statSync(path).mode & 0o777;

let home: string;
let path: string;

beforeEach(() => {
	home = mkdtempSync(join(tmpdir(), 'retriever-credentials-test-'));
	path = credentials_path({ HOME: home });
});

afterEach(() => {
	rmSync(home, { recursive: true, force: true });
});

const load = (env: Record<string, string | undefined>) => {
	const logged: string[] = [];
	const report = load_credentials_file(env, (message) =>
		logged.push(message),
	);
	return { report, logged };
};

describe('credentials_path', () => {
	it('defaults to a per-user file under ~/.config', () => {
		expect(path).toBe(
			join(home, '.config', 'mcp-retriever', 'credentials.env'),
		);
	});

	it('honors an absolute XDG_CONFIG_HOME and ignores a relative one', () => {
		expect(
			credentials_path({ HOME: home, XDG_CONFIG_HOME: '/xdg' }),
		).toBe('/xdg/mcp-retriever/credentials.env');
		expect(
			credentials_path({ HOME: home, XDG_CONFIG_HOME: 'relative' }),
		).toBe(path);
	});

	it('uses an explicit file, and the default when disabled', () => {
		expect(
			credentials_path({
				HOME: home,
				RETRIEVER_CREDENTIALS_FILE: '/srv/keys.env',
			}),
		).toBe('/srv/keys.env');
		expect(
			credentials_path({
				HOME: home,
				RETRIEVER_CREDENTIALS_FILE: 'none',
			}),
		).toBe(path);
	});
});

describe('credentials file format', () => {
	it('parses settings and skips comments, junk and invalid names', () => {
		const values = parse_credentials(
			[
				'# a comment',
				'',
				'TAVILY_API_KEY=tvly-abc',
				'  EXA_API_KEY = "exa-quoted"  ',
				"SEARXNG_URL='http://127.0.0.1:8080'",
				'not a setting',
				'lower_case=ignored',
				'=missing-name',
				'EMPTY_VALUE=',
				'GITHUB_API_KEY=ghp_with=equals',
			].join('\r\n'),
		);
		expect([...values]).toEqual([
			['TAVILY_API_KEY', 'tvly-abc'],
			['EXA_API_KEY', 'exa-quoted'],
			['SEARXNG_URL', 'http://127.0.0.1:8080'],
			['GITHUB_API_KEY', 'ghp_with=equals'],
		]);
	});

	it('round-trips settings in order, including unknown names', () => {
		const values = new Map([
			['EXA_API_KEY', 'exa-1'],
			['SOME_FUTURE_SETTING', 'kept'],
			['TAVILY_API_KEY', 'tvly-2'],
		]);
		const text = serialize_credentials(values);
		expect(text.startsWith('# mcp-retriever credentials\n')).toBe(
			true,
		);
		expect([...parse_credentials(text)]).toEqual([...values]);
	});

	it('refuses names and values that would corrupt the file', () => {
		expect(() =>
			serialize_credentials(new Map([['bad name', 'x']])),
		).toThrow('Invalid setting name');
		expect(() =>
			serialize_credentials(
				new Map([['EXA_API_KEY', 'one\nINJECTED=two']]),
			),
		).toThrow('single line');
	});

	it('treats any group or other permission bit as too open', () => {
		expect(too_open(0o100600)).toBe(false);
		expect(too_open(0o100400)).toBe(false);
		expect(too_open(0o100640)).toBe(true);
		expect(too_open(0o100604)).toBe(true);
	});
});

describe('write_credentials', () => {
	it('reads nothing from a file that does not exist', () => {
		expect(read_credentials(path).size).toBe(0);
	});

	it.runIf(posix)(
		'creates a private directory and file and leaves no temporary file',
		() => {
			write_credentials(path, new Map([['EXA_API_KEY', 'exa-1']]));
			expect(mode(dirname(path))).toBe(0o700);
			expect(mode(path)).toBe(0o600);
			expect(readdirSync(dirname(path))).toEqual(['credentials.env']);
			expect(read_credentials(path).get('EXA_API_KEY')).toBe('exa-1');
		},
	);

	it.runIf(posix)(
		'replaces an existing file and tightens a loose mode',
		() => {
			mkdirSync(dirname(path), { recursive: true });
			writeFileSync(path, 'EXA_API_KEY=old\n', { mode: 0o644 });
			chmodSync(path, 0o644);
			write_credentials(path, new Map([['EXA_API_KEY', 'new']]));
			expect(mode(path)).toBe(0o600);
			expect(readFileSync(path, 'utf8')).toContain('EXA_API_KEY=new');
			expect(readFileSync(path, 'utf8')).not.toContain('old');
		},
	);

	it('keeps the previous file when the new content is invalid', () => {
		write_credentials(path, new Map([['EXA_API_KEY', 'exa-1']]));
		expect(() =>
			write_credentials(path, new Map([['EXA_API_KEY', 'a\nb']])),
		).toThrow('single line');
		expect(read_credentials(path).get('EXA_API_KEY')).toBe('exa-1');
		expect(readdirSync(dirname(path))).toEqual(['credentials.env']);
	});
});

describe('load_credentials_file', () => {
	it('does nothing without a file', () => {
		const env = { HOME: home };
		expect(load(env)).toEqual({ report: undefined, logged: [] });
		expect(env).toEqual({ HOME: home });
	});

	it('fills unset settings and lets the environment win', () => {
		write_credentials(
			path,
			new Map([
				['TAVILY_API_KEY', 'tvly-from-file'],
				['EXA_API_KEY', 'exa-from-file'],
				['SEARXNG_URL', 'http://127.0.0.1:8080'],
			]),
		);
		const env: Record<string, string | undefined> = {
			HOME: home,
			EXA_API_KEY: 'exa-from-env',
			TAVILY_API_KEY: '',
		};
		const { report, logged } = load(env);
		expect(env.TAVILY_API_KEY).toBe('tvly-from-file');
		expect(env.EXA_API_KEY).toBe('exa-from-env');
		expect(env.SEARXNG_URL).toBe('http://127.0.0.1:8080');
		expect(report).toEqual({
			path,
			loaded: ['TAVILY_API_KEY', 'SEARXNG_URL'],
			skipped_by_env: ['EXA_API_KEY'],
		});
		expect(logged).toEqual([`Loaded 2 setting(s) from ${path}`]);
		expect(logged.join('\n')).not.toMatch(
			/tvly|exa-from|127\.0\.0\.1/,
		);
	});

	it('keeps an explicitly empty control from the environment', () => {
		write_credentials(
			path,
			new Map([
				['RETRIEVER_TOOL_GROUPS', 'search'],
				['RETRIEVER_SPEND_CAPS', 'exa:monthly:usd=5'],
			]),
		);
		const env: Record<string, string | undefined> = {
			HOME: home,
			RETRIEVER_TOOL_GROUPS: '',
		};
		const { report } = load(env);
		expect(env.RETRIEVER_TOOL_GROUPS).toBe('');
		expect(env.RETRIEVER_SPEND_CAPS).toBe('exa:monthly:usd=5');
		expect(report?.skipped_by_env).toEqual(['RETRIEVER_TOOL_GROUPS']);
	});

	it('loads only known settings, never arbitrary variables', () => {
		mkdirSync(dirname(path), { recursive: true });
		writeFileSync(
			path,
			[
				'NODE_OPTIONS=--require /tmp/evil.js',
				'MCP_API_KEY=edge-secret',
				'PATH=/tmp',
				'GITHUB_API_KEY=ghp_ok',
			].join('\n'),
			{ mode: 0o600 },
		);
		const env: Record<string, string | undefined> = { HOME: home };
		const { report } = load(env);
		expect(env).toEqual({ HOME: home, GITHUB_API_KEY: 'ghp_ok' });
		expect(report?.loaded).toEqual(['GITHUB_API_KEY']);
	});

	it('is disabled by RETRIEVER_CREDENTIALS_FILE=none', () => {
		write_credentials(path, new Map([['EXA_API_KEY', 'exa-1']]));
		const env = { HOME: home, RETRIEVER_CREDENTIALS_FILE: 'none' };
		expect(load(env)).toEqual({ report: undefined, logged: [] });
		expect(env).not.toHaveProperty('EXA_API_KEY');
	});

	it('reads the file named by RETRIEVER_CREDENTIALS_FILE', () => {
		const explicit = join(home, 'elsewhere', 'keys.env');
		write_credentials(explicit, new Map([['EXA_API_KEY', 'exa-1']]));
		const env: Record<string, string | undefined> = {
			HOME: home,
			RETRIEVER_CREDENTIALS_FILE: explicit,
		};
		expect(load(env).report?.loaded).toEqual(['EXA_API_KEY']);
		expect(env.EXA_API_KEY).toBe('exa-1');
	});

	it.runIf(posix)('refuses a file other users can read', () => {
		write_credentials(path, new Map([['EXA_API_KEY', 'exa-1']]));
		chmodSync(path, 0o644);
		const env: Record<string, string | undefined> = { HOME: home };
		const { report, logged } = load(env);
		expect(env).not.toHaveProperty('EXA_API_KEY');
		expect(report).toMatchObject({
			refused: 'permissions',
			loaded: [],
		});
		expect(logged).toHaveLength(1);
		expect(logged[0]).toContain('chmod 600');
		expect(logged[0]).not.toContain('exa-1');
	});

	it('ignores a file it cannot read instead of failing startup', () => {
		mkdirSync(path, { recursive: true, mode: 0o700 });
		const env: Record<string, string | undefined> = { HOME: home };
		const { report, logged } = load(env);
		expect(report).toMatchObject({
			refused: 'unreadable',
			loaded: [],
		});
		expect(logged).toEqual([
			`Ignoring ${path}: it could not be read`,
		]);
		expect(env).toEqual({ HOME: home });
	});
});
