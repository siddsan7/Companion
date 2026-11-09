# Ticket 12: history controls — implementation in progress

Goal: explicit prior-dialogue search, requested readable transcripts, independent conversation deletion and visible source-revocation effects. The accepted check boundary is the normal Electron desktop plus resulting files and history. Root runs checks using controlled external provider, OS-dialog, time and filesystem boundaries. No live sign-in or model inference is established by these checks.

This is a partial evidence record. Ticket #12 is not complete or independently approved. Conversation deletion, dynamic affected-idea warnings, the final coupled gate and ticket review remain pending. Candidate commits are on `ticket/12-history-controls`; integration uses preserving merges after review.

## Observed checks

Focused results are separate runs, not a single complete gate. Times are observed root-run results.

| Check | Actual result and commits |
| --- | --- |
| Explicit opt-in prior-dialogue search | Initial regression `8208cbf` failed at the missing search control (1.1m). Implementation `b0feb0f` passed (35.7s). Default packages excluded unrelated retained replies. |
| Authority closure without unselected raw ancestors | Regression `f7d6ab7` reproduced raw ancestor inclusion in a continuation (36.8s). Fix `9701677` passed (41.9s); the original exact-package case also passed (34.8s). |
| Foreign-origin revocation | Regression `db10ff0` passed on unchanged runtime (1.2m). A second instance persisted origin omission; stale Send made no submission, transitive dialogue was excluded and retained text stayed intact. Source change at the final dispatch boundary also blocked raw turn start. |
| Explicit exact transcript preview/cancel/publication | First regression `cfb52c8` failed at the missing preview control (1.0m). The first candidate failed an observer comparison (40.9s): the test read hidden old preview text during asynchronous repreview. Test-only `309ab30` waits for visible proposed Markdown; implementation `35499a3` then passed (41.4s). No runtime identity cache was added to conceal that observer error. |
| Copied transcript cannot become source evidence | `268f64c` passed (34.8s). A copy outside the managed parent, with its companion ID removed but transcript artifact type retained, was rejected by explicit context inclusion and brief input selection. |
| Strict optional archive history references | Regression `ac3eb57` failed at disabled export (39.9s); static inspection separately identified the missing strict allowlist member. Fix `1654178`, after preserving sync `07c77fa`, passed roundtrip, retained exclusions and recomputed-integrity malformed-reference variants (55.4s). References are retained, not stripped. |
| Retained failed transcript publication | Regression `aeaae87` failed at the absent restart recovery region (32.3s). Implementation `c17e73d` passed (34.0s): exact intent/stage writing survived restart; inspection and explicit Resume/Confirm published once without model replay. |
| Actual process exit at post-link and post-receipt boundaries | `ccdcf47`: both cases passed on unchanged runtime (56.4s total; 27.9s and 27.8s). Tests exited the actual Electron main, awaited the wrapper and verified main absence. Changed source and removed origin did not block acknowledgement of the exact already-published pair. A completed output subsequently removed or edited was not recreated or overwritten. The list reporter's attachment invocation is not claimed as a retained artifact path. |
| Actual publication guards and late view responses | Initial seven-case run: five guards passed, two late-view cases failed (2.9m total). The preview failure was genuine; the confirmation failure first hit a hidden-control observer. `d20f381` corrects only that completion observer and retains assertions. Rerun reproduced both genuine view failures (30.1s and 33.9s). Fix `662aff0` passed all seven (2.6m), including destination/journal junctions, unknown hardlink peer, collision, changed origin and late A preview/confirmation after selecting B. |
| First conversation deletion tracer | Regression `082b64c` failed at the missing preview control (1.1m), after creating a saved idea, transcript and second-window reviewed foreign-history package. Runtime implementation and passing evidence remain pending. |

## Current ownership and source-copy inventory

History remains application-data `conversations/<UUID>.json`, with exact outgoing contexts, messages, brief pins and conservative source dependencies. Optional `package.historyRefs` contains exact `{conversationId, requestId, digest}` authority references, including transitive closure. Only explicitly selected foreign turns contribute raw dialogue; unselected ancestor text is not automatically resent. Origin and active exclusions and fresh source eligibility are checked again before dispatch. The strict archive extension accepts only UUID identities, literal lowercase SHA256, no extra members and no duplicate qualified references.

Readable transcript publication is main-owned and shares the live Conversations store. New-publication lock order is conversations, then managed `.transcripts`. Selected output is an independent contained vault Markdown file, potentially outside the configured managed parent. Its artifact type prevents reuse as current context or brief evidence even after copying and removal of its companion ID.

| Copy | Contents and lifecycle |
| --- | --- |
| Selected transcript `.md` | Full historical questions, ordered assistant items/phases/status, original outgoing context, exact brief/source/foreign provenance and current support/completeness warnings. Independent writing; source or conversation deletion does not imply removal. |
| `.transcripts/<operation>.intent.json` | Schema 1: operation, ID, vault/root, origin conversation, record digest, destination, complete text/digest, review state and creation instant. Review state includes warning text, original/current dependency descriptors and foreign-origin record hashes. This can be the only unpublished copy. Provenance paths confer no deletion authority. |
| `.transcripts/<operation>.md.pending` | Exact proposed Markdown. One ordinary link before publication; only the exact known stage/output pair may have two links. Unknown peers, aliases and edited copies remain preserved and blocked. |
| `.transcripts/<operation>.published.json` | Content-free schema/operation/ID/digest/device/inode receipt. Confirmation may acknowledge an exact already-published pair without rebuilding current source authority. Completion never authorizes recreation of missing or edited output. |
| Process-local preview | Exact intent plus pinned parent identities, behind bounded opaque tokens. Cancellation creates no journal. Late responses cannot replace a different selected conversation's view; an already-confirmed publication remains recoverable. |

Pending discovery validates contained operation identities and retained ownership. Inspection does not publish. Explicit resume of new publication revalidates origin and warnings. A damaged or unavailable operation is preserved for review. Source-bearing journals and independent quotations belong in #13's inventory; they are not disposable caches.

## Pending acceptance and readiness

- Finish independently scoped conversation deletion, stale-save/generation fences, exact pending-stage handling, crash recovery and explicit archive restore without undoing current exclusions.
- Flag affected saved ideas after source rejection without silently rewriting independent notes.
- Run the final coupled desktop gate, inspect the final diff and obtain independent Standards, Spec and merger approval.
- #13 owns capture/revision deletion and suppression. #16 owns complete integrated regression and real integration evidence.

Live sign-in, inference, complete prompt/tool inventory and provider-capacity proof remain deferred/unverified. Production chat/comparison readiness remains restricted. Hosted Actions is billing-blocked and user-waived, not passed; actual enforced branch rules still apply. No deployment is authorized. The final complete-PR independent review and merge happen only after the full task is implemented; after remote merge verification, pause at the user's requested clean checkpoint.
