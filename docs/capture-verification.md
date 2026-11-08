# Offline capture verification

Scope: issue #2, desktop actions and persisted Markdown/settings. Disposable vaults and a controlled clock/timezone are the approved acceptance boundary. The harness substitutes only folder selection, time, Obsidian dispatch and filesystem interruption checkpoints. It launches the actual Electron application.

Recorded evidence so far:

- Initial Electron installation and sandbox launch failures were infrastructure failures, not behavioral reds.
- Literal title text containing JavaScript replacement tokens failed before callback-based replacement; it passed after correction.
- Interrupted title save reached the staged-write checkpoint, killed the process, and failed to recover the requested title after restart. The durable transaction implementation then passed all three acceptance tests, including subsequent title editing.
- A numeric externally edited capture timestamp broke the list with `capturedAt.localeCompare is not a function` and no file warning. A regression now requires the damaged filename to be visible while a valid YAML capture remains available.
- A real Windows `Captures` junction to an outside directory was accepted as "Vault ready" before realpath containment checks. The regression requires refusal and preserves an unrelated file outside the vault.
- Interrupted capture reached the flushed-stage checkpoint, then failed to appear after kill/restart. Recovery now distinguishes quick captures from title journals and skips live owners. Its regression passed in the next full run.
- Independent desktop smoke and the excerpt regression found that a Markdown horizontal rule truncated displayed content. The renderer now strips only initial frontmatter. The regression and an independent desktop smoke passed with Unicode, the horizontal rule, tail text and provenance intact.
- The next full run had 11 passing tests and one test-harness timing failure: the failed-save test removed the capture directory before setup had visibly completed. Setup now waits for "Vault ready" before injecting failure. The assertions for retained draft and one successful retry remain unchanged.
- With setup synchronization corrected, 12 tests passed. The ownership regression failed because an invalid title journal restored unrelated backup bytes to a missing target. Restoration and cleanup now require a validated capture identity, source hash and title-only proposal.
- After that guard, 13 tests passed. The added heading regression failed because a title edit replaced a later source heading after the generated heading had been removed. Title edits now change only an exact generated heading at its original leading position. Changed/deleted headings and later source text remain intact.

Final acceptance suite: **14 passed**. Coverage includes offline thought/link capture, empty rejection, editable stable titles, restart persistence, external edits and interleavings, interrupted capture/title saves, invalid recovery ownership, Obsidian-compatible YAML, damaged metadata isolation, actual Windows junction refusal, excerpt provenance and full Markdown/Unicode display, recorded Obsidian URI, local midnight/travel/DST, historical search and failed-write retry. JavaScript syntax and `git diff --check` pass. Independent desktop smoke confirmed readable files and the Unicode/horizontal-rule/provenance display. No installed Obsidian handler was exercised.

Tests for functionality already built before the first usable Electron run are conformance coverage, not retrospective evidence of test-first implementation. Keep that distinction in the final report.

Real integration gates:

| Gate | Status | Evidence |
| --- | --- | --- |
| Installed Obsidian opens the note | Skipped | Harness records the URI; that is not a passed installed-handler check. |
| Real Reel to MD producer handoff | Skipped | Outside this capture slice. |
| Signed-in Codex with effective Windows isolation | Skipped | Outside this capture slice. |
| Windows scheduled worker | Skipped | Outside this capture slice. |

No release-readiness claim follows from these local capture tests. Review and integration remain separate from implementation.
