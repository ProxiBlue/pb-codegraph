import test from 'node:test';
import assert from 'node:assert/strict';
import { getImpact } from '../mcp/src/impact.ts';
import { buildIsolatedFixtureDb } from './helpers/isolated-fixture-db.ts';
import { injectMagentoEdges } from './helpers/inject-magento-edges.ts';

// Real node ids from the fixture (see tests/sqlite-writer.test.ts).
const CLASS_FOO_ID = 'class:8a4d752448b6fec30dc789fc478809fe';
const EVENT_ID = 'magento:event:checkout_cart_save_after';

// C4 (see _devils_advocate.md): codegraph does not index the string arg of
// $eventManager->dispatch('x'), so there is no graph edge from a
// dispatching PHP method to the event it dispatches. Observer traversal is
// therefore only reachable STARTING FROM the minted event node itself, via
// the `observes` edge (event node -> observer class).
test('it returns observers via impact/context starting from an event node', { timeout: 120_000 }, () => {
  const fixture = buildIsolatedFixtureDb();
  try {
    injectMagentoEdges(fixture.dbPath, {
      nodes: [{ id: EVENT_ID, kind: 'event', name: 'checkout_cart_save_after' }],
      edges: [
        // observes: minted event node -> observer class node
        {
          sourceId: EVENT_ID,
          targetId: CLASS_FOO_ID,
          type: 'CALLS',
          reason: 'magento:events:observer:checkout_cart_save_after',
          metadata: { event: 'checkout_cart_save_after', area: 'frontend' },
        },
      ],
    });

    const result = getImpact({ fixture_repo: { db_path: fixture.dbPath } }, { symbol: EVENT_ID, repo: 'fixture_repo' });

    assert.equal(result.errors.length, 0);
    assert.equal(result.results.length, 1);
    const [repoResult] = result.results;
    assert.equal(repoResult.node.id, EVENT_ID);
    assert.equal(repoResult.node.kind, 'event');

    const allRows = Object.values(repoResult.results_by_depth).flat();
    const observerRow = allRows.find((r) => r.node.id === CLASS_FOO_ID);
    assert.ok(observerRow, 'expected the observer class to appear in impact results starting from the event node');
    assert.deepEqual(observerRow?.edge_kind_path, ['observes']);
    assert.equal(observerRow?.metadata?.event, 'checkout_cart_save_after');
  } finally {
    fixture.cleanup();
  }
});
