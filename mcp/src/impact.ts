// impact MCP tool logic (task 007).
//
// Recursive, depth-capped (<=4) traversal over BOTH native codegraph edge
// kinds (calls/instantiates/references/imports/...) and the LOCKED magento
// kinds from docs/edge-taxonomy.md (wraps, preference_for, observes,
// renders, references) — keyed on the remapped lowercase `kind` column,
// never the vendored uppercase `type`.
//
// direction:
//  - 'dependencies' walks OUTGOING edges (source = current node) — "what
//    this symbol structurally points at".
//  - 'dependents' walks INCOMING edges (target = current node) — "what
//    points at this symbol".
//  - 'both' (the default) unions both walks. Magento edges do not all point
//    in the "intuitive" impact direction — e.g. `wraps`' source is the
//    TARGET class, not the plugin (see docs/edge-taxonomy.md) — so 'both'
//    is the safe default for magento-aware impact; callers that want one
//    literal graph direction only can pass it explicitly.
//
// Every result row carries its edge_kind_path (the sequence of edge kinds
// walked to reach it) and is grouped by depth. A cycle guard (visited-path
// check inside the recursive CTE) prevents infinite loops; the depth cap
// additionally bounds the walk. When a node at the deepest allowed depth
// still has further edges, depth_capped is set (loud, not a silent drop).
//
// Staleness (deploy-safety-critical — see _devils_advocate.md C5): impact
// is exactly the tool the fleet's plugin/observer/preference contract
// depends on, so a stale augmenter marker (codegraph reindexed since the
// last augment run — which cascade-deletes injected magento edges) gets a
// LOUD top-level warning and each affected repo result is flagged
// non_authoritative, rather than silently returning a native-only result
// that LOOKS complete. strict:true refuses (throws) instead of warning.
import type Database from 'better-sqlite3';
import { openReadOnlyDb } from './db.ts';
import type { Registry } from './registry.ts';
import { resolveSymbolNode, NODE_COLUMNS, type ResolvedNode } from './resolve-symbol.ts';
import { readAugmenterMarker, readCurrentFilesIndexedAt, type AugmenterStatus } from './augmenter-marker.ts';

export const IMPACT_MAX_DEPTH = 4;
// Hard cap on returned rows per repo — "no silent truncation" (code
// standards): when more rows exist than this, `truncated` + `total_matches`
// make the cap loud rather than silently dropping rows.
export const IMPACT_RESULT_CAP = 200;

export type ImpactDirection = 'dependents' | 'dependencies' | 'both';
export type WalkDirection = 'dependents' | 'dependencies';

/** Thrown (not returned as a soft per-repo error) when strict:true and the
 * augmenter marker is stale for a queried repo — impact refuses outright
 * rather than serving a non-authoritative result silently. */
export class StaleAugmenterError extends Error {}

