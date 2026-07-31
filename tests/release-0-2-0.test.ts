import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');

function readJson(relPath: string): unknown {
  return JSON.parse(fs.readFileSync(path.join(repoRoot, relPath), 'utf-8'));
}

function read(relPath: string): string {
  return fs.readFileSync(path.join(repoRoot, relPath), 'utf-8');
}

test('it bumps 0.2.0 in plugin and marketplace manifests', () => {
  const plugin = readJson('.claude-plugin/plugin.json') as { version: string; description: string };
  assert.equal(plugin.version, '0.2.0', 'plugin.json version must be 0.2.0');
  assert.doesNotMatch(
    plugin.description,
    /^LLM-driven impact.check(\s+only)?$/i,
    'plugin.json description must not describe the plugin as LLM-only anymore',
  );
  assert.match(
    plugin.description,
    /graph|codegraph|deterministic/i,
    'plugin.json description must mention the new deterministic graph capability',
  );

  const marketplace = readJson('.claude-plugin/marketplace.json') as {
    plugins: Array<{ name: string; version: string; description: string }>;
  };
  const entry = marketplace.plugins.find((p) => p.name === 'pb-codegraph');
  assert.ok(entry, 'marketplace.json must list the pb-codegraph plugin entry');
  assert.equal(entry!.version, '0.2.0', 'marketplace.json plugin entry version must be 0.2.0');
  assert.match(
    entry!.description,
    /graph|codegraph|deterministic/i,
    'marketplace.json plugin entry description must mention the new deterministic graph capability',
  );
  assert.doesNotMatch(
    entry!.description,
    /LLM-driven impact check that orchestrates existing tools.*Roadmap: deterministic tree-sitter symbol graph in v0\.2\+/is,
    'marketplace.json description must not still describe the graph as a future roadmap item',
  );

  const pkg = readJson('package.json') as { version: string };
  assert.equal(pkg.version, '0.2.0', 'package.json version must be 0.2.0');
});

test('it documents every deliverable in changelog and readme', () => {
  const changelog = read('CHANGELOG.md');
  assert.match(changelog, /## \[?0\.2\.0\]?/i, 'CHANGELOG.md must carry a 0.2.0 entry');

  // Every task-013-listed deliverable family gets a changelog mention.
  for (const term of [
    /sqlite.writer|writer/i,
    /node.id resolver|node-id/i,
    /mapper/i,
    /augment.*cli|cli wrapper/i,
    /mcp shim|mcp server/i,
    /find_symbol/i,
    /context/i,
    /impact/i,
    /query/i,
    /schema.guard/i,
    /core index/i,
    /ddev cutover|cutover/i,
    /acceptance/i,
  ]) {
    assert.match(changelog, term, `CHANGELOG.md 0.2.0 entry should mention: ${term}`);
  }

  const readme = read('README.md');
  assert.match(readme, /0\.2\.0/, 'README.md must reference 0.2.0');
  assert.match(readme, /augmenter/i, 'README.md must describe the augmenter');
  assert.match(readme, /shim|mcp/i, 'README.md must describe the MCP shim');
  assert.match(readme, /codegraph/i, 'README.md must name the codegraph engine dependency');
  assert.match(
    readme,
    /AWAITING LUCAS SIGN-OFF|not.{0,20}(yet )?(executed|cut over)|awaiting sign.off/i,
    'README.md status must reflect that pps cutover has not been executed / sign-off is pending',
  );
  assert.match(readme, /RECOVERY|restore|rebuild/i, 'README.md must carry restore/recovery notes');
});

test('it updates impact-check command with graph-backend detection', () => {
  const cmd = read('commands/impact-check.md');
  assert.match(cmd, /\.codegraph\/codegraph\.db/, 'command must check for the codegraph db presence');
  assert.match(cmd, /find_symbol/);
  assert.match(cmd, /\bimpact\b/);
  assert.match(cmd, /\bcontext\b/);
  assert.match(cmd, /\bquery\b/);
  assert.match(cmd, /legacy/i, 'command must name the legacy LLM fallback path explicitly');
  assert.match(
    cmd,
    /pb-codegraph/,
    'command must reference the fleet-compat MCP server name the shim is served under',
  );
});

test('it passes the consistency sweep including attribution and no-secrets checks', () => {
  const license = read('LICENSE');
  assert.match(license, /Apache License/i);

  const notice = read('NOTICE');
  assert.ok(notice.length > 0, 'NOTICE must be non-empty');

  // Same pattern .claude/testing.md documents. Lines that only quote the
  // grep pattern itself (this doc line, or a doc citing it verbatim) are
  // self-references, not real secrets — every other hit fails the sweep.
  const secretPattern = /(ff15ea68|9c111c47)/;
  const selfReferenceLine = /grep -rE.*ff15ea68.*9c111c47|secretPattern\s*=/;
  const scanDirs = ['augmenter', 'mcp', 'shared', 'scripts', 'bin', 'docs', 'templates', 'commands', 'tests', '.claude', 'README.md', 'CHANGELOG.md', 'NOTICE', 'LICENSE'];
  for (const rel of scanDirs) {
    const full = path.join(repoRoot, rel);
    if (!fs.existsSync(full)) continue;
    const stat = fs.statSync(full);
    const files: string[] = [];
    if (stat.isDirectory()) {
      const walk = (dir: string) => {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
          if (entry.name === 'node_modules' || entry.name === '.git') continue;
          const p = path.join(dir, entry.name);
          if (entry.isDirectory()) walk(p);
          else files.push(p);
        }
      };
      walk(full);
    } else {
      files.push(full);
    }
    for (const f of files) {
      const content = fs.readFileSync(f, 'utf-8');
      for (const line of content.split('\n')) {
        if (!secretPattern.test(line)) continue;
        assert.match(line, selfReferenceLine, `unexplained secret-shaped hit in ${path.relative(repoRoot, f)}: ${line}`);
      }
    }
  }

  for (const jsonFile of ['.claude-plugin/plugin.json', '.claude-plugin/marketplace.json', 'package.json', 'tsconfig.json']) {
    assert.doesNotThrow(() => readJson(jsonFile), `${jsonFile} must be valid JSON`);
  }
});
