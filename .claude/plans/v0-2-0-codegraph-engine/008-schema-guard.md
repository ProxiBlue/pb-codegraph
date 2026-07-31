# Task 008: Schema-version guard + codegraph version pin

**Status**: completed
**Depends on**: 005
**Retry count**: 0

## Description
Guard module used by shim startup and augmenter: read schema_versions max(version) + presence checks (nodes.qualified_name, edges.provenance, project_metadata) and compare against the supported matrix (v6-era as characterized from pinned codegraph 1.5.0 — record actual observed version in the matrix during implementation). Unknown/newer schema → refuse with actionable message naming the pinned codegraph version. Pin: wrapper + fixture script call npx @colbymchenry/codegraph@<pinned>; single PINNED_VERSION constant + docs on the upgrade procedure (bump pin → run fixture suite → update matrix).

## Requirements (Test Descriptions)
- [x] `it accepts the fixture db schema version`
- [x] `it refuses an artificially bumped schema version with actionable message`
- [x] `it refuses when provenance column is absent`
- [x] `it exposes one pinned version constant consumed by wrapper and fixture script`

## Acceptance Criteria
- Guard wired into shim startup and augment entry; tests cover accept+refuse paths

## Implementation Notes
- Single guard module at `shared/schema-guard.ts` (`assertSupportedSchema`, throws `UnsupportedSchemaError`), consumed by BOTH `mcp/src/db.ts`'s `openReadOnlyDb` and `augmenter/src/writer/sqlite-writer.ts`'s `openWriterDb` — no `server.ts` edits (per coordination note; avoided any overlap with concurrent 006/007 work).
- `shared/pinned.ts` is the single `PINNED_CODEGRAPH_VERSION`/`PINNED_CODEGRAPH_PACKAGE` ("@colbymchenry/codegraph@1.5.0") source. `scripts/build-fixture-db.sh` keeps its own literal in sync (bash can't `import` a `.ts` module); `tests/schema-guard.test.ts` is the sed-able-marker cross-check that fails the build if they drift.
- Observed `MAX(schema_versions.version)` from `tests/fixture/.codegraph/codegraph.db` (built via the pinned codegraph 1.5.0) = `8` (table carries two rows, versions 1 and 8) — recorded as the sole entry in `shared/schema-guard.ts`'s `SUPPORTED_SCHEMA_VERSIONS`.
- Presence checks: `nodes.qualified_name` column, `edges.provenance` column, `project_metadata` table — all characterized present in the fixture db.
- `tsconfig.json` `include` extended with `"shared/**/*"`.
- New `docs/upgrading-codegraph.md`: bump-pin → fixture-suite → matrix-update procedure.
- Pre-existing, unrelated test failures observed during the full-suite run (`node --test`): `tests/node-id-resolver.test.ts` (module load `SyntaxError` — `augmenter/src/resolvers/node-id.ts` missing `resolveMethod`/`resolveFileEndpoint` exports) and one `tests/vendoring.test.ts` subtest, both from task 003's (node-id-resolver) in-progress work, not touched by this task. Confirmed pre-existing via `git stash` (tracked-file diff reverted, error persisted unchanged) and by neither failure referencing any file this task touched (`shared/`, `mcp/src/db.ts`, `augmenter/src/writer/sqlite-writer.ts`, `docs/upgrading-codegraph.md`, `tsconfig.json`).
