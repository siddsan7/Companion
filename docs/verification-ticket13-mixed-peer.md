# Mixed deletion: late adjacent recovery copy

The regression uses the real Electron UI, public deletion controls, persisted files, existing writer checkpoints, and proof that the actual Electron main process exited. It follows the held five-origin setup from `tests/mixed-retention-deletion.spec.js`: admitted A, whole current Y, original held conflict, kept-current resolution conflict, and archived repair containing independent annotation X. It does not fabricate admissions, producer records, repair journals, or authority.

After public preview and confirmation, the test pauses at `capture-deletion-authorized`. It records committed authority and all five unchanged original buffers and identities. It then copies the actual current whole-Y bytes into a new ordinary `<capture>.md.pending` file with exclusive creation. The arrival record includes exact bytes, physical identity, producer files, and the committed ledger before release. It proves the copy has a separate identity and that neither retained output nor a retention stage exists at this boundary.

After release, the test waits for either the real completed-deletion status or the real changed-scope error. It saves the actual terminal status, files, ledger, producer files, and last checkpoint before asserting the required HOLD. Required behavior preserves the entire committed ledger, all five original files, the arriving copy, and producer files, with no writing publication or stage. A fresh public recovery inspection must still describe that unfinished changed scope.

Run from this worktree:

```powershell
npm test -- tests/mixed-peer-deletion.spec.js
```

Evidence files include `mixed-main-exit.json`, `mixed-held-observations.json`, `mixed-peer-authorized-arrival.json`, and `mixed-peer-terminal-result.json` under the Playwright result directory. These contain literal fixture bytes and identities; they are test observations, not application-created source copies.

Implementation stage: test only. No production change. Runtime execution belongs to the root agent; no RED or GREEN result is claimed here yet. Expected baseline failure is actual completed deletion despite the arriving selected recovery copy. Root must record the reached result before authorizing the minimum shared-guard fix.


Root actual regression RED17628ms, exit1/no skips, on stagedtreea812f472295a08dba683130053ad3cbeb7b7d2ae with productbe5e7f0 unchanged. Actual five-origin setup, real main/wrapper exit, authorized source5/nooutputs, and newly copied ordinary same-wholeY .md.pending path all passed before release. Saved actual terminal result is phase deleted, all5consented origins gone, both writingoutputs present, NEWadjacentpending copy still present; expected changed-scope HOLD failed at line175. This reproduces independent P1, not fixture failure. Evidence Temp/companion-ticket13-mixed-peer-red-20261110 includes arrival/authorization/terminal buffers+identities and exit1. Later expected preservation/recovery assertions were not reached. Root GO minimum shared-peer guard inside mixed.inspect before any publication/source mutation; sourcefix must leave test unchanged.

Root's first run with the two-line shared-guard fix failed after 15068 ms at the full-vault snapshot comparison. Before that failure, the real changed-scope HOLD, unchanged authority, all five preserved source files, preserved arriving copy, and absent retained outputs passed. This is partial behavior evidence, not a GREEN result. The snapshot differed only because `CaptureDeletion.confirm` releases its acquired current-file lock in `finally`; `Vault.release` removes that exact `<current>.lock` file on HOLD as well as success. Evidence is in Temp `companion-ticket13-mixed-peer-green-20261110`.

The observer correction proves that exact lock is an ordinary single-link file whose JSON owner PID equals the observed Electron main PID while paused. It records that observed lock and derives the expected post-release snapshot by removing only its exact relative path. Terminal and fresh public-recovery checks require that lock to be absent and every remaining vault entry to match the full observed byte, identity, and link snapshot. No generic lock filter, source expectation, timeout, retry, or production change accompanies this correction. Root must rerun the corrected regression; no successful full run is claimed yet.


Root corrected regression GREEN16039ms, exit0/no skips, stagedtreeb2126c85bd59ffb10fe5f41c9e52f70362c5c57e. Same two-line sourcefix as first fixed attempt: shared adjacent-peer guard now runs inside mixed.inspect before stages/publication/source mutation. Exact currentlock owner/lifecycle assertion distinguishes legitimate finally cleanup; allother fullsnapshot byte/inode/link/ledger/producer checks unchanged. Stable deleting HOLD, all5originals and newcopy unchanged, no outputs/stages, exactcommittedauthority and freshpublic recovery inspection passed. Evidence Temp/companion-ticket13-mixed-peer-corrected-20261110. BaselineRED17628ms and firstfixed15.1s lockobserverfailure remain separately recorded. Required firstmixedpositive+regression coupled and independentreview/merger still follow.


Root fixed firstmixedpositive + peerregression coupled gate passed2/2, exit0/no skips,36969ms (15.2s/21.0s), immutable stagedtreefc0b3266b2fe5c04eafd9189002d7e97e942ac38. The late-copy HOLD and fullX/Y publication/purge/suppression/restart both passed with exact same two-line sourcefix. Evidence Temp/companion-ticket13-mixed-peer-coupled-20261110. No second scanner/owner/format changes. Independent non-author review/merger and exact mainhelper composition still required; no full13/PR approval.
