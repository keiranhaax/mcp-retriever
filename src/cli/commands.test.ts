import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
	afterEach,
	beforeEach,
	describe,
	expect,
	it,
	vi,
} from 'vitest';
import {
	credentials_path,
	read_credentials,
	write_credentials,
} from '../config/credentials_file.js';
import { HELP, run_cli, type CliContext } from './commands.js';
import { fake_terminal, KEY, request_url } from './test_terminal.js';

const GITHUB_KEY = 'ghp_0123456789abcdefWXYZ';
const TAVILY_KEY = 'tvly-0123456789abcdefQRST';
const BRAVE_KEY = 'BSA0123456789abcdefMNOP';
const ENTRY = '/opt/app/dist/index.js';

let home: string;
let path: string;

beforeEach(() => {
	vi.stubEnv('NO_COLOR', '');
	home = mkdtempSync(join(tmpdir(), 'retriever-cli-test-'));
	path = credentials_path({ HOME: home });
});

afterEach(() => {
	rmSync(home, { recursive: true, force: true });
});

interface Options {
	tty?: boolean;
	env?: Record<string, string>;
	status?: number;
	stdin?: string;
}

const cli = (options: Options = {}) => {
	// Wide enough that messages with temporary paths stay on one row.
	const terminal = fake_terminal({
		tty: options.tty ?? false,
		columns: 200,
	});
	const printed: string[] = [];
	const fetcher = vi.fn<typeof fetch>(
		async () => new Response('', { status: options.status ?? 200 }),
	);
	const ctx: CliContext = {
		io: terminal.io,
		env: { HOME: home, ...options.env },
		fetcher,
		read_stdin: () => options.stdin ?? '',
		print: (line) => printed.push(line),
		entry: ENTRY,
		version: '9.9.9',
	};
	return {
		terminal,
		printed,
		fetcher,
		run: (...argv: string[]) => run_cli(argv, ctx),
	};
};

const save = (...entries: [string, string][]) =>
	write_credentials(path, new Map(entries));

const requested = (fetcher: ReturnType<typeof cli>['fetcher']) =>
	fetcher.mock.calls.map(([input]) => request_url(input));

describe('run_cli', () => {
	it('prints the version and the usage on stdout', async () => {
		const version = cli();
		expect(await version.run('--version')).toBe(0);
		expect(version.printed).toEqual(['9.9.9']);
		for (const argv of [['help'], ['--help'], ['-h'], []]) {
			const help = cli();
			expect(await help.run(...argv)).toBe(0);
			expect(help.printed).toEqual([HELP]);
			expect(help.terminal.raw()).toBe('');
		}
	});

	it('rejects an unknown command with the usage on the terminal', async () => {
		const { run, printed, terminal } = cli();
		expect(await run('serve')).toBe(2);
		expect(printed).toEqual([]);
		expect(terminal.text()).toContain('Unknown command: serve');
		expect(terminal.text()).toContain('Usage:');
	});
});

