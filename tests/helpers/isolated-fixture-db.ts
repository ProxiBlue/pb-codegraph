// Builds a private, per-call copy of the tests/fixture/ codegraph index so
// MCP shim tests (which read AND sometimes mutate project_metadata to
// exercise staleness scenarios) never race with tests/build-fixture-db.test.ts,
// which destructively rebuilds the shared tests/fixture/.codegraph/ output on
// every run. node --test executes test files in parallel by default, so two
// files touching the same SQLite file would be a real race, not a theoretical
// one.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..', '..');

// Kept in sync with scripts/build-fixture-db.sh (see tests/build-fixture-db.test.ts
// for the pin assertion against that script).
const CODEGRAPH_VERSION = '@colbymchenry/codegraph@1.5.0';

export interface IsolatedFixtureDb {
  dir: string;
  dbPath: string;
  cleanup: () => void;
}

/**
 * Builds an isolated codegraph SQLite index (own temp dir, own copy of the
 * fixture PHP tree) so callers can freely open the db read/write for
 * augmenter-marker seeding without touching the shared fixture db other
 * tests read.
 */
export function buildIsolatedFixtureDb(): IsolatedFixtureDb {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pb-codegraph-mcp-fixture-'));
  fs.cpSync(path.join(repoRoot, 'tests', 'fixture', 'app'), path.join(dir, 'app'), { recursive: true });

  execFileSync('npx', ['--yes', CODEGRAPH_VERSION, 'init', '--force', dir], { stdio: 'pipe' });

  const dbPath = path.join(dir, '.codegraph', 'codegraph.db');
  if (!fs.existsSync(dbPath)) {
    fs.rmSync(dir, { recursive: true, force: true });
    throw new Error(`expected isolated fixture db at ${dbPath} after codegraph init`);
  }

  return {
    dir,
    dbPath,
    cleanup: () => fs.rmSync(dir, { recursive: true, force: true }),
  };
}
