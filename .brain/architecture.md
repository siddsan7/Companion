# Runtime map

- `app/main.js`: Electron lifecycle; folder-selection/settings, IPC, clock and Obsidian OS boundary. `COMPANION_TEST_ROOT` substitutes those boundaries for disposable acceptance runs.
- `app/preload.js`: narrow renderer-to-main bridge. Renderer Node access is disabled; sandbox, context isolation, CSP and blocked network/navigation apply.
- `app/vault.js`: authoritative Markdown capture store. Exclusive staged publication, stable UUID frontmatter, first capture instant, derived/editable title, user excerpt provenance. No index or database owns note content.
- `app/renderer.js`, `index.html`, `style.css`: capture, timezone-aware Today, history/search, title edit, open-note workflow.
- `tests/capture.spec.js`: Playwright Electron desktop plus persisted-files seam. Tests use disposable vaults and controlled clock/timezone/OS dispatch.

Next seam: identity reconciliation and imported revision ownership extend the vault writer. Preserve capture timestamps, independent user writing and atomic publication. Worker and UI mutations must use one shared lock/journal contract before concurrent intake is enabled.

Settings are outside the vault in Electron user data. Captures, annotations, ideas, briefs and revisions occupy separate areas under the selected parent. Only captures are implemented in #2. No retention expiry exists.
