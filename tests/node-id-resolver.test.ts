import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import {
  resolveClass,
  resolveMethod,
  resolveFileEndpoint,
  mintEventId,
  mintRouteId,
  mintTemplateId,
} from '../augmenter/src/resolvers/node-id.ts';
import { buildIsolatedFixtureDb, type IsolatedFixtureDb } from './helpers/isolated-fixture-db.ts';

// Uses buildIsolatedFixtureDb (own temp dir + own `codegraph init` run)
// rather than reading tests/fixture/.codegraph/codegraph.db directly — that
// shared path is destructively rebuilt (`rm -rf` + reinit) by
// tests/build-fixture-db.test.ts, and node --test runs files in parallel by
// default, so a direct read races it. This mirrors the pattern already used
// by every tests/mcp-*.test.ts file.
let fixture: IsolatedFixtureDb;

test.before(() => {
  fixture = buildIsolatedFixtureDb();
});

test.after(() => {
  fixture.cleanup();
});

// Each test gets its own copy (inside the isolated fixture's own temp dir,
// cleaned up wholesale by fixture.cleanup()) so a test that mutates the db
// (e.g. inserting a "now indexed" native row) never leaks into another.
let dbCounter = 0;
function withFreshDb<T>(fn: (db: Database.Database, dbPath: string) => T): T {
  dbCounter += 1;
  const dbPath = path.join(fixture.dir, `resolver-scratch-${dbCounter}.db`);
  fs.copyFileSync(fixture.dbPath, dbPath);
  const db = new Database(dbPath);
  try {
    return fn(db, dbPath);
  } finally {
    db.close();
  }
}

test('it characterizes codegraph qualified_name format for classes and methods from the fixture', () => {
  withFreshDb((db) => {
    // Class: app/code/Acme/ModuleA/Model/Foo.php declares `class Foo` in
    // namespace Acme\ModuleA\Model (FQCN Acme\ModuleA\Model\Foo). codegraph
    // stores qualified_name as "<namespace>::<ClassName>" — the LAST
    // backslash before the class name becomes '::', not every separator.
    const classRow = db
      .prepare(`SELECT kind, name, qualified_name FROM nodes WHERE kind = 'class' AND name = 'Foo'`)
      .get() as { kind: string; name: string; qualified_name: string };
    assert.ok(classRow, 'fixture must index Acme\\ModuleA\\Model\\Foo as a class node');
    assert.equal(classRow.qualified_name, 'Acme\\ModuleA\\Model::Foo');

    // Interface: app/code/Acme/ModuleA/Api/FooInterface.php, FQCN
    // Acme\ModuleA\Api\FooInterface.
    const interfaceRow = db
      .prepare(`SELECT kind, name, qualified_name FROM nodes WHERE kind = 'interface' AND name = 'FooInterface'`)
      .get() as { kind: string; name: string; qualified_name: string };
    assert.ok(interfaceRow, 'fixture must index Acme\\ModuleA\\Api\\FooInterface as an interface node');
    assert.equal(interfaceRow.qualified_name, 'Acme\\ModuleA\\Api::FooInterface');

    // Method: Foo::getFoo(). codegraph appends "::<methodName>" onto the
    // owning class's own qualified_name, i.e. "<namespace>::<Class>::<method>".
    const methodRow = db
      .prepare(`SELECT kind, name, qualified_name FROM nodes WHERE kind = 'method' AND name = 'getFoo' AND file_path LIKE '%Model/Foo.php'`)
      .get() as { kind: string; name: string; qualified_name: string };
    assert.ok(methodRow, 'fixture must index Foo::getFoo as a method node');
    assert.equal(methodRow.qualified_name, 'Acme\\ModuleA\\Model::Foo::getFoo');

    // Interface method: FooInterface::getFoo().
    const interfaceMethodRow = db
      .prepare(`SELECT kind, name, qualified_name FROM nodes WHERE kind = 'method' AND name = 'getFoo' AND file_path LIKE '%Api/FooInterface.php'`)
      .get() as { kind: string; name: string; qualified_name: string };
    assert.ok(interfaceMethodRow, 'fixture must index FooInterface::getFoo as a method node');
    assert.equal(interfaceMethodRow.qualified_name, 'Acme\\ModuleA\\Api::FooInterface::getFoo');
  });
});

