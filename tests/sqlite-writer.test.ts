import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import {
  PROVENANCE,
  remapEdgeKind,
  openWriterDb,
  writeAugmentation,
  type AugmentEdge,
  type AugmentNode,
} from '../augmenter/src/writer/sqlite-writer.ts';
import { buildIsolatedFixtureDb, type IsolatedFixtureDb } from './helpers/isolated-fixture-db.ts';

// pb-codegraph: switched from reading tests/fixture/.codegraph/codegraph.db
// directly to buildIsolatedFixtureDb (own temp dir + own `codegraph init`
// run) — that shared path is destructively rebuilt (`rm -rf` + reinit) by
// tests/build-fixture-db.test.ts, and node --test runs files in parallel by
// default, so a direct read raced it (see task 003's node-id-resolver.test.ts,
// which hit the same race and adopted the same fix). Mirrors the pattern
// already used by every tests/mcp-*.test.ts file.
let fixture: IsolatedFixtureDb;

test.before(() => {
  fixture = buildIsolatedFixtureDb();
});

test.after(() => {
  fixture.cleanup();
});

let dbCounter = 0;
function withFreshDb<T>(fn: (db: Database.Database, dbPath: string) => T): T {
  dbCounter += 1;
  const dbPath = path.join(fixture.dir, `writer-scratch-${dbCounter}.db`);
  fs.copyFileSync(fixture.dbPath, dbPath);
  const db = openWriterDb(dbPath);
  try {
    return fn(db, dbPath);
  } finally {
    db.close();
  }
}

// Real node ids from the fixture (see tests/fixture app/code/Acme/...):
// class:8a4d... = Acme\ModuleA\Model\Foo, interface:2ea0... = FooInterface.
const CLASS_FOO_ID = 'class:8a4d752448b6fec30dc789fc478809fe';
const INTERFACE_FOO_ID = 'interface:2ea043a4b2a4886e40b3b0f999676e7b';
const METHOD_GETFOO_ID = 'method:e06c59f1a267d797bd5b5b76e65376d2';

test('it remaps vendored type+reason to the locked lowercase kinds so preference_for is distinct from native implements', () => {
  assert.equal(remapEdgeKind('IMPLEMENTS', 'magento:di:preference'), 'preference_for');

  withFreshDb((db) => {
    const nativeImplementsBefore = db
      .prepare(`SELECT COUNT(*) AS c FROM edges WHERE kind = 'implements'`)
      .get() as { c: number };
    assert.ok(nativeImplementsBefore.c > 0, 'fixture must already carry a native implements edge');

    const edges: AugmentEdge[] = [
      {
        sourceId: INTERFACE_FOO_ID,
        targetId: CLASS_FOO_ID,
        type: 'IMPLEMENTS',
        reason: 'magento:di:preference',
      },
    ];
    writeAugmentation(db, { nodes: [], edges });

    const nativeImplementsAfter = db
      .prepare(`SELECT COUNT(*) AS c FROM edges WHERE kind = 'implements'`)
      .get() as { c: number };
    assert.equal(nativeImplementsAfter.c, nativeImplementsBefore.c, 'native implements edges must be untouched');

    const preferenceRows = db
      .prepare(`SELECT source, target, provenance FROM edges WHERE kind = 'preference_for'`)
      .all() as Array<{ source: string; target: string; provenance: string }>;
    assert.equal(preferenceRows.length, 1);
    assert.equal(preferenceRows[0].source, INTERFACE_FOO_ID);
    assert.equal(preferenceRows[0].target, CLASS_FOO_ID);
    assert.equal(preferenceRows[0].provenance, PROVENANCE);
  });
});

