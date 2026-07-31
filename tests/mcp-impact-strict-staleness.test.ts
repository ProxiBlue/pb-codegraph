import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { getImpact, StaleAugmenterError } from '../mcp/src/impact.ts';
import { buildIsolatedFixtureDb } from './helpers/isolated-fixture-db.ts';

const CLASS_FOO_ID = 'class:8a4d752448b6fec30dc789fc478809fe';

function currentFilesIndexedAt(dbPath: string): number {
  const db = new Database(dbPath, { readonly: true });
  try {
    return (db.prepare('SELECT MAX(indexed_at) AS m FROM files').get() as { m: number }).m;
  } finally {
    db.close();
  }
}

function writeStaleAugmenterMarker(dbPath: string, currentIndexedAt: number): void {
  const db = new Database(dbPath);
  try {
    const runAt = Date.now();
    db.prepare('INSERT OR REPLACE INTO project_metadata (key, value, updated_at) VALUES (?, ?, ?)').run(
      'pb_augmenter_run_at',
      String(runAt),
      runAt,
    );
    db.prepare('INSERT OR REPLACE INTO project_metadata (key, value, updated_at) VALUES (?, ?, ?)').run(
      'pb_augmenter_files_indexed_at',
      String(currentIndexedAt - 1_000),
      runAt,
    );
  } finally {
    db.close();
  }
}

test('it fails (not warns) in strict mode when the marker is stale', { timeout: 120_000 }, () => {
  const fixture = buildIsolatedFixtureDb();
  try {
    const indexedAt = currentFilesIndexedAt(fixture.dbPath);
    writeStaleAugmenterMarker(fixture.dbPath, indexedAt);

    assert.throws(
      () =>
        getImpact(
          { fixture_repo: { db_path: fixture.dbPath } },
          { symbol: CLASS_FOO_ID, repo: 'fixture_repo', strict: true },
        ),
      (err: unknown) => {
        assert.ok(err instanceof StaleAugmenterError, 'expected a StaleAugmenterError, not a soft per-repo error');
        assert.match((err as Error).message, /stale/i);
        assert.match((err as Error).message, /PB_CODEGRAPH_STRICT_STALENESS|strict/i);
        return true;
      },
    );
  } finally {
    fixture.cleanup();
  }
});