// Real node ids from the fixture (see tests/fixture app/code/Acme/... and
// tests/sqlite-writer.test.ts's own comment pinning these same ids).
const CLASS_FOO_ID = 'class:8a4d752448b6fec30dc789fc478809fe';
const INTERFACE_FOO_ID = 'interface:2ea043a4b2a4886e40b3b0f999676e7b';
const METHOD_GETFOO_ID = 'method:e06c59f1a267d797bd5b5b76e65376d2';

test('it resolves an fqcn from di xml to the indexed class node id', () => {
  withFreshDb((db) => {
    // di.xml's <preference type="Acme\ModuleA\Model\Foo"> target.
    const classResolved = resolveClass(db, 'Acme\\ModuleA\\Model\\Foo');
    assert.equal(classResolved.id, CLASS_FOO_ID);
    assert.equal(classResolved.minted, false);

    // di.xml's <preference for="Acme\ModuleA\Api\FooInterface"> source.
    const interfaceResolved = resolveClass(db, 'Acme\\ModuleA\\Api\\FooInterface');
    assert.equal(interfaceResolved.id, INTERFACE_FOO_ID);
    assert.equal(interfaceResolved.minted, false);
  });
});

test('it resolves a class method target to the method node when indexed', () => {
  withFreshDb((db) => {
    // webapi.xml's <service class="Acme\ModuleA\Model\Foo" method="getFoo">.
    const methodResolved = resolveMethod(db, 'Acme\\ModuleA\\Model\\Foo', 'getFoo');
    assert.equal(methodResolved.id, METHOD_GETFOO_ID);
    assert.equal(methodResolved.minted, false);
  });
});

test('it resolves a File:relpath endpoint to the class node defined in that file', () => {
  withFreshDb((db) => {
    // Vendored-mapper-style endpoint shape (see docs/edge-taxonomy.md
    // "Endpoint model") — a `File:<relpath>` string with no codegraph node
    // of its own; the resolver must map it to the class/interface node
    // actually defined in that file.
    const resolved = resolveFileEndpoint(db, 'File:app/code/Acme/ModuleA/Model/Foo.php');
    assert.equal(resolved.id, CLASS_FOO_ID);
    assert.equal(resolved.minted, false);

    // Bare relpath (no "File:" prefix) must resolve the same way.
    const bareResolved = resolveFileEndpoint(db, 'app/code/Acme/ModuleA/Api/FooInterface.php');
    assert.equal(bareResolved.id, INTERFACE_FOO_ID);
    assert.equal(bareResolved.minted, false);
  });
});

test('it mints deterministic event, route, and template node ids', () => {
  // events.xml <event name="checkout_cart_save_after">
  assert.equal(mintEventId('checkout_cart_save_after'), 'magento:event:checkout_cart_save_after');
  assert.equal(mintEventId('checkout_cart_save_after'), mintEventId('checkout_cart_save_after'));

  // webapi.xml <route url="/V1/moduleb/foo">
  assert.equal(mintRouteId('webapi', '/V1/moduleb/foo'), 'magento:route:webapi:/V1/moduleb/foo');
  // routes.xml frontName-declared route
  assert.equal(mintRouteId('frontend', 'moduleb'), 'magento:route:frontend:moduleb');
  assert.equal(mintRouteId('webapi', '/V1/moduleb/foo'), mintRouteId('webapi', '/V1/moduleb/foo'));

  // layout xml <block template="Acme_ModuleB::foo.phtml">
  assert.equal(
    mintTemplateId('frontend', 'Acme_ModuleB::foo.phtml'),
    'magento:template:frontend:Acme_ModuleB::foo.phtml',
  );
  assert.equal(
    mintTemplateId('frontend', 'Acme_ModuleB::foo.phtml'),
    mintTemplateId('frontend', 'Acme_ModuleB::foo.phtml'),
  );
});

test('it mints a stable external placeholder node for unresolved targets and returns the same id across repeat runs', () => {
  // di.xml's <type name="Magento\Catalog\Model\Product"> — a real Magento
  // core class with no PHP file anywhere in this fixture tree (deliberate
  // unresolved-target case, see tests/fixture/.../ModuleB/etc/di.xml).
  const unresolvedFqcn = 'Magento\\Catalog\\Model\\Product';

  const firstRun = withFreshDb((db) => resolveClass(db, unresolvedFqcn));
  assert.equal(firstRun.minted, true);
  assert.equal(firstRun.id, 'magento:external:Magento\\Catalog\\Model\\Product');
  assert.equal(firstRun.node?.kind, 'external');
  assert.equal(firstRun.node?.qualifiedName, 'Magento\\Catalog\\Model\\Product');

  // A fresh db copy stands in for a repeat augmenter run against the same
  // (still-unresolved) project state — the id must be identical, not
  // re-derived from any run-specific state (timestamp, counter, etc.).
  const secondRun = withFreshDb((db) => resolveClass(db, unresolvedFqcn));
  assert.equal(secondRun.id, firstRun.id);
  assert.equal(secondRun.minted, true);
});

