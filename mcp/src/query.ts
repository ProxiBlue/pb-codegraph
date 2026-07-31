// query MCP tool logic (task 007): named, parameterized SQL templates —
// NOT raw SQL passthrough (see .claude/code-standards.md). Every template
// below is a fixed prepared statement; the only caller-controlled input is
// bound query params, never SQL text. See docs/query-cookbook.md for the
// mapping from each template to the old GitNexus cypher pattern it
// replaces.
import type Database from 'better-sqlite3';
import { openReadOnlyDb } from './db.ts';
import type { Registry } from './registry.ts';
import { resolveSymbolNode, NODE_COLUMNS, type ResolvedNode } from './resolve-symbol.ts';
import { PROVENANCE } from '../../augmenter/src/writer/sqlite-writer.ts';

export const QUERY_TEMPLATE_NAMES = [
  'callers_of',
  'wired_plugins_on',
  'observers_of_event',
  'routes_to',
  'preferences_for',
  'dead_symbols',
] as const;
export type QueryTemplateName = (typeof QUERY_TEMPLATE_NAMES)[number];

// Hard cap on returned rows per repo — "no silent truncation" (code
// standards): when more rows exist than this, `truncated` + `total_matches`
// make the cap loud rather than silently dropping rows.
export const QUERY_RESULT_CAP = 100;

// Native edge kinds a "who calls/uses this symbol" query considers — see
// task 007 description ("native kinds (calls/instantiates/references/
// imports)"). provenance IS NULL restricts this to codegraph-native rows,
// so it never conflates with the augmenter's own `references` kind (webapi/
// routes wiring reuses the `references` name — see docs/edge-taxonomy.md).
const NATIVE_CALL_LIKE_KINDS = ['calls', 'instantiates', 'references', 'imports'] as const;

// Symbol kinds dead_symbols considers as "candidate" dead code. Minted
// magento node kinds are intentionally excluded (an unreferenced route/
// template/event node is not "dead code" in the same sense).
const DEAD_SYMBOL_CANDIDATE_KINDS = ['class', 'interface', 'method'] as const;

export type QueryDirection = 'outgoing' | 'incoming';

export interface QueryNode {
  repo: string;
  id: string;
  kind: string;
  name: string;
  qualified_name: string;
  file_path: string;
  start_line: number;
  end_line: number;
  signature: string | null;
}

export interface QueryResultRow {
  direction: QueryDirection;
  edge_kind: string;
  metadata: Record<string, unknown> | null;
  node: QueryNode;
}

export interface QueryRepoResult {
  repo: string;
  rows: QueryResultRow[];
  truncated: boolean;
  total_matches: number;
}

export interface RepoQueryError {
  repo: string;
  error: string;
}

export interface RunQueryOptions {
  template: QueryTemplateName;
  params: Record<string, unknown>;
  repo?: string;
}

export interface RunQueryResult {
  template: QueryTemplateName;
  params: Record<string, unknown>;
  results: QueryRepoResult[];
  errors: RepoQueryError[];
}

class QueryValidationError extends Error {}

function requireStringParam(params: Record<string, unknown>, key: string, template: string): string {
  const value = params[key];
  if (typeof value !== 'string' || value.length === 0) {
    throw new QueryValidationError(
      `pb-codegraph: query template "${template}" requires a non-empty string param "${key}" ` +
        `(got ${JSON.stringify(value)}). See docs/query-cookbook.md for this template's expected params.`,
    );
  }
  return value;
}

interface EdgeJoinRow {
  direction: QueryDirection;
  edge_kind: string;
  metadata: string | null;
  n_id: string;
  n_kind: string;
  n_name: string;
  n_qualified_name: string;
  n_file_path: string;
  n_start_line: number;
  n_end_line: number;
  n_signature: string | null;
}

function toQueryNode(repo: string, row: EdgeJoinRow): QueryNode {
  return {
    repo,
    id: row.n_id,
    kind: row.n_kind,
    name: row.n_name,
    qualified_name: row.n_qualified_name,
    file_path: row.n_file_path,
    start_line: row.n_start_line,
    end_line: row.n_end_line,
    signature: row.n_signature,
  };
}

