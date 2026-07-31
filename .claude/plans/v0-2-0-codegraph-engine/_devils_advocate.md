# Devil's Advocate Review: v0-2-0-codegraph-engine

Reviewed against actual vendored source at
`/home/lucas/workspace/proxiblue/mage-os-gitnexus/augmenter/src/` (the code the plan
ports). Several findings contradict the plan's central premise ("vendor parsers +
resolvers unchanged, replace only the writer"). Evidence cited per finding.

## Critical (Must fix before building)

### C1 — "Vendor parsers/resolvers unchanged" is false; the mappers are the port
The plan (001 desc, 002 context "parsers/mappers plug in unchanged") assumes only
`writer/lbug-writer.ts` is replaced. The actual source shows the **mappers** are the
GitNexus-coupled layer and cannot be vendored verbatim:
- `parsers/di-xml-mapper.ts:23` does `new NodeIdResolver(psr4Map, projectRoot)` and
  emits synthetic ids `Class:path:Name` (`node-id.ts:64`), not codegraph `class:<hash>`.
- Every mapper hardcodes `import { AugmentEdge } from '../writer/lbug-writer.js'` and the
  old id scheme.
- `resolvers/node-id.ts` is **filesystem-based** (`fs.existsSync`, `node-id.ts:54`) and
  returns synthetic ids. It never queries a DB. Task 003 calls this an "adaptation" — it
  is a from-scratch DB-backed rewrite, and the mappers that call it must change too.
Fix: task 001 vendors only the pure XML parsers + psr4/template resolvers verbatim.
Mapper adaptation is now an explicit task (new **003b**). node-id.ts and lbug-writer.ts
are re-implemented (003/002), NOT vendored.

### C2 — Locked edge taxonomy does not match what the code emits (kind names + collisions)
The taxonomy locked in 001 / _plan.md (preference_for, wraps, observes, renders,
references, all lowercase) does not match the mapper output:

| Family | Emitted `type` | Emitted `reason` | Endpoints |
|---|---|---|---|
| preference | `IMPLEMENTS` (di-xml-mapper.ts:54) | magento:di:preference | Class→Interface |
| plugin | `WRAPS` (di-xml-mapper.ts:81) | magento:di:plugin | Class→Class |
| observer | `CALLS` (events-xml.ts:161) | magento:events:observer:<event> | File→File |
| layout | `CALLS` (layout-xml-mapper.ts:51) | magento:layout:block-template | File→File |
| webapi | `HANDLES_ROUTE` (webapi-xml.ts:165) | magento:webapi:route | File→Route |
| routes | `HANDLES_ROUTE` (routes-xml.ts:159) | magento:routes:controller | File→Route |

Two problems: (a) `preference` maps to `IMPLEMENTS` — **indistinguishable from codegraph's
native `implements` edge** except by provenance; (b) `observer` and `layout` both use
`CALLS`. If the writer stores `type` verbatim, the impact CTE (007) that keys on magento
kind names will never find them. A remap table (type+reason → locked kind) is mandatory
and unowned. Fix: remap table added to task 002; impact CTE (007) keys on remapped kinds.

### C3 — 4 of 6 edge families use `File:` endpoints that have no codegraph node
Observer, layout edges are `File:<a> → File:<b>` (events-xml.ts:141/156,
layout-xml-mapper.ts:47-52). routes/webapi source from `File:<routes.xml>` /
`File:<service.php>`. codegraph indexes PHP **symbols** (nodes look like `class:<hash>`),
and `events.xml` / `routes.xml` / `.phtml` are not PHP symbols it will node-ify at all.
So these edge endpoints resolve to nothing. Task 003 only specs FQCN→class/method
resolution; it is silent on File-endpoint resolution and on the fact that events.xml has
no node. This makes the observer/layout/route families dangle or mint garbage.
Fix: re-model in 003/003b — observer source becomes a minted `event` node
(`magento:event:<name>`) → observer **class** node; layout becomes block **class** →
minted `template` node; routes/webapi source resolves the service/controller to its class
node, target is the minted `route` node. Task 003 must resolve `File:<relpath>` → the
class/symbol node defined in that file.

### C4 — Impact "method dispatching an event reaches observers" (007 test 2) is unimplementable as written
The observer edge links the **events.xml file** to the observer, keyed by event name in
`reason` (events-xml.ts:163). Nothing links the PHP **dispatch call-site**
(`$eventManager->dispatch('x')`) to the event. codegraph's generic tree-sitter PHP does
not capture the string argument of `dispatch()` as a structured edge. So no graph path
exists from a dispatching method to its observers. This is deploy-safety-critical (the
hard fleet contract: impact must traverse events indirection). Fix: 007 rescoped — observer
traversal goes through the minted event node (`observes` edges) and the
`observers_of_event` query template; the dispatch-site→event link is documented as a v0.2
limitation + optional stretch (dispatch-site recognizer). The test asserting method→observer
graph traversal is replaced with event-node + query-template assertions.

### C5 — Concurrency: watcher reindex silently wipes injected edges; warn-only recreates the stale-index uselessness
codegraph auto-syncs (FS watcher, 2s debounce) and REINDEX CASCADE-DELETES injected edges
(spike fact). There is no daemon re-running the augmenter, so any watcher-triggered reindex
(a dev saving a file in the ddev container) leaves impact returning **native-only** results
(no plugins/observers/preferences) until someone manually runs `pb-codegraph index`. The
shim only WARNS (005 context, 007). For a deploy-safety tool, a soft warn is exactly the
stale-index failure Lucas is fleeing. Additionally two writers (augmenter + watcher) on one
SQLite file → `SQLITE_BUSY`; no task sets `busy_timeout`, WAL awareness, or retry, and no
task guards the augmenter against a watcher reindex firing mid-augment (which would
cascade-delete the rows it is inserting). Fix: 002/004 set `busy_timeout`, wrap augment in a
transaction, and capture `max(files.indexed_at)` before+after augment — if it advanced, the
watcher reindexed mid-run → re-augment. 007 makes impact staleness a LOUD banner (not a soft
warn) and non-green in the health probe; strict-fail mode available.

