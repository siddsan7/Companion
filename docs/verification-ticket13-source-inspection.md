# Bounded source inspection — focused checks passed

Goal: a reviewed Conversation waits for brief real source contention, reads fresh source bytes after admission, and fails closed when native ownership outlasts the two-second admission bound. Provider turns must never retry automatically. Source mutations keep their existing immediate refusal and sole native ownership boundary.

The approved test seam is the real Electron UI plus retained request files, provider fixture submissions/RPC records, and exact Markdown note bytes. Test-only method/native observers schedule contention; they do not manufacture busy errors or replace native acquisition. The design review and lock map are retained in the root-owned temporary evidence directory as `companion-history13-inspection-design-review-20261110.md` and `companion-history13-context-lock-map-20261110.md`.

## Frozen cases

All three cases reuse `prepareConversation`, `onlyConversation`, `noSubmission`, and `conversationRpc` in `tests/conversations.spec.js`. Discovery filter: `source inspection`. Static declaration count: **3**; root's three-case run discovered and executed all three.

1. `source inspection waits for a brief Refresh owner and sends the reviewed package exactly once`: requires one completed retained request, one exact reviewed submission, one provider turn, and unchanged Markdown notes.
2. `source inspection reads changed capture bytes after a Refresh wait and requires fresh review without a turn`: changes actual selected capture bytes while ownership is held; requires a failed retained intent with original reviewed text and empty reply, fresh-review guidance, no submission/turn, exact changed notes, and a subsequent explicit preview containing the new bytes without another request.
3. `source inspection fails closed when a native Refresh owner outlasts admission and starts no body or turn`: keeps native ownership until the UI reports failure, requires at least two seconds from dispatch release scheduling to that observation, zero post-intent Intake.info entries (the first corpus source-read call), truthful busy failure, no submission/turn, and exact unchanged notes.

Each case pauses at the existing `conversation-before-dispatch` checkpoint after durable intent. Clicking actual Refresh starts state/info. Only its `Intake.recover` entry can be held, after a matching real native `listening` event proves current ownership. No new lock is created. An independent ten-second safety deadline and explicit finally release prevent a stranded test owner. Safety deadline expiry invalidates the control. Native event evidence is attached as `source-inspection-native-events.json`.

Both short cases wait for two actual same-address `EADDRINUSE` emissions in the post-intent build before releasing Refresh. The baseline emits these from info and Vault.list; the proposed correction must emit them from bounded outer admission attempts. Synchronization deliberately does not depend on the old Vault.list call. The native observer forwards original listen/emit calls and adds no error listener. Existing intervals, default tests, timeouts, provider behavior, and production files are unchanged.

## Canonical actual run table

| Stage | Candidate | Actual result |
| --- | --- | --- |
| Test syntax | New three-case test edit, product unchanged | `node --check tests/conversations.spec.js` passed |
| Static discovery | Same edit | Three literal `source inspection` test declarations |
| Runtime discovery | Root-tested unchanged tree `e5fb3f3` | Three cases discovered and executed |
| Controlled RED, three cases | Root-tested unchanged tree `e5fb3f3` | 82,055 ms, exit 1; all three failed. First case timed out before probe setup while reading the reviewed package after the Electron binary download; this is not product RED. Second and third cases reached real contention and failed as detailed below. |
| Controlled RED, isolated brief overlap with warm cache | Same unchanged tree `e5fb3f3` | 29,302 ms, exit 1; expected `SOURCE_INSPECTION_ONCE`, actual retained UI request failed with intake-already-running. Real RED. |
| Product syntax | Minimal two-source-file correction after root commit `f9e9a76` | `node --check app/source-mutation.js` and `node --check app/context.js` passed |
| Focused GREEN, three unchanged cases | Root-tested corrected tree `ed3f76` | 71,774 ms, exit 0; all three passed with their original outcome assertions |
| Original-four harness discovery | Diagnostic cleanup candidate | Aborted before launch: the filter selected five cases, including the existing ledger preview identity guard. Discovery mismatch only; no product failure. |
| Original FIVE after diagnostic cleanup | Root-tested tree `f96c261` | 183,494 ms, exit 0; all five passed: the three new cases, original two-hop history case, and existing ledger preview identity guard |
| Complete ticket / Context gate | 162 cases across 20 files prepared by root | Pending; no result or final approval |

Earlier actual full144 and controlled overlap results remain in `docs/verification-ticket13-history-contention.md`; this report does not reinterpret the original failure's unproved owner. The controlled RED in that report established a reachable contention seam, not a successful correction.

