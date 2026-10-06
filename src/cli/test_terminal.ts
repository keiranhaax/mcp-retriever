import { PassThrough, Writable } from 'node:stream';
import type { Io } from './ui.js';

/**
 * A scripted terminal for prompt tests: a TTY-shaped input that
 * accepts queued keys and an output that records what was drawn.
 */

export const KEY = {
	enter: '\r',
	space: ' ',
	up: '\x1b[A',
	down: '\x1b[B',
	backspace: '\x7f',
	ctrl_c: '\x03',
} as const;

// oxlint-disable-next-line no-control-regex
const ANSI = /\x1b\[[0-9;?]*[A-Za-z]/g;

export const strip_ansi = (text: string): string =>
	text.replace(ANSI, '');

/** The URL of a recorded `fetch` call. */
export const request_url = (input: string | URL | Request): string =>
	typeof input === 'string'
		? input
		: input instanceof URL
			? input.href
			: input.url;

export interface FakeTerminal {
	io: Io;
	/**
	 * Queues input. Each argument arrives as its own chunk, so a
	 * prompt that finishes leaves the rest for the next prompt.
	 */
	keys: (...keys: string[]) => void;
	/** Everything written, escape sequences included. */
	raw: () => string;
	/** Everything written, with escape sequences removed. */
	text: () => string;
	is_raw: () => boolean;
}

export const fake_terminal = ({
	columns = 60,
	rows = 20,
	tty = true,
}: {
	columns?: number;
	rows?: number;
	tty?: boolean;
} = {}): FakeTerminal => {
	const state = { raw: false };
	const input = Object.assign(new PassThrough(), {
		isTTY: tty,
		get isRaw() {
			return state.raw;
		},
		setRawMode(mode: boolean) {
			state.raw = mode;
			return input;
		},
	});
	const written: string[] = [];
	const output = Object.assign(
		new Writable({
			write(chunk, _encoding, done) {
				written.push(String(chunk));
				done();
			},
		}),
		{ isTTY: tty, columns, rows },
	);
	return {
		io: { input, output } as unknown as Io,
		keys: (...keys) => {
			for (const key of keys) input.write(key);
		},
		raw: () => written.join(''),
		text: () => strip_ansi(written.join('')),
		is_raw: () => state.raw,
	};
};
