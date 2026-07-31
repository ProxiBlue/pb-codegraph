# Query Cookbook — `query(template, params)`

`query` is NOT a raw-SQL passthrough (see `.claude/code-standards.md`). It
only accepts one of the six named templates below, each a fixed prepared
statement over `nodes`/`edges` — the only caller-controlled input is bound
params, validated per template (`mcp/src/query.ts`). This doc maps each
template to the old GitNexus/LBUG cypher pattern it replaces, so anyone
migrating a playbook query from the pre-pb-codegraph tool has a direct
translation.

**Provenance note on the cypher shown below:** the old GitNexus mappers
(`lbug-writer.ts` and friends) are explicitly NOT vendored into this repo
(see task 001 scope boundary / `docs/edge-taxonomy.md`), so these are
reconstructed representative examples of the query shapes the fleet's
playbooks actually used against the old LBUG graph (edge types `CALLS`,
`WRAPPED_BY`, `OBSERVED_BY`, `HANDLES_ROUTE`, `PREFERRED_BY`) — not a copy
of a specific file. The point of the mapping is the edge-family
correspondence, not cypher-for-cypher fidelity.

## `callers_of`

**Params:** `{ symbol: string }` — a node id, `qualified_name`, or bare name
(resolved the same way as `find_symbol`/`context`).

**Returns:** every node with an incoming NATIVE edge (`calls`, `instantiates`,
`references`, `imports` — `provenance IS NULL`) pointing at the resolved
symbol. Deliberately excludes the augmenter's own `references` rows
(webapi/routes wiring reuses the `references` kind name — see
`docs/edge-taxonomy.md` — so `provenance IS NULL` is what keeps "who calls
this" from being polluted by "what route points at this").

**Old GitNexus equivalent:**
```cypher
MATCH (caller)-[r:CALLS|REFERENCES|IMPORTS]->(target {id: $id})
RETURN caller, r
```

## `wired_plugins_on`

**Params:** `{ symbol: string }` — the plugin TARGET class/method.

**Returns:** the plugin class(es) di.xml wires onto this target, via the
`wraps` edge (source = target class, target = plugin class — see
`docs/edge-taxonomy.md`'s corrected endpoint model), with `sortOrder`/`area`
metadata surfaced.

**Old GitNexus equivalent:**
```cypher
MATCH (target {id: $id})-[r:WRAPPED_BY]->(plugin)
RETURN plugin, r.sortOrder, r.area
```

## `observers_of_event`

**Params:** `{ event: string }` — the bare event name (e.g.
`checkout_cart_save_after`), not a node id.

**Returns:** the observer class(es) events.xml wires onto that event, via
the `observes` edge (source = minted `event` node, target = observer
class).

**v0.2 scope limitation (see task 007 / `_devils_advocate.md` C4):**
codegraph's generic PHP indexer does not capture the string argument of
`$eventManager->dispatch('event_name')` as a structured edge, so there is
NO graph path from a PHP method that dispatches an event to that event's
observers. `observers_of_event` (name-keyed, starting from the event node)
is the only way v0.2 answers "who observes this event" — a
dispatch-site recognizer that would let `impact`/`callers_of` traverse
FROM a dispatching method TO its observers is deferred to a v0.3 stretch.

**Old GitNexus equivalent:**
```cypher
MATCH (e:Event {name: $eventName})-[r:OBSERVED_BY]->(observer)
RETURN observer, r
```

## `routes_to`

**Params:** `{ route: string }` — the route path (webapi, e.g.
`/V1/moduleb/foo`) or route id (routes.xml, e.g. `moduleb`) as minted by the
augmenter (`magento:route:<area>:<path>`'s `name`, not its full id).

**Returns:** the service/controller class(es) wired to that route, via the
`references` edge (source = class node, target = minted `route` node — see
`docs/edge-taxonomy.md`'s corrected endpoint model; the direction is
resolved, not the ambiguous "↔" the taxonomy doc shows for the family in
the abstract).

**Route honesty note (inherited from `docs/edge-taxonomy.md`):** for the
`routes.xml` family specifically, Magento resolves `frontName -> controller`
by URL convention at runtime, not by declaration — `routes_to` only ever
returns what the augmenter actually wrote an edge for (the declaring
module/class), never a resolved "the" controller that doesn't exist as an
edge in v0.2.

**Old GitNexus equivalent:**
```cypher
MATCH (svc)-[r:HANDLES_ROUTE]->(route:Route {path: $routePath})
RETURN svc, r
```

## `preferences_for`

**Params:** `{ symbol: string }` — an interface OR a concrete class id/
qualified_name/name.

**Returns:** BOTH directions of di.xml preference redirection in one call —
outgoing `preference_for` edges (this symbol is the interface; the row is
the concrete class it's redirected to) UNIONed with incoming `preference_for`
edges (this symbol is the class; the row is the interface it substitutes
for). Each row is tagged `direction: 'outgoing' | 'incoming'` so callers can
tell which case applied without needing to already know whether `symbol`
was an interface or a class.

**Old GitNexus equivalent:**
```cypher
MATCH (i)-[r:PREFERRED_BY]-(c)
WHERE i.id = $id OR c.id = $id
RETURN i, c, r
```

## `dead_symbols`

**Params:** `{}` (no required params).

**Returns:** `class`/`interface`/`method` nodes with NO incoming edge of any
kind — native or magento. This is a candidate list, not a certainty: a
public API entry point that nothing in THIS repo calls looks identical to
genuinely dead code (webapi/plugin-hookable methods called from outside the
indexed tree are a known false-positive class — cross-check against
`wired_plugins_on`/`routes_to`/`observers_of_event` before deleting
anything this template surfaces).

**Old GitNexus equivalent:** none — this is a new template, not a port of
an existing playbook query. The nearest LBUG-era approximation was a manual
`MATCH (n) WHERE NOT ()-->(n) RETURN n` run ad hoc, never a named/reusable
query.

## `impact` vs `query` — when to use which

`impact(symbol, ...)` is the general recursive (depth<=4) traversal tool —
reach for it when the question is "what breaks if I change this" and you
want the whole neighborhood, grouped by depth, in both native and magento
directions at once. `query(template, params)` is for a SPECIFIC, one-hop-ish
named question (the 6 above) where a fixed, reviewable SQL shape is more
appropriate than a generic parameterized traversal — e.g. `observers_of_event`
needs a name-keyed lookup `impact` cannot do at all (impact only resolves a
node id/qualified_name/name, never a bare event string with no node of its
own to start from).
