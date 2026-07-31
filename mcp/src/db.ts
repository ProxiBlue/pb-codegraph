// Read-only SQLite connection helper for the MCP shim.
//
// The shim NEVER writes (v0.2.0 scope — see task 005 context: re-augment
// triggers are a warn-only note here, not an exec). Connections are opened
// SQLITE_OPEN_READONLY and set busy_timeout so a concurrent codegraph
// writer (the FS watcher re-indexing, or the augmenter CLI) doesn't error
// the read outright — WAL readers just wait up to the timeout instead of
// hitting SQLITE_BUSY immediately (see _devils_advocate.md C5).
import Database from 'better-sqlite3';
import { assertSupportedSchema } from '../../shared/schema-guard.ts';

const BUSY_TIMEOUT_MS = 5_000;

export function openReadOnlyDb(dbPath: string): Database.Database {
  let db: Database.Database;
  try {
    db = new Database(dbPath, { readonly: true, fileMustExist: true });
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new Error(`pb-codegraph: unable to open codegraph db read-only at "${dbPath}": ${reason}`);
  }

  db.pragma(`busy_timeout = ${BUSY_TIMEOUT_MS}`);

  // Schema-version guard (task 008): refuse an unrecognized codegraph
  // schema up front rather than failing deep inside a later query.
  try {
    assertSupportedSchema(db);
  } catch (err) {
    db.close();
    throw err;
  }

  return db;
}
