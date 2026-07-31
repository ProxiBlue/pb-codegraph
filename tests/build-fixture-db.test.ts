import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
const dbPath = path.join(repoRoot, 'tests', 'fixture', '.codegraph', 'codegraph.db');

test('it builds a fixture codegraph db via pinned codegraph version script', { timeout: 120_000 }, () => {
  const scriptPath = path.join(repoRoot, 'scripts', 'build-fixture-db.sh');
  assert.ok(fs.existsSync(scriptPath), 'expected scripts/build-fixture-db.sh to exist');

  const scriptContent = fs.readFileSync(scriptPath, 'utf-8');
  assert.match(scriptContent, /@colbymchenry\/codegraph@1\.5\.0/, 'script must pin the codegraph version');

  execFileSync('bash', [scriptPath], { stdio: 'pipe' });

  assert.ok(fs.existsSync(dbPath), `expected fixture db at ${dbPath} after running the script`);

  const db = new Database(dbPath, { readonly: true });
  try {
    const nodeCount = (db.prepare('SELECT COUNT(*) AS c FROM nodes').get() as { c: number }).c;
    assert.ok(nodeCount > 0, 'fixture db must contain at least one indexed node');
  } finally {
    db.close();
  }
});
