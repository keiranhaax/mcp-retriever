import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fake_terminal, KEY, strip_ansi } from './test_terminal.js';
import {
	Cancelled,
	clip,
	confirm,
	is_interactive,
	multiselect,
	note,
	select,
	spin,
	step,
	text,
	wrap,
} from './ui.js';

const OPTIONS = [
	{ value: 'a', label: 'Alpha' },
	{ value: 'b', label: 'Beta', hint: 'second' },
	{ value: 'c', label: 'Gamma' },
];

beforeEach(() => {
	// Colors stay on for the fake TTY whatever the runner exports.
	vi.stubEnv('NO_COLOR', '');
});

describe('clip', () => {
	it('leaves rows that fit alone', () => {
		expect(clip('short', 20)).toBe('short');
	});

	it('truncates to the terminal width with an ellipsis', () => {
		const clipped = clip('abcdefghijklmnopqrstuvwxyz', 10);
		expect(strip_ansi(clipped)).toBe('abcdefghi…');
	});

	it('does not count escape sequences towards the width', () => {
		const row = `\x1b[36mabc\x1b[0m\x1b[2mdef\x1b[0m`;
		expect(clip(row, 10)).toBe(row);
		expect(strip_ansi(clip(row, 5))).toBe('abcd…');
		expect(clip(row, 5).startsWith('\x1b[36mabc\x1b[0m')).toBe(true);
	});
});

describe('wrap', () => {
	it('breaks between words and never splits one', () => {
		expect(wrap('one two three', 20)).toEqual(['one two three']);
		expect(wrap('one two three', 7)).toEqual(['one two', 'three']);
		expect(wrap('to /a/very/long/path now', 8)).toEqual([
			'to',
			'/a/very/long/path',
			'now',
		]);
	});

	it('writes paths and commands to copy in full', () => {
		const terminal = fake_terminal({ columns: 30 });
		const command =
			'claude mcp add --scope user mcp-retriever -- node /opt/a/long/path/dist/index.js';
		note(terminal.io, [command], 'Run this command');
		step(terminal.io, 'ok', `Saved to ${'/deep'.repeat(12)}/file`);
		expect(terminal.text()).toContain(command);
		expect(terminal.text()).toContain(`${'/deep'.repeat(12)}/file`);
		expect(terminal.text()).not.toContain('…');
	});

	it('keeps a status message whole on a narrow terminal', () => {
		const terminal = fake_terminal({ columns: 30 });
		const message =
			'Cursor: this entry carries TAVILY_API_KEY inline today';
		step(terminal.io, 'info', message);
		const rows = terminal.text().trimEnd().split('\n');
		expect(rows.length).toBeGreaterThan(1);
		for (const row of rows) expect(row.length).toBeLessThan(30);
		expect(
			rows.map((row) => row.replace(/^│ {2}[· ] /, '')).join(' '),
		).toBe(message);
	});

	it('wraps a long question instead of cutting it off', async () => {
		const terminal = fake_terminal({ columns: 30 });
		terminal.keys('y');
		const question =
			'Write this entry? Other servers are kept and a .bak copy is made.';
		expect(await confirm(terminal.io, question)).toBe(true);
		expect(terminal.text()).not.toContain('…');
		expect(terminal.text().replace(/\n[│◆◇] {2}/g, ' ')).toContain(
			question,
		);
	});
});

describe('is_interactive', () => {
	it('needs a terminal on both ends', () => {
		expect(is_interactive(fake_terminal().io)).toBe(true);
		expect(is_interactive(fake_terminal({ tty: false }).io)).toBe(
			false,
		);
	});
});

describe('select', () => {
	it('moves with the arrow keys and returns the chosen value', async () => {
		const terminal = fake_terminal();
		terminal.keys(KEY.down, KEY.enter);
		expect(await select(terminal.io, 'Pick one', OPTIONS)).toBe('b');
		expect(terminal.text()).toContain('Pick one');
		expect(terminal.text()).toContain('second');
	});

	it('wraps around from the first option to the last', async () => {
		const terminal = fake_terminal();
		terminal.keys(KEY.up, KEY.enter);
		expect(await select(terminal.io, 'Pick one', OPTIONS)).toBe('c');
	});

	it('restores the terminal when it finishes', async () => {
		const terminal = fake_terminal();
		terminal.keys(KEY.enter);
		await select(terminal.io, 'Pick one', OPTIONS);
		expect(terminal.is_raw()).toBe(false);
		expect(terminal.raw().endsWith('\x1b[?25h')).toBe(true);
	});

	it('leaves later input for the next prompt', async () => {
		const terminal = fake_terminal();
		terminal.keys(KEY.enter, KEY.down, KEY.down, KEY.enter);
		expect(await select(terminal.io, 'First', OPTIONS)).toBe('a');
		expect(await select(terminal.io, 'Second', OPTIONS)).toBe('c');
	});
});

