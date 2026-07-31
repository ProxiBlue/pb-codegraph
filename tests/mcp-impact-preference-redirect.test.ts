import test from 'node:test';
import assert from 'node:assert/strict';
import { getImpact } from '../mcp/src/impact.ts';
import { buildIsolatedFixtureDb } from './helpers/isolated-fixture-db.ts';
import { injectMagentoEdges } from './helpers/inject-magento-edges.ts';

// Real node ids from the fixture (see tests/sqlite-writer.test.ts).
const CLASS_FOO_ID = 'class:8a4d752448b6fec30dc789fc478809fe';
const INTERFACE_FOO_ID = 'interface:2ea043a4b2a4886e40b3b0f999676e7b';

function injectPreference(dbPath: string): void {
  injectMagentoEdges(dbPath, {
    nodes: [],
    edges: [
      // preference_for: interface node -> concrete class node
      {
        sourceId: INTERFACE_FOO_ID,
        targetId: CLASS_FOO_ID,
        type: 'IMPLEMENTS',
        reason: 'magento:di:preference',
      },
    ],
  });
}

test('it follows preference redirection in both directions', { timeout: 120_000 }, () => {
  const fixture = buildIsolatedFixtureDb();
  try {
    injectPreference(fixture.dbPath);

    // From the interface -> the concrete class it's redirected to (outgoing).
    const fromInterface = getImpact(
      { fixture_repo: { db_path: fixture.dbPath } },
      { symbol: INTERFACE_FOO_ID, repo: 'fixture_repo', direction: 'dependencies' },
    );
    assert.equal(fromInterface.errors.length, 0);
    const interfaceRows = Object.values(fromInterface.results[0].results_by_depth).flat();
    const classRow = interfaceRows.find((r) => r.node.id === CLASS_FOO_ID);
    assert.ok(classRow, 'expected the concrete class reachable from the interface via preference_for');
    assert.deepEqual(classRow?.edge_kind_path, ['preference_for']);

    // From the class -> the interface it substitutes for (incoming).
    const fromClass = getImpact(
      { fixture_repo: { db_path: fixture.dbPath } },
      { symbol: CLASS_FOO_ID, repo: 'fixture_repo', direction: 'dependents' },
    );
    assert.equal(fromClass.errors.length, 0);
    const classRows = Object.values(fromClass.results[0].results_by_depth).flat();
    const interfaceRow = classRows.find((r) => r.node.id === INTERFACE_FOO_ID);
    assert.ok(interfaceRow, 'expected the interface reachable from the class via preference_for');
    assert.deepEqual(interfaceRow?.edge_kind_path, ['preference_for']);
  } finally {
    fixture.cleanup();
  }
});
