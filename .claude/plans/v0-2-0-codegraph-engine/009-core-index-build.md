# Task 009: Shared core index build script + ignore conversion

**Status**: pending
**Depends on**: none
**Retry count**: 0

## Description
scripts/build-core-indexes.sh: builds the shared read-only DBs (mageos = vendor/mage-os, hyva = vendor/hyva-themes, deps = curated runtime libs) once centrally under ~/.pb-codegraph/indexes/<name>/ from a LIVE-BRANCH GIT ARCHIVE export to a temp dir (tar from git archive — NO scratch .git directories anywhere, NO writes inside project trees; the stray-git-lock failure mode of the old pipeline must be structurally impossible). Converts the existing .gitnexusignore.{mageos,hyva,deps} lists (at ~/workspace/proxiblue/mage-os-gitnexus/index/) into codegraph ignore config. Per-project custom+vendor-split indexing documented for the ddev task.

## Context
- HARD FLEET RULE: never rm anything under any project .git (2026-06-29 incident). Script must not touch project .git at all — archive export only, temp dirs under mktemp, cleanup trap.
- Reuse live-branch discipline from ~/.config/gitnexus/rebuild-all.sh (read as reference for branch overrides) but this script only handles CORE repos (mage-os source trees), not per-project code.

**Vendor-split ignore contract (see _devils_advocate.md I3):** The per-project index (built by the wrapper in 004/010) MUST exclude the shared cores (`vendor/mage-os`, `vendor/hyva-themes`) — those live in the central mageos/hyva DBs — while INCLUDING 3rd-party `vendor/*` so a custom plugin/preference targeting a 3rd-party class resolves to a real node instead of a bare `external` placeholder. This task produces both the core-DB ignore lists AND the per-project ignore template (converted from `.gitnexusignore.{mageos,hyva,deps}` at ~/workspace/proxiblue/mage-os-gitnexus/index/) that enforces this split. Cross-DB edges are out of scope (federation is query-merge), so a custom→mage-os plugin edge lands as an external placeholder in the project DB — document this expected gap.

## Requirements (Test Descriptions)
- [ ] `it exports source via git archive into a temp dir and never creates a git dir in the export`
- [ ] `it never writes inside the source project tree`
- [ ] `it converts gitnexusignore patterns to codegraph ignore config`
- [ ] `it emits a per-project ignore template that excludes vendor/mage-os and vendor/hyva-themes but keeps other vendor packages`
- [ ] `it produces a queryable db per core repo under the central index dir`
- [ ] `it cleans temp dirs on exit including failure paths`

## Acceptance Criteria
- shellcheck-clean; dry-run mode; smoke-tested against one real core repo on this host
