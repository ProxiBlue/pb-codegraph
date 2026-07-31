// pb-codegraph: new file (not vendored). Replaces the legacy augmenter's
// augmenter/src/writer/lbug-writer.ts wholesale — that writer's CSV bulk
// COPY + Cypher MERGE machinery targeted ladybugdb (the old LBUG graph
// engine) and has no equivalent here. codegraph's storage is plain SQLite
// (see docs/edge-taxonomy.md), so this writer speaks SQL directly.
//
// Runtime choice: better-sqlite3 (not node:sqlite).
//  - Synchronous API lets the full delete+reinsert cycle run inside one
//    `db.transaction()` call with no async interleaving window for
//    codegraph's own FS-watcher reindex to observe a half-applied state.
//  - Already a repo dependency (see package.json; used by
//    tests/build-fixture-db.test.ts) and the pinned choice in
//    .claude/code-standards.md's SQLite section.
//  - Caveat: ships a native (N-API) addon. It must be installed/rebuilt
//    against the Node ABI actually running inside the ddev web container
//    (postinstall runs prebuild-install / node-gyp) — a host-built binary
//    does not necessarily load in-container. See task 010 (ddev cutover)
//    for the container wiring; `npm rebuild better-sqlite3` in-container
//    if the prebuilt binary doesn't match.
//  - node:sqlite (Node >=22.5, still experimental) was rejected for v0.2
//    because the fleet's ddev containers pin Node 20 (.claude/testing.md).
import Database from 'better-sqlite3';
import { assertSupportedSchema } from '../../../shared/schema-guard.ts';

export const PROVENANCE = 'pb-codegraph-augmenter' as const;

/**
 * Node kinds minted by this augmenter. These kinds never appear in
 * codegraph's native PHP indexer output (see docs/edge-taxonomy.md "Node
 * kinds"), so kind membership alone safely identifies augmenter-owned
 * nodes — the `nodes` table has no `provenance` column (only `edges`
 * does), so this is the ownership marker for nodes.
 */
export const MINTED_NODE_KINDS = ['event', 'route', 'template', 'external'] as const;
export type MintedNodeKind = (typeof MINTED_NODE_KINDS)[number];

/**
 * Vendored mapper output shape (the legacy augmenter's AugmentEdge), gaining a
 * `metadata` field per task 002's plan. `type` + `reason` are remapped to a
 * LOCKED lowercase edge kind before insertion — see the kind remap table in
 * docs/edge-taxonomy.md. `confidence` is intentionally NOT part of this
 * type: it is always 1.0 upstream and dead in the codegraph model.
 */
export interface AugmentEdge {
  sourceId: string;
  targetId: string;
  type: 'IMPLEMENTS' | 'WRAPS' | 'CALLS' | 'HANDLES_ROUTE';
  reason: string;
  /** Extra fields forwarded verbatim into edges.metadata JSON, e.g.
   * { sortOrder, area } for wraps, { event, area } for observes. */
  metadata?: Record<string, unknown>;
  line?: number | null;
  col?: number | null;
}

export interface AugmentNode {
  id: string;
  kind: MintedNodeKind;
  name: string;
  qualifiedName?: string;
  filePath?: string;
  language?: string;
}

export interface AugmentInput {
  nodes: AugmentNode[];
  edges: AugmentEdge[];
}

export interface WriteResult {
  edgesDeleted: number;
  nodesDeleted: number;
  nodesInserted: number;
  edgesInserted: number;
}

/**
 * Kind remap table (locked, see docs/edge-taxonomy.md). The vendored
 * mappers emit uppercase `type` + free-text `reason` designed for the old
 * LBUG schema; storing `type` verbatim would collide `IMPLEMENTS` with
 * codegraph's own native `implements` edge, and would make `observer` and
 * `layout` edges (both emit `CALLS`) unqueryable as distinct families.
 */
