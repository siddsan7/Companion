# Ticket 13 current gate checkpoint

Current immutable GUI candidate: .worktrees/issue-13-manual-ledger-guard, commit32000d7b9db793e521c7b86229afb7085abc64f0/tree4a232394ab7f7415a5bab189bab3071497937f30. Full144 is running: Temp/companion-ticket13-final-144-20261110. Do not edit that worktree or launch another GUI before exit.json. One recorded failure is the second derived send in the two-hop foreign-history case: persisted incomplete request/intake busy BEFORE deletion/restoration. Final counts remain pending; inspect ALL failure markers, not only tail.

Primary e819d85, editor886550ac, earlier gate fixes45c77d9, manual corrections32000d7 are pushed with all history preserved. Exact32000d7 complete-ticket static Standards/Spec approvals: Temp/companion-ticket13-final144-{standards,spec}-20261110.md. Runtime excluded. Ticket13 is not root-integrated/closed;16 remains blocked. No full-PR/release approval.

## Actual evidence

Original complete141 FAILED:138pass/3fail/0skip, exit1,3374493ms. Temp/companion-ticket13-final-composed-141-20261110. All three failures: restored imported citations, foreign-ledger status, recreated-backup startup overlap. Later142 STOPPED after13 completed passes/0 completed failures, exit1,299371ms on reviewed manual P1. Temp/companion-ticket13-corrected-final-142-20261110. Neither passed.

Separate fixes0ba0edb and2ef6d4c retain full physical CAS, avoid only guarded identical-byte replacement, and report the owned ledger error. Test-only3e4fa3a waits existing startup completion; tracing removed e8b2459. Four normal cases passed113336ms. Manual P1 regressionf69fda2 RED10364ms, fixa537172 unchanged GREEN10673ms. Namespace P2 regressionb0de1a6 RED8270ms, fix2ae4333 unchanged GREEN9850ms. Six representative controls PASS88807ms. Canonical tables in composed docs/verification-ticket13-{gate-fixes,manual-ledger-guard}.md. Focused passes are not full gates.

## Pending contention probe

Root plan903ede9 preceded fresh .worktrees/issue-13-history-contention; approved plan-only preserving sync072a0a2 precedes pushed TEST-ONLY diagnostic870da75/tree9a76778a4fd5ffdb92c775bb2f0990ab46bc7ad2. Syntax and actual one-case discovery passed. Runtime pending until full144 exits. Existing durable runner: Temp/companion-verified-test-runner.cjs. Original case actions/assertions/timeout/retries unchanged. No product fix chosen.

Read Temp/companion-history48-busy-diagnosis-20261110.md and .brain/plan-ticket13-history-contention.md. Concrete seam: Intake.info busy fallback followed by separately locked Vault.list during fresh revalidation. Minute refresh is a candidate owner, unproved. Capture native listening/error/close intervals and original stacks before design review. Probe overhead can mask the race; a pass is not closure. Do not add blind support wait after New conversation (clears marker without relaunch). Keep sole kernel, lock order, fresh authority and live-owner reentrance; no stale-data fallback, model retry, timer disablement or second mutex.

## Limits and next action

Automatic approval review rejected ONE recursive cleanup command for TWO Temp fixtures before execution, stating only blocked by policy. Leave Temp/companion-deletion-IcAQ2f and Temp/companion-deletion-UC6bGb; do not bypass. Disclose this at final handoff.

Finish full144 and preserve actual final outcome, run one diagnostic serially, review evidence-directed correction, reproduce/fix separately, relevant checks plus fresh complete gate/exact-tip independent approval/assigned merger. Preserve helper→primary→root integration before13 closure. Then committed fresh16 plan/worktree. Temp/companion-release16-final-gap-map-20261110.md narrows new journeys against existing tests. Live sign-in deferred/readiness closed; hosted Actions waived/billing-blocked/unverified. Full-spec/final-PR review and required gates precede merge-commit/main ancestry verification, then PAUSE. No deployment.
