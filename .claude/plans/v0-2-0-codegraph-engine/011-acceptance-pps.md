# Task 011: Acceptance harness — pps parallel diff vs the legacy tool

**Status**: completed (harness + report produced — NOT a migration
acceptance; see docs/acceptance-report-pps-2026-07-31.md "AWAITING LUCAS
SIGN-OFF")
**Depends on**: 010
**Retry count**: 0

## Description
scripts/acceptance-diff.sh + docs: on pps, index custom code + augment, then compare shim impact output vs live legacy-tool impact (containers still up) for at least 5 real symbols: one plugin-wrapped method (Braintree/ShipperHQ area), one observer/event case, one preference-redirected interface, ONE CROSS-DB case (a custom plugin/preference targeting a vendor/mage-os class — exercises federation + external-placeholder behavior, see _devils_advocate.md I5), and ONE NEGATIVE case (a symbol with no magento wiring — proves the augmenter injects no false edges). Diff is classified PER IMPACTED NODE (not just per symbol): both-found / new-stack-only / legacy-only / **different-set** (both located the symbol but returned divergent impacted sets — the most dangerous case). Each divergence gets an explanation category (index staleness — the legacy index is a week stale — vs resolution miss vs augmenter gap vs cross-db-boundary vs event-dispatch-not-traversed per C4). Human-readable verdict; Lucas signs off before fleet cutover.

## Requirements (Test Descriptions)
- [x] `it produces a per-impacted-node classification including a different-set category` — `scripts/lib/classify-acceptance.ts` classifies every impacted file_path into both-found / different-set / new-stack-only / legacy-only; real run produced 4 both-found, 4 different-set, 3 new-stack-only, 21 legacy-only across 5 symbols (docs/acceptance-report-pps-2026-07-31.md "Overall classification summary").
- [x] `it covers a cross-db case and a no-wiring negative case` — symbol 4 (`Liftgate` extends unindexed mage-os core, no XML wiring at all) and symbol 5 (`CustomOptionQtyLimit\Helper\Data`, confirmed zero magento-kind edges both sides) in scripts/acceptance-symbols-pps.json; see report sections 4 and 5.
- [x] `it explains each divergence with a category (staleness/resolution-miss/augmenter-gap/cross-db/event-dispatch)` — every non-empty classification bucket in the report is assigned a category (augmenter-gap-is-the-point, resolution-miss x2 subtypes, cross-db-limitation, legacy short-name collision false positive — a 6th, empirically-evidenced category beyond the brief's 5 — and event-dispatch-not-traversed, with 0 new findings this run). See "Overall classification summary" table.
- [x] `it fails loudly when either backend is unreachable rather than emitting a partial verdict` — `scripts/acceptance-diff.sh` probes legacy-backend reachability before doing any indexing work (exit 2, no scratch dir created, verified live: pointing `--legacy-base-url` at a closed port produced `LEGACY BACKEND UNREACHABLE: connection ... failed` and exit code 2 with zero files written); `scripts/lib/new-stack-impact.ts` / `scripts/lib/legacy-impact.ts` both throw (never write a partial output file) on any transport/tool-level error, propagating to `scripts/acceptance-diff.sh` exit codes 2/3.

## Acceptance Criteria
- Run on pps; report reviewed by Lucas (sign-off gate — NOT auto-passable)

## Implementation Notes

- `scripts/acceptance-diff.sh` — parameterized bash harness (no baked pps
  paths; `--pps-root`/`--symbols`/`--legacy-container|--legacy-base-url`
  all required inputs). Copies `app/code` read-only (`cp -a`) into a scratch
  dir, runs `bin/pb-codegraph.ts index` there, writes a registry, queries
  both backends, classifies, and verifies `git status --porcelain` on
  `--pps-root` is byte-identical before/after (exit 4 "SAFETY TRIP" if not).
  `shellcheck` clean via `docker run --rm -v "$PWD":/w koalaman/shellcheck:stable`.
- `scripts/lib/new-stack-impact.ts` — real MCP stdio client
  (`Client`/`StdioClientTransport`, same pattern as
  `tests/mcp-stdio-find-symbol-context.test.ts`) calling the `impact` tool
  once per symbol against `mcp/bin/server.ts`.
- `scripts/lib/legacy-impact.ts` — raw HTTP JSON-RPC client against
  the legacy server's streamable-HTTP MCP endpoint (initialize → notifications/initialized
  → tools/call, `mcp-session-id` header threaded through, SSE-framed
  response body parsed). Calls `impact` twice per symbol (`upstream` +
  `downstream` — the legacy tool has no `"both"` direction).
- `scripts/lib/classify-acceptance.ts` — merges both backends' output at
  file_path granularity (deduped, min depth per mapped direction),
  excluding pure-structural `contains` edges and self-file hits (documented
  in the report's "Comparison methodology" section), emits
  `classification.json` + a markdown table.
- `scripts/acceptance-symbols-pps.json` — the 5 real pps symbols (data
  file, not script logic — keeps `acceptance-diff.sh` itself
  project-agnostic per code-standards.md).
- `docs/acceptance-report-pps-2026-07-31.md` — the human sign-off artifact:
  environment/reachability details, safety verification, symbol-selection
  rationale (with disambiguation-collision counts), full comparison
  methodology, per-symbol findings with cited raw JSON, a cross-cutting
  finding (legacy short-name collision false positives on common
  Magento `Helper\Data`-style names — evidenced with 4 grep citations, not
  previously documented anywhere in this plan), the classification summary
  table, tooling status, known limitations, and an explicit "AWAITING LUCAS
  SIGN-OFF" section.
- Full run performed live against the actual pps checkout and the actual
  running legacy graph container (IP resolved via
  `docker inspect`, no host port). `npx tsc --noEmit` clean; existing
  `node --test --import tsx tests/*.test.ts` suite still 74/74 passing (no
  regressions); secrets grep 0 real hits.
- One genuine augmenter-taxonomy gap surfaced by this acceptance run (not
  fixed here, logged in the report's "Known limitations"): the `references`
  edge kind is not augmenter-exclusive — codegraph's own native indexer
  independently emits edges named `references` (652 native rows vs 2
  augmenter rows in the scratch index), the same collision class
  `_devils_advocate.md` C2 flagged for `IMPLEMENTS` but missed for
  `references`. Needs a provenance-column-based fix in a follow-up task.
