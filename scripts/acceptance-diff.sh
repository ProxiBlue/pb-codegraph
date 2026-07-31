#!/usr/bin/env bash
# scripts/acceptance-diff.sh
#
# Task 011 acceptance harness: for a Magento/Mage-OS project checkout that
# still has a live legacy graph container, index+augment a READ-ONLY COPY of its
# app/code into a scratch directory with the new pb-codegraph stack, query
# BOTH backends' `impact` tool for a caller-supplied list of real symbols,
# and emit a per-impacted-node (both-found / new-stack-only / legacy-only
# / different-set) classification.
#
# HARD FLEET RULE: this script must NEVER write inside the project root it
# is asked to index. app/code is copied (`cp -a`, read-only on the source
# side) into a scratch directory; codegraph indexes and the augmenter writes
# ONLY inside that scratch copy's .codegraph/ — never back into the
# project's own working tree. If the project root is a git repository, this
# script verifies `git status --porcelain` is byte-identical before and
# after the run and refuses to report success otherwise (see step 6 below).
#
# This script is intentionally project-agnostic: no pps-specific path is
# hardcoded here. The pps-specific symbol list lives in
# scripts/acceptance-symbols-pps.json and is passed in via --symbols; the
# concrete run for pps is documented in
# docs/acceptance-report-pps-2026-07-31.md.
#
# Usage:
#   scripts/acceptance-diff.sh \
#     --pps-root <magento-project-checkout> \
#     --symbols <path-to-symbols.json> \
#     (--legacy-container <docker-container-name> | --legacy-base-url <url>) \
#     [--legacy-port <port>] [--legacy-repo <name>] \
#     [--scratch-dir <dir>] [--out-dir <dir>] [--depth <1-4>] [--keep-scratch]
#
# The symbols JSON has the shape documented at the top of
# scripts/acceptance-symbols-pps.json (a "legacy_repo" default + a
# "symbols" array of {label, category, description, new_stack_symbol,
# legacy_target, legacy_file_path}).
#
# Exit codes:
#   0  success — classification produced (NOT a pass/fail verdict on the
#      migration itself; see docs/acceptance-report-pps-2026-07-31.md
#      "AWAITING LUCAS SIGN-OFF")
#   1  usage / configuration error
#   2  legacy backend unreachable (fails loudly — no partial verdict)
#   3  new-stack indexing/augment/query step failed (fails loudly — no
#      partial verdict)
#   4  SAFETY TRIP — the project root's git working tree changed during the
#      run (should be structurally impossible; treated as a hard failure)
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

PPS_ROOT=""
SYMBOLS_FILE=""
LEGACY_CONTAINER=""
LEGACY_BASE_URL=""
LEGACY_PORT="4747"
LEGACY_REPO=""
SCRATCH_DIR=""
OUT_DIR=""
DEPTH="4"
KEEP_SCRATCH=0

# Every mktemp scratch dir this run creates (unless --scratch-dir was given,
# in which case the caller owns cleanup). Removed on any exit path
# (success, error, or signal) unless --keep-scratch was passed.
OWN_SCRATCH_DIR=1

log() { printf '[acceptance-diff] %s\n' "$*" >&2; }
die() { printf '[acceptance-diff] ERROR: %s\n' "$*" >&2; exit "${2:-1}"; }

cleanup() {
  local rc=$?
  if [ "$OWN_SCRATCH_DIR" -eq 1 ] && [ "$KEEP_SCRATCH" -eq 0 ] && [ -n "$SCRATCH_DIR" ] && [ -d "$SCRATCH_DIR" ]; then
    rm -rf -- "$SCRATCH_DIR"
  elif [ -n "$SCRATCH_DIR" ] && [ -d "$SCRATCH_DIR" ]; then
    log "scratch dir kept at: $SCRATCH_DIR"
  fi
  exit "$rc"
}
trap cleanup EXIT INT TERM

usage() {
  sed -n '2,/^set -euo pipefail/p' "${BASH_SOURCE[0]}" | sed '$d' | sed 's/^# \{0,1\}//'
}

require_cmd() {
  command -v "$1" >/dev/null 2>&1 || die "required command '$1' not found on PATH"
}

