# Changelog

## 0.2.0 — 2026-07-31

Deterministic codegraph engine, alongside the existing v0.1.0 LLM-driven impact check.

pb-codegraph now pins and augments the upstream
[`@colbymchenry/codegraph`](https://www.npmjs.com/package/@colbymchenry/codegraph)
tree-sitter indexer instead of relying purely on LLM reasoning. The v0.1.0
`/pb-codegraph:impact-check` command is retained unchanged as a fallback and
gains a graph-backend detection step so both modes ship in the same plugin.

- **Vendored augmenter foundation** — pure XML parsers and path resolvers
  (`di.xml`, `events.xml`, `layout.xml`, `routes.xml`, `webapi.xml`) vendored
  minimally from `mage-os-gitnexus` (Lucas's own prior MIT-licensed work,
  relicensed Apache-2.0 — see `NOTICE`); mappers, the writer, and the node-id
  resolver are new, DB-backed re-implementations, not vendored. Fixture
  Magento module tree + fixture codegraph db build script
  (`scripts/build-fixture-db.sh`, pinned `@colbymchenry/codegraph@1.5.0`).
- **SQLite writer** (`augmenter/src/writer/sqlite-writer.ts`) — remaps the
  vendored mappers' `type`+`reason` output to a LOCKED set of lowercase edge
  kinds (`preference_for`, `wraps`, `observes`, `renders`, `references`) so
  Magento wiring edges never collide with codegraph's own native `implements`/
  `calls` edges. Idempotent (delete-own-provenance-then-reinsert, single
  transaction, `busy_timeout`), maintains `nodes_fts` for minted nodes, every
  row tagged `provenance='pb-codegraph-augmenter'`.
- **DB-backed node-id resolver** (`augmenter/src/resolvers/node-id.ts`) —
  resolves di.xml/events.xml/layout/webapi/routes targets to real
  `nodes.id`/`qualified_name` values (or mints a stable `magento:external:...`
  placeholder for unresolved 3rd-party FQCNs), replacing the vendored
  filesystem-based resolver.
- **Magento mapper adaptation** (`augmenter/src/mappers/*.ts`) — di.xml
  preferences/plugins, events.xml observers, layout block→template rendering,
  webapi.xml and routes.xml route wiring, all resolved through the new
  DB-backed resolver and written through the new writer. See
  `docs/edge-taxonomy.md` for the locked kind/endpoint contract (direction
  correction for `preference_for` folded into this release — see below).
- **Augment CLI wrapper** (`bin/pb-codegraph.ts` / `augmenter/src/cli.ts`) —
  `pb-codegraph index`/`augment` orchestrates a `codegraph init`/`index` run
  followed by all five mapper phases, with a watcher-race guard (codegraph's
  own reindex can cascade-delete augmenter-owned rows mid-run) and a
  `pb-codegraph health` subcommand for registry-wide status checks.
- **MCP shim** (`mcp/bin/server.ts` / `mcp/src/*.ts`) — new stdio MCP server,
  served under the existing fleet-compat name `gitnexus-mageos` (drop-in
  replacement for the old GitNexus HTTP endpoint at cutover, no downstream
  agent/playbook rewiring needed). Tools:
  - `list_repos` — per-registry-entry status, node/edge counts, augmenter
    freshness, per-repo error isolation.
  - `find_symbol` — exact id/qualified_name/name match, then ranked FTS5
    prefix search, federated across every registered repo.
  - `context` — one-hop neighbor graph (native + all five magento edge
    kinds) for a resolved symbol, with parsed edge metadata.
  - `impact` — recursive, depth-capped (max 4) dependents/dependencies/both
    traversal across native and magento edge kinds; loud non-authoritative
    warning (or `strict` refusal) when the augmenter marker is stale
    relative to the last codegraph reindex.
  - `query` — six named, parameterized templates (`callers_of`,
    `wired_plugins_on`, `observers_of_event`, `routes_to`,
    `preferences_for`, `dead_symbols`) mapped to their old GitNexus/LBUG
    cypher equivalents in `docs/query-cookbook.md` — no raw SQL passthrough.
- **Schema guard** (`shared/schema-guard.ts`) — single
  `assertSupportedSchema` consumed by both the writer's and the shim's DB
  open paths; refuses with an actionable message (naming the pinned
  codegraph version and `docs/upgrading-codegraph.md`) on an unsupported
  schema version or a missing `provenance` column, rather than silently
  reading/writing a db it doesn't understand.
- **Core index build** (`scripts/build-core-indexes.sh`) — builds shared,
  read-only vendor-only codegraph indexes (mageos/hyva/deps) from a
  `.gitnexusignore`-derived `.gitignore`, scoped so a core index can never
  leak a source project's own tracked tree.
- **DDEV cutover tooling** — `pb-codegraph health` CLI subcommand,
  `templates/registry.template.json`, and `docs/cutover.md` (full runbook:
  pre-flight LIVE-branch check, core-index mount, registry generation,
  per-project vendor-split, MCP entry swap, rollback via container stop-not-
  remove).
- **pps acceptance run** (`docs/acceptance-report-pps-2026-07-31.md`,
  `scripts/acceptance-diff.sh`) — real GitNexus-vs-pb-codegraph comparison
  against 5 pvcpipesupplies symbols, safety-verified (pps working tree
  byte-identical before/after). **Status: data collected, AWAITING LUCAS
  SIGN-OFF** — this release does NOT cut pps (or any project) over and does
  NOT stop the GitNexus container; that decision remains Lucas's per
  `docs/cutover.md` step 9. One taxonomy gap surfaced by the run (native
  `references` edges are not augmenter-exclusive) is logged as a known
  limitation, not fixed in this release.
- **Upstream PR prep** (`docs/upstream-pr/`) — draft spec + implementation
  for contributing a Magento routing recognizer to upstream
  `colbymchenry/codegraph` (routes.xml + webapi.xml only). Nothing opened
  upstream; submission is Lucas's call.
- **`/pb-codegraph:impact-check` graph-backend detection** — the command now
  checks for `.codegraph/codegraph.db` first; when present it prefers the
  deterministic `find_symbol`/`context`/`impact`/`query` MCP tools for
  caller/DI-preference/plugin-chain/observer lookups, falling back to the
  original grep + `magento2-lsp` + LLM flow for table-write/cron-concurrency
  detection (no graph equivalent yet) and for projects with no index built.
- **Docs correction**: `docs/edge-taxonomy.md`'s `preference_for` endpoint
  direction was documented backwards in an earlier draft ("interface →
  concrete class"); corrected to match the shipped mapper implementation
  (source = concrete implementation class, target = interface/abstract
  class).

## 0.1.0 — 2026-06-24

Initial release.

- `/pb-codegraph:impact-check` — LLM-driven cross-module impact analysis for
  Magento 2 / Mage-OS, orchestrating grep, the `magento2-lsp` MCP server, and
  config XML reading with structured LLM reasoning. Detects direct callers,
  DI preference resolution, plugin chains, observer chains, table-write data
  flow, and cron-vs-cron concurrency hazards, with cited evidence and
  confidence levels per finding.