test('it inserts edges with provenance and json metadata (reason, sortOrder, area, event) that survive readback', () => {
  withFreshDb((db) => {
    const edges: AugmentEdge[] = [
      {
        sourceId: CLASS_FOO_ID,
        targetId: METHOD_GETFOO_ID,
        type: 'WRAPS',
        reason: 'magento:di:plugin',
        metadata: { sortOrder: 10, area: 'global' },
      },
      {
        sourceId: METHOD_GETFOO_ID,
        targetId: CLASS_FOO_ID,
        type: 'CALLS',
        reason: 'magento:events:observer:checkout_cart_save_after',
        metadata: { event: 'checkout_cart_save_after', area: 'frontend' },
      },
    ];
    writeAugmentation(db, { nodes: [], edges });

    const wrapsRow = db
      .prepare(`SELECT metadata, provenance FROM edges WHERE kind = 'wraps'`)
      .get() as { metadata: string; provenance: string };
    assert.equal(wrapsRow.provenance, PROVENANCE);
    const wrapsMeta = JSON.parse(wrapsRow.metadata);
    assert.equal(wrapsMeta.reason, 'magento:di:plugin');
    assert.equal(wrapsMeta.sortOrder, 10);
    assert.equal(wrapsMeta.area, 'global');

    const observesRow = db
      .prepare(`SELECT metadata, provenance FROM edges WHERE kind = 'observes'`)
      .get() as { metadata: string; provenance: string };
    assert.equal(observesRow.provenance, PROVENANCE);
    const observesMeta = JSON.parse(observesRow.metadata);
    assert.equal(observesMeta.reason, 'magento:events:observer:checkout_cart_save_after');
    assert.equal(observesMeta.event, 'checkout_cart_save_after');
    assert.equal(observesMeta.area, 'frontend');
  });
});

test('it respects the unique edge identity index without erroring on duplicates', () => {
  withFreshDb((db) => {
    const duplicateEdge: AugmentEdge = {
      sourceId: CLASS_FOO_ID,
      targetId: METHOD_GETFOO_ID,
      type: 'WRAPS',
      reason: 'magento:di:plugin',
      metadata: { sortOrder: 10, area: 'global' },
    };

    assert.doesNotThrow(() => {
      writeAugmentation(db, { nodes: [], edges: [duplicateEdge, { ...duplicateEdge }] });
    });

    const wrapsRows = db.prepare(`SELECT COUNT(*) AS c FROM edges WHERE kind = 'wraps'`).get() as {
      c: number;
    };
    assert.equal(wrapsRows.c, 1, 'exact duplicate (same source/target/kind/line/col) must collapse to one row');
  });
});

test('it upserts minted event/route/template/external nodes without clobbering codegraph-owned nodes', () => {
  withFreshDb((db) => {
    const nativeBefore = db
      .prepare(`SELECT id, kind, name, qualified_name, file_path FROM nodes WHERE id = ?`)
      .get(CLASS_FOO_ID);
    assert.ok(nativeBefore, 'native class node must exist in fixture before write');

    const nodes: AugmentNode[] = [
      {
        id: 'magento:event:checkout_cart_save_after',
        kind: 'event',
        name: 'checkout_cart_save_after',
      },
      // Same id as an existing native node's *name*, but a distinct minted
      // id namespace — must never collide with or overwrite the native row.
      {
        id: 'magento:external:Magento\\Catalog\\Model\\Product',
        kind: 'external',
        name: 'Product',
        qualifiedName: 'Magento\\Catalog\\Model\\Product',
      },
    ];

    writeAugmentation(db, { nodes, edges: [] });

    const nativeAfter = db
      .prepare(`SELECT id, kind, name, qualified_name, file_path FROM nodes WHERE id = ?`)
      .get(CLASS_FOO_ID);
    assert.deepEqual(nativeAfter, nativeBefore, 'native node row must be byte-for-byte unchanged');

    const eventRow = db.prepare(`SELECT kind, name FROM nodes WHERE id = ?`).get(
      'magento:event:checkout_cart_save_after',
    ) as { kind: string; name: string };
    assert.equal(eventRow.kind, 'event');
    assert.equal(eventRow.name, 'checkout_cart_save_after');

    const externalRow = db
      .prepare(`SELECT kind, qualified_name FROM nodes WHERE id = ?`)
      .get('magento:external:Magento\\Catalog\\Model\\Product') as { kind: string; qualified_name: string };
    assert.equal(externalRow.kind, 'external');
    assert.equal(externalRow.qualified_name, 'Magento\\Catalog\\Model\\Product');
  });
});