parse_args() {
  while [ $# -gt 0 ]; do
    case "$1" in
      --pps-root) PPS_ROOT="${2:?--pps-root requires a value}"; shift 2 ;;
      --symbols) SYMBOLS_FILE="${2:?--symbols requires a value}"; shift 2 ;;
      --legacy-container) LEGACY_CONTAINER="${2:?--legacy-container requires a value}"; shift 2 ;;
      --legacy-base-url) LEGACY_BASE_URL="${2:?--legacy-base-url requires a value}"; shift 2 ;;
      --legacy-port) LEGACY_PORT="${2:?--legacy-port requires a value}"; shift 2 ;;
      --legacy-repo) LEGACY_REPO="${2:?--legacy-repo requires a value}"; shift 2 ;;
      --scratch-dir) SCRATCH_DIR="${2:?--scratch-dir requires a value}"; OWN_SCRATCH_DIR=0; shift 2 ;;
      --out-dir) OUT_DIR="${2:?--out-dir requires a value}"; shift 2 ;;
      --depth) DEPTH="${2:?--depth requires a value}"; shift 2 ;;
      --keep-scratch) KEEP_SCRATCH=1; shift ;;
      -h|--help) usage; exit 0 ;;
      *) die "unknown argument: $1 (see --help)" ;;
    esac
  done

  [ -n "$PPS_ROOT" ] || die "--pps-root is required"
  [ -d "$PPS_ROOT" ] || die "--pps-root directory does not exist: $PPS_ROOT"
  [ -n "$SYMBOLS_FILE" ] || die "--symbols is required"
  [ -f "$SYMBOLS_FILE" ] || die "--symbols file does not exist: $SYMBOLS_FILE"
  if [ -z "$LEGACY_CONTAINER" ] && [ -z "$LEGACY_BASE_URL" ]; then
    die "one of --legacy-container or --legacy-base-url is required"
  fi
  if [ -n "$LEGACY_CONTAINER" ] && [ -n "$LEGACY_BASE_URL" ]; then
    die "pass only one of --legacy-container or --legacy-base-url, not both"
  fi
}

# --- step 0: pps working-tree safety snapshot -------------------------------

PPS_STATUS_BEFORE=""
PPS_IS_GIT_REPO=0

snapshot_pps_status() {
  if git -C "$PPS_ROOT" rev-parse --git-dir >/dev/null 2>&1; then
    PPS_IS_GIT_REPO=1
    PPS_STATUS_BEFORE="$(git -C "$PPS_ROOT" status --porcelain)"
  else
    log "warn: --pps-root is not a git repository — skipping the before/after working-tree identity check"
  fi
}

verify_pps_status_unchanged() {
  [ "$PPS_IS_GIT_REPO" -eq 1 ] || return 0
  local after
  after="$(git -C "$PPS_ROOT" status --porcelain)"
  if [ "$after" != "$PPS_STATUS_BEFORE" ]; then
    log "BEFORE (git status --porcelain):"
    printf '%s\n' "$PPS_STATUS_BEFORE" >&2
    log "AFTER (git status --porcelain):"
    printf '%s\n' "$after" >&2
    die "SAFETY TRIP: --pps-root working tree changed during this run — see BEFORE/AFTER above. This script must never write inside --pps-root." 4
  fi
  log "pps working tree unchanged (git status --porcelain identical before/after) — verified."
}

# --- step 1: legacy-backend reachability -------------------------------------------

resolve_legacy_base_url() {
  if [ -n "$LEGACY_BASE_URL" ]; then
    return
  fi
  require_cmd docker
  local ip
  ip="$(docker inspect -f '{{range .NetworkSettings.Networks}}{{.IPAddress}} {{end}}' "$LEGACY_CONTAINER" 2>/dev/null | awk '{print $1}')"
  if [ -z "$ip" ]; then
    die "LEGACY BACKEND UNREACHABLE: could not resolve a container IP for '$LEGACY_CONTAINER' (is it running? \`docker ps\`)" 2
  fi
  LEGACY_BASE_URL="http://$ip:$LEGACY_PORT/api/mcp"
  log "resolved legacy base url: $LEGACY_BASE_URL (container=$LEGACY_CONTAINER)"
}

check_legacy_reachable() {
  local probe
  if ! probe="$(curl -sS -m 10 -o /dev/null -w '%{http_code}' -X POST "$LEGACY_BASE_URL" \
      -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' \
      -d '{"jsonrpc":"2.0","id":0,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"acceptance-diff-probe","version":"0.0.0"}}}' 2>&1)"; then
    die "LEGACY BACKEND UNREACHABLE: connection to $LEGACY_BASE_URL failed: $probe" 2
  fi
  if [ "$probe" != "200" ]; then
    die "LEGACY BACKEND UNREACHABLE: $LEGACY_BASE_URL returned HTTP $probe on initialize" 2
  fi
  log "legacy backend reachable at $LEGACY_BASE_URL (initialize -> HTTP 200)"
}

