// pb-codegraph: new file (not vendored). The legacy augmenter's
// resolvers/node-id.ts is filesystem/synthetic-id based (`NodeIdResolver`,
// `fs.existsSync`, synthetic `Class:<path>:<Name>` ids) and never queries a
// DB — see _devils_advocate.md C1. This is a from-scratch, DB-backed
// rewrite: it resolves Magento FQCNs (from di.xml/events.xml/webapi.xml/
// routes.xml/layout xml) to existing codegraph nodes via qualified_name
// lookup, and mints deterministic placeholder ids (event/route/template/
// external) so augmenter edges never dangle. Pure/DB-read-only — this
// module never writes; the writer (see writer/sqlite-writer.ts) owns all
// inserts, including inserting any minted AugmentNode this resolver hands
// back.
import type Database from 'better-sqlite3';

/**
 * Result of a resolution attempt. `minted` is true when `id` does not (yet)
 * exist as a row in the `nodes` table — the caller (003b's mappers) must
 * include `node` in the AugmentNode batch handed to the writer so the id
 * becomes real. `minted` is false when `id` already refers to a native
 * codegraph-indexed row.
 */
export interface ResolvedNode {
  id: string;
  minted: boolean;
  node?: import('../writer/sqlite-writer.ts').AugmentNode;
}

interface NativeNodeRow {
  id: string;
}

/**
 * Strips a leading namespace separator and collapses doubled backslashes
 * (as can appear from XML/PHP double-quoted-string escaping of `\\`) down
 * to codegraph's single-backslash namespace convention. Does NOT touch the
 * `::` codegraph uses between namespace and symbol name — that conversion
 * is `fqcnToQualifiedName`'s job, not normalization.
 */
export function normalizeFqcn(fqcn: string): string {
  return fqcn.trim().replace(/\\{2,}/g, '\\').replace(/^\\+/, '');
}

/**
 * Converts a normalized FQCN (`Ns\Sub\ClassName`) into codegraph's
 * qualified_name shape for the class/interface node it names
 * (`Ns\Sub::ClassName`) — characterized against the real fixture db in the
 * "it characterizes codegraph qualified_name format..." test: codegraph
 * turns the LAST backslash (the one separating namespace from symbol name)
 * into `::`, not every separator.
 */
export function fqcnToQualifiedName(fqcn: string): string {
  const normalized = normalizeFqcn(fqcn);
  const lastSeparator = normalized.lastIndexOf('\\');
  if (lastSeparator === -1) return normalized;
  return `${normalized.slice(0, lastSeparator)}::${normalized.slice(lastSeparator + 1)}`;
}

function findNativeNode(db: Database.Database, kinds: string[], qualifiedName: string): NativeNodeRow | undefined {
  const placeholders = kinds.map(() => '?').join(', ');
  return db
    .prepare(`SELECT id FROM nodes WHERE kind IN (${placeholders}) AND qualified_name = ? LIMIT 1`)
    .get(...kinds, qualifiedName) as NativeNodeRow | undefined;
}

/**
 * Resolves a class/interface FQCN to its native codegraph node id. Always
 * checks native nodes FIRST (see _devils_advocate.md I2) — a symbol
 * codegraph has since indexed supersedes any external placeholder minted by
 * a prior run, because minting is skipped entirely once the native row is
 * found. Falls back to a deterministic minted `external` placeholder
 * (`magento:external:<normalized-fqcn>`) when no native class/interface
 * node exists for it, so callers (003b's mappers) never dangle an edge.
 */
export function resolveClass(db: Database.Database, fqcn: string): ResolvedNode {
  const qualifiedName = fqcnToQualifiedName(fqcn);
  const native = findNativeNode(db, ['class', 'interface'], qualifiedName);
  if (native) return { id: native.id, minted: false };

  const normalized = normalizeFqcn(fqcn);
  const lastSeparator = normalized.lastIndexOf('\\');
  const name = lastSeparator === -1 ? normalized : normalized.slice(lastSeparator + 1);
  return {
    id: mintExternalId(fqcn),
    minted: true,
    node: { id: mintExternalId(fqcn), kind: 'external', name, qualifiedName: normalized },
  };
}

export function mintExternalId(fqcn: string): string {
  return `magento:external:${normalizeFqcn(fqcn)}`;
}

/** `magento:event:<name>` — see docs/edge-taxonomy.md "Node kinds". Pure
 * function of `name`, so re-runs mint the identical id (see the "stable
 * across runs" acceptance criterion). */
export function mintEventId(name: string): string {
  return `magento:event:${name}`;
}

/** `magento:route:<area>:<path>` — e.g.
 * `magento:route:webapi:/V1/moduleb/foo`, `magento:route:frontend:moduleb`. */
export function mintRouteId(area: string, routePath: string): string {
  return `magento:route:${area}:${routePath}`;
}

/** `magento:template:<area>:<path>` — e.g.
 * `magento:template:frontend:Acme_ModuleB::foo.phtml`. */
export function mintTemplateId(area: string, templatePath: string): string {
  return `magento:template:${area}:${templatePath}`;
}

/**
 * Resolves a class FQCN + method name (e.g. webapi.xml's
 * `<service class="..." method="...">`) to the native `method` node when
 * codegraph indexed it (qualified_name `<class-qualified-name>::<method>`,
 * per the characterization test). Falls back to the owning class node
 * (task 003 spec: "method-level targets to method nodes where present, fall
 * back to class node") — which itself falls back to a minted `external`
 * placeholder if even the class isn't indexed.
 */
export function resolveMethod(db: Database.Database, fqcn: string, methodName: string): ResolvedNode {
  const methodQualifiedName = `${fqcnToQualifiedName(fqcn)}::${methodName}`;
  const native = findNativeNode(db, ['method'], methodQualifiedName);
  if (native) return { id: native.id, minted: false };

  return resolveClass(db, fqcn);
}

/**
 * Resolves a `File:<relpath>` endpoint (the shape the vendored, un-adapted
 * mappers emit — see docs/edge-taxonomy.md "Endpoint model" and
 * _devils_advocate.md C3) to the class/interface node actually defined in
 * that file, by querying `nodes.file_path`. Accepts a bare relpath too (no
 * "File:" prefix) for callers that already stripped it. Always a native
 * lookup — a project-local PHP file this resolver is asked about is
 * expected to already be indexed by codegraph; if it isn't, that's a real
 * resolution failure (not an unresolved-3rd-party case, which is what
 * `resolveClass`'s external-minting fallback is for), so this throws an
 * actionable error rather than silently minting.
 */
export function resolveFileEndpoint(db: Database.Database, fileEndpoint: string): ResolvedNode {
  const relPath = fileEndpoint.startsWith('File:') ? fileEndpoint.slice('File:'.length) : fileEndpoint;
  const row = db
    .prepare(`SELECT id FROM nodes WHERE kind IN ('class', 'interface') AND file_path = ? LIMIT 1`)
    .get(relPath) as NativeNodeRow | undefined;
  if (!row) {
    throw new Error(
      `node-id resolver: no class/interface node found for file "${relPath}" — ` +
        'expected this file to already be indexed by codegraph (checked nodes.file_path)',
    );
  }
  return { id: row.id, minted: false };
}
