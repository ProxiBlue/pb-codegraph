#!/usr/bin/env -S node --import tsx
// pb-codegraph: new file (not vendored). Acceptance-harness helper (task
// 011) — queries the LIVE GitNexus MCP server over its streamable-HTTP
// JSON-RPC transport (no host port; reached via the container's docker0
// bridge IP — see docs/acceptance-report-pps-2026-07-31.md "How the
// backends were reached") for the `impact` tool. GitNexus's impact tool
// requires a literal "upstream" or "downstream" direction (no "both"), so
// this calls it twice per symbol and writes BOTH raw responses — the
// classifier (scripts/lib/classify-acceptance.ts) merges them to match the
// new stack's direction:"both" semantics.
//
// Usage:
//   node --import tsx scripts/lib/gitnexus-impact.ts \
//     --base-url http://<container-ip>:4747/api/mcp --repo <gitnexus-repo-name> \
//     --symbols <path-to-symbols.json> --out-dir <dir> [--max-depth 4]
//
// Fails loudly (nonzero exit, actionable stderr message) on ANY transport
// failure (connection refused/timeout, non-200, bad JSON-RPC envelope,
// tool-level isError) — never writes a partial output file for a failed
// call. This is what lets scripts/acceptance-diff.sh's "unreachable backend
// -> abort, no partial verdict" requirement hold.
import fs from 'node:fs';
import path from 'node:path';

interface CliArgs {
  baseUrl: string;
  repo: string;
  symbols: string;
  outDir: string;
  maxDepth: number;
}

function parseArgs(argv: string[]): CliArgs {
  const get = (flag: string): string | undefined => {
    const i = argv.indexOf(flag);
    return i === -1 ? undefined : argv[i + 1];
  };

  const baseUrl = get('--base-url');
  const repo = get('--repo');
  const symbols = get('--symbols');
  const outDir = get('--out-dir');
  const maxDepth = get('--max-depth');

  if (!baseUrl || !repo || !symbols || !outDir) {
    throw new Error(
      'usage: gitnexus-impact.ts --base-url <url> --repo <name> --symbols <path> --out-dir <dir> [--max-depth N]',
    );
  }

  return { baseUrl, repo, symbols, outDir: path.resolve(outDir), maxDepth: maxDepth ? Number(maxDepth) : 4 };
}

interface SymbolEntry {
  label: string;
  gitnexus_target: string;
  gitnexus_file_path: string;
}

interface SymbolsFile {
  symbols: SymbolEntry[];
}

/** GitNexus's streamable-HTTP transport replies with an SSE-framed body
 * ("event: message\ndata: {...}\n\n") even for a single-shot JSON-RPC
 * call — this extracts the JSON payload from the last `data:` line. */
function parseSseBody(body: string): unknown {
  const lines = body.split('\n').filter((l) => l.startsWith('data:'));
  if (lines.length === 0) {
    throw new Error(`gitnexus-impact: response body had no "data:" line to parse — raw body: ${body.slice(0, 500)}`);
  }
  const lastData = lines[lines.length - 1].slice('data:'.length).trim();
  return JSON.parse(lastData);
}

interface JsonRpcEnvelope {
  jsonrpc: '2.0';
  id?: number | string | null;
  result?: unknown;
  error?: { code: number; message: string };
}

