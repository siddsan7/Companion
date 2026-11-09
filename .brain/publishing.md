# Publishing and final checkpoint

The user's latest instructions replace the earlier personal-review-only main merge rule.

- Draft PR: https://github.com/siddsan7/Companion/pull/17. Head: `integration/1-local-second-brain`; base: `main`.
- Finish spec #1 and every approved sub-issue before final PR review or merge. Keep the PR description, ticket checklist and actual gate evidence current.
- Preserve all existing commits and ticket-branch ancestry. Use ordinary commits and history-preserving merges. Never squash, amend, rebase, force-push, backdate or manufacture commits.
- Keep milestones cohesive and independently reviewable. Push verified milestones; publish ticket branches when their checked commits are not yet integrated.
- Future commits use the existing `siddsan7 <siddsan7@gmail.com>` author identity. GitHub's remote baseline commit maps that exact identity to `siddsan7`. Check actual author/committer identity before commits; do not override dates.
- At completion use the code-review skill against the complete PR. Fresh independent Standards and Spec reviewers must not have authored the changes. Fix blockers in separate commits, rerun relevant checks, and obtain approval of the final PR tip.
- Add repeatable automated release checks in #16; the baseline has no Actions workflow. Required checks must pass. Then mark ready and merge with a merge commit, preserving individual commits. No further workflow confirmation is needed.
- Keep live-sign-in deferral and all resulting readiness restrictions. Skipped live checks are not passed checks. No deployment is authorized.
- Before merging, stop workers and test processes, clean temporary native tasks and finish local cleanup. After merging, verify remote `main` contains the merge and complete history, then pause at the clean checkpoint so the user can change access permissions. Do not change permissions or continue post-merge work automatically.
