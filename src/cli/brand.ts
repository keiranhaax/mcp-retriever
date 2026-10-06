import { emitKeypressEvents, type Key } from 'node:readline';
import {
	BAR,
	c,
	Cancelled,
	clip,
	is_interactive,
	use_color,
	write_rows,
	type Io,
} from './ui.js';

/**
 * Brand art for the setup TUI: a dotted globe under a segmented
 * magnifier whose lens holds result lines, fed by ten sources. The
 * welcome screen draws it in Unicode braille and plays a short
 * animation (packets travel in, lines resolve inside the lens) that
 * ends on a still frame. Other screens show a compact mark beside the
 * name. Small terminals get the compact header only, and everything
 * degrades to plain text without color.
 */

export type Rgb = readonly [number, number, number];
export type ColorDepth = 'none' | 'basic' | '256' | 'true';

type Env = Record<string, string | undefined>;

const CYAN: Rgb = [0, 229, 255];
const MINT: Rgb = [94, 255, 196];
const BLUE: Rgb = [64, 128, 255];
const VIOLET: Rgb = [160, 107, 255];
const WHITE: Rgb = [255, 255, 255];
const TRACE: Rgb = [72, 96, 136];

export const color_depth = (
	io: Io,
	env: Env = process.env,
): ColorDepth => {
	if (!use_color(io)) return 'none';
	if (/truecolor|24bit/i.test(env.COLORTERM ?? '')) return 'true';
	if (/256/.test(env.TERM ?? '')) return '256';
	return 'basic';
};

const sgr = ([red, green, blue]: Rgb, depth: ColorDepth): string => {
	if (depth === 'true') return `38;2;${red};${green};${blue}`;
	if (depth === '256') {
		const level = (value: number) => Math.round((value / 255) * 5);
		return `38;5;${16 + 36 * level(red) + 6 * level(green) + level(blue)}`;
	}
	const bit = (value: number) => (value >= 128 ? 1 : 0);
	return String(90 + bit(red) + 2 * bit(green) + 4 * bit(blue));
};

export const tint = (
	text: string,
	color: Rgb,
	depth: ColorDepth,
	bold = false,
): string =>
	depth === 'none'
		? text
		: `\x1b[${bold ? '1;' : ''}${sgr(color, depth)}m${text}\x1b[0m`;

const mix = (from: Rgb, to: Rgb, amount: number): Rgb => [
	Math.round(from[0] + (to[0] - from[0]) * amount),
	Math.round(from[1] + (to[1] - from[1]) * amount),
	Math.round(from[2] + (to[2] - from[2]) * amount),
];

const clamp = (value: number) => Math.min(1, Math.max(0, value));
const radians = (degrees: number) => (degrees * Math.PI) / 180;

// Braille packs a 2 x 4 dot grid into one character cell.
const DOT_BITS = [
	[0x01, 0x08],
	[0x02, 0x10],
	[0x04, 0x20],
	[0x40, 0x80],
] as const;

interface Canvas {
	dot: (x: number, y: number, color: Rgb) => void;
	erase: (x: number, y: number) => void;
	render: (depth: ColorDepth) => string[];
}

/** A dot canvas. Each cell takes the color of the last dot set in it. */
const create_canvas = (cols: number, rows: number): Canvas => {
	const width = cols * 2;
	const height = rows * 4;
	const lit = new Uint8Array(width * height);
	const colors: (Rgb | undefined)[] = Array.from({
		length: cols * rows,
	});
	const inside = (x: number, y: number) =>
		x >= 0 && y >= 0 && x < width && y < height;
	return {
		dot: (x, y, color) => {
			const px = Math.round(x);
			const py = Math.round(y);
			if (!inside(px, py)) return;
			lit[py * width + px] = 1;
			colors[(py >> 2) * cols + (px >> 1)] = color;
		},
		erase: (x, y) => {
			const px = Math.round(x);
			const py = Math.round(y);
			if (inside(px, py)) lit[py * width + px] = 0;
		},
		render: (depth) => {
			const out: string[] = [];
			for (let row = 0; row < rows; row += 1) {
				let line = '';
				let run = '';
				let run_color: Rgb | undefined;
				const flush = () => {
					if (run)
						line += run_color ? tint(run, run_color, depth) : run;
					run = '';
				};
				for (let col = 0; col < cols; col += 1) {
					let bits = 0;
					for (let dy = 0; dy < 4; dy += 1)
						for (let dx = 0; dx < 2; dx += 1)
							if (lit[(row * 4 + dy) * width + col * 2 + dx])
								bits |= DOT_BITS[dy][dx];
					const color = bits ? colors[row * cols + col] : undefined;
					if (color !== run_color) {
						flush();
						run_color = color;
					}
					run += bits ? String.fromCharCode(0x2800 + bits) : ' ';
				}
				flush();
				out.push(line.trimEnd());
			}
			return out;
		},
	};
};