describe('keys commands in scripts', () => {
	it('prints the credentials path on stdout alone', async () => {
		const { run, printed, terminal } = cli();
		expect(await run('keys', 'path')).toBe(0);
		expect(printed).toEqual([path]);
		expect(terminal.raw()).toBe('');
	});

	it('honors RETRIEVER_CREDENTIALS_FILE', async () => {
		const elsewhere = join(home, 'keys.env');
		const { run, printed } = cli({
			env: {
				RETRIEVER_CREDENTIALS_FILE: elsewhere,
				NEW_KEY: GITHUB_KEY,
			},
		});
		expect(await run('keys', 'path')).toBe(0);
		expect(
			await run('keys', 'set', 'github', '--from-env', 'NEW_KEY'),
		).toBe(0);
		expect(printed[0]).toBe(elsewhere);
		expect(read_credentials(elsewhere).get('GITHUB_API_KEY')).toBe(
			GITHUB_KEY,
		);
		expect(existsSync(path)).toBe(false);
	});

	it('lists masked keys and marks ones the environment supplies', async () => {
		save(
			['GITHUB_API_KEY', GITHUB_KEY],
			['RETRIEVER_SPEND_CAPS', 'exa:monthly:usd=5'],
		);
		const { run, printed } = cli({
			env: { TAVILY_API_KEY: TAVILY_KEY },
		});
		expect(await run('keys', 'list')).toBe(0);
		const report = printed.join('\n');
		expect(report).toContain(`Credentials file: ${path}`);
		expect(report).toMatch(/github\s+••••WXYZ\n/);
		expect(report).toMatch(/tavily\s+••••QRST {2}\(environment\)/);
		expect(report).toMatch(/exa\s+not set/);
		expect(report).toMatch(/spend caps\s+exa:monthly:usd=5/);
		expect(report).not.toContain(GITHUB_KEY);
		expect(report).not.toContain(TAVILY_KEY);
	});

	it('prints the list when run without a terminal or an action', async () => {
		const { run, printed } = cli();
		expect(await run('keys')).toBe(0);
		expect(printed[0]).toBe(`Credentials file: ${path}`);
	});

	it('saves a key from an environment variable without showing it', async () => {
		const { run, terminal, printed, fetcher } = cli({
			env: { NEW_KEY: `  ${GITHUB_KEY}\n` },
		});
		expect(
			await run('keys', 'set', 'github', '--from-env', 'NEW_KEY'),
		).toBe(0);
		expect(read_credentials(path).get('GITHUB_API_KEY')).toBe(
			GITHUB_KEY,
		);
		if (process.platform !== 'win32')
			expect(statSync(path).mode & 0o777).toBe(0o600);
		expect(terminal.text()).toContain(
			`Saved GITHUB_API_KEY (••••WXYZ) to ${path}`,
		);
		expect(terminal.raw() + printed.join('')).not.toContain(
			GITHUB_KEY,
		);
		expect(fetcher).not.toHaveBeenCalled();
	});

	it('saves a normalized URL read from stdin', async () => {
		const { run } = cli({ stdin: 'http://127.0.0.1:8080/\n' });
		expect(await run('keys', 'set', 'searxng', '--stdin')).toBe(0);
		expect(read_credentials(path).get('SEARXNG_URL')).toBe(
			'http://127.0.0.1:8080',
		);
	});

	it.each([
		[['--from-env', 'UNSET_VARIABLE'], '', 'No value received'],
		[['--stdin'], '   \n', 'No value received'],
		[['--stdin'], 'short', 'too short'],
		[['--stdin'], 'has a space in it', 'cannot contain spaces'],
	])('saves nothing for %j', async (flags, stdin, message) => {
		const { run, terminal } = cli({ stdin });
		expect(await run('keys', 'set', 'github', ...flags)).toBe(2);
		expect(terminal.text()).toContain(message);
		expect(existsSync(path)).toBe(false);
	});

	it('never takes a key from the command line', async () => {
		const { run, terminal } = cli();
		expect(await run('keys', 'set', 'github', GITHUB_KEY)).toBe(2);
		expect(terminal.text()).toContain('--from-env VAR or --stdin');
		expect(existsSync(path)).toBe(false);
	});

	it('tests a new key on request and fails when it is rejected', async () => {
		const { run, terminal, fetcher } = cli({
			stdin: TAVILY_KEY,
			status: 401,
		});
		expect(
			await run('keys', 'set', 'tavily', '--stdin', '--test'),
		).toBe(1);
		expect(requested(fetcher)).toEqual([
			'https://api.tavily.com/usage',
		]);
		expect(terminal.text()).toContain('Tavily: key rejected (401)');
		expect(read_credentials(path).get('TAVILY_API_KEY')).toBe(
			TAVILY_KEY,
		);
	});

	it('runs free checks only, unless paid checks are allowed', async () => {
		save(
			['GITHUB_API_KEY', GITHUB_KEY],
			['BRAVE_API_KEY', BRAVE_KEY],
		);
		const free = cli();
		expect(await free.run('keys', 'test')).toBe(0);
		expect(requested(free.fetcher)).toEqual([
			'https://api.github.com/rate_limit',
		]);
		expect(free.terminal.text()).toContain(
			'Brave Search: not tested',
		);
		const paid = cli();
		expect(await paid.run('keys', 'test', '--paid')).toBe(0);
		expect(requested(paid.fetcher)).toHaveLength(2);
		expect(requested(paid.fetcher)[1]).toContain(
			'api.search.brave.com',
		);
	});

	it('tests one provider and reports a rejected key', async () => {
		save(
			['GITHUB_API_KEY', GITHUB_KEY],
			['TAVILY_API_KEY', TAVILY_KEY],
		);
		const { run, fetcher } = cli({ status: 401 });
		expect(await run('keys', 'test', 'tavily')).toBe(1);
		expect(requested(fetcher)).toEqual([
			'https://api.tavily.com/usage',
		]);
		expect(await cli().run('keys', 'test', 'nope')).toBe(2);
	});

	it('removes a saved key', async () => {
		save(
			['GITHUB_API_KEY', GITHUB_KEY],
			['TAVILY_API_KEY', TAVILY_KEY],
		);
		const { run, terminal } = cli();
		expect(await run('keys', 'remove', 'github')).toBe(0);
		expect([...read_credentials(path).keys()]).toEqual([
			'TAVILY_API_KEY',
		]);
		expect(await run('keys', 'remove', 'github')).toBe(0);
		expect(terminal.text()).toContain('GITHUB_API_KEY was not set');
	});

	it('rejects unknown providers and actions', async () => {
		const { run, terminal } = cli();
		expect(await run('keys', 'remove', 'nope')).toBe(2);
		expect(terminal.text()).toContain('Unknown provider: nope');
		expect(await run('keys', 'rotate', 'github')).toBe(2);
		expect(terminal.text()).toContain('Unknown keys action: rotate');
	});
});

