# Task 011: Acceptance harness — pps parallel diff vs GitNexus

**Status**: pending
**Depends on**: 010
**Retry count**: 0

## Description
scripts/acceptance-diff.sh + docs: on pps, index custom code + augment, then compare shim impact output vs live GitNexus impact (containers still up) for at least 5 real symbols: one plugin-wrapped method (Braintree/ShipperHQ area), one observer/event case, one preference-redirected interface, ONE CROSS-DB case (a custom plugin/preference targeting a vendor/mage-os class — exercises federation + external-placeholder behavior, see _devils_advocate.md I5), and ONE NEGATIVE case (a symbol with no magento wiring — proves the augmenter injects no false edges). Diff is classified PER IMPACTED NODE (not just per symbol): both-found / new-stack-only / gitnexus-only / **different-set** (both located the symbol but returned divergent impacted sets — the most dangerous case). Each divergence gets an explanation category (index staleness — gitnexus is a week stale — vs resolution miss vs augmenter gap vs cross-db-boundary vs event-dispatch-not-traversed per C4). Human-readable verdict; Lucas signs off before fleet cutover.

## Requirements (Test Descriptions)
- [ ] `it produces a per-impacted-node classification including a different-set category`
- [ ] `it covers a cross-db case and a no-wiring negative case`
- [ ] `it explains each divergence with a category (staleness/resolution-miss/augmenter-gap/cross-db/event-dispatch)`
- [ ] `it fails loudly when either backend is unreachable rather than emitting a partial verdict`

## Acceptance Criteria
- Run on pps; report reviewed by Lucas (sign-off gate — NOT auto-passable)