const arc = (
	canvas: Canvas,
	x: number,
	y: number,
	radius: number,
	color: Rgb,
	keep: (degrees: number) => boolean = () => true,
) => {
	const steps = Math.ceil(2 * Math.PI * radius * 1.5);
	for (let step = 0; step < steps; step += 1) {
		const degrees = (step / steps) * 360;
		if (!keep(degrees)) continue;
		canvas.dot(
			x + radius * Math.cos(radians(degrees)),
			y + radius * Math.sin(radians(degrees)),
			color,
		);
	}
};

const ART_COLS = 72;
const ART_ROWS = 15;
const GLOBE = { x: 64, y: 28, r: 21 };
const LENS = { x: 82, y: 35, r: 15 };

// Blue on the left limb through cyan to mint on the right. A fixed set
// of stops keeps neighbouring cells in one escape sequence.
const GLOBE_SHADES: readonly Rgb[] = Array.from(
	{ length: 9 },
	(_, stop) =>
		stop < 4
			? mix(BLUE, CYAN, stop / 4)
			: mix(CYAN, MINT, (stop - 4) / 4),
);

const draw_globe = (canvas: Canvas, spin: number) => {
	const { x, y, r } = GLOBE;
	const shade = (px: number) =>
		GLOBE_SHADES[Math.round(clamp(((px - x) / r + 1) / 2) * 8)];
	for (let degrees = 0; degrees < 360; degrees += 6) {
		const px = x + r * Math.cos(radians(degrees));
		canvas.dot(px, y + r * Math.sin(radians(degrees)), shade(px));
	}
	// Dots where meridians cross parallels, front hemisphere only.
	for (let latitude = -72; latitude <= 72; latitude += 12) {
		const ring = r * Math.cos(radians(latitude));
		const py = y - r * Math.sin(radians(latitude));
		for (let longitude = -180; longitude < 180; longitude += 12) {
			const angle = radians(longitude + spin);
			if (Math.cos(angle) <= 0.1) continue;
			const px = x + ring * Math.sin(angle);
			canvas.dot(px, py, shade(px));
		}
	}
};

// Result lines inside the lens: two dots tall, on cell boundaries.
const RESULT_BARS = [
	{ y: -7, length: 13 },
	{ y: -3, length: 18 },
	{ y: 1, length: 11 },
	{ y: 5, length: 15 },
] as const;

const draw_lens = (canvas: Canvas, resolved: readonly number[]) => {
	const { x, y, r } = LENS;
	for (let py = y - r; py <= y + r; py += 1)
		for (let px = x - r; px <= x + r; px += 1)
			if (Math.hypot(px - x, py - y) < r) canvas.erase(px, py);
	for (const radius of [r - 0.5, r + 0.5])
		arc(canvas, x, y, radius, WHITE, (degrees) => degrees % 45 >= 8);
	// Handle towards the lower right, three dots thick.
	const slope = Math.SQRT1_2;
	for (const offset of [-1, 0, 1])
		for (let reach = r + 2; reach <= r + 14; reach += 0.5)
			canvas.dot(
				x + slope * (reach - offset),
				y + slope * (reach + offset),
				WHITE,
			);
	RESULT_BARS.forEach((bar, index) => {
		const length = Math.round(bar.length * clamp(resolved[index]));
		for (let step = 0; step < length; step += 1) {
			canvas.dot(x - 8 + step, y + bar.y, CYAN);
			canvas.dot(x - 8 + step, y + bar.y + 1, CYAN);
		}
	});
};

