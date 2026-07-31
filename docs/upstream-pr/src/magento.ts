/**
 * Magento 2 / Mage-OS Framework Resolver
 *
 * Drop-in location once submitted: src/resolution/frameworks/magento.ts
 * (register in src/resolution/frameworks/index.ts's FRAMEWORK_RESOLVERS array,
 * PHP section, alongside laravelResolver/drupalResolver).
 *
 * Full design rationale, node/edge shape justification, and the honesty notes
 * this file's comments reference in short form all live in
 * docs/upstream-pr/magento-recognizer-spec.md (§ numbers below point there).
 *
 * ## What this resolver does
 *
 * 1. **Detection** (spec §2) — composer.json `magento/*` dependency or
 *    package type, falling back to the registration.php + module.xml module
 *    envelope signature for Composer-less trees.
 *
 * 2. **routes.xml route extraction** (spec §4.1-4.3) — per-file `extract()`
 *    mints one `route` node per resolved controller action class
 *    (`Controller/<Path>/<Action>.php`), with a `references` edge from the
 *    route node to the controller class node (route is the source — mirrors
 *    drupalResolver's routeNode -> handler direction). The route's
 *    `frontName` is NOT known at this point (it lives in a sibling
 *    routes.xml, possibly a different file than the controller) — `name`
 *    carries an unresolved placeholder until `postExtract` runs.
 *
 * 3. **postExtract frontName join** (spec §4.2) — a project-wide pass reads
 *    every etc/frontend/routes.xml and etc/adminhtml/routes.xml, builds a
 *    moduleName -> { area -> frontName } map, and rewrites each pending
 *    route node's `name` (id/qualifiedName preserved) to the fully resolved
 *    `<area>:/<frontName>/<path>` string. Mirrors NestJS's postExtract
 *    RouterModule-prefix fixup — same "declared in file A, applies to file
 *    B" shape.
 *
 * 4. **webapi.xml route extraction** (spec §4.4) — single-pass extraction;
 *    URL + method + service class::method are all in one document, so no
 *    postExtract join is needed for this family.
 *
 * ## Design decisions (review in future iterations)
 *
 * - di.xml / events.xml / layout xml (preferences, plugins, observers,
 *   block-template rendering) are explicitly OUT OF SCOPE for this
 *   recognizer. Those are dependency-injection and event-dispatch wiring,
 *   not routing — a natural follow-up PR, not this one. (pb-codegraph, the
 *   downstream consumer this spec was drafted for, already covers that
 *   ground locally via its own SQLite-writer augmenter; see
 *   github.com/ProxiBlue/pb-codegraph docs/edge-taxonomy.md for that
 *   project's independent node/edge design for those four wiring families.)
 * - Admin path prefix (spec §4.2, point 1) is deliberately NOT resolved —
 *   it is a runtime config value (`admin/url/use_custom_path` etc.), not a
 *   static-analysis fact, so the `adminhtml:` area tag is left unprefixed.
 * - Verb-per-controller-action (spec §4.3) is deliberately NOT asserted for
 *   the routes.xml family — Magento does not restrict a controller to one
 *   HTTP verb by declaration.
 *
 * ## TODOs for future iterations
 *
 * - TODO: di.xml preference/plugin edges (separate PR — DI wiring, not
 *   routing).
 * - TODO: events.xml observer edges (separate PR — event dispatch, not
 *   routing).
 * - TODO: layout xml block/template edges (separate PR — view rendering,
 *   not routing).
 * - TODO: resolve the admin path prefix from `env.php`/`config.php` when
 *   present, instead of leaving it unprefixed.
 */

import { Node } from '../../types';
import { FrameworkResolver, ResolutionContext, ResolvedRef, UnresolvedRef } from '../types';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Parse the last PHP namespace segment from a FQCN like `\Acme\ModuleA\Model\Foo`. */
function lastSegment(fqcn: string): string | null {
  const clean = fqcn.replace(/^\\+/, '').trim();
  if (!clean.includes('\\')) return clean || null;
  const parts = clean.split('\\');
  return parts[parts.length - 1] ?? null;
}

/** `FooBar` -> `foo_bar` — Magento's URL-segment casing convention for both
 * controller directory/class names and action method names. */
function toUrlSegment(name: string): string {
  return name
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .toLowerCase();
}

/** `app/code/<Vendor>/<Module>/Controller/...` -> `Vendor_Module`, the exact
 * module-name string Magento's own registration.php/module.xml declare.
 * Returns null for a controller file not nested under a Vendor/Module pair
 * two segments above a `Controller/` directory (defensive — malformed or
 * unconventional trees should no-op, not throw). */
