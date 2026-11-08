# Runtime map

- `app/main.js`: Electron lifecycle; folder-selection/settings, IPC, clock and Obsidian OS boundary. `COMPANION_TEST_ROOT` substitutes those boundaries for disposable acceptance runs.
- `app/preload.js`: narrow renderer-to-main bridge. Renderer Node access is disabled; sandbox, context isolation, CSP and blocked network/navigation apply.
- `app/vault.js`: authoritative Markdown capture store. Exclusive staged publication, stable UUID frontmatter, first capture instant, derived/editable title, user excerpt provenance. No index or database owns note content.
- `app/renderer.js`, `index.html`, `style.css`: capture, timezone-aware Today, history/search, title edit, open-note workflow.
- `app/intake-producer.js`, `producer-schema/`: Reel to MD draft envelope, strict schema/semantic revalidation, bound-excerpt restrictions, stable multi-file read and exact inert/redacted notes comparison. Supported draft review is unreviewed; extraction completeness and uncertainty are separate.
- `app/intake.js`: vault-owned `.intake/ledger.json`, immutable accepted attempts separate from locator outcomes, staged snapshot/journal publication, title intent recovery, immutable `Revisions/<uuid>.json`, source-byte grouping and distinct producer attempts. Source conflicts retain incoming/local/previous versions and pause that source while independent intake continues. Capture access failures defer per source; only explicit Check now retries them. Stage/final files require ordinary contained files and exact known hardlink peers for recovery. It does not copy media. Source connection/first check/manual checks share this entry point; scheduling will call it later.
- `app/intake-lock.js`: canonical-vault kernel-owned named-pipe lock on Windows; process death releases it without racing stale PID reclamation. Reconciliation, connection and imported title mutation use the same lock.
- `app/intake-view.js`: source connection, first-scan choice, held reasons, last check and source/revision inspection. Sections have named navigation as the shell grows.
- `tests/capture.spec.js`: Playwright Electron desktop plus persisted-files seam. Tests use disposable vaults and controlled clock/timezone/OS dispatch.

Next seams: finalized-review precedence/ambiguity, annotations and identity/conflict repair, and scheduled worker registration extend intake. Preserve capture timestamps, independent user writing and journaled publication. Imported stages never use quick-capture recovery. Intake metadata is vault authority and must not roll back during later app-history restoration.

Settings are outside the vault in Electron user data. Captures, annotations, ideas, briefs and revisions occupy separate areas under the selected parent. Only captures are implemented in #2. No retention expiry exists.
