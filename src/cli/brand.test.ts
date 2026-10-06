import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
	art_rows,
	banner,
	color_depth,
	fits_welcome,
	header_rows,
	play_welcome,
	tagline_row,
	welcome_rows,
	WELCOME_COLS,
	WELCOME_ROWS,
	wordmark_rows,
	WORDMARK_WIDTH,
} from './brand.js';
import { fake_terminal, KEY, strip_ansi } from './test_terminal.js';
import { Cancelled } from './ui.js';

const TAGLINE = 'Search · Retrieve · Read · Extract · Across the Web';
const BRAILLE = /[⠁-⣿]/;
const BLOCKS = /[█▀▄]/;
const LARGE = { columns: 100, rows: 40 };

beforeEach(() => {
	vi.stubEnv('NO_COLOR', '');
});

describe('welcome frames', () => {
	it('keeps every frame the same size and inside the minimum width', () => {
		for (const t of [0, 0.25, 0.5, 0.75, 1]) {
			const rows = welcome_rows(t, 'none');
			expect(rows).toHaveLength(WELCOME_ROWS);
			for (const row of rows)
				expect(row.length).toBeLessThanOrEqual(WELCOME_COLS);
		}
	});

	it('ends on the full mark: art, wordmark and tagline', () => {
		const rows = welcome_rows(1, 'none');
		const art = rows.slice(0, WELCOME_ROWS - 6).join('\n');
		expect(art).toMatch(BRAILLE);
		expect(art).not.toMatch(BLOCKS);
		const wordmark = rows.slice(-5, -2);
		for (const row of wordmark) expect(row).toMatch(BLOCKS);
		expect(Math.max(...wordmark.map((row) => row.length))).toBe(
			WELCOME_COLS,
		);
		expect(rows.at(-1)?.trim()).toBe(TAGLINE);
	});

	it('starts without the wordmark, tagline or result lines', () => {
		const first = welcome_rows(0, 'none');
		expect(first.join('\n')).not.toMatch(BLOCKS);
		expect(first.join('\n')).not.toContain('Search');
		expect(first).not.toEqual(welcome_rows(1, 'none'));
		// Result lines are the only dots strictly inside the lens.
		const dots = (rows: string[]) =>
			rows.join('').replace(/[^⠁-⣿]/g, '').length;
		expect(dots(art_rows(0, 'none'))).toBeLessThan(
			dots(art_rows(1, 'none')),
		);
	});

	it('is deterministic and clamps time to the still frame', () => {
		expect(welcome_rows(0.4, 'none')).toEqual(
			welcome_rows(0.4, 'none'),
		);
		expect(welcome_rows(7, 'none')).toEqual(welcome_rows(1, 'none'));
		expect(welcome_rows(-1, 'none')).toEqual(welcome_rows(0, 'none'));
	});

	it('adds only color codes at each color depth', () => {
		const plain = welcome_rows(1, 'none');
		expect(plain.join('')).not.toContain('\x1b');
		const cases = [
			['true', '\x1b[38;2;0;229;255m'],
			['256', '\x1b[38;5;'],
			['basic', '\x1b[96m'],
		] as const;
		for (const [depth, code] of cases) {
			const colored = welcome_rows(1, depth);
			expect(colored.join('\n')).toContain(code);
			expect(colored.map(strip_ansi)).toEqual(plain);
		}
	});

	it('reveals the wordmark and tagline progressively', () => {
		expect(wordmark_rows(0, 'none')).toEqual(['', '', '']);
		const partial = wordmark_rows(3, 'none');
		const full = wordmark_rows(13, 'none');
		for (const [index, row] of partial.entries()) {
			expect(full[index].startsWith(row)).toBe(true);
			expect(row.length).toBeLessThan(full[index].length);
		}
		expect(full[0]).toHaveLength(WORDMARK_WIDTH);
		expect(tagline_row(2, 'none')).toBe('Search · Retrieve');
		expect(tagline_row(5, 'none')).toBe(TAGLINE);
	});
});

describe('color_depth', () => {
	it('follows the terminal and environment', () => {
		const { io } = fake_terminal();
		expect(color_depth(io, { COLORTERM: 'truecolor' })).toBe('true');
		expect(color_depth(io, { COLORTERM: '24bit' })).toBe('true');
		expect(color_depth(io, { TERM: 'xterm-256color' })).toBe('256');
		expect(color_depth(io, { TERM: 'xterm' })).toBe('basic');
		expect(color_depth(io, {})).toBe('basic');
	});

	it('is off for NO_COLOR and for output that is not a terminal', () => {
		const env = { COLORTERM: 'truecolor' };
		expect(color_depth(fake_terminal({ tty: false }).io, env)).toBe(
			'none',
		);
		vi.stubEnv('NO_COLOR', '1');
		expect(color_depth(fake_terminal().io, env)).toBe('none');
	});
});

