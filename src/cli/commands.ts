import { readFileSync } from 'node:fs';
import {
	credentials_path,
	read_credentials,
	write_credentials,
} from '../config/credentials_file.js';
import { parse_spend_caps } from '../server/spend_caps.js';
import { banner } from './brand.js';
import {
	detect_clients,
	inline_settings,
	launch_command,
	snippet,
	write_json_config,
} from './clients.js';
import {
	find_provider,
	mask,
	normalize_origin,
	PROVIDERS,
	run_check,
	type CheckResult,
	type ProviderSpec,
} from './providers.js';
import {
	c,
	Cancelled,
	confirm,
	default_io,
	is_interactive,
	multiselect,
	note,
	outro,
	select,
	spin,
	step,
	text,
	type Io,
} from './ui.js';

export interface CliContext {
	io: Io;
	env: Record<string, string | undefined>;
	fetcher: typeof fetch;
	/** Reads a secret piped on stdin (`keys set x --stdin`). */
	read_stdin: () => string;
	/** Results a script may capture, such as `keys path`. */
	print: (line: string) => void;
	/** The running entry file; client entries launch this build. */
	entry: string;
	version: string;
}

export const default_context = (
	overrides: Partial<CliContext> = {},
): CliContext => ({
	io: default_io(),
	env: process.env,
	fetcher: fetch,
	read_stdin: () => readFileSync(0, 'utf8'),
	print: (line) => process.stdout.write(`${line}\n`),
	entry: process.argv[1] ?? '',
	version: 'unknown',
	...overrides,
});

// Prompts and progress go to the terminal on stderr; `ctx.print`
// carries results on stdout. Commands never run beside the server.
const say = (ctx: CliContext, line = '') =>
	ctx.io.output.write(`${line}\n`);

const status_icon = (result: CheckResult): 'ok' | 'warn' | 'fail' =>
	result.status === 'ok'
		? 'ok'
		: result.status === 'invalid' ||
			  result.status === 'unreachable' ||
			  result.status === 'no_credits'
			? 'fail'
			: 'warn';

const report_check = (
	ctx: CliContext,
	provider: ProviderSpec,
	result: CheckResult,
) => {
	step(
		ctx.io,
		status_icon(result),
		`${provider.name}: ${result.detail}`,
	);
	if (result.warning) step(ctx.io, 'warn', result.warning);
};

const source_of = (
	ctx: CliContext,
	provider: ProviderSpec,
	stored: ReadonlyMap<string, string>,
): { value?: string; source?: 'env' | 'file' } => {
	const env_value = ctx.env[provider.env];
	if (env_value) return { value: env_value, source: 'env' };
	const file_value = stored.get(provider.env);
	if (file_value) return { value: file_value, source: 'file' };
	return {};
};

const validate_value = (
	provider: ProviderSpec,
	value: string,
): string | undefined => {
	if (provider.kind === 'url') {
		try {
			normalize_origin(value);
		} catch (error) {
			return (error as Error).message;
		}
		return undefined;
	}
	if (/\s/.test(value)) return 'keys cannot contain spaces';
	if (value.length < 8) return 'that looks too short for an API key';
	return undefined;
};

const clean_value = (provider: ProviderSpec, value: string) =>
	provider.kind === 'url' ? normalize_origin(value) : value.trim();

/** Free checks run automatically; paid checks need consent. */
const maybe_check = async (
	ctx: CliContext,
	provider: ProviderSpec,
	value: string,
	values: ReadonlyMap<string, string>,
	paid: boolean | 'ask',
): Promise<CheckResult | undefined> => {
	if (!provider.check) {
		step(
			ctx.io,
			'info',
			`${provider.name}: saved without testing (no free check)`,
		);
		return undefined;
	}
	if (provider.check_cost !== 'free') {
		const allowed =
			paid === 'ask'
				? await confirm(
						ctx.io,
						`Test ${provider.name}? This uses ${provider.check_cost}.`,
						false,
					)
				: paid;
		if (!allowed) {
			step(ctx.io, 'info', `${provider.name}: not tested`);
			return undefined;
		}
	}
	const result = await spin(
		ctx.io,
		`Checking ${provider.name}…`,
		() => run_check(provider, value, values, ctx.fetcher),
	);
	report_check(ctx, provider, result);
	return result;
};

