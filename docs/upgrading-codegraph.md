# Upgrading the pinned codegraph version

pb-codegraph pins a single `@colbymchenry/codegraph` npm package version
(`shared/pinned.ts`'s `PINNED_CODEGRAPH_VERSION`) and characterizes its
SQLite schema up front (`shared/schema-guard.ts`'s
`SUPPORTED_SCHEMA_VERSIONS` + required-column/table checks). Both the mcp
shim's read-only open path (`mcp/src/db.ts`) and the augmenter's write open
path (`augmenter/src/writer/sqlite-writer.ts`) call the same guard before
touching a db, and refuse with an actionable message (naming the pinned
version + this doc) rather than reading/writing against an uncharacterized
schema.

## Why a pin + guard exist

codegraph is a fast-moving third-party CLI. A schema migration between
releases (new/renamed/dropped columns, a bumped `schema_versions.version`)
would otherwise be discovered as a confusing runtime SQL error deep inside a
query, or worse, silently produce wrong results (e.g. a query reading a
column that now means something else). The guard turns that into an
up-front, actionable refusal.

## Bump procedure

1. **Bump the pin.** Update `PINNED_CODEGRAPH_VERSION` in `shared/pinned.ts`
   to the new codegraph release. Update the matching
   `CODEGRAPH_VERSION="@colbymchenry/codegraph@<version>"` literal in
   `scripts/build-fixture-db.sh` to the same value — `tests/schema-guard.test.ts`
   ("it exposes one pinned version constant consumed by wrapper and fixture
   script") asserts these two stay in sync, since a bash script cannot
   `import` a `.ts` module.

2. **Run the fixture suite.** Rebuild the fixture db against the new pin and
   run the full test suite:

   ```
   bash scripts/build-fixture-db.sh
   npx tsc --noEmit
   node --test --import tsx tests/*.test.ts
   ```

   `tests/schema-guard.test.ts`'s accept-path test
   (`it accepts the fixture db schema version`) will fail loudly if the new
   release's schema no longer satisfies the OLD `SUPPORTED_SCHEMA_VERSIONS` /
   required-column list — that failure is expected until step 3.

3. **Update the supported matrix.** Inspect the freshly-built
   `tests/fixture/.codegraph/codegraph.db`:

   ```
   sqlite3 tests/fixture/.codegraph/codegraph.db \
     "SELECT * FROM schema_versions; PRAGMA table_info(nodes); PRAGMA table_info(edges);"
   ```

   Record the observed `MAX(schema_versions.version)` in
   `shared/schema-guard.ts`'s `SUPPORTED_SCHEMA_VERSIONS` (add the new value;
   only drop an old one if you have confirmed no registered repo still runs
   the old codegraph release — this repo may serve multiple projects
   indexed at different times). Re-check that `nodes.qualified_name`,
   `edges.provenance`, and the `project_metadata` table are still present;
   if codegraph renamed/dropped any of them, update
   `shared/schema-guard.ts`'s `REQUIRED_COLUMNS`/`REQUIRED_TABLES` AND every
   call site that reads them (`mcp/src/repo-status.ts`,
   `augmenter/src/writer/sqlite-writer.ts`) to match the new shape.

4. **Re-run the full suite** to confirm the guard now accepts the fixture db
   again and every other test (writer, shim, resolver) still passes against
   the new schema shape.

## What the guard checks

- `MAX(schema_versions.version)` is a member of `SUPPORTED_SCHEMA_VERSIONS`.
- `nodes.qualified_name` column exists.
- `edges.provenance` column exists.
- `project_metadata` table exists.

Any single failure refuses the whole open with one message naming the
pinned codegraph version, the supported version list, and this doc.
