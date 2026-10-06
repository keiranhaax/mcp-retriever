import {
	copyFileSync,
	existsSync,
	mkdirSync,
	readFileSync,
	renameSync,
	writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { LOADABLE_SETTINGS } from '../config/credentials_file.js';

/**
 * Client registration for the setup TUI. Every entry launches the
 * server without keys; the server reads the private credentials
 * file. JSON clients can be updated in place (with a .bak copy);
 * others get a snippet or command to run.
 */

export interface Launch {
	command: string;
	args: string[];
}

export const SERVER_NAME = 'mcp-retriever';

/**
 * `npx` when `entry` (the running entry file) sits in a package
 * cache or an installed package, else that build's own path.
 */
export const launch_command = (entry: string): Launch => {
	if (/[\\/](_npx|node_modules)[\\/]/.test(entry))
		return { command: 'npx', args: ['-y', 'mcp-retriever'] };
	return { command: 'node', args: [resolve(entry)] };
};

export interface Client {
	id: string;
	name: string;
	kind: 'json' | 'command' | 'toml';
	path?: string;
	detected: boolean;
}

export const detect_clients = (home = homedir()): Client[] => {
	const desktop =
		process.platform === 'darwin'
			? join(
					home,
					'Library/Application Support/Claude/claude_desktop_config.json',
				)
			: process.platform === 'win32'
				? join(
						process.env.APPDATA ?? join(home, 'AppData/Roaming'),
						'Claude/claude_desktop_config.json',
					)
				: join(home, '.config/Claude/claude_desktop_config.json');
	const cursor = join(home, '.cursor/mcp.json');
	const codex = join(home, '.codex/config.toml');
	const has_dir = (path: string) => existsSync(dirname(path));
	return [
		{
			id: 'claude-code',
			name: 'Claude Code',
			kind: 'command',
			detected: existsSync(join(home, '.claude')),
		},
		{
			id: 'claude-desktop',
			name: 'Claude Desktop',
			kind: 'json',
			path: desktop,
			detected: has_dir(desktop),
		},
		{
			id: 'cursor',
			name: 'Cursor',
			kind: 'json',
			path: cursor,
			detected: has_dir(cursor),
		},
		{
			id: 'codex',
			name: 'Codex',
			kind: 'toml',
			path: codex,
			detected: existsSync(codex),
		},
	];
};

const quote_shell = (value: string) =>
	/^[\w@%+=:,./-]+$/.test(value)
		? value
		: `'${value.replace(/'/g, `'\\''`)}'`;

export const snippet = (client: Client, launch: Launch): string => {
	if (client.kind === 'command')
		return [
			'claude',
			'mcp',
			'add',
			'--scope',
			'user',
			SERVER_NAME,
			'--',
			launch.command,
			...launch.args,
		]
			.map(quote_shell)
			.join(' ');
	if (client.kind === 'toml')
		return [
			`[mcp_servers.${SERVER_NAME.replace(/-/g, '_')}]`,
			`command = ${JSON.stringify(launch.command)}`,
			`args = ${JSON.stringify(launch.args)}`,
		].join('\n');
	return JSON.stringify(
		{ mcpServers: { [SERVER_NAME]: launch } },
		null,
		2,
	);
};

export interface MergeResult {
	text: string;
	status: 'added' | 'updated' | 'unchanged';
}

const is_record = (
	value: unknown,
): value is Record<string, unknown> =>
	Boolean(value) &&
	typeof value === 'object' &&
	!Array.isArray(value);

const LOADABLE = new Set<string>(LOADABLE_SETTINGS);

/**
 * Provider keys and URLs move from a client entry into the
 * credentials file. RETRIEVER_* controls stay inline: they can
 * differ per client, and the environment wins over the file.
 */
const moves_to_file = (
	name: string,
	value: unknown,
): value is string =>
	LOADABLE.has(name) &&
	!name.startsWith('RETRIEVER_') &&
	typeof value === 'string' &&
	value.trim() !== '' &&
	!/[\r\n]/.test(value);

/** Adds or replaces only this server's entry; keeps everything else. */
export const merge_json_config = (
	existing: string | undefined,
	launch: Launch,
): MergeResult => {
	const parsed: unknown =
		existing && existing.trim() ? JSON.parse(existing) : {};
	if (!is_record(parsed))
		throw new Error('config file is not a JSON object');
	const servers = parsed.mcpServers ?? {};
	if (!is_record(servers))
		throw new Error('mcpServers is not an object');
	const before = servers[SERVER_NAME];
	const entry: Record<string, unknown> = is_record(before)
		? { ...before, ...launch }
		: { ...launch };
	if (is_record(entry.env)) {
		const kept = Object.entries(entry.env).filter(
			([name, value]) => !moves_to_file(name, value),
		);
		if (kept.length) entry.env = Object.fromEntries(kept);
		else delete entry.env;
	}
	const status =
		before === undefined
			? 'added'
			: JSON.stringify(before) === JSON.stringify(entry)
				? 'unchanged'
				: 'updated';
	servers[SERVER_NAME] = entry;
	parsed.mcpServers = servers;
	return { text: `${JSON.stringify(parsed, null, 2)}\n`, status };
};

/** Writes a merged JSON client config, keeping a `.bak` of the old one. */
export const write_json_config = (
	path: string,
	launch: Launch,
): MergeResult & { backup?: string } => {
	const existing = existsSync(path)
		? readFileSync(path, 'utf8')
		: undefined;
	const result = merge_json_config(existing, launch);
	if (result.status === 'unchanged') return result;
	mkdirSync(dirname(path), { recursive: true });
	let backup: string | undefined;
	if (existing !== undefined) {
		backup = `${path}.bak`;
		copyFileSync(path, backup);
	}
	const temporary = `${path}.mcp-retriever.tmp`;
	writeFileSync(temporary, result.text, { mode: 0o600 });
	renameSync(temporary, path);
	return { ...result, backup };
};

/** Provider settings an existing client entry still carries inline. */
export const inline_settings = (
	path: string,
): Map<string, string> => {
	const found = new Map<string, string>();
	try {
		const config: unknown = JSON.parse(readFileSync(path, 'utf8'));
		const servers = is_record(config) ? config.mcpServers : undefined;
		const entry = is_record(servers)
			? servers[SERVER_NAME]
			: undefined;
		const env = is_record(entry) ? entry.env : undefined;
		if (is_record(env))
			for (const [name, value] of Object.entries(env))
				if (moves_to_file(name, value)) found.set(name, value.trim());
	} catch {
		// A missing or unreadable config carries nothing inline.
	}
	return found;
};
