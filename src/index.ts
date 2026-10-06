#!/usr/bin/env node

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { load_credentials_file } from './config/credentials_file.js';

const { name, version } = JSON.parse(
	readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
) as { name: string; version: string };

const argv = process.argv.slice(2);
if (argv.length > 0) {
	// Commands never start the server. Their code loads only here, so
	// a plain start imports nothing before the credentials file.
	const { default_context, run_cli } =
		await import('./cli/commands.js');
	process.exitCode = await run_cli(
		argv,
		default_context({
			entry: fileURLToPath(import.meta.url),
			version,
		}),
	);
} else {
	// Fill unset provider settings before any config module reads env.
	load_credentials_file();
	const { StdioTransport } = await import('@tmcp/transport-stdio');
	const { create_server } = await import('./server/create_server.js');
	const server = create_server({ name, version });
	const transport = new StdioTransport(server);
	transport.listen();
	console.error('Retriever MCP server running on stdio');
}
