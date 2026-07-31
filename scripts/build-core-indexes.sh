#!/usr/bin/env bash
# scripts/build-core-indexes.sh
#
# Builds the shared, read-only core codegraph indexes (mageos = vendor/mage-os,
# hyva = vendor/hyva-themes, deps = curated runtime PHP libs) once centrally
# under $PB_CODEGRAPH_INDEX_DIR (default ~/.pb-codegraph/indexes/<name>/).
#
# HARD FLEET RULE: this script must NEVER create, modify, or delete anything
# inside any project tree or any .git directory. Source code is obtained ONLY
# via `git archive` (a read-only export of a committed ref — it never writes
# to the source repo's .git) piped into a plain `tar` extraction in a mktemp
# scratch directory. Vendor content (composer-installed, not git-tracked) is
# copied read-only (`cp -a`) from the source checkout into the same scratch
# dir. No `git init`/`git clone` ever runs in the scratch dir either, so no
# .git directory is ever created anywhere by this script — the stray
# .git/index.lock failure mode (2026-06-29 incident) is structurally
# impossible here.
#
# Usage:
#   scripts/build-core-indexes.sh --source <magento-project-dir> [options]
#
# Options:
#   --source <dir>             Magento project checkout with vendor/mage-os,
#                               vendor/hyva-themes, and curated deps present on
#                               disk. Required unless --only template is used.
#   --branch <name>             Live branch to export via git archive.
#                               (default: PB_CODEGRAPH_LIVE_BRANCH or "live")
#   --only <name[,name,...]>    Restrict to one or more of: mageos hyva deps
#                               template (default: all four)
#   --index-dir <dir>           Output root for built indexes.
#                               (default: PB_CODEGRAPH_INDEX_DIR or
#                               ~/.pb-codegraph/indexes)
#   --ignore-source-dir <dir>   Where .legacyignore.<name> files live.
#                               (default: PB_CODEGRAPH_IGNORE_SOURCE_DIR or
#                               ~/.pb-codegraph/ignore-sources)
#   --limit <N>                 Cap the number of files copied per vendor
#                               subpath (smoke/testing only — never use for a
#                               real core build).
#   --dry-run                   Print the plan (archive command, copy list,
#                               generated ignore content) without touching the
#                               filesystem beyond a throwaway plan directory.
#   --codegraph-version <ver>   Pin override for the npx-installed codegraph
#                               CLI. (default: 1.5.0)
#   -h, --help                  Show this help and exit.
#
# Exit codes:
#   0  success
#   1  usage / configuration error (actionable message printed to stderr)
#   2  a build step failed for at least one target
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

readonly ALL_TARGETS=(mageos hyva deps template)
readonly DEFAULT_CODEGRAPH_VERSION="1.5.0"
readonly PROJECT_TEMPLATE_PATH="$REPO_ROOT/templates/per-project-vendor-split.gitignore"

SOURCE_DIR=""
LIVE_BRANCH="${PB_CODEGRAPH_LIVE_BRANCH:-live}"
ONLY_TARGETS=""
INDEX_DIR="${PB_CODEGRAPH_INDEX_DIR:-$HOME/.pb-codegraph/indexes}"
IGNORE_SOURCE_DIR="${PB_CODEGRAPH_IGNORE_SOURCE_DIR:-$HOME/.pb-codegraph/ignore-sources}"
FILE_LIMIT=""
DRY_RUN=0
CODEGRAPH_VERSION="${PB_CODEGRAPH_VERSION:-$DEFAULT_CODEGRAPH_VERSION}"

# Every mktemp scratch dir this run creates. Cleaned up by cleanup() on any
# exit path (success, error, or signal) — the "never leaves temp dirs behind,
# including on failure" requirement.
SCRATCH_DIRS=()

log() { printf '[build-core-indexes] %s\n' "$*" >&2; }
die() { printf '[build-core-indexes] ERROR: %s\n' "$*" >&2; exit 1; }

# shellcheck disable=SC2329 # invoked indirectly via `trap cleanup EXIT INT TERM` below
cleanup() {
  # Capture the real exit status FIRST — every command below (including the
  # `[ -d ]` checks) has its own status, and without this an EXIT trap's
  # final command status silently overwrites the script's actual exit code.
  local rc=$?
  local dir
  for dir in "${SCRATCH_DIRS[@]:-}"; do
    if [ -n "$dir" ] && [ -d "$dir" ]; then
      rm -rf -- "$dir"
    fi
  done
  exit "$rc"
}
trap cleanup EXIT INT TERM

