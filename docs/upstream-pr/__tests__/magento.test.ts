/**
 * Tests for Magento 2 / Mage-OS framework resolver.
 *
 * Drop-in location once submitted: __tests__/magento.test.ts (top-level
 * __tests__ dir, matching __tests__/drupal.test.ts's own location — NOT
 * nested under src/resolution/).
 *
 * Unit tests cover magentoResolver.detect(), extract() (routes.xml
 * controller actions + webapi.xml), resolve(), and postExtract() (frontName
 * join). One integration-style test mirrors drupal.test.ts's own "route
 * node linked to controller method" E2E test — a real CodeGraph instance
 * over a temporary Magento module layout — to confirm the full pipeline
 * (extract -> resolve -> postExtract) produces a working
 * route -> controller edge with the frontName correctly joined in.
 *
 * NOTE for reviewers: this file is a draft written against the recognizer
 * spec in docs/upstream-pr/magento-recognizer-spec.md and the draft
 * implementation in docs/upstream-pr/src/magento.ts. It has not been run
 * against the actual colbymchenry/codegraph repo from this sandbox (no
 * checkout of that repo, and its `src/resolution/types`,
 * `src/extraction/grammars`, etc. import paths are not resolvable here) —
 * whoever picks this PR up should run it for real against a checkout before
 * submitting. See docs/upstream-pr/README.md.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { CodeGraph } from '../src';
import { initGrammars, loadAllGrammars } from '../src/extraction/grammars';
import { magentoResolver } from '../src/resolution/frameworks/magento';
import type { ResolutionContext } from '../src/resolution/types';
import type { Node } from '../src/types';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeContext(overrides: Partial<ResolutionContext> = {}): ResolutionContext {
  return {
    getNodesInFile: () => [],
    getNodesByName: () => [],
    getNodesByQualifiedName: () => [],
    getNodesByKind: () => [],
    fileExists: () => false,
    readFile: () => null,
    getProjectRoot: () => '/project',
    getAllFiles: () => [],
    getNodesByLowerName: () => [],
    getImportMappings: () => [],
    ...overrides,
  };
}

const FRONTEND_ROUTES_XML = `<?xml version="1.0"?>
<config xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:noNamespaceSchemaLocation="urn:magento:framework:App/etc/routes.xsd">
    <router id="standard">
        <route id="moduleb" frontName="moduleb">
            <module name="Acme_ModuleB" />
        </route>
    </router>
</config>
`;

const WEBAPI_XML = `<?xml version="1.0"?>
<routes xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:noNamespaceSchemaLocation="urn:magento:module:Magento_Webapi:etc/webapi.xsd">
    <route url="/V1/moduleb/foo" method="GET">
        <service class="Acme\\ModuleA\\Model\\Foo" method="getFoo" />
        <resources>
            <resource ref="anonymous" />
        </resources>
    </route>
</routes>
`;

const CONTROLLER_PHP = `<?php
namespace Acme\\ModuleB\\Controller\\Foo;

use Magento\\Framework\\App\\Action\\Action;
use Magento\\Framework\\App\\Action\\Context;

class Bar extends Action
{
    public function execute()
    {
        return $this->_resultFactory->create(\\Magento\\Framework\\Controller\\ResultFactory::TYPE_PAGE);
    }
}
`;

// ---------------------------------------------------------------------------
// detect()
// ---------------------------------------------------------------------------

describe('magentoResolver.detect', () => {
  it('returns true when composer.json has a magento/ dependency', () => {
    const ctx = makeContext({
      readFile: (f) =>
        f === 'composer.json'
          ? JSON.stringify({ require: { 'magento/framework': '103.0.*', php: '~8.1' } })
          : null,
    });
    expect(magentoResolver.detect(ctx)).toBe(true);
  });

  it('returns true when composer.json type is magento2-module', () => {
    const ctx = makeContext({
      readFile: (f) => (f === 'composer.json' ? JSON.stringify({ type: 'magento2-module' }) : null),
    });
    expect(magentoResolver.detect(ctx)).toBe(true);
  });

  it('returns false when composer.json has no magento/ dependencies', () => {
    const ctx = makeContext({
      readFile: (f) =>
        f === 'composer.json' ? JSON.stringify({ require: { 'laravel/framework': '^10' } }) : null,
    });
    expect(magentoResolver.detect(ctx)).toBe(false);
  });

  it('returns true via the registration.php + module.xml fallback when composer.json is absent', () => {
    const ctx = makeContext({
      readFile: () => null,
      getAllFiles: () => [
        'app/code/Acme/ModuleB/registration.php',
        'app/code/Acme/ModuleB/etc/module.xml',
      ],
    });
    // registration.php content must be read too — override readFile to
    // answer the registration.php probe specifically.
    ctx.readFile = (f) =>
      f === 'app/code/Acme/ModuleB/registration.php'
        ? '<?php \\Magento\\Framework\\Component\\ComponentRegistrar::register(\\Magento\\Framework\\Component\\ComponentRegistrar::MODULE, "Acme_ModuleB", __DIR__);'
        : null;
    expect(magentoResolver.detect(ctx)).toBe(true);
  });

  it('returns false when registration.php exists but etc/module.xml does not', () => {
    const ctx = makeContext({
      readFile: (f) =>
        f === 'app/code/Acme/ModuleB/registration.php'
          ? '<?php \\Magento\\Framework\\Component\\ComponentRegistrar::register(\\Magento\\Framework\\Component\\ComponentRegistrar::MODULE, "Acme_ModuleB", __DIR__);'
          : null,
      getAllFiles: () => ['app/code/Acme/ModuleB/registration.php'],
    });
    expect(magentoResolver.detect(ctx)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// extract() — webapi.xml
// ---------------------------------------------------------------------------

describe('magentoResolver.extract — webapi.xml', () => {
  it('emits a route node with id keyed on the URL alone', () => {
    const { nodes } = magentoResolver.extract!('app/code/Acme/ModuleB/etc/webapi.xml', WEBAPI_XML);
    expect(nodes).toHaveLength(1);
    expect(nodes[0]).toMatchObject({
      id: 'magento:route:webapi:/V1/moduleb/foo',
      kind: 'route',
      name: 'GET /V1/moduleb/foo',
      language: 'xml',
    });
  });

  it('emits a references edge from the route to the service class::method', () => {
    const { references } = magentoResolver.extract!('app/code/Acme/ModuleB/etc/webapi.xml', WEBAPI_XML);
    expect(references).toHaveLength(1);
    expect(references[0]).toMatchObject({
      fromNodeId: 'magento:route:webapi:/V1/moduleb/foo',
      referenceName: 'Acme\\ModuleA\\Model\\Foo::getFoo',
      referenceKind: 'references',
    });
  });

  it('returns empty result for non-webapi/non-php files', () => {
    const { nodes, references } = magentoResolver.extract!(
      'app/code/Acme/ModuleB/etc/di.xml',
      '<config></config>',
    );
    expect(nodes).toHaveLength(0);
    expect(references).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// extract() — routes.xml controller actions (via the controller PHP file)
// ---------------------------------------------------------------------------

describe('magentoResolver.extract — controller actions', () => {
  it('mints a route node for a frontend controller action with a pending frontName', () => {
    const { nodes } = magentoResolver.extract!(
      'app/code/Acme/ModuleB/Controller/Foo/Bar.php',
      CONTROLLER_PHP,
    );
    expect(nodes).toHaveLength(1);
    expect(nodes[0]).toMatchObject({
      kind: 'route',
      name: 'pending:frontend:/<frontName>/foo/bar',
      language: 'php',
    });
  });

  it('emits a references edge from the route to a resolver-scoped controller-class sentinel', () => {
    const { references } = magentoResolver.extract!(
      'app/code/Acme/ModuleB/Controller/Foo/Bar.php',
      CONTROLLER_PHP,
    );
    expect(references).toHaveLength(1);
    expect(references[0].referenceName).toBe('magento:controller-class:Bar');
  });

  it('ignores a plain PHP class that is not a Magento controller', () => {
    const plainClass = `<?php\nnamespace Acme\\ModuleB\\Model;\nclass Foo\n{\n    public function bar() {}\n}\n`;
    const { nodes } = magentoResolver.extract!('app/code/Acme/ModuleB/Model/Foo.php', plainClass);
    expect(nodes).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// claimsReference() / resolve()
// ---------------------------------------------------------------------------

describe('magentoResolver.claimsReference', () => {
  it('claims the controller-class sentinel', () => {
    expect(magentoResolver.claimsReference!('magento:controller-class:Bar')).toBe(true);
  });

  it('claims a webapi service class::method reference', () => {
    expect(magentoResolver.claimsReference!('Acme\\ModuleA\\Model\\Foo::getFoo')).toBe(true);
  });

  it('does not claim an unrelated bare identifier', () => {
    expect(magentoResolver.claimsReference!('someHelperFunction')).toBe(false);
  });
});

describe('magentoResolver.resolve', () => {
  it('resolves the controller-class sentinel to the file-scoped class node', () => {
    const classNode: Node = {
      id: 'class-node-id',
      kind: 'class',
      name: 'Bar',
      qualifiedName: 'app/code/Acme/ModuleB/Controller/Foo/Bar.php::Bar',
      filePath: 'app/code/Acme/ModuleB/Controller/Foo/Bar.php',
      language: 'php',
      startLine: 5,
      endLine: 12,
      startColumn: 0,
      endColumn: 0,
      updatedAt: Date.now(),
    };
    const ctx = makeContext({ getNodesInFile: () => [classNode] });
    const resolved = magentoResolver.resolve(
      {
        fromNodeId: 'magento:route:app/code/Acme/ModuleB/Controller/Foo/Bar.php::route',
        referenceName: 'magento:controller-class:Bar',
        referenceKind: 'references',
        line: 5,
        column: 0,
        filePath: 'app/code/Acme/ModuleB/Controller/Foo/Bar.php',
        language: 'php',
      },
      ctx,
    );
    expect(resolved).toMatchObject({ targetNodeId: 'class-node-id', resolvedBy: 'framework' });
  });

  it('resolves a webapi service class::method to the method node when present', () => {
    const classNode: Node = {
      id: 'class-node-id',
      kind: 'class',
      name: 'Foo',
      qualifiedName: 'app/code/Acme/ModuleA/Model/Foo.php::Foo',
      filePath: 'app/code/Acme/ModuleA/Model/Foo.php',
      language: 'php',
      startLine: 1,
      endLine: 10,
      startColumn: 0,
      endColumn: 0,
      updatedAt: Date.now(),
    };
    const methodNode: Node = {
      ...classNode,
      id: 'method-node-id',
      kind: 'method',
      name: 'getFoo',
      qualifiedName: 'app/code/Acme/ModuleA/Model/Foo.php::Foo::getFoo',
    };
    const ctx = makeContext({
      getNodesByName: (name) => (name === 'Foo' ? [classNode] : []),
      getNodesInFile: () => [classNode, methodNode],
    });
    const resolved = magentoResolver.resolve(
      {
        fromNodeId: 'magento:route:webapi:/V1/moduleb/foo',
        referenceName: 'Acme\\ModuleA\\Model\\Foo::getFoo',
        referenceKind: 'references',
        line: 3,
        column: 0,
        filePath: 'app/code/Acme/ModuleB/etc/webapi.xml',
        language: 'xml',
      },
      ctx,
    );
    expect(resolved).toMatchObject({ targetNodeId: 'method-node-id', confidence: 0.9, resolvedBy: 'framework' });
  });
});

// ---------------------------------------------------------------------------
// postExtract() — frontName join
// ---------------------------------------------------------------------------

describe('magentoResolver.postExtract', () => {
  it('rewrites a pending route node name once the owning module frontName is found', () => {
    const pendingRoute: Node = {
      id: 'magento:route:app/code/Acme/ModuleB/Controller/Foo/Bar.php::route',
      kind: 'route',
      name: 'pending:frontend:/<frontName>/foo/bar',
      qualifiedName: 'app/code/Acme/ModuleB/Controller/Foo/Bar.php::route',
      filePath: 'app/code/Acme/ModuleB/Controller/Foo/Bar.php',
      language: 'php',
      startLine: 5,
      endLine: 5,
      startColumn: 0,
      endColumn: 0,
      updatedAt: Date.now(),
    };
    const ctx = makeContext({
      getAllFiles: () => ['app/code/Acme/ModuleB/etc/frontend/routes.xml'],
      readFile: (f) => (f === 'app/code/Acme/ModuleB/etc/frontend/routes.xml' ? FRONTEND_ROUTES_XML : null),
      getNodesByKind: (kind) => (kind === 'route' ? [pendingRoute] : []),
    });
    const updates = magentoResolver.postExtract!(ctx);
    expect(updates).toHaveLength(1);
    expect(updates[0].id).toBe(pendingRoute.id); // id preserved
    expect(updates[0].qualifiedName).toBe(pendingRoute.qualifiedName); // qualifiedName preserved
    expect(updates[0].name).toBe('frontend:/moduleb/foo/bar');
  });

  it('leaves a route pending (returns no update) when no routes.xml declares its module', () => {
    const pendingRoute: Node = {
      id: 'magento:route:app/code/Acme/ModuleC/Controller/Foo/Bar.php::route',
      kind: 'route',
      name: 'pending:frontend:/<frontName>/foo/bar',
      qualifiedName: 'app/code/Acme/ModuleC/Controller/Foo/Bar.php::route',
      filePath: 'app/code/Acme/ModuleC/Controller/Foo/Bar.php',
      language: 'php',
      startLine: 5,
      endLine: 5,
      startColumn: 0,
      endColumn: 0,
      updatedAt: Date.now(),
    };
    const ctx = makeContext({
      getAllFiles: () => ['app/code/Acme/ModuleB/etc/frontend/routes.xml'],
      readFile: (f) => (f === 'app/code/Acme/ModuleB/etc/frontend/routes.xml' ? FRONTEND_ROUTES_XML : null),
      getNodesByKind: (kind) => (kind === 'route' ? [pendingRoute] : []),
    });
    const updates = magentoResolver.postExtract!(ctx);
    expect(updates).toHaveLength(0);
  });

  it('elides the default index/index action pair down to the bare frontName', () => {
    const pendingRoute: Node = {
      id: 'magento:route:app/code/Acme/ModuleB/Controller/Index/Index.php::route',
      kind: 'route',
      name: 'pending:frontend:/<frontName>',
      qualifiedName: 'app/code/Acme/ModuleB/Controller/Index/Index.php::route',
      filePath: 'app/code/Acme/ModuleB/Controller/Index/Index.php',
      language: 'php',
      startLine: 5,
      endLine: 5,
      startColumn: 0,
      endColumn: 0,
      updatedAt: Date.now(),
    };
    const ctx = makeContext({
      getAllFiles: () => ['app/code/Acme/ModuleB/etc/frontend/routes.xml'],
      readFile: (f) => (f === 'app/code/Acme/ModuleB/etc/frontend/routes.xml' ? FRONTEND_ROUTES_XML : null),
      getNodesByKind: (kind) => (kind === 'route' ? [pendingRoute] : []),
    });
    const updates = magentoResolver.postExtract!(ctx);
    expect(updates[0].name).toBe('frontend:/moduleb');
  });
});

// ---------------------------------------------------------------------------
// End-to-end — route node linked to controller class, frontName resolved
// ---------------------------------------------------------------------------

describe('Magento end-to-end — frontend route resolves to controller class with frontName joined', () => {
  let tmpDir: string;

  beforeAll(async () => {
    await initGrammars();
    await loadAllGrammars();
  });

  afterEach(() => {
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('creates a route -> controller-class edge with the frontName resolved into the route name', async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-magento-'));

    fs.writeFileSync(
      path.join(tmpDir, 'composer.json'),
      JSON.stringify({ require: { 'magento/framework': '103.0.*' } }),
    );

    const modDir = path.join(tmpDir, 'app', 'code', 'Acme', 'ModuleB');
    fs.mkdirSync(path.join(modDir, 'etc', 'frontend'), { recursive: true });
    fs.mkdirSync(path.join(modDir, 'Controller', 'Foo'), { recursive: true });

    fs.writeFileSync(path.join(modDir, 'etc', 'frontend', 'routes.xml'), FRONTEND_ROUTES_XML);
    fs.writeFileSync(path.join(modDir, 'Controller', 'Foo', 'Bar.php'), CONTROLLER_PHP);

    const graph = new CodeGraph({ projectRoot: tmpDir });
    await graph.init();
    await graph.indexAll();

    const routeNodes = await graph.searchNodes({ kind: 'route' });
    const route = routeNodes.find((n) => n.filePath.endsWith('Controller/Foo/Bar.php'));
    expect(route).toBeDefined();
    expect(route!.name).toBe('frontend:/moduleb/foo/bar');

    await graph.close();
  });
});
