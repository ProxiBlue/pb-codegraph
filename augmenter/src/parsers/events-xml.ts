import fs from 'fs';
import path from 'path';
import { XMLParser } from 'fast-xml-parser';

// pb-codegraph: stripped from the vendored events-xml.ts — only the pure
// parse functions (parseSingleEventsXml, findEventsXmlFiles) are vendored.
// parseAndMapEventsXml (the mapper body) and its NodeIdResolver/AugmentEdge
// dependencies are GitNexus-coupled and are NOT vendored; adapted in 003b.

export interface EventObserver {
  eventName: string;
  observerName: string;
  instanceFqcn: string;
  disabled: boolean;
  sourceFile: string;
  area: string;
}

const AREA_PATTERNS: Array<{ suffix: string; area: string }> = [
  { suffix: 'etc/frontend/events.xml', area: 'frontend' },
  { suffix: 'etc/adminhtml/events.xml', area: 'adminhtml' },
  { suffix: 'etc/webapi_rest/events.xml', area: 'webapi_rest' },
  { suffix: 'etc/webapi_soap/events.xml', area: 'webapi_soap' },
  { suffix: 'etc/events.xml', area: 'global' },
];

export function areaFromPath(filePath: string): string {
  for (const { suffix, area } of AREA_PATTERNS) {
    if (filePath.endsWith(suffix)) return area;
  }
  return 'global';
}

export function parseSingleEventsXml(xmlContent: string, sourceFile: string, area: string): EventObserver[] {
  const observers: EventObserver[] = [];

  let parsed: unknown;
  try {
    const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_' });
    parsed = parser.parse(xmlContent);
  } catch {
    return observers;
  }

  if (!parsed || typeof parsed !== 'object') return observers;

  const root = parsed as Record<string, unknown>;
  const config = root['config'] as Record<string, unknown> | undefined;
  if (!config) return observers;

  const eventRaw = config['event'];
  const eventList: unknown[] = Array.isArray(eventRaw) ? eventRaw : eventRaw != null ? [eventRaw] : [];

  for (const eventEl of eventList) {
    const ev = eventEl as Record<string, unknown>;
    const eventName = ev['@_name'] as string | undefined;
    if (!eventName) continue;

    const observerRaw = ev['observer'];
    const observerList: unknown[] = Array.isArray(observerRaw) ? observerRaw : observerRaw != null ? [observerRaw] : [];

    for (const obs of observerList) {
      const o = obs as Record<string, unknown>;
      const observerName = o['@_name'] as string | undefined;
      const instanceFqcn = o['@_instance'] as string | undefined;
      const disabled = String(o['@_disabled'] ?? 'false').toLowerCase() === 'true';

      if (!observerName || !instanceFqcn) continue;

      observers.push({ eventName, observerName, instanceFqcn, disabled, sourceFile, area });
    }
  }

  return observers;
}

// pb-codegraph: was an unexported `function findEventsXmlFiles` in the
// original — exported here so it is directly testable/reusable per task
// 001's requirement to vendor `parseSingle* + find*Files`.
export async function findEventsXmlFiles(dir: string): Promise<string[]> {
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
      } else if (entry.isFile() && entry.name === 'events.xml') {
        results.push(full);
      }
    }
  }

  walk(dir);
  return results;
}
