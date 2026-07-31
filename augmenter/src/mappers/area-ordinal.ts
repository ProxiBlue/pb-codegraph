// pb-codegraph: shared per-area edge-identity helper for the Magento XML
// mappers (di-xml-mapper.ts, events-xml-mapper.ts). Magento modules can
// register the SAME observer/plugin/preference on the SAME
// event/target/for-type in MULTIPLE areas -- e.g. `etc/events.xml` (global)
// AND `etc/adminhtml/events.xml` for the identical observer+event, or
// `etc/di.xml` (global) AND `etc/frontend/di.xml` for the identical
// plugin+target (real core example: Magento\Tax's GrandTotalDetailsPlugin is
// declared in both). The augmenter's `wraps`/`observes`/`preference_for`
// edges never carry a native source-file line/col of their own (they are
// minted from XML declarations, not PHP symbol coordinates), so every area's
// edge for the same (source, target, kind) tuple previously shared the exact
// same (line=null, col=null) pair. codegraph's `idx_edges_identity` unique
// index is `(source, target, kind, IFNULL(line,-1), IFNULL(col,-1))`, so the
// second area's `INSERT OR IGNORE` silently dropped the row (found via
// verify-wiring on real pps data, 2026-07-31 -- Magento\Csp\Observer::Render's
// `etc/events.xml` (global) registration vanished, leaving only the
// `etc/adminhtml/events.xml` one).
//
// Fix: give each area a stable, small, deterministic ordinal and store it in
// the edge's `line` field. This is explicitly NOT a source-file line number
// -- it exists purely so the unique index treats each area's registration of
// the same wiring as a distinct row. See docs/edge-taxonomy.md's "observes
// identity note" for the on-disk contract this encodes.
const AREA_ORDINALS: Readonly<Record<string, number>> = {
  global: 1,
  frontend: 2,
  adminhtml: 3,
  webapi_rest: 4,
  webapi_soap: 5,
  crontab: 6,
};

/** Any area string not in the table above (an area pattern this augmenter
 * doesn't yet recognize) still gets a stable, non-conflicting ordinal rather
 * than colliding with a recognized area's slot. */
export const FALLBACK_AREA_ORDINAL = 9;

export function areaOrdinal(area: string): number {
  return AREA_ORDINALS[area] ?? FALLBACK_AREA_ORDINAL;
}
