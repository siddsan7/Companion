# Ticket 13: separately selected saved-idea removal

Goal: let the user deliberately remove one saved idea and its displayed managed proposal/publication copies. Keep capture deletion, originating conversations, transcripts, other ideas and external backups separate. This is a bounded parallel part of #13, not a new ticket or permission.

Base: ticket/13-source-deletion at 3bf9c9b. Primary worker continues manual held recovery. Use a separate worktree/branch; preserve all commits. Root owns Git, installs/network, desktop tests, review and integration. The worker owns Ideas removal code, Ideas UI and new acceptance cases only. Do not edit capture-deletion, source-authority, source-recovery, capture-delete-view or existing deletion tests. Coordinate the small preload bridge addition at merge.

Read the originating specification/ticket and domain guidance. Source pointers: Temp/companion-spec-1-current.md, Temp/companion-deletion13-mixed-removal-design.md, app/ideas.js, app/ideas-view.js, app/briefs-lock.js and tests/ideas.spec.js. Use the already approved desktop UI plus persisted files seam and tdd. No live authentication, model calls, managed-home reads or deployment.

Before production changes, send root the exact removal-marker schema and lock/publication protocol. First write one normal desktop regression: save two independent ideas, preview removal of one, cancel with exact unchanged bytes, confirm only its displayed managed copies, retain original source/history/other idea, and restart without resurrection. Root runs RED before implementation. Later add actual-exit recovery and stale-confirm/changed-scope guards one vertical at a time.

## Required design

- Use the existing .ideas withBriefMutation lock. Removal must not call context/recovery-mutating list helpers while taking its raw preview. No new mutex or generic deletion framework. Keep current lock order: writing store before Intake; do not acquire Conversation from inside Ideas.
- Preview exact selected identity, note/proposed writing, managed intents/stages/publication receipts and exact known stage/destination hardlink pairs. Bind ordinary contained parent/leaf identity, literal hash, size and all peers. Changed/unknown/mixed copies hold; never erase by filename or provenance alone. Show retained external copies/quotations as outside the displayed scope.
- Confirm revalidates the whole token under the same writer lock, then durably records a strict content-free per-idea removal marker BEFORE unlink. Its exact schema is a design decision for root review. It must survive removal of publication receipts and restart, retain only identity/path/hash/ownership facts, and prevent every old operation for that idea from publishing again.
- Fence confirm before its first write and immediately before publication; fence resumed preview/recovery, acknowledgement and relevant readers. Clearing in-memory tokens alone is insufficient. A newly created independent idea receives a fresh UUID and remains allowed.
- Recovery uses only the committed exact manifest. Recheck parents and the entire remaining scope before destructive work, then each target before unlink. Permit only exact known peers and verify final absence; replacement/new files require fresh explicit scope, never widened consent. Do not reconstruct deleted writing from retained intents.
- Keep a permanent removal marker even after cleanup completes. Malformed/replaced authority fails closed. Do not overwrite source/suppression or prior writing attribution. Default capture deletion remains independent of this action.
- Add a clear preview/cancel/confirm UI for an explicitly chosen saved idea and a recovery route for confirmed incomplete removal. No automatic removal or semantic quotation editing.

## Checks and handoff

Root serializes desktop runs; freeze the worker's worktree source/tests during its run. Worker uses syntax and diff checks only. Report exact changed files, schema, failed/passed checks supplied by root and remaining acceptance. Push meaningful tests/implementation/fix milestones through root, then independently review before preserving integration into the primary ticket branch. Full #13 review and #16 release gates still follow.