function toRows(repo: string, edgeRows: EdgeJoinRow[]): QueryResultRow[] {
  return edgeRows.map((row) => ({
    direction: row.direction,
    edge_kind: row.edge_kind,
    metadata: row.metadata ? (JSON.parse(row.metadata) as Record<string, unknown>) : null,
    node: toQueryNode(repo, row),
  }));
}

function resolveOrThrow(db: Database.Database, symbol: string, template: string): ResolvedNode {
  const node = resolveSymbolNode(db, symbol);
  if (!node) {
    throw new QueryValidationError(
      `pb-codegraph: query template "${template}" could not resolve symbol "${symbol}" in this repo`,
    );
  }
  return node;
}

/**
 * callers_of: who calls/references/imports/instantiates this symbol —
 * incoming NATIVE edges only (see NATIVE_CALL_LIKE_KINDS). Maps to the old
 * GitNexus `MATCH (caller)-[:CALLS|REFERENCES]->(target {id: $id})` cypher
 * pattern (see docs/query-cookbook.md).
 */
function callersOf(db: Database.Database, params: Record<string, unknown>): EdgeJoinRow[] {
  const symbol = requireStringParam(params, 'symbol', 'callers_of');
  const target = resolveOrThrow(db, symbol, 'callers_of');
  const placeholders = NATIVE_CALL_LIKE_KINDS.map(() => '?').join(', ');
  return db
    .prepare(
      `SELECT 'incoming' AS direction, e.kind AS edge_kind, e.metadata AS metadata,
              n.id AS n_id, n.kind AS n_kind, n.name AS n_name, n.qualified_name AS n_qualified_name,
              n.file_path AS n_file_path, n.start_line AS n_start_line, n.end_line AS n_end_line,
              n.signature AS n_signature
       FROM edges e JOIN nodes n ON n.id = e.source
       WHERE e.target = ? AND e.provenance IS NULL AND e.kind IN (${placeholders})
       ORDER BY n.qualified_name`,
    )
    .all(target.id, ...NATIVE_CALL_LIKE_KINDS) as EdgeJoinRow[];
}

/**
 * wired_plugins_on: the plugin class(es) di.xml wires onto this target
 * class/method. Maps to the old GitNexus
 * `MATCH (target)-[:WRAPPED_BY]->(plugin)` cypher pattern.
 */
function wiredPluginsOn(db: Database.Database, params: Record<string, unknown>): EdgeJoinRow[] {
  const symbol = requireStringParam(params, 'symbol', 'wired_plugins_on');
  const target = resolveOrThrow(db, symbol, 'wired_plugins_on');
  return db
    .prepare(
      `SELECT 'outgoing' AS direction, e.kind AS edge_kind, e.metadata AS metadata,
              n.id AS n_id, n.kind AS n_kind, n.name AS n_name, n.qualified_name AS n_qualified_name,
              n.file_path AS n_file_path, n.start_line AS n_start_line, n.end_line AS n_end_line,
              n.signature AS n_signature
       FROM edges e JOIN nodes n ON n.id = e.target
       WHERE e.source = ? AND e.kind = 'wraps' AND e.provenance = ?
       ORDER BY n.qualified_name`,
    )
    .all(target.id, PROVENANCE) as EdgeJoinRow[];
}

/**
 * observers_of_event: observer class(es) events.xml wires onto a named
 * event. Params: { event: "<event name>" } — resolves the minted event
 * node (id `magento:event:<name>` or a node with kind='event' matching
 * name/id exactly). Maps to the old GitNexus
 * `MATCH (e:Event {name: $name})-[:OBSERVED_BY]->(observer)` cypher
 * pattern. See task 007 C4 scope note: this is the ONLY supported way to
 * reach observers by event name — there is no PHP dispatch-site -> event
 * edge in v0.2.
 */
