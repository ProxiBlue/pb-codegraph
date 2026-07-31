# Task 013: Release 0.2.0

**Status**: completed
**Depends on**: 001, 002, 003, 003b, 004, 005, 006, 007, 008, 009, 010, 011
**Retry count**: 0

## Description
Version 0.2.0 in plugin manifests; CHANGELOG; README rewrite: engine architecture (codegraph + augmenter + shim), the v0.1 impact-check command's new deterministic backend (uses graph when .codegraph db present, legacy LLM flow otherwise — update commands/impact-check.md with the detection step), install/cutover pointers, RECOVERY.md-compatible restore section (registry, core indexes rebuildable, nothing secret). Consistency sweep: tsc/tests green, shellcheck, JSON valid, NOTICE/Apache-2.0 attribution intact, no secrets, every new file referenced from README.

## Requirements (Test Descriptions)
- [x] `it bumps 0.2.0 in plugin and marketplace manifests`
- [x] `it documents every deliverable in changelog and readme`
- [x] `it updates impact-check command with graph-backend detection`
- [x] `it passes the consistency sweep including attribution and no-secrets checks`

## Acceptance Criteria
- Repo self-documenting; fleet sync picks up 0.2.0

## Implementation Notes

**Pre-existing sweep fixes (accumulated-from-orchestration issues named in the task brief, fixed before the 4 requirement tests were written):**

1. **tsconfig surface** (`tsconfig.json`): `include` extended with `scripts/**/*.ts` and `bin/**/*.ts` (neither was actually type-checked before — `bin/pb-codegraph.ts` and all of `scripts/lib/*.ts` were silently outside the include set) and `exclude` now explicitly lists `docs/upstream-pr/**/*` (it was already omitted from `include`, so already excluded in practice, but the explicit exclude documents the intent and defends against a future glob widening). `npx tsc --noEmit` is clean over the full new `include` set with zero new errors — the previously-reported `node:fs`/`process` diagnostics did not reproduce once `scripts/lib/*.ts` was actually added to `include` (the ambient `process`/`node:*` types resolve fine under the existing `"types": ["node"]` + `@types/node` devDependency; nothing else needed changing).
2. **docs/edge-taxonomy.md direction fix**: the "Kind remap table" row for `preference_for` read "interface node → concrete class node", backwards per task 003b's own implementation notes (which flag the same discrepancy and cite both the vendored mapper's actual `sourceId`/`targetId` assignment in `augmenter/src/mappers/di-xml-mapper.ts` and task 003b's own task-file prose as agreeing on the opposite direction). Corrected the table row to "concrete class node → interface/abstract class node" and added an explicit correction note beneath the "distinct kind" paragraph, citing the source code line (`sourceId: implNode.id, targetId: interfaceNode.id`) as evidence. Verified against `tests/edge-taxonomy-doc.test.ts` (no assertion pinned the old wrong text) and the real mapper source — still green.
3. **tests/sqlite-writer.test.ts unused import**: removed `MINTED_NODE_KINDS` from the import list (was never referenced in the file body).
4. **Serial full-suite flake sweep**: `tests/schema-guard.test.ts` was the one remaining file reading the shared `tests/fixture/.codegraph/codegraph.db` path directly (via a `before`-hook `fs.copyFileSync` from that path), racing `tests/build-fixture-db.test.ts`'s destructive rebuild of that same path under `node --test`'s default parallel file execution — the exact class of race already fixed elsewhere (tasks 003/005) and explicitly flagged as out-of-scope-for-then in task 003/008's own implementation notes. Migrated it to `tests/helpers/isolated-fixture-db.ts`'s `buildIsolatedFixtureDb()`, matching every other MCP/writer/resolver test file. Verified: 3 consecutive serial runs (`node --test --test-concurrency=1 --import tsx tests/*.test.ts`) and 3 consecutive default-parallel runs (`npm test`), all 78/78 green, both before and after adding this task's own new test file.

**This task's own deliverables:**

