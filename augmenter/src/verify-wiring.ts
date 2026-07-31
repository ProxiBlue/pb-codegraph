// pb-codegraph: new file (not vendored). `verify-wiring` reconciles the
// augmenter's STATIC edges (di.xml/events.xml parsed at index time, see
// docs/edge-taxonomy.md) against bricklayer's RUNTIME ObjectManager truth
// (ProxiBlue/bricklayer's `mcp` stdio server, spawned as a child process —
// see PROBED FACTS in the task spec). Scope: only the three magento edge
// kinds bricklayer itself exposes a query surface for — `wraps` (plugin-list),
// `observes` (event-list), `preference_for` (preference-list). `renders` and
// `references` (routes/webapi) have no bricklayer-side runtime query and are
// explicitly OUT OF SCOPE for this tool (see usage() in cli.ts).
//
// CHARACTERIZED LIMITATION (2026-07-31, real pps run): both `plugin-list`
// and `preference-list` are PER-TARGET tools (className / interface arg),
// not full-corpus dumps — `preference-list` called with no `interface` arg
// returns only a small curated "common interfaces" sample, not everything
// Magento knows about. Consequently this tool can only discover a runtime
// wraps/preference fact for a target class/interface it ALREADY has at
// least one STATIC fact for (queried via distinctWrapTargets /
// distinctPreferenceInterfaces) — a target with ZERO static rows at all
// (e.g. a plugin/preference wired entirely from an unparsed vendor tree)
// can never surface as MISSING_FROM_GRAPH for that reason alone. `observes`
// does not share this limitation: event-list dumps everything per area.
import fs from 'node:fs';
import path from 'node:path';
import type Database from 'better-sqlite3';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

import { openReadOnlyDb } from '../../mcp/src/db.ts';
import { openWriterDb } from './writer/sqlite-writer.ts';
import { loadRegistryFromPath } from '../../mcp/src/registry.ts';
import { defaultDbPath } from './augment.ts';
import { normalizeFqcn } from './resolvers/node-id.ts';

// --- exit codes --------------------------------------------------------
export const EXIT_VERIFY_OK = 0;
export const EXIT_VERIFY_MISSING_FROM_GRAPH = 1;
export const EXIT_VERIFY_ENV_ERROR = 2;

// --- FQCN <-> qualified_name -------------------------------------------

/**
 * Reverses `resolvers/node-id.ts`'s `fqcnToQualifiedName` (which turns the
 * LAST `\` in a normalized FQCN into `::`): turns the LAST `::` in a
 * codegraph qualified_name back into `\`. A minted `external` node's
 * qualified_name never contains `::` (it's the normalized FQCN verbatim —
 * see node-id.ts resolveClass), so this is a no-op for those, which is
 * exactly right.
 */
export function qualifiedNameToFqcn(qualifiedName: string): string {
  const lastSeparator = qualifiedName.lastIndexOf('::');
  if (lastSeparator === -1) return qualifiedName;
  return `${qualifiedName.slice(0, lastSeparator)}\\${qualifiedName.slice(lastSeparator + 2)}`;
}

function parseMetadata(raw: string | null): Record<string, unknown> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

// --- static facts (read from codegraph SQLite dbs) ----------------------

export interface StaticWrapFact {
  dbLabel: string;
  edgeId: number;
  /** Plugin PHP class (di.xml `<plugin type="...">`) — the `wraps` edge's
   * SOURCE per the shipped di-xml-mapper.ts (`sourceId: pluginNode.id`,
   * `targetId: targetNode.id` — augmenter/src/mappers/di-xml-mapper.ts:88-99).
   * NOTE: docs/edge-taxonomy.md's kind-remap table row for `plugin` reads
   * "target class node → plugin class node" (the opposite), which conflicts
   * with the shipped mapper the same way the doc's preference_for row once
   * did before its own "Direction correction" note — flagging rather than
   * silently picking a side, but the shipped writer's actual on-disk
   * direction is what a real project db contains, so that's authoritative
   * for reconciliation here. */
  pluginFqcn: string;
  targetFqcn: string;
  sortOrder: number | null;
  area: string | null;
}

export interface StaticObserveFact {
  dbLabel: string;
  edgeId: number;
  area: string | null;
  event: string;
  observerFqcn: string;
}

export interface StaticPreferenceFact {
  dbLabel: string;
  edgeId: number;
  /** source = concrete impl class (di-xml-mapper.ts's `implNode`). */
  implFqcn: string;
  /** target = interface/abstract class (di-xml-mapper.ts's `interfaceNode`). */
  interfaceFqcn: string;
  area: string | null;
}

export interface StaticFacts {
  wraps: StaticWrapFact[];
  observes: StaticObserveFact[];
  preferences: StaticPreferenceFact[];
}

interface WrapRow {
  edgeId: number;
  metadata: string | null;
  pluginQn: string;
  targetQn: string;
}
interface ObserveRow {
  edgeId: number;
  metadata: string | null;
  eventName: string;
  observerQn: string;
}
interface PreferenceRow {
  edgeId: number;
  metadata: string | null;
  implQn: string;
  interfaceQn: string;
}

/** Reads every augmenter-owned wraps/observes/preference_for edge out of a
 * single already-open codegraph db, tagged with `dbLabel` so callers can
 * tell which db (project vs. a registry entry) a fact came from — needed
 * both for the cross-db union (CROSS-DB REALITY) and for --stamp, which
 * only ever writes back to the project db. */
