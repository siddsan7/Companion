# Ticket 13 affected-writing preview helper

## Scope

Owns app/deletion-dependents.js, the small capture-deletion.js inventory/preview and strict pending-writing hook, capture-delete-view.js display, and tests/deletion-dependents.spec.js. No source authority schema, main, context, preload or source-inventory changes. Root owns Git, runtime, review and integration.

## Acceptance boundary and evidence

The approved boundary is the actual Electron desktop plus resulting files, with controlled provider/time/checkpoints. The frozen tracer creates an imported reviewed synthetic capture, annotation, saved idea, direct and derived conversation requests, readable transcript, and a retained idea intent/stage using actual UI writers. It checks named dependents, byte-exact preview/cancel, renewed review after an idea changes, retained writing after default deletion, support warnings and unchanged provider submissions.

Root observed two distinct fixture failures before the feature: an unrelated context query, then an omitted annotation-save completion wait. Both were corrected without weakening feature assertions. Root then observed true feature RED in 49.8 seconds: all actual setup writes passed, but deletion preview stayed hidden with the changed/unreviewed-writing error. Actual cause: inspectManualPeers classified the validated .ideas UUID Markdown pending stage as source recovery solely because its structured dependency contained the capture UUID. Root preserved/pushed frozen test commit 77a54e7. No helper runtime or GUI commands were run.

## Implementation

Read-only inventory scans ordinary whole-vault Markdown for managed annotation/idea/transcript metadata; fixed .ideas/.transcripts intents, stages and receipts; fixed annotation/link/repair writing layouts; ordinary local conversation records and pending stages through the existing pinned Conversations safeDirectory guard; and cloned unsaved overlays. It never invokes list, corpus, recovery, provider calls, store creation or provenance locators. It records exact file hashes/identities and relevant directory membership in the existing in-memory source preview. Source confirmation compares that inventory twice and never gains authority to remove dependent writing. Rows distinguish preserved affected writing from unknown attribution and show exact request identities and retained text. Structured source dependencies and history references drive closure; quotations are not dependency evidence.

The pending-writing exception is limited to a UUID .md.pending directly in the fixed .ideas or .transcripts folder, paired with the same UUID intent. The intent must use exact current-writer JSON serialization, known independent envelopes, the existing Ideas.intent ownership contract on guarded raw bytes, and Transcripts.validateIntent identity checks, an ordinary contained destination, literal stage bytes equal to intent.text and digest, and either one link or the exact stage/output pair. It runs afresh in inspectManualPeers for preview and deletion recovery. It never deletes, publishes or rewrites independent writing. Changed, malformed or mixed records keep the existing hold.

## Checks and limits

Syntax checks passed for the three production files and frozen test. Root first candidate failed in 50.2 seconds before preview: Ideas is not a constructor. This was an invalid export assumption: ideas.js exports only installIdeas. The candidate now removes that import and checks the existing Ideas.intent ownership contract on guarded raw bytes. Its envelope validation reuses the known current and legacy optional shapes from the sibling idea-removal helper, including structured identity choices/issues. No writer exports or source authority schemas changed. The corrected tracer has now passed; independent review remains pending. No live sign-in/provider gate was attempted. The initial tracer covers local historyIds; foreign historyRefs, unknown attribution, alias rejection, and unsaved overlays are implemented but do not yet have new runtime evidence in this helper. No all-copy or semantic-erasure claim is made; separate archives, comparison records, exports/backups and provider submissions are explicitly disclosed as separately managed.

## Second candidate and observer correction

Root second candidate ran 56.2 seconds. All named dependent preview and byte-exact cancellation checks passed. The later stale-dependent assertion expected a hold but source deletion completed. Source inspection found an observer ordering gap: cancel hides the section but retains its DOM; the test's second toContainText could pass against that hidden earlier preview before the new preview inventory finished. The file edit could therefore precede the fresh token binding. The test now awaits a fresh visible section before each further deletion preview and hidden completion after the second cancel, plus absence of the future edit marker before mutation. All hold and preservation assertions remain. Production was unchanged for the observer correction. The root rerun then passed as recorded below.

## First green

Root reran the corrected fresh-preview observer case (run 6342): 59.3 seconds for the case, 59.8 seconds total, exit 0, no skips. All named writing/request identities, byte-exact preview and cancellation, changed-dependent hold with source preservation, renewed preview and default source purge, independent writing preservation, support warnings and unchanged provider submissions passed. Root retained the passed last-run record at Temp/companion-ticket13-affected-first-green-20261109. The complete run history is two fixture failures, true feature RED at 49.8 seconds, invalid-export candidate failure at 50.2 seconds, stale-hidden-DOM test observer failure at 56.2 seconds, and corrected GREEN at 59.8 seconds total.

Code and tests are frozen for the root's feature and observer commit. This proves the first tracer only. Foreign history references and unsaved overlay behavior are the next single bounded desktop case; the broader helper scope and independent review are not complete or approved.