describe('compact header', () => {
	it('puts the mark beside the name and the screen title', () => {
		const rows = header_rows(fake_terminal().io, 'keys').map(
			strip_ansi,
		);
		expect(rows).toHaveLength(2);
		expect(rows[0]).toMatch(BRAILLE);
		expect(rows[0].endsWith('  mcp-retriever')).toBe(true);
		expect(rows[1].endsWith('  keys')).toBe(true);
		expect(rows[0].indexOf('mcp-retriever')).toBe(
			rows[1].indexOf('keys'),
		);
	});
});

describe('fits_welcome', () => {
	it('needs an interactive terminal with room for the frame', () => {
		expect(fits_welcome(fake_terminal(LARGE).io, {})).toBe(true);
		expect(
			fits_welcome(fake_terminal({ columns: 80, rows: 24 }).io, {}),
		).toBe(true);
		expect(
			fits_welcome(
				fake_terminal({ columns: WELCOME_COLS, rows: 40 }).io,
				{},
			),
		).toBe(false);
		expect(
			fits_welcome(
				fake_terminal({ columns: 100, rows: WELCOME_ROWS + 1 }).io,
				{},
			),
		).toBe(false);
		expect(
			fits_welcome(fake_terminal({ ...LARGE, tty: false }).io, {}),
		).toBe(false);
		expect(
			fits_welcome(fake_terminal(LARGE).io, { TERM: 'dumb' }),
		).toBe(false);
	});
});

describe('banner', () => {
	it('shows only the compact header on a small terminal', async () => {
		const terminal = fake_terminal({ columns: 60, rows: 20 });
		await banner(terminal.io, 'setup', { welcome: true });
		expect(terminal.text()).toContain('mcp-retriever');
		expect(terminal.text()).toContain('setup');
		expect(terminal.text()).not.toContain('Search');
		expect(terminal.raw()).not.toContain('\x1b[?25l');
		expect(terminal.text().split('\n')).toHaveLength(4);
	});

	it('shows the compact header when no welcome is asked for', async () => {
		const terminal = fake_terminal(LARGE);
		await banner(terminal.io, 'keys');
		expect(terminal.text()).not.toContain('Search');
		expect(terminal.text()).toContain('keys');
	});

	it('plays the welcome and leaves the still frame on screen', async () => {
		const terminal = fake_terminal(LARGE);
		await banner(terminal.io, 'setup', {
			welcome: true,
			frames: 3,
			interval_ms: 1,
		});
		const raw = terminal.raw();
		expect(raw.indexOf('\x1b[?25l')).toBeGreaterThanOrEqual(0);
		expect(raw.indexOf('\x1b[?25h')).toBeGreaterThan(
			raw.indexOf('\x1b[?25l'),
		);
		// Each redraw moves back up over exactly one frame.
		expect(raw).toContain(`\x1b[${WELCOME_ROWS}A`);
		expect(terminal.is_raw()).toBe(false);
		const text = terminal.text();
		expect(text).toContain(TAGLINE);
		expect(text.trimEnd().endsWith('│')).toBe(true);
		expect(text.lastIndexOf('setup')).toBeGreaterThan(
			text.lastIndexOf(TAGLINE),
		);
	});
});

describe('play_welcome', () => {
	it('skips to the still frame on any key and consumes that key', async () => {
		const terminal = fake_terminal(LARGE);
		terminal.keys(KEY.enter);
		const started = Date.now();
		await play_welcome(terminal.io, {
			frames: 1000,
			interval_ms: 50,
		});
		expect(Date.now() - started).toBeLessThan(2000);
		expect(terminal.text()).toContain(TAGLINE);
		expect(terminal.is_raw()).toBe(false);
		expect(terminal.io.input.read()).toBeNull();
	});

	it('cancels on Ctrl+C and restores the terminal', async () => {
		const terminal = fake_terminal(LARGE);
		terminal.keys(KEY.ctrl_c);
		await expect(
			play_welcome(terminal.io, { frames: 1000, interval_ms: 50 }),
		).rejects.toBeInstanceOf(Cancelled);
		expect(terminal.is_raw()).toBe(false);
		expect(terminal.raw().endsWith('\x1b[?25h')).toBe(true);
	});
});
