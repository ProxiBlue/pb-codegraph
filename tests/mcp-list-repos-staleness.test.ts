import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { getRepoStatus } from '../mcp/src/repo-status.ts';
import { buildIsolatedFixtureDb } from './helpers/isolated-fixture-db.ts';

function currentFilesIndexedAt(dbPath: string): number {
  const db = new Database(dbPath, { readonly: true });
  try {
    return (db.prepare('SELECT MAX(indexed_at) AS m FROM files').get() as { m: number }).m;
  } finally {
    db.close();
  }
}

function writeAugmenterMarker(dbPath: string, runAt: number, filesIndexedAtSnapshot: number): void {
  const db = new Database(dbPath);
  try {
    db.prepare(
      'INSERT OR REPLACE INTO project_metadata (key, value, updated_at) VALUES (?, ?, ?)',
    ).run('pb_augmenter_run_at', String(runAt), runAt);
    db.prepare(
      'INSERT OR REPLACE INTO project_metadata (key, value, updated_at) VALUES (?, ?, ?)',
    ).run('pb_augmenter_files_indexed_at', String(filesIndexedAtSnapshot), runAt);
  } finally {
    db.close();
  }
}

test('it reports augmenter staleness status per repo', { timeout: 120_000 }, () => {
  const fixture = buildIsolatedFixtureDb();
  try {
    // Case 1: never augmented (no marker rows at all yet).
    const neverRun = getRepoStatus('fixture_repo', { db_path: fixture.dbPath });
    assert.equal(neverRun.ok, true);
    if (neverRun.ok) {
      assert.equal(neverRun.augmenter_status, 'never-run');
    }

    const indexedAt = currentFilesIndexedAt(fixture.dbPath);

    // Case 2: augmented after the current files.indexed_at snapshot -> fresh.
    writeAugmenterMarker(fixture.dbPath, Date.now(), indexedAt);
    const fresh = getRepoStatus('fixture_repo', { db_path: fixture.dbPath });
    assert.equal(fresh.ok, true);
    if (fresh.ok) {
      assert.equal(fresh.augmenter_status, 'fresh');
    }

    // Case 3: codegraph reindexed since the augmenter ran (snapshot older
    // than the current files.indexed_at) -> stale.
    writeAugmenterMarker(fixture.dbPath, Date.now(), indexedAt - 1_000);
    const stale = getRepoStatus('fixture_repo', { db_path: fixture.dbPath });
    assert.equal(stale.ok, true);
    if (stale.ok) {
      assert.equal(stale.augmenter_status, 'stale');
    }
  } finally {
    fixture.cleanup();
  }
});
