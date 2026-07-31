# Task 003: Node-id resolver adaptation

**Status**: pending
**Depends on**: 001, 002
**Retry count**: 0

## Description
REWRITE (not adapt — the vendored resolvers/node-id.ts is filesystem/synthetic-id based and never queries a DB; see _devils_advocate.md C1). New DB-backed resolver: resolve Magento FQCNs (from XML) to existing codegraph nodes via qualified_name lookup (normalize namespace separators, codegraph uses e.g. 'Uptactics\PpsTheme\Block\Product\View::Attributes' shapes — verify against fixture), method-level targets to method nodes where present, fall back to class node. Unresolved targets (class in another repo/db or not indexed) → minted placeholder node kind 'external' (id `magento:external:<normalized-fqcn>`) with qualified_name, so edges never dangle.

**File-endpoint resolution (critical — see C3):** 4 of 6 vendored edge families produce `File:<relpath>` endpoints (observer, layout source; routes/webapi source) that have NO codegraph node. The resolver must map `File:<relpath>` → the class/symbol node defined in that file (query nodes by file_path). Special cases: `events.xml` and `routes.xml` are XML, not PHP — they have no code node at all, so the observer source is NOT the events.xml file but a MINTED `event` node (`magento:event:<name>`), and route/template targets are minted nodes. The resolver exposes minting helpers for event/route/template/external node ids (deterministic, stable across runs).

**Dedup / reconciliation (see I2):** external/minted ids MUST be deterministic from the NORMALIZED qualified_name so re-runs are stable and cannot double-mint. The resolver checks native codegraph nodes FIRST on every call — a symbol that codegraph has since indexed supersedes any prior `external` placeholder (which task 002's own-provenance delete then reaps).

## Context
- Spike observation: node ids are 'class:<md5-ish>' and qualified_name uses '\' with '::' separator quirks — task must characterize exact format from fixture DB first (write the characterization test FIRST)
- psr4-map.ts resolver vendored in 001 helps map file paths

## Requirements (Test Descriptions)
- [ ] `it characterizes codegraph qualified_name format for classes and methods from the fixture`
- [ ] `it resolves an fqcn from di xml to the indexed class node id`
- [ ] `it resolves a class method target to the method node when indexed`
- [ ] `it resolves a File:relpath endpoint to the class node defined in that file`
- [ ] `it mints deterministic event, route, and template node ids`
- [ ] `it mints a stable external placeholder node for unresolved targets and returns the same id across repeat runs`
- [ ] `it prefers an existing native node over minting when the symbol is now indexed`
- [ ] `it never produces an edge whose source or target is missing from nodes`

## Acceptance Criteria
- Resolution hit-rate over fixture = 100%; unresolved path covered by explicit test
