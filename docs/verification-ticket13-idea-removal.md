# Ticket 13: separately selected saved-idea removal

This bounded workflow removes one explicitly chosen saved idea and its displayed managed copies. It preserves the originating conversation, captures, transcripts and other ideas. Moved, external and backup copies remain outside this scope. This report does not establish completion of ticket 13.

## Observed desktop evidence

The root agent ran the normal Electron UI with isolated persisted files and controlled provider responses. The worker did not run desktop tests.

- RED: one case failed after 1.0 minute. Two ideas had been saved; the selected idea lacked the `Preview saved idea removal` button. No removal scope was reached. The root retained the actual failure under its temporary `companion-ticket13-idea-removal-red-20261109` evidence directory.
- The subsequent test tidy removed copied unused helpers, imports and optional setup branches. The scenario and acceptance assertions stayed the same.
- GREEN: one case passed in 38.0 seconds (case: 37.6 seconds). It displayed the selected UUID and all three managed paths: note, intent and publication receipt. Raw preview and cancel preserved exact bytes. Confirmation removed those copies, preserved the other idea and source/history bytes, and restart did not recreate the removed note or pending proposal.
- Worker syntax checks passed for `ideas-removal.js`, `ideas.js`, `ideas-view.js` and `preload.js`. The whitespace diff check passed.
- Crash/Context RED: the next single case failed in 42.5 seconds after actual Electron `app.exit(77)` and restart. All selected copies remained behind the durable marker. The selected idea still appeared once in the manual Context options; zero was required. The other idea remained eligible. The root retained the actual 190-byte process/exit record under `companion-ticket13-idea-context-red-20261109`.
- Crash/Context GREEN: the unchanged case passed in 39.7 seconds (case: 39.3 seconds). Before cleanup, the selected note still existed but was absent from manual Context options and discovery candidates; the other idea stayed eligible. Explicit recovery removed exactly the committed copies, retained a one-link permanent marker and preserved source/history and the other idea's bytes.
- Syntax checks also passed for the focused `context.js` and `main.js` changes. Context uses the existing Ideas guard and removal fence through a production callback, including the shared store anchor. Direct Context callers have a raw marker check. Eligibility is checked again after asynchronous corpus reads, before returning eligible ideas.

## Approved authority protocol

The existing `.ideas` mutation lock serializes preview, confirmation and recovery. Raw removal preview does not call context or recovery-mutating list helpers, and does not create a missing store.

The permanent `<idea UUID>.removed.json` marker has exact fields: `schema`, `kind`, `ideaId`, `operation`, `vault`, `parents` and `files`. Parent records contain only canonical relative path and device/inode identity. File records contain only path, kind, owning operation, literal SHA-256, size, device/inode identity and exact known peers. Paths, parents and peer groups are sorted and unique. No source or writing body is retained in the marker.

Publication first writes an exclusive `<idea UUID>.removed.json.pending` file, flushes it and binds its created handle identity. An exclusive hardlink publishes the final marker as its exact known peer. No unlink occurs before final authority exists. A complete pending-only marker fences the old identity; explicit recovery must validate the committed scope and publish final authority before unlinking. Partial or damaged markers hold their affected identity. Recovery checks the loaded marker, parents, entire remaining scope and each leaf before unlink, then checks final absence. The marker remains after cleanup.

Ideas guards retain each observed `.ideas` directory identity for the process lifetime, including same-vault reconfiguration. Missing or replaced storage cannot silently replace that anchor or remove its publication fence. This does not claim historical inode proof after restart if all durable authority was externally removed.

## Remaining checks

- Unknown orphan stages, changed scope, unknown hardlink peers and stale operation publication need focused regression evidence. Static review found that a selected-identity orphan stage without its own validated intent is not yet detected by the removal scope scan.
- Pending-only proposals need their own explicit removal control and desktop evidence; the current visible removal action starts from saved-note rows.
- Full ticket review, integration, release checks and live provider/isolation checks remain with the root agent. No live provider, authentication, merge or deployment was performed by this worker.
