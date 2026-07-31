// pb-codegraph: new file (not vendored). Adapts mage-os-gitnexus's
// parsers/layout-xml-mapper.ts (GitNexus-coupled, not vendored — see task
// 001 scope + _devils_advocate.md C1/C3). The vendored mapper links
// `File:<block-class.php>` -> `File:<resolved-template-path>`, neither of
// which is a codegraph node once the template can't be found on disk. This
// version resolves the block `class` FQCN to its class node (source) and
// mints a `template` node from the raw layout `template` ref (target) — per
// docs/edge-taxonomy.md's "Endpoint model", the template id is
// `magento:template:<area>:<templateRef>` (module::relative-path form),
// independent of whether the .phtml file can be located on disk.
import type Database from 'better-sqlite3';
import { parseLayoutXml } from '../parsers/layout-xml.ts';
import { resolveClass, mintTemplateId } from '../resolvers/node-id.ts';
import type { AugmentEdge, AugmentNode } from '../writer/sqlite-writer.ts';

export interface LayoutMappingResult {
  nodes: AugmentNode[];
  edges: AugmentEdge[];
  stats: {
    resolved: number;
    /** Block class FQCNs with no native class node, minted as `external`
     * placeholders (see node-id.ts resolveClass). */
    externallyMinted: string[];
  };
}

export async function mapLayoutXmlEdges(projectRoot: string, db: Database.Database): Promise<LayoutMappingResult> {
  const { blockTemplates } = await parseLayoutXml(projectRoot);

  const nodes: AugmentNode[] = [];
  const edges: AugmentEdge[] = [];
  const externallyMinted: string[] = [];
  const mintedTemplateIds = new Set<string>();
  let resolved = 0;

  for (const bt of blockTemplates) {
    const blockNode = resolveClass(db, bt.blockClass);
    if (blockNode.minted && blockNode.node) {
      nodes.push(blockNode.node);
      externallyMinted.push(bt.blockClass);
    }

    const templateId = mintTemplateId(bt.area, bt.templateRef);
    if (!mintedTemplateIds.has(templateId)) {
      mintedTemplateIds.add(templateId);
      nodes.push({ id: templateId, kind: 'template', name: bt.templateRef });
    }

    edges.push({
      sourceId: blockNode.id,
      targetId: templateId,
      type: 'CALLS',
      reason: 'magento:layout:block-template',
      metadata: { templateRef: bt.templateRef, area: bt.area },
    });
    resolved++;
  }

  return { nodes, edges, stats: { resolved, externallyMinted } };
}