function observersOfEvent(db: Database.Database, params: Record<string, unknown>): EdgeJoinRow[] {
  const event = requireStringParam(params, 'event', 'observers_of_event');
  const eventNode = db
    .prepare(`SELECT id FROM nodes WHERE kind = 'event' AND (id = ? OR name = ?) LIMIT 1`)
    .get(`magento:event:${event}`, event) as { id: string } | undefined;
  if (!eventNode) {
    throw new QueryValidationError(
      `pb-codegraph: query template "observers_of_event" found no event node for "${event}" in this repo`,
    );
  }
  return db
    .prepare(
      `SELECT 'outgoing' AS direction, e.kind AS edge_kind, e.metadata AS metadata,
              n.id AS n_id, n.kind AS n_kind, n.name AS n_name, n.qualified_name AS n_qualified_name,
              n.file_path AS n_file_path, n.start_line AS n_start_line, n.end_line AS n_end_line,
              n.signature AS n_signature
       FROM edges e JOIN nodes n ON n.id = e.target
       WHERE e.source = ? AND e.kind = 'observes' AND e.provenance = ?
       ORDER BY n.qualified_name`,
    )
    .all(eventNode.id, PROVENANCE) as EdgeJoinRow[];
}

/**
 * routes_to: the service/controller class(es) wired to a named minted route
 * (webapi.xml `<route url="...">` or routes.xml `<route id="...">`).
 * Params: { route: "<route path or id>" }. Endpoint direction per
 * docs/edge-taxonomy.md: class node is the source, route node is the
 * target — so this resolves the route node then walks INCOMING `references`
 * edges. Maps to the old GitNexus
 * `MATCH (svc)-[:HANDLES_ROUTE]->(r:Route {path: $path})` cypher pattern.
 */
function routesTo(db: Database.Database, params: Record<string, unknown>): EdgeJoinRow[] {
  const route = requireStringParam(params, 'route', 'routes_to');
  const routeNode = db
    .prepare(`SELECT id FROM nodes WHERE kind = 'route' AND (id = ? OR name = ?) LIMIT 1`)
    .get(route, route) as { id: string } | undefined;
  if (!routeNode) {
    throw new QueryValidationError(`pb-codegraph: query template "routes_to" found no route node for "${route}" in this repo`);
  }
  return db
    .prepare(
      `SELECT 'incoming' AS direction, e.kind AS edge_kind, e.metadata AS metadata,
              n.id AS n_id, n.kind AS n_kind, n.name AS n_name, n.qualified_name AS n_qualified_name,
              n.file_path AS n_file_path, n.start_line AS n_start_line, n.end_line AS n_end_line,
              n.signature AS n_signature
       FROM edges e JOIN nodes n ON n.id = e.source
       WHERE e.target = ? AND e.kind = 'references' AND e.provenance = ?
       ORDER BY n.qualified_name`,
    )
    .all(routeNode.id, PROVENANCE) as EdgeJoinRow[];
}

/**
 * preferences_for: follows di.xml preference redirection in BOTH
 * directions from the given interface or class — the interface's
 * preference_for edge (outgoing, to the concrete class it's redirected to)
 * and/or the class's preference_for edge (incoming, from the interface(s)
 * it substitutes for). Maps to the old GitNexus
 * `MATCH (i)-[:PREFERRED_BY]-(c)` (undirected) cypher pattern.
 */
function preferencesFor(db: Database.Database, params: Record<string, unknown>): EdgeJoinRow[] {
  const symbol = requireStringParam(params, 'symbol', 'preferences_for');
  const target = resolveOrThrow(db, symbol, 'preferences_for');
  return db
    .prepare(
      `SELECT 'outgoing' AS direction, e.kind AS edge_kind, e.metadata AS metadata,
              n.id AS n_id, n.kind AS n_kind, n.name AS n_name, n.qualified_name AS n_qualified_name,
              n.file_path AS n_file_path, n.start_line AS n_start_line, n.end_line AS n_end_line,
              n.signature AS n_signature
       FROM edges e JOIN nodes n ON n.id = e.target
       WHERE e.source = ? AND e.kind = 'preference_for' AND e.provenance = ?
       UNION ALL
       SELECT 'incoming' AS direction, e.kind AS edge_kind, e.metadata AS metadata,
              n.id AS n_id, n.kind AS n_kind, n.name AS n_name, n.qualified_name AS n_qualified_name,
              n.file_path AS n_file_path, n.start_line AS n_start_line, n.end_line AS n_end_line,
              n.signature AS n_signature
       FROM edges e JOIN nodes n ON n.id = e.source
       WHERE e.target = ? AND e.kind = 'preference_for' AND e.provenance = ?
       ORDER BY direction, n_qualified_name`,
    )
    .all(target.id, PROVENANCE, target.id, PROVENANCE) as EdgeJoinRow[];
}

