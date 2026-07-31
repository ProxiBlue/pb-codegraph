import test from 'node:test';
import assert from 'node:assert/strict';
import { getImpact } from '../mcp/src/impact.ts';
import { buildIsolatedFixtureDb } from './helpers/isolated-fixture-db.ts';
import { injectMagentoEdges } from './helpers/inject-magento-edges.ts';

// Real node ids from the fixture (see tests/sqlite-writer.test.ts).
const CLASS_FOO_ID = 'class:8a4d752448b6fec30dc789fc478809fe';
const FOO_PLUGIN_CLASS_ID = 'class:a120baa1ff63d157886f598a63e014fd';

test('it returns the wrapping plugin in impact of a plugin target method', { timeout: 120_000 }, () => {
  const fixture = buildIsolatedFixtureDb();
  try {
    injectMagentoEdges(fixture.dbPath, {
      nodes: [],
      edges: [
        // wraps: target class node -> plugin class node (see docs/edge-taxonomy.md)
        {
          sourceId: CLASS_FOO_ID,
          targetId: FOO_PLUGIN_CLASS_ID,
          type: 'WRAPS',
          reason: 'magento:di:plugin',
          metadata: { sortOrder: 10, area: 'global' },
        },
      ],
    });

    const result = getImpact(
      { fixture_repo: { db_path: fixture.dbPath } },
      { symbol: CLASS_FOO_ID, repo: 'fixture_repo' },
    );

    assert.equal(result.errors.length, 0);
    assert.equal(result.results.length, 1);
    const [repoResult] = result.results;
    assert.equal(repoResult.node.id, CLASS_FOO_ID);

    const allRows = Object.values(repoResult.results_by_depth).flat();
    const pluginRow = allRows.find((r) => r.node.id === FOO_PLUGIN_CLASS_ID);
    assert.ok(pluginRow, 'expected the wrapping plugin class to appear in impact results');
    assert.deepEqual(pluginRow?.edge_kind_path, ['wraps']);
    assert.equal(pluginRow?.depth, 1);
  } finally {
    fixture.cleanup();
  }
});
