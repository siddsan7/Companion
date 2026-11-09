# Ticket 11: explicitly saved ideas and experiment proposals

Goal: retain a chosen conversation interpretation as an independent vault Markdown note after reviewing its exact content and destination. The approved seam is the ordinary Electron UI plus resulting Markdown, conversation files and operation journals. Tests use the real external stdio fixture, portable authored producer review bundles, controlled time and the existing OS dispatch/filesystem checkpoint substitutes. They do not establish live model readiness or installed Obsidian behavior.

Source checkpoint: `bc9a312`, followed by history-preserving upstream integration merge `73e5afd` from `52488c9`. Root owns actual tests, Git and integration. The implementer ran syntax and whitespace checks. Production and test files are frozen for the coupled gate. The complete ideas/context/conversations gate and final independent ticket review are **pending**; this report does not call them passed.

## Acceptance coverage

| Requirement | Implemented behavior and public checks |
| --- | --- |
| Explicit confirmation and independent writing | Draft controls appear beside retained replies. Title, explanation and limitations are editable; preview exposes exact Markdown and destination. Cancel writes no idea. Confirm writes the approved bytes. Capture and conversation bytes remain unchanged in the acceptance flows. Sending, restart and unsupported results do not automatically create idea notes. |
| Observations and failed analogies | Both kinds save without experiment fields. Two ordinary captures can be dependencies of two independent interpretations, with distinct stable idea identities. Completed, known-attribution saved writing can be found and explicitly selected in a later context preview. |
| Complete Experiment Proposal | Main validates nonblank hypothesis, borrowed mechanism, project application, smallest test and observable result before preview. The note receives the proposal label and five sections only after all fields are complete. Changing kind or fields revokes renderer confirmation. A proposal is never described as an executed experiment or verified outcome. |
| References, uncertainty and ownership | New notes retain the conversation's exact brief `{id, version, digest}`, conservative capture dependencies and separate explicitly selected imported evidence anchors. Source notes are not rewritten to add relationships. Limitations, original output status and support disclosures remain in the Markdown. |
| Original cited revision | Portable accepted revision A is selected in a controlled conversation and cited explicitly. After reviewed B is admitted and chosen current, saved-note inspection still returns literal A. Damage to uncited B does not block A inspection. Damage to cited A reports unavailable with no newer substitution; independent writing is preserved. |
| Failed write and explicit retry | A publication failure retains exact proposed text, destination and operation in a vault journal. Restart exposes a pending proposal without publishing or generating automatically. Explicit resume/confirmation produces one note and one receipt; unrelated editor writing stays unchanged. |
| Crash, identity and containment | Actual Electron main exit is tested after link/before receipt and after receipt/before stage cleanup. Explicit recovery recognizes only the exact owned pair, completes once and does not resurrect a subsequently deleted completed note. Unknown outside hardlinks are rejected before creating a destination peer. Actual `Ideas` and `.ideas` parent junction replacements are rejected while ordinary capture remains usable. |
| Current support changes | Main binds current dependency eligibility/digests and canonical authority at preview. A source edit during paused confirmation prevents publication and preserves the proposal and external edit. A fresh preview can retain historical writing with explicit stale/unavailable support warnings. |

## Actual verification

All elapsed times below are root-reported actual Electron runs. Incremental checks are not a substitute for the pending final coupled gate.

