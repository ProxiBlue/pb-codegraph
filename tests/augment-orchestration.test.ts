import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';

import { PROVENANCE } from '../augmenter/src/writer/sqlite-writer.ts';
import { runAugment, DbNotFoundError } from '../augmenter/src/augment.ts';
import { UnsupportedSchemaError } from '../shared/schema-guard.ts';
import { AUGMENTER_RUN_AT_KEY, AUGMENTER_FILES_INDEXED_AT_KEY } from '../mcp/src/augmenter-marker.ts';
import { buildIsolatedFixtureDb, type IsolatedFixtureDb } from './helpers/isolated-fixture-db.ts';

// Ground truth for tests/fixture/app, characterized against a real
// `codegraph init` run (see this task's session notes) — 1 preference_for,
// 2 wraps (one native target, one external-minted target), 2 observes
// (controller_action_predispatch, checkout_cart_save_after), 1 renders, 1
// references (webapi only — routes.xml mints a route node but never an
// edge, see docs/edge-taxonomy.md "Route honesty note").
const EXPECTED_EDGE_KIND_COUNTS: Record<string, number> = {
  preference_for: 1,
  wraps: 2,
  observes: 2,
  renders: 1,
  references: 1,
};
const EXPECTED_TOTAL_EDGES = 7;

let fixture: IsolatedFixtureDb;

test.before(() => {
  fixture = buildIsolatedFixtureDb();
});

test.after(() => {
  fixture.cleanup();
});

let dbCounter = 0;
function freshDbPath(): string {
  dbCounter += 1;
  const dbPath = path.join(fixture.dir, `augment-scratch-${dbCounter}.db`);
  fs.copyFileSync(fixture.dbPath, dbPath);
  return dbPath;
}

function edgeKindCounts(dbPath: string): Record<string, number> {
  const db = new Database(dbPath, { readonly: true });
  try {
    const rows = db
      .prepare(`SELECT kind, COUNT(*) AS c FROM edges WHERE provenance = ? GROUP BY kind`)
      .all(PROVENANCE) as Array<{ kind: string; c: number }>;
    return Object.fromEntries(rows.map((r) => [r.kind, r.c]));
  } finally {
    db.close();
  }
}

function totalCounts(dbPath: string): { nodes: number; edges: number } {
  const db = new Database(dbPath, { readonly: true });
  try {
    const nodes = (db.prepare('SELECT COUNT(*) AS c FROM nodes').get() as { c: number }).c;
    const edges = (db.prepare('SELECT COUNT(*) AS c FROM edges').get() as { c: number }).c;
    return { nodes, edges };
  } finally {
    db.close();
  }
}

test('it augments the fixture project producing all six edge families with correct counts', async () => {
  const dbPath = freshDbPath();
  const result = await runAugment(fixture.dir, dbPath);

  assert.equal(result.families.diPreferences.resolved, 1);
  assert.equal(result.families.diPlugins.resolved, 2);
  assert.equal(result.families.events.resolved, 2);
  assert.equal(result.families.layout.resolved, 1);
  assert.equal(result.families.webapi.resolved, 1);
  assert.equal(result.families.routes.routesMinted, 1);

  assert.equal(result.edgesInserted, EXPECTED_TOTAL_EDGES);
  assert.deepEqual(edgeKindCounts(dbPath), EXPECTED_EDGE_KIND_COUNTS);
});

test('it records the staleness marker pair in project_metadata', async () => {
  const dbPath = freshDbPath();
  const before = Date.now();
  const result = await runAugment(fixture.dir, dbPath);

  const db = new Database(dbPath, { readonly: true });
  try {
    const runAtRow = db.prepare('SELECT value FROM project_metadata WHERE key = ?').get(AUGMENTER_RUN_AT_KEY) as
      | { value: string }
      | undefined;
    const snapshotRow = db
      .prepare('SELECT value FROM project_metadata WHERE key = ?')
      .get(AUGMENTER_FILES_INDEXED_AT_KEY) as { value: string } | undefined;

    assert.ok(runAtRow, 'expected pb_augmenter_run_at to be recorded');
    assert.ok(snapshotRow, 'expected pb_augmenter_files_indexed_at to be recorded');
    assert.ok(Number(runAtRow!.value) >= before, 'run_at must be a real timestamp taken during this run');
    assert.equal(Number(snapshotRow!.value), result.filesIndexedAt);
  } finally {
    db.close();
  }
});