function moduleNameFromControllerPath(filePath: string): string | null {
  const match = filePath.match(/(?:^|\/)([^/]+)\/([^/]+)\/Controller\//);
  return match ? `${match[1]}_${match[2]}` : null;
}

/** True for a `Controller/<Path>/<Action>.php` path (frontend or adminhtml —
 * the adminhtml case is just `Controller/Adminhtml/<Path>/<Action>.php`,
 * still matched by the same `/Controller\//` anchor). */
function isControllerFile(filePath: string): boolean {
  return /\/Controller\/.+\.php$/.test(filePath) && filePath.endsWith('.php');
}

/** `Controller/Foo/Bar.php` -> ['Foo'], 'Bar' (path segments, action segment).
 * `Controller/Adminhtml/Widget/Edit.php` -> ['Adminhtml', 'Widget'], 'Edit'
 * — the leading `Adminhtml` segment is stripped by the caller once area is
 * known (spec §4.2 point 2); kept here so this helper stays area-agnostic. */
function controllerPathSegments(filePath: string): { dirSegments: string[]; action: string } | null {
  const match = filePath.match(/\/Controller\/(.+)\.php$/);
  if (!match) return null;
  const parts = match[1]!.split('/');
  const action = parts.pop();
  if (!action) return null;
  return { dirSegments: parts, action };
}

/** True when the file's class implements/extends one of Magento's controller
 * markers. Deliberately regex-based (not AST-based) — matches the same
 * "conventionally named / conventionally shaped file" heuristic Drupal's
 * `isDrupalHookFile` and NestJS's decorator scan both already use for
 * framework detection, rather than requiring a full PHP AST walk here. */
function looksLikeMagentoController(content: string): boolean {
  return (
    /implements\s+[^{]*ActionInterface/.test(content) ||
    /extends\s+\\?Magento\\Framework\\App\\Action\\Action\b/.test(content) ||
    /extends\s+\\?Action\b/.test(content)
  ) && /function\s+execute\s*\(/.test(content);
}

/** First `class <Name>` declaration's simple name + 1-indexed line, or null. */
function findClassDeclaration(content: string): { name: string; line: number } | null {
  const lines = content.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i]!.match(/\bclass\s+(\w+)/);
    if (m) return { name: m[1]!, line: i + 1 };
  }
  return null;
}

// ---------------------------------------------------------------------------
// routes.xml (frontName declarations) — parsed for the postExtract join only
// ---------------------------------------------------------------------------

/** module name -> { area -> frontName }, built once per postExtract call from
 * every etc/frontend/routes.xml and etc/adminhtml/routes.xml in the project. */
function collectFrontNames(context: ResolutionContext): Map<string, Map<string, string>> {
  const result = new Map<string, Map<string, string>>();

  for (const filePath of context.getAllFiles()) {
    const areaMatch = filePath.match(/\/etc\/(frontend|adminhtml)\/routes\.xml$/);
    if (!areaMatch) continue;
    const area = areaMatch[1]!;
    const content = context.readFile(filePath);
    if (!content) continue;

    // Minimal attribute-scoped scan — a full XML parser is unnecessary for
    // this well-known, three-attribute element shape (mirrors Drupal's own
    // line-oriented routing.yml scan rather than pulling in a YAML/XML
    // dependency for one recognizer).
    const routeBlocks = content.match(/<route\b[^>]*>[\s\S]*?<\/route>/g) ?? [];
    for (const block of routeBlocks) {
      const frontNameMatch = block.match(/frontName="([^"]+)"/);
      if (!frontNameMatch) continue;
      const frontName = frontNameMatch[1]!;
      const moduleMatches = block.matchAll(/<module\s+name="([^"]+)"/g);
      for (const moduleMatch of moduleMatches) {
        const moduleName = moduleMatch[1]!;
        if (!result.has(moduleName)) result.set(moduleName, new Map());
        result.get(moduleName)!.set(area, frontName);
      }
    }
  }

  return result;
}

// ---------------------------------------------------------------------------
// webapi.xml extraction
// ---------------------------------------------------------------------------