const EDGE_KIND_REMAP: ReadonlyArray<{
  type: AugmentEdge['type'];
  reasonPrefix: string;
  kind: string;
}> = [
  { type: 'IMPLEMENTS', reasonPrefix: 'magento:di:preference', kind: 'preference_for' },
  { type: 'WRAPS', reasonPrefix: 'magento:di:plugin', kind: 'wraps' },
  { type: 'CALLS', reasonPrefix: 'magento:events:observer:', kind: 'observes' },
  { type: 'CALLS', reasonPrefix: 'magento:layout:block-template', kind: 'renders' },
  { type: 'HANDLES_ROUTE', reasonPrefix: 'magento:webapi:route', kind: 'references' },
  { type: 'HANDLES_ROUTE', reasonPrefix: 'magento:routes:controller', kind: 'references' },
];

export function remapEdgeKind(type: AugmentEdge['type'], reason: string): string {
  const match = EDGE_KIND_REMAP.find((r) => r.type === type && reason.startsWith(r.reasonPrefix));
  if (!match) {
    throw new Error(
      `sqlite-writer: no locked-kind remap for vendored type "${type}" reason "${reason}" — ` +
        'see the kind remap table in docs/edge-taxonomy.md',
    );
  }
  return match.kind;
}

/** Opens the DB for writing with busy_timeout set so a concurrent
 * codegraph FS-watcher reindex doesn't fail the write with SQLITE_BUSY. */
export function openWriterDb(dbPath: string): Database.Database {
  const db = new Database(dbPath);
  db.pragma('busy_timeout = 5000');
  // Detect (not force) whichever journal mode codegraph itself set up —
  // WAL allows concurrent readers during our write; we respect it either
  // way rather than overriding codegraph's own pragma choice.
  db.pragma('journal_mode');

  // Schema-version guard (task 008): refuse an unrecognized codegraph
  // schema before any augmenter write touches it.
  try {
    assertSupportedSchema(db);
  } catch (err) {
    db.close();
    throw err;
  }

  return db;
}

/**
 * Whether `nodes_fts` is already kept in sync by an AFTER INSERT trigger on
 * `nodes` (true for the characterized fixture DB — see `nodes_ai` in
 * sqlite_master). Detected rather than assumed: FTS5 external-content
 * tables do NOT auto-sync without an explicit trigger, so a codegraph
 * version/config without one would silently leave minted nodes
 * unsearchable unless the writer maintains nodes_fts itself.
 */
function nodesFtsHasInsertTrigger(db: Database.Database): boolean {
  const rows = db
    .prepare(`SELECT sql FROM sqlite_master WHERE type = 'trigger' AND tbl_name = 'nodes'`)
    .all() as Array<{ sql: string | null }>;
  return rows.some((r) => !!r.sql && /AFTER\s+INSERT/i.test(r.sql) && /nodes_fts/i.test(r.sql));
}

function upsertNodes(db: Database.Database, nodes: AugmentNode[]): number {
  if (nodes.length === 0) return 0;
  const now = Date.now();
  const ftsMaintainedByTrigger = nodesFtsHasInsertTrigger(db);

  // start/end line/col are NOT NULL on `nodes` with no default — minted
  // nodes (event/route/template/external) have no source-file coordinates
  // of their own (they represent XML-declared concepts, not PHP symbols),
  // so we write 0 as an explicit "not applicable" sentinel.
  const insertNode = db.prepare(`
    INSERT OR IGNORE INTO nodes (
      id, kind, name, qualified_name, file_path, language,
      start_line, end_line, start_column, end_column, updated_at
    ) VALUES (@id, @kind, @name, @qualifiedName, @filePath, @language, 0, 0, 0, 0, @updatedAt)
  `);
  // Mirrors the fixture's own `nodes_ai` trigger body exactly (same
  // columns, same content-rowid convention) so the manual path and the
  // trigger-maintained path produce identical nodes_fts rows.
  const insertFts = db.prepare(`
    INSERT INTO nodes_fts (rowid, id, name, qualified_name, docstring, signature)
    VALUES (?, ?, ?, ?, NULL, NULL)
  `);

  let inserted = 0;
  for (const node of nodes) {
    const qualifiedName = node.qualifiedName ?? node.name;
    const info = insertNode.run({
      id: node.id,
      kind: node.kind,
      name: node.name,
      qualifiedName,
      filePath: node.filePath ?? '',
      language: node.language ?? 'magento-xml',
      updatedAt: now,
    });
    if (info.changes > 0) {
      inserted++;
      if (!ftsMaintainedByTrigger) {
        insertFts.run(info.lastInsertRowid, node.id, node.name, qualifiedName);
      }
    }
  }
  return inserted;
}

