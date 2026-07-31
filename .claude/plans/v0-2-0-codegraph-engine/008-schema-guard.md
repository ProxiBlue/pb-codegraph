# Task 008: Schema-version guard + codegraph version pin

**Status**: pending
**Depends on**: 005
**Retry count**: 0

## Description
Guard module used by shim startup and augmenter: read schema_versions max(version) + presence checks (nodes.qualified_name, edges.provenance, project_metadata) and compare against the supported matrix (v6-era as characterized from pinned codegraph 1.5.0 — record actual observed version in the matrix during implementation). Unknown/newer schema → refuse with actionable message naming the pinned codegraph version. Pin: wrapper + fixture script call npx @colbymchenry/codegraph@<pinned>; single PINNED_VERSION constant + docs on the upgrade procedure (bump pin → run fixture suite → update matrix).

## Requirements (Test Descriptions)
- [ ] `it accepts the fixture db schema version`
- [ ] `it refuses an artificially bumped schema version with actionable message`
- [ ] `it refuses when provenance column is absent`
- [ ] `it exposes one pinned version constant consumed by wrapper and fixture script`

## Acceptance Criteria
- Guard wired into shim startup and augment entry; tests cover accept+refuse paths