| Check | Actual result |
| --- | --- |
| First explicit-save tracer RED | Failed as intended after a completed controlled reply: missing Draft saved idea control, 53.9 seconds. |
| First candidate exact-text comparison | Failed, 26.9 seconds: the test read the prior readonly text during asynchronous repreview, then confirmed the new preview. Confirmation did not regenerate IDs or bytes. Unchanged proposals now intentionally retain one main-owned identity, operation and creation instant. Subsequent tracer passed, 31.6 seconds. |
| Experiment completeness RED | Missing Saved idea kind, 48.8 seconds. Experiment candidate passed, 33.0 seconds. |
| URI observation correction | Observation failed, 28.9 seconds, because polling threw `ENOENT` before asynchronous dispatch created the output file. The observer now treats only `ENOENT` as pending; exact URI assertions and other errors are unchanged. Both first cases then passed in 1.0 minute: observation 29.5 seconds, experiment 32.9 seconds. |
| Explicit imported citation RED and three-case check | Missing a1 selection, 52.4 seconds. All three ideas cases subsequently passed in 1.8 minutes. |
| Exact evidence damage regression | Passed, 39.8 seconds, with unchanged runtime: damaged uncited B did not block cited A; damaged A showed unavailable/no substitution. |
| Many-to-many/context eligibility | Passed, 39.6 seconds, with unchanged runtime. |
| Interrupted/unselected-memory origin | Passed, 25.4 seconds, with unchanged runtime. Independent writing remained inspectable after restart but was absent from supporting discovery/manual context. |
| Durable failed publication RED/GREEN | RED 27.7 seconds: checkpoint was unwired and save succeeded. After wiring the existing filesystem boundary and journal resume, passed in 29.4 seconds. |
| Unknown outside hardlink RED/GREEN | RED 22.8 seconds: destination was created and stage/outside/destination each had three links; no receipt existed. After exact peer validation before publication, passed in 22.9 seconds. |
| Two crash boundaries RED/GREEN | Both missing-checkpoint REDs took 27.8 seconds each. After narrow checkpoints and exact-pair recovery, both passed: 26.5 and 28.3 seconds, 55.3 seconds total. Tests record actual main PID, wrapper exit and main absence, rather than killing only a shell wrapper. |
| Source-change and parent-junction checks | Source edit initially failed in 28.1 seconds because publication proceeded. `Ideas` and `.ideas` junction cases passed in 25.6 and 25.5 seconds. After current-support binding, source edit passed in 23.2 seconds. |
| Worker checks | Changed JavaScript syntax checks and `git diff --check` passed after the final runtime edit. These supplement actual root-owned acceptance checks. |
| Final combined gate | Pending at this report's creation: `npm.cmd test -- tests/ideas.spec.js tests/context.spec.js tests/conversations.spec.js`. |
| Independent ticket review | Pending. No ticket-complete, integration approval or release-ready claim. |

## Reference and eligibility contract

`app/ideas.js` owns authoring, validation, publication, pending recovery, exact evidence inspection and saved-note identity resolution. `app/ideas-view.js` supplies the ordinary desktop controls through narrow preload/IPC operations. Main constructs the fixed `obsidian://open?path=` URI from a validated unique idea identity and an encoded contained path; the renderer supplies neither a path nor a URI.

The main-owned preview binds original conversation/request identity, retained package and reply, output status, exclusion scope, exact brief pin, editable fields, kind, complete experiment fields, selected anchors and current support state. Unchanged repreview retains its identity and creation instant. Confirmation reconstructs with that same identity and compares content/destination/key after the filesystem checkpoint. Changed context requires a new explicit review. No model call occurs during authoring, preview, confirmation or recovery.

An imported citation anchor is:

```text
kind: imported_evidence
capture_id, revision_id, snapshot_sha256
evidence_id, evidence_kind
start_seconds, end_seconds  # nullable
excerpt, excerpt_sha256
```

Offers require a completed retained request, admitted matching snapshot/evidence, current canonical capture eligibility and the full original source in the retained serialized package. Selection is explicit. The package did not retain structured passage offsets; none are invented. A validated evidence anchor does not establish that a particular explanation sentence is supported. Ordinary captures retain content-digest dependencies; the implementation does not invent immutable revision evidence for them. Annotation, saved-idea and explicit-note dependency forms that lack save-specific supported attribution remain conservatively unavailable as supporting saved-idea context.

Historical inspection is separate from current support. It resolves the single requested admitted revision through ledger capture membership and matching attempt snapshot hashes, then validates ordinary contained parents/file, exact revision identity and selected evidence. It never opens the newest revision as a fallback or validates every unrelated revision before returning the requested one. Current removal/rejection/unresolved status is a warning on still-available historical evidence. Missing or damaged cited evidence is unavailable. Original-media availability and factual accuracy are not inferred from review acceptance.

