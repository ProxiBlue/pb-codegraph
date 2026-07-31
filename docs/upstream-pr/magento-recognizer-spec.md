# Magento 2 framework recognizer — spec for `colbymchenry/codegraph`

Status: draft, not submitted. Target repo: https://github.com/colbymchenry/codegraph.
Mirrors the existing `src/resolution/frameworks/drupal.ts` recognizer (the closest
precedent: a PHP/Composer ecosystem, convention-heavy routing declared in a
non-PHP config file, hook/event dispatch resolved by name pattern rather than
static call). Where this spec diverges from Drupal's shape it says so and why.

## 1. Why Magento is in-scope

`codegraph`'s README already frames "Framework-aware Routes" as: "detects
web-framework routing files and emits `route` nodes linked by `references`
edges to their handler classes or functions" — 17 frameworks today, including
one other PHP ecosystem with declarative + convention routing (Drupal
`*.routing.yml`) at an "honest static-analysis ceiling" of 78.9% coverage per
the README's own validated-coverage table. Magento 2 is the same shape of gap
for PHP/Composer projects: hundreds of thousands of live Magento 2 / Mage-OS
installs, two routing declaration styles (`routes.xml` for frontend/adminhtml
HTML controllers, `webapi.xml` for REST/SOAP service endpoints), both
resolvable to real PHP symbols without LLM help — it is a pure static-analysis
problem, the same category CodeGraph already solves for Laravel, Rails, and
Drupal.

## 2. Detection

`magentoResolver.detect(context)` mirrors `drupalResolver.detect` — a fast
`composer.json` check, falling back to a file-signature check for
Composer-less trees (a module dropped straight into `app/code/` with no
project-root `composer.json`, which is common for a single custom module
checked into its own repo):

1. **Primary — composer.json.** `require`/`require-dev` contains any package
   whose name starts with `magento/` (covers `magento/framework`,
   `magento/module-*`, `magento/product-community-edition`, and Mage-OS forks
   published under the same `magento/` vendor prefix), OR `"type"` starts with
   `magento2-module` / `magento2-theme` (the two Composer package types
   Magento's own `magento/magento-composer-installer` recognizes for
   individually-published modules).