/**
 * dead_symbols: class/interface/method nodes with NO incoming edge of any
 * kind (native or magento) — candidates for dead code. Heuristic, not a
 * certainty: a public API entry point with no local caller looks identical.
 * No direct GitNexus cypher equivalent existed for this template (new in
 * pb-codegraph) — see docs/query-cookbook.md.
 */
function deadSymbols(db: Database.Database, _params: Record<string, unknown>): EdgeJoinRow[] {
  const placeholders = DEAD_SYMBOL_CANDIDATE_KINDS.map(() => '?').join(', ');
  const rows = db
    .prepare(
      `SELECT ${NODE_COLUMNS}
       FROM nodes n
       WHERE n.kind IN (${placeholders})
         AND NOT EXISTS (SELECT 1 FROM edges e WHERE e.target = n.id)
       ORDER BY n.qualified_name`,
    )
    .all(...DEAD_SYMBOL_CANDIDATE_KINDS) as ResolvedNode[];
  return rows.map((r) => ({
    direction: 'outgoing',
    edge_kind: 'dead_symbol',
    metadata: null,
    n_id: r.id,
    n_kind: r.kind,
    n_name: r.name,
    n_qualified_name: r.qualified_name,
    n_file_path: r.file_path,
    n_start_line: r.start_line,
    n_end_line: r.end_line,
    n_signature: r.signature,
  }));
}

const TEMPLATES: Record<QueryTemplateName, (db: Database.Database, params: Record<string, unknown>) => EdgeJoinRow[]> = {
  callers_of: callersOf,
  wired_plugins_on: wiredPluginsOn,
  observers_of_event: observersOfEvent,
  routes_to: routesTo,
  preferences_for: preferencesFor,
  dead_symbols: deadSymbols,
};

export function runQuery(registry: Registry, options: RunQueryOptions): RunQueryResult {
  const { template, params, repo } = options;

  if (!QUERY_TEMPLATE_NAMES.includes(template)) {
    throw new QueryValidationError(
      `pb-codegraph: unknown query template "${template}" — valid templates are: ${QUERY_TEMPLATE_NAMES.join(', ')}. ` +
        'query() only accepts these named, parameterized templates, never raw SQL.',
    );
  }
  const run = TEMPLATES[template];

  const repoNames = repo ? [repo] : Object.keys(registry);
  const errors: RepoQueryError[] = [];
  const results: QueryRepoResult[] = [];

  for (const repoName of repoNames) {
    const entry = registry[repoName];
    if (!entry) {
      errors.push({ repo: repoName, error: `pb-codegraph: repo "${repoName}" is not in the registry` });
      continue;
    }

    try {
      const db = openReadOnlyDb(entry.db_path);
      let edgeRows: EdgeJoinRow[];
      try {
        edgeRows = run(db, params);
      } finally {
        db.close();
      }
      const totalMatches = edgeRows.length;
      const truncated = totalMatches > QUERY_RESULT_CAP;
      const capped = truncated ? edgeRows.slice(0, QUERY_RESULT_CAP) : edgeRows;
      results.push({
        repo: repoName,
        rows: toRows(repoName, capped),
        truncated,
        total_matches: totalMatches,
      });
    } catch (err) {
      if (err instanceof QueryValidationError && repo) {
        // A single explicitly-named repo with a validation failure (e.g.
        // symbol not found) is surfaced as a hard throw — there is nowhere
        // else useful to look.
        throw err;
      }
      const reason = err instanceof Error ? err.message : String(err);
      errors.push({ repo: repoName, error: reason });
    }
  }

  return { template, params, results, errors };
}
