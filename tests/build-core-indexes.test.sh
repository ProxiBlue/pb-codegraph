#!/usr/bin/env bash
# tests/build-core-indexes.test.sh
#
# Behavior tests for scripts/build-core-indexes.sh. Plain bash (no test
# framework needed for a shell script under test) — each requirement from
# .claude/plans/v0-2-0-codegraph-engine/009-core-index-build.md gets one
# `test_*` function. Run: bash tests/build-core-indexes.test.sh
#
# Network/npx calls are real (npx --yes is cached locally on this host —
# see package-lock evidence in ~/.npm/_npx). The "real core repo" smoke test
# uses pvcpipesupplies's on-disk vendor/ (read-only) per testing.md, capped
# with --limit for speed.
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
SUT="$REPO_ROOT/scripts/build-core-indexes.sh"

WORK="$(mktemp -d "${TMPDIR:-/tmp}/pb-codegraph-core-test-XXXXXX")"
trap 'rm -rf "$WORK"' EXIT

PASS=0
FAIL=0

ok()   { PASS=$((PASS+1)); printf 'ok   - %s\n' "$1"; }
bad()  { FAIL=$((FAIL+1)); printf 'FAIL - %s\n' "$1"; shift; [ $# -gt 0 ] && printf '       %s\n' "$*"; }

# --- fixture: a throwaway git "project" (never a real project tree) with a
# tiny vendor/ tree that mimics mage-os / hyva-themes / a 3rd-party package.
# This is intentionally NOT under $REPO_ROOT and is created fresh per run —
# nothing this test does touches the pb-codegraph repo's own .git.
make_fixture_project() {
  local dir="$1"
  mkdir -p "$dir"
  git -C "$dir" init -q -b live
  git -C "$dir" config user.email test@example.com
  git -C "$dir" config user.name test
  mkdir -p "$dir/app/code/Vendor/Sample"
  echo '<?php class Sample {}' > "$dir/app/code/Vendor/Sample/Sample.php"
  git -C "$dir" add -A
  git -C "$dir" commit -q -m "init"

  mkdir -p "$dir/vendor/mage-os/module-sample" "$dir/vendor/hyva-themes/sample-theme" "$dir/vendor/some3rdparty/lib"
  cat > "$dir/vendor/mage-os/module-sample/Sample.php" <<'EOF'
<?php
namespace MageOs\Sample;
class Sample
{
    public function hello(): string
    {
        return 'hi';
    }
}
EOF
  cat > "$dir/vendor/hyva-themes/sample-theme/Sample.php" <<'EOF'
<?php
namespace Hyva\Sample;
class Sample
{
    public function hello(): string
    {
        return 'hi';
    }
}
EOF
  cat > "$dir/vendor/some3rdparty/lib/Sample.php" <<'EOF'
<?php
namespace ThirdParty\Sample;
class Sample
{
    public function hello(): string
    {
        return 'hi';
    }
}
EOF
}

# --- fixture: minimal .gitnexusignore.<name> files mirroring the real ones
# structurally (blanket-vendor dance + a nested composer-style re-negation)
# so the conversion logic is exercised the same way it would be against the
# real files at ~/workspace/proxiblue/mage-os-gitnexus/index/.
make_fixture_ignore_dir() {
  local dir="$1"
  mkdir -p "$dir"
  cat > "$dir/.gitnexusignore.mageos" <<'EOF'
!vendor/
!vendor/mage-os/
vendor/*
!vendor/mage-os/
vendor/mage-os/language-*
*.md
**/Test/
EOF
  cat > "$dir/.gitnexusignore.hyva" <<'EOF'
!vendor/
!vendor/hyva-themes/
vendor/*
!vendor/hyva-themes/
*.md
**/Test/
EOF
  cat > "$dir/.gitnexusignore.deps" <<'EOF'
!vendor/
!vendor/laminas/
!vendor/composer/semver/
!vendor/composer/ca-bundle/
vendor/*
!vendor/laminas/
!vendor/composer/
vendor/composer/*
!vendor/composer/semver/
!vendor/composer/ca-bundle/
*.md
**/Test/
EOF
}

PROJECT_DIR="$WORK/fixture-project"
IGNORE_DIR="$WORK/fixture-ignore"
make_fixture_project "$PROJECT_DIR"
make_fixture_ignore_dir "$IGNORE_DIR"

# ---------------------------------------------------------------------------
test_git_archive_export_no_git_dir() {
  local name="it exports source via git archive into a temp dir and never creates a git dir in the export"
  local out
  out="$(bash "$SUT" --source "$PROJECT_DIR" --branch live \
    --ignore-source-dir "$IGNORE_DIR" --index-dir "$WORK/idx1" \
    --only mageos --limit 50 2>&1)"
  local rc=$?
  if [ "$rc" -ne 0 ]; then
    bad "$name" "script exited $rc: $out"
    return
  fi
  if ! printf '%s' "$out" | grep -q "exporting refs/heads/live"; then
    bad "$name" "expected log line about exporting refs/heads/live, got: $out"
    return
  fi
  if [ -e "$WORK/idx1/mageos/.codegraph/.git" ]; then
    bad "$name" "a .git dir leaked into the published index output"
    return
  fi
  ok "$name"
}

test_never_writes_inside_source_tree() {
  local name="it never writes inside the source project tree"
  local before after status_before status_after
  before="$(cd "$PROJECT_DIR" && find . -not -path './.git*' | sort)"
  status_before="$(git -C "$PROJECT_DIR" status --porcelain)"
  bash "$SUT" --source "$PROJECT_DIR" --branch live \
    --ignore-source-dir "$IGNORE_DIR" --index-dir "$WORK/idx2" \
    --only hyva --limit 50 >/dev/null 2>&1
  after="$(cd "$PROJECT_DIR" && find . -not -path './.git*' | sort)"
  status_after="$(git -C "$PROJECT_DIR" status --porcelain)"
  if [ "$before" != "$after" ]; then
    bad "$name" "file listing under source tree changed"
    return
  fi
  if [ "$status_before" != "$status_after" ]; then
    bad "$name" "git status --porcelain changed: before=[$status_before] after=[$status_after]"
    return
  fi
  ok "$name"
}

test_converts_gitnexusignore_to_codegraph_ignore() {
  local name="it converts gitnexusignore patterns to codegraph ignore config"
  local out
  out="$(bash "$SUT" --source "$PROJECT_DIR" --branch live \
    --ignore-source-dir "$IGNORE_DIR" --index-dir "$WORK/idx3" \
    --only mageos --dry-run 2>&1)"
  if ! printf '%s' "$out" | grep -q '^\[dry-run\]     !vendor/$'; then
    bad "$name" "generated .gitignore missing '!vendor/' negation: $out"
    return
  fi
  if printf '%s' "$out" | grep -qE '^\[dry-run\]     vendor/\*$'; then
    bad "$name" "generated .gitignore still contains the raw 'vendor/*' blanket dance line: $out"
    return
  fi
  if ! printf '%s' "$out" | grep -q 'vendor/mage-os/language-\*'; then
    bad "$name" "generated .gitignore dropped a genuine exclude pattern (vendor/mage-os/language-*): $out"
    return
  fi
  ok "$name"
}

test_project_ignore_template() {
  local name="it emits a per-project ignore template that excludes vendor/mage-os and vendor/hyva-themes but keeps other vendor packages"
  local tmpl="$REPO_ROOT/templates/per-project-vendor-split.gitignore"
  rm -f "$tmpl"
  bash "$SUT" --only template >/dev/null 2>&1
  if [ ! -f "$tmpl" ]; then
    bad "$name" "template file not written: $tmpl"
    return
  fi
  if ! grep -qx '!vendor/' "$tmpl"; then
    bad "$name" "template missing '!vendor/' negation"
    return
  fi
  if ! grep -qx 'vendor/mage-os/' "$tmpl"; then
    bad "$name" "template does not exclude vendor/mage-os/"
    return
  fi
  if ! grep -qx 'vendor/hyva-themes/' "$tmpl"; then
    bad "$name" "template does not exclude vendor/hyva-themes/"
    return
  fi
  if grep -qE '^vendor/\*$' "$tmpl"; then
    bad "$name" "template blanket-excludes all of vendor/ (3rd-party packages must stay included)"
    return
  fi
  ok "$name"
}

test_produces_queryable_db_per_core_repo() {
  local name="it produces a queryable db per core repo under the central index dir"
  local idx="$WORK/idx4"
  local out
  out="$(bash "$SUT" --source "$PROJECT_DIR" --branch live \
    --ignore-source-dir "$IGNORE_DIR" --index-dir "$idx" \
    --only mageos,hyva --limit 50 2>&1)"
  local rc=$?
  if [ "$rc" -ne 0 ]; then
    bad "$name" "script exited $rc: $out"
    return
  fi
  local db1="$idx/mageos/.codegraph/codegraph.db"
  local db2="$idx/hyva/.codegraph/codegraph.db"
  if [ ! -s "$db1" ] || [ ! -s "$db2" ]; then
    bad "$name" "expected non-empty db files at $db1 and $db2"
    return
  fi
  local status_json
  status_json="$(npx --yes @colbymchenry/codegraph@1.5.0 status "$idx/mageos" -j 2>/dev/null)"
  if ! printf '%s' "$status_json" | grep -q '"initialized":true'; then
    bad "$name" "codegraph status does not report an initialized db for mageos: $status_json"
    return
  fi
  if printf '%s' "$status_json" | grep -q '"fileCount":0'; then
    bad "$name" "mageos db indexed 0 files — vendor/mage-os subtree was not resolved"
    return
  fi
  ok "$name"
}

# --- empirical Post-001-caveat verification (task 010) -----------------
# The tests above build DBs against a throwaway SYNTHETIC git fixture
# (make_fixture_project) — they prove the ignore-conversion mechanism is
# wired correctly, but do not prove it against a REAL Magento project's
# on-disk vendor/hyva-themes tree, which is exactly the scenario the
# Post-001 caveat (codegraph silently ignores dirs named Vendor/vendor,
# "No files found to index", zero error) demands empirical proof against.
# Uses pvcpipesupplies's real, read-only vendor/hyva-themes checkout,
# capped with --limit for speed; skips (reported ok, with a note) on a host
# where that checkout is not present, so this file stays runnable off
# Lucas's box without a false FAIL.
PPS_ROOT="${PB_CODEGRAPH_TEST_PPS_ROOT:-$HOME/workspace/uptactics/pvcpipesupplies}"

sqlite_node_count() {
  local db_path="$1"
  node -e "
    const Database = require('better-sqlite3');
    const db = new Database(process.argv[1], { readonly: true });
    const row = db.prepare('SELECT COUNT(*) AS c FROM nodes').get();
    console.log(row.c);
    db.close();
  " "$db_path" 2>/dev/null
}

test_real_pps_hyva_vendor_node_counts() {
  local name="it indexes pvcpipesupplies's real vendor/hyva-themes tree with node counts > 0 (Post-001 caveat empirical verification)"

  if [ ! -d "$PPS_ROOT/vendor/hyva-themes" ]; then
    ok "$name (skipped — $PPS_ROOT/vendor/hyva-themes not present on this host)"
    return
  fi

  local status_before status_after
  status_before="$(git -C "$PPS_ROOT" status --porcelain)"

  local idx="$WORK/idx-real-pps"
  local out
  out="$(bash "$SUT" --source "$PPS_ROOT" --branch live \
    --index-dir "$idx" --only hyva --limit 200 2>&1)"
  local rc=$?

  status_after="$(git -C "$PPS_ROOT" status --porcelain)"
  if [ "$status_before" != "$status_after" ]; then
    bad "$name" "pps working tree changed — this script must be strictly read-only against the source project"
    return
  fi

  if [ "$rc" -ne 0 ]; then
    bad "$name" "script exited $rc: $out"
    return
  fi

  local db="$idx/hyva/.codegraph/codegraph.db"
  if [ ! -s "$db" ]; then
    bad "$name" "expected non-empty db at $db"
    return
  fi

  local node_count
  node_count="$(cd "$REPO_ROOT" && sqlite_node_count "$db")"
  if [ -z "$node_count" ] || [ "$node_count" -le 0 ]; then
    bad "$name" "expected node count > 0 for the real pps vendor/hyva-themes index, got '$node_count' (Post-001 caveat: codegraph silently indexes 0 files under a dir literally named vendor/ unless the .gitignore negation mechanism is actually in effect)"
    return
  fi

  ok "$name (node_count=$node_count, db=$db)"
}

test_cleans_temp_dirs_on_exit_including_failure() {
  local name="it cleans temp dirs on exit including failure paths"
  local before after
  before="$(find "${TMPDIR:-/tmp}" -maxdepth 1 -name 'pb-codegraph-core-*' 2>/dev/null | sort)"

  # happy path
  bash "$SUT" --source "$PROJECT_DIR" --branch live \
    --ignore-source-dir "$IGNORE_DIR" --index-dir "$WORK/idx5" \
    --only deps --limit 50 >/dev/null 2>&1

  # failure path: nonexistent live branch must fail loudly and still clean up
  bash "$SUT" --source "$PROJECT_DIR" --branch does-not-exist \
    --ignore-source-dir "$IGNORE_DIR" --index-dir "$WORK/idx6" \
    --only mageos >/dev/null 2>&1
  local fail_rc=$?

  after="$(find "${TMPDIR:-/tmp}" -maxdepth 1 -name 'pb-codegraph-core-*' 2>/dev/null | sort)"

  if [ "$fail_rc" -eq 0 ]; then
    bad "$name" "expected nonzero exit for a missing live branch, got 0"
    return
  fi
  if [ "$before" != "$after" ]; then
    bad "$name" "leftover pb-codegraph-core-* scratch dirs after run: $(comm -13 <(printf '%s\n' "$before") <(printf '%s\n' "$after"))"
    return
  fi
  ok "$name"
}

test_git_archive_export_no_git_dir
test_never_writes_inside_source_tree
test_converts_gitnexusignore_to_codegraph_ignore
test_project_ignore_template
test_produces_queryable_db_per_core_repo
test_real_pps_hyva_vendor_node_counts
test_cleans_temp_dirs_on_exit_including_failure

printf '\n%d passed, %d failed\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
