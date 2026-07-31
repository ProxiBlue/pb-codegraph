// Tests for templates/registry.template.json (task 010) — the ddev cutover
// deliverable operators copy per-project and fill in the placeholder repo
// name. Values must be CONTAINER paths (never baked host paths) — see
// docs/cutover.md "Registry template" section and mcp/src/registry.ts's
// db_path contract note.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadRegistryFromPath } from '../mcp/src/registry.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
const templatePath = path.join(repoRoot, 'templates', 'registry.template.json');

test('it ships a registry template with container-path db entries covering project plus core repos', () => {
  assert.ok(fs.existsSync(templatePath), `expected registry template at ${templatePath}`);

  // Must be a well-formed registry (same shape mcp/src/registry.ts loads at
  // runtime), so it doubles as a schema-validated example, not just prose.
  const registry = loadRegistryFromPath(templatePath);

  // Core repos built centrally by scripts/build-core-indexes.sh.
  for (const coreName of ['mageos', 'hyva', 'deps']) {
    assert.ok(registry[coreName], `expected a "${coreName}" core repo entry`);
    assert.match(
      registry[coreName].db_path,
      /\.codegraph\/codegraph\.db$/,
      `${coreName} db_path must point at a codegraph.db file`,
    );
  }

  // A per-project entry (placeholder key the operator renames) for the
  // vendor-split project db.
  const nonCoreEntries = Object.entries(registry).filter(([name]) => !['mageos', 'hyva', 'deps'].includes(name));
  assert.ok(nonCoreEntries.length >= 1, 'expected at least one placeholder project repo entry');

  const raw = fs.readFileSync(templatePath, 'utf-8');
  const home = os.homedir();

  for (const [name, entry] of Object.entries(registry)) {
    assert.ok(entry.db_path.startsWith('/'), `${name} db_path must be an absolute container path`);
  }

  // No baked host paths: neither this machine's home dir nor the repo's own
  // checkout path may leak into the template.
  assert.ok(!raw.includes(home), 'registry template must not contain a baked host home-directory path');
  assert.ok(!raw.includes(repoRoot), 'registry template must not contain a baked host repo path');
});
