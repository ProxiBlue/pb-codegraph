import fs from 'fs';
import path from 'path';
import { XMLParser } from 'fast-xml-parser';

// pb-codegraph: stripped from the vendored routes-xml.ts — only the pure
// parse functions (parseSingleRoutesXml, findRoutesXmlFiles) are vendored.
// parseAndMapRoutesXml (the mapper body) and its AugmentEdge/AugmentNode
// dependencies are legacy-server-coupled and are NOT vendored; adapted in 003b.

export interface FrontendRoute {
  routeId: string;
  frontName: string;
  moduleName: string;
  area: string;
  sourceFile: string;
}

const parserOptions = {
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
};

function asArray(val: unknown): unknown[] {
  if (val === undefined || val === null) return [];
  if (Array.isArray(val)) return val;
  return [val];
}

export function parseSingleRoutesXml(
  xmlContent: string,
  sourceFile: string,
  area: string,
): FrontendRoute[] {
  const routes: FrontendRoute[] = [];

  let parsed: unknown;
  try {
    const parser = new XMLParser(parserOptions);
    parsed = parser.parse(xmlContent);
  } catch {
    return routes;
  }

  if (!parsed || typeof parsed !== 'object') return routes;

  const root = parsed as Record<string, unknown>;
  const config = root['config'] as Record<string, unknown> | undefined;
  if (!config) return routes;

  for (const routerNode of asArray(config['router'])) {
    const router = routerNode as Record<string, unknown>;

    for (const routeNode of asArray(router['route'])) {
      const route = routeNode as Record<string, unknown>;
      const routeId = route['@_id'] as string | undefined;
      const frontName = route['@_frontName'] as string | undefined;
      if (!routeId || !frontName) continue;

      for (const moduleNode of asArray(route['module'])) {
        const mod = moduleNode as Record<string, unknown>;
        const moduleName = mod['@_name'] as string | undefined;
        if (!moduleName) continue;

        routes.push({ routeId, frontName, moduleName, area, sourceFile });
      }
    }
  }

  return routes;
}

// pb-codegraph: was an unexported `function findRoutesXmlFiles` in the
// original — exported here so it is directly testable/reusable per task
// 001's requirement to vendor `parseSingle* + find*Files`.
export function findRoutesXmlFiles(dir: string, area: string): Array<{ file: string; area: string }> {
  const results: Array<{ file: string; area: string }> = [];

  function walk(current: string): void {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.isFile() && entry.name === 'routes.xml') {
        const suffix = `etc/${area}/routes.xml`;
        if (full.endsWith(suffix)) {
          results.push({ file: full, area });
        }
      }
    }
  }

  walk(dir);
  return results;
}
