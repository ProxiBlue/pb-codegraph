# Testing — pb-codegraph plugin repo

Node/TypeScript + shell + markdown plugin repo. Node v20 on host. NO php runtime needed (fixtures are static PHP files, never executed).

## Test commands (repo root)
- TypeScript: `npx tsc --noEmit` (once tsconfig.json exists — first TS task creates it; strict mode)
- Unit tests: `node --test --import tsx` over `**/*.test.ts` (add tsx + @types/node as devDeps when bootstrapping package.json); alternatively `npx vitest run` if a worker prefers — pick ONE in task 001 and note it here via implementation notes
- Fixture DB: `bash scripts/build-fixture-db.sh` (pins npx @colbymchenry/codegraph@1.5.0; output under tests/fixture/.codegraph/ — gitignored, built on demand)
- Shell: `shellcheck scripts/*.sh` (host has no shellcheck binary — use `docker run --rm -v "$PWD":/w koalaman/shellcheck:stable /w/scripts/<file>.sh`)
- JSON: `python3 -m json.tool` every *.json
- Secrets grep (0 hits): `grep -rE '(ff15ea68|9c111c47)' --exclude-dir=.git --exclude-dir=node_modules .`

## RED/GREEN
Requirements are real unit tests where code is produced (writer, resolver, shim, guard — test against the fixture DB), and greppable/parseable assertions for doc/template tasks. SQLite assertions via better-sqlite3 in tests or python3 sqlite3 one-liners.

## Full suite (pre-commit)
tsc + unit tests + shellcheck + JSON + secrets grep. All green before commit.
