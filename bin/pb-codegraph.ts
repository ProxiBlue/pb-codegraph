#!/usr/bin/env -S node --import tsx
// Thin shebang entrypoint for the `pb-codegraph` CLI (task 004). All
// argument parsing / exit-code mapping lives in augmenter/src/cli.ts so
// tests can call `main()` directly instead of spawning a subprocess for
// every case — mirrors the mcp/bin/server.ts (thin entry) vs
// mcp/src/server.ts (logic) split already used in this repo.
import { main } from '../augmenter/src/cli.ts';

main(process.argv.slice(2)).then((code) => process.exit(code));
