import test from 'node:test';
import assert from 'node:assert/strict';
import { runQuery } from '../mcp/src/query.ts';
import { buildIsolatedFixtureDb } from './helpers/isolated-fixture-db.ts';
import { injectMagentoEdges } from './helpers/inject-magento-edges.ts';

// Real node id from the fixture (see tests/sqlite-writer.test.ts).
const CLASS_FOO_ID = 'class:8a4d752448b6fec30dc789fc478809fe';
const EVENT_ID = 'magento:event:checkout_cart_save_after';

test('it returns observers of a named event via the observers_of_event query template', { timeout: 120_000 }, () => {
  const fixture = buildIsolatedFixtureDb();
  try {
    injectMagentoEdges(fixture.dbPath, {
      nodes: [{ id: EVENT_ID, kind: 'event', name: 'checkout_cart_save_after' }],
      edges: [
        {
          sourceId: EVENT_ID,
          targetId: CLASS_FOO_ID,
          type: 'CALLS',
          reason: 'magento:events:observer:checkout_cart_save_after',
          metadata: { event: 'checkout_cart_save_after', area: 'frontend' },
        },
      ],
    });

    const result = runQuery(
      { fixture_repo: { db_path: fixture.dbPath } },
      { template: 'observers_of_event', params: { event: 'checkout_cart_save_after' }, repo: 'fixture_repo' },
    );

    assert.equal(result.template, 'observers_of_event');
    assert.equal(result.errors.length, 0);
    assert.equal(result.results.length, 1);
    const [repoResult] = result.results;
    assert.equal(repoResult.repo, 'fixture_repo');

    const observerRow = repoResult.rows.find((r) => r.node.id === CLASS_FOO_ID);
    assert.ok(observerRow, 'expected the observer class as a row from the observers_of_event template');
    assert.equal(observerRow?.edge_kind, 'observes');
    assert.equal(observerRow?.metadata?.event, 'checkout_cart_save_after');
  } finally {
    fixture.cleanup();
  }
});