/** Prompts until the user has a value they want, or skips. */
const collect_value = async (
	ctx: CliContext,
	provider: ProviderSpec,
	values: Map<string, string>,
): Promise<string | undefined> => {
	const current = values.get(provider.env);
	for (;;) {
		const entered = await text(
			ctx.io,
			provider.kind === 'url'
				? `${provider.name} URL`
				: `${provider.name} key`,
			{
				secret: provider.kind === 'key',
				placeholder: current
					? `enter keeps ${mask(current, provider.kind)}`
					: provider.kind === 'url'
						? 'http://127.0.0.1:8080'
						: `from ${provider.signup}`,
				validate: (value) => validate_value(provider, value),
			},
		);
		if (!entered) return current;
		const value = clean_value(provider, entered);
		const result = await maybe_check(
			ctx,
			provider,
			value,
			values,
			'ask',
		);
		if (
			!result ||
			result.status === 'ok' ||
			result.status === 'rate_limited' ||
			result.status === 'unchecked'
		)
			return value;
		const next = await select(ctx.io, 'What now?', [
			{ value: 'retry', label: 'Enter it again' },
			{
				value: 'keep',
				label: 'Save it anyway',
				hint: 'useful when offline',
			},
			{
				value: 'skip',
				label: current
					? 'Keep the previous value'
					: 'Skip this provider',
			},
		]);
		if (next === 'keep') return value;
		if (next === 'skip') return current;
	}
};

const SPEND_DEFAULTS: Record<string, string> = {
	exa: 'exa:monthly:usd=5',
	tavily: 'tavily:monthly:credits=1000',
	firecrawl: 'firecrawl:monthly:credits=500',
};

const configure_spend_caps = async (
	ctx: CliContext,
	values: Map<string, string>,
) => {
	const families = Object.keys(SPEND_DEFAULTS).filter((family) =>
		values.has(`${family.toUpperCase()}_API_KEY`),
	);
	if (!families.length) return;
	const existing = values.get('RETRIEVER_SPEND_CAPS');
	const wanted = await confirm(
		ctx.io,
		existing
			? `Edit spending caps? (now: ${existing})`
			: 'Add monthly spending caps for paid providers?',
		!existing,
	);
	if (!wanted) return;
	const suggested =
		existing ??
		families.map((family) => SPEND_DEFAULTS[family]).join(',');
	const caps = await text(ctx.io, 'Spending caps', {
		initial: suggested,
		validate: (value) => {
			try {
				parse_spend_caps(value);
				return undefined;
			} catch (error) {
				return (error as Error).message;
			}
		},
	});
	if (caps) values.set('RETRIEVER_SPEND_CAPS', caps);
	else values.delete('RETRIEVER_SPEND_CAPS');
};

