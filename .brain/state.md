# Spec #1 implementation

Goal: implement siddsan7/Companion#1 and #2–#16 on integration/1-local-second-brain. Baseline04ed4fb. Approved planning was committed in e030e51 before worktrees.

Constraints: accepted spec/ADRs apply. The user approved desktop workflow plus resulting files/history as the test seam. Main owns planning, integration, Git writes, installs/network, GUI/native checks and communication. Workers edit isolated worktrees and run syntax checks. Worker escalated commands can hang; root runs them. Ticket merges require independent assigned-reviewer approval. Final merge to main is for the user. No push/deployment occurred.

Reviewed integration:
- #2 offline capture:9a6985d, independently approved;14 desktop/file tests and independent smoke passed; issue closed.
- #7 project briefs:aacc87a, independently approved;7 brief/21 combined tests and actual read-only MyTune README smoke passed; issue closed.
- #3 draft intake:2c27097, independently approved exact tip;35 combined passed,1 actual file-symlink capability skip; actual producer smoke repeated after sync passed33 evidence/one capture/one snapshot/restart idempotence/source hashes unchanged; issue closed(comment6718512475).
- #8 Codex setup: `2993ab0`, independently approved and integrated; 42 tests passed, one file-symlink capability skip (5.8 minutes). Actual Windows isolation and reproducible probe checks passed. Under the user's explicit sign-in deferral, the implementation issue is closed; remaining live checks are recorded as skipped in release #16 (comments 6720370059 and 6720370187). Chat remains unready. No new authentication or real model request is authorized during this deferral. See verification-ticket8.md.

Current work: #4 is integrated at `e672259` and closed (comment 6720197315). Fully reviewed integration `7a638ad` includes #6 scheduling. #5 safety fixes proceed separately. #9 source `8059adb` is synchronizing `7a638ad`; its native blockers are #4+#7, so it can advance without #5. Preserve reviewed modules/tests. The later #5 merger owns the mandatory first #5+#9 annotation coupling before #5 integration.

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

Worker scope: `.worktrees/issue-6`, branch `ticket/6-windows-intake`, base `2c27097`. Root owns Git writes, GUI/native checks and integration. Nine scoped cases passed in 2.0 minutes. Source checkpoint `6148c33` synchronized with reviewed #4 in `9ec6230`; `8a38a5d` corrected the older guard's healthy-status expectation without changing production behavior. The final combined suite passed 59 tests with one Windows file-symlink capability skip (9.2 minutes). Actual producer smoke also passed with 33 evidence entries and unchanged sources. JS syntax, PS parser and whitespace passed. Exact-tip independent approval is next.

Implemented explicit fixed-anchor setup; per-user native task registration/repair/removal; due admission within existing intake locking; coalescing; no intentional wake; pause/resume/disable; UI-closed headless entry; effective task-state/policy drift; durable success/error metadata and busy controls. First/manual checks preserve the anchor. Failed admitted attempts consume their slot and need explicit Check now; the next daily slot remains eligible.

Actual native run c proved automatic UI-closed launch, authored source-file access, one capture/revision and simulated handledSlot 4, task result 0. After the review fix, native d effective inspection passed policyMatches=true: expected enabled TimeTrigger/ceiled boundary/P1D/no expiry/StartWhenAvailable/no wake/IgnoreNew. Root confirmed exact cleanup and absence. Natural 24-hour recurrence, sleep/sign-out missed timing, multi-day OS coalescing and empirical no-wake remain unobserved. No full gate/release readiness claim. Evidence: `../docs/verification-ticket6.md`.

Reusable lessons: translate stored task account names to SID and compare exact identity; Windows may normalize SID registrations. Ceil registered trigger boundaries to whole seconds while retaining exact application anchors because Windows drops trigger fractions. Wait for actual busy-control completion before external mutation; repeated identical success text can be stale. Keep policy drift separate from ownership so known-owned repair can restore settings while foreign tasks remain protected. The eleven-cycle desktop guard test needs a bounded 60-second budget and named field steps; all assertions remain intact.

## Ticket #9 source checkpoint

Source checkpoint8059adb implements local discovery/context preview from reviewed e672259. It is now synchronizing reviewed integration7a638ad, including #6 scheduling. See ../docs/verification-ticket9.md. Root observed full12 desktop/file GREEN plus the final delayed-preview targeted GREEN before sync. No auth/model calls or live provider-bound claim.

Next: root runs synchronized scoped13/full73 and independent exact-tip review before #9 integration. #9 depends on #4+#7, not #5; keep the current annotation reader until #5 integration. The FIRST #5+#9 coupling, owned by the later #5 merger before #5 integration, must consume guarded cross-vault annotations, apply canonical namespaced identity choices and preserve independent annotation header/footer text. No exposed #5 bypass is authorized. The #11 reader remains a provisional dependency adapter; #10 must use durable history dependencies and revalidate before dispatch. Root owns Git/GUI/integration.