function insertEdges(db: Database.Database, edges: AugmentEdge[]): number {
  if (edges.length === 0) return 0;
  const insertEdge = db.prepare(`
    INSERT OR IGNORE INTO edges (source, target, kind, metadata, line, col, provenance)
    VALUES (@source, @target, @kind, @metadata, @line, @col, @provenance)
  `);

  let inserted = 0;
  for (const edge of edges) {
    const kind = remapEdgeKind(edge.type, edge.reason);
    const metadata = JSON.stringify({ ...edge.metadata, reason: edge.reason });
    const info = insertEdge.run({
      source: edge.sourceId,
      target: edge.targetId,
      kind,
      metadata,
      line: edge.line ?? null,
      col: edge.col ?? null,
      provenance: PROVENANCE,
    });
    inserted += info.changes;
  }
  return inserted;
}

function deleteProvenanceEdges(db: Database.Database): number {
  const info = db.prepare(`DELETE FROM edges WHERE provenance = ?`).run(PROVENANCE);
  return info.changes;
}

/**
 * Deletes minted nodes (kind in MINTED_NODE_KINDS) no longer referenced by
 * ANY remaining edge — run AFTER deleteProvenanceEdges, so a minted node
 * whose only edge was just deleted becomes eligible. Never touches a
 * codegraph-native node: those never carry a minted kind.
 */
function deleteOrphanedMintedNodes(db: Database.Database): number {
  const placeholders = MINTED_NODE_KINDS.map(() => '?').join(', ');
  const info = db
    .prepare(
      `DELETE FROM nodes
       WHERE kind IN (${placeholders})
         AND id NOT IN (SELECT source FROM edges UNION SELECT target FROM edges)`,
    )
    .run(...MINTED_NODE_KINDS);
  return info.changes;
}

/**
 * Idempotent full augment write: delete own-provenance edges, delete any
 * minted node left orphaned by that (no remaining edge references it), then
 * reinsert everything from `input` — all inside a single transaction so a
 * concurrent codegraph FS-watcher reindex cannot observe (or interleave
 * with) a half-applied state, and so a failure at any step rolls back the
 * whole cycle rather than leaving deletes applied without their reinserts.
 */
export function writeAugmentation(db: Database.Database, input: AugmentInput): WriteResult {
  const run = db.transaction((): WriteResult => {
    const edgesDeleted = deleteProvenanceEdges(db);
    const nodesDeleted = deleteOrphanedMintedNodes(db);
    const nodesInserted = upsertNodes(db, input.nodes);
    const edgesInserted = insertEdges(db, input.edges);
    return { edgesDeleted, nodesDeleted, nodesInserted, edgesInserted };
  });
  // busy_timeout (set in openWriterDb) already makes SQLite block/retry
  // internally for up to 5s before raising SQLITE_BUSY. This wraps that
  // with one application-level retry band for the (rare) case a codegraph
  // FS-watcher reindex holds the write lock past that window.
  return runWithBusyRetry(run);
}

function runWithBusyRetry<T>(fn: () => T, maxAttempts = 3): T {
  for (let attempt = 1; ; attempt++) {
    try {
      return fn();
    } catch (err) {
      const isBusy = (err as { code?: string } | undefined)?.code === 'SQLITE_BUSY';
      if (!isBusy || attempt >= maxAttempts) throw err;
    }
  }
}