const connect_clients = async (
	ctx: CliContext,
	path: string,
	values: Map<string, string>,
) => {
	const launch = launch_command(ctx.entry);
	const clients = detect_clients(ctx.env.HOME);
	const chosen = await multiselect(
		ctx.io,
		'Connect to which MCP clients?',
		clients.map((client) => ({
			value: client.id,
			label: client.name,
			hint: client.detected ? 'detected' : 'not found',
		})),
		new Set(
			clients
				.filter((client) => client.detected)
				.map((client) => client.id),
		),
	);
	for (const client of clients) {
		if (!chosen.includes(client.id)) continue;
		if (client.kind === 'json' && client.path) {
			note(
				ctx.io,
				snippet(client, launch).split('\n'),
				`${client.name}: ${client.path}`,
			);
			const inline = inline_settings(client.path);
			if (inline.size)
				step(
					ctx.io,
					'info',
					`${client.name}: this entry carries ${[...inline.keys()].join(', ')} inline; writing it moves them into the credentials file`,
				);
			const ok = await confirm(
				ctx.io,
				`Write this entry to ${client.name}? Other servers are kept and a .bak copy is made.`,
			);
			if (!ok) continue;
			try {
				// Save moved settings before they leave the client config,
				// so a failed write cannot drop a key. Values chosen in
				// this run win over inline ones.
				const moved = [...inline].filter(
					([name]) => !values.has(name),
				);
				if (moved.length) {
					for (const [name, value] of moved) values.set(name, value);
					write_credentials(path, values);
				}
				const result = write_json_config(client.path, launch);
				step(
					ctx.io,
					'ok',
					`${client.name}: entry ${result.status}${
						result.backup ? ` (backup ${result.backup})` : ''
					}`,
				);
				if (moved.length)
					step(
						ctx.io,
						'ok',
						`Moved ${moved.map(([name]) => name).join(', ')} into ${path}`,
					);
			} catch (error) {
				step(
					ctx.io,
					'fail',
					`${client.name}: ${(error as Error).message}; add the entry above by hand`,
				);
			}
			continue;
		}
		note(
			ctx.io,
			snippet(client, launch).split('\n'),
			client.kind === 'command'
				? `${client.name}: run this command`
				: `${client.name}: add to ${client.path}`,
		);
	}
};

export const run_setup = async (ctx = default_context()) => {
	if (!is_interactive(ctx.io)) {
		say(
			ctx,
			'setup needs an interactive terminal. In scripts use:\n  mcp-retriever keys set <provider> --from-env VAR\n  mcp-retriever keys set <provider> --stdin',
		);
		return 1;
	}
	const path = credentials_path(ctx.env);
	const values = read_credentials(path);
	await banner(ctx.io, 'setup', { welcome: true });
	note(ctx.io, [
		'Pick the providers you have keys for. Each key is tested',
		'with a free call where the provider offers one, then saved',
		`privately to ${c.cyan(ctx.io, path)}.`,
		c.dim(
			ctx.io,
			'No key yet? SearXNG and GitHub cost nothing. Esc cancels.',
		),
	]);
	const chosen = await multiselect(
		ctx.io,
		'Which providers do you want to use?',
		PROVIDERS.map((provider) => {
			const { value, source } = source_of(ctx, provider, values);
			const state = value
				? `set ${mask(value, provider.kind)}${source === 'env' ? ' via env' : ''}`
				: provider.check_cost === 'free'
					? 'free check'
					: undefined;
			return {
				value: provider.id,
				label: provider.name,
				hint: [provider.unlocks, state].filter(Boolean).join(' · '),
			};
		}),
		new Set(
			PROVIDERS.filter((provider) => values.has(provider.env)).map(
				(provider) => provider.id,
			),
		),
	);
	if (!chosen.length) {
		outro(ctx.io, 'Nothing selected. Nothing saved.');
		return 0;
	}
	for (const id of chosen) {
		const provider = find_provider(id)!;
		if (ctx.env[provider.env])
			step(
				ctx.io,
				'info',
				`${provider.env} is also set in your environment; the environment wins at runtime`,
			);
		const value = await collect_value(ctx, provider, values);
		if (value) values.set(provider.env, value);
	}
	for (const provider of PROVIDERS)
		if (!chosen.includes(provider.id) && values.has(provider.env)) {
			const drop = await confirm(
				ctx.io,
				`Remove the saved ${provider.name} key?`,
				false,
			);
			if (drop) values.delete(provider.env);
		}
	await configure_spend_caps(ctx, values);
	write_credentials(path, values);
	step(
		ctx.io,
		'ok',
		`Saved ${values.size} setting(s) to ${path} (0600)`,
	);
	await connect_clients(ctx, path, values);
	outro(
		ctx.io,
		`Done. Restart your MCP client. Edit keys any time with ${c.cyan(ctx.io, 'mcp-retriever keys')}.`,
	);
	return 0;
};

