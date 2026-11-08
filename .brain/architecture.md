# Runtime map

- `app/main.js`: Electron lifecycle; folder-selection/settings, IPC, clock and Obsidian OS boundary. `COMPANION_TEST_ROOT` substitutes those boundaries for disposable acceptance runs.
- `app/preload.js`: narrow renderer-to-main bridge. Renderer Node access is disabled; sandbox, context isolation, CSP and blocked network/navigation apply.
- `app/vault.js`: authoritative Markdown capture store. Exclusive staged publication, stable UUID frontmatter, first capture instant, derived/editable title, user excerpt provenance. No index or database owns note content.
- `app/renderer.js`, `index.html`, `style.css`: capture, timezone-aware Today, history/search, title edit, open-note workflow.
- `tests/capture.spec.js`: Playwright Electron desktop plus persisted-files seam. Tests use disposable vaults and controlled clock/timezone/OS dispatch.
- `app/codex.js`, `codex-rpc.js`, `codex-policy.js`, `codex-isolation.js`, `codex-turn.js`: ticket 8 setup state, private managed App Server lifecycle, dedicated-home policy, real named-profile Windows canary probes, and fresh-thread terminal handling. No auth files or exported tokens are read. `codex-view.js` owns the setup panel. Capture does not depend on Codex readiness.
- `tests/codex.spec.js`: desktop/file acceptance tests with an external stdio child fixture. Fixture results never establish live readiness. `scripts/codex-gate.cjs` drives the same adapter for root-owned live checks; `docs/verification-ticket8.md` records actual evidence and unpassed gates.
- `app/native/codex-read-probe.c` plus its compiled artifact/manifest: reviewed Kernel32-only Windows read-denial probe, reproducibly built by `scripts/build-codex-probe.ps1`. `app/codex-probe.js` verifies pins and copies the helper into the isolated working directory. PowerShell/Node crypto startup failures were not treated as file denials. The full actual direct/child/case/extended/junction matrix passed under the unchanged strict profile.

Next seam: identity reconciliation and imported revision ownership extend the vault writer. Preserve capture timestamps, independent user writing and atomic publication. Worker and UI mutations must use one shared lock/journal contract before concurrent intake is enabled.

Settings are outside the vault in Electron user data. Captures, annotations, ideas, briefs and revisions occupy separate areas under the selected parent. Only captures are implemented in #2. No retention expiry exists.

Codex's separate `codex/managed-home` belongs to App Server and may contain managed credentials. Companion never reads/copies auth files. Future history export/restore must whitelist history data and exclude this managed home; do not archive the whole application-data directory. Readiness reports contain safe evidence, never a reusable certificate.
