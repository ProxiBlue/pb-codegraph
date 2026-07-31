import fs from 'fs';
import path from 'path';
import { XMLParser } from 'fast-xml-parser';

// pb-codegraph: stripped from the vendored webapi-xml.ts — only the pure
// parse functions (parseSingleWebapiXml, findWebapiXmlFiles) are vendored.
// parseAndMapWebapiXml (the mapper body) and its NodeIdResolver/AugmentEdge/
// AugmentNode dependencies are legacy-server-coupled and are NOT vendored;
// adapted in 003b.

export interface WebapiRoute {
  url: string;
  httpMethod: string;
  serviceClass: string;
  serviceMethod: string;
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

export function parseSingleWebapiXml(xmlContent: string, sourceFile: string): WebapiRoute[] {
  const routes: WebapiRoute[] = [];

  let parsed: unknown;
  try {
    const parser = new XMLParser(parserOptions);
    parsed = parser.parse(xmlContent);
  } catch {
    return routes;
  }

  if (!parsed || typeof parsed !== 'object') return routes;

  const root = parsed as Record<string, unknown>;
  const routesEl = root['routes'] as Record<string, unknown> | undefined;
  if (!routesEl) return routes;

  const routeList = asArray(routesEl['route']);
  for (const routeRaw of routeList) {
    const route = routeRaw as Record<string, unknown>;
    const url = route['@_url'] as string | undefined;
    const httpMethod = route['@_method'] as string | undefined;

    const serviceRaw = route['service'] as Record<string, unknown> | undefined;
    if (!serviceRaw) continue;

    const serviceClass = serviceRaw['@_class'] as string | undefined;
    const serviceMethod = serviceRaw['@_method'] as string | undefined;

    if (!url || !httpMethod || !serviceClass || !serviceMethod) continue;

    routes.push({ url, httpMethod, serviceClass, serviceMethod, sourceFile });
  }

  return routes;
}

// pb-codegraph: was an unexported `function findWebapiXmlFiles` in the
// original — exported here so it is directly testable/reusable per task
// 001's requirement to vendor `parseSingle* + find*Files`.
export async function findWebapiXmlFiles(dir: string): Promise<string[]> {
  const results: string[] = [];

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
      } else if (entry.isFile() && entry.name === 'webapi.xml') {
        results.push(full);
      }
    }
  }

  walk(dir);
  return results;
}
