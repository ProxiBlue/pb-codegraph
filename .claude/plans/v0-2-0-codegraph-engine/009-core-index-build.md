# Task 009: Shared core index build script + ignore conversion

**Status**: completed
**Depends on**: none
**Retry count**: 0

## Description
scripts/build-core-indexes.sh: builds the shared read-only DBs (mageos = vendor/mage-os, hyva = vendor/hyva-themes, deps = curated runtime libs) once centrally under ~/.pb-codegraph/indexes/<name>/ from a LIVE-BRANCH GIT ARCHIVE export to a temp dir (tar from git archive — NO scratch .git directories anywhere, NO writes inside project trees; the stray-git-lock failure mode of the old pipeline must be structurally impossible). Converts the existing .gitnexusignore.{mageos,hyva,deps} lists (at ~/workspace/proxiblue/mage-os-gitnexus/index/) into codegraph ignore config. Per-project custom+vendor-split indexing documented for the ddev task.

## Context
- HARD FLEET RULE: never rm anything under any project .git (2026-06-29 incident). Script must not touch project .git at all — archive export only, temp dirs under mktemp, cleanup trap.
- Reuse live-branch discipline from ~/.config/gitnexus/rebuild-all.sh (read as reference for branch overrides) but this script only handles CORE repos (mage-os source trees), not per-project code.

**Vendor-split ignore contract (see _devils_advocate.md I3):** The per-project index (built by the wrapper in 004/010) MUST exclude the shared cores (`vendor/mage-os`, `vendor/hyva-themes`) — those live in the central mageos/hyva DBs — while INCLUDING 3rd-party `vendor/*` so a custom plugin/preference targeting a 3rd-party class resolves to a real node instead of a bare `external` placeholder. This task produces both the core-DB ignore lists AND the per-project ignore template (converted from `.gitnexusignore.{mageos,hyva,deps}` at ~/workspace/proxiblue/mage-os-gitnexus/index/) that enforces this split. Cross-DB edges are out of scope (federation is query-merge), so a custom→mage-os plugin edge lands as an external placeholder in the project DB — document this expected gap.

## Requirements (Test Descriptions)
- [x] `it exports source via git archive into a temp dir and never creates a git dir in the export`
- [x] `it never writes inside the source project tree`
- [x] `it converts gitnexusignore patterns to codegraph ignore config`
- [x] `it emits a per-project ignore template that excludes vendor/mage-os and vendor/hyva-themes but keeps other vendor packages`
- [x] `it produces a queryable db per core repo under the central index dir`
- [x] `it cleans temp dirs on exit including failure paths`

## Acceptance Criteria
- shellcheck-clean; dry-run mode; smoke-tested against one real core repo on this host

## Implementation Notes

- Deliverable: `scripts/build-core-indexes.sh` + `tests/build-core-indexes.test.sh` (plain
  bash test harness, one `test_*` per requirement, run via `bash tests/build-core-indexes.test.sh`)
  + `templates/per-project-vendor-split.gitignore` (generated artifact for task 010's
  per-project vendor-split wrapper).
- **codegraph's ignore engine, empirically verified (not assumed):** `vendor/` is one of
  codegraph's built-in default-ignored dirs. `codegraph.json`'s `exclude`/`include` lists
  (dist/project-config.d.ts) explicitly CANNOT restore a built-in-ignored dir — only a root
  `.gitignore` negation (`!vendor/`) can, exactly like the original `.gitnexusignore` files
  already assumed (comment in dist/extraction/index.d.ts confirms: "merged with the
  project's root .gitignore ... a negation there (e.g. `!vendor/`) overrides a default").
  Confirmed live: a scratch dir with only `codegraph.json` include patterns left vendor/*
  files undiscovered ("No files found to index"); the same tree with a root `.gitignore`
  containing `!vendor/` indexed correctly. So "codegraph ignore config" for this engine
  IS a `.gitignore` file — the conversion writes one, not a `codegraph.json`.
- Ignore conversion (`derive_include_subpaths` + `build_gitignore_content` in the script):
  parses `.gitnexusignore.<name>` (real gitignore syntax) generically — no per-package
  names hardcoded. Leaf-most `!vendor/<path>/` negations become the physical `cp -a`
  copy-scope (vendor/ itself is composer-installed, never git-tracked, so `git archive`
  cannot pull it in); the GitNexus-specific "blanket re-ignore everything under vendor/"
  dance lines (`vendor/*`, `vendor/composer/*`, bare `!vendor/`) are dropped as structural
  noise superseded by the physical copy-scoping; every other line (comments, genuine
  excludes like `vendor/mage-os/language-*`, `**/Test/`) passes through verbatim as valid
  `.gitignore` syntax. Verified correct against the real
  `~/workspace/proxiblue/mage-os-gitnexus/index/.gitnexusignore.{mageos,hyva,deps}` files
  including the nested `vendor/composer/{semver,ca-bundle}` re-negation in `.deps`.
- **Scope-leak fix found during smoke testing (not in original design):** `git archive`
  of a real project's live branch exports its FULL tracked tree (app/code, pub/, etc.), not
  just vendor metadata. Left unguarded, indexing pvcpipesupplies as the core-build source
  pulled 590 files (all of pps's tracked source) into what must be a vendor-only shared
  core DB. Fixed by prefixing the generated `.gitignore` with `/*` + `!/vendor/` so a core
  index can only ever contain `vendor/` content regardless of what else the source
  project's live branch tracks. Re-verified via smoke test: file count dropped from 590 to
  3 (the vendor/hyva-themes subset only) with `--source pvcpipesupplies --only hyva --limit 5`.
- **Trap/exit-code bug found and fixed during TDD:** the `cleanup()` EXIT trap's last
  command status (a `[ -d "$dir" ]` check) was silently overwriting the script's real exit
  code (a successful build reported exit 1). Fixed by capturing `$?` as the very first
  statement in `cleanup()` and explicitly `exit`-ing with it at the end — standard bash
  EXIT-trap discipline.
- **Subshell scoping bug found and fixed during TDD:** an earlier `new_scratch_dir()`
  helper appended to the global `SCRATCH_DIRS` array from inside a `$(...)` command
  substitution (a subshell) — the append never reached the parent shell, so `cleanup()`
  silently cleaned nothing despite reporting success. Fixed by inlining `mktemp` +
  `SCRATCH_DIRS+=(...)` directly in `build_core_target()` (no subshell).
- Smoke-tested against real pvcpipesupplies on-disk `vendor/hyva-themes` (read-only,
  `--limit 5`, throwaway `--index-dir`); confirmed `git status --porcelain` on pps is
  unchanged before/after and no `.git` dir appears anywhere in the export.
- shellcheck: clean (`docker run --rm -v "$PWD":/w koalaman/shellcheck:stable
  /w/scripts/build-core-indexes.sh`) after removing one unused array var and adding a
  `# shellcheck disable=SC2329` on `cleanup()` (false positive — it IS invoked, via `trap`).
- Secrets grep: 0 real hits (only self-match inside `.claude/testing.md`'s own grep pattern
  string).
- Env-driven, no baked host paths: `PB_CODEGRAPH_INDEX_DIR` (default
  `~/.pb-codegraph/indexes`), `PB_CODEGRAPH_IGNORE_SOURCE_DIR` (default
  `~/workspace/proxiblue/mage-os-gitnexus/index`), `PB_CODEGRAPH_LIVE_BRANCH` (default
  `live`), `PB_CODEGRAPH_VERSION` (default pinned `1.5.0`) — all overridable via flags too.