The preview support snapshot uses the existing authoritative Context corpus and selected identity authority. It binds only original request dependencies, not unrelated corpus issues. Context retains its existing canonical annotation rules, conservative parent closure and exclusions. Saved-idea metadata keeps capture closure and the exact brief pin. The reader explicitly supports provisional legacy numeric brief versions while checking the full pin on new writer records; it does not discard either dependency. Incomplete output and unknown/unavailable attribution remain inspectable independent writing but cannot enter supporting context. Current support checks inherit the Context corpus's broader eligibility restrictions; exact historical citation inspection remains target-only.

## Vault inventory for tickets 12–14

These artifacts belong to the selected vault parent, separately from app-data conversations. Conversation deletion must not remove saved notes or pending independent writing. History archives must not treat these as conversation-store authority or roll back vault intake decisions. There is no automatic retention expiry.

| Path | Contents and ownership |
| --- | --- |
| `Ideas/<slug>--<idea-id>.md` | Independent readable Markdown. Schema-1 `saved_idea` frontmatter includes `companion_id`, title/instant/kind, complete experiment object when applicable, `source_dependencies`, numeric compatibility brief version plus full `project_brief`, `support_attribution_unavailable`, `citations`, and `origin` conversation/request/package/reply/status identities. Body retains interpretation, limitations, support warnings, evidence excerpts and references. |
| `.ideas/<operation-id>.intent.json` | Schema 1: `operation`, idea `id`, `vault`, `destination`, exact proposed `text`, `digest`, `proposalKey`, `warnings`, author `input`, durable `referenceBindings`, and `supportState`. This can contain the only retained unpublished independent writing and source quotations. |
| `.ideas/<operation-id>.md.pending` | Exact proposed Markdown stage. May be unpublished, or the known second hardlink peer of an already published destination awaiting acknowledgement/cleanup. Never infer ownership from link count alone. |
| `.ideas/<operation-id>.published.json` | Schema-1 receipt: operation/idea/digest plus exact `dev` and `ino` identity strings. Contains no proposed text. A completed receipt cannot authorize recreation after deletion or replacement. |

`input` retains author fields, kind, experiment fields, origin IDs and selected `referenceIds`. `referenceBindings[]` maps those IDs to main-validated `{conversationId, requestId, anchor, label}` entries for restart validation. `supportState[]` retains dependency key/original/current digests, exclusion, canonical identity choice/issues, capture source/path/current revision/hash/eligibility/hold flags and warnings. These are validation evidence, not sentence citation proof.

Publication uses kernel-owned mutation coordination, flushed exclusive intent/stage writes and exclusive no-replace linking. Parents are checked for ordinary type, canonical path and retained identity around I/O. Immediately before publication, the stage must have one link with an absent destination, or exactly two links comprising the known stage/destination inode/device pair. Unknown peers are preserved and rejected. Pending stages and published pairs are never exposed by weakening the normal ordinary one-link note reader.

After publication but before receipt, explicit recovery acknowledges only the exact pair without linking again. After receipt but before cleanup, explicit confirmation removes only the known stage. Completed receipts without a stage stay completed even if the destination is edited or deleted. Journals remain for ownership and audit. Source purge in #13 must inventory the full intent/stage/note set and preserve or materialize independent writing before removing source-bearing copies; separate explicit scope is required to remove that writing.

## Limits and deferred gates

- Installed Obsidian opening is **unobserved**. Acceptance verifies the exact fixed encoded URI at main's OS dispatch substitute; it does not prove the installed application's behavior.
- Managed sign-in and live model use remain **user-deferred**. No authentication files or managed-home contents were read/copied. Chat remains unready without the independent production evidence required by #8/#10.
- The portable accepted/edited producer bundles are visibly authored synthetic fixtures. They exercise the actual admission contract but do not replace the required real producer-to-conversation-to-saved-experiment journey.
- Hosted CI remains **billing-blocked and user-waived**, not passed. This does not waive local automated checks or final independent review.
- Controlled failure, hardlink, junction and process-exit cases provide concrete boundary evidence, not a claim of immunity to every operating-system race or storage failure.
- Full release verification, final whole-PR independent review and the authorized main merge/pause checkpoint belong after #16. No deployment is authorized.
