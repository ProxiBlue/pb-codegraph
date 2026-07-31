# ddev cutover: legacy code-graph tool -> pb-codegraph

Replaces a project's per-project legacy graph container (defined in its own
`.ddev` compose file, served over HTTP on `:4747`) with the pb-codegraph MCP shim (stdio, spawned
by in-container claude) plus a small set of shared, read-only "core" indexes
mounted into every project's web container. Acceptance-tested end to end
against pps (`pvcpipesupplies`) in task 011; this doc is the runbook task 011
follows.

Every command below is either read-only against the target project (`git
archive`, `cp -a`, `ddev exec ... --version`) or writes ONLY to files this
plugin owns (`mcps/.mcp.json`, a new `.ddev/docker-compose.pb-codegraph.yaml`,
a `registry.json`). Nothing here touches pb-hcf — see "Follow-up" at the
bottom.

## 0. Pre-flight: LIVE-branch check (MANDATORY before any .ddev/mcp/registry edit)

Fleet hard rule (`feedback_ddev_live_branch_required`): before writing ANY
`.ddev/`, `mcps/.mcp.json`, or registry file into a project, verify the
project's git checkout is on its LIVE-equivalent branch. If it is not, STOP
and list the offending files you were about to write — do not proceed.

```bash
cd <project-root>
git branch --show-current
```

Compare the result to the project's LIVE-equivalent (default `live`; consult
project memory for exceptions — e.g. ntotank's LIVE-equivalent is `uat`, not
`live`). For pps the LIVE-equivalent is the literal branch `live`
(`uptactics/m2_pvcpipesupplies`).

This check gates the WRITE steps below (section 4 mount edit, section 6
registry.json, section 7 `mcps/.mcp.json` swap). It does NOT gate
`scripts/build-core-indexes.sh`: that script exports a specific ref
(`refs/heads/live` via `git archive`) regardless of what branch is currently
checked out in the working tree, and never writes into the source project at
all (see the script's own header comment) — so core-index builds may run
safely from any working-tree state. Section 8's empirical verification in
this task ran core-index builds against pps for exactly this reason, with
pps mid-feature-branch in its working tree the whole time.

## 1. Where indexing runs

Two different processes build two different kinds of index, in two different
places:

- **Project index** (a project's own `app/code`, `app/design`, plus
  non-core `vendor/*` per the vendor-split template — section 5): runs IN
  the ddev web container, via `pb-codegraph index <project-root>` invoked by
  the in-container claude session (stdio-spawned, same process boundary the
  augmenter and MCP shim already run in). Confirm node/npx availability
  before first use:

  ```bash
  ddev exec node --version   # must be >=20 (package.json engines.node)
  ddev exec npx --version
  ```

  ddev's PHP web containers already ship Node (Magento's
  `setup:static-content:deploy` / Tailwind build pipeline depends on it), so
  this is a verification step, not a new dependency to install.

- **Core indexes** (`mageos`, `hyva`, `deps` — shared, read-only, one build
  serves every project): run on the HOST via
  `scripts/build-core-indexes.sh`, NOT inside any project's container. The
  script reads a project checkout's `vendor/mage-os`, `vendor/hyva-themes`,
  and curated deps read-only (`git archive` + `cp -a`) and writes the built
  `.codegraph/codegraph.db` files under `$PB_CODEGRAPH_INDEX_DIR` (default
  `~/.pb-codegraph/indexes/<name>/`) on the HOST filesystem. This is
  intentional: rebuilding the same mage-os/hyva-themes graph inside every
  project's container would be pure duplication.

- **Registry `db_path` values are always CONTAINER paths**, even for the
  core indexes built on the host — the host-built dbs are exposed to a
  container only via the read-only mount in section 4, and the registry
  entry names the path AS SEEN FROM INSIDE THE CONTAINER
  (`/mounts/pb-codegraph-core/<name>/.codegraph/codegraph.db`), never the
  host path they were built at. See `templates/registry.template.json`.