interface Source {
	x: number;
	y: number;
	color: Rgb;
	icon: readonly string[];
}

const SOURCES: readonly Source[] = [
	{
		x: 36,
		y: 8,
		color: CYAN,
		icon: [' ### ', '#####', '#####', '#####', ' ### '],
	},
	{
		x: 16,
		y: 18,
		color: [255, 95, 210],
		icon: ['#####', '#   #', '#   #', '#   #', '#####'],
	},
	{
		x: 9,
		y: 30,
		color: MINT,
		icon: ['  #  ', ' ### ', '#####', ' ### ', '  #  '],
	},
	{
		x: 16,
		y: 42,
		color: [255, 170, 80],
		icon: ['#####', '     ', '#####', '     ', '#####'],
	},
	{
		x: 36,
		y: 52,
		color: BLUE,
		icon: ['  #  ', '  #  ', '#####', '  #  ', '  #  '],
	},
	{
		x: 108,
		y: 8,
		color: [124, 255, 107],
		icon: ['#####', '#####', '#####', '#####', '#####'],
	},
	{
		x: 127,
		y: 17,
		color: VIOLET,
		icon: [' ### ', '#   #', '#   #', '#   #', ' ### '],
	},
	{
		x: 134,
		y: 26,
		color: [255, 232, 110],
		icon: ['  #  ', '  #  ', ' ### ', ' ### ', '#####'],
	},
	{
		x: 133,
		y: 36,
		color: [255, 110, 110],
		icon: ['#   #', ' # # ', '  #  ', ' # # ', '#   #'],
	},
	{
		x: 125,
		y: 44,
		color: [120, 200, 255],
		icon: ['#    ', '###  ', '#####', '###  ', '#    '],
	},
];

/** Points from just outside a source to the edge of the globe or lens. */
const connection = (
	source: Source,
): (readonly [number, number])[] => {
	const dx = GLOBE.x - source.x;
	const dy = GLOBE.y - source.y;
	const length = Math.hypot(dx, dy);
	const points: (readonly [number, number])[] = [];
	for (let step = 6; step < length; step += 1) {
		const px = source.x + (dx * step) / length;
		const py = source.y + (dy * step) / length;
		if (Math.hypot(px - GLOBE.x, py - GLOBE.y) <= GLOBE.r + 2) break;
		if (Math.hypot(px - LENS.x, py - LENS.y) <= LENS.r + 3) break;
		points.push([px, py]);
	}
	return points;
};

const CONNECTIONS = SOURCES.map(connection);

// Packets leave in a scattered order rather than sweeping round.
const LAUNCH_ORDER = [0, 5, 2, 7, 4, 9, 1, 6, 3, 8];
const TRAVEL = 0.38;

/** The illustration at time `t` in [0, 1]; `t = 1` is the still frame. */
export const art_rows = (t: number, depth: ColorDepth): string[] => {
	const time = clamp(t);
	const canvas = create_canvas(ART_COLS, ART_ROWS);
	for (const points of CONNECTIONS)
		points.forEach(([x, y], step) => {
			if (step % 4 < 2) canvas.dot(x, y, TRACE);
		});
	draw_globe(canvas, (1 - time) ** 2 * 48);
	draw_lens(
		canvas,
		RESULT_BARS.map(
			(_, index) => (time - 0.42 - 0.12 * index) / 0.22,
		),
	);
	SOURCES.forEach((source, index) => {
		const points = CONNECTIONS[index];
		const progress =
			(time - 0.04 - 0.05 * LAUNCH_ORDER.indexOf(index)) / TRAVEL;
		if (progress <= 0 || progress >= 1) return;
		const head = Math.floor(progress * (points.length - 1));
		for (let tail = 0; tail < 3 && head - tail >= 0; tail += 1) {
			const [x, y] = points[head - tail];
			canvas.dot(x, y, source.color);
			canvas.dot(x, y + 1, source.color);
		}
	});
	for (const source of SOURCES)
		source.icon.forEach((row, dy) => {
			row.split('').forEach((cell, dx) => {
				if (cell === '#')
					canvas.dot(
						source.x - 2 + dx,
						source.y - 2 + dy,
						source.color,
					);
			});
		});
	return canvas.render(depth);
};

