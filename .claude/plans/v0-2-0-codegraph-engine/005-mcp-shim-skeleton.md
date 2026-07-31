# Task 005: MCP shim — server skeleton + registry + list_repos

**Status**: pending
**Depends on**: none
**Retry count**: 0

## Description
Start mcp/ server (node, stdio MCP; @modelcontextprotocol/sdk) named for fleet compat. Registry config file (JSON, path via env PB_CODEGRAPH_REGISTRY) maps repo names → {db_path, description}: e.g. m2_pvcpipesupplies → /path/.codegraph/codegraph.db, mageos/hyva/deps → shared central DBs. Tool list_repos returns names + node/edge counts + last indexed_at + augmenter marker status per repo.

## Context
- Fleet contract: server must be usable under the existing mcps/.mcp.json key gitnexus-mageos (stdio command entry replaces the http url entry at cutover — task 010)
- Multi-db: open read-only (SQLITE_OPEN_READONLY) — shim never writes except optional re-augment trigger note (defer actual re-augment exec to wrapper; shim only WARNS in v0.2.0 — keep it read-only, simpler)
- Read-only connections must still set `busy_timeout` and be WAL-aware (codegraph may be mid-reindex; see _devils_advocate.md C5) so a concurrent codegraph write doesn't error the read.
- **Registry paths are CONTAINER-visible paths (see I4):** the shim runs inside the ddev web container (stdio spawned by in-container claude). Project DB path = the container mount of `.codegraph/codegraph.db`; core DB paths = the container mount point of `~/.pb-codegraph/indexes` (host path is NOT valid in-container). Task 010 pins the mount; task 005 only requires the registry loader treat `db_path` as an already-resolved container path and fail clearly if unreadable.

## Requirements (Test Descriptions)
- [ ] `it loads the registry and opens each db read only`
- [ ] `it lists repos with node and edge counts and index timestamps`
- [ ] `it reports augmenter staleness status per repo`
- [ ] `it survives a registry entry pointing at a missing db with a per-repo error not a crash`

## Acceptance Criteria
- MCP handshake + list_repos verified via a scripted stdio client test
