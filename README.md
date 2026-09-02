# pb-codegraph

Cross-module impact analysis for Magento 2 / Mage-OS — detect what depends on the code you're about to change, *before* you ship.

The use case this plugin exists for: a real production incident where a cron schedule change would have clobbered thousands of customer tax records on deploy. A code-graph tool caught that the cron and another module's importer wrote the same table on schedules that would now overlap. The deploy was held; the data survived.

This plugin gives Claude Code that same capability, as an open-source Apache-2.0 plugin.

## Install

```bash
claude /plugin marketplace add proxiblue/pb-codegraph
claude /plugin install pb-codegraph@pb-codegraph
```

For local development instead, add to your Claude settings:

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

That's it — the `/pb-codegraph:impact-check` command works immediately, with zero further setup.

## Do I need to build an index/db first?

**No.** Installing the plugin is enough. Out of the box, `impact-check` runs an LLM-driven analysis (grep, XML config reads, structured reasoning) — no database, no indexing step.

Building a local index (`.codegraph/codegraph.db`, one command — see below) is **optional**. If present, the command automatically prefers it for callers, DI preferences, plugin chains, and observer chains — faster and deterministic instead of LLM-reasoned. A couple of checks (table-write detection, cron-concurrency hazards) always run the LLM heuristic regardless, since those aren't indexed yet. Either way you get a full report; the index just makes part of it faster and more precise.

To build one:

```bash
pb-codegraph index <project-root>
```

Safe to build, delete, and rebuild at any time — it's purely a cache of your own git-tracked code, never a source of truth. See the "Of interest" section below for the full opt-in runbook if you want deterministic results project-wide.

## Usage

### `/pb-codegraph:impact-check [<file-path-or-glob>]`

Run before a deploy. Two modes:

1. **No argument** — diffs the current branch against the live-equivalent branch (`live`, `master`, or `HEAD~1` fallback).
2. **With argument** — explicit file/glob scope, e.g. `app/code/Vendor/Foo/Model/TaxCertificate.php` or `app/code/Vendor/Foo/**`.

For each changed PHP method or XML config node, it:

1. Extracts the changed symbol(s) from the git diff
2. Finds direct callers
3. Resolves DI preferences pointing at the changed class
4. Finds plugin chains on the changed method
5. Traces events dispatched inside the method body to their observers
6. Detects table writes in the method body (the tax-cert-style case)
7. Cross-references other modules' read/write sites on the same tables
8. Flags cron-vs-cron concurrency by reading every `crontab.xml` job that touches affected tables
9. Outputs a structured impact report with confidence levels and citations

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
- GRAPH_BACKEND (index: fresh)

