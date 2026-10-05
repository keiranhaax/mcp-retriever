import { McpServer } from 'tmcp';
import type { GenericSchema } from 'valibot';
import * as v from 'valibot';
import { create_error_response } from '../../common/errors.js';
import {
	cleanup_expired_results,
	read_result_chunk,
	RESULT_READ_LIMIT,
	RESULT_READ_MAX_BYTES,
} from '../../common/result_store.js';

export const register_result_read = (
	server: McpServer<GenericSchema>,
) => {
	cleanup_expired_results();
	server.tool(
		{
			name: 'result_read',
			description: `Read up to ${RESULT_READ_MAX_BYTES} UTF-8 bytes by opaque result_id. Follow next_offset and next_byte_offset as byte_offset within that line. Join byte continuations directly, ordinary line pages with LF. Results expire or may be evicted.`,
			annotations: {
				readOnlyHint: true,
				destructiveHint: false,
				idempotentHint: true,
				openWorldHint: false,
			},
			schema: v.object({
				result_id: v.pipe(
					v.string(),
					v.regex(
						/^[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[1-5][0-9A-Fa-f]{3}-[89aAbB][0-9A-Fa-f]{3}-[0-9A-Fa-f]{12}$/,
						'Invalid result ID',
					),
					v.description(
						'Opaque result ID returned by an Retriever tool',
					),
				),
				offset: v.optional(
					v.pipe(
						v.number(),
						v.integer(),
						v.minValue(1),
						v.maxValue(Number.MAX_SAFE_INTEGER),
						v.description('One-based line offset (default: 1)'),
					),
				),
				byte_offset: v.optional(
					v.pipe(
						v.number(),
						v.integer(),
						v.minValue(0),
						v.maxValue(Number.MAX_SAFE_INTEGER),
						v.description(
							'UTF-8 byte offset within the selected line; pass next_byte_offset unchanged (default: 0)',
						),
					),
				),
				limit: v.optional(
					v.pipe(
						v.number(),
						v.integer(),
						v.minValue(1),
						v.maxValue(RESULT_READ_LIMIT),
						v.description(
							`Maximum lines to return (default: 200, max: ${RESULT_READ_LIMIT})`,
						),
					),
				),
			}),
		},
		async ({ result_id, offset, limit, byte_offset }) => {
			try {
				const chunk = read_result_chunk(
					result_id,
					offset,
					limit,
					byte_offset,
				);
				return {
					content: [
						{
							type: 'text' as const,
							text: JSON.stringify(chunk, null, 2),
						},
					],
				};
			} catch (error) {
				const body = create_error_response(error as Error);
				return {
					content: [{ type: 'text' as const, text: body.error }],
					isError: true,
				};
			}
		},
	);
};
