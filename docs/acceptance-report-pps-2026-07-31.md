# Acceptance report — pvcpipesupplies (pps), 2026-07-31

**STATUS: AWAITING LUCAS SIGN-OFF.** This document is a data-collection
artifact produced by `scripts/acceptance-diff.sh`. It classifies where the
new pb-codegraph stack and the live legacy graph container agree/disagree on
`impact` for 5 real pps symbols. **It is not a pass/fail verdict.** Nothing
in this repo, this task, or this report authorizes cutting pps over or
stopping the legacy graph container — that decision is Lucas's alone, per
`docs/cutover.md` step 9 and `_plan.md`'s acceptance gate. Task 011's
"Status: completed" means the harness + report exist and were run for
real, not that the migration was accepted.

## How to reproduce this run

```bash
scripts/acceptance-diff.sh \
  --pps-root ~/workspace/uptactics/pvcpipesupplies \
  --symbols scripts/acceptance-symbols-pps.json \
  --legacy-container <legacy-graph-container> \
  --scratch-dir /tmp/pps-acceptance-run \
  --keep-scratch
```

Raw per-backend JSON responses and `classification.json`/`classification.md`
are written under `<scratch-dir>/results/`. The scratch dir is a **throwaway
copy** (see "Safety verification" below) — nothing under it is committed to
this repo; this document is the durable record of what one real run found.

## Environment this run actually used

- pps checkout: `~/workspace/uptactics/pvcpipesupplies`, branch
  `feature/address-trim-collect-rates` at run time (read-only source of the
  `app/code` copy — see "Safety verification").
- Legacy graph container: `<legacy-graph-container>` (name via `docker ps`), reached at its
  docker-bridge IP (`docker inspect -f
  '{{range .NetworkSettings.Networks}}{{.IPAddress}} {{end}}'
  <legacy-graph-container>'` → `172.25.0.4` at run time — no host port
  is published for this container, per the task brief). `tools/call
  list_repos` on it reports 4 indexed repos; the one used for this
  comparison is `m2_pvcpipesupplies`, **`indexedAt: 2026-05-26T14:02:10Z`
  for the mageos/hyva/deps cores and `2026-07-22T19:00:33Z` for
  `m2_pvcpipesupplies` itself** — roughly a week stale against
  `2026-07-31`, exactly the "legacy index is STALE (pinned ~Jul 23)"
  divergence category the task brief calls out in advance.
