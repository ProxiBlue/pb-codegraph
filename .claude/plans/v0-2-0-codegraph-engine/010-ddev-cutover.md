# Task 010: ddev integration + mcp.json entry + health probe

**Status**: pending
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
- [ ] `it documents the full pps cutover sequence including rollback (gitnexus containers stopped not removed)`
- [ ] `it ships a registry template with container-path db entries covering project plus core repos`
- [ ] `it documents where indexing runs and confirms node/npx availability there`
- [ ] `it requires a LIVE-branch check before any .ddev/mcp/registry edit`
- [ ] `it provides a health command usable as the new wire probe that reports non-green on stale augmenter markers`
- [ ] `it documents the read only core-index mount for ddev containers`
- [ ] `it documents the per-project vendor-split index (cores excluded, 3rd-party vendor included)`
- [ ] `it flags the pb-hcf probe update as cross-plugin follow-up without editing pb-hcf`

## Acceptance Criteria
- Followed end-to-end on pps in task 011