function extractWebapiRoutes(
  filePath: string,
  content: string,
): { nodes: Node[]; references: UnresolvedRef[] } {
  const nodes: Node[] = [];
  const references: UnresolvedRef[] = [];
  const now = Date.now();

  const routeBlocks = content.matchAll(/<route\b([^>]*)>([\s\S]*?)<\/route>/g);
  for (const routeMatch of routeBlocks) {
    const attrs = routeMatch[1]!;
    const body = routeMatch[2]!;
    const urlMatch = attrs.match(/url="([^"]+)"/);
    const methodMatch = attrs.match(/method="([^"]+)"/);
    const serviceMatch = body.match(/<service\s+class="([^"]+)"\s+method="([^"]+)"/);
    if (!urlMatch || !methodMatch || !serviceMatch) continue;

    const url = urlMatch[1]!;
    const httpMethod = methodMatch[1]!;
    const serviceClass = serviceMatch[1]!;
    const serviceMethod = serviceMatch[2]!;

    // 1-indexed line of the opening <route tag — good enough for node
    // identity purposes (routes.xml files are small, hand-authored).
    const line = content.slice(0, routeMatch.index ?? 0).split('\n').length;

    const routeId = `magento:route:webapi:${url}`;
    const routeNode: Node = {
      id: routeId,
      kind: 'route',
      name: `${httpMethod} ${url}`,
      qualifiedName: `${filePath}::route:${url}`,
      filePath,
      language: 'xml',
      startLine: line,
      endLine: line,
      startColumn: 0,
      endColumn: 0,
      updatedAt: now,
    };
    nodes.push(routeNode);

    // Route is the source, service class::method is the (unresolved) target —
    // mirrors drupalResolver.extract's routeNode -> handler direction exactly
    // (see docs/upstream-pr/magento-recognizer-spec.md § 4 for why this
    // resolver follows Drupal's route-is-source convention rather than the
    // opposite direction pb-codegraph's own local, unrelated augmenter uses).
    references.push({
      fromNodeId: routeId,
      referenceName: `${serviceClass}::${serviceMethod}`,
      referenceKind: 'references',
      line,
      column: 0,
      filePath,
      language: 'xml',
    });
  }

  return { nodes, references };
}

// ---------------------------------------------------------------------------
// routes.xml controller-action extraction (per PHP file)
// ---------------------------------------------------------------------------

function extractControllerRoute(
  filePath: string,
  content: string,
): { nodes: Node[]; references: UnresolvedRef[] } {
  if (!isControllerFile(filePath) || !looksLikeMagentoController(content)) {
    return { nodes: [], references: [] };
  }
  const cls = findClassDeclaration(content);
  const segments = controllerPathSegments(filePath);
  if (!cls || !segments) return { nodes: [], references: [] };

  const area = segments.dirSegments[0] === 'Adminhtml' ? 'adminhtml' : 'frontend';
  const pathDirs = area === 'adminhtml' ? segments.dirSegments.slice(1) : segments.dirSegments;
  const rawPath = [...pathDirs, segments.action].map(toUrlSegment).join('/');
  // Magento's default-action elision (spec §4.2 point 2): Controller/Index/
  // Index.php is reachable at the bare frontName in addition to
  // .../index/index — drop the segment when it's exactly that default pair.
  const pathSegments = rawPath === 'index/index' ? '' : rawPath;

  const now = Date.now();
  const routeId = `magento:route:${filePath}::route`;
  // Placeholder name until postExtract resolves the owning module's
  // frontName (spec §4.2) — kept human-readable so an un-joined route (no
  // matching routes.xml) is still legible, not cryptic, per spec §4.2's
  // "left with its unresolved placeholder name and is NOT dropped" note.
  const routeNode: Node = {
    id: routeId,
    kind: 'route',
    name: `pending:${area}:/<frontName>${pathSegments ? '/' + pathSegments : ''}`,
    qualifiedName: `${filePath}::route`,
    filePath,
    language: 'php',
    startLine: cls.line,
    endLine: cls.line,
    startColumn: 0,
    endColumn: 0,
    updatedAt: now,
  };

  // Route is the source, controller class is the (unresolved) target — same
  // direction as the webapi.xml edges above and as drupalResolver's
  // routeNode -> handler references. `referenceName` is a resolver-private
  // sentinel (not a bare class name) so resolve() can look the class up
  // file-scoped (context.getNodesInFile(ref.filePath)) instead of a global
  // by-name search — plain names like "Index" or "Edit" are extremely
  // common across unrelated Magento modules' controllers, so a global
  // by-name match (Drupal's approach for _form's bare-FQCN case) would be
  // ambiguous here in a way it isn't for Drupal's one-controller-per-name
  // fixtures. See claimsReference below for the matching prefix check.
  return {
    nodes: [routeNode],
    references: [
      {
        fromNodeId: routeId,
        referenceName: `magento:controller-class:${cls.name}`,
        referenceKind: 'references',
        line: cls.line,
        column: 0,
        filePath,
        language: 'php',
      },
    ],
  };
}

// ---------------------------------------------------------------------------
// Resolver
// ---------------------------------------------------------------------------

