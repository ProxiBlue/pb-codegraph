// Single source of truth for the pinned codegraph npm package version.
//
// Consumed by:
//  - shared/schema-guard.ts (names this version in refuse-path messages)
//  - scripts/build-fixture-db.sh (own CODEGRAPH_VERSION literal, kept in
//    sync with this constant — see tests/schema-guard.test.ts, which parses
//    the script and asserts its literal matches PINNED_CODEGRAPH_PACKAGE
//    below; bash cannot `import` a .ts module, so the script keeps its own
//    literal and a test is the sed-able-marker cross-check mechanism)
//  - tests/helpers/isolated-fixture-db.ts / tests/build-fixture-db.test.ts
//    (same cross-check pattern)
//  - the future augment CLI wrapper (task 004), which names this version in
//    its own refuse/log output when the schema guard trips
//
// Upgrade procedure: docs/upgrading-codegraph.md
export const PINNED_CODEGRAPH_VERSION = '1.5.0';
export const PINNED_CODEGRAPH_PACKAGE = `@colbymchenry/codegraph@${PINNED_CODEGRAPH_VERSION}` as const;
