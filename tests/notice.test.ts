import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const noticePath = path.join(path.resolve(__dirname, '..'), 'NOTICE');

test('it records vendored-code origin in NOTICE', () => {
  const notice = fs.readFileSync(noticePath, 'utf-8');

  // Identifies the vendored source repo/path
  assert.match(notice, /mage-os-gitnexus/, 'must name the source repo the augmenter was vendored from');
  assert.match(notice, /augmenter/, 'must name the augmenter subdirectory');

  // States the vendored code is Lucas's own MIT-licensed code being relicensed
  assert.match(notice, /MIT/, 'must state the original license of the vendored code');
  assert.match(notice, /Lucas van Staden/, 'must attribute the original author');

  // States what was vendored (parsers + resolvers, not mappers/writer/node-id)
  assert.match(notice, /parsers/i);
  assert.match(notice, /resolvers/i);

  // Relicense-compatibility statement (MIT -> Apache-2.0 is permitted since Lucas owns both)
  assert.match(notice, /Apache/i, 'must state relicense compatibility to Apache-2.0');
});