test('it is idempotent across three consecutive runs with identical final row counts', async () => {
  const dbPath = freshDbPath();

  await runAugment(fixture.dir, dbPath);
  const first = totalCounts(dbPath);

  await runAugment(fixture.dir, dbPath);
  const second = totalCounts(dbPath);

  await runAugment(fixture.dir, dbPath);
  const third = totalCounts(dbPath);

  assert.deepEqual(second, first);
  assert.deepEqual(third, first);
  assert.deepEqual(edgeKindCounts(dbPath), EXPECTED_EDGE_KIND_COUNTS);
});

test('it re-injects edges after a codegraph reindex wiped them', async () => {
  const dbPath = freshDbPath();
  await runAugment(fixture.dir, dbPath);
  const original = totalCounts(dbPath);
  assert.equal(edgeKindCounts(dbPath) && Object.values(edgeKindCounts(dbPath)).reduce((a, b) => a + b, 0), EXPECTED_TOTAL_EDGES);

  // Simulate a codegraph reindex: it cascade-deletes every augmenter-owned
  // edge (FK ON DELETE CASCADE off `nodes`) by deleting the minted nodes
  // those edges reference, plus any provenance edge still standing
  // (e.g. wraps edges targeting a NATIVE node, which a real reindex leaves
  // in place but the augmenter's own re-run must still wipe/reinsert).
  const wipe = new Database(dbPath);
  try {
    wipe.prepare(`DELETE FROM edges WHERE provenance = ?`).run(PROVENANCE);
    wipe
      .prepare(`DELETE FROM nodes WHERE kind IN ('event', 'route', 'template', 'external')`)
      .run();
  } finally {
    wipe.close();
  }
  assert.equal(Object.keys(edgeKindCounts(dbPath)).length, 0, 'expected the simulated wipe to remove all magento edges');

  await runAugment(fixture.dir, dbPath);
  const restored = totalCounts(dbPath);

  assert.deepEqual(restored, original);
  assert.deepEqual(edgeKindCounts(dbPath), EXPECTED_EDGE_KIND_COUNTS);
});

test('it re-runs augment when files.indexed_at advances mid-run (watcher race) before recording the marker', async () => {
  const dbPath = freshDbPath();

  // Simulate the FS-watcher's reindex landing in the exact window between
  // the write completing and the post-write files.indexed_at re-check —
  // only on the first attempt, so the second (retry) attempt observes a
  // stable before/after pair and the loop terminates.
  let bumped = false;
  const result = await runAugment(fixture.dir, dbPath, {
    onAfterWrite: (db, attempt) => {
      if (attempt === 1 && !bumped) {
        bumped = true;
        const row = db.prepare('SELECT path FROM files LIMIT 1').get() as { path: string };
        db.prepare('UPDATE files SET indexed_at = indexed_at + 999999 WHERE path = ?').run(row.path);
      }
    },
  });

  assert.equal(result.attempts, 2, 'expected exactly one re-augment after the simulated watcher race');
  assert.deepEqual(edgeKindCounts(dbPath), EXPECTED_EDGE_KIND_COUNTS, 'edges must reflect the final stable write');

  const db = new Database(dbPath, { readonly: true });
  try {
    const currentIndexedAt = (db.prepare('SELECT MAX(indexed_at) AS m FROM files').get() as { m: number }).m;
    const snapshotRow = db
      .prepare('SELECT value FROM project_metadata WHERE key = ?')
      .get(AUGMENTER_FILES_INDEXED_AT_KEY) as { value: string };
    assert.equal(
      Number(snapshotRow.value),
      currentIndexedAt,
      'the recorded marker must match the CONFIRMED-STABLE post-write snapshot, not the mid-race value',
    );
  } finally {
    db.close();
  }
});

// The CLI-level "exits 2 with a clear message on missing/unknown-schema db"
// requirement (checklist item 6) is covered end-to-end, at the process exit
// code, in tests/augment-cli.test.ts — this file only proves runAugment()
// throws the two distinguishable error types the CLI maps to exit code 2.
test('it throws DbNotFoundError for a missing db (feeds the CLI exit-2 path)', async () => {
  const missingPath = path.join(fixture.dir, 'does-not-exist.db');
  await assert.rejects(() => runAugment(fixture.dir, missingPath), DbNotFoundError);
});

test('it throws UnsupportedSchemaError for an unknown-schema db (feeds the CLI exit-2 path)', async () => {
  const badSchemaPath = path.join(fixture.dir, 'bad-schema.db');
  const db = new Database(badSchemaPath);
  db.exec('CREATE TABLE schema_versions (version INTEGER)');
  db.exec('INSERT INTO schema_versions (version) VALUES (999)');
  db.close();

  await assert.rejects(() => runAugment(fixture.dir, badSchemaPath), UnsupportedSchemaError);
});