test('it prefers an existing native node over minting when the symbol is now indexed', () => {
  withFreshDb((db) => {
    const fqcn = 'Magento\\Catalog\\Model\\Product';

    // Sanity: unresolved before we simulate codegraph having indexed it.
    const before = resolveClass(db, fqcn);
    assert.equal(before.minted, true);

    // Simulate codegraph having since indexed Magento\Catalog\Model\Product
    // as a real native class row (a later `pb-codegraph index` run, per
    // _devils_advocate.md I2 — the resolver must re-check native nodes
    // FIRST on every call, not trust a previously-minted placeholder).
    db.prepare(
      `INSERT INTO nodes (
        id, kind, name, qualified_name, file_path, language,
        start_line, end_line, start_column, end_column, updated_at
      ) VALUES ('class:nowindexed', 'class', 'Product', 'Magento\\Catalog\\Model::Product',
        'vendor/magento/module-catalog/Model/Product.php', 'php', 1, 1, 1, 1, 0)`,
    ).run();

    const after = resolveClass(db, fqcn);
    assert.equal(after.minted, false);
    assert.equal(after.id, 'class:nowindexed');
  });
});

test('it never produces an edge whose source or target is missing from nodes', () => {
  withFreshDb((db) => {
    // Every endpoint the fixture's 5 XML families actually declare (see
    // tests/fixture/app/code/Acme/ModuleA|ModuleB/etc/*.xml), resolved
    // through every resolver entry point this module exposes — including
    // the deliberate unresolved-target case (Magento\Catalog\Model\Product,
    // di.xml).
    const resolved = [
      // di.xml preference: interface -> class
      resolveClass(db, 'Acme\\ModuleA\\Api\\FooInterface'),
      resolveClass(db, 'Acme\\ModuleA\\Model\\Foo'),
      // di.xml plugin: target class -> plugin class
      resolveClass(db, 'Acme\\ModuleA\\Plugin\\FooPlugin'),
      // di.xml unresolved plugin target (ModuleB/etc/di.xml)
      resolveClass(db, 'Magento\\Catalog\\Model\\Product'),
      // events.xml observers
      resolveClass(db, 'Acme\\ModuleA\\Model\\Foo'),
      resolveClass(db, 'Acme\\ModuleA\\Plugin\\FooPlugin'),
      // layout.xml block class
      resolveClass(db, 'Acme\\ModuleA\\Model\\Foo'),
      // webapi.xml service class + method
      resolveMethod(db, 'Acme\\ModuleA\\Model\\Foo', 'getFoo'),
      // File: endpoint form (vendored-mapper shape)
      resolveFileEndpoint(db, 'File:app/code/Acme/ModuleA/Model/Foo.php'),
    ];

    // Minted node ids (event/route/template from this same edge set — not
    // resolved via a class/method fqcn, but must still satisfy the
    // invariant once handed to the writer).
    const mintedIds = [
      mintEventId('controller_action_predispatch'),
      mintEventId('checkout_cart_save_after'),
      mintRouteId('webapi', '/V1/moduleb/foo'),
      mintRouteId('frontend', 'moduleb'),
      mintTemplateId('frontend', 'Acme_ModuleB::foo.phtml'),
    ];

    const existsNatively = (id: string): boolean =>
      db.prepare(`SELECT 1 FROM nodes WHERE id = ?`).get(id) !== undefined;

    for (const r of resolved) {
      const satisfied = r.minted ? r.node?.id === r.id : existsNatively(r.id);
      assert.ok(
        satisfied,
        `resolved id "${r.id}" (minted=${r.minted}) must either exist natively or carry ` +
          'a minted AugmentNode with the same id for the writer to insert',
      );
    }

    // mint*Id ids are never claimed to exist natively — 003b/the writer is
    // responsible for constructing and inserting their AugmentNode
    // (event/route/template minting nodes, not this test's concern beyond
    // "the id itself is well-formed and namespaced under magento:").
    for (const id of mintedIds) {
      assert.match(id, /^magento:(event|route|template):/);
    }
  });
});
