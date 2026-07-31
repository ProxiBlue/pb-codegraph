// context MCP tool logic.
//
// Contract (task 006): the node + one-hop neighbors, both directions,
// across ALL edge kinds (native codegraph kinds AND the LOCKED magento
// kinds from docs/edge-taxonomy.md: preference_for, wraps, observes,
// renders, references), grouped by edge kind, with metadata (sortOrder,
// area, event, reason) surfaced rather than left as an opaque JSON string.
//
// Symbol resolution reuses find_symbol's exact-then-fts strategy (id match
// first, then qualified_name/name exact, then FTS top rank) so callers can
// pass either a find_symbol result's id, its qualified_name, or a bare name.
import type Database from 'better-sqlite3';
import { openReadOnlyDb } from './db.ts';
import type { Registry } from './registry.ts';
import { resolveSymbolNode, NODE_COLUMNS } from './resolve-symbol.ts';

export interface ContextNode {
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

export type EdgeDirection = 'outgoing' | 'incoming';

export interface ContextEdge {
  direction: EdgeDirection;
  node: ContextNode;
  metadata: Record<string, unknown> | null;
  line: number | null;
  col: number | null;
}

export interface ContextResult {
  repo: string;
  node: ContextNode;
  neighbors: Record<string, ContextEdge[]>;
}

export interface RepoQueryError {
  repo: string;
  error: string;
}

export interface GetContextResult {
  symbol: string;
  results: ContextResult[];
  errors: RepoQueryError[];
}

interface EdgeRow {
  direction: EdgeDirection;
  kind: string;
  metadata: string | null;
  line: number | null;
  col: number | null;
  n_id: string;
  n_kind: string;
  n_name: string;
  n_qualified_name: string;
  n_file_path: string;
  n_start_line: number;
  n_end_line: number;
  n_signature: string | null;
}

function fetchNeighborEdges(db: Database.Database, nodeId: string): EdgeRow[] {
  return db
    .prepare(
      `SELECT 'outgoing' AS direction, e.kind AS kind, e.metadata AS metadata, e.line AS line, e.col AS col,
              n.id AS n_id, n.kind AS n_kind, n.name AS n_name, n.qualified_name AS n_qualified_name,
              n.file_path AS n_file_path, n.start_line AS n_start_line, n.end_line AS n_end_line,
              n.signature AS n_signature
       FROM edges e JOIN nodes n ON n.id = e.target
       WHERE e.source = @nodeId
       UNION ALL
       SELECT 'incoming' AS direction, e.kind AS kind, e.metadata AS metadata, e.line AS line, e.col AS col,
              n.id AS n_id, n.kind AS n_kind, n.name AS n_name, n.qualified_name AS n_qualified_name,
              n.file_path AS n_file_path, n.start_line AS n_start_line, n.end_line AS n_end_line,
              n.signature AS n_signature
       FROM edges e JOIN nodes n ON n.id = e.source
       WHERE e.target = @nodeId`,
    )
    .all({ nodeId }) as EdgeRow[];
}

function groupByKind(repo: string, edgeRows: EdgeRow[]): Record<string, ContextEdge[]> {
  const grouped: Record<string, ContextEdge[]> = {};
  for (const row of edgeRows) {
    const metadata = row.metadata ? (JSON.parse(row.metadata) as Record<string, unknown>) : null;
    const edge: ContextEdge = {
      direction: row.direction,
      metadata,
      line: row.line,
      col: row.col,
      node: {
        repo,
        id: row.n_id,
        kind: row.n_kind,
        name: row.n_name,
        qualified_name: row.n_qualified_name,
        file_path: row.n_file_path,
        start_line: row.n_start_line,
        end_line: row.n_end_line,
        signature: row.n_signature,
      },
    };
    (grouped[row.kind] ??= []).push(edge);
  }
  return grouped;
}

export interface GetContextOptions {
  symbol: string;
  repo?: string;
}

export function getContext(registry: Registry, options: GetContextOptions): GetContextResult {
  const { symbol, repo } = options;
  const repoNames = repo ? [repo] : Object.keys(registry);

  const errors: RepoQueryError[] = [];
  const results: ContextResult[] = [];

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
        const edgeRows = fetchNeighborEdges(db, nodeRow.id);
        results.push({
          repo: repoName,
          node: {
            repo: repoName,
            id: nodeRow.id,
            kind: nodeRow.kind,
            name: nodeRow.name,
            qualified_name: nodeRow.qualified_name,
            file_path: nodeRow.file_path,
            start_line: nodeRow.start_line,
            end_line: nodeRow.end_line,
            signature: nodeRow.signature,
          },
          neighbors: groupByKind(repoName, edgeRows),
        });
      } finally {
        db.close();
      }
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      errors.push({ repo: repoName, error: reason });
    }
  }

  return { symbol, results, errors };
}
