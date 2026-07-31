# Empirical vendor-dir verification (Post-001 caveat, task 010)

Task 001 discovered codegraph SILENTLY ignores directories named
`Vendor`/`vendor` ("No files found to index", zero error, no exception).
This doc records the empirical proof that the `!vendor/` root-`.gitignore`
negation mechanism (built by task 009's `scripts/build-core-indexes.sh` —
see `build_gitignore_content()` and `emit_project_template()`) actually
restores `vendor/*` content to the index, run against a REAL Magento
project's on-disk `vendor/hyva-themes` tree (`pvcpipesupplies`), not just
the synthetic git fixture `tests/build-core-indexes.test.sh` uses for its
mechanics tests.

This is evidence, not a template — the commands/output below are recorded
verbatim from the machine they were run on and may contain host-specific
paths. The reusable, host-portable version of this check is the automated
regression test `test_real_pps_hyva_vendor_node_counts` in
`tests/build-core-indexes.test.sh` (env-overridable via
`PB_CODEGRAPH_TEST_PPS_ROOT`, skips cleanly — reported `ok`, not a false
`FAIL` — on a host without that checkout).

## (a) Core-index export: does the archive layout retain a `vendor/` prefix?

```bash
bash scripts/build-core-indexes.sh \
  --source /home/lucas/workspace/uptactics/pvcpipesupplies \
  --branch live \
  --only hyva \
  --limit 200 \
  --index-dir /tmp/.../scratchpad/vendor-verify-idx
```

Output:

```
[build-core-indexes] target=hyva: exporting refs/heads/live from /home/lucas/workspace/uptactics/pvcpipesupplies (git archive, read-only)
[build-core-indexes] copied 200 file(s) (--limit 200) from vendor/hyva-themes
[build-core-indexes] target=hyva: indexing with codegraph@1.5.0
┌  Initializing CodeGraph
│
◆  Initialized in /tmp/pb-codegraph-core-aQBCeZ
│
Scanning files...
Parsing code...
Resolving refs...
Linking dynamic dispatch...
│
◆  Indexed 53 files
│
●  419 nodes, 525 edges in 165ms
│
└  Done

[build-core-indexes] target=hyva: OK — db at /tmp/.../scratchpad/vendor-verify-idx/hyva/.codegraph/codegraph.db
```

`Indexed 53 files` / `419 nodes, 525 edges` — NOT `No files found to index` /
zero nodes. The archive export DOES retain the `vendor/` path prefix (the
copied subtree lands at `<scratch>/vendor/hyva-themes/...`, matching the
`!vendor/` negation's root-relative anchor), so the core-index build path
does not hit the Post-001 silent-ignore failure mode.

## (b) sqlite node-count assertion (`node counts > 0`, per this task's testing config)

```bash
node -e "
  const Database = require('better-sqlite3');
  const db = new Database('/tmp/.../vendor-verify-idx/hyva/.codegraph/codegraph.db', { readonly: true });
  const nodeCount = db.prepare('SELECT COUNT(*) AS c FROM nodes').get();
  const edgeCount = db.prepare('SELECT COUNT(*) AS c FROM edges').get();
  const sample = db.prepare(\"SELECT qualified_name, kind FROM nodes WHERE qualified_name LIKE '%hyva%' LIMIT 5\").all();
  console.log(JSON.stringify({ nodeCount, edgeCount, sample }, null, 2));
  db.close();
"
```

Output:

```json
{
  "nodeCount": { "c": 419 },
  "edgeCount": { "c": 525 },
  "sample": [
    { "qualified_name": "vendor/hyva-themes/hyva-ui/components/footer/B-4-column-newsletter/src/Magento_Customer/layout/default.xml", "kind": "file" },
    { "qualified_name": "vendor/hyva-themes/hyva-ui/components/footer/B-4-column-newsletter/src/Magento_Sales/layout/default.xml", "kind": "file" },
    { "qualified_name": "vendor/hyva-themes/hyva-ui/components/footer/B-4-column-newsletter/src/Magento_Theme/layout/default.xml", "kind": "file" },
    { "qualified_name": "vendor/hyva-themes/hyva-ui/components/footer/C-mega/src/Magento_Theme/layout/default.xml", "kind": "file" },
    { "qualified_name": "vendor/hyva-themes/hyva-ui/components/slider/A-basic/src/Magento_Theme/layout/cms_index_index.xml", "kind": "file" }
  ]
}
```

`nodeCount.c = 419 > 0`, and every sample `qualified_name` retains the full
`vendor/hyva-themes/...` prefix — the mechanism is the root-`.gitignore`
negation, not an export-with-stripped-prefix (option (b)'s alternative
named in the Post-001 caveat was ruled out: the export keeps the prefix,
the `!vendor/` negation is what makes it visible to codegraph).

## (b) Project vendor-split DB: which mechanism actually works?

Per `scripts/build-core-indexes.sh`'s own header comment on
`build_gitignore_content()` (task 009): a bare `codegraph.json` `include`
list does NOT un-ignore `vendor/` — codegraph's built-in default-ignore for
`vendor/` wins regardless of `codegraph.json` config. Only a root
`.gitignore` negation (`!vendor/`) restores it. **Chosen mechanism: root
`.gitignore` negation**, not an `ignore-config override`. This is the same
mechanism `templates/per-project-vendor-split.gitignore` implements for
the per-project DB (excluding `vendor/mage-os/` and `vendor/hyva-themes/`
specifically while leaving `!vendor/` — and therefore every other
`vendor/*` package — indexed). See `docs/cutover.md` section 3 for the
per-project application procedure (append, never overwrite, the project's
existing root `.gitignore`).

## Read tree unaffected

`git -C /home/lucas/workspace/uptactics/pvcpipesupplies status --porcelain`
was empty both immediately before and immediately after the run above —
the source project's working tree and index were not touched (matches
`scripts/build-core-indexes.sh`'s own "never writes inside the source
project tree" contract, already covered by
`tests/build-core-indexes.test.sh`'s
`test_never_writes_inside_source_tree`).

## Regression coverage

`tests/build-core-indexes.test.sh::test_real_pps_hyva_vendor_node_counts`
re-runs this exact check (real pps `vendor/hyva-themes`, `--limit 200`,
throwaway index dir, sqlite node-count assertion `> 0`, before/after
`git status --porcelain` diff) as part of the repo's normal test suite —
see `.claude/testing.md`.
