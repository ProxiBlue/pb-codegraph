#!/usr/bin/env node
// Stdio entrypoint for the pb-codegraph MCP shim. Run under the ddev web
// container's node (task 010 pins the mount/runtime); the fleet .mcp.json
// stdio command entry invokes this file.
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createServer } from '../src/server.ts';

async function main(): Promise<void> {
  const server = createServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
