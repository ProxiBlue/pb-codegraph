# Task 003b: Adapt the 5 XML mappers to the codegraph node/edge model

**Status**: completed
**Depends on**: 001, 002, 003
**Retry count**: 0

## Description
Re-implement the 5 mapper bodies (di, layout, events, webapi, routes) — NOT vendored verbatim because they hardcode GitNexus's synthetic id scheme, uppercase edge `type`, File-level endpoints, and the filesystem `NodeIdResolver` (see _devils_advocate.md C1/C2/C3). Each adapted mapper consumes the vendored pure parser (task 001), resolves endpoints via the DB-backed resolver (task 003), and emits the writer's edge shape with `metadata` (task 002). Concretely:

- **di preference**: `mapDiXmlEdges` preferences → edge kind `preference_for`, source = impl class node, target = interface/abstract class node.
- **di plugin**: → kind `wraps`, source = plugin class node, target = wrapped class node, metadata {sortOrder, area} (both ARE parsed by di-xml.ts:90/92 but dropped by the old mapper — forward them). before/after/around NOT emitted in v0.2.
- **events observer**: → kind `observes`; source = MINTED `event` node (`magento:event:<name>`), target = observer CLASS node (resolve instanceFqcn, not File:observer.php), metadata {event, area}.
- **layout block→template**: → kind `renders`; source = block CLASS node (resolve blockClass), target = MINTED `template` node (`magento:template:<area>:<path>`), keep template ref in metadata.
- **webapi / routes**: → kind `references`; MINTED `route` node (`magento:route:<area>:<path>` for frontend, webapi url for REST) ↔ resolved service/controller class node. routes.xml declares no controller (Magento resolves frontName→controller by convention) — the route node may stand alone; do NOT fabricate a controller edge (document as v0.2 limitation, M2).

Area-merge semantics from the original augment.ts are preserved (parser ordering, per-area di/events handling). Every emitted edge carries provenance via the writer.

## Context
- Reference (do NOT copy verbatim): di-xml-mapper.ts, layout-xml-mapper.ts, events-xml.ts, webapi-xml.ts, routes-xml.ts under ~/workspace/proxiblue/mage-os-gitnexus/augmenter/src — for parser call patterns and stats shapes only.
- The resolver (003) owns FQCN/File→node-id + minting; the writer (002) owns remap-to-kind + metadata JSON + FTS. This task wires parser → resolver → writer per family.
- Skipped/unresolved counts must still be surfaced per family (the old stats objects) for the CLI summary (004).

## Requirements (Test Descriptions)
- [x] `it emits preference_for edges between impl and interface class nodes` — `augmenter/src/mappers/di-xml-mapper.ts` `mapDiXmlEdges`; source=impl(`toType`) class node, target=interface(`forType`) node (see in-code comment: task-003b direction wins over docs/edge-taxonomy.md's reversed table cell — flagged, not silently resolved)
- [x] `it emits wraps edges carrying sortOrder and area metadata` — same file, plugin loop; forwards `sortOrder`/`area` into `edges.metadata` (previously dropped by the vendored mapper)
- [x] `it emits observes edges from a minted event node to the observer class node with event metadata` — `augmenter/src/mappers/events-xml-mapper.ts` `mapEventsXmlEdges`; source=minted `magento:event:<name>` node, target=`resolveClass(instanceFqcn)`
- [x] `it emits renders edges from a block class node to a minted template node` — `augmenter/src/mappers/layout-xml-mapper.ts` `mapLayoutXmlEdges`; source=`resolveClass(blockClass)`, target=minted `magento:template:<area>:<templateRef>`
- [x] `it emits references edges between a minted route node and the resolved controller/service class node` — `augmenter/src/mappers/webapi-xml-mapper.ts` `mapWebapiXmlEdges` (webapi.xml service method resolved via `resolveMethod`); routes.xml intentionally emits no class-side edge, see next requirement's mapper and the M2 note below
- [x] `it routes unresolved targets through the resolver's external minting so no edge dangles` — exercised via ModuleB's di.xml unresolved `Magento\Catalog\Model\Product` plugin target; `resolveClass` mints `magento:external:...` and the mapper stages it into the writer's node batch
- [x] `it preserves per-family resolved/skipped stats for the cli summary` — each mapper returns a `stats` object (`preferencesResolved`/`pluginsResolved`, `resolved`/`skippedDisabled`, `resolved`, `resolved`, `routesMinted`) for task 004's CLI summary

## Acceptance Criteria
- All five families produce the locked kinds against the task-001 fixture; counts match the taxonomy doc
- No mapper instantiates the old filesystem NodeIdResolver or emits a File:<relpath> endpoint id

## Implementation Notes
- 5 mapper files added under `augmenter/src/mappers/` (di-xml-mapper.ts, events-xml-mapper.ts, layout-xml-mapper.ts, webapi-xml-mapper.ts, routes-xml-mapper.ts). None instantiate the vendored filesystem `NodeIdResolver` or `parsePsr4Map`/`TemplatePathResolver` — all endpoint resolution goes through task 003's DB-backed `resolvers/node-id.ts`.
- **routes.xml (M2 limitation, explicit per task text):** `mapRoutesXmlEdges` mints the `route` node only and emits **zero** edges — routes.xml carries no controller FQCN to resolve (Magento resolves frontName→controller by URL convention, not declaration), so fabricating a class-side edge was explicitly out of scope. The route node surviving GC (writer's `deleteOrphanedMintedNodes`) relies on the mapper re-emitting the same node on every re-run (verified: the writer inserts nodes before checking edge-orphan state on the *next* cycle, and this mapper always re-stages the node regardless of edge presence).
- **Direction discrepancy (documented, not silently resolved):** `docs/edge-taxonomy.md`'s "Kind remap table" row for `preference_for` reads "interface node → concrete class node", which is the *reverse* of both (a) the vendored `di-xml-mapper.ts`'s own source/target assignment (`_devils_advocate.md` C2: "Class→Interface"), and (b) this task file's explicit prose two lines above the requirements ("source = impl class node, target = interface/abstract class node"). Since this task file is the explicitly-authoritative spec for 003b, I implemented source=impl, target=interface, and left an in-code comment at the call site flagging the doc/task mismatch for whoever reconciles the taxonomy doc next (likely 004/007 authors should double-check downstream query direction against this choice).
- `externallyMinted` stats arrays store the *original FQCN* (not the minted `magento:external:...` id) — matches the vendored mapper's `unresolvedFqcns: string[]` semantics, repurposed since the new resolver never truly "fails" (always mints a placeholder instead of skipping).
- Template minting uses the raw layout `template` ref verbatim (`magento:template:<area>:<Module_Name::path.phtml>`) rather than a filesystem-resolved relative path — matches `mintTemplateId`'s doc comment and the `node-id-resolver.test.ts` characterization (`mintTemplateId('frontend', 'Acme_ModuleB::foo.phtml')`), so `resolvers/template-path.ts`'s `TemplatePathResolver` is not used by this mapper.
- webapi route id is minted from the URL alone (`magento:route:webapi:<url>`), no HTTP method in the id — matches `node-id-resolver.test.ts`'s `mintRouteId('webapi', '/V1/moduleb/foo')` characterization (the vendored mapper's `Route:webapi:${httpMethod}:${url}` scheme was NOT carried over).
- New test file: `tests/magento-mappers.test.ts` (7 tests, one per requirement, using `buildIsolatedFixtureDb` + the real writer per the existing `tests/helpers/inject-magento-edges.ts` pattern). `npx tsc --noEmit` clean; `node --test --import tsx tests/magento-mappers.test.ts` — 7/7 pass.
