# Ticket 13: temporary visible-action observers

## Scope and acceptance

This is diagnostic instrumentation, not a product correction or a passing gate.
The author worked only in the fresh `issue-13-visible-action-order` worktree at
`8d660dc`. Its history preserves `1a208df` and the measured candidate `c78058f`.
The approved plan and its preservation review remain the authority for this work.

Observe the original four Context failures, the changed-source Conversation case,
and the same-byte manual restoration case. The helper gates on their six exact
literal titles. Other tests do not install observers. Suite hooks retain all
original actions, assertions, waits, budgets, retries, timers and cleanup actions.
The existing Conversation source-control helpers remain unchanged.

Acceptance for a later diagnostic run is useful bounded evidence of actual action
order, actual payload authority, and actual backend results. A passing rerun alone
does not establish a historical cause. Preserve failed and setup-failed attempts.

## Evidence

`testInfo.outputPath('visible-action-order.json')` is written before existing suite
cleanup. It contains each launch session, installation coverage/errors, up to 512
main events, and up to 256 renderer events. Sequence numbers, dropped-event counts,
monotonic times and wall times identify retention and clock limits. Main and
renderer monotonic clocks have separate origins; use operation probes and wall
times to correlate them rather than directly subtracting their monotonic values.

Actual `ipcMain._invokeHandlers` entries observe start, return, rejection and
synchronous throw. They call the original handler exactly once with the original
receiver and arguments, return its original value or promise, and rethrow the
original synchronous error. Promise observers do not replace the original promise
or rejection. The frozen preload bridge stays unchanged. A queued renderer probe
on each asynchronous result snapshots property values without delaying the
original IPC result; its timestamp is probe execution, not a synchronous bridge
delivery timestamp.

Observed channels: state, vault repairs and identity choice; Context find, passage
and preview; Conversation list and preview; brief propose, state and approve.
Idea list, intake check, review connection and annotation creation record operation
ownership only, with no input or output bodies. These additional operations can
help identify an Intake owner without inventing busy responses.

Whitelisted scalar summaries include selected keys and digests, the presence and
values of source-generation tuples, passage approvals, proposal IDs/digests and
versions, repair tokens and inventory file hashes. File paths are hashed.
Text, titles, questions, replies and packages retain lengths and fingerprints,
not content. SHA-256 is used in main summaries; the labelled FNV-1a fingerprint
also supports matching renderer text/property snapshots to main source text.
FNV-1a is diagnostic correlation only and cannot establish evidence authority.
Arrays retain their original count and at most 48 entries; recursion is capped.
The helper reads no managed home or fixture-store payload files.

Renderer events record trusted clicks/input/changes, control node identities,
current values as fingerprints, result/selected/manual/repair/proposal/history
identities and summaries, status/errors, package lengths/fingerprints, and Send
enabled state. DOM mutations trigger snapshots without a timer or frame loop.
Only existing relevant button `onclick` handlers are wrapped: original receiver,
arguments, return value, promise and synchronous error are preserved. Start and
settlement markers show actual completion independently of Playwright click
completion. Package textarea setters delegate to the original native setter and
record actual publication/clearing writes, including a short call stack. Proposal
textarea values are sampled at events, result probes and handler completion.

Earlier launch renderer events stream to a bounded host buffer. Main sessions
also save their bounded ring synchronously on `before-quit` to per-launch output
files, allowing normal close/relaunch steps to retain their earlier observations.
Live main state is read at final evidence saving; a quit snapshot is the fallback.
Each live-main read and fallback quit-snapshot read has its own 2000 ms observation
deadline. The deadline timer is cleared after settlement; a late read rejection
stays handled. A timeout records unavailable evidence and permits existing
cleanup to continue without changing the original test status or error. No test,
assertion, or cleanup budget is extended.
Observer installation/persistence errors are recorded where possible, without
replacing an application error or asserting observer success.

## Reading the evidence

1. Compare a trusted control click and handler start with the pending Find,
   Refresh, Propose or passage operation and its subsequent return/render. Match
   displayed source fingerprints/node identities to the earlier discovery result;
   compare submitted digests, source generations, repair token or proposal ID with
   the newly returned authority. This can show old controls acted on while a newer
   operation was incomplete.
2. A current submitted identity plus an actual handler rejection and matching UI
   error supports a real backend authority/freshness refusal. Identical source
   bytes alone do not prove identical source-generation authority.
3. A successful preview result followed by a package publication and then a clear
   with an invalidation call stack supports later renderer invalidation. A success
   with no publication, followed by an earlier-preview-ignored summary, supports
   discarded publication. Passage completion and history DOM revisions provide
   further ordering evidence. Neither is inferred from an empty package alone.
4. The manual restoration case needs both the initial Send and the later
   post-restoration Send inspected. The observed full-run failure was the second
   readiness assertion; do not mislabel it as the initial send failure.

## Checks and remaining limits

Author verification is static only: syntax checks on the four owned JavaScript
files and inspection of their diffs. No discovery, tests, GUI, dependency install,
network action, or product edit was run by the author. Root owns later serial
runtime validation and exact-tip review after the frozen full run is preserved.

Instrumentation begins after `firstWindow`; earlier startup IPC is not covered.
Renderer setup defers to DOMContentLoaded without adding a test wait when needed.
Closure-local numeric preview generations and displayed-history revision strings
are not directly exposed. Source generations in actual IPC inputs/outputs are
captured; package write stacks identify invalidation boundaries instead of
claiming access to closure counters. DOM history fingerprints and request status
summaries are observations, not proof of an accepted internal revision.

Queued IPC result probes are asynchronous. No observer can claim the exact
renderer await-resumption instant from their timestamp. `onclick` settlement and
actual package property writes provide independent boundary evidence. Event rings
can evict earlier evidence, and array/recursion limits can omit detail. Observer
cost can affect scheduling; the six uninstrumented workflows and complete gate
remain necessary after any separately reviewed correction and observer removal.
Abrupt process termination can lose a main quit snapshot. No cause, correction,
runtime success, Ticket 13 completion, or release readiness is established here.

## First actual six-case observation

Root ran the original six selected workflows unchanged at staged treeebda35e8531b0b99c6ad536b40f37c3e41327f50. Complete result FAILED1pass/5fail/0skip/exit1/49140ms; raw Temp/companion-ticket13-visible-action-six-20261110. Runner29154 completed and copied artifacts. The first launch downloaded the pinned Electron binary but reached the original custom-annotation assertion; it was not a setup-only failure. Brief version case passed; all other selected cases failed their original assertions. An instrumented pass establishes no historical cause.

Root verified changed-source Conversation220 and same-byte restoration1443 had no observer errors/missing channels/dropped records. In both, the trusted Add action and its synchronous completion preceded current Find result rendering. The later preview submitted the OLD capture digest in220 and omitted the newly returned sourceGeneration in1443 despite identical bytes. Both backend refusals correctly required fresh explicit selection. Their failed final assertion was not a successful preview erased by history polling. Actual IDs/times and scope limits: Temp/companion-ticket13-visible-restoration-order-analysis-20261110.md.

Independent passage analysis observed preview dispatched with zero selections before the actual passage approval returned. Its later add/clearPreview invalidated the older preview; backend preview succeeded, then the renderer correctly ignored it. Temp/companion-ticket13-visible-passage-brief-analysis-20261110.md will retain the exact chronology. Context71/125 analysis remains separate. No change to source/native guards, timers, model readiness or original budgets is justified by these observations. Full149/13 remainsFAILED; any correction needs independent design review, controlled ordering regression, observer cleanup, unchanged workflows and a new complete gate.