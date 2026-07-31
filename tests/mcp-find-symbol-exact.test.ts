import test from 'node:test';
import assert from 'node:assert/strict';
import { findSymbol } from '../mcp/src/find-symbol.ts';
import { buildIsolatedFixtureDb } from './helpers/isolated-fixture-db.ts';

// Real node from the fixture (see tests/fixture app/code/Acme/ModuleA/Model/Foo.php,
// also used as CLASS_FOO_ID in tests/sqlite-writer.test.ts).
const FOO_QUALIFIED_NAME = 'Acme\\ModuleA\\Model::Foo';

test('it finds a class by exact qualified name in a named repo', { timeout: 120_000 }, () => {
  const fixture = buildIsolatedFixtureDb();
  try {
    const result = findSymbol(
      { fixture_repo: { db_path: fixture.dbPath, description: 'isolated fixture repo' } },
      { query: FOO_QUALIFIED_NAME, repo: 'fixture_repo' },
    );

    assert.equal(result.errors.length, 0);
    assert.ok(result.results.length >= 1, 'expected at least one exact match');

    const match = result.results[0];
    assert.equal(match.match_type, 'exact');
    assert.equal(match.repo, 'fixture_repo');
    assert.equal(match.kind, 'class');
    assert.equal(match.qualified_name, FOO_QUALIFIED_NAME);
    assert.equal(match.name, 'Foo');
    assert.equal(match.file_path, 'app/code/Acme/ModuleA/Model/Foo.php');
    assert.equal(typeof match.start_line, 'number');
    assert.equal(typeof match.end_line, 'number');
    assert.ok('signature' in match, 'signature field must be present (even if null)');
  } finally {
    fixture.cleanup();
  }
});
