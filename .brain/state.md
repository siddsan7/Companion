# Spec #1 implementation

Goal: implement GitHub issue #1 and sub-issues #2–#16 on `integration/1-local-second-brain`.

Baseline: `04ed4fb`. Approved planning committed first in `e030e51`, before worktrees.

Constraints: preserve the accepted spec and ADRs. Tests use the already approved desktop workflow plus resulting files/history, with controlled time, producer artifacts, and agent responses. Real producer, signed-in isolated Codex, and Windows scheduler gates require independent evidence. No merge or deployment without the user or an explicitly assigned reviewer.

Acceptance: all ticket criteria, realistic failure/restart flows, two-axis integration review, release gates reported honestly. Close issues only when their criteria are met.

Current frontier: #2 (offline capture), branch `ticket/2-offline-capture`, based on planning tip `5a7f0c7`. Electron 45.2.3, Playwright 1.65.0, YAML 2.9.1 and npm lockfile establish the first desktop runtime. Final desktop/file suite: 14 passed; syntax and whitespace checks passed. Independent desktop smoke confirmed readable files and full Unicode/Markdown excerpt display. Installed Obsidian, producer, Codex isolation and scheduler gates remain skipped. Runtime/ownership details are in `architecture.md`; red/green evidence and gate status are in `../docs/capture-verification.md`.

Review authorization: the user explicitly assigned independent reviewer subagents for ticket merges. The final merge to main still requires the user's review. No ticket implementation worker merges, pushes or closes issues.

Native dependency graph: 2 -> 3,7,8; 3 -> 4,5,6; 4+7 -> 9; 9+8 -> 10; 10 -> 11,15; 10+6 -> 14; 11 -> 12; 5+12 -> 13; 13+15+14 -> 16.

Session workflow lesson: worker escalated commands can wait invisibly for approval. Main runs installs/network, Git writes and GUI tests; workers edit and run sandbox syntax checks, then send main exact commands. Do not wait on hidden worker approvals. Electron cannot launch in the sandbox. Initial install/launch failures were infrastructure failures; later behavioral reds and greens are recorded separately in `docs/capture-verification.md`.

Next: commit and independently review #2's exact diff, integrate only after assigned-reviewer approval, then advance the native frontier. Identity reconciliation and source-revision intake extend the vault boundary next; imports must not reuse quick-capture stage recovery without their snapshot/ledger contract. No main merge or release readiness is authorized by the local tests.

## Ticket #3 worker handoff

`ticket/3-reel-drafts` began at reviewed #2 commit `9a6985d85f8ef874a662d3c172447afa82a54439`; ancestry was confirmed before edits. Scope is explicit draft connection/check, independently validated producer drafts, byte grouping/distinct attempts, immutable snapshots, vault-owned outcomes, shared native lock, crash/title recovery, held/conflicting source isolation and source inspection. Feature code is frozen for main-agent full checks, actual producer desktop handoff, current-tip synchronization and exact-commit independent review. No worker merge/push/closure is authorized.

Final scoped #3 desktop/file suite: 14 passed, 1 actual file-symlink capability skip (1.9 min). All JavaScript syntax and whitespace checks passed after the last product edit. Independent actual producer desktop admission passed before the final guards (9.3 s): 1 capture, 1 snapshot, partial/unreviewed, 33 evidence entries, restart idempotent, all producer hashes unchanged. Root will repeat the smoke and full combined suite after synchronization. Full producer/conversation/saved-proposal, installed Obsidian, Codex isolation and scheduler gates are separate; this ticket does not establish them.

Intake authority is `.intake/ledger.json` in the vault, including immutable accepted attempts independently of mutable locator outcomes. Application-history restore must not roll it back. Interrupted source journals are separate from quick-capture stages. Incoming conflict snapshots/archives and previous/local files remain available; explicit repair is a later public seam. Deletion must enumerate these source-bearing recovery files while retaining identity/outcome/suppression metadata.

Review corrections: file-specific immutable target collisions are isolated; capture rename EACCES/EPERM/EBUSY is deferred per source and retried only on explicit Check now. Global ledger/vault failures still stop. Outside stage aliases are refused by ordinary-file, containment and exact known-peer link checks. Both actual hardlink classes and own post-link crash recoveries passed; the actual file-symlink case is skipped for Windows EPERM. Imported generated headings remain literal through title edits without rewriting source text. Next: root-owned clean checkpoint, assigned merger synchronization to reviewed #7 tip `aacc87a`, combined suite/producer repeat, and exact-commit independent review. No further product edits without a concrete merge/review finding.
