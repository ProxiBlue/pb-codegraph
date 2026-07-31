import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { loadRegistryFromPath } from '../mcp/src/registry.ts';
import { openReadOnlyDb } from '../mcp/src/db.ts';
import { buildIsolatedFixtureDb } from './helpers/isolated-fixture-db.ts';

test('it loads the registry and opens each db read only', { timeout: 120_000 }, () => {
  const fixture = buildIsolatedFixtureDb();
  try {
    const registryPath = path.join(fixture.dir, 'registry.json');
    fs.writeFileSync(
      registryPath,
      JSON.stringify({
        fixture_repo: { db_path: fixture.dbPath, description: 'isolated fixture repo' },
      }),
    );

    const registry = loadRegistryFromPath(registryPath);
    assert.deepEqual(Object.keys(registry), ['fixture_repo']);
    assert.equal(registry.fixture_repo.db_path, fixture.dbPath);
    assert.equal(registry.fixture_repo.description, 'isolated fixture repo');

    const db = openReadOnlyDb(registry.fixture_repo.db_path);
    try {
      assert.throws(
        () => db.exec('CREATE TABLE should_fail (id INTEGER)'),
        /readonly|read-only/i,
        'connection opened by openReadOnlyDb must reject writes',
      );

      const row = db.prepare('SELECT COUNT(*) AS c FROM nodes').get() as { c: number };
      assert.ok(row.c > 0, 'expected the readonly connection to see the fixture nodes');
    } finally {
      db.close();
    }
  } finally {
    fixture.cleanup();
  }
});
