# Task 001: Vendor augmenter + fixture tree + edge taxonomy doc

**Status**: completed
**Depends on**: none
**Retry count**: 0

## Description
Vendor ONLY the pure XML parsers + path resolvers verbatim from the legacy augmenter's source tree into augmenter/src/, preserving Apache-2.0+attribution notices for the vendored MIT code in NOTICE. Create tests/fixture/: a tiny synthetic Magento module tree (2 modules, one di.xml with preference+plugin+virtualType+sortOrder, events.xml with 2 observers, one layout xml block+template, webapi.xml route, frontend routes.xml, 3 PHP classes, PLUS one di.xml preference/plugin whose target FQCN is NOT present in the fixture tree — to exercise external-node minting in 003) plus scripts/build-fixture-db.sh that runs codegraph init+index over it to produce the test DB (DB not committed; built on demand, codegraph pinned via npx @colbymchenry/codegraph@1.5.0). Write docs/edge-taxonomy.md: the fixed edge/node contract every later task consumes.

**Scope boundary (critical — verified against source):** The mappers, the node-id resolver, and the writer are NOT vendored verbatim — they are legacy-coupled and re-implemented downstream:
- Vendor VERBATIM: `parsers/di-xml.ts`, `parsers/layout-xml.ts`, the parse-only functions of `parsers/events-xml.ts`/`webapi-xml.ts`/`routes-xml.ts` (`parseSingle*` + `find*Files`), `resolvers/psr4-map.ts`, `resolvers/template-path.ts`.
- Do NOT vendor: `writer/lbug-writer.ts` (→ task 002), `resolvers/node-id.ts` (filesystem/synthetic-id based → DB-backed rewrite in task 003), the `mapAndParse*`/`map*Edges` mapper bodies (→ task 003b — they hardcode the old id scheme, uppercase edge `type`, and File-level endpoints).

## Context
- Source: the legacy augmenter's src/{parsers,resolvers}/*.ts (+ augment.ts, cli.ts as reference only)
- Taxonomy (LOCKED, CORRECTED to match the actual data model — see _devils_advocate.md C2/C3/I1):
  - Edge kinds (writer remaps the vendored uppercase `type`+`reason` to these — see 002): `preference_for` (was IMPLEMENTS+magento:di:preference — MUST be a distinct kind, NOT native `implements`), `wraps` (metadata: sortOrder, area — before/after/around is NOT available from di.xml in v0.2, deferred to v0.4), `observes` (metadata: event, area), `renders`, `references`.
  - Node kinds: native class/interface/method (codegraph-owned); MINTED by augmenter — `event` (id `magento:event:<name>`), `route` (id `magento:route:<area>:<path>`), `template` (id `magento:template:<area>:<path>`), `external` (id `magento:external:<normalized-fqcn>`, for targets not indexed).
  - Endpoint model (corrected — the vendored mappers emit File:<relpath> endpoints which have NO codegraph node): observer = `event` node → observer CLASS node; layout = block CLASS node → `template` node; webapi/routes = service/controller CLASS node ↔ `route` node. Resolution of File/FQCN → class node is task 003's job.
  - provenance='pb-codegraph-augmenter' on every injected row; metadata.reason='magento:<source>' preserved from the vendored parser's `reason` string.
- NOTICE: original augmenter is Lucas's own MIT code from his prior wrapper project — note origin + relicense-compatibility line

## Requirements (Test Descriptions)
- [x] `it vendors the pure xml parsers and path resolvers verbatim, does NOT vendor mappers or lbug writer, and re-implements node-id resolver DB-backed (not vendored)` (renamed by task 003, see its note below — original text: "...and does NOT vendor node-id resolver, mappers, or lbug writer")
  - di-xml.ts, layout-xml.ts, resolvers/psr4-map.ts, resolvers/template-path.ts copied byte-for-byte. events-xml.ts/webapi-xml.ts/routes-xml.ts stripped to parseSingle*+find*Files only (mapAndParse*/parseAndMap* + writer/node-id imports removed), findEventsXmlFiles/findWebapiXmlFiles exported (were unexported in source) — both changes marked with `// pb-codegraph:` comments per code-standards.
  - **Task 003 addendum:** once task 003 created its DB-backed rewrite at the same path (`augmenter/src/resolvers/node-id.ts`, by design — see 003's own description), the original "must NOT exist" assertion for that path was no longer distinguishing "vendored" from "not vendored". tests/vendoring.test.ts was updated (by task 003) to assert the file exists but does not carry the vendored filesystem/synthetic-id implementation (`fs.existsSync`, `NodeIdResolver` class, `Class:<path>:<Name>` id scheme) and does query the `nodes` table — same intent, corrected mechanism.
- [x] `it ships a fixture module tree covering all six edge families plus one unresolved-target case for external minting`
  - tests/fixture/app/code/Acme/{ModuleA,ModuleB}: preference+plugin+virtualType (ModuleA di.xml), 2-observer events.xml, block+template layout xml (+ physical .phtml), webapi.xml route, frontend routes.xml, 3 PHP files (FooInterface, Foo, FooPlugin), and ModuleB/etc/di.xml plugin targeting Magento\Catalog\Model\Product (no backing file in tree = external-mint case). Namespace originally `Vendor` — renamed to `Acme` after req 4 discovered codegraph ignores dirs literally named `Vendor` (see req 4 note).
- [x] `it ships a plugin fixture carrying sortOrder and area attributes`
  - Passed immediately (no new prod code needed): ModuleA/etc/di.xml's plugin (sortOrder=10) was already built alongside requirement 2's fixture since the task bundles preference+plugin+virtualType+sortOrder into one file. Test adds a parser-level check (parseSingleDiXml against the fixture) confirming sortOrder=10, area='global' round-trip.
- [x] `it builds a fixture codegraph db via pinned codegraph version script`
  - scripts/build-fixture-db.sh (executable, set -euo pipefail, only ever rm -rf's tests/fixture/.codegraph — never touches .git) runs `npx --yes @colbymchenry/codegraph@1.5.0 init --force`. Found+fixed a real bug during RED->GREEN: codegraph silently default-ignores any directory literally named `Vendor` (matches composer's `vendor/` convention, case-sensitive on "Vendor" too) — "No files found to index" with zero error. Renamed the fixture's placeholder vendor namespace from `Vendor` to `Acme` (dirs, namespaces, di.xml/events.xml/webapi.xml/routes.xml/layout content, module names, file `vendor_moduleb_index_index.xml` -> `acme_moduleb_index_index.xml`) across fixture + tests/fixture-tree.test.ts + tests/di-xml-fixture.test.ts. DB now indexes 24 nodes/15 edges from the fixture tree.
- [x] `it documents the corrected edge/node taxonomy (kind remap, minted node kinds, class-not-File endpoints, wraps metadata sortOrder/area only) with metadata fields per kind`
  - docs/edge-taxonomy.md: full remap table (uppercase vendored type+reason -> locked lowercase kind), preference_for-vs-native-implements collision note, minted node id schemes, corrected class/minted-node endpoint model (not File:), wraps sortOrder/area scope with before/after/around explicitly deferred to v0.4, route honesty note (M2), provenance discipline.
- [x] `it records vendored-code origin in NOTICE`
  - NOTICE gets a new "Vendored code" section: origin (the author's prior Magento augmenter), original MIT license + author, exact list of what was/wasn't vendored, and the same-copyright-holder relicense-compatibility rationale for MIT->Apache-2.0.

## Acceptance Criteria
- npx tsc --noEmit passes on vendored sources (or documented minimal shims)
- Fixture build script runs clean on this host
