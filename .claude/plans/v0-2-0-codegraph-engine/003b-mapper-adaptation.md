# Task 003b: Adapt the 5 XML mappers to the codegraph node/edge model

**Status**: pending
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
- [ ] `it emits preference_for edges between impl and interface class nodes`
- [ ] `it emits wraps edges carrying sortOrder and area metadata`
- [ ] `it emits observes edges from a minted event node to the observer class node with event metadata`
- [ ] `it emits renders edges from a block class node to a minted template node`
- [ ] `it emits references edges between a minted route node and the resolved controller/service class node`
- [ ] `it routes unresolved targets through the resolver's external minting so no edge dangles`
- [ ] `it preserves per-family resolved/skipped stats for the cli summary`

## Acceptance Criteria
- All five families produce the locked kinds against the task-001 fixture; counts match the taxonomy doc
- No mapper instantiates the old filesystem NodeIdResolver or emits a File:<relpath> endpoint id
