#!/usr/bin/env -S node --import tsx
// pb-codegraph: new file (not vendored). Acceptance-harness helper (task
// 011) — reads the raw per-symbol JSON already written by
// scripts/lib/new-stack-impact.ts and scripts/lib/legacy-impact.ts and
// produces a PER-IMPACTED-NODE classification for each symbol:
//
//   both-found     same file_path reached at the same mapped depth on both
//                  backends.
//   different-set  same file_path reached on BOTH backends but at a
//                  DIFFERENT depth (or via a different walk direction) —
//                  the devils-advocate "most dangerous" case: both tools
//                  agree the file is impacted but disagree on how close,
//                  which could mislead depth-based risk triage.
//   new-stack-only file_path reached by pb-codegraph but not by the legacy tool.
//   legacy-only  file_path reached by the legacy tool but not by pb-codegraph.
//
// Methodology note (see docs/acceptance-report-pps-2026-07-31.md
// "Comparison methodology"): the two backends report impacted nodes at
// different granularities (pb-codegraph: method/field/class/minted-node
// ids; legacy tool: File:/Class:<file>:<name> ids). This classifier compares
// at FILE_PATH granularity (deduped, minimum depth per direction) — the
// coarsest granularity both backends share — rather than pretending a
// finer-grained match is meaningful across two different node models.
// Direction mapping: pb-codegraph "dependencies" (outgoing) <->
// the legacy tool's "downstream" (what this depends on); pb-codegraph "dependents"
// (incoming) <-> the legacy tool's "upstream" (what depends on this).
//
// Usage:
//   node --import tsx scripts/lib/classify-acceptance.ts \
//     --symbols <path-to-symbols.json> --results-dir <dir> \
//     [--out <classification.json>] [--md <classification.md>]
import fs from 'node:fs';
import path from 'node:path';

interface CliArgs {
  symbols: string;
  resultsDir: string;
  out?: string;
  md?: string;
}

function parseArgs(argv: string[]): CliArgs {
  const get = (flag: string): string | undefined => {
    const i = argv.indexOf(flag);
    return i === -1 ? undefined : argv[i + 1];
  };
  const symbols = get('--symbols');
  const resultsDir = get('--results-dir');
  if (!symbols || !resultsDir) {
    throw new Error('usage: classify-acceptance.ts --symbols <path> --results-dir <dir> [--out <file>] [--md <file>]');
  }
  return { symbols, resultsDir, out: get('--out'), md: get('--md') };
}

interface SymbolEntry {
  label: string;
  category: string;
  description: string;
  new_stack_symbol: string;
  legacy_target: string;
  legacy_file_path: string;
}

interface SymbolsFile {
  legacy_repo: string;
  symbols: SymbolEntry[];
}

type MappedDirection = 'outgoing' | 'incoming';

interface FileHit {
  filePath: string;
  direction: MappedDirection;
  depth: number;
  edgeKinds: string[];
}

type Classification = 'both-found' | 'different-set' | 'new-stack-only' | 'legacy-only';

interface NodeClassification {
  file_path: string;
  classification: Classification;
  new_stack?: { direction: MappedDirection; depth: number; edge_kinds: string[] };
  legacy?: { direction: MappedDirection; depth: number; relation_types: string[] };
}

interface SymbolClassification {
  label: string;
  category: string;
  description: string;
  new_stack_found: boolean;
  legacy_found: boolean;
  new_stack_root_node?: { qualified_name: string; kind: string; augmenter_status: string };
  legacy_root_node?: { id: string; name: string };
  magento_kind_edges_new_stack: Array<{ file_path: string; kind: string; depth: number }>;
  nodes: NodeClassification[];
  counts: Record<Classification, number>;
}

function readJson(file: string): unknown {
  return JSON.parse(fs.readFileSync(file, 'utf-8'));
}

const MAGENTO_KINDS = new Set(['wraps', 'preference_for', 'observes', 'renders']);
// 'references' is deliberately excluded from MAGENTO_KINDS: it collides with
// codegraph's own native reference-edge kind name (see
// docs/edge-taxonomy.md "Why a remap table exists" — the same IMPLEMENTS
// collision problem C2 warned about, recurring for `references`). Only
// wraps/preference_for/observes/renders are unambiguous augmenter-only
// kinds by name alone.

