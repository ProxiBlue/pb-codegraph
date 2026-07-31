// Schema-version guard: refuses to operate against a codegraph SQLite db
// whose schema this build has not been characterized against, rather than
// silently reading/writing garbage or crashing deep inside a query.
//
// Used by BOTH the mcp shim's read-only open path (mcp/src/db.ts) and the
// augmenter's write open path (augmenter/src/writer/sqlite-writer.ts) — a
// single guard consulted from both entry points, per task 008.
//
// Upgrade procedure (bump pin -> run fixture suite -> update this matrix):
// see docs/upgrading-codegraph.md.
import type Database from 'better-sqlite3';
import { PINNED_CODEGRAPH_PACKAGE } from './pinned.ts';

const UPGRADE_DOC = 'docs/upgrading-codegraph.md';

/**
 * schema_versions.version values this build has been characterized
 * against, pinned to PINNED_CODEGRAPH_PACKAGE. Observed directly from
 * tests/fixture/.codegraph/codegraph.db's `schema_versions` table
 * (max(version) = 8) when this guard was written — see task 008 notes.
 */
export const SUPPORTED_SCHEMA_VERSIONS: readonly number[] = [8];

/** Columns/tables the guard/rest of the codebase assumes exist, beyond the
 * bare schema_versions row — characterized from the same fixture db. */
const REQUIRED_COLUMNS: ReadonlyArray<{ table: string; column: string }> = [
  { table: 'nodes', column: 'qualified_name' },
  { table: 'edges', column: 'provenance' },
];
const REQUIRED_TABLES: readonly string[] = ['project_metadata'];

export class UnsupportedSchemaError extends Error {}

function refuse(reason: string): never {
  throw new UnsupportedSchemaError(
    `pb-codegraph: refusing to open codegraph db — ${reason} ` +
      `(this build is pinned to ${PINNED_CODEGRAPH_PACKAGE}, which supports schema version(s) ` +
      `${SUPPORTED_SCHEMA_VERSIONS.join(', ')}). ` +
      `See ${UPGRADE_DOC} to bump the pin, run the fixture suite, and update the supported matrix.`,
  );
}

/**
 * Throws UnsupportedSchemaError if `db`'s schema_versions max(version) is
 * not in SUPPORTED_SCHEMA_VERSIONS, or any REQUIRED_COLUMNS/REQUIRED_TABLES
 * entry is missing. No-op (returns) if the schema is supported.
 */
export function assertSupportedSchema(db: Database.Database): void {
  const versionRow = db.prepare('SELECT MAX(version) AS v FROM schema_versions').get() as { v: number | null };
  const version = versionRow.v;

  if (version === null || !SUPPORTED_SCHEMA_VERSIONS.includes(version)) {
    refuse(`schema_versions max(version) is "${version ?? 'unknown'}", not a supported version.`);
  }

  for (const { table, column } of REQUIRED_COLUMNS) {
    if (!hasColumn(db, table, column)) {
      refuse(`expected column "${table}.${column}" is missing.`);
    }
  }

  for (const table of REQUIRED_TABLES) {
    if (!hasTable(db, table)) {
      refuse(`expected table "${table}" is missing.`);
    }
  }
}

function hasColumn(db: Database.Database, table: string, column: string): boolean {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  return cols.some((c) => c.name === column);
}

function hasTable(db: Database.Database, table: string): boolean {
  const row = db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`).get(table);
  return row !== undefined;
}
