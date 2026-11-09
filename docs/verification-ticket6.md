# Windows daily intake verification (#6)

Base: `2c27097`. This slice adds explicit Windows scheduling to the existing draft intake. The desktop workflow and resulting files/history are the approved acceptance boundary. Root owns GUI tests, Git writes and all native task operations. The worker made no task registrations, native mutations or escalations.

## Contracts

- Setup is explicit and requires a connected source. Declining the first scan leaves the first scheduled check 24 elapsed hours after setup. First/manual checks do not reset the anchor or consume scheduled slots.
- The exact UTC application anchor is retained. Windows truncates fractional trigger seconds, so the registered first boundary rounds upward by less than one second. Infinite 24-hour repetition retains that offset; application slot admission continues to use the exact original anchor.
- Every intake entry uses the existing `Intake.reconcile` and native vault lock. Scheduled admission runs inside that lock before reconciliation. One attempt consumes every elapsed scheduled slot through the current slot; there is no replay loop.
- Failed/interrupted admitted attempts remain visible and need explicit Check now; the next daily slot remains eligible. Pause blocks queued admission and lets an active import finish. Resume/repair preserve the anchor. Disable removes only the exact owned task and preserves notes, sources and history.
- The task uses the current user's resolved SID, InteractiveToken, least privilege, TimeTrigger, infinite PT24H (Windows may canonicalize this to P1D), IgnoreNew, StartWhenAvailable and no intentional wake. No logon/startup/registration trigger is added. The app performs due catch-up on launch; early launch does not scan.
- Ownership checks require the exact marker, principal SID, action count, executable, arguments and working directory before mutation. Unknown collisions are preserved. First/manual/scheduled successes and terminal errors remain available outside an inaccessible vault.

## Desktop/file evidence

Root observed RED before GREEN for each implementation slice:

1. Setup button absent; then explicit setup/declined first scan/early restart/manual anchor preservation passed (1 case, 7.2s).
2. Late launch did not catch up; then missed-slot coalescing and retained last success through source errors passed (2 cases, 17.0s).
3. OS registration boundary missing; then lifecycle and actual headless Electron entry passed (3 cases, 19.0s).
4. Inaccessible vault lost visible prior success; external terminal metadata fixed it (4 cases, 35.8s).
5. Effective task disabled state was hidden; mismatch display and retained ownership-collision bytes passed (5 cases, 48.6s).
6. Manual success was unavailable after vault loss; manual/first results now persist outside the vault (6 cases, 51.3s).
7. Fractional setup registered an early-truncated boundary; registered boundary now rounds upward while the exact anchor remains unchanged. A repeat exposed stale repeated-Repair status in the test. Controls now expose a disabled busy state and the test waits for actual completion before external mutation. No ownership check or expected foreign bytes was weakened. All seven cases passed (56.5s).
8. Scheduled/manual overlap regression passed with all eight cases (1.1m): hold a real headless worker at snapshot staging, reject manual overlap through the native lock, publish one capture/revision, then skip a second invocation in the same slot. No product change was needed for this regression.

Run: `npm.cmd test -- tests/schedule.spec.js`. Final scoped result: all nine cases passed in 2.0 minutes; the eleven-cycle policy drift/repair case completed in 48.8 seconds. Combined regression is pending root execution. Independent review found missing trigger/settings drift validation beyond Enabled. Root confirmed ninth RED at triggerCount=0. Native inspection and comparison now check count/type/enabled/start boundary/interval/end limits/catch-up/wake/overlap policy separately from ownership. Ninth GREEN and the fresh actual native inspection after the PowerShell change both passed. The probe retains production-inspection.json with actual fields and policyMatches; exact disposable cleanup is required. JS syntax, PowerShell parser and whitespace checks pass on the worker tree. Code and tests are frozen for root checkpoint, synchronization after reviewed #4 integration, combined checks and exact-tip independent review.

## Actual Windows evidence

Root's read-only native adapter probe passed: COM connection, fixed PowerShell script with JSON stdin, and exact absent-task lookup returned null with exit 0.

The first real setup created a task but inspection/cleanup refused it because Windows normalized the registered SID to a local account name. The adapter now resolves either representation to a SecurityIdentifier and compares the exact current SID. Translation failures still reject mutation. Root confirmed exact cleanup and absence after this fix.

