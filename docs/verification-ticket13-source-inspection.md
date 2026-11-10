# Bounded source inspection — regressions frozen for RED

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
| Focused GREEN | Pending RED and minimal product correction | Not run |
| Original history workflow / coupled checks / full gate | Pending root execution | Not run |

Earlier actual full144 and controlled overlap results remain in `docs/verification-ticket13-history-contention.md`; this report does not reinterpret the original failure's unproved owner. The controlled RED in that report established a reachable contention seam, not a successful correction.

Root supplied the actual runtime results above. In the three-case run, changed-byte revalidation encountered two real same-address native busy events and one post-intent source-read entry, then retained a busy failure instead of fresh-review guidance. The persistent-owner case likewise recorded two native busy events and one source-read entry; busy failure appeared after 66 ms rather than the required admission bound of at least 2,000 ms. These are product RED results distinct from the first case's cold setup failure.

The unchanged warm-cache brief-overlap run recorded two real native busy events, entered and released the held owner, and did not reach its safety deadline. It failed the expected reply assertion with the retained busy failure. Evidence directories are `%TEMP%/companion-source-inspection13-red-three-20261110` and `%TEMP%/companion-source-inspection13-red-overlap-warm-20261110`. Tests and product source stayed unchanged across these runs. Root will preserve test and RED evidence before authorizing product edits.

Worker scope: tests/report edits and syntax only. No staging, commit, installation, runtime test, GUI, or network action by this worker. Root performed the runtime runs. Product edits remain frozen until root preserves the test and RED evidence and authorizes the minimal correction.
