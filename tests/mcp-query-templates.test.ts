import test from 'node:test';
import assert from 'node:assert/strict';
import { runQuery, QUERY_TEMPLATE_NAMES } from '../mcp/src/query.ts';
import { buildIsolatedFixtureDb } from './helpers/isolated-fixture-db.ts';
import { injectMagentoEdges } from './helpers/inject-magento-edges.ts';

// Real node ids from the fixture (see tests/sqlite-writer.test.ts).
const CLASS_FOO_ID = 'class:8a4d752448b6fec30dc789fc478809fe';
const INTERFACE_FOO_ID = 'interface:2ea043a4b2a4886e40b3b0f999676e7b';
const FOO_PLUGIN_CLASS_ID = 'class:a120baa1ff63d157886f598a63e014fd';
// FooPlugin::afterGetFoo -- native `references` edge -> class Foo (see
// tests/sqlite-writer.test.ts / the raw fixture edge dump).
const METHOD_AFTER_GETFOO_ID = 'method:a283c55e990ed47354879a0cf8a0e486';
const EVENT_ID = 'magento:event:checkout_cart_save_after';
const ROUTE_ID = 'magento:route:webapi:/V1/moduleb/foo';

function seedFixture(dbPath: string): void {
  injectMagentoEdges(dbPath, {
    nodes: [
      { id: EVENT_ID, kind: 'event', name: 'checkout_cart_save_after' },
      { id: ROUTE_ID, kind: 'route', name: '/V1/moduleb/foo' },
    ],
    edges: [
      {
        sourceId: INTERFACE_FOO_ID,
        targetId: CLASS_FOO_ID,
        type: 'IMPLEMENTS',
        reason: 'magento:di:preference',
      },
      {
        sourceId: CLASS_FOO_ID,
        targetId: FOO_PLUGIN_CLASS_ID,
        type: 'WRAPS',
        reason: 'magento:di:plugin',
        metadata: { sortOrder: 10, area: 'global' },
      },
      {
        sourceId: EVENT_ID,
        targetId: CLASS_FOO_ID,
        type: 'CALLS',
        reason: 'magento:events:observer:checkout_cart_save_after',
        metadata: { event: 'checkout_cart_save_after', area: 'frontend' },
      },
      {
        sourceId: CLASS_FOO_ID,
        targetId: ROUTE_ID,
        type: 'HANDLES_ROUTE',
        reason: 'magento:webapi:route',
        metadata: { area: 'webapi' },
      },
    ],
  });
}

test('it executes each documented query template against the fixture', { timeout: 120_000 }, () => {
  const fixture = buildIsolatedFixtureDb();
  try {
    seedFixture(fixture.dbPath);
    const registry = { fixture_repo: { db_path: fixture.dbPath } };

    // Sanity: the 6 templates named in the task are exactly what the module exports.
    assert.deepEqual(
      [...QUERY_TEMPLATE_NAMES].sort(),
      ['callers_of', 'dead_symbols', 'observers_of_event', 'preferences_for', 'routes_to', 'wired_plugins_on'].sort(),
    );

    const callers = runQuery(registry, { template: 'callers_of', params: { symbol: CLASS_FOO_ID }, repo: 'fixture_repo' });
    assert.equal(callers.errors.length, 0);
    assert.ok(
      callers.results[0].rows.some((r) => r.node.id === METHOD_AFTER_GETFOO_ID),
      'callers_of must find the native references edge from FooPlugin::afterGetFoo to Foo',
    );

    const wiredPlugins = runQuery(registry, {
      template: 'wired_plugins_on',
      params: { symbol: CLASS_FOO_ID },
      repo: 'fixture_repo',
    });
    assert.equal(wiredPlugins.errors.length, 0);
    assert.ok(wiredPlugins.results[0].rows.some((r) => r.node.id === FOO_PLUGIN_CLASS_ID));

    const observers = runQuery(registry, {
      template: 'observers_of_event',
      params: { event: 'checkout_cart_save_after' },
      repo: 'fixture_repo',
    });
    assert.equal(observers.errors.length, 0);
    assert.ok(observers.results[0].rows.some((r) => r.node.id === CLASS_FOO_ID));

    const routes = runQuery(registry, { template: 'routes_to', params: { route: '/V1/moduleb/foo' }, repo: 'fixture_repo' });
    assert.equal(routes.errors.length, 0);
    assert.ok(routes.results[0].rows.some((r) => r.node.id === CLASS_FOO_ID));

    const preferences = runQuery(registry, {
      template: 'preferences_for',
      params: { symbol: CLASS_FOO_ID },
      repo: 'fixture_repo',
    });
    assert.equal(preferences.errors.length, 0);
    assert.ok(preferences.results[0].rows.some((r) => r.node.id === INTERFACE_FOO_ID));

    const dead = runQuery(registry, { template: 'dead_symbols', params: {}, repo: 'fixture_repo' });
    assert.equal(dead.errors.length, 0);
    assert.ok(Array.isArray(dead.results[0].rows));
  } finally {
    fixture.cleanup();
  }
});
