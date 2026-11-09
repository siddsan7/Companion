# Ticket 10: reviewed project conversations

Goal: send an explicitly reviewed context package through the guarded App Server adapter, retain complete local history, and resume without replay. Approved seam: Electron desktop controls and resulting files/history, with controlled time, filesystem and external stdio provider boundaries. Authored fixtures are visibly synthetic; they do not establish live integration or reasoning quality.

## Actual verification

Root ran all GUI tests. Worker syntax/diff checks supplement these results.

| Root check | Result | Checkpoint |
| --- | --- | --- |
| Context, conversations and Codex safeguards | 48 passed, 15.7 minutes | `6951c63` |
| Selection, persistent scope, stale window and storage recovery | 5 passed, 3.0 minutes | `0a92f46` |
| Late A completion preserves reviewed B draft | Passed, 29.7 seconds; existing runtime unchanged | `003fa25` |
| Explicit speculation permission and removal | Passed, 29.8 seconds; existing runtime unchanged | `f3a51bb` |
| Producer rejection excludes direct/transitive dialogue; independent capture stays usable | Passed, 50.2 seconds | `3c6826e` |
| Unknown attribution excludes direct/transitive dialogue; original text remains inspectable | Passed, 29.1 seconds; existing runtime unchanged | `c7f8888` |
| Final synchronized combined suite | Interrupted for fixes: two capture tests used an unscoped alert lookup; the new conversation alert makes it ambiguous. Remaining cases were not completed. | `c7f8888` |
| Fresh independent Standards/Spec review | Standards withheld approval: history-directory alias containment needs a regression and fix. Spec approved within #10 scope; final-tip approval remains pending. | `c7f8888` |

Earlier bounded RED/GREEN checks reproduced Windows publication failures, persistent storage failures, stale evidence during preflight, Unicode limits, incomplete/ambiguous turns and message ordering. Setup corrections are not product REDs: the race question needed a lexical match; the third rejection turn needed its own reply/count fence. Neither required a runtime change.

Integration sync `b844d2c` preserves #5 whole-vault annotation scanning, namespaced canonical identity authority and the exact immediate generated-header strip in Context. Preload keeps the explicit union of narrow conversation and repair channels. The final combined gate must exercise this synchronized code.

Live managed sign-in was explicitly skipped by the user. No live model interaction, effective prompt/tool inventory proof or verified model/harness/output capacity was established. Fixture readiness remains false. Missing independent production proof blocks dispatch while capture stays usable. No deployment or release-ready claim is made.

## Reviewed boundary and eligibility

Preview constructs the full literal question, exact pinned approved brief, selected passages/provenance and eligible historical dialogue. The contract requests a shared mechanism, application as a hypothesis, limitations, observable test, supported references or No Supported Connection. Beyond-evidence suggestions require explicit permission and a Speculative label instruction. This is a dispatch contract, not a reasoning-quality claim.

Main retains at most 64 memory-only, one-use approval tokens. Send accepts a token, never renderer package text. The complete snapshot is rebuilt and compared before durable intent, after asynchronous preflight and before actual turn start. Changed sources, history, brief, scope, settings or proof require another preview. Text is never silently trimmed/replaced or automatically replayed. Final text is LF-normalized, SHA256-bound and counted in Unicode code points under 32000 and any smaller verified bound. Dispatch uses the exact reviewed text.

`ConversationEvidence` is shared by Context and Provider. It whitelists model, bound and harness/output provenance with a stable random process-local binding. Relevant private proof, settings, vault, setup generation and readiness changes rotate that binding. Status, busy/lease, reply and counters do not. Account/certificate/private-proof details stay inside main memory; no credential-derived fingerprint enters history. Production has no default verified capacity. Legacy controlled `context-bound.json` preview checks and explicit absent-proof fixture labels remain supported. Token windows never establish input capacity or headroom.

The provider uses shared `runTurn` and a fresh ephemeral App Server thread per explicit turn. It checks returned model, binding and complete-text bound immediately before dispatch. Production also requires managed authentication, unexpired isolation certificate, inventory/configuration/root/account audit and independent capacity evidence. Controlled tests use the real stdio transport with authored responses and no login/probes. No raw RPC or runTurn is exposed through preload.

Reviewed per-conversation exclusion scope persists at preview, before Send. Revision checks revoke older tokens across windows. Removed/rejected/changed/unknown support and incomplete replies are excluded from future packages, including dependent dialogue. Dependencies conservatively union included history from the first multiturn exchange; explicit history omission propagates through history IDs. Local historic text remains inspectable with warnings. Re-add/recheck is a new explicit action; successful restoration intents are consumed. This does not implement global deletion/suppression.

