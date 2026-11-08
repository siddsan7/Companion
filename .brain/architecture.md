# Runtime map

- `app/main.js`: Electron lifecycle; folder-selection/settings, IPC, clock and Obsidian OS boundary. `COMPANION_TEST_ROOT` substitutes those boundaries for disposable acceptance runs.
- `app/preload.js`: narrow renderer-to-main bridge. Renderer Node access is disabled; sandbox, context isolation, CSP and blocked network/navigation apply.
- `app/vault.js`: authoritative Markdown capture store. Exclusive staged publication, stable UUID frontmatter, first capture instant, derived/editable title, user excerpt provenance. No index or database owns note content.
- `app/renderer.js`, `index.html`, `style.css`: capture, timezone-aware Today, history/search, title edit, open-note workflow.
- `app/intake-producer.js`, `producer-schema/`: Reel to MD draft envelope, strict schema/semantic revalidation, bound-excerpt restrictions, stable multi-file read and exact inert/redacted notes comparison. Supported draft review is unreviewed; extraction completeness and uncertainty are separate.
- `app/intake.js`: vault-owned `.intake/ledger.json`, immutable accepted attempts separate from locator outcomes, staged snapshot/journal publication, title intent recovery, immutable `Revisions/<uuid>.json`, source-byte grouping and distinct producer attempts. Source conflicts retain incoming/local/previous versions and pause that source while independent intake continues. Capture access failures defer per source; only explicit Check now retries them. Stage/final files require ordinary contained files and exact known hardlink peers for recovery. It does not copy media. Source connection, first/manual checks and scheduled/catch-up workers share this entry point and native lock.
- `app/intake-lock.js`: canonical-vault kernel-owned named-pipe lock on Windows; process death releases it without racing stale PID reclamation. Reconciliation, connection and imported title mutation use the same lock.
- `app/intake-view.js`: source connection, first-scan choice, held reasons, last check and source/revision inspection. Sections have named navigation as the shell grows.
- `tests/capture.spec.js`: Playwright Electron desktop plus persisted-files seam. Tests use disposable vaults and controlled clock/timezone/OS dispatch.

Next seams: finalized-review precedence/ambiguity, annotations and identity/conflict repair, and remaining lifecycle work extend intake. Preserve capture timestamps, independent user writing and journaled publication. Imported stages never use quick-capture recovery. Intake metadata is vault authority and must not roll back during later app-history restoration.

Settings are outside the vault in Electron user data. Captures, annotations, ideas, briefs and revisions occupy separate areas under the selected parent. Capture support began in #2; Project Brief support is described below. No retention expiry exists.

## Project Briefs (#7)

- `app/briefs.js`: vault-backed local extraction, append-only proposal/failure records, approved version files carrying their SHA256 in the filename, strict retained snapshot/reference validation, current source checks, and exact version lookup for downstream conversation pinning. Full selected source text is retained. Nothing is shortened automatically.
- `app/briefs-lock.js`: cross-process kernel ownership for every brief mutation, keyed by canonical selected parent path. Windows named pipes and Linux abstract sockets release on process death; no PID/stale-file reclamation. Version allocation and exclusive publication stay in the same lock. Busy attempts preserve the editor for explicit retry.
- `app/briefs-ipc.js`: OS file selection and serialized brief mutations; renderer cannot supply arbitrary source paths to reads. Source selection is explicit and not recursive.
- `app/briefs-view.js`: local source/passages inspection, editable text and validated source:line references, explicit approval, staleness/failure warnings and preserved approved history.
- `tests/briefs.spec.js`: approved desktop plus persisted-files seam, disposable selected documents and OS dialog substitute. `brief-pin` reads and validates only candidates for the requested approved numeric version, so unrelated damaged proposals/newer approvals cannot block a healthy historical pin. It returns the exact approved version, retained sources and current source warnings; unavailable, damaged or ambiguous requested versions fail rather than substitute another version.

Local extraction is a transparent heading-based draft, not a model summary or semantic verification. User edits remain identified as user writing. Conversation UI and complete outgoing context limits remain downstream responsibilities.

## Daily Windows intake (#6)

- `app/schedule.js`: installation-local anchor, desired lifecycle state, exact task identity, due-slot admission inside the existing Intake lock, coalescing, terminal diagnostics. A failed/interrupted admitted scheduled attempt consumes that due slot; explicit Check now retries, while the next daily slot remains eligible. First/manual checks do not consume scheduled slots.
- `app/task-scheduler.js` and `task-scheduler.ps1`: fixed no-shell adapter, JSON stdin, exact owned task lookup; InteractiveToken/least privilege, infinite PT24H, UTC first boundary A+24h, no intentional wake, missed-run availability and IgnoreNew. Pause gates queued launches, resume retains A, disable removes only the exact task, repair validates ownership/action before update. Effective trigger/count/boundary/repetition/expiry/catch-up/wake/overlap settings are inspected separately and drift stays visible until repair. Native boundaries ceil to whole seconds; application anchors stay exact.
- `app/main.js --intake-worker --schedule-file <absolute>`: headless early lifecycle path; never creates a BrowserWindow. Uses the same Intake.reconcile and lock as source connection, first scan and Check now.
- `tests/schedule.spec.js`: desktop plus resulting files/history, controlled time and OS task boundary; headless subprocess is real Electron. `scripts/probe-scheduled-intake.cjs` is a root-only disposable native integration tool, not application startup behavior.
