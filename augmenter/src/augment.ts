// pb-codegraph: new file (not vendored). Orchestration analogue of
// the legacy augmenter's augment.ts — same phase ordering
// (di.xml -> layout xml -> events.xml -> webapi.xml -> routes.xml) and the
// same best-effort per-phase error handling (a single mapper failure logs a
// warning and contributes zero edges/nodes rather than aborting the whole
// run), adapted to call the DB-backed 003b mappers + task 002's
// sqlite-writer instead of the vendored lbug-writer. See task 004.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import type Database from 'better-sqlite3';

import { mapDiXmlEdges } from './mappers/di-xml-mapper.ts';
import { mapEventsXmlEdges } from './mappers/events-xml-mapper.ts';
import { mapLayoutXmlEdges } from './mappers/layout-xml-mapper.ts';
import { mapWebapiXmlEdges } from './mappers/webapi-xml-mapper.ts';
import { mapRoutesXmlEdges } from './mappers/routes-xml-mapper.ts';
import {
  openWriterDb,
  writeAugmentation,
  type AugmentEdge,
  type AugmentInput,
  type AugmentNode,
  type WriteResult,
} from './writer/sqlite-writer.ts';
import { PINNED_CODEGRAPH_PACKAGE } from '../../shared/pinned.ts';
import {
  AUGMENTER_RUN_AT_KEY,
  AUGMENTER_FILES_INDEXED_AT_KEY,
  readCurrentFilesIndexedAt,
} from '../../mcp/src/augmenter-marker.ts';

/** Thrown when the target codegraph db file does not exist at all — distinct
 * from schema-guard.ts's UnsupportedSchemaError (file exists but the schema
 * is unrecognized). Both map to CLI exit code 2 (see cli.ts). */
export class DbNotFoundError extends Error {}

/** codegraph always writes its index at `<project-root>/.codegraph/codegraph.db`
 * (see scripts/build-fixture-db.sh, tests/helpers/isolated-fixture-db.ts) —
 * the single place that convention is encoded for the augment CLI wrapper. */
export function defaultDbPath(projectRoot: string): string {
  return path.join(projectRoot, '.codegraph', 'codegraph.db');
}

export interface FamilyStats {
  diPreferences: { resolved: number };
  diPlugins: { resolved: number };
  events: { resolved: number; skippedDisabled: number };
  layout: { resolved: number };
  webapi: { resolved: number };
  /** routes.xml mints route nodes but never emits an edge in v0.2 — see
   * docs/edge-taxonomy.md "Route honesty note". */
  routes: { routesMinted: number };
}

export interface AugmentRunResult extends WriteResult {
  /** How many write attempts the watcher-race guard needed (1 = no race
   * detected; >1 = files.indexed_at advanced mid-run and augment re-ran —
   * see _devils_advocate.md C5). */
  attempts: number;
  runAt: number;
  filesIndexedAt: number | null;
  families: FamilyStats;
}

/**
 * Runs a single augmentation phase under best-effort error handling,
 * mirroring the vendored augment.ts's runPhase exactly: a parser bug or
 * transient failure in one phase logs a warning and contributes zero
 * edges/nodes — the rest of the augmentation continues.
 */