const print_list = (ctx: CliContext) => {
	const path = credentials_path(ctx.env);
	const values = read_credentials(path);
	ctx.print(`Credentials file: ${path}`);
	for (const provider of PROVIDERS) {
		const { value, source } = source_of(ctx, provider, values);
		const state = value
			? `${mask(value, provider.kind)}${source === 'env' ? '  (environment)' : ''}`
			: c.dim(ctx.io, 'not set');
		ctx.print(`  ${provider.id.padEnd(14)} ${state}`);
	}
	const caps = values.get('RETRIEVER_SPEND_CAPS');
	if (caps) ctx.print(`  ${'spend caps'.padEnd(14)} ${caps}`);
	return 0;
};

const test_all = async (
	ctx: CliContext,
	paid: boolean | 'ask',
	only?: ProviderSpec,
) => {
	const values = read_credentials(credentials_path(ctx.env));
	let failures = 0;
	for (const provider of only ? [only] : PROVIDERS) {
		const { value } = source_of(ctx, provider, values);
		if (!value) continue;
		const result = await maybe_check(
			ctx,
			provider,
			value,
			values,
			paid,
		);
		if (
			result &&
			(result.status === 'invalid' ||
				result.status === 'no_credits' ||
				result.status === 'unreachable')
		)
			failures += 1;
	}
	return failures ? 1 : 0;
};

const keys_menu = async (ctx: CliContext) => {
	const path = credentials_path(ctx.env);
	await banner(ctx.io, 'keys');
	for (;;) {
		const values = read_credentials(path);
		const choice = await select(ctx.io, 'Choose a provider to edit', [
			...PROVIDERS.map((provider) => {
				const { value, source } = source_of(ctx, provider, values);
				return {
					value: provider.id,
					label: `${provider.name.padEnd(30)} ${
						value
							? `${mask(value, provider.kind)}${source === 'env' ? ' (env)' : ''}`
							: '—'
					}`,
					hint: provider.unlocks,
				};
			}),
			{ value: '__test', label: 'Test all saved keys' },
			{ value: '__done', label: 'Done' },
		]);
		if (choice === '__done') break;
		if (choice === '__test') {
			await test_all(ctx, 'ask');
			continue;
		}
		const provider = find_provider(choice)!;
		const has = values.has(provider.env);
		const action = await select(ctx.io, provider.name, [
			{ value: 'set', label: has ? 'Replace' : 'Add' },
			...(has
				? [
						{ value: 'test', label: 'Test' },
						{ value: 'remove', label: 'Remove' },
					]
				: []),
			{ value: 'back', label: 'Back' },
		]);
		if (action === 'set') {
			const value = await collect_value(ctx, provider, values);
			if (value && value !== values.get(provider.env)) {
				values.set(provider.env, value);
				write_credentials(path, values);
				step(ctx.io, 'ok', `${provider.name} saved`);
			}
		} else if (action === 'test') {
			await test_all(ctx, 'ask', provider);
		} else if (action === 'remove') {
			if (
				await confirm(
					ctx.io,
					`Remove the saved ${provider.name} ${provider.kind}?`,
					false,
				)
			) {
				values.delete(provider.env);
				write_credentials(path, values);
				step(ctx.io, 'ok', `${provider.name} removed`);
			}
		}
	}
	outro(ctx.io, 'Restart your MCP client to pick up changes.');
	return 0;
};

const option_value = (args: string[], flag: string) => {
	const index = args.indexOf(flag);
	return index >= 0 ? args[index + 1] : undefined;
};

