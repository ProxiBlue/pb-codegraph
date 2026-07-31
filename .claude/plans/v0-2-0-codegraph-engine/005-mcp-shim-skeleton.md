# Task 005: MCP shim — server skeleton + registry + list_repos

**Status**: completed
**Depends on**: none
**Retry count**: 0

## Description
Start mcp/ server (node, stdio MCP; @modelcontextprotocol/sdk) named for fleet compat. Registry config file (JSON, path via env PB_CODEGRAPH_REGISTRY) maps repo names → {db_path, description}: e.g. m2_pvcpipesupplies → /path/.codegraph/codegraph.db, mageos/hyva/deps → shared central DBs. Tool list_repos returns names + node/edge counts + last indexed_at + augmenter marker status per repo.

## Context
- Fleet contract: server must be usable under the fleet's existing legacy mcps/.mcp.json server key (stdio command entry replaces the http url entry at cutover — task 010)
- Multi-db: open read-only (SQLITE_OPEN_READONLY) — shim never writes except optional re-augment trigger note (defer actual re-augment exec to wrapper; shim only WARNS in v0.2.0 — keep it read-only, simpler)
- Read-only connections must still set `busy_timeout` and be WAL-aware (codegraph may be mid-reindex; see _devils_advocate.md C5) so a concurrent codegraph write doesn't error the read.
- **Registry paths are CONTAINER-visible paths (see I4):** the shim runs inside the ddev web container (stdio spawned by in-container claude). Project DB path = the container mount of `.codegraph/codegraph.db`; core DB paths = the container mount point of `~/.pb-codegraph/indexes` (host path is NOT valid in-container). Task 010 pins the mount; task 005 only requires the registry loader treat `db_path` as an already-resolved container path and fail clearly if unreadable.

