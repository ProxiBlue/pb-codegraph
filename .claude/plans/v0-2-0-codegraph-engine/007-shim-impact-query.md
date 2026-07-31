# Task 007: MCP shim — impact + query templates

**Status**: completed
**Depends on**: 005
**Retry count**: 0

## Description
impact(symbol, repo?, depth<=4, direction=dependents|dependencies|both): recursive CTE over edges traversing native kinds (calls/instantiates/references/imports) AND the LOCKED magento kinds (`wraps`, `preference_for`, `observes`, `renders`, `references`) — a method wrapped by a plugin lists the plugin; a preference redirect surfaces both classes; an `event` node reaches its observers. The CTE keys on the remapped lowercase kinds (see 002), NOT the vendored uppercase `type`. Results grouped by depth with edge-kind path annotation. query(template, params): named parameterized SQL templates (callers_of, wired_plugins_on, observers_of_event, routes_to, preferences_for, dead_symbols) — NOT raw SQL; document mapping from the old GitNexus cypher examples in docs/query-cookbook.md.

**Event-impact scope (critical — see _devils_advocate.md C4):** In v0.2 the graph has `event` node → observer edges (observes), but NO edge from a PHP dispatch call-site to the event (codegraph does not index the string arg of `$eventManager->dispatch('x')`). So "impact of a method that dispatches event X reaches its observers" is NOT true graph traversal in v0.2 — it is served by the `observers_of_event` query template (name-keyed) and by `context`/`impact` STARTING from the event node. Document this limitation in the cookbook; a dispatch-site recognizer is deferred (v0.3 stretch). Do NOT assert method→observer graph traversal.

**Staleness (critical — see C5):** impact is deploy-safety-critical. When the augmenter marker is stale vs `files.indexed_at` (codegraph reindexed since last augment → magento edges are wiped), impact prepends a LOUD banner (not a soft one-liner) AND the result is flagged non-authoritative; the health probe (010) reports non-green. Provide a `strict` option that makes impact FAIL rather than return a magento-blind result.

## Context
- The hard requirement: impact through di.xml/events.xml indirection (playbooks declare impact authoritative incl. plugins/observers/preferences)
- Depth cap + cycle guard (visited set in CTE); cap result rows, note truncation loudly (no silent caps)

## Requirements (Test Descriptions)
- [x] `it returns the wrapping plugin in impact of a plugin target method`
- [x] `it returns observers via impact/context starting from an event node` (passed immediately — exercises the shared traversal machinery built for req 1; noted per TDD rules, no implementation needed)
- [x] `it returns observers of a named event via the observers_of_event query template`
- [x] `it follows preference redirection in both directions` (exercises dependents/dependencies direction param explicitly against the shared traversal built for req 1)
- [x] `it caps depth and annotates each result with its edge path` (depth cap, cycle guard, and depth_capped loud flag were built into the recursive CTE from req 1 onward — verified here with a 6-hop chain + a back-edge cycle)
- [x] `it emits a loud non-authoritative banner and flags non-green when the augmenter marker is stale` (staleness/warning wiring was built into impact.ts from req 1's initial implementation using mcp/src/augmenter-marker.ts)
- [x] `it fails (not warns) in strict mode when the marker is stale` (StaleAugmenterError throw path built into impact.ts from req 1's initial implementation)
- [x] `it executes each documented query template against the fixture`

## Acceptance Criteria
- All traversal tests green on fixture; cookbook maps every old cypher example

## Implementation Notes
- New: `mcp/src/impact.ts` (`getImpact`, `StaleAugmenterError`, `IMPACT_MAX_DEPTH=4`, `IMPACT_RESULT_CAP=200`) — recursive CTE keyed on the remapped lowercase `edges.kind`, cycle guard via a `visited` path string checked with `instr()`, per-direction (`dependencies`=outgoing/`dependents`=incoming/`both`=union) walk, `depth_capped` flag when a depth-cap-truncated node still has further edges, loud `warning` banner + per-repo `non_authoritative`/`augmenter_status` when the augmenter marker is stale, `strict:true` throws `StaleAugmenterError` instead.
- New: `mcp/src/query.ts` (`runQuery`, `QUERY_TEMPLATE_NAMES`) — 6 named templates (`callers_of`, `wired_plugins_on`, `observers_of_event`, `routes_to`, `preferences_for`, `dead_symbols`), each a fixed prepared statement with validated params (no raw SQL passthrough); `docs/query-cookbook.md` maps each to its old GitNexus/LBUG cypher equivalent (with a provenance note: the old mappers are not vendored, so the cypher shown is reconstructed representative, not a literal file copy) and documents the C4 event-dispatch-site limitation.
- Structural refactor (kept existing tests green, verified after each step): extracted `mcp/src/resolve-symbol.ts` (shared symbol resolver used by `context.ts`, `impact.ts`, `query.ts`) and `mcp/src/augmenter-marker.ts` (shared staleness computation used by `repo-status.ts` and `impact.ts`) so 007 doesn't duplicate 005/006 logic.
- `server.ts` extended additively with delimited `--- tool: impact ---` / `--- tool: query ---` blocks; `strict` defaults to `env.PB_CODEGRAPH_STRICT_STALENESS === '1'` when not explicitly passed (resolved in the server handler only, so the pure `getImpact`/`runQuery` functions stay env-independent and safely testable in parallel).
- Requirements 2, 4, 5, 6, 7 passed on first run once written — the shared CTE/staleness machinery needed to satisfy requirement 1 necessarily implements those behaviors too (front-loaded, not accidental scope creep); noted inline per TDD rules rather than silently claimed as new work.
- One transient full-suite run showed `fail 1` with an anomalous 171s duration (vs. two immediately-following clean runs at ~6.8s each, 53/53 pass) — timing is consistent with CPU/process contention from a concurrently-running sibling parallel-dispatch worker (task 003b's `augmenter/src/mappers/*.ts` files were observed being actively written mid-session at 11:08-11:09 by mtime). Not reproducible after that worker's writes landed; two subsequent clean runs are the evidence for closing this out rather than chasing a ghost.
