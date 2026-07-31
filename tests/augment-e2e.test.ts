// Mandatory end-to-end fixture test (see .claude/testing.md's "Project
// Testing Configuration" note for task 004): build fixture db -> augment ->
// verify all six edge families + counts -> codegraph reindex (wipes) ->
// wrapper `index` -> counts restored identical. Spawns the REAL
// bin/pb-codegraph.ts CLI (not the in-process main()) and the REAL pinned
// codegraph binary via npx, so this genuinely exercises the cascade-wipe
// premise this task's watcher-race guard exists for — not a simulation.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';

import { PROVENANCE } from '../augmenter/src/writer/sqlite-writer.ts';
import { PINNED_CODEGRAPH_PACKAGE } from '../shared/pinned.ts';
import { buildIsolatedFixtureDb, type IsolatedFixtureDb } from './helpers/isolated-fixture-db.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
const cliEntrypoint = path.join(repoRoot, 'bin', 'pb-codegraph.ts');

function runCli(args: string[]): { stdout: string; status: number } {
  try {
    const stdout = execFileSync(process.execPath, ['--import', 'tsx', cliEntrypoint, ...args], {
      cwd: repoRoot,
      encoding: 'utf-8',
    });
    return { stdout, status: 0 };
  } catch (err) {
    const e = err as { status?: number; stdout?: string };
    return { stdout: e.stdout ?? '', status: e.status ?? 1 };
  }
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

test(
  'end-to-end: index -> augment -> reindex (wipes) -> wrapper index -> counts restored identical',
  { timeout: 180_000 },
  async () => {
    let fixture: IsolatedFixtureDb | undefined;
    try {
      // 1. Build fixture db (own scratch fixture dir + real `codegraph init`).
      fixture = buildIsolatedFixtureDb();

      // 2. augment.
      const augmentResult = runCli(['augment', fixture.dir]);
      assert.equal(augmentResult.status, 0, `augment must exit 0; stdout:\n${augmentResult.stdout}`);

      // 3. Verify all six edge families + counts.
      const afterAugment = edgeKindCounts(fixture.dbPath);
      assert.deepEqual(afterAugment, {
        preference_for: 1,
        wraps: 2,
        observes: 2,
        renders: 1,
        references: 1,
      });
      const totalsAfterAugment = totalCounts(fixture.dbPath);
      assert.equal(
        Object.values(afterAugment).reduce((a, b) => a + b, 0),
        7,
        'expected 7 total augmenter-owned edges across all six families',
      );

      // 4. codegraph reindex — the REAL cascade-wipe, not a simulation.
      execFileSync('npx', ['--yes', PINNED_CODEGRAPH_PACKAGE, 'index', '--force', fixture.dir], { stdio: 'pipe' });
      const afterWipe = edgeKindCounts(fixture.dbPath);
      assert.deepEqual(afterWipe, {}, 'expected the real codegraph reindex to cascade-delete every magento edge');

      // 5. wrapper `index` (codegraph index && augment).
      const indexResult = runCli(['index', fixture.dir]);
      assert.equal(indexResult.status, 0, `wrapper index must exit 0; stdout:\n${indexResult.stdout}`);

      // 6. Counts restored identical.
      const restored = edgeKindCounts(fixture.dbPath);
      assert.deepEqual(restored, afterAugment);
      assert.deepEqual(totalCounts(fixture.dbPath), totalsAfterAugment);
    } finally {
      fixture?.cleanup();
    }
  },
);
