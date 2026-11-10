# Ticket 13: selected transcript removal

This bounded part of D37-I05 removes one explicitly selected transcript export and its displayed app-owned recovery copies. It keeps the originating conversation, source captures, saved ideas, other exports and external backups independent. It does not promise automatic semantic erasure of quotations.

## Observed desktop and file checks

Root ran `tests/transcript-removal.spec.js` through the normal Electron UI with a temporary vault, controlled clock, synthetic provider and controlled filesystem checkpoint. No live model request or sign-in occurred.

- Initial RED: exit 1 in 55.3 seconds. Two exports were actually created. The selected export had its output, intent, receipt and app-created stage/output hardlink pair. The test then failed because the selected-export control was absent. Root committed the test as `afd384cb0c96d4597b0603f87e766f2df0fafad5` before production changes.
- First candidate: exit 1 in 56.9 seconds before removal assertions. The UI exposed both correct export options, but the exact nested-label observer did not select the combobox. This was an observer failure, not a passed feature check.
- Root committed the one-line role-based combobox observer correction as `43f96e7`. Selection identity, assertions and time limits stayed unchanged.
- Corrected candidate: exit 0 in 33.8 seconds; the case took 33.4 seconds. Root observed all four selected copies in the review, byte-exact vault state after preview and cancel, removal of only those copies, and one permanent content-free marker. The originating conversation, source capture, other export, external backup and provider submission log stayed unchanged. Restart did not recreate the removed copies.

Root retained initial RED evidence under `Temp/companion-ticket13-transcript-removal-red-20261109/` and the failed observer attempt under `Temp/companion-ticket13-transcript-removal-attempt1-20261109/`. These are local evidence locations, not repository artifacts. The worker ran syntax checks only; root owns desktop execution and Git operations.

## Removal authority and publication

The fixed `.transcripts/<id>.removed.json` marker is permanent. Its strict schema contains the selected transcript `id`, original `exportOperation`, a new removal `operation`, vault and destination binding, canonical parent identities, and exact targets. Each target binds its path, role, literal SHA-256, device, inode, byte size and complete known hardlink peer set. No transcript, question, source excerpt or title is stored in the marker.

The writer exclusively creates `<id>.removed.json.pending`, records the actual created inode before serialization, writes the exact marker bytes and flushes the handle. It retains those exact bytes and inode for the entire attempt. It publishes the final marker with an exclusive hardlink and validates the exact known stage/final pair. A strict self-inode field does not replace these per-attempt checks and does not provide cryptographic protection against fully rewritten local authority.

Removal uses the existing Conversation then `.transcripts` lock order. Preview uses raw guarded reads and does not call Context, snapshot generation, recovery or folder creation. Confirm revalidates the whole reviewed scope before the first write. It commits removal authority before deleting any selected writing. It then checks the whole remaining scope, checks each target again immediately before unlink, and verifies final absence. Changed files, unknown peers and new copies hold the operation.

Fixed final-marker or pending-stage presence fences old export confirmations, resume and acknowledgement paths. Publication checks the fence before writes, after controlled checkpoints and immediately before output publication or stage cleanup. A fresh explicit export receives fresh identities. Every reader and writer shares the same-instance `.transcripts` directory identity guard; disappearance or replacement after observation holds the store. This does not claim a durable cross-restart inode proof.

Complete valid pending-only authority can be explicitly reviewed, revalidated and atomically linked to its final marker before target removal. Partial or malformed authority cannot authorize erasure. Pending removals are shown separately. Their content-free controls do not globally block unrelated valid exports when shared folders remain valid.

## Remaining checks and scope

The observed checks do not complete ticket 13. The finite coupled gate and independent review remain required before integration. Complete ticket 13 and ticket 16 release gates remain separate obligations.

## Original coupled gate and review blocker

Root session `33780` passed all 21 coupled cases on unchanged `7989a203bf8a633600cc39ff41fec140c2f19dd6` in 10.3 minutes, with no skips. Root retained the last-run result and stale-confirmation diagnostics under `Temp/companion-ticket13-transcript-coupled-green-20261109/`.

