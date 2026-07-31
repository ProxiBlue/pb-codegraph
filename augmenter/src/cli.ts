// pb-codegraph: new file (not vendored). Argument parsing + exit-code
// mapping for the `pb-codegraph` CLI (task 004). Kept separate from
// bin/pb-codegraph.ts (the thin shebang entrypoint) so tests can import and
// call `main()` directly without spawning a subprocess for every case —
// mirrors the mcp/bin/server.ts (thin entry) vs mcp/src/server.ts (logic)
// split already used in this repo.
//
// Exit codes (see task 004's "## Context"): 0 ok, 1 augment error, 2 db
// missing/unknown schema. `health` (task 010) reuses 1/2 with distinct
// exported names: EXIT_HEALTH_NOT_GREEN (at least one registered repo is
// not ok+fresh) and EXIT_DB_ERROR (the registry itself could not be loaded,
// so health could not even be determined).
import path from 'node:path';

import { UnsupportedSchemaError } from '../../shared/schema-guard.ts';
import {
  DbNotFoundError,
  defaultDbPath,
  runAugment,
  runIndexAndAugment,
  type AugmentRunResult,
} from './augment.ts';
import { loadRegistryFromEnv, loadRegistryFromPath } from '../../mcp/src/registry.ts';
import { listRepoStatuses, type RepoStatus } from '../../mcp/src/repo-status.ts';
import { parseVerifyWiringArgs, runVerifyWiring } from './verify-wiring.ts';

export const EXIT_OK = 0;
export const EXIT_AUGMENT_ERROR = 1;
export const EXIT_DB_ERROR = 2;
/** `health` non-green exit code — deliberately the same numeric value as
 * EXIT_AUGMENT_ERROR (any nonzero exit is "not healthy" for a wire probe
 * consumer), exported under its own name so health call sites/tests read
 * clearly and the two concepts can diverge later without a breaking change. */
export const EXIT_HEALTH_NOT_GREEN = 1;

export function usage(): string {
  return [
    'Usage:',
    '  pb-codegraph augment <project-root> [--db <path>]',
    '  pb-codegraph index <project-root>',
    '  pb-codegraph health [--registry <path>]',
    '  pb-codegraph verify-wiring <project-root> [--db <path>] [--registry <path>] [--stamp]',
    '',
    '  augment        Parse Magento XML wiring and inject edges into an already-indexed codegraph db.',
    '  index          Rebuild the codegraph index (init if never indexed) then augment it — the answer',
    '                 to a codegraph reindex cascade-wiping previously-injected magento edges.',
    '  health         Report registry-wide health as JSON (wire-probe replacement for the legacy',
    '                 curl :4747 check). Non-green when any repo is unreadable/unsupported-schema or its',
    '                 augmenter marker is stale. --registry overrides PB_CODEGRAPH_REGISTRY.',
    '  verify-wiring  Reconcile the augmenter\'s static edges against vendor/bin/bricklayer\'s runtime',
    '                 ObjectManager truth (spawned as an MCP stdio child process; override the spawn',
    '                 command via PB_CODEGRAPH_BRICKLAYER_CMD). Scope: preference_for, wraps, and',
    '                 observes ONLY — bricklayer exposes no runtime query for renders or references',
    '                 (routes/webapi), so those two edge kinds are out of scope for this command.',
    '                 --registry unions core/3rd-party dbs into the static side before declaring a',
    '                 runtime fact missing-from-graph (see docs/edge-taxonomy.md). --stamp marks',
    '                 GRAPH_ONLY edges (static-only, e.g. a disabled module) in the PROJECT db with',
    '                 metadata.enabled_in_env=false; without --stamp it only reports them. NOTE: both',
    '                 plugin-list and preference-list are per-target-class/interface bricklayer tools,',
    '                 so a wraps/preference fact for a class/interface with ZERO static rows can never',
    '                 be found missing-from-graph — only already-known targets get cross-checked.',
  ].join('\n');
}

interface ParsedArgs {
  command: 'augment' | 'index';
  projectRoot: string;
  dbPath?: string;
}

function parseArgs(argv: string[]): ParsedArgs | null {
  const [command, projectRootArg, ...rest] = argv;
  if (command !== 'augment' && command !== 'index') return null;
  if (!projectRootArg) return null;

  const projectRoot = path.resolve(projectRootArg);

  let dbPath: string | undefined;
  const dbFlagIndex = rest.indexOf('--db');
  if (dbFlagIndex !== -1) {
    const value = rest[dbFlagIndex + 1];
    if (!value) return null;
    dbPath = path.resolve(value);
  }

  return { command, projectRoot, dbPath };
}

