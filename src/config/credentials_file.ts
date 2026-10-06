import {
	chmodSync,
	existsSync,
	mkdirSync,
	readFileSync,
	renameSync,
	statSync,
	unlinkSync,
	writeFileSync,
} from 'node:fs';
import { randomBytes } from 'node:crypto';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

/**
 * A private, user-level credentials file written by `mcp-retriever
 * setup` and `mcp-retriever keys`. The server reads it at startup so
 * MCP client configurations never need to carry provider keys.
 *
 * Real environment variables always win over the file. Only the
 * settings below are ever loaded; anything else in the file is kept
 * on rewrite but ignored. A file readable by group or others is
 * refused, as SSH does for private keys.
 */
export const LOADABLE_SETTINGS = [
	'TAVILY_API_KEY',
	'BRAVE_API_KEY',
	'BRAVE_ANSWERS_API_KEY',
	'GITHUB_API_KEY',
	'EXA_API_KEY',
	'YOU_API_KEY',
	'LINKUP_API_KEY',
	'CONTEXT_DEV_API_KEY',
	'FIRECRAWL_API_KEY',
	'FIRECRAWL_BASE_URL',
	'FIRECRAWL_AGENT_URL',
	'SEARXNG_URL',
	'RETRIEVER_SPEND_CAPS',
	'RETRIEVER_TOOL_GROUPS',
] as const;

export type LoadableSetting = (typeof LOADABLE_SETTINGS)[number];

const NAME_PATTERN = /^[A-Z][A-Z0-9_]*$/;
const HEADER = [
	'# mcp-retriever credentials',
	'# Written by `mcp-retriever setup` / `mcp-retriever keys`.',
	'# Keep this file private (mode 0600). Environment variables',
	'# with the same name take precedence over these values.',
];

type Env = Record<string, string | undefined>;

export const credentials_path = (env: Env = process.env): string => {
	const explicit = env.RETRIEVER_CREDENTIALS_FILE;
	if (explicit && explicit !== 'none') return explicit;
	const base =
		env.XDG_CONFIG_HOME && env.XDG_CONFIG_HOME.startsWith('/')
			? env.XDG_CONFIG_HOME
			: join(env.HOME || homedir(), '.config');
	return join(base, 'mcp-retriever', 'credentials.env');
};

const unquote = (value: string): string => {
	const trimmed = value.trim();
	return trimmed.replace(/^(['"])(.*)\1$/, '$2');
};

/** Parses `NAME=value` lines; comments, blanks and junk are skipped. */
export const parse_credentials = (
	text: string,
): Map<string, string> => {
	const values = new Map<string, string>();
	for (const raw of text.split(/\r?\n/)) {
		const line = raw.trim();
		if (!line || line.startsWith('#')) continue;
		const index = line.indexOf('=');
		if (index <= 0) continue;
		const name = line.slice(0, index).trim();
		if (!NAME_PATTERN.test(name)) continue;
		const value = unquote(line.slice(index + 1));
		if (value) values.set(name, value);
	}
	return values;
};

export const serialize_credentials = (
	values: ReadonlyMap<string, string>,
): string => {
	const lines = [...HEADER, ''];
	for (const [name, value] of values) {
		if (!NAME_PATTERN.test(name))
			throw new Error(`Invalid setting name: ${name}`);
		if (/[\r\n]/.test(value))
			throw new Error(`${name} must be a single line`);
		lines.push(`${name}=${value}`);
	}
	return `${lines.join('\n')}\n`;
};

export const too_open = (mode: number): boolean =>
	(mode & 0o077) !== 0;

export const read_credentials = (
	path: string,
): Map<string, string> => {
	if (!existsSync(path)) return new Map();
	return parse_credentials(readFileSync(path, 'utf8'));
};

/** Atomic private write: 0700 directory, 0600 file, rename into place. */
export const write_credentials = (
	path: string,
	values: ReadonlyMap<string, string>,
): void => {
	const directory = dirname(path);
	if (!existsSync(directory)) {
		mkdirSync(directory, { recursive: true, mode: 0o700 });
		chmodSync(directory, 0o700);
	}
	const temporary = join(
		directory,
		`.credentials.${randomBytes(6).toString('hex')}.tmp`,
	);
	try {
		writeFileSync(temporary, serialize_credentials(values), {
			mode: 0o600,
			flag: 'wx',
		});
		renameSync(temporary, path);
		chmodSync(path, 0o600);
	} catch (error) {
		try {
			unlinkSync(temporary);
		} catch {
			// The temporary file may never have been created.
		}
		throw error;
	}
};

export interface LoadReport {
	path: string;
	loaded: LoadableSetting[];
	skipped_by_env: LoadableSetting[];
	refused?: 'permissions' | 'unreadable';
}

/**
 * Fills unset loadable settings in `env` from the credentials file.
 * Set RETRIEVER_CREDENTIALS_FILE=none to disable. Never logs values.
 */
export const load_credentials_file = (
	env: Env = process.env,
	log: (message: string) => void = (message) =>
		console.error(message),
): LoadReport | undefined => {
	if (env.RETRIEVER_CREDENTIALS_FILE === 'none') return undefined;
	const path = credentials_path(env);
	if (!existsSync(path)) return undefined;
	const report: LoadReport = {
		path,
		loaded: [],
		skipped_by_env: [],
	};
	// A broken file must not stop the server: providers configured
	// through the environment still work without it.
	let values: Map<string, string>;
	try {
		if (
			process.platform !== 'win32' &&
			too_open(statSync(path).mode)
		) {
			log(
				`Ignoring ${path}: readable by other users. Run: chmod 600 "${path}"`,
			);
			report.refused = 'permissions';
			return report;
		}
		values = read_credentials(path);
	} catch {
		log(`Ignoring ${path}: it could not be read`);
		report.refused = 'unreadable';
		return report;
	}
	for (const name of LOADABLE_SETTINGS) {
		const value = values.get(name);
		if (!value) continue;
		// An empty key is no key, so the file may supply it. An empty
		// RETRIEVER_* control is a deliberate setting (an empty tool
		// group list fails closed) and always stands.
		const set_in_env = name.startsWith('RETRIEVER_')
			? env[name] !== undefined
			: Boolean(env[name]);
		if (set_in_env) {
			report.skipped_by_env.push(name);
			continue;
		}
		env[name] = value;
		report.loaded.push(name);
	}
	if (report.loaded.length > 0)
		log(`Loaded ${report.loaded.length} setting(s) from ${path}`);
	return report;
};
