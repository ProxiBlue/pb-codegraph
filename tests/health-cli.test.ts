// Tests for `pb-codegraph health` (task 010) — the CLI replacement for the
// old gitnexus http :4747 probe. See docs/cutover.md "Health probe" section
// for the wire-usage contract this backs.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';

import { main, EXIT_OK, EXIT_HEALTH_NOT_GREEN, EXIT_DB_ERROR } from '../augmenter/src/cli.ts';
import { buildIsolatedFixtureDb, type IsolatedFixtureDb } from './helpers/isolated-fixture-db.ts';

function captureIO(): { io: { log: (m: string) => void; error: (m: string) => void }; logs: string[]; errors: string[] } {
  const logs: string[] = [];
  const errors: string[] = [];
  return { io: { log: (m) => logs.push(m), error: (m) => errors.push(m) }, logs, errors };
}

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

let fixture: IsolatedFixtureDb;

test.before(() => {
  fixture = buildIsolatedFixtureDb();
});

test.after(() => {
  fixture.cleanup();
});

test(
  'it provides a health command usable as the new wire probe that reports non-green on stale augmenter markers',
  { timeout: 120_000 },
  async () => {
    const registryPath = path.join(fixture.dir, 'health-registry.json');
    fs.writeFileSync(registryPath, JSON.stringify({ fixture_repo: { db_path: fixture.dbPath } }));

    const indexedAt = currentFilesIndexedAt(fixture.dbPath);

    // fresh marker -> green, exit 0
    writeAugmenterMarker(fixture.dbPath, Date.now(), indexedAt);
    const { io: freshIo, logs: freshLogs } = captureIO();
    const freshCode = await main(['health', '--registry', registryPath], freshIo);
    assert.equal(freshCode, EXIT_OK);
    const freshReport = JSON.parse(freshLogs.join(''));
    assert.equal(freshReport.status, 'green');
    assert.equal(freshReport.repos.find((r: { name: string }) => r.name === 'fixture_repo')?.augmenter_status, 'fresh');

    // stale marker (codegraph reindexed since last augment run) -> non-green, nonzero exit
    writeAugmenterMarker(fixture.dbPath, Date.now(), indexedAt - 1_000);
    const { io: staleIo, logs: staleLogs } = captureIO();
    const staleCode = await main(['health', '--registry', registryPath], staleIo);
    assert.equal(staleCode, EXIT_HEALTH_NOT_GREEN);
    assert.notEqual(staleCode, EXIT_OK);
    const staleReport = JSON.parse(staleLogs.join(''));
    assert.equal(staleReport.status, 'non-green');
    const staleRepo = staleReport.repos.find((r: { name: string }) => r.name === 'fixture_repo');
    assert.equal(staleRepo?.augmenter_status, 'stale');

    // registry pointing at a missing db -> per-repo error, still non-green
    const brokenRegistryPath = path.join(fixture.dir, 'health-registry-broken.json');
    fs.writeFileSync(
      brokenRegistryPath,
      JSON.stringify({ broken_repo: { db_path: path.join(fixture.dir, 'does-not-exist.db') } }),
    );
    const { io: brokenIo, logs: brokenLogs } = captureIO();
    const brokenCode = await main(['health', '--registry', brokenRegistryPath], brokenIo);
    assert.equal(brokenCode, EXIT_HEALTH_NOT_GREEN);
    const brokenReport = JSON.parse(brokenLogs.join(''));
    assert.equal(brokenReport.status, 'non-green');
    assert.equal(brokenReport.repos.find((r: { name: string }) => r.name === 'broken_repo')?.ok, false);

    // registry file itself missing -> config error, distinct exit code
    const { io: missingIo, errors: missingErrors } = captureIO();
    const missingCode = await main(['health', '--registry', path.join(fixture.dir, 'nope-registry.json')], missingIo);
    assert.equal(missingCode, EXIT_DB_ERROR);
    assert.ok(missingErrors.length > 0);
  },
);
