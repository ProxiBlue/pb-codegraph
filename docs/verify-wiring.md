# verify-wiring

`pb-codegraph verify-wiring <project-root> [--db <path>] [--registry <path>] [--stamp]`

Reconciles the augmenter's STATIC edges (di.xml/events.xml, parsed at
`augment` time — see `docs/edge-taxonomy.md`) against
[ProxiBlue/bricklayer](https://github.com/ProxiBlue/bricklayer)'s RUNTIME
ObjectManager truth, spawned as an MCP stdio child process (override the
spawn command via `PB_CODEGRAPH_BRICKLAYER_CMD`; default
`vendor/bin/bricklayer mcp`).

## Scope

Only the three magento edge kinds bricklayer itself exposes a runtime query
surface for:

- `preference_for` — bricklayer's `preference-list` tool.
- `wraps` — bricklayer's `plugin-list` tool.
- `observes` — bricklayer's `event-list` tool.

`renders` and `references` (webapi/routes) have **no bricklayer-side runtime
query** and are explicitly out of scope for this command.

## Flags

- `--db <path>` — override the project codegraph db path (defaults to the
  project's own `.codegraph/codegraph.db`).
- `--registry <path>` — union additional codegraph dbs (core/mage-os, hyva,
  3rd-party dep indexes) into the static side before declaring a runtime fact
  MISSING_FROM_GRAPH. Cross-DB wiring (a project preference/plugin/observer
  whose target lives only in a core index, never the project db) would
  otherwise false-positive as missing.
- `--stamp` — marks GRAPH_ONLY edges (static-only, e.g. a disabled module or
  an environment where the wiring simply isn't active) in the PROJECT db with
  `metadata.enabled_in_env = false`. Without `--stamp`, GRAPH_ONLY rows are
  only reported, never mutated. Registry (core) dbs are NEVER stamped —
  `--stamp` only ever writes to the project db.

## CHARACTERIZED LIMITATION — per-target/per-interface bricklayer tools

Both `plugin-list` and `preference-list` are PER-TARGET tools
(`className`/`interface` argument), not full-corpus dumps —
`preference-list` called with no `interface` arg returns only a small curated
"common interfaces" sample, not everything Magento knows about.
Consequently this tool can only discover a runtime `wraps`/`preference` fact
for a target class/interface it ALREADY has at least one STATIC fact for
(queried via `distinctWrapTargets`/`distinctPreferenceInterfaces`) — a
target with ZERO static rows at all (e.g. a plugin/preference wired entirely
from an unparsed vendor tree) can never surface as MISSING_FROM_GRAPH for
that reason alone. `observes` does not share this limitation: `event-list`
dumps everything per area.

**Interceptor normalization.** `reconcilePreferences` strips ONE trailing
`\Interceptor` segment off a runtime `preference-list` impl FQCN before
key-matching against the static graph — a generated Magento interceptor
(`<Class>\Interceptor`) is a 1:1 runtime wrapper of the class a plugin was
attached to, so runtime reports the interceptor name while di.xml (and the
static graph) name the plain class. A match found only after this
normalization is still reported MATCHED, keeping the RAW (interceptor)
runtime name in the report line and noting "matched via interceptor
normalization" so it's clear which side of the match was adjusted.

## Compiled DI

`detectCompiledDi` (`augmenter/src/verify-wiring.ts`) checks
`<project-root>/generated/metadata/` for any `*plugin-list.php` file before
reconciling `wraps`. That directory is Magento's `bin/magento
setup:di:compile` output — when it's present, bricklayer's `plugin-list`
tool uses the COMPILED data VERBATIM: a class outside the compiled set (one
the compiler never touched, e.g. a class only reachable from a code path not
exercised by compilation) returns **no plugins at all** (`[]`) regardless of
what di.xml actually declares for it.

When this is detected, `verify-wiring` prints a loud banner and marks the
`wraps` section of the report **non-authoritative (compiled DI present)** —
its GRAPH_ONLY rows are still printed for visibility but are excluded from
the report's rolled-up `graphOnly` summary total, since they may simply be
classes the compiler never touched rather than real static-only drift.

**To restore full runtime verification, remove `generated/metadata`** (i.e.
run the project in developer mode, uncompiled). Note this is not scoped to
this tool: while `generated/metadata` exists, Magento itself also serves DI
wiring from that compiled cache rather than the live di.xml/events.xml —
`verify-wiring`'s wraps findings and Magento's own runtime behavior are both
reading the same potentially-stale compiled snapshot in that state.

## Known model differences

These are real, evidence-backed divergences between the static graph and
bricklayer's runtime truth that are NOT bugs to fix in pb-codegraph — they
are documented here so a MISSING_FROM_GRAPH / GRAPH_ONLY / SORTORDER_DRIFT
finding can be triaged correctly instead of chased as a false regression.

### (a) Transitive preference chains

The static graph stores ONE-HOP `preference_for` edges per di.xml
declaration; runtime reports the fully RESOLVED endpoint after Magento's own
preference-chain resolution. Example (pps live run, 2026-07-31): a di.xml
`<preference for="Magento\Framework\Serialize\SerializerInterface"
type="Firebear\ImportExport\Model\Serialize\Serializer\Json">` is a single
edge in the graph, but if another module further overrides
`Firebear\ImportExport\Model\Serialize\Serializer\Json` itself, runtime
reports the FINAL class in the chain, not the intermediate one the graph's
one-hop edge names. Treat a `preference_for` MISSING_FROM_GRAPH finding that
resolves to a class one hop downstream of a real static edge as this case,
not a genuine gap.

### (b) Cross-area merge semantics

Magento's runtime `event-list(area=X)` MERGES `global`-scoped observers into
EVERY area's result set (a global observer fires in every area, not just
"global" requests) — a runtime fact for a global-declared observer can be
reported tagged under any queried area (frontend/adminhtml/...), not just
"global". `reconcileObserves` (`augmenter/src/verify-wiring.ts`) implements
this explicitly: a `global` static fact matches a runtime fact reported
under ANY area, while an area-specific static fact (frontend/adminhtml/...)
still matches only its own area — Magento does NOT merge area-scoped
observers into other areas. Before this was implemented (pre 2026-07-31),
every global observer produced one false MISSING_FROM_GRAPH per
non-"global" area it was also reported under, plus a false GRAPH_ONLY for
the static side.

### (c) Plugin-name merge across modules (same plugin name, competing declarations)

**General rule:** when two modules declare a plugin (or observer) under the
**exact same `name`** attribute on the same target, Magento's di.xml (and
events.xml) merge-by-`name` semantics mean only ONE declaration survives at
runtime — typically the LAST one in module-sequence order, e.g. a later
module's `disabled="true"` declaration overriding an earlier module's
`disabled="false"` one, regardless of which `type`/class either side names.
The static graph parses each area/module's declaration independently and has
no notion of this cross-module merge-by-name step, so it can end up with a
`wraps` (or `observes`) edge for the enabled declaration while the disabling
declaration is correctly omitted (a `disabled="true"` element is filtered per
file) — but with no awareness that the omission was meant to override the
first, not merely coexist with it. Implementing real cross-module
plugin-name-merge semantics is out of scope for v0.2; this is a documented
known limitation, not a bug to chase as a regression when triaging a
MISSING_FROM_GRAPH / GRAPH_ONLY finding for a plugin/observer name known to
be declared by more than one module.

**Illustrative example — Smile\ElasticsuiteCatalog::AdjustAttributeSearchable.**
Live pps run (2026-07-31) surfaced a divergence around the plugin name
`adjust_searchable_attribute_values`. Investigated (read-only) against a real
vendor tree containing both `Magento_LayeredNavigation` (mage-os) and
`Smile_ElasticsuiteCatalog`:

- `vendor/mage-os/module-layered-navigation/etc/adminhtml/di.xml:10` declares
  `<plugin name="adjust_searchable_attribute_values"
  type="Magento\LayeredNavigation\Plugin\Save\AdjustAttributeSearchable"
  sortOrder="1" disabled="false" />` on
  `Magento\Catalog\Model\Product\Attribute\Frontend\Inputtype\Presentation`.
- `vendor/smile/elasticsuite/src/module-elasticsuite-catalog/etc/adminhtml/di.xml:29`
  declares a plugin under the **exact same `name`**
  (`adjust_searchable_attribute_values`) on the **exact same target type**,
  but a DIFFERENT `type`
  (`Smile\ElasticsuiteCatalog\Plugin\LayeredNavigation\Save\AdjustAttributeSearchable`)
  and `disabled="true"`.
- `Smile_ElasticsuiteCatalog`'s `etc/module.xml` explicitly sequences AFTER
  `Magento_LayeredNavigation` (`<sequence><module
  name="Magento_LayeredNavigation" />...`), so per Magento's di.xml
  merge-by-`name` semantics, Smile's later declaration should be the
  EFFECTIVE one for that plugin name — i.e. the plugin should be disabled at
  runtime, full stop, regardless of which `type` either declaration names.

**Confirmed as a general pattern, not a one-off** by re-running verify-wiring
against pps after the fixes in this doc's other sections landed
(2026-07-31): the same divergence class recurred for two `observes` facts,
both simpler single-declaration cases (no cross-module name-merge involved
at all):
`app/code/Mageants/ExtensionVersionInformation/etc/adminhtml/events.xml:5`
(`<observer ... disabled="true"/>` on `controller_action_predispatch`) and
`vendor/smile/elasticsuite/src/module-elasticsuite-catalog/etc/adminhtml/events.xml:34`
(`<observer disabled="true" .../>`). Both are declared `disabled="true"` in
their SOLE XML declaration (no competing enabled declaration anywhere), yet
bricklayer's `event-list` still reports them as MISSING_FROM_GRAPH (i.e. as
if active) — pb-codegraph's parser correctly omits a `disabled="true"`
observer/plugin entirely (matches real Magento behavior: it never fires),
so the graph legitimately has no row for it. This suggests bricklayer's
runtime reflection tools do not filter the `disabled` attribute at all when
listing plugins/observers — a bricklayer-side characteristic, not a
pb-codegraph gap. Any MISSING_FROM_GRAPH finding for a fact whose sole XML
declaration carries `disabled="true"` should be triaged as this case before
assuming a real static-side omission.

This is neither a vendor-split exclusion (`vendor/smile/` is NOT in the
per-project vendor-split ignore list — see
`templates/per-project-vendor-split.gitignore`, which only excludes
`vendor/mage-os/` and `vendor/hyva-themes/`) nor a virtualType. It is a
genuine THIRD class of model difference: pb-codegraph's parser
(`augmenter/src/parsers/di-xml.ts`) correctly skips `disabled="true"`
`<plugin>` elements **per file**, but has no concept of Magento's real
di.xml merge-by-`name` override across the FULL module sequence — each
area/module's `<plugin>` declaration is parsed independently, so the graph
ends up with a `wraps` edge for the mage-os (enabled) declaration and
NOTHING at all for Smile's disabling one (correctly filtered, but with no
awareness that it was meant to override the first). If bricklayer's runtime
tool reflects the raw/merged XML config rather than the fully disabled-aware
compiled result, the two backends will disagree on whether this plugin is
"active" for this target. Implementing real cross-module plugin-name-merge
semantics is out of scope for v0.2 — this is logged as a known limitation,
not fixed here.

### (d) Area-scoped preferences vs. a single-context `preference-list`

Live pps run (2026-08-01, after the interceptor-normalization fix in this
doc's earlier section landed): 11 of 16 remaining `preference_for`
MISSING_FROM_GRAPH findings shared one shape — the runtime impl, after
stripping its `\Interceptor` suffix, is IDENTICAL to the queried interface
itself (e.g. `Magento\GroupedProduct\Model\Product\Type\Grouped\Interceptor`
reported as the "preference" for
`Magento\GroupedProduct\Model\Product\Type\Grouped`), while the static graph
has a real edge naming a DIFFERENT concrete override for that same interface
scoped to a specific area (e.g.
`Magento\GroupedProduct\Model\Product\Type\Grouped\Backend`, `area:
"adminhtml"`). This means bricklayer's `preference-list` tool resolves
against a SINGLE fixed context (its own child-process ObjectManager, not
necessarily `adminhtml`) — an area-scoped `<preference>` that only takes
effect in a different area than bricklayer itself runs under will never be
visible to it; the "preference" it reports back is just the plain class
self-intercepted (a plugin attached, no preference override active in
bricklayer's context), not evidence the static edge is wrong. Same family of
divergence as (b) (cross-area merge semantics for `observes`), but
`preference-list` has no per-area argument to query around it the way
`event-list` does. Triage any MISSING_FROM_GRAPH preference finding whose
runtime impl (post-interceptor-stripping) equals the queried interface
itself, where a real static edge exists for that interface scoped to a
non-default area, as this case — not a genuine gap. Not fixed in v0.2 (no
bricklayer-side area argument to drive it with).

## Exit codes

- `0` — nothing MISSING_FROM_GRAPH (GRAPH_ONLY and SORTORDER_DRIFT findings
  do not affect the exit code).
- `1` — at least one runtime fact is MISSING_FROM_GRAPH.
- `2` — environment error (codegraph db not found, bricklayer could not be
  launched, unsupported schema, etc.).
