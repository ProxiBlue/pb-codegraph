# Code Standards — pb-codegraph plugin repo

- TypeScript strict; node 20 target; ESM. Small modules mirroring the vendored augmenter layout (parsers/ resolvers/ writer/ mcp/).
- Vendored code (parsers, psr4/template resolvers from the legacy augmenter): modify minimally; every modification gets a `// pb-codegraph:` comment stating what changed (Apache-2.0 §4 modification notice + reviewability).
- SQLite: better-sqlite3; connections in shim are READ-ONLY with busy_timeout; writer uses single transaction per augment run; respect WAL if set by codegraph.
- Provenance discipline: every row the augmenter writes carries provenance='pb-codegraph-augmenter'; never mutate codegraph-owned rows.
- Shell: bash, set -euo pipefail where safe, shellcheck-clean, mktemp + cleanup traps, NEVER touch any project .git (fleet hard rule).
- MCP shim: @modelcontextprotocol/sdk stdio; tool outputs stable + agent-readable (name/path/signature prominent); no silent truncation — note caps loudly.
- Errors: actionable messages naming the pinned codegraph version where relevant; exit codes documented.
- Docs: every new file referenced from README (release task's sweep); Apache-2.0 + NOTICE attribution preserved.
- Portability: no absolute host paths in shipped code (env/registry-driven); nothing pps-specific.