test('it makes minted nodes searchable via nodes_fts (maintains fts whether or not a trigger exists)', () => {
  const mintedNode: AugmentNode = {
    id: 'magento:event:checkout_cart_save_after',
    kind: 'event',
    name: 'checkout_cart_save_after',
  };

  // Case 1: the real fixture DB — characterized up front to actually carry
  // AFTER INSERT/UPDATE/DELETE triggers that keep nodes_fts in sync (see
  // sqlite_master dump). The write must not error/duplicate against those.
  withFreshDb((db) => {
    const triggerCount = db
      .prepare(`SELECT COUNT(*) AS c FROM sqlite_master WHERE type = 'trigger' AND tbl_name = 'nodes'`)
      .get() as { c: number };
    assert.ok(triggerCount.c > 0, 'fixture db is expected to carry nodes_fts-maintaining triggers');

    writeAugmentation(db, { nodes: [mintedNode], edges: [] });

    const hit = db
      .prepare(`SELECT id FROM nodes_fts WHERE nodes_fts MATCH 'checkout_cart_save_after'`)
      .all() as Array<{ id: string }>;
    assert.ok(
      hit.some((r) => r.id === mintedNode.id),
      'minted event node must be findable via FTS when a trigger already maintains nodes_fts',
    );
  });

  // Case 2: same schema but with the AFTER INSERT trigger stripped, to
  // prove the writer maintains nodes_fts itself when no trigger does.
  withFreshDb((db) => {
    db.exec('DROP TRIGGER IF EXISTS nodes_ai');
    db.exec('DROP TRIGGER IF EXISTS nodes_au');
    db.exec('DROP TRIGGER IF EXISTS nodes_ad');
    const triggerCount = db
      .prepare(`SELECT COUNT(*) AS c FROM sqlite_master WHERE type = 'trigger' AND tbl_name = 'nodes'`)
      .get() as { c: number };
    assert.equal(triggerCount.c, 0, 'triggers must be gone for this branch of the test');

    writeAugmentation(db, { nodes: [mintedNode], edges: [] });

    const hit = db
      .prepare(`SELECT id FROM nodes_fts WHERE nodes_fts MATCH 'checkout_cart_save_after'`)
      .all() as Array<{ id: string }>;
    assert.ok(
      hit.some((r) => r.id === mintedNode.id),
      'minted event node must be findable via FTS even with no maintaining trigger present',
    );
  });
});

test('it deletes only own-provenance rows (edges and orphaned minted nodes) on idempotent re-run', () => {
  withFreshDb((db) => {
    const nodes: AugmentNode[] = [
      { id: 'magento:event:checkout_cart_save_after', kind: 'event', name: 'checkout_cart_save_after' },
    ];
    const edges: AugmentEdge[] = [
      {
        sourceId: 'magento:event:checkout_cart_save_after',
        targetId: CLASS_FOO_ID,
        type: 'CALLS',
        reason: 'magento:events:observer:checkout_cart_save_after',
        metadata: { event: 'checkout_cart_save_after', area: 'frontend' },
      },
    ];

    const first = writeAugmentation(db, { nodes, edges });
    assert.equal(first.nodesInserted, 1);
    assert.equal(first.edgesInserted, 1);

    const countsAfterFirst = {
      nodes: (db.prepare(`SELECT COUNT(*) AS c FROM nodes`).get() as { c: number }).c,
      edges: (db.prepare(`SELECT COUNT(*) AS c FROM edges`).get() as { c: number }).c,
    };

    // Idempotent re-run with the SAME input must delete its own prior rows
    // and reinsert an identical set — no duplication, no drift.
    const second = writeAugmentation(db, { nodes, edges });
    assert.equal(second.edgesDeleted, 1, 'must delete exactly the one own-provenance edge from the prior run');
    assert.equal(
      second.nodesDeleted,
      1,
      'must delete exactly the one minted node orphaned by that edge deletion',
    );
    assert.equal(second.nodesInserted, 1);
    assert.equal(second.edgesInserted, 1);

    const countsAfterSecond = {
      nodes: (db.prepare(`SELECT COUNT(*) AS c FROM nodes`).get() as { c: number }).c,
      edges: (db.prepare(`SELECT COUNT(*) AS c FROM edges`).get() as { c: number }).c,
    };
    assert.deepEqual(countsAfterSecond, countsAfterFirst, 'counts must be stable across a repeat run');
  });
});