export interface ImpactNode {
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

export interface ImpactResultRow {
  direction: WalkDirection;
  depth: number;
  edge_kind_path: string[];
  metadata: Record<string, unknown> | null;
  node: ImpactNode;
}

export interface ImpactRepoResult {
  repo: string;
  node: ImpactNode;
  augmenter_status: AugmenterStatus;
  non_authoritative: boolean;
  results_by_depth: Record<number, ImpactResultRow[]>;
  truncated: boolean;
  total_matches: number;
  /** True when a node at the deepest walked depth has further edges that
   * were NOT walked because the depth cap was hit — the walk was cut off
   * mid-graph, not because the graph ended. */
  depth_capped: boolean;
}

export interface RepoQueryError {
  repo: string;
  error: string;
}

export interface GetImpactOptions {
  symbol: string;
  repo?: string;
  /** Requested max depth; clamped to IMPACT_MAX_DEPTH (never higher). */
  depth?: number;
  direction?: ImpactDirection;
  /** When true, a stale augmenter marker in any queried repo makes the
   * whole call throw StaleAugmenterError instead of returning a
   * loudly-flagged non-authoritative result. */
  strict?: boolean;
}

export interface GetImpactResult {
  symbol: string;
  direction: ImpactDirection;
  depth: number;
  strict: boolean;
  /** LOUD banner (not a soft one-liner), present iff any queried repo's
   * augmenter marker is stale. */
  warning: string | null;
  results: ImpactRepoResult[];
  errors: RepoQueryError[];
}

interface WalkRow {
  node_id: string;
  depth: number;
  kind_path: string;
  metadata: string | null;
}

function walkColumns(dir: WalkDirection): { fromCol: 'source' | 'target'; toCol: 'source' | 'target' } {
  // dependencies: follow OUTGOING edges (source = current node, moving to target).
  // dependents: follow INCOMING edges (target = current node, moving to source).
  return dir === 'dependencies' ? { fromCol: 'source', toCol: 'target' } : { fromCol: 'target', toCol: 'source' };
}

function walk(db: Database.Database, startId: string, dir: WalkDirection, maxDepth: number, rowCap: number): WalkRow[] {
  const { fromCol, toCol } = walkColumns(dir);

  // Cycle guard: `visited` accumulates every node id reached so far
  // (delimited with `|`), and each recursive step refuses to step onto a
  // node already in that path (`instr(...) = 0`). Combined with the
  // `depth < @maxDepth` bound, this always terminates.
  const sql = `
    WITH RECURSIVE walk(node_id, depth, kind_path, metadata, visited) AS (
      SELECT e.${toCol} AS node_id, 1 AS depth, e.kind AS kind_path, e.metadata AS metadata,
             ('|' || @startId || '|' || e.${toCol} || '|') AS visited
      FROM edges e
      WHERE e.${fromCol} = @startId
      UNION ALL
      SELECT e.${toCol} AS node_id, w.depth + 1 AS depth, w.kind_path || '>' || e.kind AS kind_path,
             e.metadata AS metadata, (w.visited || e.${toCol} || '|') AS visited
      FROM edges e
      JOIN walk w ON e.${fromCol} = w.node_id
      WHERE w.depth < @maxDepth
        AND instr(w.visited, '|' || e.${toCol} || '|') = 0
    )
    SELECT node_id, depth, kind_path, metadata FROM walk
    ORDER BY depth, node_id
    LIMIT @rowCap
  `;

  return db.prepare(sql).all({ startId, maxDepth, rowCap }) as WalkRow[];
}

function hasFurtherEdges(db: Database.Database, dir: WalkDirection, nodeIds: string[]): boolean {
  if (nodeIds.length === 0) return false;
  const { fromCol } = walkColumns(dir);
  const placeholders = nodeIds.map(() => '?').join(', ');
  const row = db.prepare(`SELECT COUNT(*) AS c FROM edges WHERE ${fromCol} IN (${placeholders})`).get(...nodeIds) as {
    c: number;
  };
  return row.c > 0;
}

function toImpactNode(repo: string, row: ResolvedNode): ImpactNode {
  return {
    repo,
    id: row.id,
    kind: row.kind,
    name: row.name,
    qualified_name: row.qualified_name,
    file_path: row.file_path,
    start_line: row.start_line,
    end_line: row.end_line,
    signature: row.signature,
  };
}

function hydrateRows(db: Database.Database, repo: string, direction: WalkDirection, rows: WalkRow[]): ImpactResultRow[] {
  if (rows.length === 0) return [];
  const placeholders = rows.map(() => '?').join(', ');
  const nodeRows = db
    .prepare(`SELECT ${NODE_COLUMNS} FROM nodes WHERE id IN (${placeholders})`)
    .all(...rows.map((r) => r.node_id)) as ResolvedNode[];
  const byId = new Map(nodeRows.map((n) => [n.id, n]));

  return rows
    .filter((r) => byId.has(r.node_id))
    .map((r) => ({
      direction,
      depth: r.depth,
      edge_kind_path: r.kind_path.split('>'),
      metadata: r.metadata ? (JSON.parse(r.metadata) as Record<string, unknown>) : null,
      node: toImpactNode(repo, byId.get(r.node_id)!),
    }));
}

const STALE_BANNER =
  'STALE MAGENTO GRAPH — the augmenter marker is behind the codegraph index (codegraph reindexed since the ' +
  'last augment run, which cascade-deletes injected magento edges). Plugin/observer/preference/route edges in ' +
  'this impact result may be MISSING and results below are flagged non_authoritative. Re-run the augmenter ' +
  '(see docs/edge-taxonomy.md provenance discipline) before trusting this result, or set ' +
  'PB_CODEGRAPH_STRICT_STALENESS=1 to refuse instead of warn.';

export function getImpact(registry: Registry, options: GetImpactOptions): GetImpactResult {
  const { symbol, repo } = options;
  const direction: ImpactDirection = options.direction ?? 'both';
  const requestedDepth = options.depth ?? IMPACT_MAX_DEPTH;
  const depth = Math.min(Math.max(Math.trunc(requestedDepth), 1), IMPACT_MAX_DEPTH);
  const strict = options.strict ?? false;

  const repoNames = repo ? [repo] : Object.keys(registry);

  const errors: RepoQueryError[] = [];
  const results: ImpactRepoResult[] = [];
  let anyStale = false;

  for (const repoName of repoNames) {
    const entry = registry[repoName];
    if (!entry) {
      errors.push({ repo: repoName, error: `pb-codegraph: repo "${repoName}" is not in the registry` });
      continue;
    }

    try {
      const db = openReadOnlyDb(entry.db_path);
      try {
        const nodeRow = resolveSymbolNode(db, symbol);
        if (!nodeRow) continue; // not found in this repo — not an error, just no result

        const indexedAt = readCurrentFilesIndexedAt(db);
        const marker = readAugmenterMarker(db, indexedAt);

        if (marker.status === 'stale' && strict) {
          throw new StaleAugmenterError(
            `pb-codegraph: refusing impact for "${symbol}" in repo "${repoName}" — augmenter marker is stale ` +
              '(codegraph reindexed since the last augment run; magento plugin/observer/preference/route edges ' +
              'have been cascade-deleted and this result would be non-authoritative). Re-run the augmenter ' +
              '(pb-codegraph augment), or drop PB_CODEGRAPH_STRICT_STALENESS to get a loudly-flagged ' +
              'non-authoritative result instead of a hard failure.',
          );
        }
        if (marker.status === 'stale') anyStale = true;

        const directionsToWalk: WalkDirection[] = direction === 'both' ? ['dependencies', 'dependents'] : [direction];

        const allRows: ImpactResultRow[] = [];
        let totalMatches = 0;
        let depthCapped = false;
        for (const dir of directionsToWalk) {
          const rawRows = walk(db, nodeRow.id, dir, depth, IMPACT_RESULT_CAP + 1);
          totalMatches += rawRows.length;
          const capped = rawRows.slice(0, IMPACT_RESULT_CAP);
          allRows.push(...hydrateRows(db, repoName, dir, capped));

          const deepestIds = [...new Set(capped.filter((r) => r.depth === depth).map((r) => r.node_id))];
          if (hasFurtherEdges(db, dir, deepestIds)) depthCapped = true;
        }

        const truncated = totalMatches > IMPACT_RESULT_CAP;
        const cappedRows = truncated ? allRows.slice(0, IMPACT_RESULT_CAP) : allRows;

        const resultsByDepth: Record<number, ImpactResultRow[]> = {};
        for (const row of cappedRows) {
          (resultsByDepth[row.depth] ??= []).push(row);
        }

        results.push({
          repo: repoName,
          node: toImpactNode(repoName, nodeRow),
          augmenter_status: marker.status,
          non_authoritative: marker.status === 'stale',
          results_by_depth: resultsByDepth,
          truncated,
          total_matches: totalMatches,
          depth_capped: depthCapped,
        });
      } finally {
        db.close();
      }
    } catch (err) {
      if (err instanceof StaleAugmenterError) throw err;
      const reason = err instanceof Error ? err.message : String(err);
      errors.push({ repo: repoName, error: reason });
    }
  }

  return {
    symbol,
    direction,
    depth,
    strict,
    warning: anyStale ? STALE_BANNER : null,
    results,
    errors,
  };
}
