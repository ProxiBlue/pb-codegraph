import test from 'node:test';
import assert from 'node:assert/strict';
import { getContext } from '../mcp/src/context.ts';
import { buildIsolatedFixtureDb } from './helpers/isolated-fixture-db.ts';
import { injectMagentoEdges } from './helpers/inject-magento-edges.ts';

// Real node ids from the fixture (see tests/sqlite-writer.test.ts).
const CLASS_FOO_ID = 'class:8a4d752448b6fec30dc789fc478809fe';
const FOO_PLUGIN_CLASS_ID = 'class:a120baa1ff63d157886f598a63e014fd';

test(
  'it surfaces plugin sortorder and observer event metadata in context output',
  { timeout: 120_000 },
  () => {
    const fixture = buildIsolatedFixtureDb();
    try {
      injectMagentoEdges(fixture.dbPath, {
        nodes: [{ id: 'magento:event:checkout_cart_save_after', kind: 'event', name: 'checkout_cart_save_after' }],
        edges: [
          {
            sourceId: CLASS_FOO_ID,
            targetId: FOO_PLUGIN_CLASS_ID,
            type: 'WRAPS',
            reason: 'magento:di:plugin',
            metadata: { sortOrder: 10, area: 'global' },
          },
          {
            sourceId: 'magento:event:checkout_cart_save_after',
            targetId: CLASS_FOO_ID,
            type: 'CALLS',
            reason: 'magento:events:observer:checkout_cart_save_after',
            metadata: { event: 'checkout_cart_save_after', area: 'frontend' },
          },
        ],
      });

      const result = getContext(
        { fixture_repo: { db_path: fixture.dbPath } },
        { symbol: CLASS_FOO_ID, repo: 'fixture_repo' },
      );

      assert.equal(result.errors.length, 0);
      const [ctx] = result.results;

      const wrapsEdge = ctx.neighbors['wraps']?.[0];
      assert.ok(wrapsEdge, 'expected a wraps edge');
      assert.ok(wrapsEdge?.metadata, 'expected parsed metadata on the wraps edge (not a raw JSON string)');
      assert.equal(wrapsEdge?.metadata?.sortOrder, 10);
      assert.equal(wrapsEdge?.metadata?.area, 'global');
      assert.equal(wrapsEdge?.metadata?.reason, 'magento:di:plugin');

      const observesEdge = ctx.neighbors['observes']?.[0];
      assert.ok(observesEdge, 'expected an observes edge');
      assert.equal(observesEdge?.metadata?.event, 'checkout_cart_save_after');
      assert.equal(observesEdge?.metadata?.area, 'frontend');
    } finally {
      fixture.cleanup();
    }
  },
);