Independent Standards review approved that bounded tip. Independent Spec review remains blocked by P2: hardlink peer construction uses default string ordering, while strict marker validation requires locale ordering. A legal lowercase destination such as `a/Transcript.md` and its app-created `Companion/.transcripts` stage can produce removal authority that rejects its own peer order. The passing original gate does not cover that destination and is not final-tip approval.

The focused regressions use that lowercase destination for normal removal confirmation and for actual main-process exit after removal staging followed by explicit recovery. Both retain a real app-created output/stage hardlink pair from the controlled post-receipt export interruption.

Root session `99195` reproduced both failures on unchanged production: exit 1. The recovery case took 30.3 seconds, recorded an actual main-process exit, and then found Resume disabled after restart. The normal case took 37.7 seconds, reached confirmation, and received the strict scope error without completing removal. Root retained the 222-byte actual-exit proof and failure evidence under `Temp/companion-ticket13-transcript-lowercase-red-20261109/`, then committed the tests and checkpoint as `33c30a1` before the fix.

The minimum fix changes only the two hardlink peer construction sorts to use the existing locale comparator. Parent and target ordering, strict uniqueness validation, marker schema and immutable authority remain unchanged. This preserves previously valid marker ordering. Syntax passed.

Root session `59030` passed both focused lowercase regressions on the unchanged candidate: exit 0, no skips, 1.1 minutes total. Actual stage-crash recovery took 30.0 seconds; normal removal took 34.4 seconds. Both workflows reached their final assertions, including explicit recovery, exact selected-copy removal, retained independent writing and restart stability. Root retained the 222-byte actual-main-exit proof and last-run result under `Temp/companion-ticket13-transcript-lowercase-green-20261109/`.

Root session `8420` then passed the final coupled gate at `4edd61b`: 21 of 21 cases, exit 0, no skips, 9.9 minutes. After the gate, root passed syntax checks for all five changed JavaScript files, the project's `npm check`, and the diff check. Root retained three actual-exit proofs (223, 221 and 226 bytes), two stale-confirmation diagnostics (656 and 688 bytes), and the last-run result under `Temp/companion-ticket13-transcript-final-coupled-green-20261109/`.

The remaining bounded-helper step is fresh independent review on both axes at the final documentation tip. These results do not claim merge authorization or whole-ticket approval; complete ticket 13 and ticket 16 obligations remain separate.

## Retained intent with missing output

Root ran a second desktop/file vertical after the first implementation milestone. The normal UI published an export. A controlled external file removal then removed its output, leaving the app-owned intent as the only retained export writing and keeping the original publication receipt as historical metadata.

- RED: exit 1 in 25.8 seconds. The selected intent and receipt were present, but removal review stayed hidden because inventory required a current output or stage. Root committed the regression as `e1f85b444954a3f1a9ebc1f8ead852faa1527412` before the fix. Evidence is under `Temp/companion-ticket13-transcript-intent-red-20261109/`.
- Minimum fix: allow exact valid retained intent scope without a current output or stage. A receipt still binds its strict fields, original transcript ID, export operation, digest and decimal historical device/inode values. Any present stage or output must still match actual known peer and receipt identities. An absent output supplies no current ownership or peer proof. Normal export acknowledgement and publication cutoffs are unchanged.
- The removal review now states that the missing output will not be recreated and that the retained receipt records historical identity facts. It lists only present selected files. Fresh inventory comparison and committed-scope checks hold a destination that reappears outside the reviewed scope.
- GREEN: root session `25930`, exit 0 in 27.8 seconds; case 27.4 seconds. Preview and cancel preserved exact bytes. Confirm removed the exact intent and receipt without recreating output. Origin conversation, source capture, external backup and provider submissions stayed unchanged. Restart kept the same result.

The original paired-export regression then passed on the same source: root session80551, exit0,33.6 seconds (case33.3). Its exact four-copy scope, mutation-free cancellation, selected-only removal, retained origin/source/other export/backup and restart checks remained intact. These are two focused runs, not a complete release gate.

## Actual main-process exit and explicit recovery

Root session `85300` passed one parameterized behavior at three removal boundaries on unchanged `4021240` production: exit 0, 1.6 minutes total; cases 32.1, 31.9 and 32.0 seconds. No production change or manufactured RED was needed.

