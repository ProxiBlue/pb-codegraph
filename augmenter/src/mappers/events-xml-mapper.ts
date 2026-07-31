// pb-codegraph: new file (not vendored). Adapts the legacy augmenter's
// parsers/events-xml.ts `parseAndMapEventsXml` (legacy-server-coupled, not
// vendored — see task 001 scope + _devils_advocate.md C1/C3). The vendored
// mapper links `File:<events.xml>` -> `File:<observer.php>`, neither of
// which is a codegraph node. This version anchors on a MINTED `event` node
// (`magento:event:<name>`) as the source and resolves the observer's
// `instance` FQCN to its class node as the target, per
// docs/edge-taxonomy.md's "Endpoint model".
import fs from 'fs';
import path from 'path';
import type Database from 'better-sqlite3';
import { parseSingleEventsXml, findEventsXmlFiles } from '../parsers/events-xml.ts';
import { resolveClass, mintEventId } from '../resolvers/node-id.ts';
import type { AugmentEdge, AugmentNode } from '../writer/sqlite-writer.ts';

export interface EventsMappingResult {
  nodes: AugmentNode[];
  edges: AugmentEdge[];
  stats: {
    resolved: number;
    /** `<observer disabled="true">` — a genuine skip; parsers/events-xml.ts
     * does not filter these itself (unlike di-xml.ts's plugin `disabled`
     * handling), so the mapper must. */
    skippedDisabled: number;
    /** Observer instance FQCNs with no native class node, minted as
     * `external` placeholders (see node-id.ts resolveClass). */
    externallyMinted: string[];
  };
}

const AREA_PATTERNS: Array<{ suffix: string; area: string }> = [
  { suffix: 'etc/frontend/events.xml', area: 'frontend' },
  { suffix: 'etc/adminhtml/events.xml', area: 'adminhtml' },
  { suffix: 'etc/webapi_rest/events.xml', area: 'webapi_rest' },
  { suffix: 'etc/webapi_soap/events.xml', area: 'webapi_soap' },
  { suffix: 'etc/events.xml', area: 'global' },
];

function areaFromPath(filePath: string): string {
  for (const { suffix, area } of AREA_PATTERNS) {
    if (filePath.endsWith(suffix)) return area;
  }
  return 'global';
}

export async function mapEventsXmlEdges(projectRoot: string, db: Database.Database): Promise<EventsMappingResult> {
  const nodes: AugmentNode[] = [];
  const edges: AugmentEdge[] = [];
  const externallyMinted: string[] = [];
  let resolved = 0;
  let skippedDisabled = 0;

  const mintedEventIds = new Set<string>();
  const searchDirs = [path.join(projectRoot, 'vendor'), path.join(projectRoot, 'app', 'code')];

  for (const searchDir of searchDirs) {
    if (!fs.existsSync(searchDir)) continue;

    const files = await findEventsXmlFiles(searchDir);
    for (const file of files) {
      if (!/\/etc\//.test(file)) continue;

      let content: string;
      try {
        content = fs.readFileSync(file, 'utf-8');
      } catch {
        continue;
      }

      const area = areaFromPath(file);
      const observers = parseSingleEventsXml(content, file, area);

      for (const obs of observers) {
        if (obs.disabled) {
          skippedDisabled++;
          continue;
        }

        const eventId = mintEventId(obs.eventName);
        if (!mintedEventIds.has(eventId)) {
          mintedEventIds.add(eventId);
          nodes.push({ id: eventId, kind: 'event', name: obs.eventName });
        }

        const observerNode = resolveClass(db, obs.instanceFqcn);
        if (observerNode.minted && observerNode.node) {
          nodes.push(observerNode.node);
          externallyMinted.push(obs.instanceFqcn);
        }

        edges.push({
          sourceId: eventId,
          targetId: observerNode.id,
          type: 'CALLS',
          reason: `magento:events:observer:${obs.eventName}`,
          metadata: { event: obs.eventName, area },
        });
        resolved++;
      }
    }
  }

  return { nodes, edges, stats: { resolved, skippedDisabled, externallyMinted } };
}
