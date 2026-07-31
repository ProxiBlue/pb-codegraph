// pb-codegraph: new file (not vendored). Adapts mage-os-gitnexus's
// parsers/routes-xml.ts `parseAndMapRoutesXml` (GitNexus-coupled, not
// vendored — see task 001 scope + _devils_advocate.md C1/C3). The vendored
// mapper links `File:<routes.xml>` -> a Route node, which both fabricates a
// meaningless "routes.xml file declares itself" edge and never resolves an
// actual controller (Magento resolves frontName -> controller by URL
// convention at runtime, not by declaration in routes.xml — there is no
// controller FQCN anywhere in this parser's output to resolve). This
// version only mints the `route` node (`magento:route:<area>:<frontName>`,
// per resolvers/node-id.ts mintRouteId + docs/edge-taxonomy.md's "Node
// kinds") and deliberately emits NO edge — see docs/edge-taxonomy.md's
// "Route honesty note" and task 003b's explicit "do NOT fabricate a
// controller edge (document as v0.2 limitation, M2)". The route node
// standing alone (no outgoing/incoming edge) is the documented v0.2
// behaviour, not a bug.
import fs from 'fs';
import path from 'path';
import { parseSingleRoutesXml, findRoutesXmlFiles } from '../parsers/routes-xml.ts';
import { mintRouteId } from '../resolvers/node-id.ts';
import type { AugmentEdge, AugmentNode } from '../writer/sqlite-writer.ts';

export interface RoutesMappingResult {
  nodes: AugmentNode[];
  /** Always empty in v0.2 — see the module-level comment (M2 limitation). */
  edges: AugmentEdge[];
  stats: {
    /** Count of distinct minted route nodes (deduplicated by id). */
    routesMinted: number;
  };
}

const AREAS = ['frontend', 'adminhtml'] as const;

export async function mapRoutesXmlEdges(projectRoot: string): Promise<RoutesMappingResult> {
  const nodes: AugmentNode[] = [];
  const mintedRouteIds = new Set<string>();

  const searchDirs = [path.join(projectRoot, 'vendor'), path.join(projectRoot, 'app', 'code')];

  for (const searchDir of searchDirs) {
    if (!fs.existsSync(searchDir)) continue;

    for (const area of AREAS) {
      for (const { file } of findRoutesXmlFiles(searchDir, area)) {
        let content: string;
        try {
          content = fs.readFileSync(file, 'utf-8');
        } catch {
          continue;
        }

        const routes = parseSingleRoutesXml(content, file, area);
        for (const route of routes) {
          const routeId = mintRouteId(area, route.frontName);
          if (!mintedRouteIds.has(routeId)) {
            mintedRouteIds.add(routeId);
            nodes.push({ id: routeId, kind: 'route', name: `${area}:${route.frontName}` });
          }
        }
      }
    }
  }

  return { nodes, edges: [], stats: { routesMinted: mintedRouteIds.size } };
}