function collectNewStackHits(newStackResult: unknown): { hits: FileHit[]; magentoEdges: FileHit[]; found: boolean; rootNode?: { qualified_name: string; kind: string; augmenter_status: string } } {
  const data = newStackResult as {
    results: Array<{
      node: { qualified_name: string; kind: string; file_path: string };
      augmenter_status: string;
      results_by_depth: Record<string, Array<{ direction: string; depth: number; edge_kind_path: string[]; node: { file_path: string; kind: string } }>>;
    }>;
  };

  if (!data.results || data.results.length === 0) {
    return { hits: [], magentoEdges: [], found: false };
  }

  const repoResult = data.results[0];
  const byFilePath = new Map<string, FileHit>();
  const magentoEdges: FileHit[] = [];

  for (const rows of Object.values(repoResult.results_by_depth)) {
    for (const row of rows) {
      const direction: MappedDirection = row.direction === 'dependencies' ? 'outgoing' : 'incoming';
      const lastKind = row.edge_kind_path[row.edge_kind_path.length - 1];
      const filePath = row.node.file_path || `<minted:${row.node.kind}>`;

      if (MAGENTO_KINDS.has(lastKind)) {
        magentoEdges.push({ filePath, direction, depth: row.depth, edgeKinds: row.edge_kind_path });
      }

      // Real (non-minted) file-backed nodes only participate in the
      // cross-backend file_path comparison — minted nodes (event/route/
      // template/external) have no legacy-tool counterpart by construction.
      if (!row.node.file_path) continue;

      // `contains` (structural class->field/method/constant containment)
      // and same-file self-hits are excluded from the file-path comparison:
      // the legacy impact tool never reports pure structural containment or
      // the queried symbol's own file back to itself as an "impacted" node
      // (it only walks CALLS/IMPORTS/EXTENDS/IMPLEMENTS/HAS_METHOD/...), so
      // including pb-codegraph's `contains` rows here would manufacture
      // "new-stack-only" noise that is not a real cross-backend divergence
      // — see docs/acceptance-report-pps-2026-07-31.md "Comparison
      // methodology".
      if (lastKind === 'contains') continue;
      if (filePath === repoResult.node.file_path) continue;

      const key = `${direction}:${filePath}`;
      const existing = byFilePath.get(key);
      if (!existing || row.depth < existing.depth) {
        byFilePath.set(key, { filePath, direction, depth: row.depth, edgeKinds: row.edge_kind_path });
      }
    }
  }

  return {
    hits: [...byFilePath.values()],
    magentoEdges,
    found: true,
    rootNode: { qualified_name: repoResult.node.qualified_name, kind: repoResult.node.kind, augmenter_status: repoResult.augmenter_status },
  };
}

function collectLegacyHits(
  upstream: unknown,
  downstream: unknown,
): { hits: FileHit[]; found: boolean; rootNode?: { id: string; name: string } } {
  const up = upstream as { target?: { id: string; name: string }; byDepth?: Record<string, Array<{ filePath: string; depth: number; relationType: string }>> };
  const down = downstream as { target?: { id: string; name: string }; byDepth?: Record<string, Array<{ filePath: string; depth: number; relationType: string }>> };

  // The legacy server returns a `target` object (with `id` unset-looking defaults)
  // even for an unresolved symbol in some server versions, so "found" is
  // judged by whether a non-empty filePath is present on the target.
  const found = Boolean(up.target?.id || down.target?.id);
  const rootNode = up.target?.id ? up.target : down.target;

  const byFilePath = new Map<string, FileHit>();
  const merge = (byDepth: Record<string, Array<{ filePath: string; depth: number; relationType: string }>> | undefined, direction: MappedDirection) => {
    if (!byDepth) return;
    for (const rows of Object.values(byDepth)) {
      for (const row of rows) {
        const key = `${direction}:${row.filePath}`;
        const existing = byFilePath.get(key);
        if (!existing || row.depth < existing.depth) {
          byFilePath.set(key, { filePath: row.filePath, direction, depth: row.depth, edgeKinds: [row.relationType] });
        }
      }
    }
  };
  // the legacy tool's "upstream" = what depends on this = pb-codegraph "dependents" (incoming).
  merge(up.byDepth, 'incoming');
  // the legacy tool's "downstream" = what this depends on = pb-codegraph "dependencies" (outgoing).
  merge(down.byDepth, 'outgoing');

  return { hits: [...byFilePath.values()], found, rootNode: rootNode as { id: string; name: string } | undefined };
}

