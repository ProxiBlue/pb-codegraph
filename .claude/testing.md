# Testing — pb-codegraph plugin repo

Node/TypeScript + shell + markdown plugin repo. Node v20 on host. NO php runtime needed (fixtures are static PHP files, never executed).

## Test commands (repo root)
- TypeScript: `npx tsc --noEmit` (once tsconfig.json exists — first TS task creates it; strict mode)
- Unit tests: `node --test --import tsx` over `**/*.test.ts` (add tsx + @types/node as devDeps when bootstrapping package.json); alternatively `npx vitest run` if a worker prefers — pick ONE in task 001 and note it here via implementation notes
  - **Implementation note (task 001):** picked `node --test --import tsx` (the documented default). Node 20's test runner CLI does not glob-expand a literal `**/*.test.ts` argument itself, and `npm run test` invokes via `/bin/sh` (dash on this host), which has no `globstar`. Since all test files currently live flatly in `tests/` (no nested test dirs), `package.json`'s `test` script and ad-hoc invocations use `node --test --import tsx tests/*.test.ts`, which dash expands correctly. Run a single file directly with `npx node --test --import tsx tests/<name>.test.ts`. If a later task adds nested `tests/**` subdirectories, switch to `find tests -name '*.test.ts' -print0 | xargs -0 npx node --test --import tsx` or enable `bash -O globstar` explicitly.
- Fixture DB: `bash scripts/build-fixture-db.sh` (pins npx @colbymchenry/codegraph@1.5.0; output under tests/fixture/.codegraph/ — gitignored, built on demand)
- Shell: `shellcheck scripts/*.sh` (host has no shellcheck binary — use `docker run --rm -v "$PWD":/w koalaman/shellcheck:stable /w/scripts/<file>.sh`)
- JSON: `python3 -m json.tool` every *.json
- Secrets grep (0 hits): `grep -rE '(ff15ea68|9c111c47)' --exclude-dir=.git --exclude-dir=node_modules .`

## RED/GREEN
Requirements are real unit tests where code is produced (writer, resolver, shim, guard — test against the fixture DB), and greppable/parseable assertions for doc/template tasks. SQLite assertions via better-sqlite3 in tests or python3 sqlite3 one-liners.

## Full suite (pre-commit)
tsc + unit tests + shellcheck + JSON + secrets grep. All green before commit.
