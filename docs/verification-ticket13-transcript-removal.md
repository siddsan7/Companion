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

The observed GREEN covers the first published stage/output pair vertical only. It does not complete ticket 13. Required follow-up verticals include retained intent-only writing, process exit around authority publication and target removal, stale export confirmations and acknowledgements, changed files, unknown aliases, and folder replacement guards. Independent review and relevant regression checks remain required before integration. Complete ticket 13 and ticket 16 release gates remain separate obligations.
