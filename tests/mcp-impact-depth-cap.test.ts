import test from 'node:test';
import assert from 'node:assert/strict';
import { getImpact, IMPACT_MAX_DEPTH } from '../mcp/src/impact.ts';
import { buildIsolatedFixtureDb } from './helpers/isolated-fixture-db.ts';
import { injectMagentoEdges } from './helpers/inject-magento-edges.ts';

// Real node id from the fixture (see tests/sqlite-writer.test.ts).
const CLASS_FOO_ID = 'class:8a4d752448b6fec30dc789fc478809fe';

function chainNode(n: number): string {
  return `magento:event:chain_${n}`;
}

test('it caps depth and annotates each result with its edge path', { timeout: 120_000 }, () => {
  const fixture = buildIsolatedFixtureDb();
  try {
    // Chain 6 hops deep (past IMPACT_MAX_DEPTH=4), plus a back-edge from
    // depth-3 straight to the already-visited start node (cycle guard).
    injectMagentoEdges(fixture.dbPath, {
      nodes: [1, 2, 3, 4, 5, 6].map((n) => ({ id: chainNode(n), kind: 'event' as const, name: `chain_${n}` })),
      edges: [
        { sourceId: CLASS_FOO_ID, targetId: chainNode(1), type: 'CALLS', reason: 'magento:events:observer:chain' },
        { sourceId: chainNode(1), targetId: chainNode(2), type: 'CALLS', reason: 'magento:events:observer:chain' },
        { sourceId: chainNode(2), targetId: chainNode(3), type: 'CALLS', reason: 'magento:events:observer:chain' },
        { sourceId: chainNode(3), targetId: chainNode(4), type: 'CALLS', reason: 'magento:events:observer:chain' },
        { sourceId: chainNode(4), targetId: chainNode(5), type: 'CALLS', reason: 'magento:events:observer:chain' },
        { sourceId: chainNode(5), targetId: chainNode(6), type: 'CALLS', reason: 'magento:events:observer:chain' },
        // cycle: depth-3 node points straight back to the start node.
        { sourceId: chainNode(3), targetId: CLASS_FOO_ID, type: 'CALLS', reason: 'magento:events:observer:chain' },
      ],
    });

    const result = getImpact(
      { fixture_repo: { db_path: fixture.dbPath } },
      { symbol: CLASS_FOO_ID, repo: 'fixture_repo', direction: 'dependencies' },
    );

    assert.equal(result.errors.length, 0);
    assert.equal(result.depth, IMPACT_MAX_DEPTH);
    const [repoResult] = result.results;
    const allRows = Object.values(repoResult.results_by_depth).flat();

    // depth 1..4 present, edge_kind_path length equals depth at every row.
    for (const row of allRows) {
      assert.equal(row.edge_kind_path.length, row.depth, `edge_kind_path length must equal depth for ${row.node.id}`);
    }
    assert.ok(allRows.some((r) => r.node.id === chainNode(4) && r.depth === 4));

    // depth 5/6 must NOT appear — cut off by the depth cap.
    assert.ok(!allRows.some((r) => r.node.id === chainNode(5)));
    assert.ok(!allRows.some((r) => r.node.id === chainNode(6)));

    // cycle guard: the back-edge to the already-visited start node must not
    // produce a row for the start node itself (no revisit, no infinite loop
    // — this test completing at all is part of the proof).
    assert.ok(!allRows.some((r) => r.node.id === CLASS_FOO_ID));

    // depth cap was hit mid-graph (chain_4 still has an outgoing edge to
    // chain_5) — must be flagged loudly, not silently dropped.
    assert.equal(repoResult.depth_capped, true);
  } finally {
    fixture.cleanup();
  }
});
