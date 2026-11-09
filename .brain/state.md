# Spec #1 implementation

Goal: finish siddsan7/Companion#1 and approved tickets #2–#16 on integration/1-local-second-brain. Baseline04ed4fb. Planning commit e030e51 and memory checkpoint5a7f0c7 preceded all worktrees.

The accepted spec/ADRs and desktop workflow plus resulting files/history are the approved seam. Main owns planning, integration, Git writes, installs/network, GUI/native checks, review and communication. Workers use isolated worktrees and read/syntax checks; worker escalation can hang, so root runs it.

Publishing: draft PR17 targets main. Follow [publishing.md](publishing.md): preserve every commit and linked siddsan7 identity; no squash/amend/rebase/force/backdates. Push checked milestones and keep the PR current. After the full spec, fresh independent code-review Standards and Spec reviewers must approve the final tip; fix blockers separately and pass local automated checks. Then use a merge commit, verify remote main/history, and pause cleanly for the user's access change. No deployment. Hosted Actions was blocked before any step by billing and is explicitly user-waived; never report it passed or bypass actual GitHub-required rules.

Reviewed, integrated implementation:
- #2 capture9a6985d; #3 draft intake2c27097; #4 finalized reviews e672259.
- #7 approved briefs aacc87a; #8 isolated setup2993ab0; #6 scheduled intake7a638ad; #9 local context43b2e7a.
- #5 repairs473fbff, including guarded whole-vault annotations, explicit canonical authority, conflict/kept-current repair, source-specific holds and crash recovery. Final combined gate:97 passed/1 Windows file-symlink capability skip in18.8m. Exact-tip independent review and merger approved. Actual producer smoke:1 capture/1 revision/33 evidence, restart idempotent, originals unchanged. Details: ../docs/verification-ticket5.md.

Active: #10 conversations in its own worktree; checked milestones are published through `3ece6cf` on `ticket/10-project-conversations`. All 15 conversation/Codex cases passed in 5.2 minutes, including exact reviewed packages, explicit retry, source/history exclusions across restarts and windows, bounded full Unicode history, and complete assistant messages/phases. Remaining: terminal-array ordering, persistent storage-failure visibility, setup terminal persistence, supported usage, shared capacity binding, conversation selection/brief pin/speculation and final eligibility checks. Complete acceptance, sync latest integration, run combined gates and obtain independent review before integrating. #11/#14/#15 become ready after #10; #12 follows #11; #13 follows #5+#12; #16 follows #13+#14+#15. Read-only #11 notes are in literal Temp/companion-ideas-notes.md; no downstream implementation has begun. Explicit prior-conversation search/export belongs to #12.

Native graph:2->3,7,8;3->4,5,6;4+7->9;9+8->10;10->11,15;10+6->14;11->12;5+12->13;13+15+14->16.

Guardrails:
- Vault Markdown owns content; .intake/ledger.json owns admitted attempts, outcomes, identity choices and suppression. History restore must never roll it back. Preserve immutable attempts/snapshots, stable capture IDs, first instants and user titles.
- Kernel locks have no stale-PID reclamation. Ordinary contained files and exact known hardlink peers are mandatory. Record exclusions survive loss of a chosen canonical file, including changed excluded-copy bytes; explicit selection is required. Ordinary unique moves remain supported.
- Annotation inspection retains all copies; supporting context admits only current canonical eligible writing. Strip only the immediate generated header after the first frontmatter boundary. Independent body/footer text remains user-owned.
- Known kept-current failures require fresh explicit annotation transfer, never automatic pending publication. Known relationship/editor failures establish durable source-specific holds; invalid global authority, aliases and storage failures remain errors.
- #13 must inventory current/moved paths, acknowledged duplicates, snapshots, all source-bearing journals/stages/before-files, repair/link archives, detach intents/retained peers/independent stages and held archives. Some contain the ONLY approved unpublished independent writing. Preserve/materialize it or offer separately scoped removal. Exact schemas are in verification-ticket5.md and current code.
- Codex managed-home can hold credentials: never read/copy auth files or include it in archives. No new authentication or real model request is authorized under the live-sign-in deferral. Chat stays unready; fixtures and static schema export are not live inference proof.

Verified limits: actual Windows isolation/probe checks and disposable native scheduler launch/policy checks passed; all temporary tasks were removed and absence verified. Natural finalized-review handoff, 24-hour/sleep/sign-out scheduling, empirical no-wake, installed Obsidian and signed-in prompt/tool inventory/inference/capacity remain unobserved or deferred. Report each separately; no release-ready claim.

Reusable test lessons:
- Playwright's Windows process() can be a shell wrapper. Crash tests exit actual Electron main, await process boundaries and verify main absence; killing the wrapper alone leaves its lock alive.
- Await public startup readiness/busy completion before manual operations; repeated old status text is not completion. Intentionally paused startup cases keep their explicit checkpoint seam.
- Windows atomic history replacement produced repeated `rename`/`EPERM` errors during multi-item streaming. Retry only the same fsynced stage rename, under the store lock, with a monotonic one-second budget; never delete the destination or retry a model request. The verified case handled 12 rename failures, persisted complete messages, sent once and restarted without replay. Whitelisted evidence: literal Temp/companion-conversation-publication10-20261108. Permanent failure must remain honest; polling currently masks its warning and still needs a separate fix.
- Write source/tests with explicit UTF-8. Node syntax checks missed an invalid Windows-encoded byte; #16 must enforce fatal source decoding. Draft notes fixture must be LF (Git blob c93c3c29690e4ba10ee52a49f3f767c95d49fbaa); finalized review fixtures preserve hashed raw CRLF bytes via -text attributes.
- Native task inspection translates account names to exact SID; registration ceilings fractional boundaries to seconds while the app retains its exact anchor. Ownership is distinct from policy drift.

External notes use literal C:/Users/sidds/AppData/Local/Temp/ (sandbox temp can disappear): companion-producer-notes.md, companion-review-canonical-notes.md, companion-scheduler-notes.md, companion-conversation-notes.md, companion-deletion-notes.md, companion-archive-notes.md and companion-evaluation-notes.md. Canonical JSON parity had174359 oracle cases without mismatch. Static installed CLI0.163.0 protocol schemas are in companion-codex-schema10-rbEUbW/schemas; no auth/model ran. Current code and per-ticket verification records win over preparatory notes.

Next: finish #10 and advance the graph. Refresh final release evidence and perform whole-PR independent review only after full implementation, then follow the publishing/merge/pause checkpoint.