New/select controls preserve independent conversation pins and scopes. New drafts reset permission and selections. A separate view epoch prevents late list/send/save responses from replacing another view; polling does not recreate unchanged selector options. Existing conversations retain their exact brief version after a newer approval. Speculation toggles revoke Send until a fresh review; actual submissions and persisted permission are tested.

## Store and downstream contracts

Application data owns `conversations/<UUID>.json`, separate from vault notes. Schema-1 records contain ID, vault root, exact brief pin `{id, version, digest}`, creation time, versioned exclusion scope and requests. Requests retain fresh ID, question, permission, exact package, full reply, ordered messages, lifecycle/error/timestamps, provider evidence/thread/turn/model when available, and usage or explicit unavailability. Messages retain item ID, full text, phase (including unknown/null) and completion proof. The truncated Codex diagnostic reply is not conversation authority.

Package schema 1 retains exact `text`, SHA256 `digest`, Unicode `count`, `limit`, safe capacity provenance/binding, warnings, dependencies `{key, digest, captureId?, revisionId?}`, included `historyIds`, history exclusions, versioned scope, brief pin, vault root, question/permission and history digest. Selected excerpts/provenance remain in text. These fields do not claim sentence-level verified citation attribution; #11 owns save-specific citation anchors.

Narrow preload operations are `conversation-list`, `conversation-preview`, `conversation-send` and `conversation-preserve`. Main owns validation/persistence. #15 may consume observed usage with its stated limits. Explicit historical search/transcript export belong to #12. Saved ideas, deletion, archive/restore and comparison flows are not implemented or claimed here. Future history archives must exclude Codex managed homes/credentials and must not roll back vault intake authority.

Intent is persisted before dispatch; lifecycle snapshots are cloned, serialized and drained. Cross-process kernel ownership protects mutations, with ordinary-file checks, flushed exclusive stages and atomic publication. Windows transient EPERM/EBUSY/EACCES rename failures retry the same stage-to-destination operation under lock for about one second. The destination is never deleted and storage recovery never retries provider requests.

On final publication failure, a main-owned cloned unsaved overlay and truthful warning survive polls and renderer reload. Explicit local Save persists without generation and compares the actual last successfully published serialization digest under lock. A changed file from another instance remains a conflict. Reads return clones. The overlay is memory-only: unsaved bytes may not survive process exit; users must save or copy them. Durable resave/restart and conflict preservation were tested. Restart marks abandoned in-progress requests interrupted; retry/edit needs current reapproved sources, a new request and a fresh thread.

## Protocol and diagnostics

Ordered per-item aggregation preserves commentary, partial/final and unknown phases. Item completion replaces only that item's text. Full terminal arrays establish order/completion; partial views do not discard known full content or invent completion. Malformed/mismatched identities, unexpected capabilities and unselected memory stay incomplete. A late citation removes the identified offending item from retained snapshots before drained terminal persistence, preserving earlier safe partial text. It cannot erase previously seen/copied bytes. The failed request is excluded from future context.

An owned setup-local turn lease starts before thread startup and spans all sink drains/final diagnostic publication, even if mutable busy resets. Setup actions respect it. Generation guards prevent stale async/queued diagnostic writes from replacing newer state. Primary errors survive diagnostic persistence failures. Conversation history remains authority.

Matching thread/turn usage events retain safe nonnegative literal counters in `total` and `last`: `totalTokens`, `inputTokens`, `cachedInputTokens`, `cacheWriteInputTokens`, `outputTokens`, `reasoningOutputTokens`, plus nullable `modelContextWindow`. Nested snapshots are cloned. Malformed/unrelated updates do not replace valid observations or poison a reply. `usageEvidence` states listener-scoped observations may be incomplete: they are not complete billing/account usage or capacity proof. No account-usage RPC is added.

Installed evidence: codex-cli 0.163.0; executable SHA256 `2692c8c7bb2cf8b0aefe638741fc90236f4b824c59578ce84994f9de58200993`. Root exported schemas without server/login/inference into literal `C:\Users\sidds\AppData\Local\Temp\companion-codex-schema10-rbEUbW\schemas`. Relevant types: AgentMessageDeltaNotification, ItemStartedNotification, ItemCompletedNotification, ThreadItem, MessagePhase, Turn, ErrorNotification and ThreadTokenUsageUpdatedNotification. Fixture controls remain separate from wire fields. Root checked the [official App Server documentation](https://learn.chatgpt.com/docs/app-server); no billing completeness or relative usage-event ordering guarantee was established.
