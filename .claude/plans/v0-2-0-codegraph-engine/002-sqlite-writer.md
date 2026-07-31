# Task 002: SQLite writer (replaces lbug-writer)

**Status**: pending
**Depends on**: 001
**Retry count**: 0

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
- [ ] `it remaps vendored type+reason to the locked lowercase kinds so preference_for is distinct from native implements`
- [ ] `it inserts edges with provenance and json metadata (reason, sortOrder, area, event) that survive readback`
- [ ] `it respects the unique edge identity index without erroring on duplicates`
- [ ] `it upserts minted event/route/template/external nodes without clobbering codegraph-owned nodes`
- [ ] `it makes minted nodes searchable via nodes_fts (maintains fts whether or not a trigger exists)`
- [ ] `it deletes only own-provenance rows (edges and orphaned minted nodes) on idempotent re-run`
- [ ] `it leaves node counts and codegraph native edges untouched across a full delete-reinsert cycle`
- [ ] `it sets busy_timeout and completes the delete+reinsert in a single transaction`
- [ ] `it opens the fixture db with the chosen sqlite binding (runtime smoke)`

## Acceptance Criteria
- Unit tests run against the task-001 fixture DB
