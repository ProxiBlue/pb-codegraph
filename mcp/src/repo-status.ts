// Per-repo status computation for the list_repos MCP tool.
//
// Every repo entry is resolved independently: a bad registry entry (missing
// db, unreadable file, etc.) produces an { ok: false, error } entry, not a
// thrown exception that would crash list_repos for every other repo (see
// task 005 requirement "it survives a registry entry pointing at a missing
// db with a per-repo error not a crash").
import { openReadOnlyDb } from './db.ts';
import type { Registry, RegistryEntry } from './registry.ts';
import { readAugmenterMarker, readCurrentFilesIndexedAt, type AugmenterStatus } from './augmenter-marker.ts';

export type { AugmenterStatus } from './augmenter-marker.ts';

export interface RepoStatusOk {
  name: string;
  description?: string;
  db_path: string;
  ok: true;
  node_count: number;
  edge_count: number;
  indexed_at: number | null;
  augmenter_status: AugmenterStatus;
  augmenter_run_at: number | null;
}

export interface RepoStatusError {
  name: string;
  description?: string;
  db_path: string;
  ok: false;
  error: string;
}

export type RepoStatus = RepoStatusOk | RepoStatusError;

export function getRepoStatus(name: string, entry: RegistryEntry): RepoStatus {
  const base = {
    name,
    db_path: entry.db_path,
    ...(entry.description ? { description: entry.description } : {}),
  };

  try {
    const db = openReadOnlyDb(entry.db_path);
    try {
      const nodeCount = (db.prepare('SELECT COUNT(*) AS c FROM nodes').get() as { c: number }).c;
      const edgeCount = (db.prepare('SELECT COUNT(*) AS c FROM edges').get() as { c: number }).c;
      const indexedAt = readCurrentFilesIndexedAt(db);

      const marker = readAugmenterMarker(db, indexedAt);

      return {
        ...base,
        ok: true,
        node_count: nodeCount,
        edge_count: edgeCount,
        indexed_at: indexedAt,
        augmenter_status: marker.status,
        augmenter_run_at: marker.runAt,
      };
    } finally {
      db.close();
    }
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    return {
      ...base,
      ok: false,
      error: reason,
    };
  }
}

export function listRepoStatuses(registry: Registry): RepoStatus[] {
  return Object.entries(registry).map(([name, entry]) => getRepoStatus(name, entry));
}
