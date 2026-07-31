<!--
Draft PR description for colbymchenry/codegraph. Copy-paste into the PR body
as-is once the branch/commits described below actually exist upstream.
Submission is not automatic — see docs/upstream-pr/README.md.
-->

# Add Magento 2 / Mage-OS framework recognizer

## Summary

Adds a 17th "Framework-aware Routes" recognizer (`src/resolution/frameworks/magento.ts`)
for Magento 2 / Mage-OS, the same shape of PHP/Composer, convention-heavy
routing gap Drupal already fills for `*.routing.yml`:

- **`routes.xml`** (frontend + adminhtml) — joins each area's declared
  `frontName` against the project's `Controller/<Path>/<Action>.php`
  convention to mint one `route` node per resolved controller action, with a
  `references` edge from the route to the controller class.
- **`webapi.xml`** — one `route` node per `<route url method>` element, with
  a `references` edge from the route to the resolved
  `<service class method>` target (method node when indexed, class node
  fallback).

No new `NodeKind` or `EdgeKind` — both families reuse the existing `route`
kind and `references` edge kind, the same ones every other framework
recognizer in this list already emits.

## Why

Magento 2 / Mage-OS has hundreds of thousands of live installs and, like
Drupal, splits routing across a declarative config file (frontName only) and
a filesystem convention (the actual controller/action mapping) — a pure
static-analysis problem with no LLM required, the same category this project
already solves for Laravel, Rails, and Drupal.

## What's included

- `src/resolution/frameworks/magento.ts` — the recognizer (`magentoResolver`),
  following `drupalResolver`'s structure and conventions as closely as the
  two frameworks' actual routing shapes allow (see inline comments for every
  point of deliberate divergence, e.g. the file-scoped controller-class
  lookup instead of Drupal's global by-name search — collision risk from
  Magento's extremely common `Index`/`Edit`/`Save` controller class names).
- Registration in `src/resolution/frameworks/index.ts`'s `FRAMEWORK_RESOLVERS`
  array (PHP section, alongside `laravelResolver`/`drupalResolver`) and the
  corresponding named re-export.
- `__tests__/magento.test.ts` — unit tests for `detect`/`extract`/`resolve`/
  `postExtract`, plus one end-to-end test (mirrors
  `__tests__/drupal.test.ts`'s own E2E test) confirming the full pipeline
  resolves a route's frontName correctly against a temporary Magento module
  layout.
- A `README.md` "Framework-aware Routes" table row:

  ```markdown
  | **Magento** | `routes.xml` frontName declarations joined against `Controller/<Path>/<Action>.php` convention (frontend + adminhtml areas); `webapi.xml` `<route url method>` → `<service class method>` |
  ```

## Design notes worth a reviewer's attention

1. **Route node identity is anchored to the controller PHP file, not
   `routes.xml`** — the frontName that completes a route's human-readable
   name is only known after a project-wide `postExtract` join (Magento's
   `routes.xml` declares `frontName ↔ module` only; the actual
   controller/action mapping is 100% directory convention, never declared in
   XML). `id`/`qualifiedName` are minted once at `extract()` time and never
   change; only `name` is rewritten by `postExtract`, per the interface's own
   "node id MUST be preserved" contract.
2. **`postExtract` is the intended hook for this** — same "declared in file
   A, applies to file B" shape `NestJS`'s `RouterModule.register` prefix
   fixup already uses.
3. **No `route → controller` edge is fabricated when a module ships a
   controller with no matching `routes.xml`** — that's a real (if unusual)
   authoring gap in the source project, and leaving the route node in its
   unresolved-placeholder state documents it rather than hiding it.
4. **Scope: routing only.** `di.xml` (DI preferences/plugins), `events.xml`
   (observers), and layout XML (block/template rendering) are Magento's
   other three XML wiring surfaces and are deliberately out of scope for
   this PR — each is a distinct extraction shape (dependency injection,
   event dispatch, view rendering — not routing) and belongs in its own
   follow-up, not bundled here.

## Test plan

- [ ] `npx vitest run __tests__/magento.test.ts`
- [ ] `npx vitest run __tests__/frameworks.test.ts __tests__/frameworks-integration.test.ts` (regression — confirm the new resolver's registration doesn't change existing framework-detection behavior for unrelated projects)
- [ ] `npm run build && npm test` (full suite)

## Out of scope / follow-ups

- `di.xml` preference/plugin edges (separate PR).
- `events.xml` observer edges (separate PR).
- Layout XML block/template edges (separate PR).
- Resolving the admin URL path prefix from `env.php`/`config.php` instead of
  leaving the `adminhtml:` area tag unprefixed (a runtime config value, not a
  static-analysis fact — deliberately deferred, documented in the resolver's
  header comment).

---

*Drafted per `docs/upstream-pr/magento-recognizer-spec.md` in
[ProxiBlue/pb-codegraph](https://github.com/ProxiBlue/pb-codegraph), which
depends on Magento/Mage-OS impact analysis and would consume this recognizer's
output once released.*
