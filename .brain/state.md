# Spec #1 implementation

Goal: implement GitHub issue #1 and sub-issues #2–#16 on `integration/1-local-second-brain`.

Baseline: `04ed4fb`. Approved planning committed first in `e030e51`, before worktrees.

Constraints: preserve the accepted spec and ADRs. Tests use the already approved desktop workflow plus resulting files/history, with controlled time, producer artifacts, and agent responses. Real producer, signed-in isolated Codex, and Windows scheduler gates require independent evidence. No merge or deployment without the user or an explicitly assigned reviewer.

Acceptance: all ticket criteria, realistic failure/restart flows, two-axis integration review, release gates reported honestly. Close issues only when their criteria are met.

Reviewed baseline: #2 was committed at `9a6985d85f8ef874a662d3c172447afa82a54439`, independently approved by `review_2`, and fast-forwarded into `integration/1-local-second-brain`. Its 14 desktop/file tests and independent smoke passed. GitHub #2 is closed (comment 6717364384). Native frontier #3, #7 and #8 started from that reviewed baseline.

Ticket #7: local Project Brief work lives in `app/briefs*.js` and its own view. Source documents remain read-only; proposals, source snapshots and approved versions are vault records. Root independently verified the actual MyTune README workflow and exact source bytes/hash. Both independent-review findings were fixed and regression tested. The seven-test brief suite passed (1.3 minutes), then all 21 capture/brief desktop tests passed (3.1 minutes). Syntax and whitespace checks passed. Exact commit `aacc87a8feaa97a9fc5985185d8e2342ba762056` received independent approval and was integrated; GitHub #7 is closed. See `../docs/verification-ticket7.md` for evidence and the exact-version pinning seam.

Review authorization: the user explicitly assigned independent reviewer subagents for ticket merges. The final merge to main still requires the user's review. No ticket implementation worker merges, pushes or closes issues.

Native dependency graph: 2 -> 3,7,8; 3 -> 4,5,6; 4+7 -> 9; 9+8 -> 10; 10 -> 11,15; 10+6 -> 14; 11 -> 12; 5+12 -> 13; 13+15+14 -> 16.

Session workflow lesson: worker escalated commands can wait invisibly for approval. Main runs installs/network, Git writes and GUI tests; workers edit and run sandbox syntax checks, then send main exact commands. Do not wait on hidden worker approvals. Electron cannot launch in the sandbox. Initial install/launch failures were infrastructure failures; later behavioral reds and greens are recorded separately in `docs/capture-verification.md`.

Next: verify and independently review the exact synchronized #3 candidate before integration, then advance the native frontier. Identity reconciliation and source-revision intake extend the vault boundary; imports must not reuse quick-capture stage recovery without their snapshot/ledger contract. No main merge or release readiness is authorized by the local tests.

## Ticket #3 worker handoff

`ticket/3-reel-drafts` began at reviewed #2 commit `9a6985d85f8ef874a662d3c172447afa82a54439`; ancestry was confirmed before edits. Scope is explicit draft connection/check, independently validated producer drafts, byte grouping/distinct attempts, immutable snapshots, vault-owned outcomes, shared native lock, crash/title recovery, held/conflicting source isolation and source inspection. Feature code is frozen for main-agent full checks, actual producer desktop handoff, current-tip synchronization and exact-commit independent review. No worker merge/push/closure is authorized.

Final scoped #3 desktop/file suite: 14 passed, 1 actual file-symlink capability skip (1.9 min). After synchronization with reviewed #7, all 36 combined cases completed: 35 passed, 1 capability skip (5.0 min). Syntax and whitespace checks passed. Independent actual producer desktop admission passed again on the synchronized tree: 1 capture, 1 snapshot, partial/unreviewed, 33 evidence entries, restart idempotent, all producer hashes unchanged. Full producer/conversation/saved-proposal, installed Obsidian and scheduler gates remain separate. The user deferred live Codex sign-in; chat stays unready.

Intake authority is `.intake/ledger.json` in the vault, including immutable accepted attempts independently of mutable locator outcomes. Application-history restore must not roll it back. Interrupted source journals are separate from quick-capture stages. Incoming conflict snapshots/archives and previous/local files remain available; explicit repair is a later public seam. Deletion must enumerate these source-bearing recovery files while retaining identity/outcome/suppression metadata.

Review corrections: file-specific immutable target collisions are isolated; capture rename EACCES/EPERM/EBUSY is deferred per source and retried only on explicit Check now. Global ledger/vault failures still stop. Outside stage aliases are refused by ordinary-file, containment and exact known-peer link checks. Both actual hardlink classes and own post-link crash recoveries passed; the actual file-symlink case is skipped for Windows EPERM. Imported generated headings remain literal through title edits without rewriting source text. Next: root-owned clean checkpoint, assigned merger synchronization to reviewed #7 tip `aacc87a`, combined suite/producer repeat, and exact-commit independent review. No further product edits without a concrete merge/review finding.

Synchronization: merger `sync_3` combined reviewed #7 tip `aacc87a8feaa97a9fc5985185d8e2342ba762056` with #3 checkpoint `5e5d35ffd99d2fa5c448f34d76604bd5e1e523a0` in `d8dc3ed22045f83415aa0bc615d15fe93ade2db7`. Both feature modules/tests remain unchanged. Combined checks and the actual producer smoke passed as recorded above. Independent review found no remaining blocker; exact final commit approval and integration are next.

## Ticket #5 frozen candidate

Base 2c27097 verified. The approved desktop workflow plus files/history seam was implemented through nine vertical RED/GREEN cases. Final root-run scoped suite: 9 passed in 1.9 minutes. Cases cover durable annotation transfer, ordinary annotations, verified moves and links, preserved duplicate selection/reopening, missing restore/scoped intake removal with retained history/suppression, actual unavailable-vault restart, moved-conflict paths, interleaved edit recovery/independent intake, and conflict-before-move with current user title retention. Original capture identity/instant and historical archive bytes remain preserved.

Independent review found two confirmed defects (moved resolution path and colliding resolution archives), then one conflict-before-move case; all have public regressions and observed GREEN corrections. Product/tests are frozen for root checkpoint, latest integration synchronization, combined regression and exact-tip re-review. Worker performed no Git writes, installs/network, GUI launches, merges or closure. Actual Obsidian integration is skipped: no common install/URI registration was found. Controlled URI dispatch proves only the OS-boundary request. See ../docs/verification-ticket5.md.

Storage handoff: .intake ledger retains identity choices, missing/removal state, attempts/outcomes/suppression. History restore must not roll it back. Later capture deletion must enumerate all accepted revisions, original and resolution conflict/deferred journals, source/annotation/link stages and before-files, annotation/repair/link intents, moved current paths and preserved duplicate paths. Missing-note removal here explicitly removes only from active intake and retains history; complete dependency-preview deletion belongs to #13.

Next: root-owned checkpoint; sync reviewed integration (including #4/#6/#8), preserve their APIs/modules, run combined checks and assigned exact-tip review before integration. No final main merge or release-ready claim.
