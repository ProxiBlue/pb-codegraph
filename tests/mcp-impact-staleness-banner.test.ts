import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { getImpact } from '../mcp/src/impact.ts';
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
    // Snapshot older than the CURRENT files.indexed_at -> codegraph reindexed
    // since the last augment run -> stale (see mcp/src/augmenter-marker.ts).
    db.prepare('INSERT OR REPLACE INTO project_metadata (key, value, updated_at) VALUES (?, ?, ?)').run(
      'pb_augmenter_files_indexed_at',
      String(currentIndexedAt - 1_000),
      runAt,
    );
  } finally {
    db.close();
  }
}

test(
  'it emits a loud non-authoritative banner and flags non-green when the augmenter marker is stale',
  { timeout: 120_000 },
  () => {
    const fixture = buildIsolatedFixtureDb();
    try {
      const indexedAt = currentFilesIndexedAt(fixture.dbPath);
      writeStaleAugmenterMarker(fixture.dbPath, indexedAt);

      const result = getImpact(
        { fixture_repo: { db_path: fixture.dbPath } },
        { symbol: CLASS_FOO_ID, repo: 'fixture_repo' },
      );

      assert.equal(result.errors.length, 0);
      assert.ok(result.warning, 'expected a top-level LOUD warning, not a silent/soft note');
      assert.match(result.warning ?? '', /STALE/);

      const [repoResult] = result.results;
      assert.equal(repoResult.augmenter_status, 'stale');
      assert.equal(
        repoResult.non_authoritative,
        true,
        'a stale repo result must be flagged non_authoritative for the health probe (010) to report non-green',
      );
    } finally {
      fixture.cleanup();
    }
  },
);