# --- step 2: scratch copy + index + augment ----------------------------------

build_new_stack_index() {
  local project_dir="$1"
  mkdir -p "$project_dir/app"
  log "copying $PPS_ROOT/app/code -> $project_dir/app/code (read-only on the source side)"
  cp -a "$PPS_ROOT/app/code" "$project_dir/app/code"

  log "indexing + augmenting the scratch copy (pb-codegraph index)"
  if ! node --import tsx "$REPO_ROOT/bin/pb-codegraph.ts" index "$project_dir"; then
    die "new-stack indexing/augment failed for scratch copy: $project_dir" 3
  fi
}

write_registry() {
  local registry_path="$1" repo_name="$2" db_path="$3"
  python3 - "$registry_path" "$repo_name" "$db_path" <<'PYEOF'
import json, sys
registry_path, repo_name, db_path = sys.argv[1:4]
json.dump({repo_name: {"db_path": db_path, "description": "acceptance-diff scratch index"}}, open(registry_path, "w"), indent=2)
PYEOF
  log "wrote registry: $registry_path (repo=$repo_name db_path=$db_path)"
}

# --- main --------------------------------------------------------------------

main() {
  parse_args "$@"
  require_cmd node
  require_cmd npx
  require_cmd curl
  require_cmd python3
  require_cmd git

  if [ -z "$LEGACY_REPO" ]; then
    LEGACY_REPO="$(python3 -c "import json,sys; print(json.load(open(sys.argv[1])).get('legacy_repo',''))" "$SYMBOLS_FILE")"
  fi
  [ -n "$LEGACY_REPO" ] || die "--legacy-repo not given and symbols file has no top-level \"legacy_repo\""

  snapshot_pps_status
  resolve_legacy_base_url
  check_legacy_reachable

  if [ -z "$SCRATCH_DIR" ]; then
    SCRATCH_DIR="$(mktemp -d "${TMPDIR:-/tmp}/pb-codegraph-acceptance-XXXXXX")"
  else
    mkdir -p "$SCRATCH_DIR"
  fi
  [ -n "$OUT_DIR" ] || OUT_DIR="$SCRATCH_DIR/results"
  mkdir -p "$OUT_DIR"

  local project_dir="$SCRATCH_DIR/project"
  local registry_path="$SCRATCH_DIR/registry.json"

  build_new_stack_index "$project_dir"
  write_registry "$registry_path" "$LEGACY_REPO" "$project_dir/.codegraph/codegraph.db"

  log "querying the new-stack MCP shim over stdio (mcp/bin/server.ts) for every symbol"
  if ! node --import tsx "$SCRIPT_DIR/lib/new-stack-impact.ts" \
      --registry "$registry_path" --repo "$LEGACY_REPO" \
      --symbols "$SYMBOLS_FILE" --out-dir "$OUT_DIR" --depth "$DEPTH"; then
    die "new-stack impact query step failed — see output above" 3
  fi

  log "querying the legacy MCP server over HTTP JSON-RPC for every symbol"
  if ! node --import tsx "$SCRIPT_DIR/lib/legacy-impact.ts" \
      --base-url "$LEGACY_BASE_URL" --repo "$LEGACY_REPO" \
      --symbols "$SYMBOLS_FILE" --out-dir "$OUT_DIR" --max-depth "$DEPTH"; then
    die "LEGACY BACKEND UNREACHABLE or errored mid-run — see output above (no partial verdict emitted)" 2
  fi

  log "classifying per-impacted-node divergence"
  node --import tsx "$SCRIPT_DIR/lib/classify-acceptance.ts" \
    --symbols "$SYMBOLS_FILE" --results-dir "$OUT_DIR" \
    --out "$OUT_DIR/classification.json" --md "$OUT_DIR/classification.md"

  verify_pps_status_unchanged

  log "DONE. Raw per-backend responses + classification.json/.md under: $OUT_DIR"
  log "This is a data-collection run, NOT a pass/fail verdict — see the human sign-off report."
  cat "$OUT_DIR/classification.md" >&2
}

main "$@"
