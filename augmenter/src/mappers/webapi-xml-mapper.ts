// pb-codegraph: new file (not vendored). Adapts the legacy augmenter's
// parsers/webapi-xml.ts `parseAndMapWebapiXml` (legacy-server-coupled, not
// vendored — see task 001 scope + _devils_advocate.md C1/C3). The vendored
// mapper mints a route id keyed by `httpMethod:url` and strips the
// resolver's Interface node id down to a synthetic `File:` id. This version
// mints the route id from the URL alone (`magento:route:webapi:<url>`, per
// resolvers/node-id.ts mintRouteId + docs/edge-taxonomy.md's "Node kinds")
// and resolves the service class+method to the actual method node (falling
// back to the class node) via resolvers/node-id.ts resolveMethod — source =
// resolved service class/method node, target = minted route node, per
// docs/edge-taxonomy.md's "Endpoint model" (webapi/routes direction).
import fs from 'fs';
import path from 'path';
import type Database from 'better-sqlite3';
import { parseSingleWebapiXml, findWebapiXmlFiles } from '../parsers/webapi-xml.ts';
import { resolveMethod, mintRouteId } from '../resolvers/node-id.ts';
import type { AugmentEdge, AugmentNode } from '../writer/sqlite-writer.ts';

export interface WebapiMappingResult {
  nodes: AugmentNode[];
  edges: AugmentEdge[];
  stats: {
    resolved: number;
    /** Service class FQCNs with no native class/method node, minted as
     * `external` placeholders (see node-id.ts resolveMethod -> resolveClass). */
    externallyMinted: string[];
  };
}

export async function mapWebapiXmlEdges(projectRoot: string, db: Database.Database): Promise<WebapiMappingResult> {
  const nodes: AugmentNode[] = [];
  const edges: AugmentEdge[] = [];
  const externallyMinted: string[] = [];
  const mintedRouteIds = new Set<string>();
  let resolved = 0;

  const searchDirs = [path.join(projectRoot, 'vendor'), path.join(projectRoot, 'app', 'code')];

  for (const searchDir of searchDirs) {
    if (!fs.existsSync(searchDir)) continue;

    const files = await findWebapiXmlFiles(searchDir);
    for (const file of files) {
      let content: string;
      try {
        content = fs.readFileSync(file, 'utf-8');
      } catch {
        continue;
      }

      const routes = parseSingleWebapiXml(content, file);
      for (const route of routes) {
        const routeId = mintRouteId('webapi', route.url);
        if (!mintedRouteIds.has(routeId)) {
          mintedRouteIds.add(routeId);
          nodes.push({ id: routeId, kind: 'route', name: `${route.httpMethod} ${route.url}` });
        }

        const serviceNode = resolveMethod(db, route.serviceClass, route.serviceMethod);
        if (serviceNode.minted && serviceNode.node) {
          nodes.push(serviceNode.node);
          externallyMinted.push(route.serviceClass);
        }

        edges.push({
          sourceId: serviceNode.id,
          targetId: routeId,
          type: 'HANDLES_ROUTE',
          reason: 'magento:webapi:route',
          metadata: { area: 'webapi' },
        });
        resolved++;
      }
    }
  }

  return { nodes, edges, stats: { resolved, externallyMinted } };
}