## What I did NOT check (limitations)
- ...
```

Every claim cites a file path and line number.

## How it works

Two pieces, both in this repo:

- **codegraph engine** — drives the upstream [`@colbymchenry/codegraph`](https://www.npmjs.com/package/@colbymchenry/codegraph) tree-sitter PHP indexer as a dependency (fetched via `npx` on demand, not vendored). Builds the raw call/DI graph.
- **augmenter** — walks a Magento module tree's `di.xml`/`events.xml`/layout XML/`webapi.xml`/`routes.xml` and writes Magento-specific wiring (plugin chains, observers, routes) into the same index, so the tree-sitter graph understands Magento's XML-driven wiring, not just plain PHP calls.

An MCP shim exposes it all as deterministic, read-only tools (`find_symbol`, `context`, `impact`, `query`) that the `impact-check` command calls when an index is present.

Vendored-code note: the XML parsers and path resolvers under `augmenter/src/parsers/` and `augmenter/src/resolvers/` are adapted from an earlier project of the author's (originally MIT, relicensed Apache-2.0 with consent — see `NOTICE`). Everything else is new.

## Dependencies

- **`@colbymchenry/codegraph`** — the tree-sitter PHP indexer. Fetched via `npx` on demand.
- **`better-sqlite3`** — SQLite bindings for the index writer/reader.
- **`@modelcontextprotocol/sdk`** — MCP server implementation.
- **[`magento2-lsp`](https://github.com/mage-os/magento2-lsp) MCP server** — used by the LLM-fallback flow. Without it, those steps fall back to grep + XML parsing.
- **`gh` CLI** — optional, only used to cite affecting PRs/tickets in the report.

## Development

Test/build/lint commands live in `.claude/testing.md`; code conventions live in `.claude/code-standards.md`. In short:

- `npx tsc --noEmit` — strict TypeScript over the whole repo (except `docs/upstream-pr/`, a separate deliverable — see below)
- `node --test --import tsx tests/*.test.ts` — full unit/integration suite
- `docker run --rm -v "$PWD":/w koalaman/shellcheck:stable /w/scripts/<file>.sh` — shell lint

## License

Apache License 2.0 — see [LICENSE](./LICENSE) and [NOTICE](./NOTICE).

Copyright (c) 2026 Lucas van Staden / Proxiblue.

**Attribution is required.** Redistributors and forks MUST preserve the `LICENSE`, `NOTICE`, and copyright notices, and MUST state significant modifications in modified files (per Apache 2.0 §4). Usable in any environment — commercial or non-commercial, embedded in proprietary stacks, forked, or modified — provided attribution is preserved.

---

## Of interest — v0.2.0 internals, status, and roadmap

Everything below is detail for contributors or the curious — not required reading to use the plugin.

### Two backends, one command

`impact-check` checks for `.codegraph/codegraph.db` at the start of every run:

- **Present** → prefers the deterministic MCP tools for callers / DI preferences / plugin chains / observer chains. Falls back to the LLM heuristic only for table-write and cron-concurrency detection (not indexed yet), and cross-checks any result flagged as stale.
- **Absent** → runs the original LLM flow end to end (grep, `magento2-lsp` MCP, XML config readers, structured reasoning). Not a degraded mode — this is the fully-supported default.

| Capability | LLM flow | Graph engine |
|---|---|---|
| Find direct callers of a method | grep + filter | deterministic depth-capped traversal |
| Resolve DI preferences | via magento2-lsp MCP | indexed `preference_for` edges |
| Plugin chain analysis | XML scan + LLM reasoning | indexed `wraps` edges (sortOrder+area) |
| Observer chain (events.xml → observers) | grep + LLM | indexed `observes` edges |
| Data-flow / table-write detection | heuristic regex over method body | not yet modeled — still the heuristic |
| Cron-vs-cron concurrency hazards | LLM reasoning over crontab.xml | not yet modeled — still the heuristic |
| Confidence levels | LLM-shaped ("high/medium/low") | quantitative (depth, edge kind, staleness banner) |

Real production failures drove which pieces the graph engine indexes first (callers, DI, plugins, observers, routes) — table-write / cron-concurrency detection is deliberately still LLM-heuristic because it isn't indexed yet, not an oversight.

### Rollout status

Acceptance-tested against one production project (pvcpipesupplies): `docs/acceptance-report-pps-2026-07-31.md` documents a real run comparing the graph backend against a legacy tool on 5 real symbols, via a read-only comparison harness (`scripts/acceptance-diff.sh`). **No project has switched over to the graph backend as its default yet** — that's a deliberate, per-project, human-reviewed decision (`docs/cutover.md`), not something this plugin does automatically.

### Building a project-wide index (full runbook)

See `docs/cutover.md` for the complete steps. Summary:

1. Build the shared, read-only "core" vendor indexes once, fleet-wide (`scripts/build-core-indexes.sh`).
2. Apply the project's vendor-split ignore template (`templates/per-project-vendor-split.gitignore`).
3. Build the project's own index (`pb-codegraph index`), generate `registry.json` from `templates/registry.template.json`.
4. Point the MCP config's `pb-codegraph` entry at the stdio server (`mcp/bin/server.ts`).
5. Verify with `pb-codegraph health` (exit 0 + `"status": "green"`).
6. Run `scripts/acceptance-diff.sh` against real symbols and get a human to review the diff before relying on it for real decisions.

Rollback at any point is stopping (not removing) the old backend, plus reverting the one MCP config entry — no rebuild required.

### Known limitations (v0.2.0)

- **Table-write / cron-concurrency detection is not indexed** — the augmenter models XML wiring, not PHP method bodies' data flow. Still the LLM heuristic regardless of backend.
- **Plugin execution order (`before`/`after`/`around`) isn't captured yet** — requires parsing the plugin class's method-name prefixes, not just di.xml. See `docs/edge-taxonomy.md`.
- **`routes.xml` mints a route node but no controller edge** — Magento resolves `frontName → controller` by URL convention, not declaration, so there's nothing in `routes.xml` to resolve that edge from.
- **Native `references` edges overlap with the augmenter's own** — codegraph's own indexer independently emits `references` edges (652 native rows vs 2 augmenter rows in one real index); needs a provenance-based disambiguation fix. See `docs/acceptance-report-pps-2026-07-31.md`.

### Roadmap

1. Resolve the `references` collision (above); decide on wider cutover based on acceptance-report review.
2. **Data-flow analysis** — detect table writes via ResourceModel inheritance, `getConnection()` calls, and repository pattern, making the tax-cert-style detector deterministic instead of heuristic.
3. **Plugin execution order** — parse method-name prefixes to complete the `wraps` metadata.
4. **Upstream contribution** — a drafted Magento routing recognizer for upstream `colbymchenry/codegraph` lives in `docs/upstream-pr/`, not yet submitted.
5. **Continuous reindex** — watch git for changes and reindex incrementally instead of on-demand.

### Recovery notes

Nothing in this plugin is secret and nothing requires a backed-up runtime artifact to restore:

- The codegraph engine itself isn't vendored — fetched from npm on demand.
- Per-project indexes are 100% rebuildable from source — a cache, never a source of truth.
- Shared "core" vendor indexes are rebuildable via `scripts/build-core-indexes.sh`.
- `registry.json` contains only local db paths — no credentials, no host-specific absolute paths.
- Test fixtures are either committed static PHP or regeneratable build output.

### Why this exists

The prior tool that gave us this capability shipped under a commercial license. The terms were workable, but a critical piece of deploy safety shouldn't rest on one vendor's pricing model staying favorable. This plugin is the in-house path — start cheap and LLM-shaped, evolve toward deterministic as real production failures justify the engineering cost.