## Requirements (Test Descriptions)
- [x] `it loads the registry and opens each db read only` — `mcp/src/registry.ts` (`loadRegistryFromPath`/`loadRegistryFromEnv`) + `mcp/src/db.ts` (`openReadOnlyDb`, `readonly:true`+`busy_timeout`). Test: `tests/mcp-registry.test.ts`.
- [x] `it lists repos with node and edge counts and index timestamps` — `mcp/src/repo-status.ts` (`getRepoStatus`/`listRepoStatuses`), counts via `nodes`/`edges`, `indexed_at` via `MAX(files.indexed_at)`. Test: `tests/mcp-list-repos-counts.test.ts`.
- [x] `it reports augmenter staleness status per repo` — reads `project_metadata` keys `pb_augmenter_run_at`/`pb_augmenter_files_indexed_at` (keys owned by task 004's writer; shim only reads); `never-run` when absent, `stale` when the snapshot is older than current `files.indexed_at`, else `fresh`. Test: `tests/mcp-list-repos-staleness.test.ts`.
- [x] `it survives a registry entry pointing at a missing db with a per-repo error not a crash` — `getRepoStatus`'s try/catch (built during the previous requirement) already isolates failures per repo; this test passed immediately with no new implementation code — noting the over-coverage rather than forcing an artificial change. Test: `tests/mcp-list-repos-error-isolation.test.ts`.

## Acceptance Criteria
- [x] MCP handshake + list_repos verified via a scripted stdio client test — `tests/mcp-stdio-handshake.test.ts` spawns `mcp/bin/server.ts` via `node --import tsx` and drives it with `@modelcontextprotocol/sdk`'s `Client`/`StdioClientTransport`.

## Implementation Notes

**Layout** (mirrors `augmenter/src/{parsers,resolvers}`): `mcp/src/registry.ts` (registry
loader, `PB_CODEGRAPH_REGISTRY` env), `mcp/src/db.ts` (read-only sqlite opener,
`busy_timeout`), `mcp/src/repo-status.ts` (`getRepoStatus`/`listRepoStatuses` — per-repo
try/catch isolation, node/edge counts, `MAX(files.indexed_at)`, augmenter marker read),
`mcp/src/server.ts` (`McpServer`, tool `list_repos`, server name pinned to fleet-compat
the legacy fleet server key), `mcp/bin/server.ts` (stdio entrypoint). Added deps: `@modelcontextprotocol/sdk`
(^1.30.0), `zod` (^4.0.0, sdk peer — declared explicitly rather than relying on hoisting).
`tsconfig.json` `include` extended with `mcp/**/*`.

**Registry semantics:** `loadRegistryFromPath`/`loadRegistryFromEnv` require a non-empty
`db_path` string per entry; missing/unset env var, missing file, invalid JSON, and malformed
entries all throw actionable errors naming the offending path/key (no baked-in absolute host
path — matches I4/container-path pinning).

**Augmenter staleness (v0.2.0 shim is READ-ONLY, so this task only *reads* the marker task 004
will write):** `project_metadata` keys `pb_augmenter_run_at` / `pb_augmenter_files_indexed_at`
(names taken from task 004's own spec text, which already commits to them). No marker rows →
`never-run` (honest "not yet augmented" state, not an error). Marker present and its
`files_indexed_at` snapshot >= current `MAX(files.indexed_at)` → `fresh`. Snapshot older than
current → `stale` (codegraph reindexed since the last augment ran, cascade-wiping injected
edges per `_devils_advocate.md` C5). This is a soft/report-only signal in list_repos per this
task's scope; the LOUD non-authoritative banner + strict-fail behavior for `impact` is task
007's job (per the parent instructions and `_plan.md` Architecture Notes).

**Test isolation (why `tests/helpers/isolated-fixture-db.ts` exists):** `node --test` runs
test files in parallel by default, and `tests/build-fixture-db.test.ts` unconditionally
`rm -rf`s + rebuilds the shared `tests/fixture/.codegraph/` output on every run. Since the mcp
tests need read/write access to `project_metadata` (to seed staleness scenarios) against a
live codegraph db, they build their own private copy per test (temp dir, copy of
`tests/fixture/app`, `npx @colbymchenry/codegraph@1.5.0 init`) instead of sharing that path —
avoiding a real race rather than a theoretical one. Test files: `tests/mcp-registry.test.ts`,
`tests/mcp-list-repos-counts.test.ts`, `tests/mcp-list-repos-staleness.test.ts`,
`tests/mcp-list-repos-error-isolation.test.ts`, `tests/mcp-stdio-handshake.test.ts` — all flat
under `tests/` (unchanged `tests/*.test.ts` glob per `.claude/testing.md`).

**Requirement 4 note:** `it survives a registry entry pointing at a missing db with a per-repo
error not a crash` passed on first run with no new implementation — the try/catch built into
`getRepoStatus` for requirement 2/3 already provided per-repo isolation. Documented as
over-coverage from a prior step rather than forcing an artificial code change.

**Unrelated transient failure observed and ruled out:** a `tsc`/full-suite run mid-session
showed `tests/vendoring.test.ts` failing (`writer/ must not exist` assertion). `git diff
--stat HEAD` confirmed this task's session touched only `mcp/**`, `tests/mcp-*.test.ts`,
`tests/helpers/isolated-fixture-db.ts`, `package.json`, `tsconfig.json`, and this task file.
`stat` on `augmenter/src/writer/sqlite-writer.ts` and `tests/vendoring.test.ts` showed both
had `mtime` seconds before the failing run, from a concurrently-running sibling task (002,
still `pending` in its task file at that moment) editing the same working tree in parallel
orchestration. Re-run seconds later was green with no changes from this session — confirmed
not caused by task 005's work.

**Full suite at completion:** `npx tsc --noEmit` clean; `node --test --import tsx
tests/*.test.ts` → 20/20 passing; JSON check clean; secrets grep clean (the only hit is
`.claude/testing.md`'s own line documenting the grep pattern, a pre-existing self-reference,
not a real secret).
