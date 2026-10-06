import { emitKeypressEvents, type Key } from 'node:readline';

/**
 * A small dependency-free prompt kit for the setup TUI: select,
 * multiselect, text (optionally masked) and confirm, drawn in a
 * left gutter. Interactive prompts need a TTY on both ends; callers
 * check `is_interactive` and use flags otherwise. Escape or Ctrl+C
 * rejects with `Cancelled` and nothing is saved.
 */

export class Cancelled extends Error {
	constructor() {
		super('cancelled');
	}
}

export interface Io {
	input: NodeJS.ReadStream;
	output: NodeJS.WriteStream;
}

export const default_io = (): Io => ({
	input: process.stdin,
	output: process.stderr,
});

export const is_interactive = (io: Io): boolean =>
	Boolean(io.input.isTTY && io.output.isTTY);

export const use_color = (io: Io) =>
	Boolean(io.output.isTTY) && !process.env.NO_COLOR;

const paint =
	(code: string) =>
	(io: Io, text: string): string =>
		use_color(io) ? `\x1b[${code}m${text}\x1b[0m` : text;

export const c = {
	dim: paint('2'),
	bold: paint('1'),
	cyan: paint('36'),
	green: paint('32'),
	yellow: paint('33'),
	red: paint('31'),
	inverse: paint('7'),
};

