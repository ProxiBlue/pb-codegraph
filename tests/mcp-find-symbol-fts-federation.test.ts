import test from 'node:test';
import assert from 'node:assert/strict';
import { findSymbol } from '../mcp/src/find-symbol.ts';
import { buildIsolatedFixtureDb } from './helpers/isolated-fixture-db.ts';

test('it finds symbols by partial name via fts across all repos when repo omitted', { timeout: 120_000 }, () => {
  const fixture = buildIsolatedFixtureDb();
  try {
    // Two registry entries pointing at the same isolated fixture db, under
    // different repo names, so federation (repo omitted) has more than one
    // db to merge results from and tag correctly.
    const registry = {
      repo_one: { db_path: fixture.dbPath, description: 'repo one' },
      repo_two: { db_path: fixture.dbPath, description: 'repo two' },
    };

    // "Fo" is a prefix of Foo/FooInterface/FooPlugin but not an exact match
    // for any name/qualified_name, so this must be served entirely by the
    // FTS path, not the exact-match path.
    const result = findSymbol(registry, { query: 'Fo' });

    assert.equal(result.errors.length, 0);
    assert.ok(result.results.length > 0, 'expected fts partial matches');
    assert.ok(
      result.results.every((r) => r.match_type === 'fts'),
      'a non-exact query must only produce fts matches',
    );

    const repoNames = new Set(result.results.map((r) => r.repo));
    assert.ok(repoNames.has('repo_one') && repoNames.has('repo_two'), 'results must be tagged with both repos');

    const names = result.results.map((r) => r.name);
    assert.ok(names.includes('Foo'), 'expected the Foo class among partial matches');
  } finally {
    fixture.cleanup();
  }
});