const WORD = 'mcp-retriever';
const LETTERS = WORD.split('');

// Five pixel rows per letter, drawn two to a line with half blocks.
const GLYPHS: Record<string, readonly string[]> = {
	m: ['#   #', '## ##', '# # #', '#   #', '#   #'],
	c: ['#####', '#    ', '#    ', '#    ', '#####'],
	p: ['#####', '#   #', '#####', '#    ', '#    '],
	'-': ['   ', '   ', '###', '   ', '   '],
	r: ['#### ', '#   #', '#### ', '#  # ', '#   #'],
	e: ['#####', '#    ', '#### ', '#    ', '#####'],
	t: ['#####', '  #  ', '  #  ', '  #  ', '  #  '],
	i: ['###', ' # ', ' # ', ' # ', '###'],
	v: ['#   #', '#   #', '#   #', ' # # ', '  #  '],
};

const LETTER_COLORS: readonly Rgb[] = [
	CYAN,
	mix(CYAN, BLUE, 0.5),
	BLUE,
	TRACE,
];

export const WORDMARK_WIDTH =
	LETTERS.reduce(
		(width, letter) => width + GLYPHS[letter][0].length,
		0,
	) +
	LETTERS.length -
	1;

/** The wide block wordmark with its first `letters` letters shown. */
export const wordmark_rows = (
	letters: number,
	depth: ColorDepth,
): string[] => {
	const rows = ['', '', ''];
	LETTERS.forEach((letter, index) => {
		const glyph = GLYPHS[letter];
		const width = glyph[0].length;
		for (let row = 0; row < 3; row += 1) {
			let cells = '';
			for (let col = 0; col < width; col += 1) {
				const top = glyph[row * 2]?.[col] === '#';
				const bottom = glyph[row * 2 + 1]?.[col] === '#';
				cells += top && bottom ? '█' : top ? '▀' : bottom ? '▄' : ' ';
			}
			// Padding stays outside the color codes so rows trim alike
			// with and without color.
			const shown = index < letters ? cells.trimEnd() : '';
			if (shown)
				rows[row] += tint(
					shown,
					LETTER_COLORS[index] ?? WHITE,
					depth,
					true,
				);
			rows[row] += ' '.repeat(width + 1 - shown.length);
		}
	});
	return rows.map((row) => row.trimEnd());
};

const TAGLINE: readonly (readonly [string, Rgb])[] = [
	['Search', CYAN],
	['Retrieve', MINT],
	['Read', BLUE],
	['Extract', VIOLET],
	['Across the Web', WHITE],
];
const SEPARATOR = ' · ';
const TAGLINE_WIDTH =
	TAGLINE.reduce((width, [word]) => width + word.length, 0) +
	SEPARATOR.length * (TAGLINE.length - 1);

export const tagline_row = (
	parts: number,
	depth: ColorDepth,
): string =>
	TAGLINE.slice(0, parts)
		.map(([word, color]) => tint(word, color, depth))
		.join(tint(SEPARATOR, TRACE, depth));

const MARGIN = 2;
export const WELCOME_COLS = MARGIN + WORDMARK_WIDTH;
export const WELCOME_ROWS = ART_ROWS + 6;

/** One frame of the welcome screen; always `WELCOME_ROWS` rows. */
export const welcome_rows = (
	t: number,
	depth: ColorDepth,
): string[] => {
	const time = clamp(t);
	const pad = ' '.repeat(MARGIN);
	const letters = Math.floor(
		WORD.length * clamp((time - 0.5) / 0.36) + 1e-9,
	);
	const parts = Math.floor(
		TAGLINE.length * clamp((time - 0.86) / 0.14) + 1e-9,
	);
	const centered = ' '.repeat(
		MARGIN + Math.floor((WORDMARK_WIDTH - TAGLINE_WIDTH) / 2),
	);
	return [
		...art_rows(time, depth).map((row) => (row ? pad + row : '')),
		'',
		...wordmark_rows(letters, depth).map((row) =>
			row ? pad + row : '',
		),
		'',
		parts ? centered + tagline_row(parts, depth) : '',
	];
};

