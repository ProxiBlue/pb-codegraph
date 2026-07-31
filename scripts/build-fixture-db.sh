#!/usr/bin/env bash
# Builds the tests/fixture/ codegraph SQLite index on demand.
# Output (tests/fixture/.codegraph/) is gitignored and rebuilt from scratch
# every run — never committed.
set -euo pipefail

CODEGRAPH_VERSION="@colbymchenry/codegraph@1.5.0"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
FIXTURE_DIR="${REPO_ROOT}/tests/fixture"

if [ ! -d "${FIXTURE_DIR}" ]; then
  echo "error: fixture directory not found at ${FIXTURE_DIR}" >&2
  exit 1
fi

# Defensive: this script only ever removes the disposable .codegraph/ index
# dir under tests/fixture — never a project .git directory.
if [ -d "${FIXTURE_DIR}/.codegraph" ]; then
  rm -rf "${FIXTURE_DIR:?}/.codegraph"
fi

echo "Building fixture codegraph index (pinned ${CODEGRAPH_VERSION}) at ${FIXTURE_DIR} ..."
npx --yes "${CODEGRAPH_VERSION}" init --force "${FIXTURE_DIR}"

if [ ! -f "${FIXTURE_DIR}/.codegraph/codegraph.db" ]; then
  echo "error: expected ${FIXTURE_DIR}/.codegraph/codegraph.db to exist after init" >&2
  exit 1
fi

echo "Fixture codegraph DB built: ${FIXTURE_DIR}/.codegraph/codegraph.db"