async function runPhase<T>(name: string, fn: () => Promise<T>): Promise<T | null> {
  try {
    return await fn();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[pb-codegraph augment] phase "${name}" failed (non-fatal): ${msg}`);
    return null;
  }
}

/**
 * Runs every mapper phase and merges their nodes/edges into one combined
 * AugmentInput (the "area-merge": each mapper already resolves its own
 * di.xml/events.xml/etc per-area files internally — this just concatenates
 * the five families' output into the single batch the writer applies in one
 * transaction).
 */
async function collectAugmentInput(
  projectRoot: string,
  db: Database.Database,
): Promise<{ input: AugmentInput; families: FamilyStats }> {
  const nodes: AugmentNode[] = [];
  const edges: AugmentEdge[] = [];

  const di = await runPhase('di.xml', () => mapDiXmlEdges(projectRoot, db));
  if (di) {
    nodes.push(...di.nodes);
    edges.push(...di.edges);
  }

  const layout = await runPhase('layout-xml', () => mapLayoutXmlEdges(projectRoot, db));
  if (layout) {
    nodes.push(...layout.nodes);
    edges.push(...layout.edges);
  }

  const events = await runPhase('events.xml', () => mapEventsXmlEdges(projectRoot, db));
  if (events) {
    nodes.push(...events.nodes);
    edges.push(...events.edges);
  }

  const webapi = await runPhase('webapi.xml', () => mapWebapiXmlEdges(projectRoot, db));
  if (webapi) {
    nodes.push(...webapi.nodes);
    edges.push(...webapi.edges);
  }

  const routes = await runPhase('routes.xml', () => mapRoutesXmlEdges(projectRoot));
  if (routes) {
    nodes.push(...routes.nodes);
    edges.push(...routes.edges);
  }

  return {
    input: { nodes, edges },
    families: {
      diPreferences: { resolved: di?.stats.preferencesResolved ?? 0 },
      diPlugins: { resolved: di?.stats.pluginsResolved ?? 0 },
      events: { resolved: events?.stats.resolved ?? 0, skippedDisabled: events?.stats.skippedDisabled ?? 0 },
      layout: { resolved: layout?.stats.resolved ?? 0 },
      webapi: { resolved: webapi?.stats.resolved ?? 0 },
      routes: { routesMinted: routes?.stats.routesMinted ?? 0 },
    },
  };
}

function writeAugmenterMarker(db: Database.Database, runAt: number, filesIndexedAt: number | null): void {
  const upsert = db.prepare('INSERT OR REPLACE INTO project_metadata (key, value, updated_at) VALUES (?, ?, ?)');
  upsert.run(AUGMENTER_RUN_AT_KEY, String(runAt), runAt);
  upsert.run(AUGMENTER_FILES_INDEXED_AT_KEY, String(filesIndexedAt ?? 0), runAt);
}

export interface RunAugmentOptions {
  /** Bounded retry count for the watcher-race guard (see
   * _devils_advocate.md C5). Default 2: one normal attempt + one re-augment
   * if files.indexed_at advanced during/immediately after the first. */
  maxAttempts?: number;
  /** Test-only seam: invoked right after a write attempt completes and
   * BEFORE the post-write files.indexed_at re-check, so a test can simulate
   * a codegraph FS-watcher reindex landing in that exact window. Never used
   * outside tests — omitted, this is a no-op. */
  onAfterWrite?: (db: Database.Database, attempt: number) => void;
}

/**
 * Runs the full augment pipeline (parsers -> mappers -> resolver -> writer)
 * against an already-initialized codegraph db, idempotently. Captures
 * max(files.indexed_at) immediately before each write attempt and re-reads
 * it immediately after; if it advanced, a codegraph FS-watcher reindex
 * interleaved (cascade-deleting the rows this write just inserted), so the
 * augment re-runs (bounded by maxAttempts) before the staleness marker is
 * recorded — see _devils_advocate.md C5 and docs' "watcher race guard".
 */
export async function runAugment(
  projectRoot: string,
  dbPath: string,
  opts: RunAugmentOptions = {},
): Promise<AugmentRunResult> {
  if (!fs.existsSync(dbPath)) {
    throw new DbNotFoundError(
      `pb-codegraph: codegraph db not found at "${dbPath}" — run "pb-codegraph index ${projectRoot}" first.`,
    );
  }

  const maxAttempts = opts.maxAttempts ?? 2;
  const db = openWriterDb(dbPath);
  try {
    let writeResult: WriteResult | undefined;
    let families: FamilyStats | undefined;
    let filesIndexedAt: number | null = null;
    let attempts = 0;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      attempts = attempt;
      const before = readCurrentFilesIndexedAt(db);

      const collected = await collectAugmentInput(projectRoot, db);
      families = collected.families;
      writeResult = writeAugmentation(db, collected.input);

      opts.onAfterWrite?.(db, attempt);

      const after = readCurrentFilesIndexedAt(db);
      filesIndexedAt = after;

      if (before === after) break; // stable — no interleaved reindex, safe to record the marker

      if (attempt === maxAttempts) {
        console.warn(
          `[pb-codegraph augment] files.indexed_at kept advancing across ${maxAttempts} attempt(s) ` +
            '(persistent watcher-reindex race) — recording the marker against the latest write anyway.',
        );
      }
    }

    const runAt = Date.now();
    writeAugmenterMarker(db, runAt, filesIndexedAt);

    return { ...(writeResult as WriteResult), attempts, runAt, filesIndexedAt, families: families as FamilyStats };
  } finally {
    db.close();
  }
}

/**
 * The cascade-wipe answer: `codegraph index` (or `init`, if this project
 * root has never been indexed before) rebuilds codegraph's native index from
 * scratch, which cascade-deletes every augmenter-injected edge/minted node
 * (FK `ON DELETE CASCADE` — see docs/edge-taxonomy.md provenance
 * discipline). Immediately re-running augment afterwards is what makes this
 * wrapper command safe to use as the sole entry point instead of relying on
 * codegraph's bare FS watcher (which never re-augments on its own).
 */
export async function runIndexAndAugment(projectRoot: string, dbPath: string): Promise<AugmentRunResult> {
  const alreadyInitialized = fs.existsSync(path.join(projectRoot, '.codegraph'));
  const subcommand = alreadyInitialized ? 'index' : 'init';

  try {
    execFileSync('npx', ['--yes', PINNED_CODEGRAPH_PACKAGE, subcommand, '--force', projectRoot], { stdio: 'pipe' });
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new Error(
      `pb-codegraph: "${PINNED_CODEGRAPH_PACKAGE} ${subcommand}" failed for "${projectRoot}": ${reason}`,
    );
  }

  return runAugment(projectRoot, dbPath);
}