- `transcript-remove-after-stage`: complete pending-only authority remained intact. Restart did not publish authority or erase targets. Explicit reviewed recovery published the final marker first; a second controlled pause proved the known marker/stage pair existed while all original selected targets remained intact.
- `transcript-remove-after-tombstone`: the exact two-link final-marker/stage pair remained intact across process exit and restart. Recovery required explicit review and removed only the committed selected scope.
- `transcript-remove-after-unlink`: one selected target was already absent. Restart preserved the remaining partial scope. Explicit recovery finished the same manifest once and retained the same permanent marker.

Each case recorded the wrapper PID, main PID, wrapper exit result and observed main-process exit in its own `testInfo.outputPath` JSON before restarting. Root verified and copied all three distinct proof files (223, 222 and 226 bytes) to `Temp/companion-ticket13-transcript-crashes-green-20261109/`.

All three cases verified no automatic mutation on restart or preview, no reconstructed output, an unchanged content-free permanent marker after completion, exact selected-file absence, and preserved originating conversation, source capture, other export, external backup and provider submissions. A second restart offered no duplicate recovery and kept the same persisted result.

## Stale normal-export confirmation

One finite behavior uses a controlled failure after the original publication receipt. That leaves the actual normal export confirmation token visible. The user then explicitly removes that export and presses its stale normal confirmation. The behavior covers both an intact removal marker and external removal of that previously observed marker while the `.transcripts` directory identity stays unchanged.

Root session `45650` produced a real RED: one pass and one failure, exit 1 in 1.0 minute. The intact-marker case refused stale publication in 30.9 seconds. The external-marker-loss case failed in 28.8 seconds: the stale token recreated the old output (3,581 bytes), intent (5,089 bytes) and receipt (252 bytes). Tests saved actual status, export identities, unchanged parent identities and unexpected file hashes before refusal assertions. Root retained the distinct 607-byte and 1,354-byte diagnostics under `Temp/companion-ticket13-transcript-stale-red-20261109/` and committed the behavior as `aadab5b21658da77c8db1c69adadf9cd0a81eaec` before the fix.

The minimum fix remembers refused transcript IDs in the existing store instance, keyed by vault and application-root paths. It remembers its own created removal control and observed fixed marker/stage presence, including listing before parsing. The remembered ID continues to refuse old publication and acknowledgement when its control later disappears, including after same-vault reconfiguration. This memory only refuses: it cannot authorize unlink, reconstruct controls or relax strict loaded-marker and per-attempt identity checks. Fresh explicit exports still receive new IDs.

Root session `54007` passed the focused two-state rerun. Root verified durable `.last-run` state `passed` with no failed tests and inspected both actual diagnostics: directory identities stayed unchanged and `unexpectedReappearances` was empty. Fresh explicit export assertions also completed. No duration was recorded from this checkpoint. The behavior also checks exact preserved vault bytes after stale confirmation and unchanged originating conversation, source capture, other export, external backup and provider submissions.

The cache lasts only for the process. External loss of every durable removal control across a process restart cannot be inferred from memory. This is an explicit limit; no cross-restart authority reconstruction is claimed.

## Bounded ownership guards

Root session `75924` passed both ownership states on unchanged `908f972` production: exit 0, 53.8 seconds total, 26.7 seconds per case, no skips. No production change or manufactured RED was needed.

- An unknown external hardlink was added to the selected output after review. Confirm refused before creating removal authority. The alias, its bytes and the selected output's link count remained intact.
- The known `.transcripts` folder was moved aside and replaced with an ordinary new folder containing independent writing after review. Confirm refused before creating removal authority. Both the retained original store and replacement-folder writing remained unchanged. The test closed the app and restored only its own fixture folder.

Both cases verified the exact post-change vault bytes, all selected copies, other export, originating conversation, source capture, external backup and provider submissions remained unchanged. The final fixture vault matched its original bytes. At that checkpoint the coupled gate and independent review were pending. The final coupled result above supersedes that checkpoint; these two ownership guards alone are not a release gate.
