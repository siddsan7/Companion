# Ticket 13 selected annotation removal — candidate

This helper implements a separate annotation review and removal action. It does not establish ticket completion, review approval or a passed live gate.

## Observed RED and candidate checks

Root ran the unchanged desktop/file tracer after real import and two normal annotation saves. It failed at the missing **Review annotations** action, line 64, in 43.5 seconds. Later assertions were not reached. Root retained evidence in `C:/Users/sidds/AppData/Local/Temp/companion-ticket13-annotation-red-20261109` and committed the test as `b36a9d7` before production work.

Root then ran the unchanged first desktop/file tracer on the first implementation candidate: one passed, no skips, exit 0, 23.2 seconds for the case and 23.7 seconds total (session 70726). This establishes the ordinary selected-note workflow and its stated preservation/restart assertions. It does not establish concurrent-reader or stale-writer safety.

The helper ran syntax checks on annotation-authority.js, annotation-removal.js, annotation-removal-view.js, intake.js, repairs.js, main.js and preload.js. All passed. The helper did not execute Electron, tests, model calls, native checks or network operations. Root owns the next failure/recovery slices and independent review.

## Open independent audit blockers

The read-only pre-runtime audit in `C:/Users/sidds/AppData/Local/Temp/companion-annotation13-candidate-audit.md` found three concrete blockers. The passing ordinary tracer does not cover them:

1. Writer fences call `this.load()` and rebase IntakeLedger.expected while syncMoves/holdLink can retain an older ledger object. An external valid ledger replacement at link-intent-published can then be overwritten by the stale caller. Next slice: normal relationship success and conflict paths must preserve the external ledger exactly. Proposed fix: inspect and validate the current view against the originating expected view without rebasing it.
2. Native Windows relationship journals serialize file paths with backslashes. The remover currently rejects those paths. A later slice must use actual generated held relationship records, validate native paths through the existing destination boundary, and canonicalize only manifest paths.
3. Supporting annotation reads observe removal authority before asynchronous scan/ownership reads and do not recheck it afterwards. An in-flight read can return a newly removed annotation. A later controlled reader/removal interleaving must show that removed writing cannot enter discovery or a preview. Serialization through the existing reentrant sourceMutation lock is proposed, subject to lock-order and CAS-baseline review.

These remain open blockers. No helper-wide approval or complete Context exclusion proof is claimed.

## Authority and scope

`ledger.annotationRemovals[annotation UUID]` contains only operationId, phase, captureId, canonical vault root, pinned directory identities and exact file targets. A target binds normalized vault-relative path, literal SHA-256, device, inode, byte count, kind and its sorted full known peer group including itself. The strict kind allowlist covers annotation notes, annotation intent/stage, and relationship journal/before/stage/held writing. All target parents and the vault root are pinned. Namespace validation prevents annotation scope from selecting source journals. Raw classification checks the annotation UUID and capture binding. Unknown aliases, changed bytes/identities, unsupported records and new copies hold the operation.

Preview and cancel read the raw vault and guarded ledger without setup, Intake.locked, recovery, relationship updates or Context. Confirm rechecks preview and ledger identity under sourceMutation, then saves permanent `removing` authority through Intake CAS before any unlink. Each unlink rechecks the entire remaining scope, pinned parents, expected known peers, target identity and ledger CAS. Relationship payloads are removed before their journals so a crash leaves classification evidence. Completion verifies absence and records `removed`; both phases permanently fence that UUID.

Recovery is explicit through **Review unfinished annotation removals** and **Resume reviewed annotation removal**. Startup does not finish an annotation removal. It leaves known removed annotation/link/repair intents untouched and safely held. The explicit remover owns cleanup. A resumed operation cannot broaden its original targets. Unknown new copies hold instead of being absorbed into consent.

Intake.annotations excludes removing/removed identities before the first unlink, so Context cannot admit their supporting writing. The raw removal reader stays separate. Normal annotation/link/repair publication checks the same permanent authority, including publication and acknowledgement boundaries. Fresh independently authored writing uses a new UUID. Public pure seam: `assertAnnotationPublication(ledger, annotationId)` from app/annotation-authority.js throws `ANNOTATION_REMOVED`; primary mixed-writing publication must use it under the existing sourceMutation lock.

## Limits and remaining evidence

Mixed repair JSON containing the selected UUID holds before consent. This helper never deletes a whole mixed record from annotation consent. The primary worker must first preserve and split retained source or other writing through its own reviewed workflow. The standalone list currently starts from published raw annotation notes; unpublished-only recovery identities need a later evidenced review-list extension. The action works independently of source browsing and therefore remains available after source deletion.

Other annotations, source/current revisions, saved ideas, conversations, transcripts, external exports/backups and provider submissions remain outside annotation scope. Retained writing can include quotations. This is scoped managed-copy removal, with no semantic erasure promise. If the entire intake authority is externally lost or replaced with an earlier backup, the permanent refusal can also be lost; this implementation does not reconstruct missing authority from deleted content.

The initial unchanged tracer covers preview/cancel byte equality, selected removal, unselected annotation/source/revision/producer preservation, immutable source ledger fields and restart absence. It does not yet establish actual process-exit recovery, stale writer refusal, relationship held-copy cleanup, changed/unknown peer holds, Context exclusion after authority commit, source-deleted review, or mixed-repair HOLD. Root owns those next finite desktop/file slices and independent review before integration.