function classifySymbol(entry: SymbolEntry, resultsDir: string): SymbolClassification {
  const newStackRaw = readJson(path.join(resultsDir, `${entry.label}.new-stack.json`));
  const legacyUpstreamRaw = readJson(path.join(resultsDir, `${entry.label}.legacy.upstream.json`));
  const legacyDownstreamRaw = readJson(path.join(resultsDir, `${entry.label}.legacy.downstream.json`));

  const newStack = collectNewStackHits(newStackRaw);
  const legacy = collectLegacyHits(legacyUpstreamRaw, legacyDownstreamRaw);

  const newStackByKey = new Map(newStack.hits.map((h) => [`${h.direction}:${h.filePath}`, h]));
  const legacyByKey = new Map(legacy.hits.map((h) => [`${h.direction}:${h.filePath}`, h]));

  const allKeys = new Set([...newStackByKey.keys(), ...legacyByKey.keys()]);
  const nodes: NodeClassification[] = [];
  const counts: Record<Classification, number> = { 'both-found': 0, 'different-set': 0, 'new-stack-only': 0, 'legacy-only': 0 };

  for (const key of allKeys) {
    const ns = newStackByKey.get(key);
    const gn = legacyByKey.get(key);
    const filePath = (ns ?? gn)!.filePath;

    let classification: Classification;
    if (ns && gn) {
      classification = ns.depth === gn.depth ? 'both-found' : 'different-set';
    } else if (ns) {
      classification = 'new-stack-only';
    } else {
      classification = 'legacy-only';
    }
    counts[classification]++;

    nodes.push({
      file_path: filePath,
      classification,
      ...(ns ? { new_stack: { direction: ns.direction, depth: ns.depth, edge_kinds: ns.edgeKinds } } : {}),
      ...(gn ? { legacy: { direction: gn.direction, depth: gn.depth, relation_types: gn.edgeKinds } } : {}),
    });
  }

  nodes.sort((a, b) => a.file_path.localeCompare(b.file_path));

  return {
    label: entry.label,
    category: entry.category,
    description: entry.description,
    new_stack_found: newStack.found,
    legacy_found: legacy.found,
    new_stack_root_node: newStack.rootNode,
    legacy_root_node: legacy.rootNode,
    magento_kind_edges_new_stack: newStack.magentoEdges.map((e) => ({ file_path: e.filePath, kind: e.edgeKinds[e.edgeKinds.length - 1], depth: e.depth })),
    nodes,
    counts,
  };
}

function toMarkdown(symbols: SymbolClassification[]): string {
  const lines: string[] = [];
  for (const sym of symbols) {
    lines.push(`### ${sym.label} (${sym.category})`);
    lines.push('');
    lines.push(sym.description);
    lines.push('');
    lines.push(`- new-stack found root symbol: ${sym.new_stack_found}`);
    lines.push(`- legacy found root symbol: ${sym.legacy_found}`);
    lines.push(
      `- magento-kind edges (new stack only, by construction): ${sym.magento_kind_edges_new_stack.length === 0 ? 'none' : sym.magento_kind_edges_new_stack.map((e) => `${e.kind}->${e.file_path}@d${e.depth}`).join(', ')}`,
    );
    lines.push(
      `- per-file-path classification counts: both-found=${sym.counts['both-found']}, different-set=${sym.counts['different-set']}, new-stack-only=${sym.counts['new-stack-only']}, legacy-only=${sym.counts['legacy-only']}`,
    );
    lines.push('');
    lines.push('| file_path | classification | new-stack (dir@depth) | legacy (dir@depth) |');
    lines.push('|---|---|---|---|');
    for (const n of sym.nodes) {
      const ns = n.new_stack ? `${n.new_stack.direction}@${n.new_stack.depth}` : '-';
      const gn = n.legacy ? `${n.legacy.direction}@${n.legacy.depth}` : '-';
      lines.push(`| ${n.file_path} | ${n.classification} | ${ns} | ${gn} |`);
    }
    lines.push('');
  }
  return lines.join('\n');
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  const symbolsFile = JSON.parse(fs.readFileSync(args.symbols, 'utf-8')) as SymbolsFile;

  const classifications = symbolsFile.symbols.map((entry) => classifySymbol(entry, args.resultsDir));

  const output = JSON.stringify({ symbols: classifications }, null, 2);
  if (args.out) {
    fs.writeFileSync(args.out, output);
  } else {
    process.stdout.write(output + '\n');
  }

  if (args.md) {
    fs.writeFileSync(args.md, toMarkdown(classifications));
  }
}

main();
