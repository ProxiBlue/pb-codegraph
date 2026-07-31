import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';

import { main, EXIT_OK, EXIT_DB_ERROR, EXIT_AUGMENT_ERROR } from '../augmenter/src/cli.ts';
import { buildIsolatedFixtureDb, type IsolatedFixtureDb } from './helpers/isolated-fixture-db.ts';

let fixture: IsolatedFixtureDb;

test.before(() => {
  fixture = buildIsolatedFixtureDb();
});

test.after(() => {
  fixture.cleanup();
});

function captureIO(): { io: { log: (m: string) => void; error: (m: string) => void }; logs: string[]; errors: string[] } {
  const logs: string[] = [];
  const errors: string[] = [];
  return { io: { log: (m) => logs.push(m), error: (m) => errors.push(m) }, logs, errors };
}

test('it exits 2 with clear message on missing db', async () => {
  const missingPath = path.join(fixture.dir, 'nope.db');
  const { io, errors } = captureIO();

  const code = await main(['augment', fixture.dir, '--db', missingPath], io);

  assert.equal(code, EXIT_DB_ERROR);
  assert.ok(errors.length > 0, 'expected an actionable error message');
  assert.match(errors[0], /codegraph db not found/i);
  assert.ok(errors[0].includes(missingPath), 'error message must name the missing db path');
});

test('it exits 2 with clear message on unknown-schema db', async () => {
  const badSchemaPath = path.join(fixture.dir, 'cli-bad-schema.db');
  const db = new Database(badSchemaPath);
  db.exec('CREATE TABLE schema_versions (version INTEGER)');
  db.exec('INSERT INTO schema_versions (version) VALUES (999)');
  db.close();

  const { io, errors } = captureIO();
  const code = await main(['augment', fixture.dir, '--db', badSchemaPath], io);

  assert.equal(code, EXIT_DB_ERROR);
  assert.ok(errors.length > 0, 'expected an actionable error message');
  assert.match(errors[0], /refusing to open codegraph db/i);
});

test('it exits 0 and prints a summary on a successful augment run', async () => {
  const dbPath = path.join(fixture.dir, 'cli-success.db');
  fs.copyFileSync(fixture.dbPath, dbPath);

  const { io, logs } = captureIO();
  const code = await main(['augment', fixture.dir, '--db', dbPath], io);

  assert.equal(code, EXIT_OK);
  assert.ok(logs.some((l) => l.includes('Augmentation complete.')));
});

test('it exits 1 with usage on an unrecognized command', async () => {
  const { io, errors } = captureIO();
  const code = await main(['frobnicate', fixture.dir], io);

  assert.equal(code, EXIT_AUGMENT_ERROR);
  assert.ok(errors.length > 0);
  assert.match(errors[0], /Usage:/);
});