Root supplied the actual runtime results above. In the three-case run, changed-byte revalidation encountered two real same-address native busy events and one post-intent source-read entry, then retained a busy failure instead of fresh-review guidance. The persistent-owner case likewise recorded two native busy events and one source-read entry; busy failure appeared after 66 ms rather than the required admission bound of at least 2,000 ms. These are product RED results distinct from the first case's cold setup failure.

The unchanged warm-cache brief-overlap run recorded two real native busy events, entered and released the held owner, and did not reach its safety deadline. It failed the expected reply assertion with the retained busy failure. Evidence directories are `%TEMP%/companion-source-inspection13-red-three-20261110` and `%TEMP%/companion-source-inspection13-red-overlap-warm-20261110`. Tests and product source stayed unchanged across these runs. Root preserved the tests and RED report in `f9e9a76` before authorizing product edits.

## Focused GREEN evidence and limits

Root ran the unchanged three-case suite against corrected tree `ed3f76` and validated all three results. Evidence is in `%TEMP%/companion-source-inspection13-green-three-20261110`. Every control entered and released the real native owner, and none reached its safety deadline.

| Case | Native busy emissions | Held owner duration | Post-intent Intake.info entries | Outcome |
| --- | ---: | ---: | ---: | --- |
| Brief overlap | 4 | 216 ms | 4 | Exactly one completed reviewed request, exact submission, one turn, unchanged notes |
| Changed bytes | 3 | 229 ms | 1 | Fresh-review failure, no turn or submission, changed bytes preserved and shown by explicit new preview |
| Admission deadline | 64 | 2,467 ms | 0 | Busy failure after the required bound, no source-read body entry, no turn or submission, unchanged notes |

The four source-read entries in the brief-overlap case cover the normal post-intent build revalidations and preview corpus traversals. They do not establish one corpus invocation in total. Exactly-once behavior here means one intended retained request and provider turn. Source inspection admits each fresh corpus independently; it does not share a stale corpus across freshness checks.

The independent review of the bounded correction at `ed3f76` reported no blockers, conditional on the actual required gates. Root committed the correction and GREEN report as `6fe0589`. Root then removed the temporary 173-line original-case diagnostic, restoring `tests/deletion.spec.js` byte-identical to `32000d7`. The subsequent five-case run passed at `f96c261`; evidence is in `%TEMP%/companion-source-inspection13-original-five-20261110`. The original two-hop history case took about 1.5 minutes; the ledger preview identity guard took 22.8 seconds.

The attempted original-four harness run stopped at discovery before Electron launch because its filter selected five cases. Root corrected the expected count and used a new evidence directory. No assertion or application timeout changed. The cleanup five-case pass verifies the original journey without the temporary diagnostic; it does not prove the owner of the original full144 failure.

The fresh complete gate remains pending: root prepared `%TEMP%/companion-ticket13-context-162-argv.json` for 162 cases across 20 files, including the full 15-case Context suite and three new cases. Complete-ticket static checks, exact-tip review and merger approval remain pending. Live inference remains deferred; these runs use the controlled provider fixture.

## Minimal correction

Root committed and pushed the failing tests and RED report as `f9e9a76`, then authorized this correction. `sourceInspection` in `app/source-mutation.js` uses the existing sourceMutation/native admission. Its single monotonic deadline is two seconds, with delays capped at 25 ms and the remaining admission budget. It checks the deadline before every attempt and again inside the admitted callback before the corpus body. Only `INTAKE_BUSY` before that callback has ever begun can retry. Once the callback starts, all body and nested errors propagate without replay. The existing sourceMutation implementation, live ownership token, native endpoint, and mutation refusal behavior are unchanged.

`Context.corpus` now admits through sourceInspection and calls the complete existing body as `corpusOwned`. All ledger, capture, revision, annotation, source-generation, physical identity, independent-removal and raw CAS checks remain in that body. Existing corpus callers and outer lock order remain unchanged. No registry, second mutex, stale fallback, provider retry, or late uncancellable body is introduced.

Worker scope: authorized source/docs edits and syntax only. This cleanup-results update changes only this report, architecture and checkpoint docs; product files and tests remain frozen. The three new tests are unchanged from root's RED commit; root separately removed only the original-case diagnostic. No staging, commit, installation, runtime test, GUI, or network action by this worker. Root performed the recorded runtime runs; complete checks remain pending.
