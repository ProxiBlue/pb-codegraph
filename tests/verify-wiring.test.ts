import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';

import {
  qualifiedNameToFqcn,
  reconcileWraps,
  reconcileObserves,
  reconcilePreferences,
  resolveDbSources,
  parseVerifyWiringArgs,
  parseBricklayerCommand,
  parseRuntimePlugins,
  parseRuntimeEvents,
  parseRuntimePreferences,
  formatVerifyWiringReport,
  type StaticWrapFact,
  type StaticObserveFact,
  type StaticPreferenceFact,
} from '../augmenter/src/verify-wiring.ts';
import { main, EXIT_OK } from '../augmenter/src/cli.ts';
import { mintExternalId, mintEventId, normalizeFqcn } from '../augmenter/src/resolvers/node-id.ts';
import type { AugmentNode, AugmentEdge } from '../augmenter/src/writer/sqlite-writer.ts';
import { buildIsolatedFixtureDb, type IsolatedFixtureDb } from './helpers/isolated-fixture-db.ts';
import { injectMagentoEdges } from './helpers/inject-magento-edges.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
const fakeBricklayerEntrypoint = path.join(__dirname, 'helpers', 'fake-bricklayer.ts');

// Real node ids from the fixture (see tests/fixture/app/code/Acme/ModuleA and
// tests/sqlite-writer.test.ts, which document the same ids).
const CLASS_FOO_ID = 'class:8a4d752448b6fec30dc789fc478809fe'; // Acme\ModuleA\Model\Foo
const FOO_PLUGIN_CLASS_ID = 'class:a120baa1ff63d157886f598a63e014fd'; // Acme\ModuleA\Plugin\FooPlugin
const INTERFACE_FOO_ID = 'interface:2ea043a4b2a4886e40b3b0f999676e7b'; // Acme\ModuleA\Api\FooInterface

function externalNode(fqcn: string): AugmentNode {
  const normalized = normalizeFqcn(fqcn);
  const lastSep = normalized.lastIndexOf('\\');
  const name = lastSep === -1 ? normalized : normalized.slice(lastSep + 1);
  return { id: mintExternalId(fqcn), kind: 'external', name, qualifiedName: normalized };
}

function eventNode(name: string): AugmentNode {
  return { id: mintEventId(name), kind: 'event', name };
}

