# Task 002: SQLite writer (replaces lbug-writer)

**Status**: completed
**Depends on**: 001
**Retry count**: 0

## Implementation Notes
- `augmenter/src/writer/sqlite-writer.ts` (new file, not vendored) implements the writer. Runtime: better-sqlite3, justified in a top-of-file comment (synchronous API for single-transaction atomicity; already a repo dep; native-ABI in-container caveat noted for task 010).
- Fixture DB characterized before writing tests: `nodes` table has NO `provenance` column (only `edges` does) — minted-node ownership is identified by `kind IN ('event','route','template','external')`, matching docs/edge-taxonomy.md's "Node kinds" section, not a schema column.
- Fixture DB's `nodes_fts` DOES carry `nodes_ai`/`nodes_au`/`nodes_ad` AFTER-INSERT/UPDATE/DELETE triggers (verified via `sqlite_master`). The writer detects trigger presence per-write and only performs manual `INSERT INTO nodes_fts` when no such trigger exists (tested against a trigger-stripped copy of the fixture DB, in addition to the real trigger-carrying fixture).
- Idempotent write cycle order (all inside one `db.transaction()`): delete own-provenance edges -> delete now-orphaned minted nodes -> upsert nodes (`INSERT OR IGNORE`) -> insert edges (`INSERT OR IGNORE`, relies on the `(source,target,kind,IFNULL(line,-1),IFNULL(col,-1))` unique index). `openWriterDb` sets `busy_timeout=5000`; `writeAugmentation` wraps the transaction in one extra application-level SQLITE_BUSY retry band.
- Requirements 2, 3, 7, 8 passed on first run without new implementation — each was already satisfied by the code written for an earlier requirement (metadata serialization, `INSERT OR IGNORE` semantics, and the delete/reinsert transaction respectively); noted per requirement above rather than treated as silent over-implementation.
- Fixed a pre-existing test in `tests/vendoring.test.ts` (task 001's scope-boundary check): it asserted the whole `writer/` directory must not exist, which was only ever a stand-in for "the vendored `lbug-writer.ts` must not exist" — updated to check for that specific file so task 002's legitimate `writer/sqlite-writer.ts` re-implementation doesn't fail it.

## Description
Implement augmenter/src/writer/sqlite-writer.ts targeting codegraph's schema: node upserts (INSERT OR IGNORE by id; minted event/route/template/external nodes) and edge inserts honoring the unique index (source,target,kind,line,col), all rows provenance='pb-codegraph-augmenter'. Idempotency: augment run begins DELETE FROM edges WHERE provenance='pb-codegraph-augmenter' (and same for minted nodes not referenced elsewhere), then re-inserts — safe under repeat runs and after codegraph reindex wipes.

**Edge-shape mapping (critical — the vendored mappers emit a DIFFERENT shape; see _devils_advocate.md C2):** The writer's input edge type gains a `metadata: Record<string,unknown>` field. The writer owns the remap from the vendored `type`+`reason` strings to the LOCKED lowercase kinds, so magento edges never collide with codegraph-native kinds:
- `IMPLEMENTS` + reason `magento:di:preference` → kind `preference_for` (NOT native `implements`)
- `WRAPS` + `magento:di:plugin` → kind `wraps`, metadata {sortOrder, area}
- `CALLS` + `magento:events:observer:<event>` → kind `observes`, metadata {event, area}
- `CALLS` + `magento:layout:block-template` → kind `renders`
- `HANDLES_ROUTE` + `magento:webapi:route`/`magento:routes:controller` → kind `references`
The original `reason` is preserved as `metadata.reason`. `confidence` is dropped (always 1.0; dead in codegraph model).

**FTS5 (critical — see C6):** `nodes_fts` is content-linked. Minted event/route/template/external nodes MUST be made searchable — if the fixture DB's `nodes_fts` has no INSERT trigger, the writer maintains it explicitly (INSERT INTO nodes_fts(rowid,...) matching the node's rowid). `INSERT OR IGNORE` on a content table must not desync rowids. This is a hard requirement, not a documented afterthought.

**Concurrency (critical — see C5):** Open the DB with `PRAGMA busy_timeout` set (e.g. 5000ms), detect WAL journal mode, and retry writes on `SQLITE_BUSY`. Wrap the full delete+reinsert in a single transaction so codegraph's FS-watcher reindex cannot interleave a cascade-delete mid-write.

**Runtime (see I4):** Pick better-sqlite3 or node:sqlite and justify in a code comment. The chosen binding MUST load inside the ddev web container (where the shim runs), not just on the host — if better-sqlite3, note the native-ABI build requirement; if node:sqlite, note the minimum Node version. Add a smoke assertion that the binding opens the fixture DB.

## Context
- Schema (spike-verified): nodes(id TEXT pk, kind, name, qualified_name, file_path, language, start/end lines/cols, signature, visibility...), edges(source,target,kind,metadata JSON,line,col,provenance), FTS5 nodes_fts (content-linked)
- The writer defines the AugmentEdge/AugmentNode input types (gaining `metadata`); it does NOT mirror lbug-writer.ts's CSV/Cypher machinery — that was GitNexus-specific. Task 003b's adapted mappers produce the input; task 003's resolver produces the node ids.
- better-sqlite3 or node:sqlite — pick, justify in code comment (must load in-container, see Description)

## Requirements (Test Descriptions)
- [x] `it remaps vendored type+reason to the locked lowercase kinds so preference_for is distinct from native implements`
- [x] `it inserts edges with provenance and json metadata (reason, sortOrder, area, event) that survive readback` (covered by requirement-1's generic metadata serialization; no new code needed — passed on first run)
- [x] `it respects the unique edge identity index without erroring on duplicates` (covered by requirement-1's `INSERT OR IGNORE`; passed on first run)
- [x] `it upserts minted event/route/template/external nodes without clobbering codegraph-owned nodes`
- [x] `it makes minted nodes searchable via nodes_fts (maintains fts whether or not a trigger exists)` (fixture DB characterized: `nodes_ai`/`nodes_au`/`nodes_ad` triggers ARE present via `sqlite_master`; test exercises both the trigger-present path and a trigger-stripped copy to force the manual-maintenance code path)
- [x] `it deletes only own-provenance rows (edges and orphaned minted nodes) on idempotent re-run`
- [x] `it leaves node counts and codegraph native edges untouched across a full delete-reinsert cycle` (covered by requirement-6's delete/reinsert transaction; passed on first run)
- [x] `it sets busy_timeout and completes the delete+reinsert in a single transaction` (covered by `openWriterDb`'s pragma + better-sqlite3's `db.transaction()` atomic rollback-on-throw; passed on first run)
- [x] `it opens the fixture db with the chosen sqlite binding (runtime smoke)` (better-sqlite3, justified in code comment at top of augmenter/src/writer/sqlite-writer.ts)

## Acceptance Criteria
- Unit tests run against the task-001 fixture DB
