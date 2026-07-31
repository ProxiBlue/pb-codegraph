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
