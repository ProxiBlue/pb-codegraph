import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const fixtureRoot = path.join(path.resolve(__dirname, '..'), 'tests', 'fixture');

function read(relPath: string): string {
  return fs.readFileSync(path.join(fixtureRoot, relPath), 'utf-8');
}

function listPhpFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listPhpFiles(full));
    else if (entry.name.endsWith('.php') && entry.name !== 'registration.php') out.push(full);
  }
  return out;
}

test('it ships a fixture module tree covering all six edge families plus one unresolved-target case for external minting', () => {
  // Two modules
  assert.ok(fs.existsSync(path.join(fixtureRoot, 'app', 'code', 'Acme', 'ModuleA')), 'ModuleA missing');
  assert.ok(fs.existsSync(path.join(fixtureRoot, 'app', 'code', 'Acme', 'ModuleB')), 'ModuleB missing');

  // Edge family 1+2: preference + plugin in di.xml
  const diXmlA = read('app/code/Acme/ModuleA/etc/di.xml');
  assert.match(diXmlA, /<preference\s+for="Acme\\ModuleA\\Api\\FooInterface"\s+type="Acme\\ModuleA\\Model\\Foo"\s*\/>/);
  assert.match(diXmlA, /<plugin\s+name="foo_plugin"\s+type="Acme\\ModuleA\\Plugin\\FooPlugin"/);
  assert.match(diXmlA, /<virtualType\s+name="Acme\\ModuleA\\Model\\FooVirtual"/);

  // Edge family 3: observer (events.xml with 2 observers)
  const eventsXml = read('app/code/Acme/ModuleB/etc/frontend/events.xml');
  const observerMatches = eventsXml.match(/<observer\s/g) ?? [];
  assert.equal(observerMatches.length, 2, 'expected exactly 2 observers in events.xml');

  // Edge family 4: layout block + template
  const layoutXml = read('app/code/Acme/ModuleB/view/frontend/layout/acme_moduleb_index_index.xml');
  assert.match(layoutXml, /<block\s+class="Acme\\ModuleA\\Model\\Foo"[^>]*template="Acme_ModuleB::foo\.phtml"/);
  assert.ok(
    fs.existsSync(path.join(fixtureRoot, 'app/code/Acme/ModuleB/view/frontend/templates/foo.phtml')),
    'referenced template file must physically exist for template-path resolver',
  );

  // Edge family 5: webapi route
  const webapiXml = read('app/code/Acme/ModuleB/etc/webapi.xml');
  assert.match(webapiXml, /<route\s+url="\/V1\/moduleb\/foo"\s+method="GET"/);
  assert.match(webapiXml, /<service\s+class="Acme\\ModuleA\\Model\\Foo"\s+method="getFoo"/);

  // Edge family 6: frontend route
  const routesXml = read('app/code/Acme/ModuleB/etc/frontend/routes.xml');
  assert.match(routesXml, /<route\s+id="moduleb"\s+frontName="moduleb"/);
  assert.match(routesXml, /<module\s+name="Acme_ModuleB"/);

  // 3 PHP classes/interfaces
  const phpFiles = listPhpFiles(fixtureRoot);
  assert.equal(phpFiles.length, 3, `expected exactly 3 PHP class/interface files, found ${phpFiles.length}: ${phpFiles.join(', ')}`);

  // Unresolved-target case for external minting: a di.xml preference/plugin
  // whose target FQCN has no backing PHP file anywhere in the fixture tree.
  const diXmlB = read('app/code/Acme/ModuleB/etc/di.xml');
  assert.match(diXmlB, /<type\s+name="Magento\\Catalog\\Model\\Product">/);
  assert.match(diXmlB, /<plugin\s+name="unresolved_plugin"/);
  const externalFile = path.join(fixtureRoot, 'app/code/Magento/Catalog/Model/Product.php');
  assert.equal(fs.existsSync(externalFile), false, 'external target Magento\\Catalog\\Model\\Product must NOT be present in the fixture tree');
});
