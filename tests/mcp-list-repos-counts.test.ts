import test from 'node:test';
import assert from 'node:assert/strict';
import { listRepoStatuses } from '../mcp/src/repo-status.ts';
import { buildIsolatedFixtureDb } from './helpers/isolated-fixture-db.ts';

test('it lists repos with node and edge counts and index timestamps', { timeout: 120_000 }, () => {
  const fixture = buildIsolatedFixtureDb();
  try {
    const statuses = listRepoStatuses({
      fixture_repo: { db_path: fixture.dbPath, description: 'isolated fixture repo' },
    });

    assert.equal(statuses.length, 1);
    const [status] = statuses;
    assert.equal(status.name, 'fixture_repo');
    assert.equal(status.ok, true);
    if (!status.ok) return; // narrows for TS below (unreachable given assert above)

    assert.ok(status.node_count > 0, 'expected node_count to reflect the fixture index');
    assert.ok(status.edge_count > 0, 'expected edge_count to reflect the fixture index');
    assert.equal(typeof status.indexed_at, 'number');
    assert.ok(status.indexed_at! > 0, 'expected indexed_at to be a positive timestamp');
  } finally {
    fixture.cleanup();
  }
});
