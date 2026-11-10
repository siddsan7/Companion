# Ticket 13 current gate checkpoint

Current helper: `.worktrees/issue-13-source-inspection`, correction and focused GREEN report committed/pushed as `6fe0589`. Root removed only the temporary 173-line history diagnostic; `tests/deletion.spec.js` is byte-identical to `32000d7`. Root-tested cleanup tree `f96c261` passed all five selected cases in 183,494 ms. No GUI is active. Product source and tests are frozen while root preserves cleanup and docs.

Preserved lineage: primary `e819d85`, editor `886550ac`, gate fixes `45c77d9`, manual guard `32000d7`, history diagnostic/control `5acad17`, root plan `930c522`, source correction `6fe0589`. Ticket 13 is not root-integrated or closed. Ticket 16 remains blocked. Complete-ticket static checks, exact-tip Standards/Spec review, assigned merger approval and full PR/release approval remain pending.

## Actual gates and focused evidence

| Run | Actual result | Duration (ms) | Temp evidence directory |
| --- | --- | ---: | --- |
| Original complete 141 | FAILED: 138 passed, 3 failed, 0 skipped; exit 1 | 3,374,493 | `companion-ticket13-final-composed-141-20261110` |
| Corrected 142 | STOPPED on reviewed manual P1: 13 completed passes, 0 completed failures; exit 1 | 299,371 | `companion-ticket13-corrected-final-142-20261110` |
| Full 144 at `32000d7`, tree `4a232394` | FAILED: 143 passed, 1 failed, 0 skipped; exit 1 | 3,695,561 | `companion-ticket13-final-144-20261110` |
| Ordinary history diagnostic | 1 passed; no native busy error; not causal closure | 95,577 | `companion-history13-owner-probe-20261110` |
| Controlled history overlap | RED: actual native state/info owner; retained second send failed busy | 66,897 | `companion-history13-controlled-overlap-20261110` |
| New source cases, baseline `e5fb3f3` | 3 failed: first cold setup failed before probe; cases 2/3 actual product RED | 82,055 | `companion-source-inspection13-red-three-20261110` |
| Unchanged brief overlap, warm cache | Actual product RED: retained busy failure instead of reply | 29,302 | `companion-source-inspection13-red-overlap-warm-20261110` |
| Three unchanged source cases, corrected `ed3f76` | GREEN: 3 passed; exit 0 | 71,774 | `companion-source-inspection13-green-three-20261110` |
| Cleanup original FIVE, tree `f96c261` | 5 passed; exit 0: new 3, original two-hop history, ledger preview identity guard | 183,494 | `companion-source-inspection13-original-five-20261110` |

Full144's only failure was the second derived send in the two-hop foreign-history case, before deletion/restoration. Persisted intent failed with intake busy. The original overlapping owner remains unproved; controlled evidence establishes a reachable contention seam without retrospective timer attribution. The ordinary diagnostic saw minute refresh without collision: 434 events, no drops and no busy errors. Original full144 markers and copied `.last-run.json` agree; its source worktree was clean at the recorded tip.

The original-four cleanup harness aborted at discovery before launch: its filter selected five cases because an existing ledger preview identity guard also matched. Root corrected the expected count and ran the five-case set in a new directory. This was not a product failure. Original actions, assertions, timeouts and retries remain intact.

Earlier failures and corrections remain in `docs/verification-ticket13-gate-fixes.md` and `docs/verification-ticket13-manual-ledger-guard.md`: original141 failed restored citations, foreign-ledger status and recreated-backup startup overlap. Fixes `0ba0edb`/`2ef6d4c` preserve physical CAS and owned ledger errors; `3e4fa3a` adds startup synchronization, tracing removed at `e8b2459`. Four normal cases passed 113,336 ms. Manual P1 `f69fda2` RED 10,364 ms → `a537172` GREEN 10,673 ms. Namespace P2 `b0de1a6` RED 8,270 ms → `2ae4333` GREEN 9,850 ms. Six representative controls passed 88,807 ms. None replaces a complete gate.

## Current design and next gate

`sourceInspection` now runs the entire fresh Context corpus under existing native source ownership. A monotonic two-second admission budget retries only native busy before callback entry. Body/nested errors never replay; mutations remain fail-fast. Live `token.active`, source authority/CAS guards and Conversation→required writing stores→Intake lock order are unchanged. There is no second mutex, stale fallback, provider retry or timer disablement.

Root preserved RED in `f9e9a76` before authorizing the two-source-file correction. Independent bounded review of `ed3f76` found no blockers conditional on required actual gates. The three focused cases verify exact-once reviewed dispatch, changed-byte fresh-review refusal, and closed admission with zero source-read entry beyond the bound. Brief overlap legitimately traverses multiple corpora; exactly-once refers to the intended request/provider turn. See `docs/verification-ticket13-source-inspection.md` for canonical details and `docs/verification-ticket13-history-contention.md` for native owner evidence.

Next: root commits diagnostic removal and these docs, then runs the prepared complete 162-case gate across 20 files. `%TEMP%/companion-ticket13-context-162-argv.json` adds the complete 15-case Context suite and three new source cases to the previous gate. This gate is **PENDING**. Existing durable runner: `%TEMP%/companion-verified-test-runner.cjs`. After actual results, complete static checks and independent exact-tip review, obtain assigned merger approval and preserve helper→primary→root integration before closing 13.

## Limits and release sequence

Automatic approval review rejected ONE recursive cleanup command for TWO Temp fixtures before execution, stating only blocked by policy. Leave Temp/companion-deletion-IcAQ2f and Temp/companion-deletion-UC6bGb; do not bypass. Disclose this at final handoff.

After 13 closes, create the committed fresh 16 plan/worktree. `%TEMP%/companion-release16-final-gap-map-20261110.md` narrows new journeys against existing tests. Live sign-in remains deferred/readiness closed. Hosted Actions remain waived, billing-blocked and unverified. Full-spec/final-PR review and required gates precede merge-commit/main ancestry verification, then PAUSE. No deployment.
