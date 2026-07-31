# Task 013: Release 0.2.0

**Status**: pending
**Depends on**: 001, 002, 003, 003b, 004, 005, 006, 007, 008, 009, 010, 011
**Retry count**: 0

## Description
Version 0.2.0 in plugin manifests; CHANGELOG; README rewrite: engine architecture (codegraph + augmenter + shim), the v0.1 impact-check command's new deterministic backend (uses graph when .codegraph db present, legacy LLM flow otherwise — update commands/impact-check.md with the detection step), install/cutover pointers, RECOVERY.md-compatible restore section (registry, core indexes rebuildable, nothing secret). Consistency sweep: tsc/tests green, shellcheck, JSON valid, NOTICE/Apache-2.0 attribution intact, no secrets, every new file referenced from README.

## Requirements (Test Descriptions)
- [ ] `it bumps 0.2.0 in plugin and marketplace manifests`
- [ ] `it documents every deliverable in changelog and readme`
- [ ] `it updates impact-check command with graph-backend detection`
- [ ] `it passes the consistency sweep including attribution and no-secrets checks`

## Acceptance Criteria
- Repo self-documenting; fleet sync picks up 0.2.0
