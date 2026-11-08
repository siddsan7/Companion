# Companion

A local Windows desktop capture app for an Obsidian vault. No account or network connection is needed for capture and browsing.

Use Node.js 24 and npm. Run `npm ci`, then `npm start`. Select your vault directory, enter a relative parent folder, and select **Use this folder**. Save a thought or an HTTP(S) link. Titles are derived automatically and can be edited. **Add source excerpt** associates pasted text with a link and labels it as user supplied. Companion never fetches the page.

**Today** uses the PC's current timezone, shown above the capture list. **All captures** and local text search retain access to older notes. Refresh, window focus, and a one-minute refresh update date grouping. **Open in Obsidian** uses the installed application's `obsidian://open` handler.

The chosen parent contains `Captures`, `Annotations`, `Ideas`, `Briefs`, and `Revisions`. Only capture creation is available in this slice. Capture notes are readable Markdown with a stable UUID, schema version and absolute first-capture instant in frontmatter. Title edits retain the same file and identity. Settings live outside the vault in Electron's local user-data directory. Notes have no automatic expiry.

New notes publish from a flushed adjacent staging file using an exclusive hard link. Existing files cannot be replaced by capture creation. Interrupted quick captures recover after their owning process exits. Title edits detect changes since loading, journal the proposed content, move the old file to an adjacent `.bak` file, then publish without replacing an existing destination. Interrupted title saves recover on restart and show a notice. Recovery backups retain changes made through a previously opened editor handle. Inspect both files if Companion reports a conflict. Existing junctions that point outside the vault are refused. Damaged capture metadata reports its filename and preserves valid captures. A copied identity blocks edits visibly. Full move/identity repair belongs to the later identity slice.

Run `npm test` for Playwright's real Electron desktop workflow against disposable vaults and `npm run check` for JavaScript syntax. Electron's first execution can download its pinned runtime and needs network access. Tests substitute OS folder selection, time/timezone and Obsidian dispatch, and pause filesystem writes for controlled crash/editor tests. `COMPANION_TEST_ROOT` enables that harness; never set it for a real vault. The renderer has no Node access and no network access. Test notes and settings stay in the disposable root.

This slice does not provide imports, chat, scheduler, identity repair or a packaged installer. Real producer, Codex isolation, scheduler and installed Obsidian integration gates must be reported separately from acceptance tests.
