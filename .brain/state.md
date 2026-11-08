# Spec #1 implementation

Goal: implement GitHub issue #1 and sub-issues #2–#16 on `integration/1-local-second-brain`.

Baseline: `04ed4fb`. Approved planning committed first in `e030e51`, before worktrees.

Constraints: preserve the accepted spec and ADRs. Tests use the already approved desktop workflow plus resulting files/history, with controlled time, producer artifacts, and agent responses. Real producer, signed-in isolated Codex, and Windows scheduler gates require independent evidence. No merge or deployment without the user or an explicitly assigned reviewer.

Acceptance: all ticket criteria, realistic failure/restart flows, two-axis integration review, release gates reported honestly. Close issues only when their criteria are met.

Reviewed baseline: #2 was committed at `9a6985d85f8ef874a662d3c172447afa82a54439`, independently approved by `review_2`, and fast-forwarded into `integration/1-local-second-brain`. Its 14 desktop/file tests and independent smoke passed. GitHub #2 is closed (comment 6717364384). Native frontier #3, #7 and #8 started from that reviewed baseline.

Ticket #7: local Project Brief work lives in `app/briefs*.js` and its own view. Source documents remain read-only; proposals, source snapshots and approved versions are vault records. Root independently verified the actual MyTune README workflow and exact source bytes/hash. Both independent-review findings were fixed and regression tested. The seven-test brief suite passed (1.3 minutes), then all 21 capture/brief desktop tests passed (3.1 minutes). Syntax and whitespace checks passed. The reviewer found no remaining blocker; exact-commit approval and integration are next. See `../docs/verification-ticket7.md` for evidence and the exact-version pinning seam.

Review authorization: the user explicitly assigned independent reviewer subagents for ticket merges. The final merge to main still requires the user's review. No ticket implementation worker merges, pushes or closes issues.

Native dependency graph: 2 -> 3,7,8; 3 -> 4,5,6; 4+7 -> 9; 9+8 -> 10; 10 -> 11,15; 10+6 -> 14; 11 -> 12; 5+12 -> 13; 13+15+14 -> 16.

Session workflow lesson: worker escalated commands can wait invisibly for approval. Main runs installs/network, Git writes and GUI tests; workers edit and run sandbox syntax checks, then send main exact commands. Do not wait on hidden worker approvals. Electron cannot launch in the sandbox. Initial install/launch failures were infrastructure failures; later behavioral reds and greens are recorded separately in `docs/capture-verification.md`.

Next: finish and independently review exact #3/#7/#8 commits, integrate only after assigned-reviewer approval, then advance the native frontier. Identity reconciliation and source-revision intake extend the vault boundary next; imports must not reuse quick-capture stage recovery without their snapshot/ledger contract. No main merge or release readiness is authorized by the local tests.