usage() {
  sed -n '2,/^set -euo pipefail/p' "${BASH_SOURCE[0]}" | sed '$d' | sed 's/^# \{0,1\}//'
}

require_cmd() {
  command -v "$1" >/dev/null 2>&1 || die "required command '$1' not found on PATH"
}

# --- argument parsing -------------------------------------------------------

parse_args() {
  while [ $# -gt 0 ]; do
    case "$1" in
      --source) SOURCE_DIR="${2:?--source requires a value}"; shift 2 ;;
      --branch) LIVE_BRANCH="${2:?--branch requires a value}"; shift 2 ;;
      --only) ONLY_TARGETS="${2:?--only requires a value}"; shift 2 ;;
      --index-dir) INDEX_DIR="${2:?--index-dir requires a value}"; shift 2 ;;
      --ignore-source-dir) IGNORE_SOURCE_DIR="${2:?--ignore-source-dir requires a value}"; shift 2 ;;
      --limit) FILE_LIMIT="${2:?--limit requires a value}"; shift 2 ;;
      --codegraph-version) CODEGRAPH_VERSION="${2:?--codegraph-version requires a value}"; shift 2 ;;
      --dry-run) DRY_RUN=1; shift ;;
      -h|--help) usage; exit 0 ;;
      *) die "unknown argument: $1 (see --help)" ;;
    esac
  done
}

resolve_targets() {
  local -n _out="$1"
  _out=()
  if [ -z "$ONLY_TARGETS" ]; then
    _out=("${ALL_TARGETS[@]}")
    return
  fi
  local IFS=','
  local name
  for name in $ONLY_TARGETS; do
    case "$name" in
      mageos|hyva|deps|template) _out+=("$name") ;;
      *) die "unknown target '$name' (valid: mageos hyva deps template)" ;;
    esac
  done
}

# --- ignore conversion -------------------------------------------------------
# Converts a `.legacyignore.<name>` file (git's own ignore syntax — the syntax
# the legacy code-graph tool used, and the syntax codegraph's `ignore`-package-backed engine
# also understands via a project-root .gitignore, see
# dist/extraction/index.d.ts: "built-in defaults, merged with the project's
# root .gitignore ... a negation there (e.g. `!vendor/`) overrides a default")
# into codegraph's ignore config, which for this engine IS a .gitignore file:
# codegraph.json's `exclude`/`include` explicitly cannot un-ignore a built-in
# default-ignored dir (vendor is one — verified empirically: a bare
# codegraph.json include list left vendor/* files undiscovered; a root
# .gitignore with `!vendor/` made them visible), so only a .gitignore
# negation can restore vendor/* into the index.
#
# Two derived outputs per ignore file:
#   1. include subpaths (leaf-most `!vendor/<pkg>/` negations) — tells the
#      caller exactly which vendor subtrees to physically copy from the
#      source checkout (vendor/ itself is never git-tracked, so git archive
#      cannot pull it in — see derive_include_subpaths()).
#   2. gitignore content — the remaining lines (comments, genuine excludes
#      like `vendor/mage-os/language-*` or `**/Test/`) passed through
#      verbatim, with the legacy-tool-specific "blanket re-ignore everything
#      under vendor/" dance (`vendor/*`, `vendor/composer/*`, ...) dropped,
#      because this script already scopes the physical copy to only the
#      selected subtrees — see build_gitignore_content().

