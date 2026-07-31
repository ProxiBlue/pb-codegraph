// pb-codegraph: shared scan-root resolution for all Magento XML parsers/mappers.
// Standard project layout scans <root>/vendor + <root>/app/code. When NEITHER
// exists the caller passed a bare module tree (e.g. a core-index source like
// an exported vendor/mage-os), so fall back to scanning the root itself —
// otherwise core augments silently produce zero edges (found via
// verify-wiring on pps, 2026-07-31).
import fs from 'node:fs';
import path from 'node:path';

export function magentoScanRoots(projectRoot: string): string[] {
  const candidates = [path.join(projectRoot, 'vendor'), path.join(projectRoot, 'app', 'code')];
  const existing = candidates.filter((p) => fs.existsSync(p));
  if (existing.length > 0) return existing;
  return [projectRoot];
}