async function rpcCall(
  baseUrl: string,
  sessionId: string | undefined,
  id: number,
  method: string,
  params: Record<string, unknown> | undefined,
): Promise<{ envelope: JsonRpcEnvelope; sessionId: string | undefined }> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Accept: 'application/json, text/event-stream',
  };
  if (sessionId) headers['mcp-session-id'] = sessionId;

  const body: Record<string, unknown> = { jsonrpc: '2.0', method };
  if (id >= 0) body.id = id;
  if (params) body.params = params;

  let res: Response;
  try {
    res = await fetch(baseUrl, { method: 'POST', headers, body: JSON.stringify(body) });
  } catch (err) {
    throw new Error(
      `gitnexus-impact: UNREACHABLE — connection to "${baseUrl}" failed for method "${method}": ` +
        `${err instanceof Error ? err.message : String(err)}`,
    );
  }

  const returnedSessionId = res.headers.get('mcp-session-id') ?? sessionId;

  if (method === 'notifications/initialized') {
    // A notification gets no JSON-RPC response body (202/204 accepted).
    return { envelope: { jsonrpc: '2.0' }, sessionId: returnedSessionId };
  }

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`gitnexus-impact: HTTP ${res.status} from "${baseUrl}" for method "${method}": ${text.slice(0, 500)}`);
  }

  const text = await res.text();
  const envelope = parseSseBody(text) as JsonRpcEnvelope;
  if (envelope.error) {
    throw new Error(`gitnexus-impact: JSON-RPC error for method "${method}": ${JSON.stringify(envelope.error)}`);
  }
  return { envelope, sessionId: returnedSessionId };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  if (!fs.existsSync(args.symbols)) {
    throw new Error(`gitnexus-impact: symbols file not found at "${args.symbols}"`);
  }
  fs.mkdirSync(args.outDir, { recursive: true });

  const symbolsFile = JSON.parse(fs.readFileSync(args.symbols, 'utf-8')) as SymbolsFile;

  process.stderr.write(`[gitnexus-impact] initializing session against ${args.baseUrl} ...\n`);
  const init = await rpcCall(args.baseUrl, undefined, 1, 'initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'pb-codegraph-acceptance-diff', version: '0.0.0' },
  });
  const sessionId = init.sessionId;
  if (!sessionId) {
    throw new Error('gitnexus-impact: UNREACHABLE — no mcp-session-id header returned from initialize');
  }
  await rpcCall(args.baseUrl, sessionId, -1, 'notifications/initialized', undefined);
  process.stderr.write(`[gitnexus-impact] session established (${sessionId})\n`);

  let callId = 2;
  for (const entry of symbolsFile.symbols) {
    for (const direction of ['upstream', 'downstream'] as const) {
      process.stderr.write(
        `[gitnexus-impact] querying "${entry.gitnexus_target}" (${entry.label}, ${direction})...\n`,
      );
      const { envelope } = await rpcCall(args.baseUrl, sessionId, callId++, 'tools/call', {
        name: 'impact',
        arguments: {
          target: entry.gitnexus_target,
          direction,
          file_path: entry.gitnexus_file_path,
          repo: args.repo,
          maxDepth: args.maxDepth,
        },
      });

      const result = envelope.result as { content?: Array<{ type: string; text?: string }>; isError?: boolean } | undefined;
      if (!result) {
        throw new Error(`gitnexus-impact: no "result" in tools/call response for "${entry.label}" (${direction})`);
      }
      if (result.isError) {
        throw new Error(
          `gitnexus-impact: tool call for "${entry.label}" (${direction}) returned an MCP tool error: ` +
            JSON.stringify(result.content),
        );
      }
      const text = result.content?.find((c) => c.type === 'text')?.text;
      if (!text) {
        throw new Error(`gitnexus-impact: no text content block returned for "${entry.label}" (${direction})`);
      }

      // GitNexus appends a human "---\n**Next:** ..." footer after the JSON
      // blob in its tool text output — strip it before parsing.
      const jsonEnd = text.lastIndexOf('\n\n---');
      const jsonText = jsonEnd === -1 ? text : text.slice(0, jsonEnd);
      const parsed: unknown = JSON.parse(jsonText);

      const outFile = path.join(args.outDir, `${entry.label}.gitnexus.${direction}.json`);
      fs.writeFileSync(outFile, JSON.stringify(parsed, null, 2));
      process.stderr.write(`[gitnexus-impact]   -> ${outFile}\n`);
    }
  }
}

main().catch((err) => {
  process.stderr.write(`[gitnexus-impact] FAILED: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