- If task 002 chose `better-sqlite3` (native bindings): confirm its
  prebuilt/rebuilt binary matches the container's Node ABI before relying on
  it in-container —

  ```bash
  ddev exec node -e "require('better-sqlite3'); console.log('better-sqlite3 OK')"
  ```

  Fallback if that fails (ABI mismatch): `node:sqlite` (Node's built-in
  SQLite module, no native binding to rebuild) — see
  `.claude/plans/v0-2-0-codegraph-engine/002-sqlite-writer.md` for the
  chosen binding and this fallback note.

## 2. Registry generation

Copy `templates/registry.template.json` into the project (e.g.
`.ddev/pb-codegraph/registry.json`), replace the `<project-name>` key with
the project's ddev sitename, and point `PB_CODEGRAPH_REGISTRY` (the env var
the MCP shim reads — `mcp/src/registry.ts`) at the container path of that
file. The template already carries the three core entries (`mageos`,
`hyva`, `deps`) plus one project placeholder entry — see
`tests/registry-template.test.ts` for the shape contract.

## 3. Per-project vendor-split index

`templates/per-project-vendor-split.gitignore` (built by task 009,
`scripts/build-core-indexes.sh --only template`) is the per-project
counterpart to the core-index ignore files: it excludes `vendor/mage-os/`
and `vendor/hyva-themes/` (already covered by the shared core indexes) while
keeping every OTHER `vendor/*` package indexed, so a custom
plugin/preference that targets a 3rd-party composer package resolves to a
real graph node instead of a bare `external` placeholder.

Mechanism (empirically verified — see section 8): codegraph
default-ignores `vendor/` entirely regardless of what an `include` list in
`codegraph.json` says; only a ROOT `.gitignore` negation (`!vendor/`)
restores it. Because a Magento project already has its own root
`.gitignore` for unrelated reasons (`var/`, `generated/`, `pub/static/`,
...), the vendor-split lines must be APPENDED to that existing file, never
used to replace it:

```bash
cat templates/per-project-vendor-split.gitignore >> .gitignore
git diff .gitignore   # review before committing
```

Cross-DB edges are an accepted, documented gap: a custom class -> mage-os
class edge still resolves to an `external` placeholder node in the
per-project db even with the vendor-split template applied, because
federation across the project db and the core dbs is query-merge, not a
joined graph (see `_devils_advocate.md` I3 and the template's own header
comment).

## 4. Read-only core-index mount for ddev containers

Add a NEW project-local compose file (mirrors the existing
`docker-compose.mounts.yaml` convention — env-driven, no host literal baked
in) rather than editing an existing one:

`.ddev/docker-compose.pb-codegraph.yaml`:

```yaml
services:
  web:
    volumes:
      - "${PB_CODEGRAPH_INDEX_DIR:-$HOME/.pb-codegraph/indexes}:/mounts/pb-codegraph-core:ro"
```

`${PB_CODEGRAPH_INDEX_DIR:-$HOME/.pb-codegraph/indexes}` matches
`scripts/build-core-indexes.sh`'s own default output root, so a default
setup needs no extra env configuration; overriding
`PB_CODEGRAPH_INDEX_DIR` on the host (e.g. a shared NFS/network location
instead of `~/.pb-codegraph/indexes`) is a single env var, never a template
edit. The mount is `:ro` — the container never writes to the shared core
indexes.

After adding the file: `ddev restart`. Then verify the mount from inside
the container:

```bash
ddev exec ls /mounts/pb-codegraph-core
# mageos  hyva  deps
```

This is a `.ddev/` edit — the LIVE-branch check in section 0 gates it.

## 5. Full pps cutover sequence

Run in this order once sections 0-4 above are understood:

1. **LIVE-branch check** (section 0) — confirm pps is on `live` before any
   write below. If not, stop and list the files you were about to write
   (`.ddev/docker-compose.pb-codegraph.yaml`, `registry.json`,
   `mcps/.mcp.json`).
2. **Stop (not remove) the running legacy graph container** — it stays
   defined in its own compose file and its volumes are untouched, so
   rollback is instant:
   ```bash
   docker stop <legacy-graph-container>   # its name is visible in `docker ps` (ddev-pvcpipesupplies-*)
   ```
