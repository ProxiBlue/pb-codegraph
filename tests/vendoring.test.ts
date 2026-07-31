import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
const srcRoot = path.join(repoRoot, 'augmenter', 'src');

function readSrc(...parts: string[]): string {
  return fs.readFileSync(path.join(srcRoot, ...parts), 'utf-8');
}

test('it vendors the pure xml parsers and path resolvers verbatim, does NOT vendor mappers or lbug writer, and re-implements node-id resolver DB-backed (not vendored)', async () => {
  // Vendored pure parsers must exist
  for (const file of [
    'parsers/di-xml.ts',
    'parsers/layout-xml.ts',
    'parsers/events-xml.ts',
    'parsers/webapi-xml.ts',
    'parsers/routes-xml.ts',
  ]) {
    assert.ok(
      fs.existsSync(path.join(srcRoot, file)),
      `expected vendored parser ${file} to exist`,
    );
  }

  // Vendored pure resolvers must exist
  for (const file of ['resolvers/psr4-map.ts', 'resolvers/template-path.ts']) {
    assert.ok(
      fs.existsSync(path.join(srcRoot, file)),
      `expected vendored resolver ${file} to exist`,
    );
  }

  // resolvers/node-id.ts: task 003 re-implements this file (same path as
  // the vendored original) as a from-scratch, DB-backed rewrite — not a
  // vendored copy. Existence alone can't distinguish the two, so assert the
  // rewrite instead of absence: it must not carry the vendored
  // filesystem/synthetic-id implementation (`fs.existsSync`-based
  // resolution, the `NodeIdResolver` class, or the `Class:<path>:<Name>`
  // synthetic id scheme — see _devils_advocate.md C1), and it must actually
  // query the codegraph nodes table it's meant to be backed by.
  const nodeIdPath = path.join(srcRoot, 'resolvers', 'node-id.ts');
  assert.ok(fs.existsSync(nodeIdPath), "expected task 003's DB-backed rewrite at resolvers/node-id.ts to exist");
  // Strip `//` line comments first — this file's own doc comments discuss
  // (in prose) exactly the vendored tokens being ruled out here (explaining
  // what it deliberately does NOT do), so matching raw source would false-
  // positive on those explanations rather than on actual vendored code.
  const nodeIdCode = readSrc('resolvers', 'node-id.ts')
    .split('\n')
    .map((line) => line.replace(/\/\/.*$/, ''))
    .join('\n');
  assert.doesNotMatch(
    nodeIdCode,
    /class\s+NodeIdResolver|fs\.existsSync|\$\{nodeType\}:\$\{filePath\}:\$\{shortName\}/,
    'resolvers/node-id.ts must be the DB-backed rewrite, not the vendored filesystem/synthetic-id implementation',
  );
  assert.match(
    nodeIdCode,
    /FROM\s+nodes\b/i,
    'resolvers/node-id.ts must query the codegraph nodes table (DB-backed, per task 003)',
  );

  // Excluded (GitNexus-coupled) files must NOT be vendored
  assert.equal(
    fs.existsSync(path.join(srcRoot, 'writer', 'lbug-writer.ts')),
    false,
    'lbug-writer.ts is GitNexus-specific (ladybugdb CSV/Cypher) — must be re-implemented against ' +
      'codegraph SQLite in task 002 (writer/sqlite-writer.ts), not vendored verbatim',
  );
  assert.equal(
    fs.existsSync(path.join(srcRoot, 'parsers', 'di-xml-mapper.ts')),
    false,
    'di-xml-mapper.ts hardcodes the old id scheme — re-implemented in task 003b, not vendored',
  );
  assert.equal(
    fs.existsSync(path.join(srcRoot, 'parsers', 'layout-xml-mapper.ts')),
    false,
    'layout-xml-mapper.ts hardcodes the old id scheme — re-implemented in task 003b, not vendored',
  );

  // Vendored parse-only files must not carry the mapper/writer/node-id coupling
  // (checked against actual import statements, not prose comments explaining
  // the exclusion).
  for (const file of ['parsers/events-xml.ts', 'parsers/webapi-xml.ts', 'parsers/routes-xml.ts']) {
    const content = readSrc(file);
    const importLines = content
      .split('\n')
      .filter((line) => /^\s*import\b/.test(line))
      .join('\n');
    assert.doesNotMatch(
      importLines,
      /lbug-writer|node-id/,
      `${file} must not import from writer/lbug-writer or resolvers/node-id (mapper coupling)`,
    );
  }

  // Functional check: the pure parse functions are exported and importable
  const diXml = await import('../augmenter/src/parsers/di-xml.ts');
  assert.equal(typeof diXml.parseSingleDiXml, 'function');
  assert.equal(typeof diXml.parseDiXml, 'function');

  const layoutXml = await import('../augmenter/src/parsers/layout-xml.ts');
  assert.equal(typeof layoutXml.parseSingleLayoutXml, 'function');
  assert.equal(typeof layoutXml.parseLayoutXml, 'function');

  const eventsXml = await import('../augmenter/src/parsers/events-xml.ts');
  assert.equal(typeof eventsXml.parseSingleEventsXml, 'function');
  assert.equal(typeof eventsXml.findEventsXmlFiles, 'function');
  assert.equal((eventsXml as Record<string, unknown>).parseAndMapEventsXml, undefined);

  const webapiXml = await import('../augmenter/src/parsers/webapi-xml.ts');
  assert.equal(typeof webapiXml.parseSingleWebapiXml, 'function');
  assert.equal(typeof webapiXml.findWebapiXmlFiles, 'function');
  assert.equal((webapiXml as Record<string, unknown>).parseAndMapWebapiXml, undefined);

  const routesXml = await import('../augmenter/src/parsers/routes-xml.ts');
  assert.equal(typeof routesXml.parseSingleRoutesXml, 'function');
  assert.equal(typeof routesXml.findRoutesXmlFiles, 'function');
  assert.equal((routesXml as Record<string, unknown>).parseAndMapRoutesXml, undefined);

  const psr4Map = await import('../augmenter/src/resolvers/psr4-map.ts');
  assert.equal(typeof psr4Map.parsePsr4Map, 'function');

  const templatePath = await import('../augmenter/src/resolvers/template-path.ts');
  assert.equal(typeof templatePath.TemplatePathResolver, 'function');
});