### C6 — FTS5 maintenance for minted nodes is a soft "document it" but must be a hard requirement
`nodes_fts` is content-linked (spike). If it is external-content without triggers, minted
route/event/template/external nodes inserted into `nodes` will be **invisible to
find_symbol's FTS path** (006 test 2), and `INSERT OR IGNORE` on a content table can desync
rowids. Task 002 only says "document FTS rebuild step" in context. Fix: 002 gets a hard
requirement to maintain `nodes_fts` for every minted node (trigger-aware); 006 gets a test
that find_symbol returns a minted route/event node via FTS.

## Important (Should fix before building)

### I1 — `wraps` metadata (sortOrder, area) dropped by mapper; `type=before/after/around` not obtainable
Taxonomy promises `wraps(sortOrder, area, type=before/after/around)` and 006/007 test for
it. di-xml.ts DOES parse sortOrder + area (di-xml.ts:90/92) but the mapper drops them
(di-xml-mapper.ts:78-84 emits only type/confidence/reason). Worse, before/after/around is a
per-**method** property of the plugin PHP class (method-name prefix), not present in di.xml
at all — not obtainable in v0.2 without parsing plugin class methods. Fix: 003b forwards
sortOrder+area into `wraps` metadata; taxonomy (001) drops before/after/around from required
metadata for v0.2 (deferred to v0.4, note in doc). Requires AugmentEdge to gain a `metadata`
field (002).

### I2 — Node-id minting collision / dedup missing
Minted `external` placeholders can collide with codegraph's own later indexing of the same
class (same qualified_name, different id). The old writer AVOIDED this by
`filterEdgesByExistingNodes` (lbug-writer.ts:305) — dropping edges with missing endpoints
rather than minting. The plan chose minting but never specced reconciliation. Fix: 003 —
external ids deterministic from normalized qualified_name; resolver re-checks native nodes
FIRST on every run so a now-indexed symbol supersedes a prior placeholder; 002's
delete-own-provenance cycle cleans orphaned placeholders.

### I3 — Vendor-split indexing genuinely unspecced
The old system had custom + vendor-split DBs; `filterEdgesByExistingNodes` exists precisely
because the augmenter parses project-wide `vendor/` + `app/code` (di-xml.ts:130-133) while
the index covered a subset. Task 009 does shared cores; 010 mentions vendor-split "in
passing". No task specs the per-project ignore config that must exclude shared cores
(`vendor/mage-os`, `vendor/hyva-themes`) yet INCLUDE 3rd-party `vendor/*`. Without it, a
custom plugin wrapping a 3rd-party vendor class has no target node. Fix: firm requirement
added to 009 (ignore-config generation) and 010 (per-project vendor DB layout).

### I4 — Registry paths / container runtime duality under-specified
Shim runs in-container (stdio spawned by claude); core DBs live at `~/.pb-codegraph/indexes`
on the HOST. Registry `db_path` (005 example `/path/.codegraph/...`) must be the
**container-visible** path, and indexing (npx codegraph, node) must be available where it
runs. Editing `.ddev` to add the read-only core-index mount triggers the fleet LIVE-branch
rule. `better-sqlite3` is a native module needing the container's node ABI. None of this is
pinned. Fix: 005 requires container-path registry entries; 010 pins where indexing runs,
node/npx-in-container, the read-only mount + LIVE-branch requirement, and the sqlite-runtime
choice; 002 requires the chosen sqlite binding to load in the ddev container, not just host.

### I5 — Acceptance (011) coverage thin for a deploy-safety swap
3 hand-picked symbols is a smoke, not coverage, and the three diff categories
(both-found / new-only / gitnexus-only) miss the most dangerous case: **both found the
symbol but returned different impacted sets** (partial agreement). Fix: 011 adds a cross-DB
case (custom plugin on a mageos class, exercising federation) and a negative case (a symbol
with no magento wiring, to prove no false edges), and classifies per-impacted-node including
a "different-set/partial" category.

## Minor (Nice to address)

- M1: `confidence` (always 1.0 in every mapper) is dead data in the codegraph model — drop
  it or fold into metadata; don't carry a column for it.
- M2: routes.xml produces no route→controller edge (Magento resolves frontName→controller by
  convention, not declared). The `references(route→handler)` taxonomy label overstates what
  exists; the route node stands mostly alone in v0.2. Document honestly.
- M3: 013 depends on `001-011` but 011 is a human sign-off gate — release cannot be a purely
  automated task; note the manual gate explicitly in 013.

## Questions for the Team

- Q1: Is warn-only staleness genuinely acceptable for impact, or should the ddev integration
  disable codegraph's FS watcher entirely and make `pb-codegraph index` the sole writer
  (removing the mid-augment race at its root)? (Bears on C5's final shape.)
- Q2: Is a dispatch-site recognizer (linking `dispatch('x')` call-sites to event nodes) worth
  scheduling for v0.3 so event-impact becomes true graph traversal rather than
  name-keyed query? (Bears on C4.)
- Q3: Are 3 acceptance symbols enough for Lucas's sign-off, or should the gate require the
  full GitNexus cypher-cookbook examples re-run side-by-side?
