import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { openWriterDb, writeAugmentation, PROVENANCE } from '../augmenter/src/writer/sqlite-writer.ts';
import { mapDiXmlEdges } from '../augmenter/src/mappers/di-xml-mapper.ts';
import { mapEventsXmlEdges } from '../augmenter/src/mappers/events-xml-mapper.ts';
import { mapLayoutXmlEdges } from '../augmenter/src/mappers/layout-xml-mapper.ts';
import { mapWebapiXmlEdges } from '../augmenter/src/mappers/webapi-xml-mapper.ts';
import { mapRoutesXmlEdges } from '../augmenter/src/mappers/routes-xml-mapper.ts';
import { buildIsolatedFixtureDb, type IsolatedFixtureDb } from './helpers/isolated-fixture-db.ts';

// Uses buildIsolatedFixtureDb (own temp dir + own PHP tree copy + own
// `codegraph init` run) rather than the shared tests/fixture/.codegraph/
// path — that path is destructively rebuilt by tests/build-fixture-db.test.ts
// and node --test runs files in parallel by default. Mirrors the pattern
// already used by tests/node-id-resolver.test.ts and tests/sqlite-writer.test.ts.
let fixture: IsolatedFixtureDb;

test.before(() => {
  fixture = buildIsolatedFixtureDb();
});

test.after(() => {
  fixture.cleanup();
});

let dbCounter = 0;
async function withFreshDbAsync<T>(fn: (db: Database.Database) => Promise<T>): Promise<T> {
  dbCounter += 1;
  const dbPath = path.join(fixture.dir, `mapper-scratch-${dbCounter}.db`);
  fs.copyFileSync(fixture.dbPath, dbPath);
  const db = openWriterDb(dbPath);
  try {
    return await fn(db);
  } finally {
    db.close();
  }
}

function qualifiedNameId(db: Database.Database, kind: string, qualifiedName: string): string {
  const row = db
    .prepare(`SELECT id FROM nodes WHERE kind = ? AND qualified_name = ?`)
    .get(kind, qualifiedName) as { id: string } | undefined;
  assert.ok(row, `expected a native ${kind} node for ${qualifiedName}`);
  return row!.id;
}

test('it emits preference_for edges between impl and interface class nodes', async () => {
  await withFreshDbAsync(async (db) => {
    const result = await mapDiXmlEdges(fixture.dir, db);
    writeAugmentation(db, { nodes: result.nodes, edges: result.edges });

    const implId = qualifiedNameId(db, 'class', 'Acme\\ModuleA\\Model::Foo');
    const interfaceId = qualifiedNameId(db, 'interface', 'Acme\\ModuleA\\Api::FooInterface');

    const rows = db
      .prepare(`SELECT source, target, provenance FROM edges WHERE kind = 'preference_for'`)
      .all() as Array<{ source: string; target: string; provenance: string }>;
    // ModuleA declares this preference at global; ModuleC's
    // etc/adminhtml/di.xml fixture (see the multi-area identity tests below)
    // deliberately duplicates the SAME for/type pair at adminhtml -- both
    // must survive as distinct rows (per-area edge identity), so 2 rows,
    // not 1.
    assert.equal(rows.length, 2);
    for (const row of rows) {
      assert.equal(row.source, implId, 'source must be the impl (concrete) class node');
      assert.equal(row.target, interfaceId, 'target must be the interface node it substitutes for');
      assert.equal(row.provenance, PROVENANCE);
    }
  });
});

