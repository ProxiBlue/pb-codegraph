// pb-codegraph: new file (not vendored). Adapts the legacy augmenter's
// parsers/di-xml-mapper.ts (see _devils_advocate.md C1/C2/C3) — that mapper
// instantiates the filesystem `NodeIdResolver`, emits uppercase
// IMPLEMENTS/WRAPS `type` values, and drops the `sortOrder`/`area` a plugin
// carries. This version consumes the vendored pure parser (parsers/di-xml.ts,
// task 001) and the DB-backed resolver (resolvers/node-id.ts, task 003), and
// forwards sortOrder/area into edge metadata per docs/edge-taxonomy.md's
// "wraps metadata scope".
import type Database from 'better-sqlite3';
import { parseDiXml } from '../parsers/di-xml.ts';
import { resolveClass, type ResolvedNode } from '../resolvers/node-id.ts';
import type { AugmentEdge, AugmentNode } from '../writer/sqlite-writer.ts';

export interface DiMappingResult {
  nodes: AugmentNode[];
  edges: AugmentEdge[];
  stats: {
    preferencesResolved: number;
    // Always 0 in v0.2 — parsers/di-xml.ts only pushes a preference into its
    // result when both `for` and `type` attributes are present, and
    // resolveClass() never fails to produce an id (falls back to a minted
    // `external` placeholder). Kept for CLI-summary shape stability with the
    // vendored mapper's stats object (which could skip on an unresolved
    // FQCN before the resolver rewrite removed that failure mode).
    preferencesSkipped: number;
    pluginsResolved: number;
    pluginsSkipped: number;
    /** FQCNs that had no native class/interface node and were minted as
     * `external` placeholders (see node-id.ts resolveClass) — the v0.2
     * analogue of the vendored mapper's `unresolvedFqcns` list. */
    externallyMinted: string[];
  };
}

/** Stages a minted node for insertion and records the ORIGINAL fqcn (not
 * the minted `magento:external:...` id) in `externallyMinted` — the v0.2
 * analogue of the vendored mapper's `unresolvedFqcns: string[]`. */
function mintIfNeeded(resolved: ResolvedNode, fqcn: string, nodes: AugmentNode[], externallyMinted: string[]): void {
  if (resolved.minted && resolved.node) {
    nodes.push(resolved.node);
    externallyMinted.push(fqcn);
  }
}

export async function mapDiXmlEdges(projectRoot: string, db: Database.Database): Promise<DiMappingResult> {
  const { preferences, plugins } = await parseDiXml(projectRoot);

  const nodes: AugmentNode[] = [];
  const edges: AugmentEdge[] = [];
  const externallyMinted: string[] = [];
  let preferencesResolved = 0;
  let pluginsResolved = 0;

  for (const pref of preferences) {
    // pb-codegraph: direction — source = impl (concrete, `toType`) class
    // node, target = interface/abstract (`forType`) class node. This
    // matches the vendored mapper's own source/target assignment
    // (di-xml-mapper.ts:34-35, "Class→Interface" per
    // _devils_advocate.md C2) and the `preference_for` kind name's natural
    // reading ("<impl class> is a preference_for <interface>"), per task
    // 003b's explicit spec. NOTE: docs/edge-taxonomy.md's kind-remap table
    // literally reads "interface node → concrete class node" for this row
    // (the opposite), which conflicts with both the vendored source and
    // 003b's own prose a few lines above it in the same doc — flagging the
    // doc inconsistency here rather than silently picking a side. 003b is
    // this task's authoritative spec, so its explicit direction wins.
    const implNode = resolveClass(db, pref.toType);
    const interfaceNode = resolveClass(db, pref.forType);
    mintIfNeeded(implNode, pref.toType, nodes, externallyMinted);
    mintIfNeeded(interfaceNode, pref.forType, nodes, externallyMinted);

    edges.push({
      sourceId: implNode.id,
      targetId: interfaceNode.id,
      type: 'IMPLEMENTS',
      reason: 'magento:di:preference',
      metadata: { area: pref.area },
    });
    preferencesResolved++;
  }

  for (const plug of plugins) {
    // source = plugin class node, target = wrapped (target) class node —
    // matches the vendored mapper (di-xml-mapper.ts:62-63) and task 003b's
    // spec. sortOrder + area ARE parsed by di-xml.ts (:90/92) but dropped by
    // the vendored mapper — forwarded into metadata here per
    // docs/edge-taxonomy.md's "wraps metadata scope".
    const pluginNode = resolveClass(db, plug.pluginType);
    const targetNode = resolveClass(db, plug.targetType);
    mintIfNeeded(pluginNode, plug.pluginType, nodes, externallyMinted);
    mintIfNeeded(targetNode, plug.targetType, nodes, externallyMinted);

    edges.push({
      sourceId: pluginNode.id,
      targetId: targetNode.id,
      type: 'WRAPS',
      reason: 'magento:di:plugin',
      metadata: { sortOrder: plug.sortOrder, area: plug.area },
    });
    pluginsResolved++;
  }

  return {
    nodes,
    edges,
    stats: {
      preferencesResolved,
      preferencesSkipped: 0,
      pluginsResolved,
      pluginsSkipped: 0,
      externallyMinted,
    },
  };
}