function printSummary(log: (msg: string) => void, result: AugmentRunResult): void {
  log('--- pb-codegraph augment summary ---');
  log(`  di.xml preferences resolved:  ${result.families.diPreferences.resolved}`);
  log(`  di.xml plugins resolved:      ${result.families.diPlugins.resolved}`);
  log(`  events.xml observers:         ${result.families.events.resolved}`);
  log(`  layout block->template:       ${result.families.layout.resolved}`);
  log(`  webapi.xml routes:            ${result.families.webapi.resolved}`);
  log(`  routes.xml routes minted:     ${result.families.routes.routesMinted}`);
  log(`  edges deleted (prior run):    ${result.edgesDeleted}`);
  log(`  edges inserted:               ${result.edgesInserted}`);
  log(`  nodes deleted (orphaned):     ${result.nodesDeleted}`);
  log(`  nodes inserted:               ${result.nodesInserted}`);
  log(`  attempts (watcher-race guard): ${result.attempts}`);
  log('Augmentation complete.');
}

export interface CliIO {
  log: (msg: string) => void;
  error: (msg: string) => void;
}

const defaultIO: CliIO = { log: console.log, error: console.error };

interface HealthReport {
  status: 'green' | 'non-green';
  repos: RepoStatus[];
}

/** A repo counts toward "green" only when its db opened cleanly (schema
 * guard passed) AND its augmenter marker is 'fresh' — 'never-run' and
 * 'stale' are both non-green, same as 'ok: false' (unreadable/unsupported
 * schema), because none of those states let impact/context answer with
 * confidence that magento edges are present and current. */
function isRepoGreen(repo: RepoStatus): boolean {
  return repo.ok && repo.augmenter_status === 'fresh';
}

function parseHealthRegistryPath(rest: string[]): string | null | undefined {
  const flagIndex = rest.indexOf('--registry');
  if (flagIndex === -1) return undefined;
  const value = rest[flagIndex + 1];
  return value ? path.resolve(value) : null;
}

async function runHealth(rest: string[], io: CliIO): Promise<number> {
  const registryPath = parseHealthRegistryPath(rest);
  if (registryPath === null) {
    io.error(usage());
    return EXIT_AUGMENT_ERROR;
  }

  let registry;
  try {
    registry = registryPath ? loadRegistryFromPath(registryPath) : loadRegistryFromEnv();
  } catch (err) {
    io.error(err instanceof Error ? err.message : String(err));
    return EXIT_DB_ERROR;
  }

  const repos = listRepoStatuses(registry);
  const report: HealthReport = {
    status: repos.every(isRepoGreen) ? 'green' : 'non-green',
    repos,
  };
  io.log(JSON.stringify(report));
  return report.status === 'green' ? EXIT_OK : EXIT_HEALTH_NOT_GREEN;
}

/** Runs the CLI and returns the process exit code — never calls
 * process.exit itself, so tests can invoke this directly. */
export async function main(argv: string[], io: CliIO = defaultIO): Promise<number> {
  if (argv[0] === 'health') {
    return runHealth(argv.slice(1), io);
  }

  if (argv[0] === 'verify-wiring') {
    const verifyArgs = parseVerifyWiringArgs(argv.slice(1));
    if (!verifyArgs) {
      io.error(usage());
      return EXIT_AUGMENT_ERROR;
    }
    return runVerifyWiring(verifyArgs, io);
  }

  const parsed = parseArgs(argv);
  if (!parsed) {
    io.error(usage());
    return EXIT_AUGMENT_ERROR;
  }

  const { command, projectRoot, dbPath } = parsed;

  try {
    if (command === 'augment') {
      const result = await runAugment(projectRoot, dbPath ?? defaultDbPath(projectRoot));
      printSummary(io.log, result);
      return EXIT_OK;
    }

    const result = await runIndexAndAugment(projectRoot, defaultDbPath(projectRoot));
    printSummary(io.log, result);
    return EXIT_OK;
  } catch (err) {
    if (err instanceof DbNotFoundError || err instanceof UnsupportedSchemaError) {
      io.error(err.message);
      return EXIT_DB_ERROR;
    }
    io.error(`pb-codegraph: augment failed — ${err instanceof Error ? err.message : String(err)}`);
    return EXIT_AUGMENT_ERROR;
  }
}
