import test from 'node:test';
import assert from 'node:assert/strict';
import { getContext } from '../mcp/src/context.ts';
import { buildIsolatedFixtureDb } from './helpers/isolated-fixture-db.ts';
import { injectMagentoEdges } from './helpers/inject-magento-edges.ts';

// Real node ids from the fixture (see tests/sqlite-writer.test.ts).
const CLASS_FOO_ID = 'class:8a4d752448b6fec30dc789fc478809fe';
const INTERFACE_FOO_ID = 'interface:2ea043a4b2a4886e40b3b0f999676e7b';
const FOO_PLUGIN_CLASS_ID = 'class:a120baa1ff63d157886f598a63e014fd';

function injectAllMagentoKindsAround(dbPath: string): void {
  injectMagentoEdges(dbPath, {
    nodes: [
      { id: 'magento:event:checkout_cart_save_after', kind: 'event', name: 'checkout_cart_save_after' },
      { id: 'magento:template:frontend:Acme_ModuleB::foo.phtml', kind: 'template', name: 'foo.phtml' },
      { id: 'magento:route:webapi:/V1/moduleb/foo', kind: 'route', name: '/V1/moduleb/foo' },
    ],
    edges: [
      // preference_for: interface node -> concrete class node
      {
        sourceId: INTERFACE_FOO_ID,
        targetId: CLASS_FOO_ID,
        type: 'IMPLEMENTS',
        reason: 'magento:di:preference',
      },
      // wraps: target class node -> plugin class node
      {
        sourceId: CLASS_FOO_ID,
        targetId: FOO_PLUGIN_CLASS_ID,
        type: 'WRAPS',
        reason: 'magento:di:plugin',
        metadata: { sortOrder: 10, area: 'global' },
      },
      // observes: minted event node -> observer class node
      {
        sourceId: 'magento:event:checkout_cart_save_after',
        targetId: CLASS_FOO_ID,
        type: 'CALLS',
        reason: 'magento:events:observer:checkout_cart_save_after',
        metadata: { event: 'checkout_cart_save_after', area: 'frontend' },
      },
      // renders: block class node -> minted template node
      {
        sourceId: CLASS_FOO_ID,
        targetId: 'magento:template:frontend:Acme_ModuleB::foo.phtml',
        type: 'CALLS',
        reason: 'magento:layout:block-template',
        metadata: { area: 'frontend' },
      },
      // references: service class node -> minted route node
      {
        sourceId: CLASS_FOO_ID,
        targetId: 'magento:route:webapi:/V1/moduleb/foo',
        type: 'HANDLES_ROUTE',
        reason: 'magento:webapi:route',
        metadata: { area: 'webapi' },
      },
    ],
  });
}

test(
  'it returns context neighbors grouped by edge kind including magento kinds (preference_for, wraps, observes, renders, references)',
  { timeout: 120_000 },
  () => {
    const fixture = buildIsolatedFixtureDb();
    try {
      injectAllMagentoKindsAround(fixture.dbPath);

      const result = getContext(
        { fixture_repo: { db_path: fixture.dbPath } },
        { symbol: 'class:8a4d752448b6fec30dc789fc478809fe', repo: 'fixture_repo' },
      );

      assert.equal(result.errors.length, 0);
      assert.equal(result.results.length, 1);
      const [ctx] = result.results;
      assert.equal(ctx.node.id, CLASS_FOO_ID);
      assert.equal(ctx.repo, 'fixture_repo');

      for (const kind of ['preference_for', 'wraps', 'observes', 'renders', 'references']) {
        assert.ok(ctx.neighbors[kind], `expected a "${kind}" group in neighbors`);
        assert.ok(ctx.neighbors[kind].length > 0, `expected at least one "${kind}" edge`);
      }

      const preferenceEdge = ctx.neighbors['preference_for'][0];
      assert.equal(preferenceEdge.direction, 'incoming');
      assert.equal(preferenceEdge.node.id, INTERFACE_FOO_ID);

      const wrapsEdge = ctx.neighbors['wraps'][0];
      assert.equal(wrapsEdge.direction, 'outgoing');
      assert.equal(wrapsEdge.node.id, FOO_PLUGIN_CLASS_ID);
    } finally {
      fixture.cleanup();
    }
  },
);