test('it emits wraps edges carrying sortOrder and area metadata', async () => {
  await withFreshDbAsync(async (db) => {
    const result = await mapDiXmlEdges(fixture.dir, db);
    writeAugmentation(db, { nodes: result.nodes, edges: result.edges });

    const pluginId = qualifiedNameId(db, 'class', 'Acme\\ModuleA\\Plugin::FooPlugin');
    const targetId = qualifiedNameId(db, 'class', 'Acme\\ModuleA\\Model::Foo');

    const rows = db
      .prepare(`SELECT source, target, metadata FROM edges WHERE kind = 'wraps' AND source = ? AND target = ?`)
      .all(pluginId, targetId) as Array<{ source: string; target: string; metadata: string }>;
    // ModuleA declares this pair at global (sortOrder=10); ModuleC's
    // etc/adminhtml/di.xml fixture (see the multi-area identity tests below)
    // deliberately duplicates the SAME pair at adminhtml (sortOrder=20) --
    // filter down to the global-area row this test is actually about.
    const globalRow = rows.find((r) => JSON.parse(r.metadata).area === 'global');
    assert.ok(globalRow, 'ModuleA di.xml plugin (sortOrder=10, global) must produce a wraps edge');
    const metadata = JSON.parse(globalRow!.metadata);
    assert.equal(metadata.sortOrder, 10);
    assert.equal(metadata.area, 'global');
    assert.equal(metadata.reason, 'magento:di:plugin');
  });
});

test('it emits observes edges from a minted event node to the observer class node with event metadata', async () => {
  await withFreshDbAsync(async (db) => {
    const result = await mapEventsXmlEdges(fixture.dir, db);
    writeAugmentation(db, { nodes: result.nodes, edges: result.edges });

    const observerId = qualifiedNameId(db, 'class', 'Acme\\ModuleA\\Model::Foo');

    const row = db
      .prepare(`SELECT source, target, metadata FROM edges WHERE kind = 'observes' AND target = ?`)
      .get(observerId) as { source: string; target: string; metadata: string } | undefined;
    assert.ok(row, 'expected an observes edge targeting the Foo class node');
    assert.equal(row!.source, 'magento:event:controller_action_predispatch');

    const eventNode = db.prepare(`SELECT kind, name FROM nodes WHERE id = ?`).get(row!.source) as
      | { kind: string; name: string }
      | undefined;
    assert.ok(eventNode, 'minted event node must be inserted');
    assert.equal(eventNode!.kind, 'event');

    const metadata = JSON.parse(row!.metadata);
    assert.equal(metadata.event, 'controller_action_predispatch');
    assert.equal(metadata.area, 'frontend');
    assert.equal(metadata.reason, 'magento:events:observer:controller_action_predispatch');
  });
});

test('it emits renders edges from a block class node to a minted template node', async () => {
  await withFreshDbAsync(async (db) => {
    const result = await mapLayoutXmlEdges(fixture.dir, db);
    writeAugmentation(db, { nodes: result.nodes, edges: result.edges });

    const blockClassId = qualifiedNameId(db, 'class', 'Acme\\ModuleA\\Model::Foo');
    const templateId = 'magento:template:frontend:Acme_ModuleB::foo.phtml';

    const row = db
      .prepare(`SELECT source, target, metadata FROM edges WHERE kind = 'renders' AND source = ?`)
      .get(blockClassId) as { source: string; target: string; metadata: string } | undefined;
    assert.ok(row, 'expected a renders edge sourced from the block class node');
    assert.equal(row!.target, templateId);

    const templateNode = db.prepare(`SELECT kind, name FROM nodes WHERE id = ?`).get(templateId) as
      | { kind: string; name: string }
      | undefined;
    assert.ok(templateNode, 'minted template node must be inserted');
    assert.equal(templateNode!.kind, 'template');

    const metadata = JSON.parse(row!.metadata);
    assert.equal(metadata.templateRef, 'Acme_ModuleB::foo.phtml');
    assert.equal(metadata.area, 'frontend');
    assert.equal(metadata.reason, 'magento:layout:block-template');
  });
});