An initial automatic UI-closed launch returned task result 0 and imported one authored capture/revision, but simulated slot 4 became slot 3: Windows truncated milliseconds and launched 434ms before the exact application deadline. This was a failed admission criterion, not a passed cadence gate. Its exact task was removed and absence confirmed.

The corrected native run (root evidence run `c`) passed:

- Normal desktop setup retained production anchor `2026-11-08T09:42:56.854Z`; effective first boundary was `2026-11-09T09:42:57Z`.
- A separately labelled accelerated test trigger used `2026-11-08T09:43:55.000Z` and a simulated four-slot history. The real Windows scheduler launched the headless worker automatically with the UI closed; no forced Run operation substituted for this trigger.
- Worker started `2026-11-08T09:43:55.508Z`, completed `09:43:55.635Z`, handled slot 4, imported one capture and one immutable revision, and reported task result 0.
- Root preserved production/accelerated XML, state, observed ledger/files and cleanup evidence. Exact owned task removal returned `exactTaskAbsent: true`. No disposable task remains.

This native run uses explicitly labelled `synthetic_fixture` / `synthetic_video_wiring` producer-compatible files. It proves actual worker launch and access to those files, plus application coalescing under a simulated missed-slot history. It is separate from a real Reel to MD producer handoff.

## Unobserved real gates

Natural consecutive 24-hour recurrence, actual sleep/sign-out missed-run timing, multi-day OS missed-run coalescing and empirical no-wake behavior remain unobserved. Configuration/XML and accelerated triggers do not prove them. These gates remain skipped/pending, so this report does not declare full scheduling or release readiness. Installed-runtime upgrades, history restore and relocation are later lifecycle work; this development task requires the checkout and Electron executable to remain available.

## Repeatable disposable probe

`scripts/probe-scheduled-intake.cjs` is root-only tooling, not application startup behavior. Supply a fresh absolute directory that does not exist:

- `prepare`: use the normal desktop setup with the real scheduler, export production state/XML, then close the UI.
- `arm`: retain separate accelerated evidence, simulate four missed slots and set a whole-second automatic boundary 45 seconds ahead.
- `observe`: retain effective task result, worker terminal state, import ledger, captures and revisions.
- `cleanup`: validate ownership, delete only that exact disposable task, confirm absence and preserve all evidence.

Failed preparation after registration attempts exact cleanup and writes `cleanup-required.json` if cleanup fails. The tool never enumerates or deletes unrelated tasks.

After the policy-inspection change, root repeated a fresh real Windows setup/inspection (run `d`): `policyMatches: true`, one enabled TimeTrigger, exact expected ceiled boundary, canonical P1D, no duration/end boundary, StartWhenAvailable true, WakeToRun false and MultipleInstances 2. Root then confirmed exact task absence after cleanup. This proves the effective inspection/normalization on Windows; the natural timing gates above remain unobserved.

The first full ninth-case attempt completed earlier drift/repair assertions but exhausted the 30-second test budget during a later normal Refresh click. The retained UI had enabled controls and completed repair status. Only this eleven-cycle test now has a 60-second budget and named steps per changed policy field; all assertions and actual completion waits remain intact. The final full repeat passed all nine cases in 2.0 minutes; the policy loop completed in 48.8 seconds.


## Combined integration finding

The first combined 60-case run after synchronizing reviewed #4 ended with 58 passed, one failed and one capability skip (9.3 minutes). It found a test-contract mismatch in the invalid-finalized-bundle guard. The scan correctly reported `held` for mixed valid and held inputs, while the older review helper required `complete` before reaching the integrity assertions. The helper now accepts an explicit expected status, defaulting to strict `complete`. Only the two scans in that guard expect `held`; all held-reason, redaction, immutable-history and independent-valid-review assertions remain. Persisted-ledger assertions require `held` and no healthy `lastSuccess` after each scan, including restart. Production status behavior stayed unchanged.

Root repeated the complete combined suite after that correction: **59 passed, one Windows file-symlink capability skip (9.2 minutes)**. Syntax and whitespace checks passed. Independent read-only actual producer desktop admission also passed on the synchronized tree: one capture/revision, 33 evidence entries, partial/unreviewed status, unchanged source hashes and restart idempotence. This draft handoff and the accelerated native scheduler evidence do not replace the natural timing or deferred signed-in release gates.
