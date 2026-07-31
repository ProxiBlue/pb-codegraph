# Task 004: Augment CLI + wrapper index + staleness marker

**Status**: pending
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
- [ ] `it augments the fixture project producing all six edge families with correct counts`
- [ ] `it records the staleness marker pair in project_metadata`
- [ ] `it is idempotent across three consecutive runs with identical final row counts`
- [ ] `it re-injects edges after a codegraph reindex wiped them`
- [ ] `it re-runs augment when files.indexed_at advances mid-run (watcher race) before recording the marker`
- [ ] `it exits 2 with clear message on missing or unknown-schema db`

## Acceptance Criteria
- End-to-end fixture test: index → augment → reindex → wrapper index → counts match
