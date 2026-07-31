# Task 001: Vendor augmenter + fixture tree + edge taxonomy doc

**Status**: pending
**Depends on**: none
**Retry count**: 0

## Description
Vendor ONLY the pure XML parsers + path resolvers verbatim from ~/workspace/proxiblue/mage-os-gitnexus/augmenter/src into augmenter/src/, preserving Apache-2.0+attribution notices for the vendored MIT code in NOTICE. Create tests/fixture/: a tiny synthetic Magento module tree (2 modules, one di.xml with preference+plugin+virtualType+sortOrder, events.xml with 2 observers, one layout xml block+template, webapi.xml route, frontend routes.xml, 3 PHP classes, PLUS one di.xml preference/plugin whose target FQCN is NOT present in the fixture tree — to exercise external-node minting in 003) plus scripts/build-fixture-db.sh that runs codegraph init+index over it to produce the test DB (DB not committed; built on demand, codegraph pinned via npx @colbymchenry/codegraph@1.5.0). Write docs/edge-taxonomy.md: the fixed edge/node contract every later task consumes.

**Scope boundary (critical — verified against source):** The mappers, the node-id resolver, and the writer are NOT vendored verbatim — they are GitNexus-coupled and re-implemented downstream:
- Vendor VERBATIM: `parsers/di-xml.ts`, `parsers/layout-xml.ts`, the parse-only functions of `parsers/events-xml.ts`/`webapi-xml.ts`/`routes-xml.ts` (`parseSingle*` + `find*Files`), `resolvers/psr4-map.ts`, `resolvers/template-path.ts`.
- Do NOT vendor: `writer/lbug-writer.ts` (→ task 002), `resolvers/node-id.ts` (filesystem/synthetic-id based → DB-backed rewrite in task 003), the `mapAndParse*`/`map*Edges` mapper bodies (→ task 003b — they hardcode the old id scheme, uppercase edge `type`, and File-level endpoints).

## Context
- Source: /home/lucas/workspace/proxiblue/mage-os-gitnexus/augmenter/src/{parsers,resolvers}/*.ts (+ augment.ts, cli.ts as reference only)
- Taxonomy (LOCKED, CORRECTED to match the actual data model — see _devils_advocate.md C2/C3/I1):
  - Edge kinds (writer remaps the vendored uppercase `type`+`reason` to these — see 002): `preference_for` (was IMPLEMENTS+magento:di:preference — MUST be a distinct kind, NOT native `implements`), `wraps` (metadata: sortOrder, area — before/after/around is NOT available from di.xml in v0.2, deferred to v0.4), `observes` (metadata: event, area), `renders`, `references`.
  - Node kinds: native class/interface/method (codegraph-owned); MINTED by augmenter — `event` (id `magento:event:<name>`), `route` (id `magento:route:<area>:<path>`), `template` (id `magento:template:<area>:<path>`), `external` (id `magento:external:<normalized-fqcn>`, for targets not indexed).
  - Endpoint model (corrected — the vendored mappers emit File:<relpath> endpoints which have NO codegraph node): observer = `event` node → observer CLASS node; layout = block CLASS node → `template` node; webapi/routes = service/controller CLASS node ↔ `route` node. Resolution of File/FQCN → class node is task 003's job.
  - provenance='pb-codegraph-augmenter' on every injected row; metadata.reason='magento:<source>' preserved from the vendored parser's `reason` string.
- NOTICE: original augmenter is Lucas's own MIT code from mage-os-gitnexus wrapper — note origin + relicense-compatibility line

## Requirements (Test Descriptions)
- [ ] `it vendors the pure xml parsers and path resolvers verbatim and does NOT vendor node-id resolver, mappers, or lbug writer`
- [ ] `it ships a fixture module tree covering all six edge families plus one unresolved-target case for external minting`
- [ ] `it ships a plugin fixture carrying sortOrder and area attributes`
- [ ] `it builds a fixture codegraph db via pinned codegraph version script`
- [ ] `it documents the corrected edge/node taxonomy (kind remap, minted node kinds, class-not-File endpoints, wraps metadata sortOrder/area only) with metadata fields per kind`
- [ ] `it records vendored-code origin in NOTICE`

## Acceptance Criteria
- npx tsc --noEmit passes on vendored sources (or documented minimal shims)
- Fixture build script runs clean on this host