const MARK_COLS = 5;

/** The compact mark: a small globe with the magnifier handle. */
const mark_rows = (depth: ColorDepth): string[] => {
	const canvas = create_canvas(MARK_COLS, 2);
	arc(canvas, 3.5, 3, 3, CYAN);
	canvas.dot(3, 3, CYAN);
	canvas.dot(4, 3, CYAN);
	for (const [x, y] of [
		[6, 6],
		[7, 6],
		[7, 7],
		[8, 7],
	])
		canvas.dot(x, y, WHITE);
	// Pad by the plain width; color codes are not columns.
	const widths = canvas.render('none').map((row) => row.length);
	return canvas
		.render(depth)
		.map((row, index) => row + ' '.repeat(MARK_COLS - widths[index]));
};

/** Two rows: the compact mark beside the name and a screen title. */
export const header_rows = (io: Io, title: string): string[] => {
	const depth = color_depth(io);
	const [top, bottom] = mark_rows(depth);
	const name = `${tint('mcp', CYAN, depth, true)}${tint('-retriever', WHITE, depth, true)}`;
	return [`${top}  ${name}`, `${bottom}  ${c.dim(io, title)}`];
};

export const fits_welcome = (
	io: Io,
	env: Env = process.env,
): boolean =>
	is_interactive(io) &&
	env.TERM !== 'dumb' &&
	(io.output.columns ?? 0) > WELCOME_COLS &&
	(io.output.rows ?? 0) > WELCOME_ROWS + 1;

export interface WelcomeOptions {
	frames?: number;
	interval_ms?: number;
}

/**
 * Plays the welcome animation and leaves its last frame on screen.
 * Any key skips to that frame, so input typed early is not carried
 * into the first prompt; Ctrl+C rejects with `Cancelled`.
 */
export const play_welcome = (
	io: Io,
	{ frames = 46, interval_ms = 36 }: WelcomeOptions = {},
): Promise<void> =>
	new Promise((resolve, reject) => {
		const { input, output } = io;
		const depth = color_depth(io);
		const width = output.columns || 80;
		let drawn = 0;
		// One write per frame, overwritten in place, inside a
		// synchronized update where the terminal supports it.
		const draw = (t: number) => {
			const rows = welcome_rows(t, depth).map(
				(row) => `${clip(row, width)}\x1b[K`,
			);
			output.write(
				`\x1b[?2026h${drawn ? `\x1b[${drawn}A\r` : ''}${rows.join('\n')}\n\x1b[?2026l`,
			);
			drawn = rows.length;
		};
		let frame = 0;
		let timer: NodeJS.Timeout | undefined;
		emitKeypressEvents(input);
		const was_raw = input.isRaw;
		const finish = (error?: Error) => {
			clearInterval(timer);
			draw(1);
			input.off('keypress', on_key);
			input.setRawMode(was_raw);
			input.pause();
			output.write('\x1b[?25h');
			if (error) reject(error);
			else resolve();
		};
		const on_key = (_text: string | undefined, key?: Key) =>
			finish(
				key?.ctrl && key.name === 'c' ? new Cancelled() : undefined,
			);
		input.setRawMode(true);
		input.resume();
		input.on('keypress', on_key);
		output.write('\x1b[?25l');
		draw(0);
		timer = setInterval(() => {
			frame += 1;
			if (frame >= frames) finish();
			else draw(frame / frames);
		}, interval_ms);
	});

/**
 * Opens a screen. With `welcome`, a terminal that is large enough
 * gets the animated welcome first; otherwise the compact header.
 */
export const banner = async (
	io: Io,
	title: string,
	options: WelcomeOptions & { welcome?: boolean } = {},
): Promise<void> => {
	if (options.welcome && fits_welcome(io)) {
		await play_welcome(io, options);
		write_rows(io, [
			'',
			`${c.dim(io, '┌')}  ${c.bold(io, title)}`,
			c.dim(io, BAR),
		]);
		return;
	}
	write_rows(io, [...header_rows(io, title), c.dim(io, BAR)]);
};
