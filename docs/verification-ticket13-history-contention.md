# History contention diagnostic — controlled failure captured

The recorded full144 failure reached the second derived send in the existing two-hop foreign-history case. It retained an incomplete failed request with the intake-busy message before later deletion/restoration. The original swallowed stack and actual overlapping owner were not captured. Periodic renderer refresh is a candidate, not an established cause.

The temporary probe changes only this existing test. Its actions, assertions, 180000 ms timeout and retries remain intact. Verified seams are `Conversations.build(input, currentRequestId)`, `Intake.locked/recover`, and `Vault.list/listOwned`; `Context` has no build method. Probe-only async context associates method callers. The native observer filters only actual intake pipe addresses and records listen attempts and actual listening/error/close emissions. It does not acquire a lock, change native arguments, add error listeners, retry work, or change source authority.

Main-process events retain the latest 512 entries, at most 80 caller stacks and 32 original error observations. Renderer events retain 128 entries and observe the verified existing global refresh function, focus and base-refresh completion. The existing minute interval is unchanged. No source bodies or ledger copies are collected on active paths. Instrumentation adds overhead and can mask the race; a passing probe is not closure.

`history-contention-observation.json` is written through `testInfo.outputPath` in finally before fixture cleanup. It includes original method/kernel errors, caller IDs, native ownership boundaries, frontend events, up to three matching synthetic conversation records and this fixture's submissions. An in-memory snapshot immediately before the test's existing restart preserves the first process trace. The restarted process is not instrumented. No unrelated application data or managed sign-in home is copied.

Acceptance: capture the actual busy stack and native owner interval before proposing a product fix. Native listening/close emissions establish kernel ownership; method start alone does not. Distinguish a reentrant owned method from a new native acquisition. Read coordination, if justified by evidence, needs design review and must preserve fresh validation, the existing sole kernel owner and lock order.

## Actual runs

| Run | Candidate | Actual result | Duration (ms) |
| --- | --- | --- | ---: |
| Complete frozen gate | `32000d7`, tree `4a232` | 144 cases: 143 passed, 1 failed (two-hop history) | 3695561 |
| Ordinary observation, flag absent | `870da75`, tree `9a767` | 1 passed; no busy error; expected stale-history rejection; minute refresh without collision | 95577 |
| Controlled overlap, flag `1` | tree `63bc122` | 1 failed at the unchanged second-reply assertion; native contention captured | 66897 |

Root owns these runtime results. The ordinary pass does not identify the original failing owner or close the issue.

The controlled variation is opt-in: set `COMPANION_TEST_HISTORY_CONTENTION_OVERLAP=1` in the test runner environment. Every other value leaves the original observation active without arming a gate, writing checkpoint controls, clicking an additional Refresh or creating a gate timer. Only the second derived send is varied. It pauses at the existing `conversation-before-dispatch` checkpoint, then clicks the real Refresh button. One `Intake.recover` entry is held only when its observed `Intake.locked` caller is `Intake.info` from `app/main.js` and a matching native listening event proves current ownership. A test-only promise holds that existing owner; it creates no lock and changes no source data.

The variation releases dispatch and waits for a real `EADDRINUSE` emission on the same intake address attributed specifically to `Vault.list`, while the original owner remains held. It then releases refresh before the unchanged expected-reply assertion. Both controls release in finally before evidence collection; an independent 10000 ms safety deadline releases the held recovery call if test control fails. That timer exists only in the opt-in variation and does not change application intervals or timeouts. Deadline expiry would invalidate a claimed controlled overlap.

## Controlled evidence

The inspected artifact is `%TEMP%/companion-history13-controlled-overlap-20261110/test-results/deletion-same-byte-restora-0dc25--changing-retained-dialogue/history-contention-observation.json`. Owner call `81` (`Intake.locked`, caller `36`, `Intake.info` from `main.js:73`) acquired native server `82`. Revalidation build `83` carried the second send's `currentRequestId`. Its intake call `84` encountered actual native busy, which `Intake.info` caught; the following `Vault.list` call `86` attempted the same address, encountered actual `EADDRINUSE`, and propagated `INTAKE_BUSY` through build `83`. Original errors and stacks were retained.

The second send persisted as failed with the intake-already-running message and no reply. Exactly three fixture submissions remained. The owned gate lasted about 215 ms, released through test finally, and native server `82` subsequently closed. `deadlineExpired` was false and `collectionErrors` was empty. The original expected `FOREIGNGENERATION_C` reply assertion failed after release, establishing a red-capable controlled seam without a product change.

This proves that an actual state-refresh owner can fail fresh post-intent revalidation under the controlled schedule. It does not prove which owner caused the original full144 failure, nor that its periodic minute refresh collided. A product correction and design review remain pending; source freshness, kernel ownership and lock order remain required boundaries.

Validation: `node --check tests/deletion.spec.js` passed for the frozen diagnostic. This update changes only this report; tests and product source remain frozen. No test, GUI, installation, network or Git command was run by this worker. No product fix or successful controlled completion is claimed.