- `.claude-plugin/plugin.json` / `.claude-plugin/marketplace.json`: version bumped to `0.2.0`; descriptions rewritten to describe the deterministic codegraph engine (augmenter + MCP shim) as shipped, not roadmap — the marketplace entry also states the pps acceptance-tested-but-awaiting-sign-off status so fleet sync surfaces it accurately.
- `package.json` was already at `0.2.0` from an earlier task's edit (no change needed there — confirmed by test 1's assertion, which passed against the untouched file).
- `CHANGELOG.md` (new file): `0.5.0`-style entry (per `pb-gitnexus/CHANGELOG.md`'s `## <version> — <date>` + grouped-bullet convention) covering every deliverable family from tasks 001-012 (vendored foundation, sqlite writer, node-id resolver, mapper adaptation, augment CLI, MCP shim + all four tools, schema guard, core index build, ddev cutover, pps acceptance run + its AWAITING-SIGN-OFF status and known limitation, upstream PR prep, and this task's own impact-check detection step + edge-taxonomy doc correction), plus a `0.1.0` entry for the original LLM-driven release.
- `README.md`: full rewrite — v0.2.0 status banner (explicit "no project has been cut over, no GitNexus container stopped" statement), architecture section (engine/augmenter/shim), retained companion-to-pb-graphiti section, install (clarifies the graph backend is opt-in per project), a "Two backends, one command" usage section documenting the Step 0 detection flow, a cutover-runbook summary pointing at `docs/cutover.md`, a "Recovery / restore notes" section (RECOVERY.md-pattern-compatible: engine is `npx`-fetched not vendored, project/core indexes are 100% rebuildable caches, `registry.json` holds only local paths, nothing secret — explicitly ties to the secrets-grep sweep), a "Development" section (test/lint commands, explains why `docs/upstream-pr/` is excluded from this repo's own tsc/test runs, references `docs/vendor-dir-verification.md` and `scripts/lib/*.ts`), Dependencies, Known limitations (table-write/cron-concurrency not indexed, `wraps` before/after/around deferred, routes.xml controller-edge honesty note, the `references` collision found during acceptance, no cutover yet), Roadmap, and the unchanged Why-this-exists/License sections. Every new top-level file/directory from tasks 001-012 is either named explicitly or covered by a directory-level description (verified by hand against a full `find` listing during implementation, not just by the requirement test's sampled assertions).
- `commands/impact-check.md`: new "Step 0 — detect the backend" section (`test -f .codegraph/codegraph.db`) documenting which MCP tool (`find_symbol`/`context`/`impact`/`query`) answers which of the original steps 3a-3d, an explicit staleness-banner cross-check instruction, and an explicit statement that 3e (table-write/cron-concurrency) has no graph equivalent yet and always runs. Step 3's intro and the report template's "What I did NOT check" section were both updated to be backend-aware (a new "Backend used" report section) rather than silently assuming the legacy flow.
- New test file `tests/release-0-2-0.test.ts` — one test per requirement, following `tests/notice.test.ts`'s greppable-assertion pattern for doc/manifest requirements. The secrets-grep sub-check inside requirement 4 mirrors `.claude/testing.md`'s exact documented grep pattern and explicitly allow-lists only self-referential lines that quote the pattern itself (the same 3 files task 011's own implementation notes already identified as harmless self-matches), rather than a blanket regex-in-content check that would have false-failed on this task's own doc/test/README self-references.

**Full sweep results at completion:**
- `npx tsc --noEmit` — clean (0 errors) over `augmenter/`, `mcp/`, `shared/`, `bin/`, `scripts/`, `tests/`.
- `node --test --test-concurrency=1 --import tsx tests/*.test.ts` (serial, ×3) — 78/78 passing every run.
- `npm test` (default parallel, ×2) — 78/78 passing every run.
- `bash tests/build-core-indexes.test.sh` — 7/7 passing (unaffected shell-test harness, real pps `vendor/hyva-themes` smoke).
- Shellcheck (`docker run --rm -v "$PWD":/w koalaman/shellcheck:stable /w/scripts/<file>.sh`) — clean for all 3 `scripts/*.sh` files.
- JSON (`python3 -m json.tool`) — valid for all 8 `*.json` files in the repo (excluding `node_modules`/`.git`).
- Secrets grep (`grep -rE '(ff15ea68|9c111c47)' --exclude-dir=.git --exclude-dir=node_modules .`) — every hit is a self-reference documenting the pattern itself (`.claude/testing.md`, `README.md`, `docs/acceptance-report-pps-2026-07-31.md`, this task's own `tests/release-0-2-0.test.ts`); 0 real secret hits.
- NOTICE/Apache-2.0 attribution — `LICENSE` (Apache License 2.0) and `NOTICE` (vendoring/relicense statement) both present and unchanged from earlier tasks; README's License section still points at both and restates the Apache-2.0 §4 modification-notice obligation.
