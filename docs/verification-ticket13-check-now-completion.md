# Ticket 13: Check now completion boundary

The root plan is `.brain/plan-ticket13-check-now-completion.md` at e24efbb. The original complete162 result remains FAILED149/13. After the composed UI corrections, the original three-case run FAILED2/1/14408ms in the mixed second held-check setup. Two subsequent observations passed (5499ms and 15483ms); they did not reproduce or prove the historical native owner. These results do not establish the historical failure's cause.

## Independent regression: actual RED pending

`Check now stays unavailable until its own repair refresh completes` in `tests/repair.spec.js` uses the existing real producer fixture, desktop launch, vault setup and draft connection without scanning. It saves every producer file's exact bytes before intake. The first explicit Check invokes the genuine `check-intake` handler once. Only after that handler returns does the next actual `Intake.prototype.repairs` invocation become eligible for the controlled hold.

That invocation temporarily wraps its own instance's existing `locked` method. The wrapper delegates to the original method exactly once and waits inside the callback after the original native owner has been acquired and recovery has run. After release it invokes the original repairs work exactly once. It preserves method arguments, callback arguments, results and thrown errors. It acquires no additional owner and does not fabricate contention, errors or state. The instance's original own-property descriptor is restored, or the temporary own property is deleted when the method finishes. The prototype and genuine IPC handler are restored in finally; cleanup releases and awaits any held invocation first.

While that real repair owner is held, the first public requirement is that Check now remains disabled. A transparent wrapper around the existing renderer click handler records settlement after invoking the original handler exactly once. The held first action must have one native Check call and zero renderer settlements. After release, its renderer handler must settle, the public completion status must appear, and Check now must be enabled. One later explicit Check must settle separately with exactly two total native calls. This avoids treating unchanged old completion text as evidence that the second refresh finished.

Both checks must leave one visible capture, one persisted capture, one immutable revision snapshot and one revision in the actual ledger. The ledger must report a completed manual check. Producer filenames and all original producer bytes must remain exact. No approval, inference, source or native-admission guard is bypassed. No timer, default 30s test budget or default 5s expectation budget is changed; no retry or extra manual Check is added.

The controlled hold can establish a current UI lifecycle defect if the disabled-button assertion fails. It cannot establish the exact native owner of the historical full-run failure. Actual baseline RED is pending with root; setup failures or unrelated assertions do not count as that evidence. Root owns runtime, dependencies, Git and actual RED/GREEN execution. Only this one test and this report were authored; product files and existing tests are unchanged.

Static verification: `node --check tests/repair.spec.js` passed with exit 0. The new test, actual `Intake.locked`, installed `repairs` implementation, IPC handlers and renderer completion path were inspected. No desktop run, install, Git operation or network access was performed by this author. Changes are frozen for root's bounded baseline run.


## Actual controlled baseline RED

At stagedtree2e7baf010c14eb1b1d3369b674cadef61bc3da61, the genuine first manual check completed and its actual repair native-owner callback reached held. Original5s disabled-button assertion FAILED: Check now remained ENABLED at tests/repair.spec.js:89. Complete result1failed/0skip/exit1/10298ms, raw Temp/companion-ticket13-check-completion-red-20261110. Finally released the original callback, awaited instance restoration, restored prototype/IPC/renderer wrappers and existing fixture cleanup completed. Later second-check/producer/persistence assertions were unreached. No additional lock, replay, fakeerror or source edit. This proves controlled UI lifecycle defect; the exact historical failed mixed owner remains unproved. Smallest frontend pending guard and unchangedGREEN remain next.


## Initial pending guard milestone: one review finding open

Root's frontend handler sets pending synchronously and retains it across actual check-intake and its own Refresh. Handler entry and button state block repeated action; finally enables explicit retry unless configuration remains busy. Configuration controls respect an in-flight check; success/error reporting is bound to the current configuration. Existing shared UIerror ownership field was renamed canReport for read/action use; no backendretry/lock/model/timer change.

The UNCHANGED native-owner regression PASSED1/0skip/exit0/5493ms at stagedtreef9c3b71c61559f7b8a96d517249fff24e2b0ff43, including second explicit check, onecapture/revision and exactproducerbytes. Raw Temp/companion-ticket13-check-completion-green-20261110; runner completed/copied. An additional DOM-disabled entry guard at treee9a4b39f169921b04d1e07e6d16519b9f9386cb1 aligns configuration frontend blocking; subsequent combined checks remain pending.

Independent review REQUESTED CHANGES for ONE P2: Check catch overwrites a Refresh error's stronger canReport (configuration+refreshEpoch) with configuration-only ownership, permitting a stale same-vault read error to report later. Temp/companion-ticket13-check-completion-bounded-review-20261110.md. Preserve this feature milestone separately; add a real-error/current-success regression and compose existing ownership predicates in a follow-up fix. This source is not approved for integration yet. Historical failedmixedowner remains unproved; observercleanup and clean/full gates still required.
