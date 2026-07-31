// Shared symbol resolution: exact id/qualified_name/name match first, then
// FTS5 nodes_fts best-rank match. Extracted (task 007) so context (006),
// impact, and query (007) all resolve a caller-supplied symbol identifier
// (a find_symbol result's id, its qualified_name, or a bare name) the same
// way rather than drifting.
import type Database from 'better-sqlite3';

export interface ResolvedNode {
  id: string;
  kind: string;
  name: string;
  qualified_name: string;
  file_path: string;
  start_line: number;
  end_line: number;
  signature: string | null;
}

export const NODE_COLUMNS = 'id, kind, name, qualified_name, file_path, start_line, end_line, signature';

export function resolveSymbolNode(db: Database.Database, symbol: string): ResolvedNode | null {
  const exact = db
    .prepare(`SELECT ${NODE_COLUMNS} FROM nodes WHERE id = @symbol OR qualified_name = @symbol OR name = @symbol`)
    .get({ symbol }) as ResolvedNode | undefined;
  if (exact) return exact;

  const ftsQuery = symbol
    .split(/[^\p{L}\p{N}_]+/u)
    .filter((t) => t.length > 0)
    .map((t) => `"${t.replace(/"/g, '""')}"*`)
    .join(' OR ');
  if (!ftsQuery) return null;

  const best = db
    .prepare(
      `SELECT n.${NODE_COLUMNS.split(', ').join(', n.')}
       FROM nodes_fts
       JOIN nodes n ON n.rowid = nodes_fts.rowid
       WHERE nodes_fts MATCH @ftsQuery
       ORDER BY rank
       LIMIT 1`,
    )
    .get({ ftsQuery }) as ResolvedNode | undefined;
  return best ?? null;
}