# Prints one leaf vendor subpath per line (e.g. "vendor/mage-os",
# "vendor/composer/semver"). "Leaf" means: an explicit `!vendor/<path>/`
# negation in the source file that has no more specific negation nested
# inside it. Drops the bare `!vendor/` blanket-unignore (meaningless here —
# handled unconditionally by build_gitignore_content()).
derive_include_subpaths() {
  local ignore_file="$1"
  local -a raw=()
  local line pat

  while IFS= read -r line || [ -n "$line" ]; do
    line="${line%$'\r'}"
    [ -z "$line" ] && continue
    case "$line" in
      \#*) continue ;;
      !*) : ;;
      *) continue ;;
    esac
    pat="${line#!}"
    pat="${pat%/}"
    [ "$pat" = "vendor" ] && continue
    case "$pat" in
      vendor/*) raw+=("$pat") ;;
      *) continue ;;
    esac
  done < "$ignore_file"

  # dedupe, preserving first-seen order
  local -a uniq=()
  local p q seen
  for p in "${raw[@]:-}"; do
    [ -z "$p" ] && continue
    seen=0
    for q in "${uniq[@]:-}"; do
      [ "$q" = "$p" ] && { seen=1; break; }
    done
    [ "$seen" -eq 0 ] && uniq+=("$p")
  done

  # leaf filter: drop p when some other entry q is nested inside it (p is an
  # ancestor directory of q), so we only copy the most specific subtrees.
  local has_child
  for p in "${uniq[@]:-}"; do
    has_child=0
    for q in "${uniq[@]:-}"; do
      [ "$q" = "$p" ] && continue
      case "$q" in
        "$p"/*) has_child=1; break ;;
      esac
    done
    [ "$has_child" -eq 0 ] && printf '%s\n' "$p"
  done
}

# Prints the .gitignore content to place at the root of the scratch export
# for one core target, derived from the given .legacyignore.<name> file.
build_gitignore_content() {
  local ignore_file="$1"
  local line

  printf '# Generated by scripts/build-core-indexes.sh from %s\n' "$(basename "$ignore_file")"
  printf '# Do not edit by hand — re-run the build script to regenerate.\n'
  # A core index holds ONLY vendor/ content — the source project's own
  # tracked tree (app/code, pub/, bin/, composer.json, ...) rides along in
  # the git-archive export but must never leak into a shared core DB, so
  # blanket-ignore everything at the export root except vendor/ before
  # applying the (deeper, package-scoped) rules below.
  printf '/*\n'
  printf '!/vendor/\n'
  printf '!vendor/\n'

  while IFS= read -r line || [ -n "$line" ]; do
    line="${line%$'\r'}"
    # Drop the bare blanket-unignore (already emitted above unconditionally)
    # and any "vendor/.../*" single-level blanket re-ignore dance — both are
    # a legacy-tool-specific workaround for its own hardcoded vendor ignore, and
    # this script already scopes what physically exists in the scratch dir
    # to the selected subtrees, so a bare `vendor/*` here would wrongly
    # exclude the very directory (e.g. vendor/mage-os) we copied in.
    case "$line" in
      '!vendor/'|'!vendor') continue ;;
    esac
    if [[ "$line" =~ ^!?vendor(/[^/]+)*/\*$ ]]; then
      continue
    fi
    printf '%s\n' "$line"
  done < "$ignore_file"
}

# --- per-project ignore template --------------------------------------------
# The counterpart artifact for the per-project vendor-split wrapper (task
# 010): 3rd-party vendor/* packages must stay INDEXED in the per-project DB
# (so a custom plugin/preference targeting a 3rd-party class resolves to a
# real node), while vendor/mage-os and vendor/hyva-themes must NOT be
# re-indexed there — they already live in the central mageos/hyva DBs built
# by this script. Cross-DB edges are out of scope (federation is
# query-merge): a custom class -> mage-os class edge still lands as an
# `external` placeholder in the per-project DB even with this template
# applied — documented gap, see _devils_advocate.md I3.
emit_project_template() {
  local out="$PROJECT_TEMPLATE_PATH"
  mkdir -p "$(dirname "$out")"
  cat > "$out" <<'EOF'
# pb-codegraph per-project vendor-split ignore template
# Generated by scripts/build-core-indexes.sh (task 009) — do not edit by hand.
#
# Vendor-split contract: codegraph default-ignores vendor/ entirely, so a
# root-relative negation is required to see it at all. Exclude the two
# shared cores that already have their own central index (mageos, hyva —
# built by scripts/build-core-indexes.sh) so they are never duplicated into
# a per-project DB. Every OTHER vendor/* (3rd-party composer packages) stays
# INCLUDED, so a custom plugin/preference targeting a 3rd-party vendor class
# resolves to a real node instead of a bare `external` placeholder.
#
# Cross-DB edges are out of scope (federation is query-merge, not a joined
# graph): a custom class -> mage-os class edge still lands as an `external`
# placeholder in the per-project DB even with this template applied. That is
# an accepted, documented gap — see _devils_advocate.md I3.
!vendor/
vendor/mage-os/
vendor/hyva-themes/
EOF
  log "wrote per-project ignore template: $out"
}

# --- core target build -------------------------------------------------------

# Copies one vendor subpath (e.g. "vendor/mage-os") from the source checkout
# into the scratch export, read-only on the source side. When FILE_LIMIT is
# set, copies at most that many files (smoke-test / CI subset use only).
copy_vendor_subpath() {
  local source_dir="$1" subpath="$2" dest_dir="$3" limit="$4"
  local src="$source_dir/$subpath"

  if [ ! -d "$src" ]; then
    log "warn: $subpath not found under $source_dir — skipping"
    return 0
  fi

  mkdir -p "$dest_dir/$(dirname "$subpath")"

  if [ -n "$limit" ]; then
    local count=0 f relf
    while IFS= read -r -d '' f; do
      relf="${f#"$source_dir"/}"
      mkdir -p "$dest_dir/$(dirname "$relf")"
      cp -a -- "$f" "$dest_dir/$relf"
      count=$((count + 1))
      [ "$count" -ge "$limit" ] && break
    done < <(find "$src" -type f -print0)
    log "copied $count file(s) (--limit $limit) from $subpath"
  else
    cp -a -- "$src" "$dest_dir/$(dirname "$subpath")/"
  fi
}

