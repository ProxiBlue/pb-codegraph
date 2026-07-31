# Edge / Node Taxonomy — pb-codegraph Magento augmenter

This is the LOCKED contract every downstream task (002 writer, 003 node-id
resolver, 003b mapper adaptation, 006/007 MCP shim) consumes. It was
corrected during devils-advocate review (see
`.claude/plans/v0-2-0-codegraph-engine/_devils_advocate.md` C2/C3/I1) against
the actual vendored mapper output — not the originally-assumed shape.

## Why a remap table exists

The vendored legacy mappers (`di-xml-mapper.ts`, `events-xml.ts`,
`layout-xml-mapper.ts`, `webapi-xml.ts`, `routes-xml.ts` — none of which are
vendored verbatim; see task 001 scope boundary) emit an uppercase `type` +
free-text `reason` pair designed for the old LBUG graph schema, not for
codegraph. If the writer stored `type` verbatim:

- `preference` emits `IMPLEMENTS`, which is **indistinguishable from
  codegraph's own native `implements` edge** except by provenance — a magento
  preference and a real PHP `implements` clause would collide under the same
  edge kind.
- `observer` and `layout` both emit `CALLS`, which would make them
  unqueryable as distinct families.

So task 002's writer MUST remap `type` (+ `reason` prefix) to the LOCKED
lowercase kinds below before insertion. Downstream traversal (007 impact CTE)
keys on the remapped kind, never on the raw vendored `type`.

## Kind remap table

| Family | Vendored `type` | Vendored `reason` prefix | LOCKED edge kind | Endpoints (corrected) |
|---|---|---|---|---|
| preference | `IMPLEMENTS` | `magento:di:preference` | `preference_for` | concrete class node → interface/abstract class node |
| plugin | `WRAPS` | `magento:di:plugin` | `wraps` | target class node → plugin class node |
| observer | `CALLS` | `magento:events:observer:<event>` | `observes` | minted `event` node → observer class node |
| layout | `CALLS` | `magento:layout:block-template` | `renders` | block class node → minted `template` node |
| webapi | `HANDLES_ROUTE` | `magento:webapi:route` | `references` | service class node ↔ minted `route` node |
| routes | `HANDLES_ROUTE` | `magento:routes:controller` | `references` | controller/module class node ↔ minted `route` node |

`preference_for` is a **distinct kind, NOT native `implements`** — this is
the fix for the IMPLEMENTS collision above. A codegraph-native `implements`
edge (from real PHP source) and a magento `preference_for` edge (from di.xml)
must never be conflated; only `provenance='pb-codegraph-augmenter'` +
edge kind together identify an augmenter-injected row.

**Direction correction (task 013 release sweep):** an earlier draft of this
table read "interface node → concrete class node" for `preference_for`,
which was backwards. Task 003b's implementation notes flagged the
discrepancy explicitly: both the vendored `di-xml-mapper.ts`'s own
source/target assignment and this task file's own prose ("source = impl
class node, target = interface/abstract class node") agree on
**source = concrete implementation class, target = interface/abstract
class**. The table row above has been corrected to match the shipped
implementation (`augmenter/src/mappers/di-xml-mapper.ts`); this is a
documentation fix, not a behavior change.

## Locked edge kinds

- **`preference_for`** — di.xml `<preference for="..." type="...">`.
  Metadata: `{ reason: "magento:di:preference", area }`.
- **`wraps`** — di.xml `<type name="..."><plugin type="..." sortOrder="...">`.
  Metadata: `{ reason: "magento:di:plugin", sortOrder, area }`. See "wraps
  metadata scope" below — `before`/`after`/`around` is explicitly NOT part of
  this metadata in v0.2.
- **`observes`** — events.xml `<event name="..."><observer instance="...">`.
  Metadata: `{ reason: "magento:events:observer:<event>", event, area }`.
- **`renders`** — layout xml `<block class="..." template="...">`.
  Metadata: `{ reason: "magento:layout:block-template", area }`.
- **`references`** — webapi.xml `<route><service class="..." method="...">`
  and routes.xml `<route id="..." frontName="...">`.
  Metadata: `{ reason: "magento:webapi:route" | "magento:routes:controller", area }`.