export function readStaticFactsFromDb(db: Database.Database, dbLabel: string): StaticFacts {
  const wrapRows = db
    .prepare(
      `SELECT e.id AS edgeId, e.metadata AS metadata, ns.qualified_name AS pluginQn, nt.qualified_name AS targetQn
       FROM edges e
       JOIN nodes ns ON ns.id = e.source
       JOIN nodes nt ON nt.id = e.target
       WHERE e.kind = 'wraps' AND e.provenance = 'pb-codegraph-augmenter'`,
    )
    .all() as WrapRow[];

  const observeRows = db
    .prepare(
      `SELECT e.id AS edgeId, e.metadata AS metadata, ns.name AS eventName, nt.qualified_name AS observerQn
       FROM edges e
       JOIN nodes ns ON ns.id = e.source
       JOIN nodes nt ON nt.id = e.target
       WHERE e.kind = 'observes' AND e.provenance = 'pb-codegraph-augmenter'`,
    )
    .all() as ObserveRow[];

  const preferenceRows = db
    .prepare(
      `SELECT e.id AS edgeId, e.metadata AS metadata, ns.qualified_name AS implQn, nt.qualified_name AS interfaceQn
       FROM edges e
       JOIN nodes ns ON ns.id = e.source
       JOIN nodes nt ON nt.id = e.target
       WHERE e.kind = 'preference_for' AND e.provenance = 'pb-codegraph-augmenter'`,
    )
    .all() as PreferenceRow[];

  const wraps: StaticWrapFact[] = wrapRows.map((r) => {
    const meta = parseMetadata(r.metadata);
    return {
      dbLabel,
      edgeId: r.edgeId,
      pluginFqcn: qualifiedNameToFqcn(r.pluginQn),
      targetFqcn: qualifiedNameToFqcn(r.targetQn),
      sortOrder: typeof meta.sortOrder === 'number' ? meta.sortOrder : meta.sortOrder != null ? Number(meta.sortOrder) : null,
      area: typeof meta.area === 'string' ? meta.area : null,
    };
  });

  const observes: StaticObserveFact[] = observeRows.map((r) => {
    const meta = parseMetadata(r.metadata);
    return {
      dbLabel,
      edgeId: r.edgeId,
      area: typeof meta.area === 'string' ? meta.area : null,
      event: r.eventName,
      observerFqcn: qualifiedNameToFqcn(r.observerQn),
    };
  });

  const preferences: StaticPreferenceFact[] = preferenceRows.map((r) => {
    const meta = parseMetadata(r.metadata);
    return {
      dbLabel,
      edgeId: r.edgeId,
      implFqcn: qualifiedNameToFqcn(r.implQn),
      interfaceFqcn: qualifiedNameToFqcn(r.interfaceQn),
      area: typeof meta.area === 'string' ? meta.area : null,
    };
  });

  return { wraps, observes, preferences };
}

export interface DbSource {
  label: string;
  path: string;
}

/** Project db is always the first source. Registry entries (when
 * --registry is given) are unioned in so core/mage-os/hyva wiring — which
 * lives in ITS OWN db, never the project db (see CROSS-DB REALITY) — is
 * searched too before a runtime fact is declared MISSING_FROM_GRAPH. A
 * registry entry pointing at the exact same file as the project db is
 * skipped (avoids double-counting the same rows under two labels). */
export function resolveDbSources(projectDbPath: string, registryPath?: string): DbSource[] {
  const sources: DbSource[] = [{ label: 'project', path: projectDbPath }];
  if (!registryPath) return sources;

  const registry = loadRegistryFromPath(registryPath);
  const projectResolved = path.resolve(projectDbPath);
  for (const [name, entry] of Object.entries(registry)) {
    if (path.resolve(entry.db_path) === projectResolved) continue;
    sources.push({ label: name, path: entry.db_path });
  }
  return sources;
}

/** Opens every source read-only and merges their static facts. A source
 * that fails to open (unreadable file, unsupported schema — core dbs may be
 * read-only mounts that have gone stale) is loudly skipped, not fatal —
 * only the PROJECT source (source[0]) failing to open is fatal, and that's
 * handled by the caller (runVerifyWiring) before this is ever called. */
export function collectStaticFacts(sources: DbSource[]): StaticFacts {
  const wraps: StaticWrapFact[] = [];
  const observes: StaticObserveFact[] = [];
  const preferences: StaticPreferenceFact[] = [];

  for (const source of sources) {
    let db: Database.Database;
    try {
      db = openReadOnlyDb(source.path);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      console.warn(`[pb-codegraph verify-wiring] skipping db source "${source.label}" (${source.path}): ${reason}`);
      continue;
    }
    try {
      const facts = readStaticFactsFromDb(db, source.label);
      wraps.push(...facts.wraps);
      observes.push(...facts.observes);
      preferences.push(...facts.preferences);
    } finally {
      db.close();
    }
  }

  return { wraps, observes, preferences };
}

export function distinctWrapTargets(wraps: StaticWrapFact[]): string[] {
  return [...new Set(wraps.map((f) => f.targetFqcn))];
}

export function distinctPreferenceInterfaces(preferences: StaticPreferenceFact[]): string[] {
  return [...new Set(preferences.map((f) => f.interfaceFqcn))];
}

// --- runtime facts (bricklayer MCP client) ------------------------------

export const BRICKLAYER_CMD_ENV = 'PB_CODEGRAPH_BRICKLAYER_CMD';
export const DEFAULT_BRICKLAYER_CMD = 'vendor/bin/bricklayer mcp';
/** Per-call timeout — applied to both the initialize handshake and every
 * tools/call. */
export const BRICKLAYER_CALL_TIMEOUT_MS = 60_000;

export class BricklayerUnavailableError extends Error {}

export interface RuntimePluginEntry {
  targetFqcn: string;
  pluginName: string;
  instanceFqcn: string;
  sortOrder: number;
}
export interface RuntimeEventEntry {
  area: string;
  event: string;
  observerName: string;
  classFqcn: string;
}
export interface RuntimePreferenceEntry {
  interfaceFqcn: string;
  implFqcn: string;
}

