# Spec #1 implementation

Goal: implement siddsan7/Companion#1 and #2–#16 on integration/1-local-second-brain. Baseline04ed4fb. Approved planning was committed in e030e51 before worktrees.

Constraints: accepted spec/ADRs apply. The user approved desktop workflow plus resulting files/history as the test seam. Main owns planning, integration, Git writes, installs/network, GUI/native checks and communication. Workers edit isolated worktrees and run syntax checks. Worker escalated commands can hang; root runs them. Ticket merges require independent assigned-reviewer approval. Final merge to main is for the user. No push/deployment occurred.

Reviewed integration:
- #2 offline capture:9a6985d, independently approved;14 desktop/file tests and independent smoke passed; issue closed.
- #7 project briefs:aacc87a, independently approved;7 brief/21 combined tests and actual read-only MyTune README smoke passed; issue closed.
- #3 draft intake:2c27097, independently approved exact tip;35 combined passed,1 actual file-symlink capability skip; actual producer smoke repeated after sync passed33 evidence/one capture/one snapshot/restart idempotence/source hashes unchanged; issue closed(comment6718512475).
- #8 Codex setup:2993ab0, independently approved exact tip and merger-verified;42 combined passed,1 file-symlink capability skip(5.8min). Actual installed Windows direct/child/case/extended/junction denials and reproducible native probe passed. The user deferred live sign-in/model/provider checks. Chat remains unready; issue8 remains open for the live gate(comment6718768608). No new authentication/model request is authorized during this deferral. See verification-ticket8.md.

Active frontier: ticket5 vault repair and ticket6 Windows scheduler in separate .worktrees/issue-* from2c27097. Ticket4 human reviews is integrated at e672259. Sync latest integration before final handoff. Scope/checks/evidence live in docs/verification-ticket4.md,5.md,6.md within those worktrees. Source modules and tests for reviewed features must survive synchronization.

Native dependency graph:2->3,7,8;3->4,5,6;4+7->9;9+8->10;10->11,15;10+6->14;11->12;5+12->13;13+15+14->16. Final two-axis code-review and whole-story gates remain required. Do not claim release-ready from fixtures; report actual/skipped gates honestly.

Storage guardrails: vault Markdown owns content. .intake/ledger.json owns admitted attempts/outcomes/suppression independently of application history; never roll it back during history restore. Imported snapshots are immutable; unresolved local/incoming conflicts and recovery copies remain source-bearing. Deletion must enumerate them while retaining identity/outcome/suppression metadata. Preserve stable capture IDs/first timestamps/user titles and independent annotations. Kernel lock, exact stage ownership/alias checks and source-specific failure isolation remain required.

Reusable evidence notes outside repo: C:\Users\sidds\AppData\Local\Temp\companion-producer-notes.md, companion-review-canonical-notes.md, companion-scheduler-notes.md. Canonical Python JSON parity had174359 oracle cases with no mismatch; actual Electron lossless reviver capability subsequently passed. Natural finalized review and natural24h/sleep-signout gates remain distinct from synthetic/accelerated checks.

Native scheduler evidence: corrected automatic UI-closed launch and fresh effective-policy inspection passed; exact disposable cleanup and absence were confirmed. Natural timing gates remain unobserved; see ticket6 handoff below.

Next: complete frontier implementation/review, synchronize each from current integration, run combined checks, integrate approved tips and advance graph. Keep final main merge for user review. The live sign-in deferral remains in force.

## Ticket #4 handoff

Ticket #4 is integrated at `e672259`; its synchronized checkpoint `d7baa6c` passed combined checks and exact-tip independent review. Scope: portable finalized review validation, independent processing/extraction/human findings, immutable revisions, reviewed precedence, rejection exclusion, explicit current choices and nondestructive changed-byte associations. Shared producer roots retain both source kinds.

Root's scoped suite passed all 8 review desktop/file tests in 1.6 minutes. Actual Electron numeric reviver and producer-backed authored synthetic fixtures passed; natural finalized-review handoff is skipped without a genuine bundle. See `../docs/verification-ticket4.md`. Product/tests are frozen absent concrete gate/review findings.

When #5 merges, `selectCurrent` must use its optional `capture.relative` destination resolver and shared optional `tx.resolution` backup convention. Downstream context must honor capture ambiguity/eligibility and rejected snapshot exclusion; associations confer no approval. Preserve broad fixture LF normalization and finalized fixture byte preservation. Root owns Git writes, GUI, combined checks and exact-tip review.

Final ticket #4 combined gate: 50 passed, one Windows file-symlink capability skip (7.5 minutes) on synchronized d7baa6c. Independent actual producer draft smoke passed with 33 evidence entries, restart idempotence and source hashes unchanged. Exact-tip independent approval passed; natural finalized review remains skipped.

## Ticket #6 handoff

Worker scope: `.worktrees/issue-6`, branch `ticket/6-windows-intake`, base `2c27097`. Root owns Git writes, GUI/native checks and integration. Code/tests are frozen. Final scoped suite: nine desktop/file/headless cases passed in 2.0 minutes; policy drift/repair loop 48.8 seconds. JS syntax, PS parser and whitespace passed. Source checkpoint `6148c33` is synchronizing with reviewed #4 integration `e672259`; combined regression and exact-tip independent review remain required. Preserve current reviewed root memory during synchronization.

Implemented explicit fixed-anchor setup; per-user native task registration/repair/removal; due admission within existing intake locking; coalescing; no intentional wake; pause/resume/disable; UI-closed headless entry; effective task-state/policy drift; durable success/error metadata and busy controls. First/manual checks preserve the anchor. Failed admitted attempts consume their slot and need explicit Check now; the next daily slot remains eligible.

Actual native run c proved automatic UI-closed launch, authored source-file access, one capture/revision and simulated handledSlot 4, task result 0. After the review fix, native d effective inspection passed policyMatches=true: expected enabled TimeTrigger/ceiled boundary/P1D/no expiry/StartWhenAvailable/no wake/IgnoreNew. Root confirmed exact cleanup and absence. Natural 24-hour recurrence, sleep/sign-out missed timing, multi-day OS coalescing and empirical no-wake remain unobserved. No full gate/release readiness claim. Evidence: `../docs/verification-ticket6.md`.

Reusable lessons: translate stored task account names to SID and compare exact identity; Windows may normalize SID registrations. Ceil registered trigger boundaries to whole seconds while retaining exact application anchors because Windows drops trigger fractions. Wait for actual busy-control completion before external mutation; repeated identical success text can be stale. Keep policy drift separate from ownership so known-owned repair can restore settings while foreign tasks remain protected. The eleven-cycle desktop guard test needs a bounded 60-second budget and named field steps; all assertions remain intact.
