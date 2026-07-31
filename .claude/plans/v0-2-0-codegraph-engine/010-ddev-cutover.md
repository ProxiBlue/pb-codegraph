# Task 010: ddev integration + mcp.json entry + health probe

**Status**: completed
**Depends on**: 004, 007, 009
**Retry count**: 0

## Description
Per-project integration replacing the gitnexus container: docs + templates for (a) project index layout (custom app/code + vendor-split DB per the 009 ignore template — shared cores excluded, 3rd-party vendor included), (b) registry file generation (project + core DBs), (c) mcps/.mcp.json gitnexus-mageos entry swap: http url → stdio command launching the shim (containers reach central core DBs via existing mount conventions — document mount addition for ~/.pb-codegraph/indexes read-only).

**Runtime/path reality to pin (critical — see _devils_advocate.md I4):**
- Where indexing runs: the shim runs IN the ddev web container (stdio spawned by in-container claude). State explicitly whether `pb-codegraph index` (which invokes `npx @colbymchenry/codegraph`) runs in-container or on host, and confirm node/npx availability there.
- Registry `db_path` values are CONTAINER paths (the mount point of `.codegraph/` and of `~/.pb-codegraph/indexes`), never host paths.
- The read-only core-index mount is a `.ddev` config edit → FLEET LIVE-BRANCH RULE applies: verify the project is on its LIVE-equivalent branch before writing any `.ddev`/mcp/registry file; if not, stop and list offenders (do not proceed).
- If task 002 chose better-sqlite3 (native), confirm its ABI is built for the container's node; document the fallback (node:sqlite) if not.

Probe compat: pre-flight-check/wire currently curl :4747 — for v0.2.0 ship `pb-codegraph health` CLI returning 0/JSON (non-green when any repo's augmenter marker is stale) and NOTE the pb-hcf wire/pre-flight probe update as an explicit cross-plugin follow-up in docs/cutover.md (do NOT edit pb-hcf from this plan).

## Requirements (Test Descriptions)
- [x] `it documents the full pps cutover sequence including rollback (gitnexus containers stopped not removed)` — docs/cutover.md sections "Full pps cutover sequence" + "Rollback". Test: tests/cutover-docs.test.ts.
- [x] `it ships a registry template with container-path db entries covering project plus core repos` — templates/registry.template.json (mageos/hyva/deps + placeholder project entry, all container paths, no host paths). Test: tests/registry-template.test.ts.
- [x] `it documents where indexing runs and confirms node/npx availability there` — docs/cutover.md section "1. Where indexing runs" (project index in-container, cores on host; node/npx/better-sqlite3-ABI check commands). Test: tests/cutover-docs.test.ts.
- [x] `it requires a LIVE-branch check before any .ddev/mcp/registry edit` — docs/cutover.md section "0. Pre-flight: LIVE-branch check". Test: tests/cutover-docs.test.ts.
- [x] `it provides a health command usable as the new wire probe that reports non-green on stale augmenter markers` — `pb-codegraph health [--registry <path>]` in augmenter/src/cli.ts; JSON `{status, repos}` to stdout via io.log, exit 0 (green) / EXIT_HEALTH_NOT_GREEN=1 (non-green: any repo not ok, or augmenter_status !== 'fresh') / EXIT_DB_ERROR=2 (registry itself unloadable). Test: tests/health-cli.test.ts.
- [x] `it documents the read only core-index mount for ddev containers` — docs/cutover.md section "4. Read-only core-index mount for ddev containers" (.ddev/docker-compose.pb-codegraph.yaml, env-driven PB_CODEGRAPH_INDEX_DIR, :ro). Test: tests/cutover-docs.test.ts.
- [x] `it documents the per-project vendor-split index (cores excluded, 3rd-party vendor included)` — docs/cutover.md section "3. Per-project vendor-split index". Test: tests/cutover-docs.test.ts.
- [x] `it flags the pb-hcf probe update as cross-plugin follow-up without editing pb-hcf` — docs/cutover.md "Follow-up" subsection; verified via git status that no pb-hcf path was touched. Test: tests/cutover-docs.test.ts.

## Acceptance Criteria
- Followed end-to-end on pps in task 011

## Post-001 caveat (2026-07-31, orchestrator)
Task 001 discovered codegraph SILENTLY ignores directories named `Vendor`/`vendor` ("No files found to index", zero error). MUST verify in this task: (a) core-index exports (009) — check the archive layout doesn't retain a `vendor/` path prefix, else core DBs index nothing; assert node counts > 0 per core DB as an explicit requirement of the cutover doc; (b) project vendor-split DB — indexing project `vendor/` requires either export-with-stripped-prefix or codegraph ignore-config override (test which works); document the chosen mechanism.

**Resolved (2026-07-31):** verified empirically against the REAL pps checkout's `vendor/hyva-themes` (not just the synthetic fixture 009's tests use) — `scripts/build-core-indexes.sh --source ~/workspace/uptactics/pvcpipesupplies --branch live --only hyva --limit 200` produced `419 nodes, 525 edges` (`Indexed 53 files`, not "No files found to index"). sqlite readback confirmed `nodeCount.c = 419 > 0` and every sampled node's `qualified_name` retained the full `vendor/hyva-themes/...` prefix — the archive export does NOT strip the `vendor/` prefix. Mechanism confirmed: a root **`.gitignore` negation** (`!vendor/`) restores `vendor/*` visibility; a bare `codegraph.json` include list does not (codegraph's built-in default-ignore for `vendor/` wins regardless of ignore-config). Full record: `docs/vendor-dir-verification.md`. Automated regression: `tests/build-core-indexes.test.sh::test_real_pps_hyva_vendor_node_counts` (skips cleanly off Lucas's box via `PB_CODEGRAPH_TEST_PPS_ROOT`). pps working tree was verified untouched (`git status --porcelain` empty before/after).

## Implementation Notes

- `pb-codegraph health [--registry <path>]` added to `augmenter/src/cli.ts` (dispatches before `parseArgs`, which is augment/index-specific). Reuses `mcp/src/registry.ts` (`loadRegistryFromPath`/`loadRegistryFromEnv`) and `mcp/src/repo-status.ts` (`listRepoStatuses`) — no new registry/status logic duplicated. Exit codes: `EXIT_OK` (green), `EXIT_HEALTH_NOT_GREEN=1` (any repo not `ok` or not `augmenter_status: 'fresh'`), `EXIT_DB_ERROR=2` (registry itself unloadable). Tests: `tests/health-cli.test.ts`.
- `templates/registry.template.json`: three core entries (`mageos`/`hyva`/`deps`, container paths under `/mounts/pb-codegraph-core/`) plus one `<project-name>` placeholder entry (`/var/www/html/.codegraph/codegraph.db` — the fixed ddev web-container approot convention, so no per-project path templating is needed, only the registry KEY changes per project). Tests: `tests/registry-template.test.ts`.
- `docs/cutover.md`: full runbook (pre-flight LIVE-branch check, indexing-location/node-npx/better-sqlite3-ABI pinning, registry generation, per-project vendor-split application, read-only core-index mount via a new `.ddev/docker-compose.pb-codegraph.yaml`, the full pps cutover sequence, rollback (stop-not-remove), health probe usage, and the pb-hcf cross-plugin follow-up flag). Tests: `tests/cutover-docs.test.ts`.
- `docs/vendor-dir-verification.md`: evidentiary record (real host paths/output, not a template) of the Post-001 empirical check — see "Resolved" note above.
- No file under any pb-hcf location was touched (verified via `git status --porcelain` in the pb-hcf-follow-up test); pps's working tree was verified untouched by the vendor-dir smoke build.
