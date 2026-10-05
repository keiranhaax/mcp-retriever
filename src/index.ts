#!/usr/bin/env node

import { StdioTransport } from '@tmcp/transport-stdio';
import { readFileSync } from 'node:fs';
import { create_server } from './server/create_server.js';

const { name, version } = JSON.parse(
	readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
) as { name: string; version: string };

const server = create_server({ name, version });
const transport = new StdioTransport(server);
transport.listen();
console.error('Retriever MCP server running on stdio');
