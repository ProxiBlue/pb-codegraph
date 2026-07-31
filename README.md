# pb-codegraph

Cross-module impact analysis for Magento 2 / Mage-OS — detect what depends on the code you're about to change, *before* you ship.

The use case this plugin exists for: a real production incident where a cron schedule change would have clobbered 1000s of customer tax configurations on deploy. A code-graph tool detected that the cron and another module's importer wrote the same table, on schedules that would now overlap. Deploy was held; customers' data survived.

This plugin gives Claude Code that same capability — without the commercial-license dependency the prior tool carried.

## Status: v0.2.0 — deterministic codegraph engine + retained v0.1.0 LLM flow

v0.2.0 adds a real, deterministic code-graph backend alongside the original
v0.1.0 LLM-driven `/pb-codegraph:impact-check` command, which is **retained
unchanged as a fallback**. The command auto-selects between them per project
by checking for a `.codegraph/codegraph.db` index — see
["Two backends, one command"](#two-backends-one-command) below.

**Cutover status:** acceptance-tested against pvcpipesupplies (pps) —
**AWAITING LUCAS SIGN-OFF.** `docs/acceptance-report-pps-2026-07-31.md` documents a real
run comparing the new graph backend against the live legacy graph container on 5
real pps symbols, with a safety-verified read-only harness
(`scripts/acceptance-diff.sh`). **No project has been cut over.** No
legacy graph container has been stopped or removed by this release. Cutover
(`docs/cutover.md`) is a deliberate, per-project, human-approved action —
this repo ships the tooling and the evidence, not the decision.

| Capability | v0.1.0 (LLM, retained) | v0.2.0 (codegraph engine) |
|---|---|---|
| Find direct callers of a method | grep + filter | `impact` (deterministic depth-capped traversal) |
| Resolve DI preferences (which concrete class a `Foo` argument resolves to) | via magento2-lsp MCP | `context`/`query preferences_for` (indexed `preference_for` edges) |
| Plugin chain analysis | XML scan + LLM reasoning | `context`/`query wired_plugins_on` (indexed `wraps` edges, sortOrder+area) |
| Observer chain (events.xml dispatch → observers) | grep + LLM | `query observers_of_event` (indexed `observes` edges via minted event nodes) |
| Data-flow / table-write detection | heuristic regex over method body | **not yet modeled** — still the v0.1.0 heuristic (see "Known limitations") |
| Cron-vs-cron concurrency hazards | LLM reasoning over crontab.xml + table-write heuristic | **not yet modeled** — still the v0.1.0 heuristic |
| Confidence levels | LLM-shaped ("high/medium/low") | quantitative (depth, edge kind, staleness banner) |

Real production failures discovered with v0.1.0 drove which pieces v0.2.0
indexes first (callers, DI, plugins, observers, routes) — table-write /
cron-concurrency detection is deliberately still LLM-heuristic because it
isn't indexed yet, not an oversight.

## Architecture (v0.2.0)

Three new pieces, all in this repo, none touching pb-hcf or any project's
`.git`:

1. **codegraph engine** — this plugin pins and drives the upstream
   [`@colbymchenry/codegraph`](https://www.npmjs.com/package/@colbymchenry/codegraph)
   tree-sitter PHP indexer (`shared/pinned.ts` holds the single pinned
   version; `shared/schema-guard.ts` refuses to open a db with an
   unsupported schema version rather than silently misreading it). It is a
   dependency, not a fork — see `docs/upstream-pr/` for a draft contribution
   back upstream (Magento routing recognizer, not yet submitted).
2. **augmenter** (`augmenter/src/`) — walks a Magento module tree's
   `di.xml`/`events.xml`/layout XML/`webapi.xml`/`routes.xml` and writes
   Magento-specific wiring into the codegraph SQLite db as additional nodes
   (minted `event`/`route`/`template`/`external` nodes) and edges (locked
   lowercase kinds `preference_for`, `wraps`, `observes`, `renders`,
   `references` — see `docs/edge-taxonomy.md` for the full contract).
   Idempotent, transactional, every row tagged
   `provenance='pb-codegraph-augmenter'` so a re-run or a codegraph reindex
   never corrupts native rows. Driven by `bin/pb-codegraph.ts` (`index` /
   `augment` / `health` subcommands).
3. **MCP shim** (`mcp/`) — a stdio MCP server exposing `list_repos`,
   `find_symbol`, `context`, `impact`, and `query` as deterministic,
   read-only tools over one or more registered codegraph dbs
   (`PB_CODEGRAPH_REGISTRY`). Served under its native name
   `pb-codegraph` so an existing project's `mcps/.mcp.json` entry, agent
   playbooks, and rules keep working unchanged after cutover — only the
   transport (http → stdio) and the backing implementation change.

Vendored-code provenance: the pure XML parsers and path resolvers under
`augmenter/src/parsers/` and `augmenter/src/resolvers/psr4-map.ts` /
`template-path.ts` are vendored, minimally modified, from Lucas's own prior
Magento augmenter project (originally MIT, relicensed Apache-2.0 with his
consent — see `NOTICE`). The mappers, the SQLite writer, and the DB-backed
node-id resolver are new code, not vendored — see `NOTICE` and the code
comments at each vendored file's top for the modification-notice trail
(Apache-2.0 §4).

## Companion to pb-graphiti

`pb-codegraph` and [`pb-graphiti`](https://github.com/ProxiBlue/pb-graphiti) are deliberately separate plugins:

- **pb-codegraph** owns *code structure* and *blast radius* — what calls what, what depends on what, what changes when this changes.
- **pb-graphiti** owns *intent* and *why* — design rationale, vendor verdicts, project quirks, decision history.

They cooperate naturally: pb-codegraph's impact report can prompt a pb-graphiti write ("save: tax-cert cron + CertExporter compete for the same table") so the next session's SessionStart recall flags it before someone re-proposes the same change. The two-layer separation is intentional and worth preserving — don't merge them, even when their storage choices overlap.

## Install

```bash
claude /plugin marketplace add proxiblue/pb-codegraph
claude /plugin install pb-codegraph@pb-codegraph
```

Or for local development:

```json
{
  "extraKnownMarketplaces": {
    "pb-codegraph": {
      "source": { "source": "directory", "path": "/path/to/pb-codegraph" }
    }
  },
  "enabledPlugins": {
    "pb-codegraph@pb-codegraph": true
  }
}
```

Installing the plugin ships the `/pb-codegraph:impact-check` command
immediately (v0.1.0 LLM flow, works with zero extra setup). The v0.2.0 graph
backend is **opt-in per project** — it activates automatically once a
project has a `.codegraph/codegraph.db` index built and (for full MCP-tool
access) the `pb-codegraph` MCP server's stdio entry swapped to
`mcp/bin/server.ts`. See `docs/cutover.md` for the full per-project runbook;
nothing here auto-cuts a project over.

## Usage

### `/pb-codegraph:impact-check [<file-path-or-glob>]`

Run before a deploy. Two modes:

1. **No argument** — uses the current branch's diff against the LIVE-equivalent branch (`live`, `master`, or `HEAD~1` fallback).
2. **With argument** — explicit file/glob scope, e.g. `app/code/Vendor/Foo/Model/TaxCertificate.php` or `app/code/Vendor/Foo/**`.

#### Two backends, one command

Step 0 of the command checks `.codegraph/codegraph.db` for presence:

- **Present** → prefers the deterministic MCP tools (`find_symbol`,
  `context`, `impact`, `query`) served by the `pb-codegraph` server for
  callers / DI preferences / plugin chains / observer chains. Falls back to
  the grep+LLM heuristic only for table-write and cron-concurrency detection
  (not indexed yet) and cross-checks any result the tool flags as stale
  (augmenter marker older than the last codegraph reindex).
- **Absent** → runs the original v0.1.0 flow end to end: grep, the
  [`magento2-lsp`](https://github.com/mage-os/magento2-lsp) MCP server, XML
  config readers, structured LLM reasoning. Not a degraded mode — this is
  the fully-supported default for any project that hasn't opted into the
  graph backend.

For each changed PHP method or XML config node, the command:

1. Extracts the changed symbol(s) from the git diff
2. Searches direct callers (graph `impact`, or grep fallback)
3. Resolves DI preferences pointing at the changed class (graph `context`/`query`, or `magento2-lsp` MCP fallback)
4. Finds plugin chains on the changed method (graph `context`/`query`, or di.xml scan fallback)
5. Finds events dispatched inside the method body, traces observers in `etc/events.xml` (graph `query`, or grep fallback)
6. **Detects table writes** in the method body (the data-flow piece — the tax-cert case; always the heuristic, no graph model yet)
7. Cross-references against other modules' read/write sites on the same tables
8. **Flags cron-vs-cron concurrency** by reading every `etc/crontab.xml` whose job instance touches affected tables
9. Outputs a structured impact report with confidence levels, citations, and which backend answered each finding

### What the impact report looks like

```
# Impact analysis — 2 changed file(s)

## Changed symbols
- Vendor_Foo\Model\TaxCertificate::save() — method body changed
- Vendor_Foo/etc/crontab.xml — job foo_tax_certificate_refresh schedule changed

## Direct impact (high confidence)
- Vendor_Bar\Model\CustomerSync calls TaxCertificate::save() at line 145
- ItTools\TaxImport\Observer\PostImport observes `tax_certificate_saved` event

## Indirect impact (medium confidence)
- Hiddentechies\Compliance\Cron\CertExporter writes the same table
  (customer_tax_certificate) every 6 hours — concurrent-write hazard

## Data flow (HIGH RISK)
- Cron schedule change overlaps with CertExporter at midnight UTC.
  Recommend: stagger schedules OR add row-level locking OR hold deploy.

## Backend used
- GRAPH_BACKEND (augmenter marker: fresh)

## What I did NOT check (limitations)
- ...
```

Every claim cites a file path + line number, in keeping with the investigation protocol discipline.

## Cutting a project over to the graph backend

See `docs/cutover.md` for the full runbook. Summary:

1. Pre-flight LIVE-branch check (mandatory before any `.ddev`/`mcp`/registry write).
2. Build the shared, read-only "core" vendor indexes once, fleet-wide (`scripts/build-core-indexes.sh`).
3. Apply the project's vendor-split ignore template (`templates/per-project-vendor-split.gitignore`).
4. Build the project's own index in-container (`pb-codegraph index`), and generate `registry.json` from `templates/registry.template.json`.
5. Swap the `mcps/.mcp.json` `pb-codegraph` entry from the old HTTP url to a stdio command entry launching `mcp/bin/server.ts`.
6. Verify with `pb-codegraph health` (exit 0 + `"status": "green"`).
7. Run `scripts/acceptance-diff.sh` against real symbols and get explicit human sign-off (see `docs/acceptance-report-pps-2026-07-31.md` for the pps template) **before** relying on the graph backend for real decisions or stopping the legacy graph container.

Rollback at any point is a container `stop` (not remove) plus reverting the
one `mcps/.mcp.json` entry — no rebuild required.

## Recovery / restore notes

Nothing in this plugin is secret and nothing here requires a backed-up
runtime artifact to restore, in keeping with the fleet
`~/claude-skills-central/RECOVERY.md` pattern (this repo IS one of the git
repos that pattern restores by cloning):

- **The codegraph engine itself** is not vendored — it's `npx
  @colbymchenry/codegraph@<pinned version>` (see `shared/pinned.ts`),
  fetched from npm on demand. Nothing to restore.
- **Per-project `.codegraph/codegraph.db` indexes** are 100% rebuildable
  from source (`pb-codegraph index <project-root>`) — they are a cache of
  the project's own git-tracked code, never a source of truth. Safe to
  delete and rebuild at any time.
- **Shared "core" vendor indexes** (mageos/hyva/deps) are equally
  rebuildable via `scripts/build-core-indexes.sh` against any project's live
  branch — see `docs/cutover.md` section 1.
- **`registry.json`** (per-project, generated from
  `templates/registry.template.json`) contains only local db paths — no
  credentials, no host-specific absolute paths baked into shipped code (env/
  flag-driven throughout, per `.claude/code-standards.md`'s portability
  rule).
- **Test fixtures** (`tests/fixture/app/`, `tests/fixture/.codegraph/`) are
  either committed static PHP or gitignored build output
  (`bash scripts/build-fixture-db.sh` regenerates them).
- Nothing under this repo needs a secret to build, run, or restore. The
  secrets grep (`grep -rE '(ff15ea68|9c111c47)' --exclude-dir=.git
  --exclude-dir=node_modules .`) is part of the release sweep specifically
  to keep it that way.

## Development

Test/build/lint commands live in `.claude/testing.md`; code conventions
(TypeScript strictness, vendored-code modification-notice discipline,
SQLite/provenance rules, MCP output shape) live in
`.claude/code-standards.md`. In short:

- `npx tsc --noEmit` — strict TypeScript over `augmenter/`, `mcp/`,
  `shared/`, `bin/`, `scripts/`, and `tests/` (`docs/upstream-pr/` is
  intentionally excluded — see below).
- `node --test --import tsx tests/*.test.ts` — the full unit/integration
  suite (unit tests against a fixture Magento module tree and a real
  pinned-codegraph-built fixture db; `tests/helpers/isolated-fixture-db.ts`
  gives each test file its own private db copy so `node --test`'s default
  parallel file execution can't race the shared fixture rebuild).
- `docker run --rm -v "$PWD":/w koalaman/shellcheck:stable /w/scripts/<file>.sh` — shell lint for everything under `scripts/`.
- `docs/vendor-dir-verification.md` — the empirical evidentiary record backing `docs/cutover.md`'s vendor-directory handling claims (real host paths/output from a live run, not a template).
- `docs/upstream-pr/` is a **deliverable-as-documents** subtree (a draft spec + implementation for contributing back to upstream `colbymchenry/codegraph`, including its own `__tests__/`). It is styled for that upstream repo's own tooling (e.g. vitest-shaped imports), not this one — deliberately excluded from this repo's `tsc` include set and never picked up by this repo's `tests/*.test.ts` glob.
- `scripts/lib/*.ts` — TypeScript helpers backing `scripts/acceptance-diff.sh` (MCP client calls, legacy-backend HTTP client, classification); type-checked as part of the same `tsc` run as the rest of the repo.

## Dependencies

- **`@colbymchenry/codegraph`** (pinned, see `shared/pinned.ts`) — the tree-sitter PHP indexer the v0.2.0 engine drives. Fetched via `npx` on demand, not vendored.
- **`better-sqlite3`** — synchronous SQLite bindings used by the augmenter's writer and the MCP shim's read-only db opener; must load in-container (native ABI — see `docs/cutover.md`).
- **`@modelcontextprotocol/sdk`** — the MCP shim's stdio server implementation.
- **`magento2-lsp` MCP server** — used by the v0.1.0 LLM fallback flow (and by the graph flow's still-heuristic table-write/cron-concurrency steps). Without it, those steps fall back to pure grep + XML parsing. Install via the [mage-os/magento2-lsp](https://github.com/mage-os/magento2-lsp) project.
- **`gh` CLI** — only if you want the command to cite the affecting PRs/tickets in the report. Optional.

## Known limitations (v0.2.0)

- **Table-write / cron-concurrency detection is not indexed** — the augmenter models XML wiring, not PHP method bodies' data flow. Still the v0.1.0 heuristic regardless of backend. Tracked as a future roadmap item, not silently glossed over.
- **`wraps` metadata omits `before`/`after`/`around`** — Magento's per-method plugin execution order requires parsing the plugin class's method-name prefixes, not just di.xml. Deferred; see `docs/edge-taxonomy.md`.
- **`routes.xml` mints a route node but no controller edge** — Magento resolves `frontName → controller` by URL convention, not declaration, so there's nothing in routes.xml to resolve that edge from. Documented honestly in `docs/edge-taxonomy.md` rather than faked.
- **Native `references` edges are not augmenter-exclusive** — codegraph's own indexer independently emits `references` edges (surfaced by the pps acceptance run, 652 native rows vs 2 augmenter rows in that scratch index); needs a provenance-column-based disambiguation fix in a follow-up task. See `docs/acceptance-report-pps-2026-07-31.md` "Known limitations".
- **No cutover has happened yet** — every project still runs the legacy graph container (or the v0.1.0-only LLM flow) until a human explicitly runs the cutover runbook and reviews an acceptance report for that project.

## Roadmap

The v0.2.0 engine's own roadmap follows the same "let production misses
drive priorities" discipline v0.1.0 used:

1. **Post-0.2.0** — resolve the `references` collision (known limitation above), decide on cutover for pps and subsequent projects based on Lucas's sign-off on the acceptance report.
2. **Data-flow analysis** — static detection of table writes via ResourceModel inheritance, `getConnection()` calls, and repository pattern, so the tax-cert detector becomes deterministic instead of heuristic.
3. **Plugin execution order** — parse plugin class method-name prefixes (`before`/`after`/`around`) to complete the `wraps` metadata.
4. **Upstream contribution** — submit the Magento routing recognizer drafted in `docs/upstream-pr/` to `colbymchenry/codegraph`, if Lucas decides to.
5. **Continuous reindex** — watch git for changes and reindex incrementally instead of on-demand.

## Why this exists

The prior tool that gave us this capability ships under a commercial license. The license terms are workable, but a critical piece of deploy safety shouldn't rest on one vendor's pricing model staying favorable. This plugin is the in-house path — start cheap and LLM-shaped, evolve toward deterministic as real production failures justify the engineering cost.

## License

Apache License 2.0 — see [LICENSE](./LICENSE) and [NOTICE](./NOTICE).

Copyright (c) 2026 Lucas van Staden / Proxiblue.

**Attribution is required.** Redistributors and forks MUST preserve the `LICENSE`, `NOTICE`, and copyright notices, and MUST state significant modifications in modified files (per Apache 2.0 §4). The plugin remains usable in any environment — commercial or non-commercial, embedded in proprietary stacks, forked, or modified — provided attribution is preserved.