describe('setup', () => {
	it('refuses to run without an interactive terminal', async () => {
		const { run, terminal } = cli();
		expect(await run('setup')).toBe(1);
		expect(terminal.text()).toContain('keys set <provider> --stdin');
		expect(existsSync(path)).toBe(false);
	});

	it('collects a key, checks it for free and saves it privately', async () => {
		const { run, terminal, fetcher } = cli({ tty: true });
		terminal.keys(
			// Providers: move to GitHub, select it, confirm.
			KEY.down,
			KEY.space,
			KEY.enter,
			GITHUB_KEY,
			KEY.enter,
			// Clients: none detected, confirm the empty selection.
			KEY.enter,
		);
		expect(await run('setup')).toBe(0);
		expect([...read_credentials(path)]).toEqual([
			['GITHUB_API_KEY', GITHUB_KEY],
		]);
		if (process.platform !== 'win32')
			expect(statSync(path).mode & 0o777).toBe(0o600);
		expect(requested(fetcher)).toEqual([
			'https://api.github.com/rate_limit',
		]);
		const text = terminal.text();
		expect(text).toContain('mcp-retriever');
		expect(text).toContain('GitHub: key accepted');
		expect(text).toContain(`Saved 1 setting(s) to ${path} (0600)`);
		expect(terminal.raw()).not.toContain(GITHUB_KEY);
		expect(terminal.is_raw()).toBe(false);
	});

	it('offers spending caps for paid providers', async () => {
		const { run, terminal } = cli({ tty: true });
		terminal.keys(
			KEY.down,
			KEY.down,
			KEY.space,
			KEY.enter,
			TAVILY_KEY,
			KEY.enter,
			// Add caps: yes, then accept the suggested value.
			KEY.enter,
			KEY.enter,
			KEY.enter,
		);
		expect(await run('setup')).toBe(0);
		expect([...read_credentials(path)]).toEqual([
			['TAVILY_API_KEY', TAVILY_KEY],
			['RETRIEVER_SPEND_CAPS', 'tavily:monthly:credits=1000'],
		]);
	});

	it('does not save a rejected key the user chooses to skip', async () => {
		const { run, terminal } = cli({ tty: true, status: 401 });
		terminal.keys(
			KEY.down,
			KEY.space,
			KEY.enter,
			GITHUB_KEY,
			KEY.enter,
			// What now? -> Skip this provider.
			KEY.down,
			KEY.down,
			KEY.enter,
			KEY.enter,
		);
		expect(await run('setup')).toBe(0);
		expect(terminal.text()).toContain('GitHub: key rejected (401)');
		expect(read_credentials(path).size).toBe(0);
	});

	it('saves nothing when cancelled', async () => {
		const { run, terminal } = cli({ tty: true });
		terminal.keys(KEY.down, KEY.space, KEY.enter, KEY.ctrl_c);
		expect(await run('setup')).toBe(130);
		expect(terminal.text()).toContain(
			'Cancelled. Nothing else was changed.',
		);
		expect(existsSync(path)).toBe(false);
		expect(terminal.is_raw()).toBe(false);
	});

	describe('connecting a client', () => {
		let config: string;
		const before = () => ({
			mcpServers: {
				other: { command: 'other-server' },
				'mcp-retriever': {
					command: 'npx',
					args: ['-y', 'mcp-retriever'],
					env: {
						TAVILY_API_KEY: TAVILY_KEY,
						RETRIEVER_TOOL_GROUPS: 'search',
					},
				},
			},
		});

		beforeEach(() => {
			mkdirSync(join(home, '.cursor'));
			config = join(home, '.cursor', 'mcp.json');
			writeFileSync(config, JSON.stringify(before()));
		});

		it('moves inline keys into the credentials file before rewriting the entry', async () => {
			const { run, terminal } = cli({ tty: true });
			terminal.keys(
				KEY.down,
				KEY.space,
				KEY.enter,
				GITHUB_KEY,
				KEY.enter,
				// Clients: Cursor is preselected. Then confirm the write.
				KEY.enter,
				KEY.enter,
			);
			expect(await run('setup')).toBe(0);
			expect([...read_credentials(path)]).toEqual([
				['GITHUB_API_KEY', GITHUB_KEY],
				['TAVILY_API_KEY', TAVILY_KEY],
			]);
			expect(JSON.parse(readFileSync(config, 'utf8'))).toEqual({
				mcpServers: {
					other: { command: 'other-server' },
					'mcp-retriever': {
						command: 'node',
						args: [ENTRY],
						env: { RETRIEVER_TOOL_GROUPS: 'search' },
					},
				},
			});
			expect(
				JSON.parse(readFileSync(`${config}.bak`, 'utf8')),
			).toEqual(before());
			const text = terminal.text();
			expect(text).toContain('carries TAVILY_API_KEY inline');
			expect(text).toContain(`Moved TAVILY_API_KEY into ${path}`);
			expect(terminal.raw()).not.toContain(TAVILY_KEY);
		});

		it('leaves the client and its keys alone when the write is declined', async () => {
			const { run, terminal } = cli({ tty: true });
			terminal.keys(
				KEY.down,
				KEY.space,
				KEY.enter,
				GITHUB_KEY,
				KEY.enter,
				KEY.enter,
				'n',
			);
			expect(await run('setup')).toBe(0);
			expect(JSON.parse(readFileSync(config, 'utf8'))).toEqual(
				before(),
			);
			expect(existsSync(`${config}.bak`)).toBe(false);
			expect([...read_credentials(path).keys()]).toEqual([
				'GITHUB_API_KEY',
			]);
		});
	});
});

describe('keys menu', () => {
	it('opens with the compact header and closes on Done', async () => {
		const { run, terminal } = cli({ tty: true });
		terminal.keys(KEY.up, KEY.enter);
		expect(await run('keys')).toBe(0);
		expect(terminal.text()).toContain('mcp-retriever');
		expect(terminal.text()).toContain('Choose a provider to edit');
		expect(existsSync(path)).toBe(false);
	});

	it('removes a saved key after confirmation', async () => {
		save(
			['GITHUB_API_KEY', GITHUB_KEY],
			['TAVILY_API_KEY', TAVILY_KEY],
		);
		const { run, terminal } = cli({ tty: true });
		terminal.keys(
			// GitHub -> Remove -> yes, then Done.
			KEY.down,
			KEY.enter,
			KEY.down,
			KEY.down,
			KEY.enter,
			'y',
			KEY.up,
			KEY.enter,
		);
		expect(await run('keys')).toBe(0);
		expect([...read_credentials(path).keys()]).toEqual([
			'TAVILY_API_KEY',
		]);
		expect(terminal.text()).toContain('GitHub removed');
		expect(terminal.raw()).not.toContain(GITHUB_KEY);
	});
});
