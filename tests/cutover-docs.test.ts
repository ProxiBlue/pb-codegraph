// Content assertions for docs/cutover.md (task 010). Each test name matches
// a requirement from .claude/plans/v0-2-0-codegraph-engine/010-ddev-cutover.md
// verbatim. These are doc-content checks (grep-style, not prose-quality
// checks) — they pin the concrete facts/commands the doc must contain so a
// future edit can't silently drop a requirement.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
const docPath = path.join(repoRoot, 'docs', 'cutover.md');

function readDoc(): string {
  assert.ok(fs.existsSync(docPath), `expected ${docPath} to exist`);
  return fs.readFileSync(docPath, 'utf-8');
}

test('it documents the full pps cutover sequence including rollback (gitnexus containers stopped not removed)', () => {
  const doc = readDoc();

  assert.match(doc, /pvcpipesupplies|\bpps\b/i, 'must name pps as the cutover target');

  // The sequence must be a concrete, ordered set of steps, not prose alone.
  for (const marker of [/docker stop ddev-.*-gitnexus/, /registry\.json/, /mcps\/\.mcp\.json/, /pb-codegraph health/]) {
    assert.match(doc, marker, `cutover sequence missing expected step matching ${marker}`);
  }

  // Rollback: containers stopped, explicitly NOT removed/deleted.
  assert.match(doc, /## Rollback/i, 'must have a distinct Rollback section');
  assert.match(doc, /docker stop ddev-.*-gitnexus/, 'rollback must stop the gitnexus container');
  assert.match(doc, /docker start ddev-.*-gitnexus/, 'rollback must be able to restart the still-present gitnexus container');
  assert.doesNotMatch(doc, /docker rm\b.*gitnexus/, 'rollback/cutover must never remove the gitnexus container');
  assert.match(
    doc,
    /not removed|never remov|stopped[, ]+not removed/i,
    'must explicitly state gitnexus containers are stopped, not removed',
  );
});

test('it documents where indexing runs and confirms node/npx availability there', () => {
  const doc = readDoc();

  assert.match(doc, /IN\s+the ddev web container/i, 'must state project indexing runs in the web container');
  assert.match(doc, /ddev exec node --version/, 'must give a concrete node-availability check command');
  assert.match(doc, /ddev exec npx --version/, 'must give a concrete npx-availability check command');
  assert.match(doc, />=20|engines\.node/, 'must cross-reference the node engines requirement');
  assert.match(doc, /HOST|host filesystem/i, 'must state core-index builds run on the host, not in a container');
  assert.match(doc, /better-sqlite3/, 'must address the native binding ABI risk for better-sqlite3');
  assert.match(doc, /node:sqlite/, 'must document the node:sqlite fallback if the native binding ABI mismatches');
});

test('it requires a LIVE-branch check before any .ddev/mcp/registry edit', () => {
  const doc = readDoc();

  assert.match(doc, /LIVE-branch check/i);
  assert.match(doc, /git branch --show-current/);
  assert.match(doc, /STOP and list/i, 'must state stop-and-list-offenders behavior on mismatch, not a silent skip');
  assert.match(doc, /\.ddev\//, 'must name .ddev/ as a gated write target');
  assert.match(doc, /mcps\/\.mcp\.json/, 'must name mcps/.mcp.json as a gated write target');
  assert.match(doc, /registry\.json/, 'must name registry.json as a gated write target');
});

test('it documents the read only core-index mount for ddev containers', () => {
  const doc = readDoc();

  assert.match(doc, /docker-compose\.pb-codegraph\.yaml/, 'must name the new compose file for the mount');
  assert.match(doc, /:ro"/, 'must show the mount declared read-only');
  assert.match(doc, /\/mounts\/pb-codegraph-core/, 'must name the fixed in-container mount point');
  assert.match(doc, /PB_CODEGRAPH_INDEX_DIR/, 'must be env-driven, not a baked host path');
  assert.doesNotMatch(doc, /\/home\/lucas/, 'must not bake a literal host path into the mount instructions');
});

test('it documents the per-project vendor-split index (cores excluded, 3rd-party vendor included)', () => {
  const doc = readDoc();

  assert.match(doc, /per-project-vendor-split\.gitignore/);
  assert.match(doc, /excludes vendor\/mage-os\/ and vendor\/hyva-themes\/|vendor\/mage-os.*vendor\/hyva-themes/i);
  assert.match(doc, /every OTHER vendor\/\* package stays indexed|keeping every OTHER.*vendor.*indexed/i);
  assert.match(doc, />> \.gitignore|append/i, 'must document appending to the project .gitignore, not overwriting it');
});

test('it flags the pb-hcf probe update as cross-plugin follow-up without editing pb-hcf', () => {
  const doc = readDoc();

  assert.match(doc, /Follow-up/i);
  assert.match(doc, /pb-hcf/i);
  assert.match(doc, /curl\s*:?4747|curl.*:4747/i, 'must name the probe being replaced');
  assert.match(doc, /NOT done in this task|does not edit pb-hcf|not touched by this task/i);

  // This repo really did not touch pb-hcf during this task.
  const gitStatusOut = execFileSync('git', ['status', '--porcelain'], { cwd: repoRoot }).toString();
  assert.doesNotMatch(gitStatusOut, /pb-hcf/i, "no pb-hcf path should appear in this repo's working tree changes");
});

test('it records the empirical Post-001 vendor-dir verification with commands and node-count > 0 evidence', () => {
  const verificationPath = path.join(repoRoot, 'docs', 'vendor-dir-verification.md');
  assert.ok(fs.existsSync(verificationPath), `expected ${verificationPath} to exist`);
  const doc = fs.readFileSync(verificationPath, 'utf-8');

  assert.match(doc, /Post-001/, 'must name the Post-001 caveat it is proving');
  assert.match(doc, /pvcpipesupplies/i, 'must name the real project the verification ran against');
  assert.match(doc, /vendor\/hyva-themes/, 'must name the real vendor subtree used');
  assert.match(doc, /"c":\s*419/, 'must record the actual sqlite node-count evidence, not a placeholder');
  assert.match(doc, /nodeCount\.c = 419 > 0|> 0/, 'must assert node count > 0');
  assert.match(doc, /test_real_pps_hyva_vendor_node_counts/, 'must cross-reference the automated regression test');
  assert.match(doc, /root\s*`?\.gitignore`?\s*negation/i, 'must state which mechanism was chosen (root .gitignore negation vs ignore-config override)');

  // docs/cutover.md must point at this evidence doc.
  const cutover = readDoc();
  assert.match(cutover, /vendor-dir-verification\.md/, 'docs/cutover.md must reference docs/vendor-dir-verification.md');
});
