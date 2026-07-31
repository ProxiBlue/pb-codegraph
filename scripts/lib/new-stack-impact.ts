#!/usr/bin/env -S node --import tsx
// pb-codegraph: new file (not vendored). Acceptance-harness helper (task
// 011) — queries the REAL MCP shim (mcp/bin/server.ts) over the real stdio
// transport for the `impact` tool, one call per symbol, using the exact
// same Client/StdioClientTransport pattern as
// tests/mcp-stdio-find-symbol-context.test.ts (not the internal getImpact()
// function directly) so the acceptance comparison exercises actual wiring,
// not just library code.
//
// Usage:
//   node --import tsx scripts/lib/new-stack-impact.ts \
//     --registry <path-to-registry.json> --repo <repo-name> \
//     --symbols <path-to-symbols.json> --out-dir <dir> [--depth 4]
//
// Writes one <out-dir>/<label>.new-stack.json per symbol (the parsed tool
// response body). Exits non-zero and prints an actionable message to
// stderr on ANY failure (server spawn failure, tool error, unparsable
// response) — never writes a partial/empty result file for a failed call,
// so a missing output file is itself the "unreachable backend" signal the
// orchestrating shell script checks for.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..', '..');
const serverEntrypoint = path.join(repoRoot, 'mcp', 'bin', 'server.ts');

interface CliArgs {
  registry: string;
  repo: string;
  symbols: string;
  outDir: string;
  depth: number;
}

function parseArgs(argv: string[]): CliArgs {
  const get = (flag: string): string | undefined => {
    const i = argv.indexOf(flag);
    return i === -1 ? undefined : argv[i + 1];
  };

  const registry = get('--registry');
  const repo = get('--repo');
  const symbols = get('--symbols');
  const outDir = get('--out-dir');
  const depth = get('--depth');

  if (!registry || !repo || !symbols || !outDir) {
    throw new Error(
      'usage: new-stack-impact.ts --registry <path> --repo <name> --symbols <path> --out-dir <dir> [--depth N]',
    );
  }

  return { registry: path.resolve(registry), repo, symbols: path.resolve(symbols), outDir: path.resolve(outDir), depth: depth ? Number(depth) : 4 };
}

interface SymbolEntry {
  label: string;
  new_stack_symbol: string;
}

interface SymbolsFile {
  symbols: SymbolEntry[];
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  if (!fs.existsSync(args.registry)) {
    throw new Error(`new-stack-impact: registry file not found at "${args.registry}"`);
  }
  if (!fs.existsSync(args.symbols)) {
    throw new Error(`new-stack-impact: symbols file not found at "${args.symbols}"`);
  }
  fs.mkdirSync(args.outDir, { recursive: true });

  const symbolsFile = JSON.parse(fs.readFileSync(args.symbols, 'utf-8')) as SymbolsFile;

  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ['--import', 'tsx', serverEntrypoint],
    cwd: repoRoot,
    env: { ...(process.env as Record<string, string>), PB_CODEGRAPH_REGISTRY: args.registry },
  });
  const client = new Client({ name: 'pb-codegraph-acceptance-diff', version: '0.0.0' });

  try {
    await client.connect(transport);

    for (const entry of symbolsFile.symbols) {
      process.stderr.write(`[new-stack-impact] querying "${entry.new_stack_symbol}" (${entry.label})...\n`);
      const result = await client.callTool({
        name: 'impact',
        arguments: { symbol: entry.new_stack_symbol, repo: args.repo, depth: args.depth, direction: 'both' },
      });

      if (result.isError) {
        throw new Error(
          `new-stack-impact: tool call for "${entry.label}" ("${entry.new_stack_symbol}") returned an MCP tool error: ` +
            JSON.stringify(result.content),
        );
      }

      const content = result.content as Array<{ type: string; text?: string }>;
      const text = content.find((c) => c.type === 'text')?.text;
      if (!text) {
        throw new Error(`new-stack-impact: no text content block returned for "${entry.label}"`);
      }

      const parsed: unknown = JSON.parse(text);
      const outFile = path.join(args.outDir, `${entry.label}.new-stack.json`);
      fs.writeFileSync(outFile, JSON.stringify(parsed, null, 2));
      process.stderr.write(`[new-stack-impact]   -> ${outFile}\n`);
    }
  } finally {
    await client.close();
  }
}

main().catch((err) => {
  process.stderr.write(`[new-stack-impact] FAILED: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