test('it emits references edges between a minted route node and the resolved controller/service class node', async () => {
  await withFreshDbAsync(async (db) => {
    const result = await mapWebapiXmlEdges(fixture.dir, db);
    writeAugmentation(db, { nodes: result.nodes, edges: result.edges });

    const serviceMethodId = qualifiedNameId(db, 'method', 'Acme\\ModuleA\\Model::Foo::getFoo');
    const routeId = 'magento:route:webapi:/V1/moduleb/foo';

    const row = db
      .prepare(`SELECT source, target, metadata FROM edges WHERE kind = 'references' AND target = ?`)
      .get(routeId) as { source: string; target: string; metadata: string } | undefined;
    assert.ok(row, 'expected a references edge targeting the minted webapi route node');
    assert.equal(row!.source, serviceMethodId, 'source must be the resolved service method node');

    const routeNode = db.prepare(`SELECT kind, name FROM nodes WHERE id = ?`).get(routeId) as
      | { kind: string; name: string }
      | undefined;
    assert.ok(routeNode, 'minted route node must be inserted');
    assert.equal(routeNode!.kind, 'route');

    const metadata = JSON.parse(row!.metadata);
    assert.equal(metadata.reason, 'magento:webapi:route');
  });
});

test('it routes unresolved targets through the resolver\'s external minting so no edge dangles', async () => {
  await withFreshDbAsync(async (db) => {
    const result = await mapDiXmlEdges(fixture.dir, db);
    writeAugmentation(db, { nodes: result.nodes, edges: result.edges });

    // ModuleB/etc/di.xml plugs Magento\Catalog\Model\Product (no PHP file in
    // this fixture tree) with Acme\ModuleA\Plugin\FooPlugin (resolvable).
    const externalId = 'magento:external:Magento\\Catalog\\Model\\Product';
    const pluginId = qualifiedNameId(db, 'class', 'Acme\\ModuleA\\Plugin::FooPlugin');

    const externalNode = db.prepare(`SELECT kind, qualified_name FROM nodes WHERE id = ?`).get(externalId) as
      | { kind: string; qualified_name: string }
      | undefined;
    assert.ok(externalNode, 'unresolved di.xml target must mint an external node so the edge never dangles');
    assert.equal(externalNode!.kind, 'external');

    const row = db
      .prepare(`SELECT source, target FROM edges WHERE kind = 'wraps' AND target = ?`)
      .get(externalId) as { source: string; target: string } | undefined;
    assert.ok(row, 'expected a wraps edge whose target is the minted external node');
    assert.equal(row!.source, pluginId);

    assert.ok(result.stats.externallyMinted.includes('Magento\\Catalog\\Model\\Product'));
  });
});

test('it gives wraps edges a stable per-area identity so multi-area same-plugin registration produces per-area edges (not a single collapsed row)', async () => {
  await withFreshDbAsync(async (db) => {
    const result = await mapDiXmlEdges(fixture.dir, db);
    writeAugmentation(db, { nodes: result.nodes, edges: result.edges });

    const pluginId = qualifiedNameId(db, 'class', 'Acme\\ModuleA\\Plugin::FooPlugin');
    const targetId = qualifiedNameId(db, 'class', 'Acme\\ModuleA\\Model::Foo');

    // ModuleA/etc/di.xml (global, sortOrder=10) and ModuleC/etc/adminhtml/di.xml
    // (adminhtml, sortOrder=20) both wrap the SAME plugin+target pair -- before
    // the area-ordinal fix these collapsed to a single row on codegraph's
    // (source, target, kind, line, col) unique index (both areas had line=null).
    const rows = db
      .prepare(`SELECT metadata, line FROM edges WHERE kind = 'wraps' AND source = ? AND target = ?`)
      .all(pluginId, targetId) as Array<{ metadata: string; line: number | null }>;
    assert.equal(rows.length, 2, 'both areas\' wraps registrations must survive as distinct edges');

    const byArea = new Map(rows.map((r) => [JSON.parse(r.metadata).area as string, r]));
    assert.ok(byArea.has('global'));
    assert.ok(byArea.has('adminhtml'));
    assert.equal(JSON.parse(byArea.get('global')!.metadata).sortOrder, 10);
    assert.equal(JSON.parse(byArea.get('adminhtml')!.metadata).sortOrder, 20);
    assert.notEqual(byArea.get('global')!.line, byArea.get('adminhtml')!.line, 'each area must carry a distinct identity ordinal');
  });
});

