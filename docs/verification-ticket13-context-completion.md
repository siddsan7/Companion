# Ticket 13: Context action completion

## First vertical slice: current Find choices

Goal: while Find reads current capture text, earlier result and manual Add controls cannot select stale evidence. After the current Find completes, the user can explicitly select the fresh capture and preview its new text.

Authorized seam: real Electron desktop controls and persisted disposable vault files, with controlled delivery timing at the existing main-process IPC boundary. Discovery and preview use their actual handlers. No source bytes, digests, generations, results or errors are fabricated. This catches stale actionable choices across a pending Find; it does not establish overlapping-request ownership, passage approval completion or live provider readiness.

Regression: `a pending Find retires earlier context choices until current capture text is ready for explicit selection` in `tests/context.spec.js`.

Filter: `--grep "a pending Find retires earlier context choices until current capture text is ready for explicit selection"`.

The test first establishes an earlier result and manual option, then changes the capture on disk. Its wrapper calls the existing `context-find` handler exactly once per invocation, awaits the genuine result and holds delivery. At that gate it checks that earlier result actions and manual Add are unavailable, the manual selector is disabled, and visible feedback reports “Finding context…”. It releases delivery, requires visible “Context search complete.” feedback, explicitly adds the fresh result, and checks that the actual package contains the newly written text without a freshness error. `finally` restores the handler and releases the gate even when an assertion fails.

Constraints: preserve existing selections and exclusions, backend freshness and generation guards, ordinary timers, default 30-second test and 5-second assertion budgets, and all six temporary observer hooks. The new title is outside the observer whitelist. No implementation change belongs in this first authoring phase.

Acceptance evidence: pending root execution of the unchanged regression against baseline (RED), then the smallest reviewed implementation and unchanged regression (GREEN). `node --check tests/context.spec.js` passed at author handoff. No runtime result is claimed here. Existing changed-source, restoration, annotation and later passage checks remain required by the plan.


## Actual Find baseline RED

Root ran the unchanged new regression after locked npmci and explicit pinned Electron45.2.3 binary installation/verification. At staged tree8d3dc732fb41aef95074d4fe578f56af6f25dcf5, it FAILED1/0skip/exit1/8927ms. The real result-held flag was reached; original5s assertion observed FOUR enabled stale result/manual controls instead of0 at tests/context.spec.js:57. Finally released/restored the real handler and existing fixture cleanup completed. This is actual product RED, not setup failure. Raw Temp/companion-ticket13-context-find-red-20261110; runner94901 completed and copied artifacts. app source remained unchanged. Implementation/GREEN and other boundary checks remain pending.


## Find implementation and bounded verification

The local Find owner retires all[] and result/manual controls synchronously, exposes aria-live pending/completion/failure feedback, and alone may publish success/error/finally. Question edits, New/switch and explicit conversation retry retire the old owner. Existing selections, exclusions, digests and generations are not silently updated. Generic run catch no longer handles obsolete Find failures. Context search helper now verifies old completion is absent after input and awaits current visible completion; original behavior assertions/budgets and observer hooks remain.

At exact stagedtree81140dea3d077d5c7c0673295b2d827abc122146, five-case gate completed FAILED4pass/1fail/0skip/exit1/22967ms. The UNCHANGED delayed-Find regression PASSED1.4s (baselineRED8927ms), moved annotations4.6s, changed-source2.8s and manual restoration4.5s passed. Missingcanonical still failed actual Intake busy during identity choice8.1s; this is not a complete green group. Raw Temp/companion-ticket13-context-find-green-five-20261110, runner81235 completed/copied. Its actual trace shows both Finds completed before Refresh; old repair choice submitted while current repairs read was pending, and a different current inventory token arrived19ms after refusal. Native lock acquisition itself was not recorded. Temp/companion-ticket13-current-find-repair-order-analysis-20261110.md retains the separate diagnosis.

Independent bounded source review APPROVED preserving the Find milestone at81140dea, no blockers: Temp/companion-ticket13-context-find-bounded-review-20261110.md. This approval is limited to Find; passage, repair-choice ordering, clean observer-free gates and full162 remain required. All source/backend security, native fail-fast mutation behavior, timers and live-readiness restrictions remain.
