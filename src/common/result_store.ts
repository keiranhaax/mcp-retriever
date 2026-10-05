import {
	chmodSync,
	closeSync,
	existsSync,
	mkdirSync,
	openSync,
	readSync,
	readdirSync,
	statSync,
	unlinkSync,
	writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { gzipSync, gunzipSync } from 'node:zlib';
import { with_cause } from './errors.js';
import { ErrorType, ProviderError } from './types.js';

const DEFAULT_RESULT_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_RESULT_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const DEFAULT_MAX_RESULT_BYTES = 25 * 1024 * 1024;
const DEFAULT_MAX_STORE_BYTES = 256 * 1024 * 1024;
const MAX_CONFIGURED_BYTES = 1024 * 1024 * 1024;
// Physical quotas remain configurable; decoded data has an independent hard cap.
const MAX_LOGICAL_BYTES = 100 * 1024 * 1024;
const INDEX_BLOCK_BYTES = 64 * 1024;
const MAX_CACHED_INDEXES = 16;
// OMR1: four-byte magic, uint32 LE decoded length, then a gzip member.
const COMPRESSED_MAGIC = Buffer.from('OMR1');
interface Checkpoint {
	position: number;
	line: number;
	line_start: number;
}
interface LineIndex {
	fingerprint: string;
	size: number;
	total_lines: number;
	checkpoints: Checkpoint[];
}
const indexes = new Map<string, LineIndex>();
// One decoded result (at most MAX_LOGICAL_BYTES), never one per index.
// Expiry is lazy: idle processes retain this bounded buffer until a read,
// cleanup, or replacement. No timer or background disk work is needed.
let decoded_cache:
	| { path: string; fingerprint: string; bytes: Buffer }
	| undefined;
const forget_result = (path: string) => {
	indexes.delete(path);
	if (decoded_cache?.path === path) decoded_cache = undefined;
};
const is_result_file = (name: string) =>
	(name.endsWith('.txt') || name.endsWith('.omr')) &&
	RESULT_ID_PATTERN.test(name.slice(0, -4));
const MAX_READ_LINES = 500;
// Leave room for JSON escaping and the tool envelope, not just text.
const MAX_READ_BYTES = 12000;
const RESULT_ID_PATTERN =
	/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const result_error = (message: string) =>
	new ProviderError(ErrorType.INVALID_INPUT, message, 'result_read');

const storage_error = (message: string) =>
	new ProviderError(
		ErrorType.PROVIDER_ERROR,
		message,
		'result_store',
	);

const get_result_dir = () =>
	process.env.RETRIEVER_RESULT_DIR ||
	join(homedir(), '.cache', 'mcp-retriever', 'results');

const get_result_ttl_ms = () => {
	const configured = Number(process.env.RETRIEVER_RESULT_TTL_MS);
	if (!Number.isFinite(configured) || configured <= 0) {
		return DEFAULT_RESULT_TTL_MS;
	}
	return Math.min(Math.floor(configured), MAX_RESULT_TTL_MS);
};

const get_byte_limit = (name: string, fallback: number) => {
	const configured = Number(process.env[name]);
	if (!Number.isFinite(configured) || configured <= 0)
		return fallback;
	return Math.min(Math.floor(configured), MAX_CONFIGURED_BYTES);
};

const get_max_result_bytes = () =>
	get_byte_limit(
		'RETRIEVER_RESULT_MAX_BYTES',
		DEFAULT_MAX_RESULT_BYTES,
	);

const get_max_store_bytes = () =>
	get_byte_limit(
		'RETRIEVER_RESULT_STORE_MAX_BYTES',
		DEFAULT_MAX_STORE_BYTES,
	);

export const get_result_storage_limit = () =>
	Math.min(
		get_max_result_bytes(),
		get_max_store_bytes(),
		MAX_LOGICAL_BYTES,
	);

export const ensure_result_dir = () => {
	const result_dir = get_result_dir();
	mkdirSync(result_dir, { recursive: true, mode: 0o700 });
	chmodSync(result_dir, 0o700);
	return result_dir;
};

const result_path = (result_id: string) => {
	if (!RESULT_ID_PATTERN.test(result_id)) {
		throw result_error('Invalid result ID');
	}
	const base = join(ensure_result_dir(), result_id);
	return existsSync(`${base}.txt`) ? `${base}.txt` : `${base}.omr`;
};

export interface StoredResult {
	result_id: string;
	total_lines: number;
	expires_at: string;
}

export interface ResultChunk extends StoredResult {
	offset: number;
	limit: number;
	byte_offset: number;
	content: string;
	next_offset?: number;
	next_byte_offset?: number;
}

export const cleanup_expired_results = (now = Date.now()): number => {
	const result_dir = ensure_result_dir();
	const ttl_ms = get_result_ttl_ms();
	let removed = 0;

	for (const entry of readdirSync(result_dir, {
		withFileTypes: true,
	})) {
		if (!entry.isFile() || !is_result_file(entry.name)) continue;
		const path = join(result_dir, entry.name);
		try {
			if (now - statSync(path).mtimeMs > ttl_ms) {
				unlinkSync(path);
				forget_result(path);
				removed++;
			}
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
				throw error;
		}
	}

	return removed;
};

const prune_to_fit = (result_dir: string, required_bytes: number) => {
	const max_store_bytes = get_max_store_bytes();
	if (required_bytes > max_store_bytes) {
		throw storage_error(
			`Result exceeds the configured ${max_store_bytes}-byte total storage quota`,
		);
	}

	const files = readdirSync(result_dir, { withFileTypes: true })
		.filter((entry) => entry.isFile() && is_result_file(entry.name))
		.map((entry) => {
			const path = join(result_dir, entry.name);
			const stats = statSync(path);
			return { path, size: stats.size, mtime_ms: stats.mtimeMs };
		})
		.sort((left, right) => left.mtime_ms - right.mtime_ms);

	let total_bytes = files.reduce((sum, file) => sum + file.size, 0);
	for (const file of files) {
		if (total_bytes + required_bytes <= max_store_bytes) break;
		try {
			unlinkSync(file.path);
			forget_result(file.path);
			total_bytes -= file.size;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
				throw error;
		}
	}
};

export const store_result = (content: string): StoredResult => {
	cleanup_expired_results();
	const result_dir = ensure_result_dir();
	const content_bytes = Buffer.byteLength(content, 'utf8');
	const max_result_bytes = get_max_result_bytes();
	if (content_bytes > MAX_LOGICAL_BYTES) {
		throw storage_error(
			`Result exceeds the ${MAX_LOGICAL_BYTES}-byte logical limit`,
		);
	}
	let bytes = Buffer.from(content, 'utf8');
	let extension = 'txt';
	if (content_bytes > get_result_storage_limit()) {
		const header = Buffer.alloc(8);
		COMPRESSED_MAGIC.copy(header);
		header.writeUInt32LE(content_bytes, 4);
		bytes = Buffer.concat([header, gzipSync(bytes, { level: 1 })]);
		extension = 'omr';
	}
	if (bytes.length > max_result_bytes) {
		throw storage_error(
			`Result exceeds the configured ${max_result_bytes}-byte storage limit`,
		);
	}
	prune_to_fit(result_dir, bytes.length);
	const result_id = randomUUID();
	const path = join(result_dir, `${result_id}.${extension}`);
	writeFileSync(path, bytes, {
		flag: 'wx',
		mode: 0o600,
	});
	chmodSync(path, 0o600);
	const created_at = statSync(path).mtimeMs;
	let total_lines = content.length === 0 ? 0 : 1;
	for (
		let i = content.indexOf('\n');
		i >= 0;
		i = content.indexOf('\n', i + 1)
	)
		total_lines++;

	return {
		result_id,
		total_lines,
		expires_at: new Date(
			created_at + get_result_ttl_ms(),
		).toISOString(),
	};
};

type ReadBytes = (buffer: Buffer, position: number) => number;

const decode_result = (fd: number, size: number): Buffer => {
	try {
		// Bound both allocation and inflate, even for forged on-disk headers.
		if (size < 8 || size > MAX_LOGICAL_BYTES + INDEX_BLOCK_BYTES)
			throw new Error();
		const header = Buffer.alloc(8);
		if (
			readSync(fd, header, 0, 8, 0) !== 8 ||
			!header.subarray(0, 4).equals(COMPRESSED_MAGIC)
		)
			throw new Error();
		const expected = header.readUInt32LE(4);
		if (expected > MAX_LOGICAL_BYTES) throw new Error();
		const encoded = Buffer.alloc(size - 8);
		let position = 0;
		while (position < encoded.length) {
			const count = readSync(
				fd,
				encoded,
				position,
				encoded.length - position,
				position + 8,
			);
			if (count === 0) throw new Error();
			position += count;
		}
		const bytes = gunzipSync(encoded, {
			maxOutputLength: Math.max(1, expected),
		});
		if (bytes.length !== expected) throw new Error();
		return bytes;
	} catch (failure) {
		// Keep the fs/zlib failure reachable for diagnostics; an EIO or
		// EBADF is not the same operator problem as a corrupt file.
		throw with_cause(
			result_error(
				'Stored result is corrupt or exceeds the logical limit',
			),
			failure,
		);
	}
};

const get_line_index = (
	path: string,
	fingerprint: string,
	size: number,
	read: ReadBytes,
): LineIndex => {
	const cached = indexes.get(path);
	if (cached?.fingerprint === fingerprint) {
		indexes.delete(path);
		indexes.set(path, cached);
		return cached;
	}
	const scan = Buffer.alloc(INDEX_BLOCK_BYTES);
	const checkpoints: Checkpoint[] = [];
	let line = size === 0 ? 0 : 1;
	let line_start = 0;
	for (let position = 0; position < size; ) {
		checkpoints.push({ position, line, line_start });
		const count = read(scan, position);
		if (count === 0)
			throw result_error('Stored result changed while reading');
		for (
			let i = scan.indexOf(10);
			i >= 0 && i < count;
			i = scan.indexOf(10, i + 1)
		) {
			line++;
			line_start = position + i + 1;
		}
		position += count;
	}
	const index = { fingerprint, size, total_lines: line, checkpoints };
	indexes.delete(path);
	while (indexes.size >= MAX_CACHED_INDEXES)
		indexes.delete(indexes.keys().next().value!);
	indexes.set(path, index);
	return index;
};

const find_line_start = (
	index: LineIndex,
	target: number,
	read: ReadBytes,
): number => {
	if (target <= 1) return 0;
	if (target > index.total_lines) return index.size;
	// Last block at or before this line. Repeated checkpoints inside a
	// huge line retain its start, avoiding a rescan for byte continuations.
	let low = 0;
	let high = index.checkpoints.length;
	while (low < high) {
		const mid = Math.floor((low + high) / 2);
		if (index.checkpoints[mid].line <= target) low = mid + 1;
		else high = mid;
	}
	const checkpoint = index.checkpoints[Math.max(0, low - 1)];
	if (checkpoint.line === target) return checkpoint.line_start;
	let line = checkpoint.line;
	const scan = Buffer.alloc(INDEX_BLOCK_BYTES);
	const count = read(scan, checkpoint.position);
	for (
		let i = scan.indexOf(10);
		i >= 0 && i < count;
		i = scan.indexOf(10, i + 1)
	) {
		if (++line === target) return checkpoint.position + i + 1;
	}
	throw result_error('Stored result changed while reading');
};

export const read_result_chunk = (
	result_id: string,
	offset = 1,
	limit = 200,
	byte_offset = 0,
): ResultChunk => {
	if (!Number.isSafeInteger(offset) || offset < 1) {
		throw result_error('Offset must be a positive integer');
	}
	if (
		!Number.isInteger(limit) ||
		limit < 1 ||
		limit > MAX_READ_LINES
	) {
		throw result_error(
			`Limit must be an integer between 1 and ${MAX_READ_LINES}`,
		);
	}
	if (!Number.isSafeInteger(byte_offset) || byte_offset < 0) {
		throw result_error(
			'Byte offset must be a non-negative safe integer',
		);
	}

	const path = result_path(result_id);
	if (!existsSync(path)) {
		forget_result(path);
		throw result_error('Result not found or expired');
	}

	const stats = statSync(path);
	const expires_at_ms = stats.mtimeMs + get_result_ttl_ms();
	if (Date.now() > expires_at_ms) {
		unlinkSync(path);
		forget_result(path);
		throw result_error('Result not found or expired');
	}

	const fd = openSync(path, 'r');
	try {
		const fingerprint = `${stats.dev}:${stats.ino}:${stats.size}:${stats.mtimeMs}:${stats.ctimeMs}`;
		let decoded: Buffer | undefined;
		if (path.endsWith('.omr')) {
			if (
				decoded_cache?.path !== path ||
				decoded_cache.fingerprint !== fingerprint
			) {
				decoded_cache = undefined;
				decoded_cache = {
					path,
					fingerprint,
					bytes: decode_result(fd, stats.size),
				};
			}
			decoded = decoded_cache.bytes;
		} else if (stats.size > MAX_LOGICAL_BYTES) {
			throw result_error('Stored result exceeds the logical limit');
		}
		const size = decoded?.length ?? stats.size;
		const read: ReadBytes = decoded
			? (buffer, position) =>
					decoded.copy(
						buffer,
						0,
						position,
						Math.min(size, position + buffer.length),
					)
			: (buffer, position) =>
					readSync(fd, buffer, 0, buffer.length, position);
		const index = get_line_index(path, fingerprint, size, read);
		const total_lines = index.total_lines;
		const line_start = find_line_start(index, offset, read);
		const line_end =
			offset < total_lines
				? find_line_start(index, offset + 1, read) - 1
				: size;
		if (byte_offset > line_end - line_start) {
			throw result_error('Byte offset exceeds the selected line');
		}
		const start = line_start + byte_offset;
		const page = Buffer.alloc(MAX_READ_BYTES + 4);
		const available = read(page, start);
		if (
			byte_offset > 0 &&
			available > 0 &&
			(page[0] & 0xc0) === 0x80
		) {
			throw result_error(
				'Byte offset must be on a UTF-8 character boundary',
			);
		}
		let end = Math.min(available, MAX_READ_BYTES);
		// The first excluded byte must not be a UTF-8 continuation byte.
		while (end < available && (page[end] & 0xc0) === 0x80) end--;
		let newlines = 0;
		let last_newline = -1;
		let next_offset: number | undefined;
		let next_byte_offset: number | undefined;
		for (let i = 0; i <= end && i < available; i++) {
			if (page[i] !== 10) continue;
			if (newlines + 1 === limit) {
				// Preserve old line-offset pages: separator LF is omitted.
				end = i;
				next_offset = offset + limit;
				break;
			}
			if (i < end) {
				newlines++;
				last_newline = i;
			}
		}
		if (next_offset === undefined && start + end < size) {
			next_offset = offset + newlines;
			next_byte_offset =
				last_newline < 0 ? byte_offset + end : end - last_newline - 1;
		}
		return {
			result_id,
			offset,
			limit,
			byte_offset,
			content: page.toString('utf8', 0, end),
			total_lines,
			next_offset,
			next_byte_offset,
			expires_at: new Date(expires_at_ms).toISOString(),
		};
	} finally {
		closeSync(fd);
	}
};

export const RESULT_READ_LIMIT = MAX_READ_LINES;
export const RESULT_READ_MAX_BYTES = MAX_READ_BYTES;
