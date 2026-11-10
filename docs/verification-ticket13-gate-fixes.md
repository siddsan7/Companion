# Ticket 13 composed-gate corrections

Status: the original three failures and the later plain-manual P1/P2 blockers have bounded corrections and targeted evidence. Four normal cases passed without observers in 113,336 ms; both manual regressions and six relevant controls also passed. Independent Standards and Spec reviewers approve the bounded manual fixes at tree `330dab30e00728b8adceceeedcb017364125290d`, committed as `2ae4333`. The fresh complete gate remains pending: expected 144 cases, subject to actual discovery. The original 141-case full gate failed and the later 142-case run was stopped incomplete. Targeted passes are not a composite full pass.

## Run record

Times are actual elapsed milliseconds. Trees identify the tested state, which may precede a documentation-only result commit. Evidence folders below are under `C:/Users/sidds/AppData/Local/Temp/`.

| Run | Tested commit or tree | Actual result | Duration (ms) | Evidence folder |
| --- | --- | --- | ---: | --- |
| Original full gate | candidate `886550ac`, tree `b107a10d` | 138 passed, 3 failed, 0 skipped; exit 1 | 3,374,493 | `companion-ticket13-final-composed-141-20261110` |
| Broad diagnostic pair | `498b6eb8decdf6227d27ff1a2888b7c29386142f` | 1 passed, 1 failed; exit 1 | 93,875 | `companion-ticket13-gate-diagnostics-two-20261110` |
| Light citation diagnostic | `d9048c058efeac1f935fd20ac0b69b02fdb0d55d` | 1 failed; exit 1 | 67,175 | `companion-ticket13-citation-light-diagnostic-20261110` |
| New inspection regression, before fix | `6fe4ef2c75d82876d56164ccac4064256e423c08` | 1 failed, 0 skipped; exit 1 | 9,904 | `companion-ticket13-ledger-inspection-red-20261110` |
| Same regression, exact-byte no-op fix | `a5a999aec8211a39c50a82784f93c9f3bb4963c0` | 1 passed, 0 skipped; exit 0 | 22,090 | `companion-ticket13-ledger-inspection-green-20261110` |
| Original external-ledger case, specific diagnostic fix | `bf11a93794d13e9bbb8559dba48054f46b392c78` | 1 passed, 0 skipped; exit 0 | 11,918 | `companion-ticket13-ledger-message-green-20261110` |
| Original backup-recovery case, final-startup readiness wait | `aff161f1c07b7ffdfc77098c927763cda9d34162` | 1 passed, 0 skipped; exit 0 | 11,289 | `companion-ticket13-backup-startup-green-20261110` |
| Four normal coupled cases, observers removed | `9ad5394b74d9be9e4af1fa9663ef8185094f4cb6` | 4 passed, 0 skipped; exit 0 | 113,336 | `companion-ticket13-corrected-normal-four-20261110` |
| Stopped 142-case gate | Corrected candidate before manual fixes | 13 completed passes, 0 completed failures; stopped, exit 1; incomplete | 299,371 | `companion-ticket13-corrected-final-142-20261110` |
| Six manual/extended-family controls | `fce9cf95bfdb996beed40185e5e04d50b77451d5` | 6 passed, 0 skipped; exit 0 | 88,807 | `companion-ticket13-manual-authority-coupled-six-20261110` |
| Fresh complete ticket gate | Pending final reviewed composition | Not run; expected 144 cases, actual discovery required | Pending | Pending |

## Restored imported citations: physical ledger drift

Original case 49 failed its second deletion after restoration with the generic changed-files refusal. The broad observer passed this case and recorded equal selected/fresh scopes. That pass did not resolve the intermittent failure, and its approximately 2,000 events could affect timing.

The lighter observer reproduced the original refusal at `CaptureDeletion.confirm` line 281, before authorization. Authority remained active. Only `ledgerIdentity.ino` differed: device and raw byte digest were equal, and substituting only the observed inode made the complete scope JSON equal. Source content, dependent scope and admissions were unchanged. The broad trace separately observed real `Intake.info` / repairs `syncMoves` calls making same-digest ledger replacements. This supports a product defect in a read-only inspection path, rather than a source-family or synthetic-fixture classification problem.

The added regression uses the existing public import, deletion-preview and source-inspection controls without an observer. Before its first feature assertion, it saves actual vault and producer buffers, preview text and ledger identities. On unchanged product source, completed inspection preserved exact ledger bytes but changed the inode. The later continuation was not reached in that failed run.

The product correction in `0ba0edb` skips a byte-identical ledger publication only after the unchanged full current-view, physical-identity and parent guard succeeds. It compares a raw UTF-8 byte digest, preserves the owned baseline, and leaves real writes on the existing flushed-stage/publication path. Schema validation remains in `Intake.save`. It does not waive identity checks, adopt a foreign file, rebase or retry.