export const BAR = '│';
// oxlint-disable-next-line no-control-regex
const ESCAPE_SEQUENCE = /^\x1b\[[0-9;]*m/;

/** Truncates to the visible terminal width, keeping ANSI codes. */
export const clip = (row: string, width: number): string => {
	let visible = 0;
	let out = '';
	let index = 0;
	while (index < row.length) {
		if (row[index] === '\x1b') {
			const match = ESCAPE_SEQUENCE.exec(row.slice(index));
			if (match) {
				out += match[0];
				index += match[0].length;
				continue;
			}
		}
		if (visible >= width - 1 && index < row.length - 1) {
			return `${out}…\x1b[0m`;
		}
		out += row[index];
		visible += 1;
		index += 1;
	}
	return out;
};

/**
 * Word-wraps plain text to `width` columns. A word longer than that,
 * such as a path, keeps a line to itself and is never split.
 */
export const wrap = (text: string, width: number): string[] => {
	const lines: string[] = [];
	let line = '';
	for (const word of text.split(' ')) {
		if (line && line.length + 1 + word.length > width) {
			lines.push(line);
			line = '';
		}
		line = line ? `${line} ${word}` : word;
	}
	lines.push(line);
	return lines;
};

const text_width = (io: Io, gutter: number) =>
	Math.max(20, (io.output.columns || 80) - gutter - 1);

/** Rows of a redrawn frame: one terminal line each, so clipped. */
export const write_rows = (io: Io, rows: string[]) => {
	const width = io.output.columns || 80;
	io.output.write(
		`${rows.map((row) => clip(row, width)).join('\n')}\n`,
	);
};

// Rows that are written once carry paths, commands and snippets to
// copy. They are never cut short; the terminal wraps what is too long.
const write_static = (io: Io, rows: string[]) =>
	io.output.write(`${rows.join('\n')}\n`);

export const outro = (io: Io, message: string) =>
	write_static(io, [`${c.dim(io, '└')}  ${message}`, '']);

export const note = (io: Io, lines: string[], title?: string) => {
	const rows = title
		? wrap(title, text_width(io, 3)).map(
				(line, index) =>
					`${index ? c.dim(io, BAR) : c.cyan(io, '●')}  ${line}`,
			)
		: [];
	for (const line of lines) rows.push(`${c.dim(io, BAR)}  ${line}`);
	rows.push(c.dim(io, BAR));
	write_static(io, rows);
};

export const step = (
	io: Io,
	status: 'ok' | 'warn' | 'fail' | 'info',
	message: string,
) => {
	const icon = {
		ok: c.green(io, '✓'),
		warn: c.yellow(io, '!'),
		fail: c.red(io, '✗'),
		info: c.cyan(io, '·'),
	}[status];
	write_static(
		io,
		wrap(message, text_width(io, 5)).map(
			(line, index) =>
				`${c.dim(io, BAR)}  ${index ? ' ' : icon} ${line}`,
		),
	);
};

type Outcome<T> = { done: T } | undefined;

const interactive = <T>(
	io: Io,
	frame: () => string[],
	final: (value: T) => string[],
	cancelled: () => string[],
	on_key: (input: string | undefined, key: Key) => Outcome<T>,
): Promise<T> =>
	new Promise((resolve, reject) => {
		const { input, output } = io;
		emitKeypressEvents(input);
		const was_raw = input.isRaw;
		input.setRawMode(true);
		input.resume();
		output.write('\x1b[?25l');
		let drawn = 0;
		const draw = (rows: string[]) => {
			if (drawn) output.write(`\x1b[${drawn}A\r\x1b[0J`);
			write_rows(io, rows);
			drawn = rows.length;
		};
		const finish = () => {
			input.off('keypress', listener);
			input.setRawMode(was_raw);
			input.pause();
			output.write('\x1b[?25h');
		};
		const listener = (text: string | undefined, key?: Key) => {
			const pressed = key ?? ({} as Key);
			if (
				(pressed.ctrl && pressed.name === 'c') ||
				pressed.name === 'escape'
			) {
				draw(cancelled());
				finish();
				reject(new Cancelled());
				return;
			}
			const outcome = on_key(text, pressed);
			if (outcome) {
				draw(final(outcome.done));
				finish();
				resolve(outcome.done);
				return;
			}
			draw(frame());
		};
		input.on('keypress', listener);
		draw(frame());
	});

const header = (
	io: Io,
	state: 'active' | 'done' | 'cancel',
	message: string,
) => {
	const icon = {
		active: c.cyan(io, '◆'),
		done: c.green(io, '◇'),
		cancel: c.red(io, '■'),
	}[state];
	const bar = state === 'active' ? c.cyan(io, BAR) : c.dim(io, BAR);
	return wrap(message, text_width(io, 3)).map(
		(line, index) => `${index ? bar : icon}  ${c.bold(io, line)}`,
	);
};

const answered = (io: Io, message: string, value: string) => [
	...header(io, 'done', message),
	`${c.dim(io, BAR)}  ${c.dim(io, value)}`,
	c.dim(io, BAR),
];

const aborted = (io: Io, message: string) => () => [
	...header(io, 'cancel', message),
	`${c.dim(io, BAR)}  ${c.dim(io, 'cancelled')}`,
];

export interface Option<T> {
	value: T;
	label: string;
	hint?: string;
}

const option_row = <T>(
	io: Io,
	option: Option<T>,
	active: boolean,
	marker: string,
) => {
	const label = active ? option.label : c.dim(io, option.label);
	const hint =
		option.hint && active ? `  ${c.dim(io, option.hint)}` : '';
	return `${c.cyan(io, BAR)}  ${marker} ${label}${hint}`;
};

export const select = <T>(
	io: Io,
	message: string,
	options: Option<T>[],
	initial = 0,
): Promise<T> => {
	let cursor = Math.min(Math.max(initial, 0), options.length - 1);
	return interactive(
		io,
		() => [
			...header(io, 'active', message),
			...options.map((option, index) =>
				option_row(
					io,
					option,
					index === cursor,
					index === cursor ? c.green(io, '●') : c.dim(io, '○'),
				),
			),
			c.cyan(io, '└'),
		],
		() => answered(io, message, options[cursor].label),
		aborted(io, message),
		(_text, key) => {
			if (key.name === 'up' || key.name === 'k')
				cursor = (cursor - 1 + options.length) % options.length;
			else if (key.name === 'down' || key.name === 'j')
				cursor = (cursor + 1) % options.length;
			else if (key.name === 'return')
				return { done: options[cursor].value };
			return undefined;
		},
	);
};

export const multiselect = <T>(
	io: Io,
	message: string,
	options: Option<T>[],
	initial: ReadonlySet<T> = new Set(),
): Promise<T[]> => {
	let cursor = 0;
	const chosen = new Set(initial);
	return interactive(
		io,
		() => [
			...header(io, 'active', message),
			...options.map((option, index) =>
				option_row(
					io,
					option,
					index === cursor,
					chosen.has(option.value)
						? c.green(io, '◼')
						: c.dim(io, '◻'),
				),
			),
			`${c.cyan(io, '└')}  ${c.dim(io, 'space toggle · a all · enter confirm')}`,
		],
		(values) =>
			answered(
				io,
				message,
				values.length
					? options
							.filter((option) => chosen.has(option.value))
							.map((option) => option.label)
							.join(', ')
					: 'none',
			),
		aborted(io, message),
		(_text, key) => {
			if (key.name === 'up' || key.name === 'k')
				cursor = (cursor - 1 + options.length) % options.length;
			else if (key.name === 'down' || key.name === 'j')
				cursor = (cursor + 1) % options.length;
			else if (key.name === 'space') {
				const value = options[cursor].value;
				if (chosen.has(value)) chosen.delete(value);
				else chosen.add(value);
			} else if (key.name === 'a') {
				const all = options.every((option) =>
					chosen.has(option.value),
				);
				for (const option of options)
					if (all) chosen.delete(option.value);
					else chosen.add(option.value);
			} else if (key.name === 'return')
				return {
					done: options
						.filter((option) => chosen.has(option.value))
						.map((option) => option.value),
				};
			return undefined;
		},
	);
};

export interface TextOptions {
	placeholder?: string;
	initial?: string;
	secret?: boolean;
	/** Returns an error message, or undefined when the value is valid. */
	validate?: (value: string) => string | undefined;
}

export const text = (
	io: Io,
	message: string,
	options: TextOptions = {},
): Promise<string> => {
	let value = options.initial ?? '';
	let error: string | undefined;
	const shown = () =>
		options.secret ? '•'.repeat(Math.min(value.length, 48)) : value;
	return interactive(
		io,
		() => [
			...header(io, 'active', message),
			`${c.cyan(io, BAR)}  ${
				value
					? `${shown()}${c.inverse(io, ' ')}`
					: `${c.inverse(io, ' ')}${c.dim(io, options.placeholder ?? '')}`
			}`,
			error
				? `${c.yellow(io, '└')}  ${c.yellow(io, error)}`
				: c.cyan(io, '└'),
		],
		(result) =>
			answered(
				io,
				message,
				result
					? options.secret
						? `${'•'.repeat(8)} (${result.length} characters)`
						: result
					: 'skipped',
			),
		aborted(io, message),
		(input, key) => {
			error = undefined;
			if (key.name === 'return') {
				const result = value.trim();
				const problem = result
					? options.validate?.(result)
					: undefined;
				if (problem) {
					error = problem;
					return undefined;
				}
				return { done: result };
			}
			if (key.name === 'backspace') value = value.slice(0, -1);
			else if (key.ctrl && key.name === 'u') value = '';
			else if (
				input &&
				!key.ctrl &&
				!key.meta &&
				// oxlint-disable-next-line no-control-regex
				!/[\x00-\x1f\x7f]/.test(input)
			)
				value += input;
			return undefined;
		},
	);
};

export const confirm = (
	io: Io,
	message: string,
	initial = true,
): Promise<boolean> => {
	let value = initial;
	const choice = (label: string, on: boolean) =>
		on ? `${c.green(io, '●')} ${label}` : c.dim(io, `○ ${label}`);
	return interactive(
		io,
		() => [
			...header(io, 'active', message),
			`${c.cyan(io, BAR)}  ${choice('Yes', value)}  ${choice('No', !value)}`,
			c.cyan(io, '└'),
		],
		(result) => answered(io, message, result ? 'Yes' : 'No'),
		aborted(io, message),
		(input, key) => {
			if (['left', 'right', 'tab', 'h', 'l'].includes(key.name ?? ''))
				value = !value;
			else if (input === 'y' || input === 'Y') return { done: true };
			else if (input === 'n' || input === 'N') return { done: false };
			else if (key.name === 'return') return { done: value };
			return undefined;
		},
	);
};

/** Runs `task` with a spinner row, then replaces it with a result. */
export const spin = async <T>(
	io: Io,
	label: string,
	task: () => Promise<T>,
): Promise<T> => {
	const frames = ['◒', '◐', '◓', '◑'];
	let index = 0;
	const tty = Boolean(io.output.isTTY);
	const render = () =>
		io.output.write(
			`\r\x1b[2K${c.dim(io, BAR)}  ${c.cyan(io, frames[index++ % 4])} ${label}`,
		);
	const timer = tty ? setInterval(render, 90) : undefined;
	if (tty) render();
	try {
		return await task();
	} finally {
		if (timer) clearInterval(timer);
		if (tty) io.output.write('\r\x1b[2K');
	}
};
