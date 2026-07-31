# Task 006: MCP shim — find_symbol + context

**Status**: pending
**Depends on**: 005
**Retry count**: 0

## Description
find_symbol(name|qualified_name, repo?): exact qualified_name lookup first, then FTS5 nodes_fts match, ranked; returns file_path, lines, signature, kind, repo. context(symbol, repo?): the node + one-hop neighbors both directions across ALL edge kinds (native + magento), grouped by edge kind, with metadata surfaced (sortOrder/area/event).

## Context
- Federation: repo omitted → query every registry db, merge, tag results with repo (RRF-lite: exact matches first, then per-db FTS rank)
- Output shapes should read like the old GitNexus responses enough that agents' habits keep working (name, path, signature prominent)

## Requirements (Test Descriptions)
- [ ] `it finds a class by exact qualified name in a named repo`
- [ ] `it finds symbols by partial name via fts across all repos when repo omitted`
- [ ] `it finds a minted route or event node via fts (validates 002 fts maintenance)`
- [ ] `it returns context neighbors grouped by edge kind including magento kinds (preference_for, wraps, observes, renders, references)`
- [ ] `it surfaces plugin sortorder and observer event metadata in context output`

## Acceptance Criteria
- Tests against fixture DB incl. injected magento edges