The unchanged regression then passed its full continuation. Read-only inspection preserved bytes, inode, vault/producer contents and preview scope. A separately created ordinary ledger with exactly the same bytes and a new inode still made the held preview refuse, without authorization or unlinks. Fresh preview/cancel preserved state; fresh confirmation removed only the source files while retaining original acceptance/admission facts, producer bytes and suppression.

## External ledger replacement: truthful refusal

Original case 75 reached a real source unlink and replaced the ledger externally. Exact foreign-byte preservation passed, but the generic changed-files message failed the expected specific ledger-changed status. The diagnostic stack identified `finishDeletion` line 420; authority remained deleting. Later recovery assertions had not run at that point.

The separate correction in `2ef6d4c` adds an owned ledger guard and delegates only the two equivalent `finishDeletion` checks to it. The same full physical/parent/digest comparison runs in the same order and reports the ledger component's existing specific error. No consequential error-code consumer was found on these deleting paths. The prior no-op guard is unchanged.

The unchanged original case passed: foreign bytes were preserved before Refresh, the specific status appeared, and explicit Refresh completed the original deletion while retaining the foreign suppression entry. Finally-collected after-test bytes legitimately differ from the original foreign bytes because explicit recovery advanced authority to deleted. This does not contradict the passed before-Refresh preservation assertion.

## Backup recovery: final-restart readiness

Original case 92 passed its editor-writing, current-source, held-archive and evidence checks before the final restart. It then clicked Check now before a startup completion boundary and received the existing intake-busy refusal. That message proves concurrent exclusion, not the identity of the original lock owner or recovery corruption. The assertions after that completion status were not reached in the failed full run.

The separate test-only correction in `3e4fa3a` awaits the existing support-status terminal after that final valid held-family restart, before creating the unrelated artifact. This is downstream of the first base refresh and awaited intake repairs. The fixture has no saved ideas, so this report does not attribute its lock to idea support. The marker is not a global idle guarantee and is not applied to invalid-held-state tests.

The original workflow passed all later preservation, unrelated-import, link-count and immutable-attempt assertions in 11,289 ms with its existing 45-second timeout. Current source also included the separately verified product corrections, so this pass does not isolate the wait as the sole causal change. No action, assertion, retry or lock rule was relaxed.

The normal coupled run subsequently passed all four complete workflows with no observers: the original restored-imported-citation case, the new inspection/foreign-same-byte regression, the original specific-ledger-diagnostic case and the backup-recovery case. This verifies the restored citation workflow on the corrected composition; it does not replace the required fresh full ticket gate.

## Later plain-manual authority blockers

The stopped 142-case run is not a full pass. Independent review found plain manual deletion could remove its source before checking changed live ledger ownership. Actual RED proved source disappearance; the unchanged GREEN passed after the unconditional ledger guard. A second actual RED proved false completion when an unknown reserved-prefix whole-source copy arrived after the authorized first unlink. Existing inventory inspections now run for every family before each unlink and completion. The unchanged GREEN held without adopting or deleting the unknown copy; explicit Refresh completed the same scope only after the test removed its own verified arrival. Both manual tests and representative extended controls passed together. Exact RED/GREEN trees, durations, separate commits, review approvals and limits are in [the manual authority report](verification-ticket13-manual-ledger-guard.md).

## Review, cleanup and remaining gates

The deterministic regression was committed separately in `6a2e981`, before the product fix. The no-op design and exact bounded fix received independent reviews in `Temp/companion-ticket13-ledger-noop-design-audit.md` and `Temp/companion-ticket13-ledger-noop-fix-review.md`. The specific diagnostic correction received independent review in `Temp/companion-ticket13-ledger-message-fix-review.md`. These approvals cover their stated bounded changes, not ticket integration, the full PR or live readiness.

Temporary prototype observers, light-probe switching, trace wrappers and opt-in failed-fixture retention have been removed. Original case 49 and 75 bodies and the original cleanup hook are restored. Removing only the unchanged new 66-line regression reconstructs the original deletion test file exactly by normalized-text comparison; the checkout line endings differ. Static literal declarations increased from 37 to 38; the earlier loop-expanded expectation was 54 to 55 deletion cases and 142 total. The two later manual cases raise the full expectation to 144 across 18 files; actual final discovery remains required. Diagnostic traces remain outside the repository. The retained evidence roots are `Temp/companion-deletion-IcAQ2f` and `Temp/companion-deletion-UC6bGb`; automatic approval review rejected both recursive cleanup requests with only "blocked by policy" before execution. Leave these folders as evidence; do not bypass the rejection or ask for workflow permission.

Syntax checks passed for the edited source and tests. Next: discover and run the full immutable 144-case corrected composition, then obtain required final-tip reviews and assigned merger approval. No GUI run is active at this checkpoint. Preserve the failed full-gate record. Exact-tip approval must precede ticket 13 integration and closure. Ticket 16 and the final complete-PR/main-merge review remain separate. Live sign-in remains deferred and readiness restricted.