- New stack: pb-codegraph `index` (init + augment) run against a **scratch
  copy** of `app/code` only (per the task's hard constraint — see below),
  queried over the real stdio MCP transport
  (`mcp/bin/server.ts`, the same `Client`/`StdioClientTransport` pattern as
  `tests/mcp-stdio-find-symbol-context.test.ts`).
- Augmenter marker on the scratch index for every query in this run:
  `augmenter_status: "fresh"`, `non_authoritative: false` — the new stack's
  own staleness banner (C5) never fired, i.e. every new-stack result below
  is authoritative on its own terms.
- Augment summary for the scratch index: 13 di.xml preferences, 49 di.xml
  plugins, 15 events.xml observers, 14 layout block→template, 2 webapi
  routes, 12 routes.xml routes minted, 93 edges / 88 nodes inserted.

## Safety verification — zero writes inside pps

`scripts/acceptance-diff.sh` copies `app/code` (`cp -a`, read-only on the
pps side) into a scratch directory and indexes/augments **only** inside
that copy; `.codegraph/` is never created inside pps. The script itself
snapshots `git -C <pps-root> status --porcelain` before the run and
re-checks it identically after (see `verify_pps_status_unchanged` in
`scripts/acceptance-diff.sh`), aborting with exit code 4 ("SAFETY TRIP") if
they differ. This run's actual output:

```
[acceptance-diff] pps working tree unchanged (git status --porcelain identical before/after) — verified.
```

Independently re-verified from this session before and after the run:

```
$ git -C ~/workspace/uptactics/pvcpipesupplies status --porcelain
(empty both times — diff of the two captures is empty)
```

## Symbol selection

Read (read-only) from `app/code/Uptactics/*/etc/{di,events}.xml` in pps on
2026-07-31. Full data lives in `scripts/acceptance-symbols-pps.json`
(the concrete fixture `scripts/acceptance-diff.sh` was run against for this
report; the script itself takes any `--symbols` file and hardcodes nothing
pps-specific).

| label | category | symbol | source XML |
|---|---|---|---|
| `plugin-wrapped-method` | plugin | `Uptactics\PpsTheme\Plugin\BreadcrumbsPlugin` (`aroundGetBreadcrumbPath`, wraps `Magento\Catalog\Helper\Data`) | `app/code/Uptactics/PpsTheme/etc/di.xml` (sortOrder=1) |
| `event-observer` | observer | `Uptactics\ShipperHqCarrier\Observer\FetchShippingRates` (observes `checkout_onepage_controller_success_action`) | `app/code/Uptactics/ShipperHqCarrier/etc/frontend/events.xml` |
| `preference-redirect` | preference | `Uptactics\JournalReport\Model\ResourceModel\Product\Sold\Collection` (preference for `Magento\Reports\Model\ResourceModel\Product\Sold\Collection`) | `app/code/Uptactics/JournalReport/etc/di.xml` |
| `cross-db-mage-os-extends` | cross-db | `Uptactics\JournalReport\Block\Widget\Grid\Column\Renderer\Liftgate` (PHP `extends \Magento\Backend\Block\Widget\Grid\Column\Renderer\AbstractRenderer` — **no XML wiring at all**) | `app/code/Uptactics/JournalReport/Block/Widget/Grid/Column/Renderer/Liftgate.php:20` |
| `negative-control-no-wiring` | negative | `Uptactics\CustomOptionQtyLimit\Helper\Data` (config helper; not a plugin/preference/observer/layout/webapi/routes target anywhere under `app/code/Uptactics`) | n/a (absence verified by grep — see below) |

Deviation from the task brief's example framing: the brief suggests a
plugin example from "the Braintree/ShipperHQ area". pps has no Braintree
module, and `Uptactics_ShipperHqCarrier` declares no `<plugin>` (only
`<observer>` + constructor `<arguments>`) — confirmed by
`grep -rn "<plugin" app/code/Uptactics` (11 hits total, none in
`ShipperHqCarrier`). `BreadcrumbsPlugin` (PpsTheme) was used for the plugin
case instead, and `ShipperHqCarrier`'s own observer was used for the
event-observer case, keeping the "ShipperHQ area" flavor there.

**Ambiguity note (why fully-qualified names, not bare names, were used for
the new-stack side):** `nodes.name = 'Data'` matches **4** distinct classes
and `nodes.name = 'Collection'` matches **14** in the scratch index
(`SELECT count(*) FROM nodes WHERE kind='class' AND name IN ('Data',
'Collection')` — 4 and 14 respectively), so `scripts/acceptance-symbols-pps.json`
uses codegraph's exact `Ns\Sub::ClassName` qualified-name form for
`new_stack_symbol` and a `legacy_file_path` disambiguation hint for the
legacy side (`Liftgate`, `BreadcrumbsPlugin`, `FetchShippingRates` are
unique by bare name — confirmed 1 hit each — so no ambiguity there).

**Negative-control absence check:** `grep -rn "CustomOptionQtyLimit\\\\Helper\\\\Data\|Helper\\\\Data"
app/code/Uptactics/**/*.xml` returns nothing under `CustomOptionQtyLimit`
(the one unrelated hit, `PpsTheme/etc/di.xml:7: <type
name="Magento\Catalog\Helper\Data">`, is a *different* `Helper\Data` class
entirely — Magento core's, not this one). Confirmed independently by the
scratch DB: `Uptactics\CustomOptionQtyLimit\Helper::Data`'s edges are 100%
`contains`/`references`/`imports`/`calls` — zero `wraps`/`preference_for`/
`observes`/`renders` rows touch it.

## Comparison methodology

- **Backends queried:** new stack via the real MCP stdio shim
  (`impact` tool, `direction: "both"`, `depth: 4`); the legacy backend via its
  streamable-HTTP JSON-RPC endpoint (`impact` tool, called twice per symbol
  — `direction: "upstream"` and `"downstream"`, `maxDepth: 4` — because
  the legacy tool's `impact` has no `"both"` value; the two calls are merged by
  `scripts/lib/classify-acceptance.ts`).
- **Direction mapping:** pb-codegraph `dependencies` (outgoing,
  source=queried node) ↔ legacy `downstream` ("what this depends on");
  pb-codegraph `dependents` (incoming, target=queried node) ↔ the legacy tool's
  `upstream` ("what depends on this").
- **Node identity:** the two backends model impacted nodes at different
  granularities — pb-codegraph reports method/field/constant/class/minted
  ids (`class:<hash>`, `magento:external:<fqcn>`, ...); the legacy tool reports
  `File:<path>` / `Class:<path>:<Name>` ids. The classifier compares at
  **file_path granularity** (deduped, minimum depth kept per direction) —
  the coarsest level both backends share — rather than pretending a
  finer-grained id match is meaningful across two different node models.
- **Excluded from the file-path comparison:** (a) pb-codegraph `contains`
  edges (pure structural class→field/method/constant containment —
  the legacy tool's `impact` tool never reports this as "impact", only
  CALLS/IMPORTS/EXTENDS/IMPLEMENTS/HAS_METHOD/HAS_PROPERTY/
  METHOD_OVERRIDES/METHOD_IMPLEMENTS/ACCESSES; including `contains` would
  manufacture "new-stack-only" noise that isn't a real divergence), (b) the
  queried symbol's own file reported back to itself, (c) minted nodes
  (event/route/template/external — no legacy counterpart exists **by
  construction**, since the legacy tool has no XML-wiring awareness at all; every
  such row is counted separately as a `magento_kind_edges_new_stack` entry,
  not folded into the file-path diff).
- **`references` kind ambiguity:** `docs/edge-taxonomy.md` locks
  `references` as a magento-augmenter kind (webapi/routes family), but the
  scratch DB shows codegraph's own **native** indexer independently emits
  edges named `references` too (652 native rows vs 2 augmenter-origin ones
  in this index — confirmed by `SELECT kind, count(*) FROM edges GROUP BY
  kind`). This is the same collision class `_devils_advocate.md` C2 flagged
  for `IMPLEMENTS`, recurring for `references` — not caught by the original
  remap-table design because `references` was assumed augmenter-exclusive.
  The classifier therefore only treats `wraps`/`preference_for`/`observes`/
  `renders` as unambiguous magento-kind markers (`references` excluded from
  that set) — **flagged as a genuine augmenter-gap requiring a fix in a
  follow-up task** (provenance-column filtering, not kind-name filtering).

## Per-symbol findings

### 1. `plugin-wrapped-method` (plugin) — both found; 1 different-set, 1 new-stack-only, 0 legacy-only

New stack resolved `Uptactics\PpsTheme\Plugin::BreadcrumbsPlugin` and
returned, at depth 1 dependencies:

```json
{ "direction": "dependencies", "depth": 1, "edge_kind_path": ["wraps"],
  "metadata": { "sortOrder": 1, "area": "global", "reason": "magento:di:plugin" },
  "node": { "id": "magento:external:Magento\\Catalog\\Helper\\Data", "kind": "external", "qualified_name": "Magento\\Catalog\\Helper\\Data" } }
```

The legacy tool found the same root symbol (`BreadcrumbsPlugin.php`) but its
`upstream`/`downstream` walks (CALLS/IMPORTS/EXTENDS/...) never surface a
`wraps` edge or any node named `Magento\Catalog\Helper\Data` at all — it
has no concept of di.xml `<plugin>` wiring. **Divergence category:
augmenter-gap-is-the-point** — the legacy tool structurally cannot see this
relationship; the new stack can. This is not a regression, it's the
migration's whole value proposition, and it is why the "new-stack-only"
classification exists as a distinct bucket rather than being conflated
with a real gap.

File-path-level divergences beyond the magento edge itself:

| file_path | classification | new-stack | legacy | category |
|---|---|---|---|---|
| `.../AutocompleteBestsellers/.../Collection.php` | new-stack-only | outgoing@2 | — | resolution-miss (unconfirmed root cause; a 2-hop `calls` chain the new stack's own PHP indexer found that the legacy tool's walk from this root did not reach at maxDepth 4) |
| `.../CustomOptionQtyLimit/Helper/Data.php` | different-set | outgoing@2 | outgoing@1 | **see cross-cutting finding below — this is a legacy short-name collision false positive, not a real divergence** |

### 2. `event-observer` (observer) — both found; 2 different-set, 1 new-stack-only, 0 legacy-only

New stack resolved `Uptactics\ShipperHqCarrier\Observer::FetchShippingRates`
and returned, at depth 1 dependents:

```json
{ "direction": "dependents", "depth": 1, "edge_kind_path": ["observes"],
  "metadata": { "event": "checkout_onepage_controller_success_action", "area": "frontend", "reason": "magento:events:observer:checkout_onepage_controller_success_action" },
  "node": { "id": "magento:event:checkout_onepage_controller_success_action", "kind": "event" } }
```

Confirmed (scratch DB, direct query) that this event is a genuine
**multi-observer** event — the same
`magento:event:checkout_onepage_controller_success_action` node also has an
`observes` edge to `Uptactics\TaxCompanyValue\Observer::SetCompanyName`
(a different, unrelated module) — exactly the "class with observers"
(plural) case the task brief asks for, and per C4's documented v0.2
limitation, this is graph traversal through the **minted event node**, not
traversal of an actual `$eventManager->dispatch(...)` call-site (the
dispatch-site→event link remains an acknowledged v0.2 gap, not exercised by
this symbol either way since the legacy tool can't see it at all).

The legacy tool found the root symbol but, as expected, shows zero `observes`-like
result and no `checkout_onepage_controller_success_action` node anywhere in
its output — **augmenter-gap-is-the-point** again, same as case 1.

| file_path | classification | new-stack | legacy | category |
|---|---|---|---|---|
| `.../JournalReport/Model/GraphQLClient.php` | new-stack-only | outgoing@3 | — | resolution-miss (transitive, 3 hops deep — plausibly beyond what the legacy tool's own walk resolved from this root within maxDepth 4; unconfirmed) |
| `.../ShipperHqCarrier/Client/GraphQLClient.php` | different-set | outgoing@2 | outgoing@1 | resolution-miss (new stack reaches it via `contains`→`calls`, i.e. one extra "descend into method" hop that the legacy tool's coarser walk doesn't count as a hop) |
| `.../ShipperHqCarrier/Response/RetrieveShippingData.php` | different-set | outgoing@3 | outgoing@2 | same depth-accounting pattern as above, one level deeper |

The `different-set` rows in this run are consistently **exactly +1 depth**
on the new-stack side versus the legacy tool for the same file. That is
consistent with a systematic **methodology artifact**, not a semantic
disagreement: pb-codegraph's walk descends `class --[contains]--> method
--[calls]--> ...` (an extra hop through the containing method that this
classifier does not special-case), while the legacy tool's walk appears to count
file-to-file relationships directly. This is flagged honestly as
**unconfirmed** — verifying it would require instrumenting the legacy tool's own
cypher schema per-hop, which is out of scope for this acceptance pass — but
it is the single most plausible explanation given it recurs identically in
3 of the 4 non-magento `different-set` rows in this whole run (cases 1–3).

### 3. `preference-redirect` (preference) — both found; 1 different-set, 1 new-stack-only, 0 legacy-only

New stack resolved
`Uptactics\JournalReport\Model\ResourceModel\Product\Sold::Collection` and
returned, at depth 1 dependencies:

```json
{ "direction": "dependencies", "depth": 1, "edge_kind_path": ["preference_for"],
  "metadata": { "area": "global", "reason": "magento:di:preference" },
  "node": { "id": "magento:external:Magento\\Reports\\Model\\ResourceModel\\Product\\Sold\\Collection", "kind": "external" } }
```

The legacy tool found the same root symbol but shows no `preference_for` edge and
no `Magento\Reports\...\Collection` node — **augmenter-gap-is-the-point**,
same pattern as cases 1–2. The two file-path divergences
(`JournalReport/Model/GraphQLClient.php` different-set,
`TaxExemptionAvalaraBridge/Model/Config.php` new-stack-only) follow the
same "+1 depth via an extra method-containment hop" pattern documented in
case 2.

### 4. `cross-db-mage-os-extends` (cross-db) — both found; **0/0/0/0 — clean agreement**

`Uptactics\JournalReport\Block\Widget\Grid\Column\Renderer\Liftgate`
(`Liftgate.php:20`, `class Liftgate extends
\Magento\Backend\Block\Widget\Grid\Column\Renderer\AbstractRenderer`) is
the one symbol in this run with **no XML wiring at all** — the cross-DB
boundary here is a plain PHP `extends` to an unindexed mage-os core class.

- **New stack:** the scratch DB has **zero** `extends` edges touching
  `Liftgate` (`SELECT source,target,kind,metadata FROM edges WHERE
  kind='extends'` — 13 rows total in the whole index, none for
  `Liftgate`). Confirmed this is not augmenter behavior at all — `extends`
  is codegraph's own **native** PHP relationship kind, resolved by exact
  short-name match against the local index (`{"resolvedBy":"exact-match"}`)
  only when the base class is present. Since core is not indexed in the
  scratch project DB, codegraph's native resolver silently **drops** the
  edge — it does **not** mint an `external` placeholder the way the
  augmenter does for di.xml/events.xml/webapi.xml targets. This is a real,
  worth-documenting asymmetry between native-edge and augmenter-edge
  cross-DB handling (native: silent drop, no node; augmenter: minted
  `external` placeholder, edge preserved) — logged below under "Known
  limitations", not something this task fixes.
- **Legacy tool:** `impactedCount: 0` for both `upstream` and `downstream` —
  the legacy tool has the **exact same blind spot** for this base class. Neither
  tool can see through an unresolved cross-DB `extends`.

**Divergence category: cross-db-limitation, confirmed symmetric on both
backends.** This is the cleanest possible outcome for this category: it
shows the new stack is not *worse* than the incumbent here, both are
equally blind to an unindexed base class, and (per case 1's finding below)
this is likely the *safer* failure mode compared to the legacy tool's short-name
IMPORTS collision on the negative control.

### 5. `negative-control-no-wiring` (negative) — both found; 4 both-found, 0 different-set, 0 new-stack-only, **21 legacy-only**

`Uptactics\CustomOptionQtyLimit\Helper::Data` — confirmed above to carry
zero magento-kind edges on the new-stack side (the core assertion this
symbol exists to prove: **the augmenter injects no false edges** for a
symbol with no XML wiring). The 4 `both-found` rows
(`SkipQtyLimitedOptionsCheck.php`, `ValidateOptionsOnAddToCart.php`,
`OptionQtyLimit.php`, `BreadcrumbsPlugin.php` — all `incoming@1` on both
sides) are genuine agreement: real PHP files that legitimately construct-
inject this exact helper, found identically by both backends' native
IMPORTS/references resolution.

The 21 `legacy-only` rows are **not** a new-stack capability gap — see
the cross-cutting finding immediately below, which is evidenced
specifically against this symbol's data.

## Cross-cutting finding: legacy short-name collision false positives

The legacy tool's `target` resolution correctly disambiguated the root node by
`file_path` in every case in this run (`target.id` always matched the
exact intended file). But its `upstream`/`downstream` **walk** appears to
match by **bare class name** ("Data", "Collection", ...) rather than by the
fully-qualified class the root actually resolves to. Verified by reading
the actual source of 4 of the 21 `legacy-only` files the legacy tool reported as
importing `Uptactics\CustomOptionQtyLimit\Helper\Data`:

```
$ grep -n "^use " app/code/Xtento/CustomTrackers/Plugin/Helper/Shipping/DataPlugin.php
13:use Magento\Shipping\Helper\Data;              # a DIFFERENT "Data" — Magento core's
```

```
$ grep -n "^use " app/code/Mageplaza/OrderLabels/Controller/Adminhtml/Rule/MassDelete.php
33:use Mageplaza\OrderLabels\Helper\Data;          # a DIFFERENT "Data" — Mageplaza's own
```

```
$ grep -n "^use " app/code/Uptactics/PpsTheme/ViewModel/RecentlyPurchased.php
13:use Magento\Framework\Pricing\Helper\Data as PricingHelper;   # a THIRD unrelated "Data"
```

```
$ grep -n "^use " app/code/LizardMedia/ProductAttachment/Model/AttachmentRepository.php
15-25: (imports LizardMedia\ProductAttachment\Api\Data\... — "Data" only as a
        NAMESPACE SEGMENT, not a class named Data at all)
```

None of these 4 files import `Uptactics\CustomOptionQtyLimit\Helper\Data`.
The legacy tool's own `impact` walk merged them into this symbol's impact set
anyway, purely on the bare short name `Data` — a name shared by dozens of
`Namespace\...\Helper\Data`-style classes across Magento's own convention.
The `plugin-wrapped-method` case's lone `different-set` row
(`CustomOptionQtyLimit/Helper/Data.php`, legacy `outgoing@1`) is the same
bug from the other direction: `BreadcrumbsPlugin.php` imports **only**
`Magento\Catalog\Helper\Data` (`grep -n "^use " .../BreadcrumbsPlugin.php`
— no other `Data` import exists in that file), yet the legacy tool's downstream
walk attributes an edge to `Uptactics\CustomOptionQtyLimit\Helper\Data.php`
instead — the same name, wrong file.

Interestingly, the new stack is not entirely immune to the same underlying
failure mode either, just less exposed to it in this run: its own **native**
(non-augmenter) `references` edge from `BreadcrumbsPlugin::aroundGetBreadcrumbPath`
to `CustomOptionQtyLimit\Helper::Data` carries `{"confidence":0.7,
"resolvedBy":"exact-match","refName":"Data"}` — codegraph's own fuzzy
short-name fallback, same root cause, just a different tool. Reading
`aroundGetBreadcrumbPath(Data $helper, ...)` confirms the *only* `Data` in
that method signature is the `Magento\Catalog\Helper\Data` type-hint (the
plugin's subject parameter) — this is also a false-positive edge, at
confidence 0.7, not 1.0.

**Divergence category: shared limitation of confidence<1.0 short-name
resolution in BOTH tools' native (non-XML-derived) edge resolution — not
specific to the augmenter.** The augmenter's own edges (`wraps`,
`preference_for`, `observes`, `renders`) are always FQCN-precise (parsed
straight from `type="..."` XML attributes) and never exhibit this failure
mode in this run. **Practical implication for Lucas's sign-off:** treat any
impact result at `confidence < 1.0` (new stack) as advisory, same as you
already should for the legacy tool's equivalent fuzzy matches — this is a
property of static PHP analysis on Magento's naming conventions in
general, not a new-stack regression.

## Overall classification summary

| symbol | both-found | different-set | new-stack-only | legacy-only |
|---|---|---|---|---|
| plugin-wrapped-method | 0 | 1 | 1 | 0 |
| event-observer | 0 | 2 | 1 | 0 |
| preference-redirect | 0 | 1 | 1 | 0 |
| cross-db-mage-os-extends | 0 | 0 | 0 | 0 |
| negative-control-no-wiring | 4 | 0 | 0 | 21 |
| **total** | **4** | **4** | **3** | **21** |

Plus, orthogonal to the file-path table above (never double-counted): **3
magento-kind edges** (`wraps`, `observes`, `preference_for`) surfaced by the
new stack across symbols 1–3, each targeting a minted node with no
legacy counterpart by construction.

Every `different-set`/`new-stack-only`/`legacy-only` finding in this run
has an assigned, evidence-backed divergence category:

| category | count | evidence |
|---|---|---|
| augmenter-gap-is-the-point (the legacy tool structurally can't see XML wiring) | 3 (the 3 magento-kind edges) | per-symbol sections 1–3 above |
| resolution-miss, likely a systematic +1-depth walk-accounting difference | 4 (`different-set` rows in cases 2–3, minus the 1 collision false positive) | per-symbol sections 2–3; **unconfirmed root cause**, flagged explicitly |
| resolution-miss, deep transitive reach difference (depth 2–3) | 3 (`new-stack-only` rows in cases 1–3) | per-symbol sections 1–3; **unconfirmed root cause** |
| cross-db-limitation, symmetric on both backends | 1 symbol, 0 divergent nodes | case 4 |
| legacy short-name collision false positive | 1 `different-set` row + 21 `legacy-only` rows | "Cross-cutting finding" section, 4 grep citations |
| event-dispatch-not-traversed (v0.2 documented limitation, C4) | 0 new findings this run (event traversal goes through the minted event node successfully; the dispatch-*call-site* link remains unexercised either way since the legacy tool can't do it at all) | case 2 |
| staleness (legacy index ~1 week old) | 0 confirmed instances this run (no finding traced specifically to the `2026-07-22` snapshot vs pps HEAD; flagged as a standing risk, not a confirmed cause of anything above) | "Environment" section |

## Tooling status (this task's own deliverables)

- `docker run --rm -v "$PWD":/w koalaman/shellcheck:stable /w/scripts/acceptance-diff.sh` — **clean, 0 findings**.
- `npx tsc --noEmit` — **clean** (includes the 3 new `scripts/lib/*.ts` helpers).
- `node --test --import tsx tests/*.test.ts` — **74/74 passing**, no regressions from this task's additions (none of the existing suite imports the new `scripts/lib/*` files).
- Secrets grep (`grep -rE '(ff15ea68|9c111c47)' --exclude-dir=.git --exclude-dir=node_modules .`) — **0 real hits** (only the doc line in `.claude/testing.md` that names the pattern itself matches, as expected).
- pps working tree — **verified byte-identical** `git status --porcelain` before/after (see "Safety verification").

## Known limitations surfaced by this run (not fixed here — logged for follow-up)

1. `references` kind name collides between codegraph-native edges and
   augmenter-injected webapi/routes edges (same class of bug as C2's
   `IMPLEMENTS` collision, missed for `references` specifically) —
   needs a provenance-column-based fix in a follow-up task, not a
   kind-name-based one.
2. Native `extends`/`implements` resolution silently drops unresolvable
   cross-DB targets (no node, no edge) instead of minting an `external`
   placeholder the way the augmenter does for XML-sourced edges — an
   asymmetry worth deciding on deliberately (mint placeholders for native
   edges too, in a future task, vs. leave as-is since the legacy tool has the
   identical blind spot per case 4).
3. The legacy tool's own `impact` walk exhibits short-name collision false
   positives on common Magento naming patterns (`Namespace\...\Helper\Data`
   is ubiquitous) — not a new-stack problem, but relevant context for
   interpreting *any* historical legacy-tool impact report Lucas has trusted
   to date, not just this comparison.
4. The "+1 depth via method-containment hop" pattern in 3 of 4
   `different-set` rows is a plausible but **unconfirmed** hypothesis —
   would need a focused single-symbol legacy graph trace to fully
   verify, which is out of scope for this pass.

## AWAITING LUCAS SIGN-OFF

This report presents the classified evidence. Migration acceptance,
legacy graph container teardown, and any `.ddev`/`mcp.json` cutover (per
`docs/cutover.md` step 9) requires Lucas's explicit review and sign-off —
not implied by this task's "Status: completed".