test('it leaves node counts and codegraph native edges untouched across a full delete-reinsert cycle', () => {
  withFreshDb((db) => {
    const nativeNodeCountBefore = (
      db.prepare(`SELECT COUNT(*) AS c FROM nodes WHERE kind NOT IN ('event','route','template','external')`).get() as {
        c: number;
      }
    ).c;
    const nativeEdgeCountBefore = (
      db.prepare(`SELECT COUNT(*) AS c FROM edges WHERE provenance IS NULL`).get() as { c: number }
    ).c;
    assert.ok(nativeNodeCountBefore > 0);
    assert.ok(nativeEdgeCountBefore > 0);

    const nodes: AugmentNode[] = [
      { id: 'magento:route:webapi:/V1/moduleb/foo', kind: 'route', name: '/V1/moduleb/foo' },
    ];
    const edges: AugmentEdge[] = [
      {
        sourceId: CLASS_FOO_ID,
        targetId: 'magento:route:webapi:/V1/moduleb/foo',
        type: 'HANDLES_ROUTE',
        reason: 'magento:webapi:route',
        metadata: { area: 'webapi' },
      },
    ];

    // Run the full delete-reinsert cycle twice.
    writeAugmentation(db, { nodes, edges });
    writeAugmentation(db, { nodes, edges });

    const nativeNodeCountAfter = (
      db.prepare(`SELECT COUNT(*) AS c FROM nodes WHERE kind NOT IN ('event','route','template','external')`).get() as {
        c: number;
      }
    ).c;
    const nativeEdgeCountAfter = (
      db.prepare(`SELECT COUNT(*) AS c FROM edges WHERE provenance IS NULL`).get() as { c: number }
    ).c;

    assert.equal(nativeNodeCountAfter, nativeNodeCountBefore, 'native node count must be untouched');
    assert.equal(nativeEdgeCountAfter, nativeEdgeCountBefore, 'native (non-augmenter) edge count must be untouched');
  });
});

test('it sets busy_timeout and completes the delete+reinsert in a single transaction', () => {
  withFreshDb((db) => {
    const busyTimeout = db.pragma('busy_timeout') as Array<{ timeout: number }>;
    assert.equal(busyTimeout[0]?.timeout, 5000);

    const nodeCountBefore = (db.prepare(`SELECT COUNT(*) AS c FROM nodes`).get() as { c: number }).c;

    const nodes: AugmentNode[] = [
      { id: 'magento:event:will_not_persist', kind: 'event', name: 'will_not_persist' },
    ];
    const edges: AugmentEdge[] = [
      {
        sourceId: 'magento:event:will_not_persist',
        targetId: CLASS_FOO_ID,
        // Unknown type/reason combo — remapEdgeKind throws mid-cycle,
        // after the node above has already been staged for insertion.
        type: 'CALLS',
        reason: 'magento:unknown:family',
      },
    ];

    assert.throws(() => writeAugmentation(db, { nodes, edges }), /no locked-kind remap/);

    const nodeCountAfter = (db.prepare(`SELECT COUNT(*) AS c FROM nodes`).get() as { c: number }).c;
    assert.equal(
      nodeCountAfter,
      nodeCountBefore,
      'a failure partway through insertEdges must roll back the whole cycle, including the already-staged node insert — proving delete+reinsert runs as one transaction',
    );
  });
});

test('it opens the fixture db with the chosen sqlite binding (runtime smoke)', () => {
  // Opens a private copy (not the shared fixture path) to avoid any lock
  // contention with other test files, but exercises the real binding
  // against the real fixture schema/data end to end.
  withFreshDb((db, dbPath) => {
    assert.ok(fs.existsSync(dbPath));

    const one = db.prepare('SELECT 1 AS one').get() as { one: number };
    assert.equal(one.one, 1, 'better-sqlite3 binding must execute a trivial query against the fixture db');

    const nodeCount = (db.prepare('SELECT COUNT(*) AS c FROM nodes').get() as { c: number }).c;
    assert.ok(nodeCount > 0, 'fixture db opened via the writer binding must contain indexed nodes');
  });
});
