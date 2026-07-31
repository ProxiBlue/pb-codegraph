# Task 007: MCP shim — impact + query templates

**Status**: pending
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
- [ ] `it returns the wrapping plugin in impact of a plugin target method`
- [ ] `it returns observers via impact/context starting from an event node`
- [ ] `it returns observers of a named event via the observers_of_event query template`
- [ ] `it follows preference redirection in both directions`
- [ ] `it caps depth and annotates each result with its edge path`
- [ ] `it emits a loud non-authoritative banner and flags non-green when the augmenter marker is stale`
- [ ] `it fails (not warns) in strict mode when the marker is stale`
- [ ] `it executes each documented query template against the fixture`

## Acceptance Criteria
- All traversal tests green on fixture; cookbook maps every old cypher example