describe('multiselect', () => {
	it('toggles with space and keeps option order', async () => {
		const terminal = fake_terminal();
		terminal.keys(
			KEY.down,
			KEY.down,
			KEY.space,
			KEY.up,
			KEY.up,
			KEY.space,
			KEY.enter,
		);
		expect(await multiselect(terminal.io, 'Pick', OPTIONS)).toEqual([
			'a',
			'c',
		]);
	});

	it('starts from the initial set and toggles everything with a', async () => {
		const first = fake_terminal();
		first.keys(KEY.enter);
		expect(
			await multiselect(first.io, 'Pick', OPTIONS, new Set(['b'])),
		).toEqual(['b']);
		const all = fake_terminal();
		all.keys('a', KEY.enter);
		expect(await multiselect(all.io, 'Pick', OPTIONS)).toEqual([
			'a',
			'b',
			'c',
		]);
		const none = fake_terminal();
		none.keys('a', 'a', KEY.enter);
		expect(await multiselect(none.io, 'Pick', OPTIONS)).toEqual([]);
	});
});

describe('text', () => {
	it('collects typed input and honors backspace', async () => {
		const terminal = fake_terminal();
		terminal.keys('helloo', KEY.backspace, KEY.enter);
		expect(await text(terminal.io, 'Name')).toBe('hello');
	});

	it('returns an empty answer when skipped', async () => {
		const terminal = fake_terminal();
		terminal.keys(KEY.enter);
		expect(
			await text(terminal.io, 'Name', {
				validate: () => 'never run',
			}),
		).toBe('');
		expect(terminal.text()).toContain('skipped');
	});

	it('shows a validation error and accepts a corrected value', async () => {
		const terminal = fake_terminal();
		terminal.keys('bad', KEY.enter, 'ly', KEY.enter);
		const answer = await text(terminal.io, 'Word', {
			validate: (value) =>
				value.length < 5 ? 'needs five letters' : undefined,
		});
		expect(answer).toBe('badly');
		expect(terminal.text()).toContain('needs five letters');
	});

	it('never draws a secret', async () => {
		const secret = 'sk-live-0123456789abcdef';
		const terminal = fake_terminal();
		terminal.keys(secret, KEY.enter);
		expect(await text(terminal.io, 'Key', { secret: true })).toBe(
			secret,
		);
		expect(terminal.raw()).not.toContain(secret);
		expect(terminal.raw()).not.toContain('cdef');
		expect(terminal.text()).toContain(
			`(${secret.length} characters)`,
		);
	});
});

describe('confirm', () => {
	it('answers with y, n, enter or a toggled default', async () => {
		const answer = async (initial: boolean, ...keys: string[]) => {
			const terminal = fake_terminal();
			terminal.keys(...keys);
			return confirm(terminal.io, 'Sure?', initial);
		};
		expect(await answer(false, 'y')).toBe(true);
		expect(await answer(true, 'n')).toBe(false);
		expect(await answer(true, KEY.enter)).toBe(true);
		expect(await answer(false, KEY.enter)).toBe(false);
		expect(await answer(false, '\t', KEY.enter)).toBe(true);
	});
});

describe('cancelling', () => {
	it('rejects with Cancelled on Ctrl+C and restores the terminal', async () => {
		const terminal = fake_terminal();
		terminal.keys(KEY.ctrl_c);
		await expect(
			select(terminal.io, 'Pick one', OPTIONS),
		).rejects.toBeInstanceOf(Cancelled);
		expect(terminal.is_raw()).toBe(false);
		expect(terminal.raw().endsWith('\x1b[?25h')).toBe(true);
		expect(terminal.text()).toContain('cancelled');
	});
});

describe('spin', () => {
	it('returns the task result and clears its row', async () => {
		const terminal = fake_terminal();
		expect(await spin(terminal.io, 'Working…', async () => 7)).toBe(
			7,
		);
		expect(terminal.text()).toContain('Working…');
		expect(terminal.raw().endsWith('\r\x1b[2K')).toBe(true);
	});

	it('stays silent without a terminal and still propagates errors', async () => {
		const terminal = fake_terminal({ tty: false });
		await expect(
			spin(terminal.io, 'Working…', async () => {
				throw new Error('boom');
			}),
		).rejects.toThrow('boom');
		expect(terminal.raw()).toBe('');
	});
});