export const magentoResolver: FrameworkResolver = {
  name: 'magento',
  languages: ['php', 'xml'],

  detect(context: ResolutionContext): boolean {
    const composer = context.readFile('composer.json');
    if (composer) {
      try {
        const json = JSON.parse(composer) as {
          type?: string;
          require?: Record<string, string>;
          'require-dev'?: Record<string, string>;
        };
        if (typeof json.type === 'string' && json.type.startsWith('magento2-')) return true;
        const deps = { ...json.require, ...(json['require-dev'] ?? {}) };
        if (Object.keys(deps).some((k) => k.startsWith('magento/'))) return true;
      } catch {
        // malformed composer.json — fall through to file-signature detection
      }
    }

    const files = context.getAllFiles();
    const hasRegistration = files.some((f) => f.endsWith('registration.php'));
    if (!hasRegistration) return false;
    const registrationContent = files
      .filter((f) => f.endsWith('registration.php'))
      .map((f) => context.readFile(f))
      .find((c) => c && c.includes('ComponentRegistrar::MODULE'));
    if (!registrationContent) return false;
    return files.some((f) => f.endsWith('etc/module.xml'));
  },

  // Three shapes name no declared symbol from resolveOne's perspective, so
  // the default pre-filter would drop each before resolve() ever runs (spec
  // §5): a bare FQCN (`Acme\ModuleA\Model\Foo`), a `class::method` webapi
  // service ref, and this resolver's own `magento:controller-class:<Name>`
  // sentinel (see extractControllerRoute's comment for why that sentinel
  // exists instead of a bare class name).
  claimsReference(name: string): boolean {
    return (
      name.startsWith('magento:controller-class:') ||
      name.includes('\\') ||
      /^[A-Za-z_]\w*::\w+$/.test(name)
    );
  },

  resolve(ref: UnresolvedRef, context: ResolutionContext): ResolvedRef | null {
    // routes.xml controller-class sentinel (spec §4.1) — file-scoped lookup,
    // deliberately not a global by-name search (see extractControllerRoute).
    if (ref.referenceName.startsWith('magento:controller-class:')) {
      const className = ref.referenceName.slice('magento:controller-class:'.length);
      const cls = context
        .getNodesInFile(ref.filePath)
        .find((n) => n.kind === 'class' && n.name === className);
      if (cls) {
        return { original: ref, targetNodeId: cls.id, confidence: 0.95, resolvedBy: 'framework' };
      }
      return null;
    }

    // webapi.xml service class::method (spec §4.4) — mirrors Drupal's
    // `_controller` two-tier method/class fallback.
    const serviceMatch = ref.referenceName.match(/^([^:]+)::(\w+)$/);
    if (serviceMatch) {
      const [, fqcn, methodName] = serviceMatch;
      const className = lastSegment(fqcn!);
      if (className) {
        const classNodes = context.getNodesByName(className);
        for (const cls of classNodes) {
          if (cls.kind !== 'class') continue;
          const fileNodes = context.getNodesInFile(cls.filePath);
          const method = fileNodes.find((n) => n.kind === 'method' && n.name === methodName);
          if (method) {
            return { original: ref, targetNodeId: method.id, confidence: 0.9, resolvedBy: 'framework' };
          }
          return { original: ref, targetNodeId: cls.id, confidence: 0.7, resolvedBy: 'framework' };
        }
      }
    }

    return null;
  },

  extract(filePath: string, content: string): { nodes: Node[]; references: UnresolvedRef[] } {
    if (filePath.endsWith('webapi.xml')) {
      return extractWebapiRoutes(filePath, content);
    }
    if (filePath.endsWith('.php')) {
      return extractControllerRoute(filePath, content);
    }
    return { nodes: [], references: [] };
  },

  // Joins routes.xml frontName declarations against the pending controller
  // route nodes extract() already minted (spec §4.2/§4.3). Node `id` and
  // `qualifiedName` are preserved byte-for-byte — only `name` is rewritten —
  // satisfying the interface's "node id MUST be preserved so existing edges
  // ... stay intact" contract.
  postExtract(context: ResolutionContext): Node[] {
    const frontNames = collectFrontNames(context);
    if (frontNames.size === 0) return [];

    const updates: Node[] = [];
    for (const route of context.getNodesByKind('route')) {
      if (!route.qualifiedName.endsWith('::route')) continue; // webapi routes have no pending state
      if (!route.name.startsWith('pending:')) continue;

      const moduleName = moduleNameFromControllerPath(route.filePath);
      if (!moduleName) continue;
      const areaMap = frontNames.get(moduleName);
      if (!areaMap) continue;

      const withoutPrefix = route.name.slice('pending:'.length); // "<area>:/<frontName>/<path>"
      const area = withoutPrefix.split(':')[0]!;
      const frontName = areaMap.get(area);
      if (!frontName) continue;

      const resolvedName = withoutPrefix.replace('<frontName>', frontName);
      updates.push({ ...route, name: resolvedName });
    }
    return updates;
  },
};
