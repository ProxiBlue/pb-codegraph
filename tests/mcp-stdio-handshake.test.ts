import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { SERVER_NAME } from '../mcp/src/server.ts';
import { buildIsolatedFixtureDb } from './helpers/isolated-fixture-db.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
const serverEntrypoint = path.join(repoRoot, 'mcp', 'bin', 'server.ts');

test('it verifies MCP handshake and list_repos via a scripted stdio client', { timeout: 120_000 }, async () => {
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

    const serverVersion = client.getServerVersion();
    assert.ok(serverVersion, 'expected the server to report its Implementation info during the handshake');
    assert.equal(serverVersion?.name, SERVER_NAME, 'server must handshake as the fleet-compat name gitnexus-mageos');

    const result = await client.callTool({ name: 'list_repos', arguments: {} });
    const content = result.content as Array<{ type: string; text?: string }>;
    assert.ok(Array.isArray(content) && content.length > 0, 'expected list_repos to return content');

    const textBlock = content.find((c) => c.type === 'text');
    assert.ok(textBlock?.text, 'expected a text content block from list_repos');

    const parsed = JSON.parse(textBlock!.text!) as { repos: Array<{ name: string; ok: boolean }> };
    assert.equal(parsed.repos.length, 1);
    assert.equal(parsed.repos[0].name, 'fixture_repo');
    assert.equal(parsed.repos[0].ok, true);
  } finally {
    await client.close();
    fixture.cleanup();
  }
});