test('it gives preference_for edges a stable per-area identity so multi-area same-preference registration produces per-area edges', async () => {
  await withFreshDbAsync(async (db) => {
    const result = await mapDiXmlEdges(fixture.dir, db);
    writeAugmentation(db, { nodes: result.nodes, edges: result.edges });

    const implId = qualifiedNameId(db, 'class', 'Acme\\ModuleA\\Model::Foo');
    const interfaceId = qualifiedNameId(db, 'interface', 'Acme\\ModuleA\\Api::FooInterface');

    // ModuleA/etc/di.xml (global) and ModuleC/etc/adminhtml/di.xml (adminhtml)
    // both declare the SAME preference for/type pair.
    const rows = db
      .prepare(`SELECT metadata, line FROM edges WHERE kind = 'preference_for' AND source = ? AND target = ?`)
      .all(implId, interfaceId) as Array<{ metadata: string; line: number | null }>;
    assert.equal(rows.length, 2, 'both areas\' preference registrations must survive as distinct edges');

    const areas = rows.map((r) => JSON.parse(r.metadata).area as string).sort();
    assert.deepEqual(areas, ['adminhtml', 'global']);
    assert.notEqual(rows[0].line, rows[1].line, 'each area must carry a distinct identity ordinal');
  });
});

test('it gives observes edges a stable per-area identity so multi-area same-observer registration produces per-area edges', async () => {
  await withFreshDbAsync(async (db) => {
    const result = await mapEventsXmlEdges(fixture.dir, db);
    writeAugmentation(db, { nodes: result.nodes, edges: result.edges });

    const observerId = qualifiedNameId(db, 'class', 'Acme\\ModuleA\\Plugin::FooPlugin');
    const eventId = 'magento:event:checkout_cart_save_after';

    // ModuleB/etc/frontend/events.xml (frontend) and
    // ModuleC/etc/adminhtml/events.xml (adminhtml) both register FooPlugin as
    // an observer of the SAME event.
    const rows = db
      .prepare(`SELECT metadata, line FROM edges WHERE kind = 'observes' AND source = ? AND target = ?`)
      .all(eventId, observerId) as Array<{ metadata: string; line: number | null }>;
    assert.equal(rows.length, 2, 'both areas\' observer registrations must survive as distinct edges');

    const areas = rows.map((r) => JSON.parse(r.metadata).area as string).sort();
    assert.deepEqual(areas, ['adminhtml', 'frontend']);
    assert.notEqual(rows[0].line, rows[1].line, 'each area must carry a distinct identity ordinal');
  });
});

test('it preserves per-family resolved/skipped stats for the cli summary', async () => {
  await withFreshDbAsync(async (db) => {
    const di = await mapDiXmlEdges(fixture.dir, db);
    assert.equal(di.stats.preferencesResolved, 2, 'ModuleA global preference + ModuleC adminhtml multi-area duplicate');
    assert.equal(
      di.stats.pluginsResolved,
      3,
      'ModuleA plugin + ModuleB unresolved-target plugin + ModuleC adminhtml multi-area duplicate',
    );

    const events = await mapEventsXmlEdges(fixture.dir, db);
    assert.equal(events.stats.resolved, 3, 'ModuleB\'s 2 frontend observers + ModuleC\'s adminhtml multi-area duplicate');
    assert.equal(events.stats.skippedDisabled, 0);

    const layout = await mapLayoutXmlEdges(fixture.dir, db);
    assert.equal(layout.stats.resolved, 1);

    const webapi = await mapWebapiXmlEdges(fixture.dir, db);
    assert.equal(webapi.stats.resolved, 1);

    const routes = await mapRoutesXmlEdges(fixture.dir);
    assert.equal(routes.stats.routesMinted, 1);
  });
});
