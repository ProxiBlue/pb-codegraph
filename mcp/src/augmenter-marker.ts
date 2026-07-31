// Shared augmenter-staleness computation (task 007, extracted from
// repo-status.ts's task-005 logic so impact — deploy-safety-critical — and
// list_repos agree on exactly one definition of "stale").
//
// project_metadata keys written by the augment CLI wrapper (task 004):
// pb_augmenter_run_at (when augment last ran) and
// pb_augmenter_files_indexed_at (the max(files.indexed_at) snapshot taken
// right after that run). Stale iff codegraph's CURRENT max(files.indexed_at)
// has advanced past that snapshot — i.e. codegraph reindexed since the last
// augment run, which cascade-deletes the augmenter's injected magento edges
// (see docs/edge-taxonomy.md provenance discipline + _devils_advocate.md C5).
import type Database from 'better-sqlite3';

export const AUGMENTER_RUN_AT_KEY = 'pb_augmenter_run_at';
export const AUGMENTER_FILES_INDEXED_AT_KEY = 'pb_augmenter_files_indexed_at';

export type AugmenterStatus = 'never-run' | 'fresh' | 'stale';

export interface AugmenterMarker {
  status: AugmenterStatus;
  runAt: number | null;
  filesIndexedAtSnapshot: number | null;
}

export function readCurrentFilesIndexedAt(db: Database.Database): number | null {
  const row = db.prepare('SELECT MAX(indexed_at) AS m FROM files').get() as { m: number | null };
  return row.m ?? null;
}

export function readAugmenterMarker(db: Database.Database, indexedAt: number | null): AugmenterMarker {
  const runAtRow = db.prepare('SELECT value FROM project_metadata WHERE key = ?').get(AUGMENTER_RUN_AT_KEY) as
    | { value: string }
    | undefined;

  if (!runAtRow) {
    return { status: 'never-run', runAt: null, filesIndexedAtSnapshot: null };
  }

  const runAt = Number(runAtRow.value);

  const snapshotRow = db
    .prepare('SELECT value FROM project_metadata WHERE key = ?')
    .get(AUGMENTER_FILES_INDEXED_AT_KEY) as { value: string } | undefined;
  const filesIndexedAtSnapshot = snapshotRow ? Number(snapshotRow.value) : null;

  const status: AugmenterStatus =
    filesIndexedAtSnapshot !== null && indexedAt !== null && indexedAt > filesIndexedAtSnapshot ? 'stale' : 'fresh';

  return { status, runAt, filesIndexedAtSnapshot };
}
