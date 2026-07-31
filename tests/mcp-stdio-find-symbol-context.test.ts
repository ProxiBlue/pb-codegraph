// Wiring smoke test for the find_symbol and context tools registered in
// mcp/src/server.ts (task 006) — verifies the zod inputSchema + callback
// plumbing actually works end to end over the real stdio transport, not
// just the pure find-symbol.ts/context.ts functions the other 006 tests
// exercise directly.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { buildIsolatedFixtureDb } from './helpers/isolated-fixture-db.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
const serverEntrypoint = path.join(repoRoot, 'mcp', 'bin', 'server.ts');

test('it exposes find_symbol and context tools over stdio', { timeout: 120_000 }, async () => {
  const fixture = buildIsolatedFixtureDb();
  const registryPath = path.join(fixture.dir, 'registry.json');
  fs.writeFileSync(
    registryPath,
    JSON.stringify({
      fixture_repo: { db_path: fixture.dbPath, description: 'isolated fixture repo' },
    }),
  );

  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ['--import', 'tsx', serverEntrypoint],
    cwd: repoRoot,
    env: { ...(process.env as Record<string, string>), PB_CODEGRAPH_REGISTRY: registryPath },
  });

  const client = new Client({ name: 'pb-codegraph-test-client', version: '0.0.0' });

  try {
    await client.connect(transport);

    const tools = await client.listTools();
    const toolNames = tools.tools.map((t) => t.name);
    assert.ok(toolNames.includes('find_symbol'), 'find_symbol must be registered');
    assert.ok(toolNames.includes('context'), 'context must be registered');

    const findResult = await client.callTool({
      name: 'find_symbol',
      arguments: { name: 'Acme\\ModuleA\\Model::Foo', repo: 'fixture_repo' },
    });
    const findContent = findResult.content as Array<{ type: string; text?: string }>;
    const findText = findContent.find((c) => c.type === 'text')?.text;
    assert.ok(findText, 'expected a text content block from find_symbol');
    const findParsed = JSON.parse(findText!) as { results: Array<{ qualified_name: string }> };
    assert.ok(findParsed.results.some((r) => r.qualified_name === 'Acme\\ModuleA\\Model::Foo'));

    const contextResult = await client.callTool({
      name: 'context',
      arguments: { symbol: 'Acme\\ModuleA\\Model::Foo', repo: 'fixture_repo' },
    });
    const contextContent = contextResult.content as Array<{ type: string; text?: string }>;
    const contextText = contextContent.find((c) => c.type === 'text')?.text;
    assert.ok(contextText, 'expected a text content block from context');
    const contextParsed = JSON.parse(contextText!) as { results: Array<{ node: { qualified_name: string } }> };
    assert.equal(contextParsed.results.length, 1);
    assert.equal(contextParsed.results[0].node.qualified_name, 'Acme\\ModuleA\\Model::Foo');
  } finally {
    await client.close();
    fixture.cleanup();
  }
});
