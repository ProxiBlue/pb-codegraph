# Task 012: Upstream Magento-recognizer PR prep (stretch)

**Status**: pending
**Depends on**: 004
**Retry count**: 0

## Description
Non-blocking: prepare (not necessarily submit) an upstream contribution to colbymchenry/codegraph adding a Magento recognizer for routes.xml + webapi.xml → route nodes + references edges, following the Drupal *.routing.yml recognizer pattern. Deliverable = docs/upstream-pr/ with the proposed recognizer spec, test fixtures reusing task 001's tree, and a CONTRIBUTING-conformant draft. Actual submission = Lucas's call.

## Requirements (Test Descriptions)
- [ ] `it specifies route node and edge shapes matching codegraph's native route model`
- [ ] `it maps frontname area path to controller action classes per magento routing convention`
- [ ] `it includes fixture files exercising frontend and webapi routes`

## Acceptance Criteria
- Draft complete enough that a PR is a copy-paste job
