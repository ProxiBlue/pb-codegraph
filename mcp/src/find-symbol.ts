// find_symbol MCP tool logic.
//
// Contract (task 006): exact qualified_name lookup first, then FTS5
// nodes_fts match (ranked), across a named repo or (when repo is omitted)
// every repo in the registry — federation merges + tags each row with its
// source repo (see docs/edge-taxonomy.md federation note in task 005/006
// context: "exact matches first, then per-db FTS rank" — RRF-lite, not a
// true cross-db rank fusion).
//
// Output shape keeps name/path/signature prominent (see
// .claude/code-standards.md: "tool outputs stable + agent-readable
// (name/path/signature prominent)") so agents' legacy-tool habits keep
// working.
import type Database from 'better-sqlite3';
import { openReadOnlyDb } from './db.ts';
import type { Registry } from './registry.ts';

// Hard cap on returned results — "no silent truncation" (code-standards.md):
// when more matches exist than this, `truncated` + `total_matches` on the
// result make the cap loud rather than silently dropping rows.
export const FIND_SYMBOL_RESULT_CAP = 50;

export type SymbolMatchType = 'exact' | 'fts';

export interface SymbolResult {
  repo: string;
  match_type: SymbolMatchType;
  id: string;
  kind: string;
  name: string;
  qualified_name: string;
  file_path: string;
  start_line: number;
  end_line: number;
  signature: string | null;
}

export interface RepoQueryError {
  repo: string;
  error: string;
}

export interface FindSymbolResult {
  query: string;
  results: SymbolResult[];
  errors: RepoQueryError[];
  truncated: boolean;
  total_matches: number;
}

interface NodeRow {
  id: string;
  kind: string;
  name: string;
  qualified_name: string;
  file_path: string;
  start_line: number;
  end_line: number;
  signature: string | null;
}

const NODE_COLUMNS = 'id, kind, name, qualified_name, file_path, start_line, end_line, signature';

function findExactMatches(db: Database.Database, query: string): NodeRow[] {
  return db
    .prepare(
      `SELECT ${NODE_COLUMNS} FROM nodes WHERE qualified_name = @query OR name = @query OR id = @query ORDER BY qualified_name`,
    )
    .all({ query }) as NodeRow[];
}

/**
 * Turns free-text user input into a safe FTS5 prefix query. FTS5's own
 * query syntax (quoting, boolean operators, column filters) would otherwise
 * let a symbol name containing e.g. a bare `"` or `-` throw a syntax error
 * instead of just matching literally. We tokenize on non-alphanumeric
 * boundaries (matching FTS5's default unicode61 tokenizer closely enough
 * for identifiers/namespaces) and OR the prefix-matched tokens together.
 */
function toFtsPrefixQuery(raw: string): string | null {
  const tokens = raw.split(/[^\p{L}\p{N}_]+/u).filter((t) => t.length > 0);
  if (tokens.length === 0) return null;
  return tokens.map((t) => `"${t.replace(/"/g, '""')}"*`).join(' OR ');
}

function findFtsMatches(db: Database.Database, query: string, excludeIds: Set<string>): NodeRow[] {
  const ftsQuery = toFtsPrefixQuery(query);
  if (!ftsQuery) return [];

  const rows = db
    .prepare(
      `SELECT n.${NODE_COLUMNS.split(', ').join(', n.')}
       FROM nodes_fts
       JOIN nodes n ON n.rowid = nodes_fts.rowid
       WHERE nodes_fts MATCH @ftsQuery
       ORDER BY rank`,
    )
    .all({ ftsQuery }) as NodeRow[];

  return rows.filter((row) => !excludeIds.has(row.id));
}

function toSymbolResult(row: NodeRow, repo: string, matchType: SymbolMatchType): SymbolResult {
  return {
    repo,
    match_type: matchType,
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

export interface FindSymbolOptions {
  query: string;
  repo?: string;
}

export function findSymbol(registry: Registry, options: FindSymbolOptions): FindSymbolResult {
  const { query, repo } = options;
  const repoNames = repo ? [repo] : Object.keys(registry);

  const errors: RepoQueryError[] = [];
  const exactResults: SymbolResult[] = [];
  const ftsResults: SymbolResult[] = [];

  for (const repoName of repoNames) {
    const entry = registry[repoName];
    if (!entry) {
      errors.push({ repo: repoName, error: `pb-codegraph: repo "${repoName}" is not in the registry` });
      continue;
    }

    try {
      const db = openReadOnlyDb(entry.db_path);
      let exact: NodeRow[];
      let fts: NodeRow[];
      try {
        exact = findExactMatches(db, query);
        const exactIds = new Set(exact.map((row) => row.id));
        fts = findFtsMatches(db, query, exactIds);
      } finally {
        db.close();
      }
      for (const row of exact) exactResults.push(toSymbolResult(row, repoName, 'exact'));
      for (const row of fts) ftsResults.push(toSymbolResult(row, repoName, 'fts'));
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      errors.push({ repo: repoName, error: reason });
    }
  }

  // RRF-lite: every exact match (across every queried repo) outranks every
  // FTS match. Within each tier, repo query order is preserved (registry
  // iteration order / FTS `rank` ordering already applied per-repo above).
  const merged = [...exactResults, ...ftsResults];
  const totalMatches = merged.length;
  const truncated = totalMatches > FIND_SYMBOL_RESULT_CAP;
  const results = truncated ? merged.slice(0, FIND_SYMBOL_RESULT_CAP) : merged;

  return { query, results, errors, truncated, total_matches: totalMatches };
}
