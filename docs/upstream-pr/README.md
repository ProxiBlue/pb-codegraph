# Upstream PR prep — Magento 2 / Mage-OS recognizer for `colbymchenry/codegraph`

Status: **draft, not submitted.** Task 012 (stretch) of pb-codegraph's
v0.2.0 plan (`.claude/plans/v0-2-0-codegraph-engine/012-upstream-pr-prep.md`).
Submission (opening the actual PR/issue against
[colbymchenry/codegraph](https://github.com/colbymchenry/codegraph)) is
Lucas's call — nothing in this directory should be interpreted as already
submitted, and nothing here opens a PR or issue on its own.

## Why this exists

pb-codegraph pins and augments the upstream `@colbymchenry/codegraph` package
(`shared/pinned.ts`) rather than forking it. Upstream's own README already
frames "Framework-aware Routes" as a first-class capability across 17
frameworks — including Drupal, the closest precedent for Magento's shape of
problem (PHP/Composer ecosystem, routing split across a declarative config
file and a filesystem convention). Contributing a Magento recognizer upstream
would let every `codegraph` user index Magento routing natively, and it would
let pb-codegraph itself eventually retire the `routes.xml`/`webapi.xml`
slice of its own local augmenter (`augmenter/src/mappers/routes-xml-mapper.ts`,
`augmenter/src/mappers/webapi-xml-mapper.ts`) in favor of upstream's richer,
context-aware version (see `magento-recognizer-spec.md` §4.3 for why upstream
can do strictly more than the local augmenter — it has the extractor's own
already-indexed PHP nodes on hand, the local augmenter doesn't).

## Contents

| File | What it is |
|---|---|
| `magento-recognizer-spec.md` | The recognizer spec — node/edge shapes (matched against `codegraph`'s existing native `route`/`references` model, no new `NodeKind`/`EdgeKind`), the frontName → area → path → controller-action-class routing convention, detection heuristic, and every point of deliberate divergence from the Drupal precedent, justified. |
| `src/magento.ts` | The draft `FrameworkResolver` implementation. Drop-in target: `src/resolution/frameworks/magento.ts` in the upstream repo, registered in `src/resolution/frameworks/index.ts`. |
| `__tests__/magento.test.ts` | Draft test file. Drop-in target: `__tests__/magento.test.ts` in the upstream repo (top-level `__tests__/`, matching `drupal.test.ts`'s own location). |
| `fixtures/` | Fixture Magento module tree, reusing pb-codegraph task 001's `tests/fixture/app/code/Acme/` tree as its base (see `fixtures/README.md` for exactly which files are verbatim copies vs. new-for-this-PR). Exercises both the frontend and webapi route families, plus adminhtml area handling and the default-action elision case. |
| `PR_DESCRIPTION.md` | Copy-paste-ready PR body, in upstream's own style (their README's existing "Framework-aware Routes" table row format, their own test-plan checklist convention). |

## What was researched to write this

- `README.md`'s "Framework-aware Routes" section (upstream) — the feature
  framing, the existing 17-framework table, and the coverage-honesty
  discipline ("the convention/reflection-heavy ones at their honest
  static-analysis ceiling: ... Drupal 78.9% ...") this spec's §4.3 honesty
  note follows.
- `src/resolution/frameworks/drupal.ts` (upstream) — the explicit "pattern to
  mirror" this task named. Its `FrameworkResolver` shape (`detect`,
  `claimsReference`, `resolve`, `extract`), its `UnresolvedRef`/`ResolvedRef`
  two-tier method/class-fallback resolution, its route-node literal shape,
  and critically its **route-is-source edge direction**
  (`fromNodeId: routeNode.id`) — this spec initially assumed the opposite
  direction (matching pb-codegraph's own local, unrelated augmenter
  convention) and was corrected to match Drupal's actual precedent once that
  file was read directly; see `magento-recognizer-spec.md` §4's direction
  note for the full explanation of why the two projects reasonably differ.
- `src/resolution/frameworks/nestjs.ts` (upstream) — the `postExtract`
  cross-file finalization pattern (`RouterModule.register` prefix fixup) this
  spec's §4.2 frontName join directly reuses; same "declared in file A,
  applies to file B" shape.
- `src/resolution/frameworks/laravel.ts` (upstream) — a second PHP-ecosystem
  precedent, confirming the FQCN-handling and `claimsReference` conventions
  drupal.ts uses aren't Drupal-specific idiosyncrasies.
- `src/resolution/types.ts`, `src/types.ts` (upstream) — the `Node`/`Edge`/
  `UnresolvedRef`/`ResolvedRef`/`FrameworkResolver`/`ResolutionContext`
  interfaces this spec and draft implementation are typed against, and the
  `NODE_KINDS`/`EDGE_KINDS`/`LANGUAGES` const arrays confirming `route`,
  `references`, `'php'`, and `'xml'` all already exist — nothing here adds a
  new kind or language.
- `__tests__/drupal.test.ts` (upstream) — the test-file structure (a
  `makeContext` helper matching `ResolutionContext`, per-method `describe`
  blocks, and one real-`CodeGraph`-instance end-to-end test over a
  `fs.mkdtempSync` temporary project) this draft's own test file follows.
- This repo's `docs/edge-taxonomy.md`, `augmenter/src/parsers/routes-xml.ts`,
  `augmenter/src/parsers/webapi-xml.ts`, `augmenter/src/mappers/routes-xml-mapper.ts`,
  `augmenter/src/mappers/webapi-xml-mapper.ts`, and
  `tests/fixture/app/code/Acme/` — pb-codegraph's own independent local
  design for the same two Magento XML files, useful as a *contrast*
  (different consumer, different constraints, different edge direction —
  see the spec's §4 direction note) rather than a template to copy.
- `colbymchenry/codegraph`'s repo root listing (via the GitHub contents API)
  — confirmed no `CONTRIBUTING.md` exists upstream (a 404), so this draft
  follows the README's own documented conventions (table format, test
  commands from `CLAUDE.md`'s "Build, Test, Run" section) as the closest
  thing to a contribution style guide, rather than inventing one.

## Before this is submitted (not done as part of this task)

1. Clone `colbymchenry/codegraph` for real and run
   `docs/upstream-pr/__tests__/magento.test.ts` against an actual checkout —
   it has not been executed in this sandbox (no checkout available; the
   import paths in both `src/magento.ts` and `__tests__/magento.test.ts` are
   relative to a location inside that repo, not this one).
2. Confirm the fallback controller-detection heuristic
   (`looksLikeMagentoController`) and the URL-segment casing helper
   (`toUrlSegment`) against a larger real-world Magento codebase, not just
   this task's small fixture tree — regex-based heuristics like Drupal's own
   hook-name-pattern fallback are inherently approximate, and the coverage
   validation methodology described in the upstream README (`docs/benchmarks/`
   directory, referenced from `CLAUDE.md`) should be run before claiming a
   coverage percentage in the PR description.
3. Decide whether to open this as a PR directly or an issue proposing the
   scope first — upstream has no `CONTRIBUTING.md` stating a preference
   either way.
