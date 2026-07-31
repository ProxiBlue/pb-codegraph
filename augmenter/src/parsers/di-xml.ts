import fs from 'fs';
import path from 'path';
import { magentoScanRoots } from './scan-roots.ts';
import { XMLParser } from 'fast-xml-parser';

export interface DiPreference {
  forType: string;
  toType: string;
  sourceFile: string;
  area: string;
}

export interface DiPlugin {
  targetType: string;
  pluginType: string;
  pluginName: string;
  /** `undefined` when the `sortOrder` attribute is ABSENT from the `<plugin>`
   * element (Magento applies its own runtime default in that case) -- NEVER
   * defaulted to 0 here, because 0 is itself a real, explicit declared value
   * (see verify-wiring.ts's SORTORDER_DRIFT classification, which must be
   * able to tell "explicitly 0" apart from "not declared at all"). */
  sortOrder: number | undefined;
  disabled: boolean;
  sourceFile: string;
  area: string;
}

export interface DiXmlResult {
  preferences: DiPreference[];
  plugins: DiPlugin[];
}

const AREA_PATTERNS: Array<{ suffix: string; area: string }> = [
  { suffix: 'etc/frontend/di.xml', area: 'frontend' },
  { suffix: 'etc/adminhtml/di.xml', area: 'adminhtml' },
  { suffix: 'etc/webapi_rest/di.xml', area: 'webapi_rest' },
  { suffix: 'etc/webapi_soap/di.xml', area: 'webapi_soap' },
  { suffix: 'etc/di.xml', area: 'global' },
];

function areaFromPath(filePath: string): string {
  for (const { suffix, area } of AREA_PATTERNS) {
    if (filePath.endsWith(suffix)) return area;
  }
  return 'global';
}

export function parseSingleDiXml(xmlContent: string, sourceFile: string, area: string): DiXmlResult {
  const preferences: DiPreference[] = [];
  const plugins: DiPlugin[] = [];

  let parsed: unknown;
  try {
    const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_' });
    parsed = parser.parse(xmlContent);
  } catch {
    return { preferences, plugins };
  }

  if (!parsed || typeof parsed !== 'object') return { preferences, plugins };

  const root = parsed as Record<string, unknown>;
  const config = root['config'] as Record<string, unknown> | undefined;
  if (!config) return { preferences, plugins };

  // Extract preferences
  const prefRaw = config['preference'];
  const prefList: unknown[] = Array.isArray(prefRaw) ? prefRaw : prefRaw != null ? [prefRaw] : [];
  for (const pref of prefList) {
    const p = pref as Record<string, unknown>;
    const forType = p['@_for'] as string | undefined;
    const toType = p['@_type'] as string | undefined;
    if (forType && toType) {
      preferences.push({ forType, toType, sourceFile, area });
    }
  }

  // Extract plugins from type elements
  const typeRaw = config['type'];
  const typeList: unknown[] = Array.isArray(typeRaw) ? typeRaw : typeRaw != null ? [typeRaw] : [];
  for (const typeEl of typeList) {
    const t = typeEl as Record<string, unknown>;
    const targetType = t['@_name'] as string | undefined;
    if (!targetType) continue;

    const pluginRaw = t['plugin'];
    const pluginList: unknown[] = Array.isArray(pluginRaw) ? pluginRaw : pluginRaw != null ? [pluginRaw] : [];
    for (const plug of pluginList) {
      const pl = plug as Record<string, unknown>;
      const pluginType = pl['@_type'] as string | undefined;
      const pluginName = pl['@_name'] as string | undefined;
      const disabled = String(pl['@_disabled'] ?? 'false').toLowerCase() === 'true';

      if (!pluginType || !pluginName || disabled) continue;

      const sortOrder = pl['@_sortOrder'] != null ? Number(pl['@_sortOrder']) : undefined;

      plugins.push({ targetType, pluginType, pluginName, sortOrder, disabled: false, sourceFile, area });
    }
  }

  return { preferences, plugins };
}

async function findDiXmlFiles(dir: string): Promise<string[]> {
  const results: string[] = [];

  async function walk(current: string): Promise<void> {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        // Skip deeply nested dirs that can't contain module etc/ folders
        // but don't skip etc/ or area subdirs
        await walk(full);
      } else if (entry.isFile() && entry.name === 'di.xml') {
        results.push(full);
      }
    }
  }

  await walk(dir);
  return results;
}

export async function parseDiXml(projectRoot: string): Promise<DiXmlResult> {
  const preferences: DiPreference[] = [];
  const plugins: DiPlugin[] = [];

  const searchDirs = magentoScanRoots(projectRoot);

  for (const searchDir of searchDirs) {
    if (!fs.existsSync(searchDir)) continue;

    const files = await findDiXmlFiles(searchDir);
    for (const file of files) {
      // Only process files in etc/ paths
      if (!/\/etc\//.test(file)) continue;

      let content: string;
      try {
        content = fs.readFileSync(file, 'utf-8');
      } catch {
        continue;
      }

      const area = areaFromPath(file);
      const result = parseSingleDiXml(content, file, area);
      preferences.push(...result.preferences);
      plugins.push(...result.plugins);
    }
  }

  return { preferences, plugins };
}
