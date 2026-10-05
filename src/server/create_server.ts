import { ValibotJsonSchemaAdapter } from '@tmcp/adapter-valibot';
import { McpServer } from 'tmcp';
import type { GenericSchema } from 'valibot';
import { run_with_request_context } from '../common/request_context.js';
import { validate_config } from '../config/env.js';
import { configured_tool_groups } from './capability_groups.js';
import { setup_handlers } from './handlers.js';
import { configured_spend_caps } from './spend_caps.js';
import {
	initialize_providers,
	register_tools,
} from './tools/index.js';

export const create_server = (identity: {
	name: string;
	version: string;
}) => {
	const groups = configured_tool_groups();
	const server = new McpServer<GenericSchema>(
		{
			...identity,
			description:
				'MCP server for multi-provider web search and content retrieval',
		},
		{
			adapter: new ValibotJsonSchemaAdapter(),
			capabilities: {
				tools: { listChanged: true },
				resources: { listChanged: true },
			},
		},
	);
	const receive = server.receive.bind(server);
	server.receive = (message, context) =>
		run_with_request_context(
			(context as { signal?: AbortSignal } | undefined)?.signal,
			() => receive(message, context),
		);

	validate_config();
	configured_spend_caps();
	initialize_providers();
	register_tools(server, groups);
	setup_handlers(server);
	return server;
};