2. **Fallback — module signature.** Require BOTH of:
   - a `registration.php` file anywhere in the tree calling
     `ComponentRegistrar::register(ComponentRegistrar::MODULE, ...)` (the
     line every Magento module's bootstrap file contains, unconditionally,
     since Magento 2.0), AND
   - an `etc/module.xml` file with a `<module name="...">` root element,
   in the same module directory (same pairing discipline Drupal's fallback
   uses: require two independent signals, not one, so a stray file elsewhere
   in an unrelated tree can't false-positive).

This two-tier detection is deliberately narrower than "any `routes.xml`
exists" — `routes.xml` alone is not a reserved filename and collides with
unrelated frameworks (notably Symfony's own `routes.xml` some Magento-adjacent
tooling ships), so detection must anchor on the Magento module envelope
(`registration.php` + `module.xml`), never on the routing file names alone.

## 3. Node shape — matches codegraph's native route model exactly

No new `NodeKind` is introduced. Every node this recognizer emits uses the
existing `route` kind from `NODE_KINDS` (`src/types.ts`) — the same kind
Drupal, Laravel, Rails, Express, etc. already emit — with the full `Node`
interface populated the same way every other framework recognizer populates
it:

```ts
interface Node {
  id: string;            // see "Node identity" below
  kind: 'route';          // no new kind — reuses the existing route NodeKind
  name: string;            // human-readable route summary, see per-family shape below
  qualifiedName: string;   // stable across re-syncs; see per-family shape below
  filePath: string;        // the declaring XML file (routes.xml / webapi.xml)
  language: 'xml';         // 'xml' is already a member of LANGUAGES (src/types.ts)
  startLine: number;
  endLine: number;
  startColumn: number;
  endColumn: number;
  updatedAt: number;
}
```

This is the identical shape `drupalResolver.extract`'s `extractDrupalRoutes`
already produces for `*.routing.yml` (compare
`src/resolution/frameworks/drupal.ts`'s `routeNode` literal — `id`, `kind:
'route'`, `name`, `qualifiedName`, `filePath`, `startLine`/`endLine`,
`language: 'yaml'`, `updatedAt`) — this spec only swaps `language: 'yaml'` for
`language: 'xml'` and adapts the id/name/qualifiedName strings to Magento's
two routing-file families. **No `Node` interface change, no new `NodeKind`,
no new `EdgeKind` — this recognizer is additive-only against
`src/types.ts`.**

### `routes.xml` (frontend / adminhtml HTML controllers)

One `route` node per **resolved controller action** — i.e. one node per
`Controller/<Path>/<Action>.php` class Magento's own routing convention would
actually dispatch to, not one node per `<route>` XML element (a `routes.xml`
`<route id="..." frontName="...">` element declares only the front name; it
never enumerates actions — see §4).

- `id`: `magento:route:<controller-file-path>::route` — anchored to the
  controller file, **not** `<area>:<frontName>/<path-segments>` — because the
  frontName is not known at `extract()` time (it lives in a sibling
  `routes.xml`, resolved only once `postExtract` runs, §4.2) and the
  `postExtract` contract requires the node `id` be preserved byte-for-byte
  across that pass so existing edges stay intact. The file path is already
  a unique, stable identity for a given controller action class, so no
  frontName/area component is needed in `id` at all — only in `name` (next
  bullet), which `postExtract` is free to rewrite.
- `name`: `"pending:<area>:/<frontName-placeholder>/<path-segments>"` at
  `extract()` time (e.g. `"pending:adminhtml:/<frontName>/widget/edit"`),
  rewritten by `postExtract` to `"<area>:/<frontName>/<path-segments>"` once
  the owning module's declared frontName is known (e.g.
  `"adminhtml:/moduleb/widget/edit"` — deliberately without an `/admin/`
  prefix; see §4.2 point 1 on why the runtime admin-path prefix is left
  out) — see §4.2. `<path-segments>` is
  the lowercase-underscore URL path Magento derives from the controller
  class's directory position — `index/index` is normalized to the bare
  `frontName` per Magento's own default-action elision rule. No single HTTP
  verb is asserted (Magento controllers are not verb-restricted by
  declaration — any `ActionInterface` responds to whatever HTTP verb the
  dispatcher lets reach it; see §4.3's honesty note).
- `qualifiedName`: `<controller-file-path>::route` — stable across re-syncs,
  matching the `postExtract` contract's "qualifiedName SHOULD be preserved so
  the pass stays idempotent" requirement (`src/resolution/types.ts`).
- `filePath`: the **controller PHP file's** path (not the `routes.xml` that
  declared the front name) — the route's precise textual location is the
  controller class, matching how Rails/Laravel resolvers already attach a
  route's `filePath`/line to the file the route is actually read from during
  extraction (see §5 for why cross-file frontName resolution still works with
  this filePath choice).
- `language`: `'xml'` is what the codegraph README's own convention would
  suggest for a config-declared route (Drupal uses `'yaml'` for the same
  reason), but because this recognizer's node identity is anchored to the
  **controller PHP file** (previous bullet), `language: 'php'` is used
  instead — the node lives where its `startLine`/`endLine` actually point.

### `webapi.xml` (REST/SOAP service endpoints)

One `route` node per `<route url="..." method="...">` element — this family
*does* have a single document with both the URL and the target
`class::method` in one place, so (unlike `routes.xml`) no cross-file
resolution or `postExtract` pass is needed; it is extracted in one shot,
exactly like Drupal's routing.yml handling.

- `id`: `magento:route:webapi:<url>` — e.g.
  `magento:route:webapi:/V1/moduleb/foo`. Deliberately keyed on URL alone
  (not `method:url`) — Magento's own webapi.xml schema allows only one
  `<route>` per `(url, method)` pair but multiple HTTP methods legitimately
  share a URL (`GET /V1/foo` + `POST /V1/foo`); modelling that as one route
  node per URL with an aggregated method list (mirrored in `name`, below)
  avoids the same "IMPLEMENTS-collision" class of bug this project's own
  `docs/edge-taxonomy.md` had to correct for `preference_for` — two sibling
  `route` nodes with names differing only by HTTP verb would be
  indistinguishable to a caller querying "what handles `/V1/moduleb/foo`".
- `name`: `"<HTTP-method> <url>"`, e.g. `"GET /V1/moduleb/foo"`.
- `qualifiedName`: `<webapi.xml-path>::route:<url>`.
- `filePath`: the declaring `webapi.xml` file.
- `language`: `'xml'`.

## 4. Edge shape — reuses the existing `references` `EdgeKind`, no new kind

No new `EdgeKind` is introduced either. Both families emit the existing
`references` edge kind from `EDGE_KINDS` (`src/types.ts`) — the same kind
Drupal's `_controller`/`_form` handler links and every other framework
resolver's route→handler edge already use — via the standard
`UnresolvedRef` → `ResolvedRef` pipeline (`src/resolution/types.ts`), not a
bespoke edge type:

```ts
interface UnresolvedRef {
  fromNodeId: string;       // the route node (source) — see direction note below
  referenceName: string;    // resolver-internal key, see per-family shape
  referenceKind: 'references';
  line: number;
  column: number;
  filePath: string;
  language: Language;
}
```

**Direction: the route node is the source, the controller/service class is
the target** — i.e. the edge reads "this route references this handler",
matching `drupalResolver.extract`'s own `extractDrupalRoutes` exactly
(`fromNodeId: routeNode.id`, `referenceName: handler` — see
`src/resolution/frameworks/drupal.ts`'s `flushRoute`). This spec follows the
established upstream convention (the explicit "pattern to mirror" this draft
was scoped against) rather than inventing a new direction.

Note this is the **opposite** direction from pb-codegraph's own local,
unrelated Magento augmenter (`docs/edge-taxonomy.md`'s "Endpoint model":
"class node is the source, route node is the target"). That project made an
independent, downstream-consumer-specific choice for its own SQLite schema
and impact-query CTEs (see that repo's own devils-advocate review record) —
it is not a signal about which direction `codegraph` itself should use.
Inside `codegraph`, consistency with the existing Drupal/Rails/Laravel
recognizers matters more than parity with an unrelated downstream tool, so
this spec deliberately follows Drupal's direction, not pb-codegraph's.

### 4.1 `routes.xml` edges — route node → controller class

The controller class is **not** re-minted as a node by this resolver — it is
ordinary PHP already indexed by codegraph's own PHP extractor. Rather than
computing the extractor's node id directly (which would require duplicating
the extractor's exact id-generation inputs at a point in the pipeline where
they aren't reliably available — `extract()` receives only `(filePath,
content)`, no `ResolutionContext`), this resolver mints a resolver-private
sentinel reference name (`magento:controller-class:<ClassName>`) and resolves
it in `resolve()` via `context.getNodesInFile(ref.filePath)` filtered to
`kind === 'class'` — a **file-scoped** lookup, not Drupal's global by-name
search. This matters here specifically: Magento action class names
(`Index`, `Edit`, `Save`, `Delete`, `View`, ...) collide constantly *across*
unrelated modules' `Controller/` trees (nearly every module ships an
`Index/Index.php`), so a global `getNodesByName(className)` search — safe for
Drupal's comparatively unique controller class names — would be ambiguous
here. Anchoring to `ref.filePath` (which `extract()` always knows precisely,
since it is literally parsing that file) sidesteps the collision entirely.

### 4.2 Frontname → area → path → controller action class (the routing convention)

This is the actual Magento convention this recognizer statically encodes —
the part that has no single-file source of truth and therefore requires the
`postExtract` cross-file pass (`src/resolution/types.ts`'s
`FrameworkResolver.postExtract`, the same hook NestJS's `RouterModule.register`
prefix-fixup already uses for the identical "declared in file A, applies to
file B" shape):

1. **`routes.xml` declares `frontName ↔ module` only**, keyed by `area`
   (`etc/frontend/routes.xml` or `etc/adminhtml/routes.xml`):
   ```xml
   <router id="standard">
     <route id="moduleb" frontName="moduleb">
       <module name="Acme_ModuleB" />
     </route>
   </router>
   ```
   `frontName="moduleb"` + `area=frontend` binds every action reachable under
   `/moduleb/...` to controllers physically located inside the `Acme_ModuleB`
   module's `Controller/` directory (adminhtml routes are additionally
   prefixed with Magento's configured admin path, e.g. `/admin/moduleb/...`
   — this recognizer emits the un-prefixed `adminhtml:` area tag and leaves
   the actual admin-path string out of the id, since it is an
   environment-specific runtime config value, not a static-analysis fact).

2. **Controller action path is 100% directory convention**, never declared
   in any XML: a class at
   `<ModuleDir>/Controller/<PathSegments>/<Action>.php` implementing
   `\Magento\Framework\App\ActionInterface` (directly, or by extending
   `\Magento\Framework\App\Action\Action` / implementing one of the
   `Http{Get,Post,...}ActionInterface` siblings) is reachable at
   `/<frontName>/<lowercase-underscore PathSegments>/<lowercase-underscore
   Action>` for the `frontend` area, or
   `/<admin-path>/<frontName>/<...>` for `adminhtml`. `Index/Index.php` is
   Magento's default-action elision case: both segments drop when equal to
   `index`, so `Controller/Index/Index.php` alone is reachable at the bare
   `/<frontName>` in addition to `/<frontName>/index/index`.

3. **`postExtract` performs the join**, in one project-wide pass, called once
   after every file's `extract()` has run (and again on every incremental
   sync, per the interface's own contract):
   - Parse every `etc/frontend/routes.xml` / `etc/adminhtml/routes.xml` in
     the project into a `moduleName → { area → frontName }` map.
   - For every route node this resolver's `extract()` already minted from a
     `Controller/**/*.php` file (§4.1), resolve the owning module name from
     the file's path (`app/code/<Vendor>/<Module>/Controller/...` — the
     `<Vendor>_<Module>` pair is the module name Magento itself uses; Magento
     never nests one module's `Controller/` tree inside another's directory,
     so this is unambiguous), look up its `frontName` in the map built above,
     and return the route node with `name` (and only `name` — `id` and
     `qualifiedName` are preserved byte-for-byte, satisfying the interface's
     "node id MUST be preserved so existing edges ... stay intact" contract)
     rewritten from its `extract()`-time placeholder to the fully resolved
     `<area>:/<frontName>/<path-segments>` string.
   - A controller class whose owning module declares **no** matching
     `routes.xml` for its area (a legitimate but inert Magento authoring
     mistake — the module ships a controller no route ever reaches) is left
     with its unresolved placeholder name and is NOT dropped; this documents
     the gap explicitly rather than silently hiding an orphaned controller,
     which is itself useful signal for "what dead controller code exists"
     impact queries.

### 4.3 Route honesty note (only partial parity with pb-codegraph's own v0.2 choice)

pb-codegraph's own local Magento augmenter (`docs/edge-taxonomy.md`'s "Route
honesty note") deliberately emits **no** `route → controller` edge for
`routes.xml`, because its scope (a SQLite row-writer bolted onto an
already-built codegraph DB, per `augmenter/src/mappers/routes-xml-mapper.ts`'s
header comment) has no cheap way to walk the project's `Controller/`
directory tree and match it against already-indexed PHP nodes — the
augmenter only has the parsed XML, not the extractor's live node table, at
the point it runs.

**Upstream `codegraph` does not have that limitation.** Its `extract()` and
`postExtract()) hooks run *inside* the same pass that already tree-sitter-
parses every PHP file in the project — the class nodes this recognizer needs
to link to already exist in the graph being built, for free, at the moment
`postExtract` runs (compare: NestJS's `postExtract` already resolves sibling
`.module.ts` files this same way for prefix mutation). This is a real
capability gap between the two projects, not a stylistic choice, and it is
why this recognizer can honestly close the gap pb-codegraph's own docs
explicitly declined to fabricate: **§4.2's `postExtract` join is optional
relative to a minimal version of this recognizer** (a v1 could ship
`routes.xml` → `frontName`-only nodes with no controller edge, matching
pb-codegraph's honesty note) **but is included in this spec because upstream
codegraph, unlike the local augmenter, actually has the data on hand to do it
correctly.**

One honesty note carries over unchanged, however: Magento does not restrict
an `ActionInterface` controller to a single HTTP verb by declaration — the
verb-specific `Http{Get,Post,Put,Delete}ActionInterface` markers are
optional, and a bare `ActionInterface`/`Action`-extending controller answers
whatever verb the front controller lets through. §3's `name` field therefore
never asserts a single resolved verb for `routes.xml`-family nodes (unlike
`webapi.xml`, where the verb is an explicit, unambiguous XML attribute).

### 4.4 `webapi.xml` edges — route node → service class/method

```xml
<route url="/V1/moduleb/foo" method="GET">
  <service class="Acme\ModuleA\Model\Foo" method="getFoo" />
</route>
```

- `fromNodeId`: the route node's own id (`magento:route:webapi:<url>`, §3) —
  route is the source, per §4's direction note.
- `referenceName`: the raw `<service class>::<service method>` string (e.g.
  `Acme\ModuleA\Model\Foo::getFoo`), matching the shape
  `magentoResolver.claimsReference` must recognize per §5. `resolve()`
  resolves it the same way Drupal resolves `_controller:
  '\Drupal\...\Class::method'` (`drupalResolver.resolve`'s
  `controllerMatch` branch) — strip the leading `\`, take the FQCN's last
  namespace segment as the simple class name, `context.getNodesByName(className)`
  filtered to `kind === 'class'`, then look for a `method` node in that same
  file matching `method` (`serviceRaw['@_method']`). Falls back to the class
  node itself if no matching method node is found (interface-only method
  declarations, or a method codegraph's PHP extractor didn't index for some
  other reason) — same two-tier fallback Drupal's own `controllerMatch`
  branch already uses (method node at confidence 0.9, class node at 0.7).
- Confidence: 0.9 when a `method` node is found, 0.7 for the class-only
  fallback — identical scale to Drupal's `_controller` resolution, so cross-
  framework confidence comparisons stay meaningful.

## 5. `claimsReference` — required for the same reason as Drupal/Laravel

`Acme\ModuleA\Model\Foo::getFoo` and a bare FQCN like
`Magento\Catalog\Model\Product` do not name any node codegraph's own
extractor declared (they name a *reference target*, not a source symbol), so
the default resolution pre-filter would drop both before `resolve()` ever
runs — the exact problem Drupal's own code comment documents for its
`_controller`/`hook_*` refs and Laravel's comment documents for
`Controller@method`. `magentoResolver.claimsReference` therefore mirrors
Drupal's regex shape:

```ts
claimsReference(name: string): boolean {
  return name.includes('\\') || /^[A-Za-z_]\w*::\w+$/.test(name);
}
```

## 6. `languages`

```ts
languages: ['php', 'xml']
```

Both `'php'` and `'xml'` are already members of `LANGUAGES` (`src/types.ts`)
— no new language is introduced. `'php'` is required because §4.1's route
node identity is anchored to the controller PHP file (not the declaring
`routes.xml`); `'xml'` is required for `webapi.xml` extraction and for the
`postExtract` pass's `routes.xml` reads.

## 7. Summary table — matches the README's existing "Framework-aware Routes" table row format

| Framework | Shapes recognized |
|---|---|
| **Magento 2 / Mage-OS** | `routes.xml` frontName declarations joined against `Controller/<Path>/<Action>.php` convention (frontend + adminhtml areas); `webapi.xml` `<route url="..." method="...">` → `<service class="..." method="...">` |

This is the same one-line grammar the README's table already uses for every
other entry (compare the existing Drupal row: `` `*.routing.yml` routes
(`_controller`, `_form`, entity handlers); `hook_*` implementations ``) —
ready to insert into `README.md`'s Framework-aware Routes table as-is (see
`PR_DESCRIPTION.md`).
