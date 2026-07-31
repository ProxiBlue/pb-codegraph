import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { listRepoStatuses } from '../mcp/src/repo-status.ts';
import { buildIsolatedFixtureDb } from './helpers/isolated-fixture-db.ts';

test('it survives a registry entry pointing at a missing db with a per-repo error not a crash', { timeout: 120_000 }, () => {
  const fixture = buildIsolatedFixtureDb();
  try {
    const missingDbPath = path.join(fixture.dir, 'does-not-exist', 'codegraph.db');

    const statuses = listRepoStatuses({
      good_repo: { db_path: fixture.dbPath },
      broken_repo: { db_path: missingDbPath },
    });

    assert.equal(statuses.length, 2, 'a bad registry entry must not remove other repos from the result');

    const good = statuses.find((s) => s.name === 'good_repo');
    const broken = statuses.find((s) => s.name === 'broken_repo');

    assert.ok(good, 'good_repo must still be reported');
    assert.equal(good?.ok, true);

    assert.ok(broken, 'broken_repo must still be reported (not thrown/omitted)');
    assert.equal(broken?.ok, false);
    if (broken && !broken.ok) {
      assert.match(broken.error, /does-not-exist|unable to open/i);
    }
  } finally {
    fixture.cleanup();
  }
});
