# Task 004: Augment CLI + wrapper index + staleness marker

**Status**: completed
**Depends on**: 002, 003, 003b
**Retry count**: 0

## Description
Ship bin/pb-codegraph (node CLI): `augment <project-root> [--db <path>]` runs parsers→resolver→sqlite-writer over the Magento tree (area-merge semantics preserved from vendored augment.ts); `index <project-root>` = codegraph index && augment (the cascade-wipe answer). Augment writes staleness marker into project_metadata (key pb_augmenter_run_at + pb_augmenter_files_indexed_at snapshot of max(files.indexed_at)) — the MCP shim (task 007) compares and warns/re-augments when codegraph re-synced since last augment.

## Context
- augment.ts orchestration is the reference; keep its parser ordering + area handling (the adapted mappers from 003b are what it now calls)
- No daemon; watcher-based auto-sync means marker check happens at query time in shim
- Exit codes: 0 ok, 1 augment error, 2 db missing/unknown schema

**Watcher race guard (critical — see _devils_advocate.md C5):** codegraph's FS watcher can reindex (cascade-deleting injected edges) DURING an augment run. The augment command captures `max(files.indexed_at)` immediately before writing and re-reads it immediately after; if it advanced, a reindex interleaved → the just-written edges may be partially wiped → re-run the augment (bounded retry, e.g. 2 attempts) before recording the staleness marker. The staleness marker's `pb_augmenter_files_indexed_at` snapshot is taken AFTER the confirmed-stable write. Document that `pb-codegraph index` is the authoritative writer and that relying on the bare watcher (no re-augment) leaves the graph magento-blind until the next wrapper index.

## Requirements (Test Descriptions)
- [x] `it augments the fixture project producing all six edge families with correct counts` — tests/augment-orchestration.test.ts. Ground truth counts characterized against a real `codegraph init` run over tests/fixture/app: preference_for=1, wraps=2, observes=2, renders=1, references=1 (webapi only — routes.xml mints a route node but never an edge per docs/edge-taxonomy.md's "Route honesty note"; asserted via `result.families.routes.routesMinted === 1`), total edges=7.
- [x] `it records the staleness marker pair in project_metadata` — tests/augment-orchestration.test.ts, reusing mcp/src/augmenter-marker.ts's exported key constants (no second literal).
- [x] `it is idempotent across three consecutive runs with identical final row counts` — tests/augment-orchestration.test.ts.
- [x] `it re-injects edges after a codegraph reindex wiped them` — tests/augment-orchestration.test.ts (simulated wipe via direct SQL matching the FK-cascade shape a real `codegraph index` produces — verified empirically against a real codegraph db during implementation) + the mandatory e2e fixture test (tests/augment-e2e.test.ts) exercises the REAL `codegraph index` cascade-wipe end to end.
- [x] `it re-runs augment when files.indexed_at advances mid-run (watcher race) before recording the marker` — tests/augment-orchestration.test.ts, via the `onAfterWrite` test-only seam on `runAugment`'s options (never used outside tests).
- [x] `it exits 2 with clear message on missing or unknown-schema db` — tests/augment-cli.test.ts, at the actual CLI `main()` exit-code level (augmenter/src/cli.ts).

## Acceptance Criteria
- [x] End-to-end fixture test: index → augment → reindex → wrapper index → counts match — tests/augment-e2e.test.ts, spawning the real bin/pb-codegraph.ts CLI and the real pinned codegraph binary (no simulation).

## Implementation Notes
- `bin/pb-codegraph.ts` is a thin shebang entrypoint (`#!/usr/bin/env -S node --import tsx`); all argument parsing + exit-code mapping lives in `augmenter/src/cli.ts`'s `main(argv, io)` (never calls `process.exit` itself) so tests can call it in-process — mirrors the existing `mcp/bin/server.ts` (thin entry) vs `mcp/src/server.ts` (logic) split. `package.json` gained a `"bin": { "pb-codegraph": "bin/pb-codegraph.ts" }` entry.
- `augmenter/src/augment.ts` holds the orchestration (`runAugment`, `runIndexAndAugment`): merges the five 003b mapper phases (di.xml, layout xml, events.xml, webapi.xml, routes.xml) in the vendored augment.ts's original order, with the same best-effort per-phase error handling (one phase failing logs a warning and contributes zero edges/nodes rather than aborting the run).
- Ground-truth edge/node counts for `tests/fixture/app` were characterized empirically against a real `codegraph init`/`index` run during implementation (not assumed): preference_for=1, wraps=2, observes=2, renders=1, references=1 (webapi only — routes.xml mints 1 route node but 0 edges, a documented v0.2 limitation), 7 edges / 6 minted nodes total. The same run confirmed `codegraph index --force` genuinely cascade-deletes every augmenter-owned edge (FK `ON DELETE CASCADE`), validating the premise the watcher-race guard exists for.
- Staleness marker: reuses `mcp/src/augmenter-marker.ts`'s exported `AUGMENTER_RUN_AT_KEY` / `AUGMENTER_FILES_INDEXED_AT_KEY` constants and `readCurrentFilesIndexedAt()` (no duplicate literal/query) — that module already documented task 004 as the intended writer of those `project_metadata` keys.
- Watcher-race guard: `runAugment` takes an optional `maxAttempts` (default 2) and a test-only `onAfterWrite` hook (never invoked outside tests) used to simulate a codegraph reindex landing between a write completing and the post-write `files.indexed_at` re-check.
- `runIndexAndAugment` picks `codegraph init --force` vs `codegraph index --force` based on whether `<project-root>/.codegraph` already exists, always via `shared/pinned.ts`'s `PINNED_CODEGRAPH_PACKAGE` (no second version literal).
- Exit codes verified at the actual CLI level (`augmenter/src/cli.ts`'s `main()`): 0 ok, 1 augment/usage error, 2 `DbNotFoundError` (missing db) or `UnsupportedSchemaError` (unknown schema) — both actionable messages naming the path/pinned version.