export const run_keys = async (
	args: string[],
	ctx = default_context(),
) => {
	const [action, target] = args;
	const path = credentials_path(ctx.env);
	if (!action)
		return is_interactive(ctx.io) ? keys_menu(ctx) : print_list(ctx);
	if (action === 'list') return print_list(ctx);
	if (action === 'path') {
		ctx.print(path);
		return 0;
	}
	if (action === 'test') {
		const only =
			target && !target.startsWith('--')
				? find_provider(target)
				: undefined;
		if (target && !target.startsWith('--') && !only) {
			say(ctx, `Unknown provider: ${target}`);
			return 2;
		}
		return test_all(ctx, args.includes('--paid'), only);
	}
	const provider = target ? find_provider(target) : undefined;
	if (!provider) {
		say(
			ctx,
			`Unknown provider: ${target ?? '(none)'}. Known: ${PROVIDERS.map((p) => p.id).join(', ')}`,
		);
		return 2;
	}
	const values = read_credentials(path);
	if (action === 'remove') {
		const had = values.delete(provider.env);
		if (had) write_credentials(path, values);
		say(
			ctx,
			had ? `Removed ${provider.env}` : `${provider.env} was not set`,
		);
		return 0;
	}
	if (action === 'set') {
		const from_env = option_value(args, '--from-env');
		let raw: string | undefined;
		if (from_env) raw = ctx.env[from_env];
		else if (args.includes('--stdin')) raw = ctx.read_stdin();
		else if (is_interactive(ctx.io)) {
			const value = await collect_value(ctx, provider, values);
			if (value) {
				values.set(provider.env, value);
				write_credentials(path, values);
			}
			return 0;
		} else {
			say(
				ctx,
				'Pass --from-env VAR or --stdin. Keys are never accepted as arguments, so they stay out of shell history.',
			);
			return 2;
		}
		const value = raw?.trim();
		if (!value) {
			say(ctx, 'No value received; nothing saved.');
			return 2;
		}
		const problem = validate_value(provider, value);
		if (problem) {
			say(ctx, `${provider.name}: ${problem}`);
			return 2;
		}
		const clean = clean_value(provider, value);
		values.set(provider.env, clean);
		write_credentials(path, values);
		say(
			ctx,
			`Saved ${provider.env} (${mask(clean, provider.kind)}) to ${path}`,
		);
		if (args.includes('--test'))
			return test_all(ctx, args.includes('--paid'), provider);
		return 0;
	}
	say(ctx, `Unknown keys action: ${action}`);
	return 2;
};

export const HELP = `mcp-retriever: multi-provider search and retrieval over MCP

Usage:
  mcp-retriever                 start the MCP server on stdio
  mcp-retriever setup           guided setup: pick providers, add and
                                test keys, connect your MCP clients
  mcp-retriever keys            add, replace, test or remove keys
  mcp-retriever keys list       show configured providers (masked)
  mcp-retriever keys test [provider] [--paid]
  mcp-retriever keys set <provider> --from-env VAR | --stdin [--test]
  mcp-retriever keys remove <provider>
  mcp-retriever keys path       print the credentials file location
  mcp-retriever --version       print the version

Keys are stored in a private file (0600) that the server reads at
startup; environment variables with the same name take precedence.
Set RETRIEVER_CREDENTIALS_FILE to move it, or to "none" to disable.
`;

/** Runs one command and returns its exit code. */
export const run_cli = async (
	argv: string[],
	ctx = default_context(),
): Promise<number> => {
	const [command = 'help', ...rest] = argv;
	try {
		if (command === 'setup') return await run_setup(ctx);
		if (command === 'keys') return await run_keys(rest, ctx);
		if (['help', '--help', '-h'].includes(command)) {
			ctx.print(HELP);
			return 0;
		}
		if (['version', '--version', '-v'].includes(command)) {
			ctx.print(ctx.version);
			return 0;
		}
	} catch (error) {
		if (error instanceof Cancelled) {
			say(ctx, 'Cancelled. Nothing else was changed.');
			return 130;
		}
		throw error;
	}
	say(ctx, `Unknown command: ${command}\n\n${HELP}`);
	return 2;
};
