# Ticket 13 current gate checkpoint

Current helper: `.worktrees/issue-13-source-inspection`, revised narrow-span correction committed/pushed as `30966c090fdeb042fdc98c906c0dd5825eceda06`. Four unchanged focused cases passed 94,747 ms; the original two-hop history and ledger preview identity guard then passed 112,029 ms. The previous whole-corpus full162 was STOPPED after 8 passes / 1 failure. A fresh corrected full162 is PENDING. No GUI is active; product source and tests are frozen.

Preserved lineage: primary `e819d85`, editor `886550ac`, gate fixes `45c77d9`, manual guard `32000d7`, history diagnostic/control `5acad17`, root plan `930c522`, initial source correction `6fe0589`, diagnostic cleanup `1aabd8f`, revised root plan `d8da40a` preserved through helper merge `d808925`, narrow correction `30966c0`. The deletion spec remains byte-identical to `32000d7`. Ticket 13 is not root-integrated or closed; 16 remains blocked. Complete-ticket static checks, exact-tip Standards/Spec, assigned merger and full PR/release approval remain pending.

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
| Whole-corpus full162, HEAD `1aabd8f` / tree `f9a773` | STOPPED: 8 completed passes / 1 completed failure; exit 1; in-flight annotation removal regression | 232,908 | `companion-ticket13-context-final-162-20261110` |
| Narrow FOUR, tree `ede0e1e1110aad437be1bb9867484c7838a83d7a` | 4 passed; exit 0: unchanged annotation reader and new 3 | 94,747 | `companion-source-inspection13-narrow-four-20261110` |
| Narrow original TWO, `30966c0` / tree `757edb8668d6edf251d1869bd82f875f4f0b0653` | 2 passed; exit 0: unchanged two-hop history and ledger preview identity guard | 112,029 | `companion-source-inspection13-narrow-original-two-20261110` |

Full144's only failure was the second derived send in the two-hop foreign-history case, before deletion/restoration. Persisted intent failed with intake busy. The original overlapping owner remains unproved; controlled evidence establishes a reachable contention seam without retrospective timer attribution. The ordinary diagnostic saw minute refresh without collision: 434 events, no drops and no busy errors. Original full144 markers and copied `.last-run.json` agree; its source worktree was clean at the recorded tip.

The original-four cleanup harness aborted at discovery before launch: its filter selected five cases because an existing ledger preview identity guard also matched. Root corrected the expected count and ran the five-case set in a new directory. This was not a product failure. Original actions, assertions, timeouts and retries remain intact.

Earlier failures and corrections remain in `docs/verification-ticket13-gate-fixes.md` and `docs/verification-ticket13-manual-ledger-guard.md`: original141 failed restored citations, foreign-ledger status and recreated-backup startup overlap. Fixes `0ba0edb`/`2ef6d4c` preserve physical CAS and owned ledger errors; `3e4fa3a` adds startup synchronization, tracing removed at `e8b2459`. Four normal cases passed 113,336 ms. Manual P1 `f69fda2` RED 10,364 ms → `a537172` GREEN 10,673 ms. Namespace P2 `b0de1a6` RED 8,270 ms → `2ae4333` GREEN 9,850 ms. Six representative controls passed 88,807 ms. None replaces a complete gate.

## Current design and next gate

Whole-corpus ownership is withdrawn: the unchanged annotation reader test proved it blocked durable removal authorization while the supporting scan was held. The revised design owns only the fresh Info/list/capture/revision core, captures the INITIAL Info physical ledger observation before nested loads, and releases before supporting annotations/Briefs/Ideas/scope. Raw non-acquiring guards at core end and after all unlocked awaits compare that SAME original parent/inode/raw-digest observation outside per-item catches. No baseline rebase or final native reacquisition is allowed.

The sourceInspection admission helper is unchanged: a monotonic two-second total bound, native busy retries only before callback entry, no body/nested replay, mutations fail-fast, live `token.active` and existing lock order. Context alone passes strict `{ annotations: false }` to omit unused appended inspection annotations; public/default inspection and normal recovery remain unchanged. No second mutex, stale fallback, provider retry or timer disablement.

Root preserved RED in `f9e9a76` and the narrow correction in `30966c0`. Independent narrow-tree review found zero blockers conditional on the four focused checks, now passed. The reader committed removal while its scan was held and excluded stale writing; the admission cases and two original controls passed unchanged. Brief overlap traverses multiple corpora; exactly-once means one intended request/provider turn. Details: `docs/verification-ticket13-source-inspection.md`; native owner history: `docs/verification-ticket13-history-contention.md`.

Next: root commits these docs, runs complete-ticket static checks, then the fresh corrected 162-case gate across 20 files and fresh independent exact-tip Standards/Spec reviews. `%TEMP%/companion-ticket13-context-162-argv.json` includes the full 15-case Context suite and three new source cases. This corrected gate is **PENDING**. Durable runner: `%TEMP%/companion-verified-test-runner.cjs`. Required actual results and assigned merger approval precede preserving helper→primary→root integration and closing 13. Earlier failed/stopped gates remain failed/stopped.

## Limits and release sequence

Automatic approval review rejected ONE recursive cleanup command for TWO Temp fixtures before execution, stating only blocked by policy. Leave Temp/companion-deletion-IcAQ2f and Temp/companion-deletion-UC6bGb; do not bypass. Disclose this at final handoff.

After 13 closes, create the committed fresh 16 plan/worktree. `%TEMP%/companion-release16-final-gap-map-20261110.md` narrows new journeys against existing tests. Live sign-in remains deferred/readiness closed. Hosted Actions remain waived, billing-blocked and unverified. Full-spec/final-PR review and required gates precede merge-commit/main ancestry verification, then PAUSE. No deployment.