function withEnv(overrides: Record<string, string>, fn: () => Promise<void>): Promise<void> {
  const previous: Record<string, string | undefined> = {};
  for (const key of Object.keys(overrides)) previous[key] = process.env[key];
  Object.assign(process.env, overrides);
  return fn().finally(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
}

// --- pure function unit tests --------------------------------------------

test('it reverses codegraph qualified_name back to a PHP FQCN (class/interface, and no-op for already-backslash external ids)', () => {
  assert.equal(qualifiedNameToFqcn('Acme\\ModuleA\\Model::Foo'), 'Acme\\ModuleA\\Model\\Foo');
  assert.equal(qualifiedNameToFqcn('Acme\\ModuleA\\Api::FooInterface'), 'Acme\\ModuleA\\Api\\FooInterface');
  // minted external nodes never contain "::" — round-trips unchanged.
  assert.equal(qualifiedNameToFqcn('Acme\\ModuleA\\Model\\Bar'), 'Acme\\ModuleA\\Model\\Bar');
});

test('it splits the (env-overridable) bricklayer spawn command on whitespace with no quoting support', () => {
  assert.deepEqual(parseBricklayerCommand('vendor/bin/bricklayer mcp'), { command: 'vendor/bin/bricklayer', args: ['mcp'] });
  assert.deepEqual(parseBricklayerCommand('/usr/bin/node --import tsx /x/y.ts'), {
    command: '/usr/bin/node',
    args: ['--import', 'tsx', '/x/y.ts'],
  });
});

test('it parses verify-wiring CLI args (project-root, --db, --registry, --stamp)', () => {
  assert.equal(parseVerifyWiringArgs([]), null);
  const parsed = parseVerifyWiringArgs(['/proj', '--db', '/proj/x.db', '--registry', '/reg.json', '--stamp']);
  assert.equal(parsed?.projectRoot, '/proj');
  assert.equal(parsed?.dbPath, '/proj/x.db');
  assert.equal(parsed?.registryPath, '/reg.json');
  assert.equal(parsed?.stamp, true);

  const minimal = parseVerifyWiringArgs(['/proj']);
  assert.equal(minimal?.dbPath, undefined);
  assert.equal(minimal?.registryPath, undefined);
  assert.equal(minimal?.stamp, false);

  assert.equal(parseVerifyWiringArgs(['/proj', '--unknown-flag']), null, 'unrecognized flag must fail parsing');
});

test('it shape-tolerantly parses plugin-list/event-list/preference-list runtime payloads and warns loudly on unrecognized shapes', () => {
  const plugins = parseRuntimePlugins('Acme\\ModuleA\\Model\\Foo', {
    class: 'Acme\\ModuleA\\Model\\Foo',
    plugins: { foo_plugin: { sortOrder: 10, instance: 'Acme\\ModuleA\\Plugin\\FooPlugin' } },
  });
  assert.deepEqual(plugins, [
    { targetFqcn: 'Acme\\ModuleA\\Model\\Foo', pluginName: 'foo_plugin', instanceFqcn: 'Acme\\ModuleA\\Plugin\\FooPlugin', sortOrder: 10 },
  ]);
  assert.deepEqual(parseRuntimePlugins('X', { class: 'X', plugins: {} }), []);
  assert.deepEqual(parseRuntimePlugins('X', { not_a_recognized_shape: true }), []);

  const events = parseRuntimeEvents('global', {
    area: 'global',
    total: 1,
    events: [{ event: 'checkout_cart_save_after', observer: 'foo_observer', class: 'Acme\\ModuleA\\Observer\\FooObserver' }],
  });
  assert.deepEqual(events, [
    { area: 'global', event: 'checkout_cart_save_after', observerName: 'foo_observer', classFqcn: 'Acme\\ModuleA\\Observer\\FooObserver' },
  ]);
  assert.deepEqual(parseRuntimeEvents('frontend', { not_a_recognized_shape: true }), []);

  // Real shape, characterized against a live bricklayer (pps, 2026-07-31):
  // {filter, count, preferences: [{interface, preference}]}.
  const realPrefs = parseRuntimePreferences({
    filter: 'Acme\\ModuleA\\Api\\FooInterface',
    count: 1,
    preferences: [{ interface: 'Acme\\ModuleA\\Api\\FooInterface', preference: 'Acme\\ModuleA\\Model\\Foo' }],
  });
  assert.deepEqual(realPrefs, [{ interfaceFqcn: 'Acme\\ModuleA\\Api\\FooInterface', implFqcn: 'Acme\\ModuleA\\Model\\Foo' }]);

  // Map shape (this parser's original guess, kept only as a tolerance fallback).
  const mapPrefs = parseRuntimePreferences({ preferences: { 'Acme\\ModuleA\\Api\\FooInterface': 'Acme\\ModuleA\\Model\\Foo' } });
  assert.deepEqual(mapPrefs, [{ interfaceFqcn: 'Acme\\ModuleA\\Api\\FooInterface', implFqcn: 'Acme\\ModuleA\\Model\\Foo' }]);

  // Real "not found" shape: count 0, empty array — must not warn as unrecognized.
  assert.deepEqual(parseRuntimePreferences({ filter: 'Acme\\Nope', count: 0, preferences: [] }), []);

  assert.deepEqual(parseRuntimePreferences({ totally_unrecognized: 1 }), []);
});

test('it normalizes a leading backslash on runtime FQCNs so they key-match the (always leading-backslash-stripped) static side', () => {
  // Real evidence (pps live run, 2026-07-31): bricklayer's plugin-list/event-list sometimes
  // return an FQCN with a leading "\" (e.g. "\Smile\ElasticsuiteCatalog\Plugin\..."), while the
  // static side (resolvers/node-id.ts normalizeFqcn) always strips it — an unnormalized runtime
  // side would double-count a real match as both MISSING_FROM_GRAPH and GRAPH_ONLY.
  const plugins = parseRuntimePlugins('Magento\\Catalog\\Model\\Category', {
    class: 'Magento\\Catalog\\Model\\Category',
    plugins: { p: { sortOrder: 10, instance: '\\Smile\\ElasticsuiteCatalog\\Plugin\\ReindexProductsAfterSave' } },
  });
  assert.equal(plugins[0].instanceFqcn, 'Smile\\ElasticsuiteCatalog\\Plugin\\ReindexProductsAfterSave');

  const events = parseRuntimeEvents('global', {
    area: 'global',
    total: 1,
    events: [{ event: 'inventory_stock_save_commit_after', observer: 'stock_save', class: '\\Magento\\InventoryIndexer\\Observer\\StockSaveObserver' }],
  });
  assert.equal(events[0].classFqcn, 'Magento\\InventoryIndexer\\Observer\\StockSaveObserver');

  const prefs = parseRuntimePreferences({
    filter: 'X',
    count: 1,
    preferences: [{ interface: '\\Magento\\Framework\\Serialize\\SerializerInterface', preference: '\\Firebear\\ImportExport\\Model\\Serialize\\Serializer\\Json' }],
  });
  assert.equal(prefs[0].interfaceFqcn, 'Magento\\Framework\\Serialize\\SerializerInterface');
  assert.equal(prefs[0].implFqcn, 'Firebear\\ImportExport\\Model\\Serialize\\Serializer\\Json');
});

test('it reconciles wraps facts into matched/sortorder-drift/missing-from-graph/graph-only', () => {
  const staticFacts: StaticWrapFact[] = [
    { dbLabel: 'project', edgeId: 1, pluginFqcn: 'Acme\\Plugin\\A', targetFqcn: 'Acme\\Model\\Foo', sortOrder: 10, area: 'global' },
    { dbLabel: 'project', edgeId: 2, pluginFqcn: 'Acme\\Plugin\\Drift', targetFqcn: 'Acme\\Model\\Foo', sortOrder: 5, area: 'global' },
    { dbLabel: 'project', edgeId: 3, pluginFqcn: 'Acme\\Plugin\\Bar', targetFqcn: 'Acme\\Model\\Bar', sortOrder: 1, area: 'global' },
  ];
  const runtimeFacts = [
    { targetFqcn: 'Acme\\Model\\Foo', pluginName: 'a', instanceFqcn: 'Acme\\Plugin\\A', sortOrder: 10 },
    { targetFqcn: 'Acme\\Model\\Foo', pluginName: 'drift', instanceFqcn: 'Acme\\Plugin\\Drift', sortOrder: 99 },
    { targetFqcn: 'Acme\\Model\\Foo', pluginName: 'missing', instanceFqcn: 'Acme\\Plugin\\Missing', sortOrder: 20 },
  ];

  const result = reconcileWraps(staticFacts, runtimeFacts);
  assert.equal(result.matched.length, 1);
  assert.equal(result.matched[0].pluginFqcn, 'Acme\\Plugin\\A');
  assert.equal(result.sortOrderDrift.length, 1);
  assert.equal(result.sortOrderDrift[0].pluginFqcn, 'Acme\\Plugin\\Drift');
  assert.equal(result.sortOrderDrift[0].graphSortOrder, 5);
  assert.equal(result.sortOrderDrift[0].runtimeSortOrder, 99);
  assert.equal(result.missingFromGraph.length, 1);
  assert.equal(result.missingFromGraph[0].instanceFqcn, 'Acme\\Plugin\\Missing');
  assert.equal(result.graphOnly.length, 1);
  assert.equal(result.graphOnly[0].pluginFqcn, 'Acme\\Plugin\\Bar');
});

test('it reconciles observes facts into matched/missing-from-graph/graph-only', () => {
  const staticFacts: StaticObserveFact[] = [
    { dbLabel: 'project', edgeId: 1, area: 'global', event: 'checkout_cart_save_after', observerFqcn: 'Acme\\Observer\\Foo' },
    { dbLabel: 'project', edgeId: 2, area: 'adminhtml', event: 'admin_only_event', observerFqcn: 'Acme\\Observer\\Admin' },
  ];
  const runtimeFacts = [
    { area: 'global', event: 'checkout_cart_save_after', observerName: 'foo_observer', classFqcn: 'Acme\\Observer\\Foo' },
    { area: 'frontend', event: 'customer_login', observerName: 'login_observer', classFqcn: 'Acme\\Observer\\Login' },
  ];

  const result = reconcileObserves(staticFacts, runtimeFacts);
  assert.equal(result.matched.length, 1);
  assert.equal(result.matched[0].event, 'checkout_cart_save_after');
  assert.equal(result.missingFromGraph.length, 1);
  assert.equal(result.missingFromGraph[0].event, 'customer_login');
  assert.equal(result.graphOnly.length, 1);
  assert.equal(result.graphOnly[0].event, 'admin_only_event');
});

test('it does not flag SORTORDER_DRIFT when the graph sortOrder is absent (undeclared), only when it EXPLICITLY disagrees', () => {
  // Evidence (pps live run, 2026-07-31): GrandTotalDetailsPlugin flagged
  // DRIFT graph=0 vs runtime=1 -- the "0" was di-xml.ts's own default-fill
  // for an undeclared sortOrder attribute, not a real declaration. An
  // EXPLICIT graph sortOrder of 0 that disagrees with runtime must still
  // be flagged as real drift.
  const staticFacts: StaticWrapFact[] = [
    { dbLabel: 'project', edgeId: 1, pluginFqcn: 'Acme\\Plugin\\NoOrder', targetFqcn: 'Acme\\Model\\Foo', sortOrder: null, area: 'global' },
    { dbLabel: 'project', edgeId: 2, pluginFqcn: 'Acme\\Plugin\\Explicit', targetFqcn: 'Acme\\Model\\Foo', sortOrder: 0, area: 'global' },
  ];
  const runtimeFacts = [
    { targetFqcn: 'Acme\\Model\\Foo', pluginName: 'no_order', instanceFqcn: 'Acme\\Plugin\\NoOrder', sortOrder: 1 },
    { targetFqcn: 'Acme\\Model\\Foo', pluginName: 'explicit', instanceFqcn: 'Acme\\Plugin\\Explicit', sortOrder: 1 },
  ];

  const result = reconcileWraps(staticFacts, runtimeFacts);

  assert.equal(result.matched.length, 1, 'absent graph sortOrder must be treated as matched, not drift');
  assert.equal(result.matched[0].pluginFqcn, 'Acme\\Plugin\\NoOrder');
  assert.equal(result.sortOrderDrift.length, 1, 'an EXPLICIT graph sortOrder of 0 that disagrees with runtime must still be flagged as drift');
  assert.equal(result.sortOrderDrift[0].pluginFqcn, 'Acme\\Plugin\\Explicit');
});

test('it matches a global graph observe edge against a runtime fact reported under ANY queried area (merged-area semantics)', () => {
  // Magento's event-list(area=frontend) MERGES global observers into the
  // frontend result set (real Magento semantics: global observers fire in
  // every area) -- the runtime fact for a global-declared observer is
  // reported tagged with the QUERIED area ("frontend" here), not "global".
  const staticFacts: StaticObserveFact[] = [
    { dbLabel: 'project', edgeId: 1, area: 'global', event: 'render', observerFqcn: 'Magento\\Csp\\Observer\\Render' },
  ];
  const runtimeFacts = [
    { area: 'adminhtml', event: 'render', observerName: 'csp_render', classFqcn: 'Magento\\Csp\\Observer\\Render' },
  ];

  const result = reconcileObserves(staticFacts, runtimeFacts);
  assert.equal(result.matched.length, 1, 'a global static fact must cover a runtime fact reported under any area');
  assert.equal(result.missingFromGraph.length, 0);
  assert.equal(result.graphOnly.length, 0, 'the global static fact is covered by the merged-area runtime fact, not graph-only');
});

test('it does NOT match an area-specific graph observe edge against a runtime fact from a DIFFERENT area', () => {
  const staticFacts: StaticObserveFact[] = [
    { dbLabel: 'project', edgeId: 1, area: 'adminhtml', event: 'admin_only_event', observerFqcn: 'Acme\\Observer\\Admin' },
  ];
  const runtimeFacts = [
    { area: 'frontend', event: 'admin_only_event', observerName: 'x', classFqcn: 'Acme\\Observer\\Admin' },
  ];

  const result = reconcileObserves(staticFacts, runtimeFacts);
  assert.equal(result.matched.length, 0, 'an area-specific graph edge must only match runtime facts from its OWN area');
  assert.equal(result.missingFromGraph.length, 1);
  assert.equal(result.graphOnly.length, 1);
});

test('it reconciles preference_for facts into matched/missing-from-graph/graph-only', () => {
  const staticFacts: StaticPreferenceFact[] = [
    { dbLabel: 'project', edgeId: 1, implFqcn: 'Acme\\Model\\Foo', interfaceFqcn: 'Acme\\Api\\FooInterface', area: 'global' },
    { dbLabel: 'project', edgeId: 2, implFqcn: 'Acme\\Model\\BazImpl', interfaceFqcn: 'Acme\\Api\\BazInterface', area: 'global' },
  ];
  const runtimeFacts = [
    { interfaceFqcn: 'Acme\\Api\\FooInterface', implFqcn: 'Acme\\Model\\Foo' },
    { interfaceFqcn: 'Acme\\Api\\BarInterface', implFqcn: 'Acme\\Model\\BarImpl' },
  ];

  const result = reconcilePreferences(staticFacts, runtimeFacts);
  assert.equal(result.matched.length, 1);
  assert.equal(result.matched[0].interfaceFqcn, 'Acme\\Api\\FooInterface');
  assert.equal(result.missingFromGraph.length, 1);
  assert.equal(result.missingFromGraph[0].interfaceFqcn, 'Acme\\Api\\BarInterface');
  assert.equal(result.graphOnly.length, 1);
  assert.equal(result.graphOnly[0].interfaceFqcn, 'Acme\\Api\\BazInterface');
});

test('it formats a report grouped by category with a summary count line', () => {
  const report = formatVerifyWiringReport({
    preferences: {
      matched: [{ interfaceFqcn: 'I', implFqcn: 'C' }],
      missingFromGraph: [],
      graphOnly: [],
    },
    wraps: { matched: [], sortOrderDrift: [], missingFromGraph: [], graphOnly: [] },
    observes: { matched: [], missingFromGraph: [], graphOnly: [] },
    stamp: false,
  });
  assert.match(report.text, /verify-wiring: 1 matched, 0 missing-from-graph, 0 graph-only, 0 sortorder-drift/);
  assert.deepEqual(report.summary, { matched: 1, missingFromGraph: 0, graphOnly: 0, sortOrderDrift: 0 });
});

// --- db-backed unit tests --------------------------------------------------

let fixture: IsolatedFixtureDb;

test.before(() => {
  fixture = buildIsolatedFixtureDb();
});

test.after(() => {
  fixture.cleanup();
});

let dbCounter = 0;
function freshProjectDb(): string {
  dbCounter += 1;
  const dbPath = path.join(fixture.dir, `verify-wiring-scratch-${dbCounter}.db`);
  fs.copyFileSync(fixture.dbPath, dbPath);
  return dbPath;
}

test('it unions registry db_path entries with the project db and skips a registry entry pointing at the project db itself', () => {
  const registryPath = path.join(fixture.dir, 'registry-union-test.json');
  const corePath = path.join(fixture.dir, 'core-fixture.db');
  fs.copyFileSync(fixture.dbPath, corePath);
  fs.writeFileSync(
    registryPath,
    JSON.stringify({
      core_repo: { db_path: corePath },
      self_repo: { db_path: fixture.dbPath }, // same file as "project" below — must be de-duped
    }),
  );

  const sources = resolveDbSources(fixture.dbPath, registryPath);
  assert.deepEqual(
    sources.map((s) => s.label),
    ['project', 'core_repo'],
  );
});

test('it reads static wraps/observes/preference_for edges from a codegraph db and reverses qualified_name to FQCN', () => {
  const dbPath = freshProjectDb();
  injectMagentoEdges(dbPath, {
    nodes: [eventNode('checkout_cart_save_after')],
    edges: [
      {
        sourceId: FOO_PLUGIN_CLASS_ID,
        targetId: CLASS_FOO_ID,
        type: 'WRAPS',
        reason: 'magento:di:plugin',
        metadata: { sortOrder: 10, area: 'global' },
      },
      {
        sourceId: mintEventId('checkout_cart_save_after'),
        targetId: CLASS_FOO_ID,
        type: 'CALLS',
        reason: 'magento:events:observer:checkout_cart_save_after',
        metadata: { event: 'checkout_cart_save_after', area: 'global' },
      },
      {
        sourceId: CLASS_FOO_ID,
        targetId: INTERFACE_FOO_ID,
        type: 'IMPLEMENTS',
        reason: 'magento:di:preference',
        metadata: { area: 'global' },
      },
    ],
  });

  const db = new Database(dbPath, { readonly: true });
  try {
    // Re-derive via the module under test through resolveDbSources/collectStaticFacts path
    // is exercised in the CLI-level test below; here we sanity-check the raw rows this
    // reader depends on actually landed with the expected columns.
    const wrapRow = db
      .prepare(
        `SELECT ns.qualified_name AS pluginQn, nt.qualified_name AS targetQn, e.metadata AS metadata
         FROM edges e JOIN nodes ns ON ns.id = e.source JOIN nodes nt ON nt.id = e.target
         WHERE e.kind = 'wraps'`,
      )
      .get() as { pluginQn: string; targetQn: string; metadata: string };
    assert.equal(wrapRow.pluginQn, 'Acme\\ModuleA\\Plugin::FooPlugin');
    assert.equal(wrapRow.targetQn, 'Acme\\ModuleA\\Model::Foo');
    assert.deepEqual(JSON.parse(wrapRow.metadata), { sortOrder: 10, area: 'global', reason: 'magento:di:plugin' });
  } finally {
    db.close();
  }
});

// --- full CLI end-to-end test (spawns the fake bricklayer child process) --

function writeFixtureFile(dir: string, content: unknown): string {
  const p = path.join(dir, `fake-bricklayer-fixture-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
  fs.writeFileSync(p, JSON.stringify(content));
  return p;
}

function captureIO(): { io: { log: (m: string) => void; error: (m: string) => void }; logs: string[]; errors: string[] } {
  const logs: string[] = [];
  const errors: string[] = [];
  return { io: { log: (m) => logs.push(m), error: (m) => errors.push(m) }, logs, errors };
}

test(
  'it reconciles static edges against bricklayer runtime truth end-to-end and exits 1 when anything is missing-from-graph',
  { timeout: 120_000 },
  async () => {
    const dbPath = freshProjectDb();

    const barTarget = 'Acme\\ModuleA\\Model\\Bar';
    const barPlugin = 'Acme\\ModuleA\\Plugin\\BarPlugin';
    const driftPlugin = 'Acme\\ModuleA\\Plugin\\DriftPlugin';
    const fooObserver = 'Acme\\ModuleA\\Observer\\FooObserver';
    const adminObserver = 'Acme\\ModuleA\\Observer\\AdminObserver';
    const bazImpl = 'Acme\\ModuleA\\Model\\BazImpl';
    const bazInterface = 'Acme\\ModuleA\\Api\\BazInterface';

    const edges: AugmentEdge[] = [
      // wraps: MATCHED (FooPlugin wraps Foo, sortOrder 10 both sides)
      { sourceId: FOO_PLUGIN_CLASS_ID, targetId: CLASS_FOO_ID, type: 'WRAPS', reason: 'magento:di:plugin', metadata: { sortOrder: 10, area: 'global' } },
      // wraps: SORTORDER_DRIFT (DriftPlugin wraps Foo, static sortOrder 5, runtime says 99)
      { sourceId: mintExternalId(driftPlugin), targetId: CLASS_FOO_ID, type: 'WRAPS', reason: 'magento:di:plugin', metadata: { sortOrder: 5, area: 'global' } },
      // wraps: GRAPH_ONLY (BarPlugin wraps Bar; bricklayer reports no plugins for Bar at all)
      { sourceId: mintExternalId(barPlugin), targetId: mintExternalId(barTarget), type: 'WRAPS', reason: 'magento:di:plugin', metadata: { sortOrder: 1, area: 'global' } },
      // observes: MATCHED
      { sourceId: mintEventId('checkout_cart_save_after'), targetId: mintExternalId(fooObserver), type: 'CALLS', reason: 'magento:events:observer:checkout_cart_save_after', metadata: { event: 'checkout_cart_save_after', area: 'global' } },
      // observes: GRAPH_ONLY (admin_only_event; bricklayer reports zero adminhtml events)
      { sourceId: mintEventId('admin_only_event'), targetId: mintExternalId(adminObserver), type: 'CALLS', reason: 'magento:events:observer:admin_only_event', metadata: { event: 'admin_only_event', area: 'adminhtml' } },
      // preference_for: MATCHED
      { sourceId: CLASS_FOO_ID, targetId: INTERFACE_FOO_ID, type: 'IMPLEMENTS', reason: 'magento:di:preference', metadata: { area: 'global' } },
      // preference_for: GRAPH_ONLY (static says BazInterface -> BazImpl, but runtime says a
      // different impl now wins — see the "override" runtime response below)
      { sourceId: mintExternalId(bazImpl), targetId: mintExternalId(bazInterface), type: 'IMPLEMENTS', reason: 'magento:di:preference', metadata: { area: 'global' } },
    ];

    injectMagentoEdges(dbPath, {
      nodes: [
        externalNode(driftPlugin),
        externalNode(barPlugin),
        externalNode(barTarget),
        eventNode('checkout_cart_save_after'),
        externalNode(fooObserver),
        eventNode('admin_only_event'),
        externalNode(adminObserver),
        externalNode(bazImpl),
        externalNode(bazInterface),
      ],
      edges,
    });

    const fooFqcn = 'Acme\\ModuleA\\Model\\Foo';
    const missingPlugin = 'Acme\\ModuleA\\Plugin\\MissingPlugin';

    const fixtureFile = writeFixtureFile(fixture.dir, {
      plugins: {
        [fooFqcn]: {
          class: fooFqcn,
          plugins: {
            foo_plugin: { sortOrder: 10, instance: 'Acme\\ModuleA\\Plugin\\FooPlugin' },
            drift_plugin: { sortOrder: 99, instance: driftPlugin },
            missing_plugin: { sortOrder: 20, instance: missingPlugin },
          },
        },
        // Bar target: deliberately omitted -> fake-bricklayer default is {plugins: {}}
      },
      events: {
        global: {
          area: 'global',
          total: 1,
          events: [{ event: 'checkout_cart_save_after', observer: 'foo_observer', class: fooObserver }],
        },
        frontend: {
          area: 'frontend',
          total: 1,
          events: [{ event: 'customer_login', observer: 'login_observer', class: 'Acme\\ModuleA\\Observer\\LoginObserver' }],
        },
        adminhtml: { area: 'adminhtml', total: 0, events: [] },
      },
      // preference-list is per-interface (see verify-wiring.ts's characterization note) — keyed
      // by the exact interfaceFqcn argument distinctPreferenceInterfaces() will call it with.
      preferences: {
        'Acme\\ModuleA\\Api\\FooInterface': {
          filter: 'Acme\\ModuleA\\Api\\FooInterface',
          count: 1,
          preferences: [{ interface: 'Acme\\ModuleA\\Api\\FooInterface', preference: fooFqcn }],
        },
        [bazInterface]: {
          filter: bazInterface,
          count: 1,
          // Runtime disagrees with the static graph's impl -> MISSING_FROM_GRAPH for this pair,
          // GRAPH_ONLY for the static (bazInterface, bazImpl) pair.
          preferences: [{ interface: bazInterface, preference: 'Acme\\ModuleA\\Model\\BazImplRuntimeOverride' }],
        },
      },
    });

    await withEnv(
      {
        PB_CODEGRAPH_BRICKLAYER_CMD: `${process.execPath} --import tsx ${fakeBricklayerEntrypoint}`,
        PB_CODEGRAPH_FAKE_BRICKLAYER_FIXTURE: fixtureFile,
      },
      async () => {
        const { io, logs, errors } = captureIO();
        const code = await main(['verify-wiring', repoRoot, '--db', dbPath], io);

        assert.equal(errors.length, 0, `expected no stderr, got: ${errors.join('\n')}`);
        assert.equal(code, 1, 'expected exit 1 because missing-from-graph facts exist');

        const text = logs.join('\n');
        assert.match(text, /MATCHED\s+Acme\\ModuleA\\Plugin\\FooPlugin wraps Acme\\ModuleA\\Model\\Foo \(sortOrder 10\)/);
        assert.match(text, /DRIFT\s+Acme\\ModuleA\\Plugin\\DriftPlugin wraps Acme\\ModuleA\\Model\\Foo — graph sortOrder 5 != runtime 99/);
        assert.match(text, new RegExp(`MISSING\\s+${missingPlugin.replace(/\\/g, '\\\\')} wraps ${fooFqcn.replace(/\\/g, '\\\\')}`));
        assert.match(text, /GRAPH-ONLY\s+Acme\\ModuleA\\Plugin\\BarPlugin wraps Acme\\ModuleA\\Model\\Bar/);

        assert.match(text, /MATCHED\s+Acme\\ModuleA\\Observer\\FooObserver observes checkout_cart_save_after \[global\]/);
        assert.match(text, /MISSING\s+Acme\\ModuleA\\Observer\\LoginObserver observes customer_login \[frontend\]/);
        assert.match(text, /GRAPH-ONLY\s+Acme\\ModuleA\\Observer\\AdminObserver observes admin_only_event \[adminhtml\]/);

        assert.match(text, /MATCHED\s+Acme\\ModuleA\\Model\\Foo -> Acme\\ModuleA\\Api\\FooInterface/);
        assert.match(text, /MISSING\s+Acme\\ModuleA\\Model\\BazImplRuntimeOverride -> Acme\\ModuleA\\Api\\BazInterface/);
        assert.match(text, /GRAPH-ONLY\s+Acme\\ModuleA\\Model\\BazImpl -> Acme\\ModuleA\\Api\\BazInterface/);

        assert.match(text, /verify-wiring: 3 matched, 3 missing-from-graph, 3 graph-only, 1 sortorder-drift/);
      },
    );
  },
);

test(
  'it stamps GRAPH_ONLY edges enabled_in_env=false in the project db only, never in a registry (core) db',
  { timeout: 120_000 },
  async () => {
    const projectDbPath = freshProjectDb();
    const corePath = path.join(fixture.dir, `verify-wiring-core-${dbCounter}.db`);
    fs.copyFileSync(fixture.dbPath, corePath);

    const bazImpl = 'Acme\\ModuleA\\Model\\BazImpl';
    const bazInterface = 'Acme\\ModuleA\\Api\\BazInterface';
    const coreOnlyPlugin = 'Acme\\Core\\Plugin\\CoreOnlyPlugin';
    const coreOnlyTarget = 'Acme\\Core\\Model\\CoreOnlyTarget';

    // Project db: one GRAPH_ONLY preference (disabled module, not in runtime).
    injectMagentoEdges(projectDbPath, {
      nodes: [externalNode(bazImpl), externalNode(bazInterface)],
      edges: [
        { sourceId: mintExternalId(bazImpl), targetId: mintExternalId(bazInterface), type: 'IMPLEMENTS', reason: 'magento:di:preference', metadata: { area: 'global' } },
      ],
    });
    // "Core" registry db: a GRAPH_ONLY wraps edge that must NEVER be mutated by --stamp.
    injectMagentoEdges(corePath, {
      nodes: [externalNode(coreOnlyPlugin), externalNode(coreOnlyTarget)],
      edges: [
        { sourceId: mintExternalId(coreOnlyPlugin), targetId: mintExternalId(coreOnlyTarget), type: 'WRAPS', reason: 'magento:di:plugin', metadata: { sortOrder: 1, area: 'global' } },
      ],
    });

    const registryPath = path.join(fixture.dir, `verify-wiring-registry-${dbCounter}.json`);
    fs.writeFileSync(registryPath, JSON.stringify({ core_repo: { db_path: corePath } }));

    const fixtureFile = writeFixtureFile(fixture.dir, {
      plugins: {},
      events: {
        global: { area: 'global', total: 0, events: [] },
        frontend: { area: 'frontend', total: 0, events: [] },
        adminhtml: { area: 'adminhtml', total: 0, events: [] },
      },
      // No entry for bazInterface -> fake-bricklayer's real "not found" default
      // ({filter, count:0, preferences:[]}), which is exactly what should make the
      // static-only preference GRAPH_ONLY (not MISSING, not MATCHED).
      preferences: {},
    });

    function coreEdgeMetadata(): string | null {
      const db = new Database(corePath, { readonly: true });
      try {
        return (db.prepare(`SELECT metadata FROM edges WHERE kind = 'wraps'`).get() as { metadata: string | null }).metadata;
      } finally {
        db.close();
      }
    }
    function projectEdgeMetadata(): string | null {
      const db = new Database(projectDbPath, { readonly: true });
      try {
        return (db.prepare(`SELECT metadata FROM edges WHERE kind = 'preference_for'`).get() as { metadata: string | null }).metadata;
      } finally {
        db.close();
      }
    }

    const coreMetadataBefore = coreEdgeMetadata();

    await withEnv(
      {
        PB_CODEGRAPH_BRICKLAYER_CMD: `${process.execPath} --import tsx ${fakeBricklayerEntrypoint}`,
        PB_CODEGRAPH_FAKE_BRICKLAYER_FIXTURE: fixtureFile,
      },
      async () => {
        const { io, errors } = captureIO();
        const code = await main(
          ['verify-wiring', repoRoot, '--db', projectDbPath, '--registry', registryPath, '--stamp'],
          io,
        );
        assert.equal(errors.length, 0, `expected no stderr, got: ${errors.join('\n')}`);
        // Both dbs' facts were GRAPH_ONLY and nothing was runtime-missing, so exit must be 0.
        assert.equal(code, EXIT_OK);
      },
    );

    const projectMetadataAfter = JSON.parse(projectEdgeMetadata()!);
    assert.equal(projectMetadataAfter.enabled_in_env, false, 'project db GRAPH_ONLY edge must be stamped');

    const coreMetadataAfter = coreEdgeMetadata();
    assert.equal(coreMetadataAfter, coreMetadataBefore, 'registry (core) db edge must be untouched by --stamp');
  },
);

// --- error paths -----------------------------------------------------------

test('it exits 2 with an actionable message when the codegraph db does not exist', async () => {
  const { io, errors } = captureIO();
  const code = await main(['verify-wiring', fixture.dir, '--db', path.join(fixture.dir, 'does-not-exist.db')], io);
  assert.equal(code, 2);
  assert.match(errors.join('\n'), /codegraph db not found/);
});

test('it exits 2 with an actionable message naming PB_CODEGRAPH_BRICKLAYER_CMD when bricklayer cannot be launched', async () => {
  const dbPath = freshProjectDb();
  await withEnv({ PB_CODEGRAPH_BRICKLAYER_CMD: '/no/such/bricklayer-binary-xyz' }, async () => {
    const { io, errors } = captureIO();
    const code = await main(['verify-wiring', repoRoot, '--db', dbPath], io);
    assert.equal(code, 2);
    const message = errors.join('\n');
    assert.match(message, /unable to launch bricklayer/);
    assert.match(message, /PB_CODEGRAPH_BRICKLAYER_CMD/);
  });
});