/** Splits the (env-overridable) bricklayer spawn command on whitespace into
 * `{command, args}`. No quoting support — this is an internal override knob
 * (PB_CODEGRAPH_BRICKLAYER_CMD), not a shell, and both the default
 * ("vendor/bin/bricklayer mcp") and the test fake's override are always
 * plain space-separated tokens with no embedded spaces of their own. */
export function parseBricklayerCommand(raw: string): { command: string; args: string[] } {
  const tokens = raw.trim().split(/\s+/).filter(Boolean);
  const [command, ...args] = tokens;
  return { command: command ?? '', args };
}

export interface BricklayerSession {
  client: Client;
  close: () => Promise<void>;
}

/**
 * Spawns bricklayer's `mcp` stdio server at `projectRoot` (or the
 * PB_CODEGRAPH_BRICKLAYER_CMD override) and completes the MCP handshake
 * (initialize -> notifications/initialized, per the SDK's Client.connect).
 * Always returns a session whose `close()` kills the child process on every
 * path (mirrors StdioClientTransport.close()'s graceful-then-SIGTERM-then-
 * SIGKILL sequence) — callers MUST call close() in a finally block.
 */
export async function openBricklayerSession(
  projectRoot: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<BricklayerSession> {
  const raw = env[BRICKLAYER_CMD_ENV] || DEFAULT_BRICKLAYER_CMD;
  const { command, args } = parseBricklayerCommand(raw);

  const transport = new StdioClientTransport({
    command,
    args,
    cwd: projectRoot,
    env: env as Record<string, string>,
    stderr: 'pipe',
  });

  let stderrBuf = '';
  transport.stderr?.on('data', (chunk: Buffer) => {
    stderrBuf += chunk.toString();
  });

  const client = new Client({ name: 'pb-codegraph-verify-wiring', version: '0.2.0' });

  try {
    await client.connect(transport, { timeout: BRICKLAYER_CALL_TIMEOUT_MS });
  } catch (err) {
    await transport.close().catch(() => {});
    const reason = err instanceof Error ? err.message : String(err);
    throw new BricklayerUnavailableError(
      `pb-codegraph verify-wiring: unable to launch bricklayer via "${raw}" in "${projectRoot}" — ${reason}. ` +
        `Ensure bricklayer is installed at that path (composer require, "vendor/bin/bricklayer") or set ` +
        `${BRICKLAYER_CMD_ENV} to override the spawn command.` +
        (stderrBuf.trim() ? ` stderr: ${stderrBuf.trim()}` : ''),
    );
  }

  return {
    client,
    close: async () => {
      await client.close().catch(() => {});
    },
  };
}

function warnUnrecognizedPayload(tool: string, payload: unknown): void {
  const snippet = JSON.stringify(payload)?.slice(0, 500) ?? String(payload);
  console.warn(
    `[pb-codegraph verify-wiring] "${tool}" returned an unrecognized payload shape — treating as empty rather ` +
      `than silently guessing. Payload (truncated): ${snippet}`,
  );
}

export function parseRuntimePlugins(targetFqcn: string, structuredContent: unknown): RuntimePluginEntry[] {
  if (!structuredContent || typeof structuredContent !== 'object') {
    warnUnrecognizedPayload('plugin-list', structuredContent);
    return [];
  }
  const obj = structuredContent as Record<string, unknown>;
  const plugins = obj.plugins;
  if (!plugins || typeof plugins !== 'object') {
    warnUnrecognizedPayload('plugin-list', structuredContent);
    return [];
  }
  // PHP's empty assoc array (`plugins: []` in di.xml-less config) serializes to JSON `[]`,
  // meaning ZERO plugins for this target -- not an unrecognized payload shape. Warn only on a
  // NON-empty array (a shape bricklayer never actually emits, but still not the expected map).
  if (Array.isArray(plugins)) {
    if (plugins.length > 0) warnUnrecognizedPayload('plugin-list', structuredContent);
    return [];
  }

  const out: RuntimePluginEntry[] = [];
  for (const [pluginName, value] of Object.entries(plugins as Record<string, unknown>)) {
    const entry = (value ?? {}) as Record<string, unknown>;
    const instanceFqcn = typeof entry.instance === 'string' ? entry.instance : '';
    if (!instanceFqcn) continue;
    const sortOrder = typeof entry.sortOrder === 'number' ? entry.sortOrder : Number(entry.sortOrder ?? 0);
    // CHARACTERIZED (pps live run, 2026-07-31): bricklayer sometimes returns a leading "\" on
    // FQCNs; the static side (resolvers/node-id.ts normalizeFqcn) always strips it, so BOTH sides
    // must be normalized identically or a real match double-counts as MISSING + GRAPH_ONLY.
    out.push({ targetFqcn: normalizeFqcn(targetFqcn), pluginName, instanceFqcn: normalizeFqcn(instanceFqcn), sortOrder });
  }
  return out;
}

export function parseRuntimeEvents(area: string, structuredContent: unknown): RuntimeEventEntry[] {
  if (!structuredContent || typeof structuredContent !== 'object') {
    warnUnrecognizedPayload('event-list', structuredContent);
    return [];
  }
  const obj = structuredContent as Record<string, unknown>;
  const events = obj.events;
  if (!Array.isArray(events)) {
    warnUnrecognizedPayload('event-list', structuredContent);
    return [];
  }

  const resolvedArea = typeof obj.area === 'string' ? obj.area : area;
  const out: RuntimeEventEntry[] = [];
  for (const raw of events) {
    const e = (raw ?? {}) as Record<string, unknown>;
    const event = typeof e.event === 'string' ? e.event : '';
    const classFqcn = typeof e.class === 'string' ? e.class : '';
    if (!event || !classFqcn) continue;
    out.push({
      area: resolvedArea,
      event,
      observerName: typeof e.observer === 'string' ? e.observer : '',
      classFqcn: normalizeFqcn(classFqcn), // see parseRuntimePlugins's characterization note
    });
  }
  return out;
}

/**
 * Shape-tolerant. CHARACTERIZED against a real bricklayer (2026-07-31, pps
 * project): `preference-list` called with NO `interface` arg returns only a
 * small curated sample (`{"filter":"common interfaces","count":7,
 * "preferences":[...]}`) — NOT a full dump, contradicting the task spec's
 * "likely a full-dump map" assumption. `preference-list` is per-interface,
 * exactly like `plugin-list` is per-class (see fetchRuntimePreferences,
 * which now calls it once per static interfaceFqcn instead of once total).
 * Real per-interface payload shape: `{filter, count, preferences:
 * [{interface, preference}]}` (pair key is "preference", not "type" —
 * verified via a real call against Magento\Framework\Filesystem\
 * DriverInterface). The map shape `{preferences: {interface: impl}}` this
 * parser originally guessed at is still accepted as a fallback in case a
 * different bricklayer version/config ever emits it — kept for tolerance,
 * not because it's the observed real shape.
 */
export function parseRuntimePreferences(structuredContent: unknown): RuntimePreferenceEntry[] {
  if (!structuredContent || typeof structuredContent !== 'object') {
    warnUnrecognizedPayload('preference-list', structuredContent);
    return [];
  }
  const obj = structuredContent as Record<string, unknown>;
  const prefsRaw = 'preferences' in obj ? obj.preferences : obj;

  if (Array.isArray(prefsRaw)) {
    const out: RuntimePreferenceEntry[] = [];
    for (const raw of prefsRaw) {
      const e = (raw ?? {}) as Record<string, unknown>;
      const interfaceFqcn = (e.interface ?? e.for ?? e.forType) as string | undefined;
      const implFqcn = (e.preference ?? e.type ?? e.implementation ?? e.toType) as string | undefined;
      if (typeof interfaceFqcn === 'string' && typeof implFqcn === 'string') {
        // see parseRuntimePlugins's leading-backslash characterization note
        out.push({ interfaceFqcn: normalizeFqcn(interfaceFqcn), implFqcn: normalizeFqcn(implFqcn) });
      }
    }
    if (out.length === 0 && prefsRaw.length > 0) warnUnrecognizedPayload('preference-list', structuredContent);
    return out;
  }

  if (prefsRaw && typeof prefsRaw === 'object') {
    return Object.entries(prefsRaw as Record<string, unknown>)
      .filter((entry): entry is [string, string] => typeof entry[1] === 'string')
      .map(([interfaceFqcn, implFqcn]) => ({ interfaceFqcn: normalizeFqcn(interfaceFqcn), implFqcn: normalizeFqcn(implFqcn) }));
  }

  warnUnrecognizedPayload('preference-list', structuredContent);
  return [];
}

// bricklayer's validAreas set can vary by version -- 'crontab'/'graphql'/'webapi_rest'/
// 'webapi_soap' are queried best-effort (see fetchRuntimeEvents's per-area tolerance) and never
// abort the whole fetch if a given bricklayer install doesn't recognize one of them.
export const EVENT_LIST_AREAS = ['global', 'frontend', 'adminhtml', 'webapi_rest', 'webapi_soap', 'crontab', 'graphql'] as const;

export async function fetchRuntimePlugins(client: Client, targetFqcn: string): Promise<RuntimePluginEntry[]> {
  const result = await client.callTool(
    { name: 'plugin-list', arguments: { className: targetFqcn } },
    undefined,
    { timeout: BRICKLAYER_CALL_TIMEOUT_MS },
  );
  return parseRuntimePlugins(targetFqcn, result.structuredContent);
}

export interface FetchRuntimeEventsIO {
  error: (msg: string) => void;
}

const defaultFetchRuntimeEventsIO: FetchRuntimeEventsIO = { error: (msg) => console.warn(msg) };

/**
 * Queries every EVENT_LIST_AREAS area. bricklayer's set of `validAreas` can vary by version --
 * an individual area call failing (unrecognized area, etc.) is noted via `io.error` and skipped,
 * never aborts the whole fetch (the other areas' real data is still worth having).
 */
export async function fetchRuntimeEvents(client: Client, io: FetchRuntimeEventsIO = defaultFetchRuntimeEventsIO): Promise<RuntimeEventEntry[]> {
  const all: RuntimeEventEntry[] = [];
  for (const area of EVENT_LIST_AREAS) {
    try {
      const result = await client.callTool({ name: 'event-list', arguments: { area } }, undefined, {
        timeout: BRICKLAYER_CALL_TIMEOUT_MS,
      });
      // A tool-level failure (bricklayer throwing inside its own handler, e.g. an unrecognized
      // area) surfaces as a normal MCP response with isError:true, NOT a thrown/rejected call —
      // see the SDK's McpServer.createToolError. Must be checked explicitly, not just try/catch.
      if (result.isError) {
        const reason = Array.isArray(result.content)
          ? result.content.map((c) => ('text' in c ? c.text : JSON.stringify(c))).join(' ')
          : String(result.content);
        io.error(
          `[pb-codegraph verify-wiring] event-list area "${area}" failed — skipping (bricklayer may not ` +
            `support this area on this version): ${reason}`,
        );
        continue;
      }
      all.push(...parseRuntimeEvents(area, result.structuredContent));
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      io.error(
        `[pb-codegraph verify-wiring] event-list area "${area}" failed — skipping (bricklayer may not ` +
          `support this area on this version): ${reason}`,
      );
    }
  }
  return all;
}

/** Per-interface call (see parseRuntimePreferences's characterization note
 * — a no-args call only returns a small "common interfaces" sample, not a
 * full dump), mirroring fetchRuntimePlugins's per-target-class pattern. */
export async function fetchRuntimePreferences(client: Client, interfaceFqcn: string): Promise<RuntimePreferenceEntry[]> {
  const result = await client.callTool(
    { name: 'preference-list', arguments: { interface: interfaceFqcn } },
    undefined,
    { timeout: BRICKLAYER_CALL_TIMEOUT_MS },
  );
  return parseRuntimePreferences(result.structuredContent);
}

// --- reconciliation ------------------------------------------------------

function factKey(parts: Array<string | number | null | undefined>): string {
  return parts.map((p) => String(p ?? '')).join('\u0000');
}

export interface WrapsMatch {
  targetFqcn: string;
  pluginFqcn: string;
  sortOrder: number;
}
export interface WrapsDrift {
  targetFqcn: string;
  pluginFqcn: string;
  graphSortOrder: number | null;
  runtimeSortOrder: number;
}
export interface WrapsReconciliation {
  matched: WrapsMatch[];
  sortOrderDrift: WrapsDrift[];
  missingFromGraph: RuntimePluginEntry[];
  graphOnly: StaticWrapFact[];
}

/** MATCHED requires both sides agree the plugin wraps the target; a
 * sortOrder mismatch demotes a would-be match to SORTORDER_DRIFT instead
 * (still "both sides know about this wiring", just disagreeing on order). */
export function reconcileWraps(staticFacts: StaticWrapFact[], runtimeFacts: RuntimePluginEntry[]): WrapsReconciliation {
  const staticByKey = new Map<string, StaticWrapFact[]>();
  for (const fact of staticFacts) {
    const key = factKey([fact.targetFqcn, fact.pluginFqcn]);
    const bucket = staticByKey.get(key);
    if (bucket) bucket.push(fact);
    else staticByKey.set(key, [fact]);
  }

  const matchedKeys = new Set<string>();
  const matched: WrapsMatch[] = [];
  const sortOrderDrift: WrapsDrift[] = [];
  const missingFromGraph: RuntimePluginEntry[] = [];

  for (const runtimeFact of runtimeFacts) {
    const key = factKey([runtimeFact.targetFqcn, runtimeFact.instanceFqcn]);
    const staticMatches = staticByKey.get(key);
    if (!staticMatches || staticMatches.length === 0) {
      missingFromGraph.push(runtimeFact);
      continue;
    }
    matchedKeys.add(key);
    // An ABSENT graph sortOrder (di.xml `<plugin>` with no `sortOrder`
    // attribute -- see di-xml.ts) must never be treated as drift: `null`
    // means "no declaration to disagree with runtime", not "declared 0".
    // Only an EXPLICIT graph sortOrder that disagrees with runtime counts
    // as SORTORDER_DRIFT (found via verify-wiring on real pps data,
    // 2026-07-31 -- GrandTotalDetailsPlugin flagged graph 0 vs runtime 1,
    // where the graph "0" was this parser's own former default-fill, not a
    // declaration).
    const sortOrderAgrees = staticMatches.some((f) => f.sortOrder == null || f.sortOrder === runtimeFact.sortOrder);
    if (sortOrderAgrees) {
      matched.push({ targetFqcn: runtimeFact.targetFqcn, pluginFqcn: runtimeFact.instanceFqcn, sortOrder: runtimeFact.sortOrder });
    } else {
      sortOrderDrift.push({
        targetFqcn: runtimeFact.targetFqcn,
        pluginFqcn: runtimeFact.instanceFqcn,
        graphSortOrder: staticMatches[0].sortOrder,
        runtimeSortOrder: runtimeFact.sortOrder,
      });
    }
  }

  const graphOnly = staticFacts.filter((fact) => !matchedKeys.has(factKey([fact.targetFqcn, fact.pluginFqcn])));

  return { matched, sortOrderDrift, missingFromGraph, graphOnly };
}

export interface ObservesMatch {
  area: string | null;
  event: string;
  observerFqcn: string;
}
export interface ObservesReconciliation {
  matched: ObservesMatch[];
  missingFromGraph: RuntimeEventEntry[];
  graphOnly: StaticObserveFact[];
}

/**
 * Magento's runtime event-list(area=X) MERGES `global`-scoped observers into
 * every area's result set (real Magento semantics: a global observer fires in
 * every area, not just "global" requests) -- so a runtime fact for a
 * global-declared observer can be reported tagged under ANY queried area
 * (frontend/adminhtml/...), not just "global" (found via verify-wiring on
 * real pps data, 2026-07-31). A `global` graph edge must therefore match a
 * runtime fact reported under any area; an area-specific graph edge
 * (frontend/adminhtml/...) still matches only its own area -- Magento does
 * NOT merge area-scoped observers into other areas.
 */
export function reconcileObserves(
  staticFacts: StaticObserveFact[],
  runtimeFacts: RuntimeEventEntry[],
): ObservesReconciliation {
  const staticExactKeys = new Set(staticFacts.map((f) => factKey([f.area, f.event, f.observerFqcn])));
  const globalStaticKeys = new Set(
    staticFacts.filter((f) => f.area === 'global').map((f) => factKey([f.event, f.observerFqcn])),
  );

  const matchedExactKeys = new Set<string>();
  const matchedGlobalKeys = new Set<string>();
  const matched: ObservesMatch[] = [];
  const missingFromGraph: RuntimeEventEntry[] = [];

  for (const runtimeFact of runtimeFacts) {
    const exactKey = factKey([runtimeFact.area, runtimeFact.event, runtimeFact.classFqcn]);
    const globalKey = factKey([runtimeFact.event, runtimeFact.classFqcn]);
    const hasGlobalStatic = globalStaticKeys.has(globalKey);

    if (staticExactKeys.has(exactKey)) {
      matchedExactKeys.add(exactKey);
      // The runtime fact may exactly match a `global` static fact reported
      // back under its own "global" area (e.g. the direct area=global
      // query) -- that also covers it for the graphOnly check below, which
      // only ever looks at matchedGlobalKeys for `global` static facts.
      if (hasGlobalStatic) matchedGlobalKeys.add(globalKey);
      matched.push({ area: runtimeFact.area, event: runtimeFact.event, observerFqcn: runtimeFact.classFqcn });
    } else if (hasGlobalStatic) {
      // Covered by a `global` static fact reported under a different
      // (merged) area -- e.g. graph area=global, runtime area=adminhtml.
      matchedGlobalKeys.add(globalKey);
      matched.push({ area: runtimeFact.area, event: runtimeFact.event, observerFqcn: runtimeFact.classFqcn });
    } else {
      missingFromGraph.push(runtimeFact);
    }
  }

  const graphOnly = staticFacts.filter((f) => {
    if (f.area === 'global') return !matchedGlobalKeys.has(factKey([f.event, f.observerFqcn]));
    return !matchedExactKeys.has(factKey([f.area, f.event, f.observerFqcn]));
  });

  return { matched, missingFromGraph, graphOnly };
}

export interface PreferencesMatch {
  interfaceFqcn: string;
  implFqcn: string;
  /** true when the match only succeeded after stripping a trailing `\Interceptor` segment off
   * the runtime implFqcn (see stripInterceptorSuffix) -- implFqcn above is still the RAW
   * (un-stripped) runtime name, so the report can show what runtime actually returned while
   * noting how it was reconciled. */
  viaInterceptorNormalization?: boolean;
}
export interface PreferencesReconciliation {
  matched: PreferencesMatch[];
  missingFromGraph: RuntimePreferenceEntry[];
  graphOnly: StaticPreferenceFact[];
}

const INTERCEPTOR_SUFFIX = '\\Interceptor';

/**
 * A Magento-generated interceptor (`<Class>\Interceptor`) is a 1:1 runtime wrapper of the
 * class it intercepts -- di.xml declares (and the static graph records) the plain class, but
 * runtime's preference-list reports the generated interceptor FQCN once a plugin is attached to
 * that class. Stripping ONE trailing `\Interceptor` segment recovers the class the static side
 * actually knows about. Only ONE segment is ever stripped -- Magento never nests interceptors.
 */
function stripInterceptorSuffix(fqcn: string): { stripped: string; wasStripped: boolean } {
  if (fqcn.endsWith(INTERCEPTOR_SUFFIX)) {
    return { stripped: fqcn.slice(0, -INTERCEPTOR_SUFFIX.length), wasStripped: true };
  }
  return { stripped: fqcn, wasStripped: false };
}

export function reconcilePreferences(
  staticFacts: StaticPreferenceFact[],
  runtimeFacts: RuntimePreferenceEntry[],
): PreferencesReconciliation {
  const staticKeys = new Set(staticFacts.map((f) => factKey([f.interfaceFqcn, f.implFqcn])));
  const matchedKeys = new Set<string>();
  const matched: PreferencesMatch[] = [];
  const missingFromGraph: RuntimePreferenceEntry[] = [];

  for (const runtimeFact of runtimeFacts) {
    const exactKey = factKey([runtimeFact.interfaceFqcn, runtimeFact.implFqcn]);
    if (staticKeys.has(exactKey)) {
      matchedKeys.add(exactKey);
      matched.push({ interfaceFqcn: runtimeFact.interfaceFqcn, implFqcn: runtimeFact.implFqcn });
      continue;
    }

    const { stripped, wasStripped } = stripInterceptorSuffix(runtimeFact.implFqcn);
    const interceptorKey = wasStripped ? factKey([runtimeFact.interfaceFqcn, stripped]) : null;
    if (interceptorKey && staticKeys.has(interceptorKey)) {
      matchedKeys.add(interceptorKey);
      matched.push({
        interfaceFqcn: runtimeFact.interfaceFqcn,
        implFqcn: runtimeFact.implFqcn, // raw (un-stripped) name kept for the report
        viaInterceptorNormalization: true,
      });
      continue;
    }

    missingFromGraph.push(runtimeFact);
  }

  const graphOnly = staticFacts.filter((f) => !matchedKeys.has(factKey([f.interfaceFqcn, f.implFqcn])));

  return { matched, missingFromGraph, graphOnly };
}

// --- --stamp: mark GRAPH_ONLY edges disabled-in-env, project db only -----

/**
 * Updates `metadata.enabled_in_env = false` on the given edge ids, inside a
 * single transaction, restricted to rows that (a) exist and (b) still carry
 * provenance='pb-codegraph-augmenter' — belt-and-braces on top of the
 * caller only ever passing ids sourced from a provenance-filtered SELECT
 * (readStaticFactsFromDb). Caller is responsible for only ever passing a
 * writable connection to the PROJECT db — this function has no way to know
 * "project" vs "registry" itself.
 */
export function stampGraphOnlyEdges(db: Database.Database, edgeIds: number[]): number {
  if (edgeIds.length === 0) return 0;
  const selectStmt = db.prepare(`SELECT id, metadata FROM edges WHERE id = ? AND provenance = 'pb-codegraph-augmenter'`);
  const updateStmt = db.prepare(`UPDATE edges SET metadata = ? WHERE id = ?`);

  const run = db.transaction((ids: number[]): number => {
    let updated = 0;
    for (const id of ids) {
      const row = selectStmt.get(id) as { id: number; metadata: string | null } | undefined;
      if (!row) continue;
      const metadata = parseMetadata(row.metadata);
      metadata.enabled_in_env = false;
      updateStmt.run(JSON.stringify(metadata), id);
      updated++;
    }
    return updated;
  });

  return run(edgeIds);
}

// --- compiled DI detection --------------------------------------------------

/**
 * Detects Magento's compiled DI cache (`bin/magento setup:di:compile` output) under
 * `<project-root>/generated/metadata/*plugin-list.php`. bricklayer's PluginList reflection tool
 * uses this compiled data VERBATIM when present -- a class outside the compiled set (never
 * referenced from a compiled entry point) returns no plugins ([]) from bricklayer regardless of
 * what di.xml actually declares for it. When this is detected, the wraps section of a
 * verify-wiring report is non-authoritative: static-only ("graph-only") wraps rows may simply be
 * classes the compiler never touched, not real drift. Remove `generated/metadata` (dev mode) to
 * restore full runtime verification -- note that Magento itself also serves stale DI info from
 * this cache while it exists, so this affects more than just this tool.
 */
export function detectCompiledDi(projectRoot: string): boolean {
  const metadataDir = path.join(projectRoot, 'generated', 'metadata');
  let entries: string[];
  try {
    entries = fs.readdirSync(metadataDir);
  } catch {
    return false;
  }
  return entries.some((name) => name.endsWith('plugin-list.php'));
}

// --- report formatting ----------------------------------------------------

export interface VerifyWiringSummary {
  matched: number;
  missingFromGraph: number;
  graphOnly: number;
  sortOrderDrift: number;
}

export interface VerifyWiringReport {
  text: string;
  summary: VerifyWiringSummary;
}

function stampedSuffix(stamp: boolean, dbLabel: string): string {
  return stamp && dbLabel === 'project' ? ' (stamped enabled_in_env=false)' : '';
}

const COMPILED_DI_BANNER = [
  '*** COMPILED DI DETECTED (generated/metadata/*plugin-list.php present) ***',
  '*** bricklayer\'s runtime plugin data reflects the COMPILED set only -- a class outside the',
  '*** compiled set returns no plugins ([]) regardless of what di.xml declares for it. The wraps',
  '*** section below is NON-AUTHORITATIVE while compiled DI is present. Remove generated/metadata',
  '*** to restore full verification (dev-mode-with-metadata also means Magento itself serves stale',
  '*** DI, not just this tool).',
];

export function formatVerifyWiringReport(input: {
  preferences: PreferencesReconciliation;
  wraps: WrapsReconciliation;
  observes: ObservesReconciliation;
  stamp: boolean;
  /** true when `<project-root>/generated/metadata/*plugin-list.php` was detected (see
   * detectCompiledDi) -- makes the wraps section's findings non-authoritative. */
  compiledDiDetected?: boolean;
}): VerifyWiringReport {
  const { preferences, wraps, observes, stamp, compiledDiDetected = false } = input;
  const lines: string[] = [];

  lines.push('=== pb-codegraph verify-wiring report ===');
  lines.push('(scope: preference_for, wraps, observes only — renders/references(routes) are out of scope)');
  lines.push('');

  if (compiledDiDetected) {
    lines.push(...COMPILED_DI_BANNER);
    lines.push('');
  }

  lines.push(
    `-- preference_for: ${preferences.matched.length} matched, ${preferences.missingFromGraph.length} missing-from-graph, ` +
      `${preferences.graphOnly.length} graph-only --`,
  );
  for (const m of preferences.matched) {
    const note = m.viaInterceptorNormalization ? ' (matched via interceptor normalization)' : '';
    lines.push(`  MATCHED     ${m.implFqcn} -> ${m.interfaceFqcn}${note}`);
  }
  for (const m of preferences.missingFromGraph) {
    lines.push(`  MISSING     ${m.implFqcn} -> ${m.interfaceFqcn} (runtime only — no db has this preference)`);
  }
  for (const m of preferences.graphOnly) {
    lines.push(`  GRAPH-ONLY  ${m.implFqcn} -> ${m.interfaceFqcn} [${m.dbLabel}]${stampedSuffix(stamp, m.dbLabel)}`);
  }
  lines.push('');

  const wrapsAuthoritySuffix = compiledDiDetected ? ' [non-authoritative (compiled DI present)]' : '';
  lines.push(
    `-- wraps: ${wraps.matched.length} matched, ${wraps.sortOrderDrift.length} sortorder-drift, ` +
      `${wraps.missingFromGraph.length} missing-from-graph, ${wraps.graphOnly.length} graph-only --${wrapsAuthoritySuffix}`,
  );
  for (const m of wraps.matched) lines.push(`  MATCHED     ${m.pluginFqcn} wraps ${m.targetFqcn} (sortOrder ${m.sortOrder})`);
  for (const m of wraps.sortOrderDrift) {
    lines.push(
      `  DRIFT       ${m.pluginFqcn} wraps ${m.targetFqcn} — graph sortOrder ${m.graphSortOrder ?? 'n/a'} != runtime ${m.runtimeSortOrder}`,
    );
  }
  for (const m of wraps.missingFromGraph) {
    lines.push(`  MISSING     ${m.instanceFqcn} wraps ${m.targetFqcn} (runtime only, plugin name "${m.pluginName}")`);
  }
  for (const m of wraps.graphOnly) {
    lines.push(`  GRAPH-ONLY  ${m.pluginFqcn} wraps ${m.targetFqcn} [${m.dbLabel}]${stampedSuffix(stamp, m.dbLabel)}`);
  }
  lines.push('');

  lines.push(
    `-- observes: ${observes.matched.length} matched, ${observes.missingFromGraph.length} missing-from-graph, ` +
      `${observes.graphOnly.length} graph-only --`,
  );
  for (const m of observes.matched) lines.push(`  MATCHED     ${m.observerFqcn} observes ${m.event} [${m.area ?? 'unknown'}]`);
  for (const m of observes.missingFromGraph) {
    lines.push(
      `  MISSING     ${m.classFqcn} observes ${m.event} [${m.area}] (runtime only, observer name "${m.observerName}")`,
    );
  }
  for (const m of observes.graphOnly) {
    lines.push(`  GRAPH-ONLY  ${m.observerFqcn} observes ${m.event} [${m.area ?? 'unknown'}] [${m.dbLabel}]${stampedSuffix(stamp, m.dbLabel)}`);
  }
  lines.push('');

  // While compiled DI is present, wraps GRAPH-ONLY rows are not a real failure signal (they may
  // simply be classes the compiler never touched -- see detectCompiledDi) so they're excluded
  // from the rolled-up summary total, even though they're still printed above for visibility.
  const wrapsGraphOnlyForSummary = compiledDiDetected ? 0 : wraps.graphOnly.length;

  const summary: VerifyWiringSummary = {
    matched: preferences.matched.length + wraps.matched.length + observes.matched.length,
    missingFromGraph: preferences.missingFromGraph.length + wraps.missingFromGraph.length + observes.missingFromGraph.length,
    graphOnly: preferences.graphOnly.length + wrapsGraphOnlyForSummary + observes.graphOnly.length,
    sortOrderDrift: wraps.sortOrderDrift.length,
  };

  lines.push(
    `verify-wiring: ${summary.matched} matched, ${summary.missingFromGraph} missing-from-graph, ` +
      `${summary.graphOnly} graph-only, ${summary.sortOrderDrift} sortorder-drift`,
  );

  return { text: lines.join('\n'), summary };
}

// --- orchestration ---------------------------------------------------------

export interface VerifyWiringOptions {
  projectRoot: string;
  dbPath?: string;
  registryPath?: string;
  stamp: boolean;
}

export interface VerifyWiringIO {
  log: (msg: string) => void;
  error: (msg: string) => void;
}

/**
 * Runs the full verify-wiring pipeline: read static facts from the project
 * db (+ registry union), spawn bricklayer, fetch runtime facts, reconcile,
 * optionally stamp GRAPH_ONLY project-db edges, print the report. Returns
 * the process exit code (never calls process.exit — mirrors cli.ts's
 * `main`).
 */
export async function runVerifyWiring(options: VerifyWiringOptions, io: VerifyWiringIO): Promise<number> {
  const projectDbPath = options.dbPath ?? defaultDbPath(options.projectRoot);

  if (!fs.existsSync(projectDbPath)) {
    io.error(
      `pb-codegraph verify-wiring: codegraph db not found at "${projectDbPath}" — ` +
        `run "pb-codegraph index ${options.projectRoot}" (and "pb-codegraph augment") first.`,
    );
    return EXIT_VERIFY_ENV_ERROR;
  }

  let sources: DbSource[];
  try {
    sources = resolveDbSources(projectDbPath, options.registryPath);
  } catch (err) {
    io.error(`pb-codegraph verify-wiring: ${err instanceof Error ? err.message : String(err)}`);
    return EXIT_VERIFY_ENV_ERROR;
  }

  const staticFacts = collectStaticFacts(sources);

  let session: BricklayerSession;
  try {
    session = await openBricklayerSession(options.projectRoot);
  } catch (err) {
    io.error(err instanceof Error ? err.message : String(err));
    return EXIT_VERIFY_ENV_ERROR;
  }

  try {
    let runtimeEvents: RuntimeEventEntry[];
    const runtimePlugins: RuntimePluginEntry[] = [];
    const runtimePreferences: RuntimePreferenceEntry[] = [];
    try {
      runtimeEvents = await fetchRuntimeEvents(session.client, { error: io.error });
      for (const target of distinctWrapTargets(staticFacts.wraps)) {
        runtimePlugins.push(...(await fetchRuntimePlugins(session.client, target)));
      }
      for (const interfaceFqcn of distinctPreferenceInterfaces(staticFacts.preferences)) {
        runtimePreferences.push(...(await fetchRuntimePreferences(session.client, interfaceFqcn)));
      }
    } catch (err) {
      io.error(
        `pb-codegraph verify-wiring: bricklayer call failed — ${err instanceof Error ? err.message : String(err)}`,
      );
      return EXIT_VERIFY_ENV_ERROR;
    }

    const wraps = reconcileWraps(staticFacts.wraps, runtimePlugins);
    const observes = reconcileObserves(staticFacts.observes, runtimeEvents);
    const preferences = reconcilePreferences(staticFacts.preferences, runtimePreferences);

    if (options.stamp) {
      const graphOnlyProjectEdgeIds = [
        ...preferences.graphOnly.filter((f) => f.dbLabel === 'project').map((f) => f.edgeId),
        ...wraps.graphOnly.filter((f) => f.dbLabel === 'project').map((f) => f.edgeId),
        ...observes.graphOnly.filter((f) => f.dbLabel === 'project').map((f) => f.edgeId),
      ];
      const projectDb = openWriterDb(projectDbPath);
      try {
        stampGraphOnlyEdges(projectDb, graphOnlyProjectEdgeIds);
      } finally {
        projectDb.close();
      }
    }

    const compiledDiDetected = detectCompiledDi(options.projectRoot);
    const report = formatVerifyWiringReport({ preferences, wraps, observes, stamp: options.stamp, compiledDiDetected });
    io.log(report.text);

    return report.summary.missingFromGraph === 0 ? EXIT_VERIFY_OK : EXIT_VERIFY_MISSING_FROM_GRAPH;
  } finally {
    await session.close();
  }
}

// --- CLI argument parsing --------------------------------------------------

export function parseVerifyWiringArgs(argv: string[]): VerifyWiringOptions | null {
  const [projectRootArg, ...rest] = argv;
  if (!projectRootArg) return null;

  const projectRoot = path.resolve(projectRootArg);
  let dbPath: string | undefined;
  let registryPath: string | undefined;
  let stamp = false;

  for (let i = 0; i < rest.length; i++) {
    const token = rest[i];
    if (token === '--db') {
      const value = rest[++i];
      if (!value) return null;
      dbPath = path.resolve(value);
    } else if (token === '--registry') {
      const value = rest[++i];
      if (!value) return null;
      registryPath = path.resolve(value);
    } else if (token === '--stamp') {
      stamp = true;
    } else {
      return null;
    }
  }

  return { projectRoot, dbPath, registryPath, stamp };
}
