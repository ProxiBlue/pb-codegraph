import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { assertSupportedSchema, UnsupportedSchemaError } from '../shared/schema-guard.ts';
import { PINNED_CODEGRAPH_PACKAGE } from '../shared/pinned.ts';
import { openReadOnlyDb } from '../mcp/src/db.ts';
import { openWriterDb } from '../augmenter/src/writer/sqlite-writer.ts';
import { buildIsolatedFixtureDb, type IsolatedFixtureDb } from './helpers/isolated-fixture-db.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
const buildScript = path.join(repoRoot, 'scripts', 'build-fixture-db.sh');

// pb-codegraph (task 013 release sweep): switched from copying
// tests/fixture/.codegraph/codegraph.db directly to buildIsolatedFixtureDb
// (own temp dir + own `codegraph init` run). The shared fixture path is
// destructively rm -rf'd + rebuilt by tests/build-fixture-db.test.ts, and
// node --test runs files in parallel by default, so a `before` hook reading
// that shared path here raced it (rare, but observed — see task 003/005/007
// implementation notes documenting the same class of race elsewhere, all
// already migrated to this helper).
let fixture: IsolatedFixtureDb;

test.before(() => {
  fixture = buildIsolatedFixtureDb();
});

test.after(() => {
  fixture.cleanup();
});

let dbCounter = 0;
function freshCopyPath(): string {
  dbCounter += 1;
  const dbPath = path.join(fixture.dir, `guard-db-${dbCounter}.db`);
  fs.copyFileSync(fixture.dbPath, dbPath);
  return dbPath;
}

test('it accepts the fixture db schema version', () => {
  const dbPath = freshCopyPath();
  const db = new Database(dbPath);
  try {
    assert.doesNotThrow(() => assertSupportedSchema(db));
  } finally {
    db.close();
  }
});

test('it refuses an artificially bumped schema version with actionable message', () => {
  const dbPath = freshCopyPath();
  const db = new Database(dbPath);
  try {
    db.prepare('INSERT INTO schema_versions (version, applied_at, description) VALUES (?, ?, ?)').run(
      999,
      Date.now(),
      'artificially bumped for test',
    );

    assert.throws(
      () => assertSupportedSchema(db),
      (err: unknown) => {
        assert.ok(err instanceof UnsupportedSchemaError);
        assert.match(err.message, /999/);
        assert.match(
          err.message,
          new RegExp(PINNED_CODEGRAPH_PACKAGE.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
          'refuse message must name the pinned codegraph version',
        );
        assert.match(
          err.message,
          /docs\/upgrading-codegraph\.md/,
          'refuse message must point at the upgrade procedure doc',
        );
        return true;
      },
    );
  } finally {
    db.close();
  }
});

test('it refuses when provenance column is absent', () => {
  const dbPath = freshCopyPath();
  const db = new Database(dbPath);
  try {
    // Table rebuild (not ALTER TABLE DROP COLUMN) per .claude/testing.md,
    // since `provenance` is directly indexed (idx_edges_provenance) and
    // SQLite's DROP COLUMN support for indexed columns is version-sensitive.
    db.exec(`
      CREATE TABLE edges_no_provenance (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        source TEXT NOT NULL,
        target TEXT NOT NULL,
        kind TEXT NOT NULL,
        metadata TEXT,
        line INTEGER,
        col INTEGER
      );
      INSERT INTO edges_no_provenance (id, source, target, kind, metadata, line, col)
        SELECT id, source, target, kind, metadata, line, col FROM edges;
      DROP TABLE edges;
      ALTER TABLE edges_no_provenance RENAME TO edges;
    `);

    const cols = db.prepare('PRAGMA table_info(edges)').all() as Array<{ name: string }>;
    assert.ok(!cols.some((c) => c.name === 'provenance'), 'rebuild must have actually dropped provenance');

    assert.throws(
      () => assertSupportedSchema(db),
      (err: unknown) => {
        assert.ok(err instanceof UnsupportedSchemaError);
        assert.match(err.message, /provenance/);
        assert.match(err.message, /edges/);
        return true;
      },
    );
  } finally {
    db.close();
  }
});

test('it exposes one pinned version constant consumed by wrapper and fixture script', () => {
  // "fixture script" consumption: scripts/build-fixture-db.sh keeps its own
  // literal in sync with shared/pinned.ts (bash cannot import a .ts module,
  // so this test is the sed-able cross-check mechanism).
  const scriptContent = fs.readFileSync(buildScript, 'utf-8');
  assert.match(
    scriptContent,
    new RegExp(`CODEGRAPH_VERSION="${PINNED_CODEGRAPH_PACKAGE.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"`),
    'build-fixture-db.sh must pin the same codegraph version as shared/pinned.ts',
  );

  // "wrapper" consumption: both the mcp shim's read-only open path and the
  // augmenter's writer open path name PINNED_CODEGRAPH_PACKAGE in their
  // refuse-path message when the guard trips — proving they consume the
  // SAME single constant, not independently duplicated literals.
  const bumpedDbPath = freshCopyPath();
  const bumpedDb = new Database(bumpedDbPath);
  bumpedDb
    .prepare('INSERT INTO schema_versions (version, applied_at, description) VALUES (?, ?, ?)')
    .run(999, Date.now(), 'bumped for wrapper-consumption test');
  bumpedDb.close();

  assert.throws(
    () => openReadOnlyDb(bumpedDbPath),
    (err: unknown) => {
      assert.ok(err instanceof Error);
      assert.ok(err.message.includes(PINNED_CODEGRAPH_PACKAGE));
      return true;
    },
  );

  assert.throws(
    () => openWriterDb(bumpedDbPath),
    (err: unknown) => {
      assert.ok(err instanceof Error);
      assert.ok(err.message.includes(PINNED_CODEGRAPH_PACKAGE));
      return true;
    },
  );
});
