// pb-codegraph MCP server — native identity (compat-shim naming dropped 2026-07-31).
//
// Fleet contract: this server is served under the existing mcps/.mcp.json
// key `pb-codegraph` (stdio command entry replaces the http url entry at
// cutover — task 010), so `name` below is pinned to that key, not to
// "pb-codegraph", to keep every existing rule/playbook/agent working
// unchanged.
import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { loadRegistryFromEnv } from './registry.ts';
import { listRepoStatuses } from './repo-status.ts';
import { findSymbol } from './find-symbol.ts';
import { getContext } from './context.ts';
import { getImpact, IMPACT_MAX_DEPTH, type ImpactDirection } from './impact.ts';
import { runQuery, QUERY_TEMPLATE_NAMES } from './query.ts';

const STRICT_STALENESS_ENV = 'PB_CODEGRAPH_STRICT_STALENESS';

function strictStalenessFromEnv(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[STRICT_STALENESS_ENV] === '1';
}

export const SERVER_NAME = 'pb-codegraph';
export const SERVER_VERSION = '0.2.0';

export function createServer(): McpServer {
  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION });

  server.registerTool(
    'list_repos',
    {
      title: 'List registered codegraph repos',
      description:
        'Lists every repo registered via PB_CODEGRAPH_REGISTRY with node/edge counts, ' +
        'the last files.indexed_at timestamp, and augmenter staleness status. A bad ' +
        'registry entry (e.g. an unreadable db) is reported as a per-repo error entry, ' +
        'not a crash.',
    },
    async () => {
      const registry = loadRegistryFromEnv();
      const repos = listRepoStatuses(registry);
      return {
        content: [{ type: 'text', text: JSON.stringify({ repos }, null, 2) }],
      };
    },
  );

  // --- tool: find_symbol (task 006) -----------------------------------
  server.registerTool(
    'find_symbol',
    {
      title: 'Find a symbol by name or qualified name',
      description:
        'Exact qualified_name/name lookup first, then FTS5 nodes_fts match (ranked), across a named ' +
        'repo or (when repo is omitted) every registered repo. Includes minted magento nodes ' +
        '(event/route/template/external). Results are tagged with repo and match_type (exact|fts).',
      inputSchema: {
        name: z.string().min(1).describe('Symbol name or qualified_name to search for'),
        repo: z.string().optional().describe('Registered repo name to restrict the search to; omit to search all'),
      },
    },
    async ({ name, repo }) => {
      const registry = loadRegistryFromEnv();
      const result = findSymbol(registry, { query: name, repo });
      return {
        content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
      };
    },
  );
  // --- end tool: find_symbol -------------------------------------------

  // --- tool: context (task 006) -----------------------------------------
  server.registerTool(
    'context',
    {
      title: 'Get one-hop neighbor context for a symbol',
      description:
        'Resolves symbol (id, qualified_name, name, or FTS best match) then returns the node plus its ' +
        'one-hop neighbors in both directions across every edge kind (native and magento: preference_for, ' +
        'wraps, observes, renders, references), grouped by edge kind, with edge metadata (sortOrder, area, ' +
        'event, reason) parsed and surfaced.',
      inputSchema: {
        symbol: z.string().min(1).describe('Symbol id, qualified_name, or name to get context for'),
        repo: z.string().optional().describe('Registered repo name to restrict the lookup to; omit to search all'),
      },
    },
    async ({ symbol, repo }) => {
      const registry = loadRegistryFromEnv();
      const result = getContext(registry, { symbol, repo });
      return {
        content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
      };
    },
  );
  // --- end tool: context --------------------------------------------------

  // --- tool: impact (task 007) --------------------------------------------
  server.registerTool(
    'impact',
    {
      title: 'Recursive depth-capped impact traversal (native + magento edge kinds)',
      description:
        'Traverses outgoing/incoming/both edges up to depth 4 (native kinds: calls/instantiates/references/imports, ' +
        'AND the LOCKED magento kinds: wraps, preference_for, observes, renders, references) from a resolved symbol, ' +
        'grouped by depth with an edge-kind path per result. direction=dependencies follows outgoing edges, ' +
        'dependents follows incoming edges, both (default) unions them. A stale augmenter marker (codegraph ' +
        'reindexed since the last augment run) produces a LOUD top-level warning and non_authoritative per-repo ' +
        'flag; set strict:true (or env PB_CODEGRAPH_STRICT_STALENESS=1) to refuse instead of warn.',
      inputSchema: {
        symbol: z.string().min(1).describe('Symbol id, qualified_name, or name to compute impact for'),
        repo: z.string().optional().describe('Registered repo name to restrict the lookup to; omit to search all'),
        depth: z
          .number()
          .int()
          .min(1)
          .max(IMPACT_MAX_DEPTH)
          .optional()
          .describe(`Max traversal depth, clamped to ${IMPACT_MAX_DEPTH}`),
        direction: z
          .enum(['dependents', 'dependencies', 'both'])
          .optional()
          .describe('dependents = incoming edges, dependencies = outgoing edges, both = union (default)'),
        strict: z
          .boolean()
          .optional()
          .describe('When true, refuse (throw) instead of warn if the augmenter marker is stale for a queried repo'),
      },
    },
    async ({ symbol, repo, depth, direction, strict }) => {
      const registry = loadRegistryFromEnv();
      const result = getImpact(registry, {
        symbol,
        repo,
        depth,
        direction: direction as ImpactDirection | undefined,
        strict: strict ?? strictStalenessFromEnv(),
      });
      return {
        content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
      };
    },
  );
  // --- end tool: impact -----------------------------------------------------

  // --- tool: query (task 007) -----------------------------------------------
  server.registerTool(
    'query',
    {
      title: 'Named, parameterized query templates',
      description:
        `Runs one of the named templates (${QUERY_TEMPLATE_NAMES.join(', ')}) against a repo or every registered ` +
        'repo — never raw SQL. See docs/query-cookbook.md for each template\'s params and its mapping from the old ' +
        'legacy graph query it replaces.',
      inputSchema: {
        template: z.enum(QUERY_TEMPLATE_NAMES).describe('Named query template to run'),
        params: z.record(z.string(), z.unknown()).describe('Template-specific params (see docs/query-cookbook.md)'),
        repo: z.string().optional().describe('Registered repo name to restrict the query to; omit to search all'),
      },
    },
    async ({ template, params, repo }) => {
      const registry = loadRegistryFromEnv();
      const result = runQuery(registry, { template, params, repo });
      return {
        content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
      };
    },
  );
  // --- end tool: query -------------------------------------------------------

  return server;
}
