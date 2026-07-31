# Task 006: MCP shim — find_symbol + context

**Status**: completed
**Depends on**: 005
**Retry count**: 0

## Description
find_symbol(name|qualified_name, repo?): exact qualified_name lookup first, then FTS5 nodes_fts match, ranked; returns file_path, lines, signature, kind, repo. context(symbol, repo?): the node + one-hop neighbors both directions across ALL edge kinds (native + magento), grouped by edge kind, with metadata surfaced (sortOrder/area/event).

## Context
- Federation: repo omitted → query every registry db, merge, tag results with repo (RRF-lite: exact matches first, then per-db FTS rank)
- Output shapes should read like the old GitNexus responses enough that agents' habits keep working (name, path, signature prominent)

## Requirements (Test Descriptions)
- [x] `it finds a class by exact qualified name in a named repo`
- [x] `it finds symbols by partial name via fts across all repos when repo omitted`
- [x] `it finds a minted route or event node via fts (validates 002 fts maintenance)`
- [x] `it returns context neighbors grouped by edge kind including magento kinds (preference_for, wraps, observes, renders, references)`
- [x] `it surfaces plugin sortorder and observer event metadata in context output`

## Acceptance Criteria
- Tests against fixture DB incl. injected magento edges

## Implementation Notes
- `mcp/src/find-symbol.ts`: `findSymbol(registry, { query, repo? })` — exact
  match on `id`/`qualified_name`/`name` first, then an FTS5 prefix query
  (tokenized on non-alphanumeric boundaries, each token quoted + `*`-suffixed
  so free-text input can never throw an FTS5 syntax error) against
  `nodes_fts` joined back to `nodes` via `rowid`, `ORDER BY rank`. Federation:
  repo omitted -> iterates every registry entry, per-repo open/query errors
  are collected into `errors` (never thrown), matches merged exact-tier
  first then fts-tier (RRF-lite). Result cap `FIND_SYMBOL_RESULT_CAP = 50`
  with `truncated` + `total_matches` on the response so a cap is never
  silent (code-standards.md).
- `mcp/src/context.ts`: `getContext(registry, { symbol, repo? })` — resolves
  the target node with the same id/exact/fts strategy (fts top-1 by rank),
  then a `UNION ALL` query over `edges` for outgoing (`source = node`) and
  incoming (`target = node`) one-hop neighbors across every edge kind
  (native + the 5 locked magento kinds), grouped into `neighbors[kind]`.
  Edge `metadata` JSON column is parsed (not left as an opaque string) so
  `sortOrder`/`area`/`event`/`reason` are directly readable.
- `mcp/src/server.ts`: registered `find_symbol` and `context` tools
  additively, each in its own clearly delimited `// --- tool: X ---` /
  `// --- end tool: X ---` block per the coordination note (task 007 adds
  `impact`/`query` alongside without touching these blocks).
- Test fixtures: `tests/helpers/inject-magento-edges.ts` (new shared helper)
  wraps `augmenter/src/writer/sqlite-writer.ts`'s real `writeAugmentation`
  so injected magento nodes/edges in tests match production remap/provenance
  semantics exactly, rather than hand-rolled INSERTs.
- 6 new test files added (5 requirement tests + 1 stdio wiring smoke test
  `mcp-stdio-find-symbol-context.test.ts` verifying the zod inputSchema +
  callback plumbing end-to-end, mirroring `mcp-stdio-handshake.test.ts`'s
  pattern for `list_repos`).
- Full-suite run showed 2 pre-existing failures unrelated to this task and
  not touched by it: `tests/node-id-resolver.test.ts` (4 subtests) fails
  only when racing `tests/build-fixture-db.test.ts`'s destructive rebuild of
  the SHARED `tests/fixture/.codegraph/` path under `node --test`'s default
  parallel file execution — confirmed by running those two files alone
  (no race present), which passes 8/8; this is the exact race the
  `tests/helpers/isolated-fixture-db.ts` header comment already documents
  and all task-006 tests avoid by using `buildIsolatedFixtureDb()`.
  `tests/vendoring.test.ts` fails deterministically (with or without the
  race) asserting `augmenter/src/resolvers/node-id.ts` must NOT exist —
  stale from task 001, superseded by task 003 which intentionally added
  that file as "a DB-backed rewrite ... not vendored" (see the assertion's
  own message). Neither file was created or modified in this session
  (`git status --short` shows both as pre-existing untracked files); out of
  scope for task 006.
