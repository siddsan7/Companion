# Diagnose the two observed composed-gate failures

The frozen ticket13 candidate is 886550ac/tree b107a10d. Its full 141-case run is still in progress. Two failures are recorded so far; the remaining results are not inferred.

Case49, restored imported citations, fails the second deletion after restoration: expected deletion completion, received the generic changed-files refusal. Its cause is unproved. Inspect the original error stack and first selected/fresh inventory difference. The leading hypothesis is ledger identity drift during support/evidence inspection; dependent changes and a genuine file guard remain alternatives.

Case75 reaches a real source unlink, replaces the ledger externally, and passes exact foreign-byte preservation. It then fails the expected specific ledger-changed status because the application reports generic changed files. Later recovery assertions were not reached. Trace the original guard before changing the product diagnostic; do not weaken the status or preservation assertions.

This plan precedes a fresh isolated diagnostic/fix worktree. Keep the running editor tree immutable. Author only test diagnostics initially: the same two existing cases, original actions/assertions/timeouts/retries, in-memory inventory/ledger/error observations and durable output before fixture cleanup. Reuse the bounded plan in Temp/companion-citation13-diagnostic-patch-plan-20261110.md. Root owns all runtime and Git. Do not run another GUI test until the full gate exits.

After the full run, preserve its actual count, duration, exit, skips and all failures. Run the two diagnostic cases once. Select each minimum correction from actual evidence. Keep tests, product fixes and documentation in independently reviewable commits; preserve all ancestry. No consent expansion, CAS weakening, automatic retry, payload filtering or premature fixture classification.

Rerun relevant unchanged checks, obtain fresh independent review of corrections, then run the required fresh final ticket gate on the immutable corrected composition. A failed/composite run is never a full pass. Final exact-tip approval precedes ticket integration/closure; ticket16 and the final complete-PR/main-merge workflow remain unchanged. Live sign-in stays deferred and readiness restricted.
