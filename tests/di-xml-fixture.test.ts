import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseSingleDiXml } from '../augmenter/src/parsers/di-xml.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const fixtureRoot = path.join(path.resolve(__dirname, '..'), 'tests', 'fixture');

test('it ships a plugin fixture carrying sortOrder and area attributes', () => {
  const sourceFile = path.join(fixtureRoot, 'app/code/Acme/ModuleA/etc/di.xml');
  const xmlContent = fs.readFileSync(sourceFile, 'utf-8');

  // area is derived from the file path suffix by the vendored parser (etc/di.xml -> 'global')
  const result = parseSingleDiXml(xmlContent, sourceFile, 'global');

  assert.equal(result.plugins.length, 1);
  const [plugin] = result.plugins;
  assert.equal(plugin.targetType, 'Acme\\ModuleA\\Model\\Foo');
  assert.equal(plugin.pluginType, 'Acme\\ModuleA\\Plugin\\FooPlugin');
  assert.equal(plugin.sortOrder, 10, 'plugin fixture must carry a non-default sortOrder');
  assert.equal(plugin.area, 'global', 'plugin fixture must carry the area attribute derived from di.xml scope');
});

test('it parses an absent sortOrder attribute as undefined, never a defaulted 0 (0 is a real declared value)', () => {
  // Evidence (pps live run, 2026-07-31): GrandTotalDetailsPlugin flagged
  // SORTORDER_DRIFT graph=0 vs runtime=1 -- the graph "0" was this parser's
  // own default-fill for an ABSENT sortOrder attribute, not a declaration.
  const xmlContent = `<?xml version="1.0"?>
<config xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:noNamespaceSchemaLocation="urn:magento:framework:ObjectManager/etc/config.xsd">
    <type name="Acme\\ModuleA\\Model\\Foo">
        <plugin name="no_sort_order_plugin" type="Acme\\ModuleA\\Plugin\\FooPlugin" />
    </type>
</config>`;
  const result = parseSingleDiXml(xmlContent, '/fake/etc/di.xml', 'global');

  assert.equal(result.plugins.length, 1);
  assert.equal(
    result.plugins[0].sortOrder,
    undefined,
    'absent sortOrder attribute must parse as undefined, not a defaulted 0',
  );
});