3. **Add the read-only core-index mount** (section 4) and `ddev restart`.
4. **Build the core indexes once, centrally** (host, shared across every
   project — only needs to happen once fleet-wide, not per project):
   ```bash
   scripts/build-core-indexes.sh --source ~/workspace/uptactics/pvcpipesupplies --branch live
   ```
5. **Apply the vendor-split ignore template** to pps (section 3), then build
   and augment the project's own index, in-container:
   ```bash
   ddev exec pb-codegraph index /var/www/html
   ```
6. **Write `registry.json`** from `templates/registry.template.json`
   (section 2), with `pvcpipesupplies` as the project key.
7. **Swap the `mcps/.mcp.json` `pb-codegraph` entry** from the old
   legacy `:4747/api/mcp` http url entry to a stdio command entry that
   launches the shim (`mcp/bin/server.ts`) with `PB_CODEGRAPH_REGISTRY`
   pointed at the container path of the `registry.json` written in step 6.
8. **Verify**:
   ```bash
   ddev exec pb-codegraph health --registry <container-path-to-registry.json>
   ```
   Exit code 0 and `"status": "green"` in the JSON output confirms every
   registered repo opened cleanly with a fresh augmenter marker.
9. Hand off to task 011 for the full legacy-vs-pb-codegraph acceptance
   comparison before removing anything.

## Rollback

Because step 2 above STOPPED the legacy graph container rather than
removing it, rollback at any point is fast and does not require rebuilding
the legacy image:

```bash
# Revert the mcp entry to the old http url (see git history of mcps/.mcp.json)
git -C ~/claude-skills-central/mcps checkout -- .mcp.json   # or hand-restore the http entry

# Bring the still-present legacy graph container back
docker start <legacy-graph-container>
```

Legacy graph containers are stopped, not removed, at every step of this
runbook — `docker rm`/`docker compose down`/deleting the legacy compose
file are explicitly OUT OF SCOPE for the cutover
itself. Actual teardown/removal of the legacy graph container and image is
a separate, later, deliberate step taken only after task 011's acceptance
comparison confirms parity — never bundled into the cutover.

## 6. Health probe

`pb-codegraph health [--registry <path>]` (task 010, `augmenter/src/cli.ts`)
is the CLI replacement for the legacy tool's `curl :4747` liveness check. It
prints a single JSON object to stdout —

```json
{ "status": "green", "repos": [ { "name": "mageos", "ok": true, "augmenter_status": "fresh", "node_count": 12345, "edge_count": 45678, ... }, ... ] }
```

— and exits `0` when `status` is `"green"` (every registered repo opened
cleanly AND its augmenter marker is `fresh`), or a nonzero exit code
otherwise (`EXIT_HEALTH_NOT_GREEN` for a stale/never-run marker or an
unreadable/unsupported-schema db; `EXIT_DB_ERROR` if the registry itself
could not be loaded at all). A repo whose codegraph reindexed since the
last `pb-codegraph augment` run (stale magento edges — see
`_devils_advocate.md` C5) is reported `"augmenter_status": "stale"` and
makes the WHOLE health report non-green, not just that repo.

### Follow-up (cross-plugin, NOT done in this task/repo): pb-hcf probe update

pb-hcf's pre-flight-check/wire currently probes liveness with `curl
:4747` against the legacy http endpoint. That probe needs to be
updated to shell out to `pb-codegraph health --registry <path>` and check
its exit code instead. **This is an explicit follow-up for the pb-hcf
project** — this plan does not edit pb-hcf, and no file under
`~/claude-plugins-central/seed/marketplaces/pb-hcf` (or any other pb-hcf
location) is touched by this task. Track it as a pb-hcf-side ticket before
any project fully cuts over (a project that swaps `mcps/.mcp.json` to the
stdio shim while pb-hcf's wire still curls `:4747` will show pb-hcf's
pre-flight probe permanently red until pb-hcf is updated).

## 7. Empirical vendor-dir verification (this task)

See section 3 for the mechanism description. Commands run and their output
are recorded in `docs/vendor-dir-verification.md`.
