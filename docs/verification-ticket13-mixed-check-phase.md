# Ticket 13: minimal mixed held-check observation

This test-only diagnostic replaces the heavy visible-action helper import in
`mixed-retention-deletion.spec.js`. It installs only for the exact missing
receipted-output title. The original six-case helper and its history are unchanged.
No product correction is selected. Root owns runtime, installation, Git and review.

## Goal and checks

The original complete run failed 149/13. The original three-case run failed its
second held-check setup before the native-unlink scenario. The first heavy-observer
rerun passed in 5499 ms; first Check handler settlement preceded second click by
98 ms. That pass did not establish the old cause. Its first two deliberately
terminated main sessions lost their main rings. Preserve those attempts.

Capture actual Check/support IPC and actual Intake pipe acquisition/release with
less scheduling overhead. Distinguish overlapping frontend work, an independently
failed backend check, and a successful new check hidden by an older render.
Native EADDRINUSE plus listening/close can identify a competing observed pipe
listener; a pending RPC alone cannot identify its native owner. After two attempts
without discriminating evidence, reassess instead of repeating passes.

Acceptance is bounded evidence with explicit coverage and unavailable-data labels,
preserved original invocation semantics, and no changes to actions, assertions,
waits, budgets, retries, timers, source or locking policy. Static author checks are
syntax and owned-file inspection only. Runtime success remains unverified.

## Evidence and transparency

`mixed-check-phase-setup.json` is saved once, immediately after the existing second
Check assertion succeeds. The Check counter must equal 2. No observation read or
file save is inserted between first Check completion and second Check dispatch.
This preserves the first live main ring before later deliberate main exits.
`mixed-check-phase-final.json` is saved by afterEach before existing cleanup, also
when the second Check assertion fails. It never overwrites the setup file.

Each main memory observation has a 2000 ms deadline. It clears its observation
timer and handles late read rejection. Collection failure records unavailable
evidence; it does not replace the original assertion/error or extend its budget.
There is no main quit-file fallback. Earlier deliberately terminated sessions
remain unavailable in final output; their live setup snapshot is separate.

Actual `ipcMain._invokeHandlers` wrappers whitelist only `check-intake`, `state`,
`vault-repairs`, `idea-list`, and `connect-reviews`. Each original is called once
with its original receiver and arguments. The original value/promise is returned;
synchronous errors are rethrown unchanged. Side observers record start, return,
rejection or throw plus scalar status, vaultError, and lastCheck at/status/trigger.
No arguments, result bodies, source content or large-object hashes are recorded.

A separate diagnostic AsyncLocalStorage namespace labels asynchronous work with
channel/call numbers. The actual existing `net.Server.prototype.listen` is
delegated once with unchanged arguments, receiver, callback and return/error.
Only paths containing `companion-intake-` attach lifecycle observers. Each listen
attempt records its ordinal and existing 64-character pipe suffix, followed by
actual listening, error code and close events. The suffix is already the product's
canonical-root hash; this diagnostic never reads or hashes the root. Domain error
listeners are installed before listen; observer callbacks never throw or replace
domain handling. No owner, lock, retry, queue or new application state is added.
An absent ALS label is explicitly unattributed, including background work.

Main and renderer each retain at most 256 scalar events with sequence numbers,
wall time and their separate monotonic clock origins. Renderer events stream to a
bounded host console buffer so deliberate main termination does not erase them.
Renderer observation covers only trusted Check clicks, the existing actual Check
onclick start/settlement/error, the short status text, and the current lastCheck
paragraph. The onclick wrapper preserves receiver, arguments, original promise
and error. A MutationObserver watches only status/intake text changes. There are
no Context snapshots, frame polling, per-RPC renderer evaluations or test waits.
No managed home, app-data, credentials or fixture-store files are read by this
helper. The evidence writer writes only testInfo output paths.

## Limits and interpretation

Installation follows the original timezone-ready wait. Earlier startup operations
and already acquired pipes are not reconstructed. Ring eviction is counted; the
main installation reports missing channels and the renderer reports whether its
Check handler was wrapped. Observer installation errors are recorded best effort.
Pipe callbacks carry the listen caller label, not a claim that every enclosing
RPC is pending until close. Unattributed pipe events cannot establish an RPC owner.
The ordinals identify listen attempts in each session. The current lock creates a
fresh server per attempt. No independent native OS enumeration is added.

DOM status mutation timestamps indicate observer execution, not exact write time.
Main and renderer monotonic times cannot be directly subtracted. Compare wall
times, call numbers and actual handler settlement. Background work can outlive
RPC return; native close is the release evidence. Observer cost can still change
scheduling. A passing instrumented rerun proves neither the historical cause nor
a source correction. Remove diagnostics in a separate preserving change before
clean relevant workflows and the complete gate.


## Actual minimal observation

Root ran the unchanged original case at stagedtree32bdd7b3f283fa29975f654468b7dfd9d11ff342: PASSED1/0skip/exit0/15483ms. Raw Temp/companion-ticket13-mixed-minimal-phase-20261110; runner39948 completed/copied. The separate after-existing02 setup snapshot preserved session1 live main/native data before deliberate exits: no observer errors, missing channels, drops or nativepipeerrors. Actualcheck8 returned01/manual/complete; check11 returned02/manual/held. First Check frontend returnedwall1794341983288, second trustedclick3440 (152ms later). No self-overlap was observed. Final unavailable closed sessions are separately labeled, not repaired by inventeddata.

This is a SECOND observational pass without historicalfailure/cause closure (earlierheavyobserverPASS5499ms). Root stopped blindrepeats and committed plan e24efbb for ONE controlled existing-native-owner hold to test Checkbutton lifecycle. Sourcefiles here remained unchanged; no product fix/causeclaim follows from this passing observation. Preserve all diagnosticcommits and remove temporaryhelpers separately beforeclean verification.
