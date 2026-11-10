# Bounded source inspection — narrow focused checks passed

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
| Complete ticket / Context gate, whole-corpus span | HEAD `1aabd8f`, root-tested tree `f9a773` | STOPPED after 8 completed passes / 1 completed failure; 232,908 ms, exit 1. Existing in-flight annotation read/removal regression failed. |
| Revised narrow-span syntax | Context / repairs correction after approved plan merge `d808925` | `node --check app/context.js` and `node --check app/repairs.js` passed |
| Revised narrow-span FOUR | Exact root-tested tree `ede0e1e1110aad437be1bb9867484c7838a83d7a` | 94,747 ms, exit 0; unchanged annotation reader plus all three admission cases passed |
| Revised original TWO | Commit `30966c090fdeb042fdc98c906c0dd5825eceda06`, tree `757edb8668d6edf251d1869bd82f875f4f0b0653` | 112,029 ms, exit 0; unchanged original two-hop history and ledger preview identity guard passed |
| Fresh corrected complete gate | 162 cases across 20 files | Pending root execution; complete-ticket checks, exact-tip Standards/Spec and merger approval required |

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

The complete 162-case / 20-file gate included the full 15-case Context suite and three new cases. Root stopped it after the existing annotation-removal regression failed: 8 completed passes / 1 completed failure, 232,908 ms, exit 1. Evidence is in `%TEMP%/companion-ticket13-context-final-162-20261110`. The earlier focused passes did not establish whole-corpus concurrency correctness. Fresh complete checks, exact-tip review and merger approval remain pending. Live inference remains deferred; these runs use the controlled provider fixture.

## Minimal correction

Root committed and pushed the failing tests and RED report as `f9e9a76`, then authorized this correction. `sourceInspection` in `app/source-mutation.js` uses the existing sourceMutation/native admission. Its single monotonic deadline is two seconds, with delays capped at 25 ms and the remaining admission budget. It checks the deadline before every attempt and again inside the admitted callback before the corpus body. Only `INTAKE_BUSY` before that callback has ever begun can retry. Once the callback starts, all body and nested errors propagate without replay. The existing sourceMutation implementation, live ownership token, native endpoint, and mutation refusal behavior are unchanged.

The initial `Context.corpus` correction held the entire body under sourceInspection. That span is superseded by the revision below. The admission helper itself remains unchanged: no registry, second mutex, stale fallback, provider retry, or late uncancellable body is introduced.

## Revised span after the unchanged annotation regression

The existing test `an in-flight supporting annotation read never admits writing removed before its scan returns` pauses a real supporting scan after source inspection. It then requires annotation removal to commit phase `removing` before releasing the reader. Whole-corpus native ownership blocked that authorization. The reader already has an optimistic physical ledger CAS designed to reject the stale scan after removal; it must remain free to observe that change. Whole-corpus design approval is withdrawn.

Root committed the revised independently approved plan as `d8da40a` and preserved it in this helper through plan-only merge `d808925`. The revised correction changes only `app/context.js` and `app/repairs.js` in addition to this report:

- `sourceCorpusOwned` runs fresh Info/ledger, Vault.list and capture/revision eligibility under unchanged bounded admission. It saves the INITIAL Info physical ledger observation before nested Info calls can replace `storage.expected`, then checks that same original observation at source-core end, outside per-item catches.
- Context passes the strict internal option `{ annotations: false }` through the existing `Intake.inspect` seam. Only strict false omits its unused appended annotation scan. Default public inspection and ordinary recovery/reconciliation scans are unchanged.
- After source ownership releases, `corpusFromSources` performs the supporting annotation, Brief, Ideas and explicit-scope reads. Existing annotation CAS, source-generation, identity, dependency and removal guards remain.
- After all unlocked awaits, and before the final synchronous idea eligibility filter, a raw non-acquiring ledger view must match the SAME original parent/inode/raw-digest observation. Any mismatch rejects the entire corpus. The baseline is never rebased; mismatch is never converted to a per-item issue. There is no final native reacquisition, body replay or mutation retry. Conversation → required writing stores → Intake order is unchanged.

Root ran the unchanged four-case set against exact tree `ede0e1e1110aad437be1bb9867484c7838a83d7a`: all four passed in 94,747 ms, exit 0. Evidence is in `%TEMP%/companion-source-inspection13-narrow-four-20261110`. The annotation reader case passed in 26.7 seconds, including durable removal authorization while its scan was held and stale-writing exclusion after release. The three admission cases passed in 19.2 / 26.8 / 21.1 seconds and retained their native event evidence. All original outcome assertions passed; no action, assertion or timeout changed.

Independent bounded review of this exact narrow-span tree reported zero blockers, conditional on the four focused checks, which root has now validated. Root preserved the source correction and four-case report in `30966c090fdeb042fdc98c906c0dd5825eceda06`.

Root then ran the two unchanged original controls at that commit, tree `757edb8668d6edf251d1869bd82f875f4f0b0653`: both passed in 112,029 ms, exit 0. Evidence is in `%TEMP%/companion-source-inspection13-narrow-original-two-20261110`. The two-hop history journey took about 1.5 minutes; the ledger preview identity guard took 22.9 seconds. The fresh corrected full162 / 20-file gate, complete-ticket checks, independent exact-tip Standards/Spec review and assigned merger approval remain pending. Earlier failed/stopped gates retain their results. Product files, admission helper and tests remain frozen.

Worker scope in this step: this report, architecture and checkpoint docs only. No source or test edits, staging, commit, installation, runtime test, GUI, or network action by this worker.
