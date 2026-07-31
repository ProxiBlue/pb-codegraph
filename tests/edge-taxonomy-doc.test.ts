import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const docPath = path.join(path.resolve(__dirname, '..'), 'docs', 'edge-taxonomy.md');

function read(): string {
  return fs.readFileSync(docPath, 'utf-8');
}

test('it documents the corrected edge/node taxonomy (kind remap, minted node kinds, class-not-File endpoints, wraps metadata sortOrder/area only) with metadata fields per kind', () => {
  assert.ok(fs.existsSync(docPath), 'expected docs/edge-taxonomy.md to exist');
  const doc = read();

  // Locked lowercase edge kinds
  for (const kind of ['preference_for', 'wraps', 'observes', 'renders', 'references']) {
    assert.match(doc, new RegExp(`\`${kind}\``), `edge kind ${kind} must be documented`);
  }

  // Kind remap table: vendored uppercase type -> locked kind, per family
  assert.match(doc, /IMPLEMENTS/, 'must document the vendored IMPLEMENTS -> preference_for remap');
  assert.match(doc, /WRAPS/, 'must document the vendored WRAPS -> wraps remap');
  assert.match(doc, /CALLS/, 'must document the vendored CALLS -> observes/renders remap (observer+layout both emit CALLS)');
  assert.match(doc, /HANDLES_ROUTE/, 'must document the vendored HANDLES_ROUTE -> references remap (webapi+routes)');
  assert.match(doc, /preference_for.*NOT.*native `implements`|distinct kind, NOT native `implements`|not native `implements`/is,
    'must call out that preference_for is a distinct kind from codegraph native implements (collision risk)');

  // Minted node kinds with id schemes
  assert.match(doc, /magento:event:<name>/);
  assert.match(doc, /magento:route:<area>:<path>/);
  assert.match(doc, /magento:template:<area>:<path>/);
  assert.match(doc, /magento:external:<normalized-fqcn>|magento:external:<fqcn>/);

  // Endpoint model: class-not-File
  assert.match(doc, /observer[\s\S]{0,80}event[\s\S]{0,80}class|event node[\s\S]{0,120}observer.{0,4}class/i);
  assert.match(doc, /block[\s\S]{0,40}class[\s\S]{0,80}template/i);
  assert.match(doc, /File:<relpath>|File:.*endpoint/i, 'must document that vendored mappers emit File: endpoints with no codegraph node');

  // wraps metadata restricted to sortOrder/area (before/after/around deferred)
  assert.match(doc, /sortOrder/);
  assert.match(doc, /\barea\b/);
  assert.match(doc, /before`?\/`?after`?\/`?around|before, after, around/i);
  assert.match(doc, /v0\.4|deferred/i);

  // provenance + reason discipline
  assert.match(doc, /pb-codegraph-augmenter/);
  assert.match(doc, /magento:<source>|metadata\.reason/);

  // metadata fields documented per kind (a metadata column/section per edge kind)
  assert.match(doc, /observes[\s\S]{0,200}event/i);
  assert.match(doc, /wraps[\s\S]{0,200}sortOrder/i);
});
