# Spec #1 implementation

Goal: implement siddsan7/Companion#1 and #2–#16 on integration/1-local-second-brain. Baseline04ed4fb. Approved planning was committed in e030e51 before worktrees.

Constraints: accepted spec/ADRs apply. The user approved desktop workflow plus resulting files/history as the test seam. Main owns planning, integration, Git writes, installs/network, GUI/native checks and communication. Workers edit isolated worktrees and run syntax checks. Worker escalated commands can hang; root runs them. Ticket merges require independent assigned-reviewer approval. Final merge to main is for the user. No push/deployment occurred.

Reviewed integration:
- #2 offline capture:9a6985d, independently approved;14 desktop/file tests and independent smoke passed; issue closed.
- #7 project briefs:aacc87a, independently approved;7 brief/21 combined tests and actual read-only MyTune README smoke passed; issue closed.
- #3 draft intake:2c27097, independently approved exact tip;35 combined passed,1 actual file-symlink capability skip; actual producer smoke repeated after sync passed33 evidence/one capture/one snapshot/restart idempotence/source hashes unchanged; issue closed(comment6718512475).
- #8 Codex setup:2993ab0, independently approved exact tip and merger-verified;42 combined passed,1 file-symlink capability skip(5.8min). Actual installed Windows direct/child/case/extended/junction denials and reproducible native probe passed. The user deferred live sign-in/model/provider checks. Chat remains unready; issue8 remains open for the live gate(comment6718768608). No new authentication/model request is authorized during this deferral. See verification-ticket8.md.

Active frontier: ticket4 human reviews, ticket5 vault repair, ticket6 Windows scheduler in separate .worktrees/issue-* from2c27097. Sync latest integration before final handoff. Scope/checks/evidence live in docs/verification-ticket4.md,5.md,6.md within those worktrees. Source modules and tests for reviewed features must survive synchronization.

Native dependency graph:2->3,7,8;3->4,5,6;4+7->9;9+8->10;10->11,15;10+6->14;11->12;5+12->13;13+15+14->16. Final two-axis code-review and whole-story gates remain required. Do not claim release-ready from fixtures; report actual/skipped gates honestly.

Storage guardrails: vault Markdown owns content. .intake/ledger.json owns admitted attempts/outcomes/suppression independently of application history; never roll it back during history restore. Imported snapshots are immutable; unresolved local/incoming conflicts and recovery copies remain source-bearing. Deletion must enumerate them while retaining identity/outcome/suppression metadata. Preserve stable capture IDs/first timestamps/user titles and independent annotations. Kernel lock, exact stage ownership/alias checks and source-specific failure isolation remain required.

Reusable evidence notes outside repo: C:\Users\sidds\AppData\Local\Temp\companion-producer-notes.md, companion-review-canonical-notes.md, companion-scheduler-notes.md. Canonical Python JSON parity had174359 oracle cases with no mismatch; actual Electron lossless reviver capability subsequently passed. Natural finalized review and natural24h/sleep-signout gates remain distinct from synthetic/accelerated checks.

Native scheduler work-in-progress: exact task ownership initially failed because Windows returned account name instead of SID; exact SID translation fixed it and old task was removed. Real automatic UI-closed launch imported an authored fixture(task result0), but expected missed slot4 observed3 because Windows truncated trigger fractional seconds. That task also removed and absence verified. Worker6 is adding ceil-to-second native trigger regression while retaining exact application anchor. No disposable task remains at this checkpoint.

Next: complete frontier implementation/review, synchronize each from current integration, run combined checks, integrate approved tips and advance graph. Keep final main merge for user review. The live sign-in deferral remains in force.