Every injected edge row carries `provenance='pb-codegraph-augmenter'` and
preserves the vendored parser's `reason` string verbatim in
`metadata.reason` (e.g. `magento:events:observer:checkout_cart_save_after`).

## Node kinds

- **Native** (codegraph-owned, never touched by the augmenter): `class`,
  `interface`, `method`, `file`, etc.
- **Minted** (created by the augmenter — these node kinds do not exist in
  codegraph's own PHP indexer output):
  - `event` — id `magento:event:<name>` (e.g. `magento:event:checkout_cart_save_after`)
  - `route` — id `magento:route:<area>:<path>` (e.g. `magento:route:webapi:/V1/moduleb/foo`, `magento:route:frontend:moduleb`)
  - `template` — id `magento:template:<area>:<path>` (e.g. `magento:template:frontend:Acme_ModuleB::foo.phtml` or the resolved relative `.phtml` path)
  - `external` — id `magento:external:<normalized-fqcn>` (e.g. `magento:external:Magento\Catalog\Model\Product`), minted when a di.xml/events.xml/webapi.xml target FQCN cannot be resolved to a locally-indexed class/interface node (vendor-split or 3rd-party target not in this project's index). See the fixture's `Vendor→Acme` module tree (`tests/fixture/app/code/Acme/ModuleB/etc/di.xml`) for a concrete unresolved-target example.

Minted nodes are maintained in `nodes_fts` (hard requirement, task 002 —
`find_symbol`'s FTS path must be able to return a minted route/event/template
node, not just native symbols).

## Endpoint model (corrected — class/minted-node, never `File:`)

The vendored mappers, as written, emit `File:<relpath>` endpoints (a leftover
of the legacy tool's schema) which have **no corresponding codegraph node** —
codegraph indexes PHP symbols, not files, and `events.xml`/`routes.xml`/
`.phtml` are not PHP symbols at all. The corrected endpoint model that task
003 (resolver) and 003b (mapper adaptation) must implement:

- **observer**: source = minted `event` node (`magento:event:<name>`) →
  target = observer **class** node (resolved from the `instance` FQCN, not a
  `File:` id).
- **layout**: source = block **class** node (resolved from the `class` FQCN)
  → target = minted `template` node.
- **webapi / routes**: service or controller **class** node ↔ minted `route`
  node (direction: class node is the source, route node is the target, per
  the `references` kind above).

Resolving a `File:<relpath>` string (as emitted by the vendored parsers) or a
raw FQCN to the class/symbol node actually defined in that file is task
003's job (DB-backed node-id resolver), not this doc's concern — this doc
only fixes the *target shape* every downstream task must produce.

## `wraps` metadata scope (v0.2 limitation)

`di-xml.ts` parses `sortOrder` and `area` from the `<plugin>` element, and
both MUST be forwarded into `wraps` metadata (`sortOrder`, `area`) by task
003b — the original mapper drops them, which is a bug in the vendored code,
not a taxonomy choice.

`before`/`after`/`around` (Magento's per-method plugin execution order) is
**NOT available from di.xml** — it is a property of the plugin PHP class's
method-name prefix (e.g. `beforeSave`, `afterSave`, `aroundSave`), which
requires parsing the plugin class's method signatures, not the XML wiring
file. This is out of scope for v0.2's `wraps` metadata and is **deferred to
v0.4** (see `_plan.md` Architecture Notes, I1 finding).

## Route honesty note

`routes.xml` produces no explicit `route → controller` edge — Magento
resolves `frontName → controller` by URL convention at runtime, not by
declaration. The `references` edge for the routes family therefore links the
declaring module/class to the minted `route` node; the route node stands
mostly alone (no outgoing edge to "the" controller) in v0.2. Document this
honestly rather than implying a resolved controller edge exists.

## provenance discipline

Every row the augmenter writes carries `provenance='pb-codegraph-augmenter'`.
Nothing the augmenter writes may mutate a codegraph-owned (native) row. A
re-run of the augmenter (idempotent) deletes and re-inserts only rows
matching its own provenance value.