build_core_target() {
  local name="$1"
  local ignore_file="$IGNORE_SOURCE_DIR/.legacyignore.$name"

  [ -f "$ignore_file" ] || die "ignore source file not found: $ignore_file (need .legacyignore.$name)"

  local -a subpaths=()
  while IFS= read -r line; do
    [ -n "$line" ] && subpaths+=("$line")
  done < <(derive_include_subpaths "$ignore_file")

  if [ "$DRY_RUN" -eq 1 ]; then
    log "[dry-run] target=$name"
    log "[dry-run]   would export refs/heads/$LIVE_BRANCH from $SOURCE_DIR via git archive"
    local sp
    for sp in "${subpaths[@]:-}"; do
      log "[dry-run]   would copy vendor subpath: $sp"
    done
    log "[dry-run]   generated .gitignore:"
    build_gitignore_content "$ignore_file" | sed 's/^/[dry-run]     /' >&2
    log "[dry-run]   would index scratch export with codegraph@$CODEGRAPH_VERSION"
    log "[dry-run]   would publish db under $INDEX_DIR/$name/.codegraph/codegraph.db"
    return 0
  fi

  [ -n "$SOURCE_DIR" ] || die "--source is required to build target '$name'"
  [ -d "$SOURCE_DIR" ] || die "--source directory does not exist: $SOURCE_DIR"
  git -C "$SOURCE_DIR" rev-parse --git-dir >/dev/null 2>&1 || die "--source is not a git repository: $SOURCE_DIR"
  git -C "$SOURCE_DIR" rev-parse --verify -q "refs/heads/$LIVE_BRANCH" >/dev/null 2>&1 \
    || die "live branch '$LIVE_BRANCH' not found in $SOURCE_DIR (never falling back to the checked-out branch)"

  # NOTE: mktemp + array-append must run in THIS shell, not inside a command
  # substitution — appending to SCRATCH_DIRS from within a `$(...)` subshell
  # would silently vanish once the subshell exits, defeating cleanup().
  local scratch
  scratch="$(mktemp -d "${TMPDIR:-/tmp}/pb-codegraph-core-XXXXXX")"
  SCRATCH_DIRS+=("$scratch")

  log "target=$name: exporting refs/heads/$LIVE_BRANCH from $SOURCE_DIR (git archive, read-only)"
  git -C "$SOURCE_DIR" archive "refs/heads/$LIVE_BRANCH" | tar -x -C "$scratch"

  if [ -e "$scratch/.git" ]; then
    die "internal error: a .git entry appeared in the scratch export ($scratch) — refusing to index"
  fi

  local sp
  for sp in "${subpaths[@]:-}"; do
    copy_vendor_subpath "$SOURCE_DIR" "$sp" "$scratch" "$FILE_LIMIT"
  done

  build_gitignore_content "$ignore_file" > "$scratch/.gitignore"

  log "target=$name: indexing with codegraph@$CODEGRAPH_VERSION"
  npx --yes "@colbymchenry/codegraph@$CODEGRAPH_VERSION" init "$scratch" >&2

  local out_dir="$INDEX_DIR/$name"
  mkdir -p "$out_dir"
  rm -rf "$out_dir/.codegraph"
  cp -a "$scratch/.codegraph" "$out_dir/.codegraph"

  log "target=$name: OK — db at $out_dir/.codegraph/codegraph.db"
}

# --- main --------------------------------------------------------------------

main() {
  parse_args "$@"

  local -a targets
  resolve_targets targets

  local want_core=0 want_template=0 t
  for t in "${targets[@]}"; do
    if [ "$t" = "template" ]; then want_template=1; else want_core=1; fi
  done

  if [ "$want_core" -eq 1 ] && [ "$DRY_RUN" -eq 0 ]; then
    require_cmd git
    require_cmd tar
    require_cmd npx
  fi

  local overall_rc=0

  if [ "$want_template" -eq 1 ]; then
    emit_project_template
  fi

  for t in "${targets[@]}"; do
    [ "$t" = "template" ] && continue
    if ! build_core_target "$t"; then
      log "target=$t FAILED"
      overall_rc=2
    fi
  done

  exit "$overall_rc"
}

main "$@"
