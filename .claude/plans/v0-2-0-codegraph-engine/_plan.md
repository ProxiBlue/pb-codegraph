# Plan: pb-codegraph v0.2.0 — GitNexus replacement on codegraph engine

## Created
2026-07-31

## Status
completed

## Objective
Replace the PolyForm-NC-licensed GitNexus stack fleet-wide: colbymchenry/codegraph (MIT) supplies the PHP graph; a ported Magento augmenter injects XML-wiring edges; an MCP compat shim preserves the exact fleet contract (server gitnexus-mageos, 5 tools) so zero rules/playbooks/agents change.

## Related Issues
none (direction: memory project_pb_codegraph_v0_2_direction.md + fleet graphiti fact 2026-07-31)

## Discovery Notes
Spike (host task #11, completed): codegraph 1.5.0 SQLite schema verified — nodes(kind TEXT free), edges(kind TEXT free, metadata JSON, provenance TEXT), files(content_hash), FTS5. Custom-edge injection works; REINDEX CASCADE-DELETES injected edges → augmenter must re-run post-index/sync, idempotent by provenance. 58 files/162ms. Route model: kind='route' nodes + references edges (Drupal config-file recognizer = upstream precedent). Original augmenter at ~/workspace/proxiblue/mage-os-gitnexus/augmenter/: 1680 lines TS — parsers/(di-xml, events-xml, layout-xml, webapi-xml, routes-xml + mappers), resolvers/(node-id, psr4-map, template-path), writer/lbug-writer.ts (347 lines, the ONLY LBUG-specific piece). Port = vendor parsers/resolvers + new sqlite writer + node-id adaptation. Fleet contract (from usage map): list_repos, find_symbol, impact, context, query; impact MUST traverse magento edges (di/events indirection) — hard requirement.

## Scope
### In Scope
- Vendored+ported augmenter with SQLite writer (provenance pb-codegraph-augmenter, idempotent)
- Wrapper CLI (index = codegraph index && augment; staleness marker)
- MCP compat shim: gitnexus-mageos server name, 5 tools, multi-repo registry, schema-version guard
- Shared core index build (mageos/hyva/deps from live-archive; NO scratch git dirs in project trees)
- ddev integration + pps cutover acceptance harness (diff vs live GitNexus)
- v0.1 LLM impact-check kept as no-index fallback
- Upstream Magento-recognizer PR prep (stretch, non-blocking)
### Out of Scope
- Data-flow/table-write edges (v0.4 roadmap)
- Cross-repo call edges (same limitation GitNexus groups had — document)
- Fixing the legacy gitnexus rebuild pipeline (sunk)
- Fleet-wide rollout beyond pps (follow-up per-project work)

## Success Criteria
- [ ] Augmenter injects all 6 edge families (preference, plugin, observer, layout, webapi route, frontend route) into a codegraph SQLite with correct metadata + provenance, idempotent under re-run
- [ ] impact through a di.xml plugin chain and an events.xml observer chain returns the wired classes
- [ ] MCP shim answers all 5 contract tools; pre-flight probe path works
- [ ] Acceptance: impact diff vs live GitNexus on 5 real pps symbols (incl. cross-db + no-wiring negative) reviewed and explained
- [ ] All tests passing; no secrets; Apache-2.0 attribution intact

## Task Overview
| Task | Description | Depends On | Status |
|------|-------------|------------|--------|
| 001 | Vendor PURE parsers/resolvers + fixture tree + corrected edge taxonomy doc | - | completed |
| 002 | SQLite writer (kind remap, metadata, minted-node FTS, concurrency) | 001 | completed |
| 003 | DB-backed node-id resolver (FQCN/File → codegraph ids, minted event/route/template/external) | 001, 002 | completed |
| 003b | Adapt the 5 XML mappers to codegraph node/edge model | 001, 002, 003 | completed |
| 004 | Augment CLI + wrapper index + staleness marker + watcher-race guard | 002, 003, 003b | completed |
| 005 | MCP shim: server skeleton + registry (container paths) + list_repos | - | completed |
| 006 | MCP shim: find_symbol + context | 005 | completed |
| 007 | MCP shim: impact (recursive CTE, remapped kinds) + query templates | 005 | completed |
| 008 | Schema-version guard + codegraph version pin | 005 | completed |
| 009 | Shared core index build script (live-archive, no git dirs) + ignore/vendor-split conversion | - | completed |
| 010 | ddev integration + mcp.json entry + health probe + runtime/path pinning | 004, 007, 009 | completed |
| 011 | Acceptance harness: pps parallel diff vs GitNexus (5 symbols incl. cross-db + negative) | 010 | completed |
| 012 | Upstream Magento-recognizer PR prep (stretch) | 004 | completed |
| 013 | Release 0.2.0: README/CHANGELOG/docs | 001-011, 003b | completed |

## Architecture Notes
- **Port reality (corrected after source review — see _devils_advocate.md C1):** only the pure XML parsers + psr4/template resolvers are vendored verbatim (001). The node-id resolver is a DB-backed REWRITE (003), the writer is new (002), and the 5 mappers are ADAPTED (003b) — the originals hardcode GitNexus synthetic ids, uppercase edge `type`, File-level endpoints, and a filesystem resolver.
- Edge taxonomy (fixed in 001, consumed everywhere) — the writer remaps the vendored `type`+`reason` to these LOCKED lowercase kinds so magento edges never collide with native ones: preference_for (distinct from native `implements`), wraps(metadata sortOrder,area — before/after/around NOT available in v0.2, deferred v0.4), observes(event,area), renders(block class→template node), references(service/controller class↔route node). Minted node kinds: event `magento:event:<name>`, route `magento:route:<area>:<path>`, template `magento:template:<area>:<path>`, external `magento:external:<fqcn>`. All injected rows provenance='pb-codegraph-augmenter', metadata.reason='magento:<source>' preserved. Minted nodes maintained in nodes_fts (002).
- Endpoint model: the vendored mappers emit File:<relpath> endpoints that have NO codegraph node; 003 resolves File→class node, and observer/layout/route families anchor on minted event/route/template nodes (003b). events.xml/routes.xml/.phtml are not code symbols.
- Event impact is name-keyed (observers_of_event template + event-node traversal), NOT dispatch-site graph traversal — codegraph does not index the `dispatch('x')` string arg (v0.2 limitation, dispatch-site recognizer deferred to v0.3).
- Augmenter runs AFTER every codegraph index/sync (cascade wipes injected edges). Wrapper owns ordering; augment guards against the FS-watcher reindexing mid-run (compare max(files.indexed_at) before/after; re-run if it advanced) and uses busy_timeout + a single transaction. The shim checks the staleness marker (project_metadata vs max(files.indexed_at)); for impact (deploy-safety) stale ⇒ LOUD non-authoritative banner + non-green health + optional strict-fail, NOT a soft warn.
- Shim = thin SQL over N registered DBs; federation = query-all+merge, ranked; no cross-db edges.
- Pin codegraph version; startup guard reads schema_versions, refuses unknown with clear message.
- v0.1 impact-check command: detect .codegraph/codegraph.db → use deterministic backend, else legacy LLM flow.

## Risks & Mitigations
- codegraph schema drift on upgrade: version pin + schema_versions guard (008); provenance column loss would be caught by guard tests.
- Node-id mismatch (augmenter targets class not yet indexed / vendor split): placeholder external nodes + nightly re-augment; acceptance diff surfaces gaps.
- impact quality vs GitNexus on generic PHP: accepted (spike calibration); bricklayer remains runtime arbiter; trust-source-over-index rule stands.
- Upstream PR rejected: augmenter keeps covering routes — no dependency.

## Deferred-Question Rulings (post devils-advocate, 2026-07-31)
- Q1: codegraph FS watcher STAYS ENABLED in ddev — native-edge freshness is the core anti-staleness win; magento-edge refresh = wrapper `index` + shim strict-fail on staleness for impact. Watcher-off (`codegraph serve` without watch / debounce tuning) documented in cutover docs as a per-project knob if races surface in practice.
- Q2: dispatch-site recognizer (true graph traversal for event impact) → v0.3 roadmap; 013 README notes it.
- Q3: acceptance = 5 symbols + negative control + Lucas sign-off; full cypher-cookbook side-by-side available on demand at the gate.
