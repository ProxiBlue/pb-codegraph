import test from 'node:test';
import assert from 'node:assert/strict';
import { findSymbol } from '../mcp/src/find-symbol.ts';
import { buildIsolatedFixtureDb } from './helpers/isolated-fixture-db.ts';
import { injectMagentoEdges } from './helpers/inject-magento-edges.ts';

// Real node id from the fixture (see tests/sqlite-writer.test.ts CLASS_FOO_ID).
const CLASS_FOO_ID = 'class:8a4d752448b6fec30dc789fc478809fe';

test(
  'it finds a minted route or event node via fts (validates 002 fts maintenance)',
  { timeout: 120_000 },
  () => {
    const fixture = buildIsolatedFixtureDb();
    try {
      injectMagentoEdges(fixture.dbPath, {
        nodes: [
          { id: 'magento:event:checkout_cart_save_after', kind: 'event', name: 'checkout_cart_save_after' },
          { id: 'magento:route:webapi:/V1/moduleb/foo', kind: 'route', name: '/V1/moduleb/foo' },
        ],
        edges: [
          {
            sourceId: 'magento:event:checkout_cart_save_after',
            targetId: CLASS_FOO_ID,
            type: 'CALLS',
            reason: 'magento:events:observer:checkout_cart_save_after',
            metadata: { event: 'checkout_cart_save_after', area: 'frontend' },
          },
          {
            sourceId: CLASS_FOO_ID,
            targetId: 'magento:route:webapi:/V1/moduleb/foo',
            type: 'HANDLES_ROUTE',
            reason: 'magento:webapi:route',
            metadata: { area: 'webapi' },
          },
        ],
      });

      // Partial term -> served by the FTS path (not an exact name/qualified_name match).
      const eventResult = findSymbol(
        { fixture_repo: { db_path: fixture.dbPath } },
        { query: 'checkout_cart', repo: 'fixture_repo' },
      );
      assert.equal(eventResult.errors.length, 0);
      const eventMatch = eventResult.results.find((r) => r.id === 'magento:event:checkout_cart_save_after');
      assert.ok(eventMatch, 'expected the minted event node to be findable via fts');
      assert.equal(eventMatch?.match_type, 'fts');
      assert.equal(eventMatch?.kind, 'event');

      const routeResult = findSymbol(
        { fixture_repo: { db_path: fixture.dbPath } },
        { query: 'moduleb', repo: 'fixture_repo' },
      );
      assert.equal(routeResult.errors.length, 0);
      const routeMatch = routeResult.results.find((r) => r.id === 'magento:route:webapi:/V1/moduleb/foo');
      assert.ok(routeMatch, 'expected the minted route node to be findable via fts');
      assert.equal(routeMatch?.kind, 'route');
    } finally {
      fixture.cleanup();
    }
  },
);
