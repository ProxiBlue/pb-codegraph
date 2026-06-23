# pb-codegraph

Cross-module impact analysis for Magento 2 / Mage-OS — detect what depends on the code you're about to change, *before* you ship.

The use case this plugin exists for: a real production incident where a cron schedule change would have clobbered 1000s of customer tax configurations on deploy. A code-graph tool detected that the cron and another module's importer wrote the same table, on schedules that would now overlap. Deploy was held; customers' data survived.

This plugin gives Claude Code that same capability — without the commercial-license dependency the prior tool carried.

## Status: v0.1.0 — LLM-driven impact check

The current version orchestrates **existing** tools (grep, the [`magento2-lsp`](https://github.com/mage-os/magento2-lsp) MCP server, XML config readers) with structured LLM reasoning. No new infrastructure: no database, no indexer, no daemon. Just a careful slash command.

| Capability | v0.1.0 (LLM) | v0.2+ (planned tree-sitter graph) |
|---|---|---|
| Find direct callers of a method | grep + filter | deterministic call graph walk |
| Resolve DI preferences (which concrete class a `Foo` argument resolves to) | via magento2-lsp MCP | via magento2-lsp + cached index |
| Plugin chain analysis | XML scan + LLM reasoning | deterministic chain ordering |
| Observer chain (events.xml dispatch → observers) | grep + LLM | indexed event-to-observer map |
| Data-flow / table-write detection | heuristic regex over method body | static-analysis-grade |
| Cron-vs-cron concurrency hazards | LLM reasoning over crontab.xml + table-write heuristic | deterministic table-touch graph |
| Confidence levels | LLM-shaped (uses "high/medium/low" framing) | quantitative |

v0.1.0 trades precision for ship-speed. A deterministic graph (v0.2+) would catch cases the LLM misses; the LLM catches the obvious cases NOW. **Real production failures discovered with v0.1.0 should drive v0.2+ priorities** — don't guess what to index, let the misses tell you.

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

## Usage

### `/pb-codegraph:impact-check [<file-path-or-glob>]`

Run before a deploy. Two modes:

1. **No argument** — uses the current branch's diff against the LIVE-equivalent branch (`live`, `master`, or `HEAD~1` fallback).
2. **With argument** — explicit file/glob scope, e.g. `app/code/Vendor/Foo/Model/TaxCertificate.php` or `app/code/Vendor/Foo/**`.

For each changed PHP method or XML config node, the command:

1. Extracts the changed symbol(s) from the git diff
2. Searches direct callers via grep
3. Asks `magento2-lsp` MCP for DI preferences pointing at the changed class
4. Scans `etc/di.xml` for plugin chains on the changed method
5. Finds events dispatched inside the method body, traces observers in `etc/events.xml`
6. **Detects table writes** in the method body (the data-flow piece — the tax-cert case)
7. Cross-references against other modules' read/write sites on the same tables
8. **Flags cron-vs-cron concurrency** by reading every `etc/crontab.xml` whose job instance touches affected tables
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

## What I did NOT check (limitations)
- ...
```

Every claim cites a file path + line number, in keeping with the investigation protocol discipline.

## Dependencies

- **`magento2-lsp` MCP server** — strongly recommended. Without it, the command falls back to pure grep + XML parsing, which loses DI resolution and plugin chain semantics. Install via the [mage-os/magento2-lsp](https://github.com/mage-os/magento2-lsp) project.
- **`gh` CLI** — only if you want the command to cite the affecting PRs/tickets in the report. Optional.
- **PHP-Parser / tree-sitter** — NOT a runtime dependency yet. Reserved for v0.2+ when the deterministic graph indexer ships.

## Roadmap to v0.2+

The LLM approach will miss things — that's known. The roadmap follows production failures, not guesses:

1. **v0.1.x — Refine the LLM command** as failure modes surface. Track which cases the LLM misses; tighten the prompt and add specific bash checks for those.
2. **v0.2.0 — Static call graph indexer**. Tree-sitter-php-based. Walks `app/code/` on demand or on git change. Stores nodes (classes, methods) + edges (CALLS, EXTENDS, IMPLEMENTS) in a local Neo4j instance (reuse pb-graphiti's if running). MCP tool `pb-codegraph:callers(symbol)` for deterministic lookups.
3. **v0.3.0 — Magento wiring resolver**. DI preference resolution + plugin chain ordering + virtualType expansion. Cooperates with magento2-lsp where overlap exists.
4. **v0.4.0 — Data-flow analysis**. Static detection of table writes via ResourceModel inheritance, getConnection() calls, and repository pattern. The tax-cert detector becomes deterministic, not heuristic.
5. **v0.5.0 — Continuous reindex daemon**. Watches git for changes; reindexes incrementally. Keeps the graph current.

Each step is a real chunk of work (~1-4 weeks). Order may shift based on which v0.1.0 misses cost the most.

## Why this exists

The prior tool that gave us this capability ships under a commercial license. The license terms are workable, but a critical piece of deploy safety shouldn't rest on one vendor's pricing model staying favorable. This plugin is the in-house path — start cheap and LLM-shaped, evolve toward deterministic as real production failures justify the engineering cost.

## License

MIT — see [LICENSE](./LICENSE).
