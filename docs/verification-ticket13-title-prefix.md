# Ticket 13 adjacent title-prefix guard

The regression uses two public workflows: a saved manual thought and an imported draft. Each completes Save title, previews the actual source files, confirms deletion, observes the first native unlink and its pause, and observes main-process exit. Only after exit does the fixture write a new ordinary adjacent mixed-case `.BeFoRe-TiTlE-<UUID>.bak` file from literal surviving source-note bytes. It does not change original files or the ledger.

Each case writes `title-prefix-reached-boundaries.json` before the recovery assertion. This records actual writer hashes, the actual unlink, process exit, original survivors, and the controlled new arrival separately. Recovery must retain the original deleting authority, every original survivor and the new copy with exact bytes and identities. The already removed consented target must stay absent. Producer facts must remain unchanged.

Suggested root-owned run: `npx playwright test tests/title-prefix-deletion.spec.js --workers=1`. Runtime RED/GREEN evidence and broader gates are pending the root owner's execution. This test-only handoff does not claim a passing fix or release approval.

Root first93799 was fixture failure9.1/10.8s at undefined source.id/authority lookup; main exit/arrival/recovery not reached. It is NOT product RED. Corrected raw YAML companion_id lookup with UUID assertion, production unchanged. Initial errors retained Temp/companion-ticket13-title-prefix-fixture-failure-20261110.

Root corrected56352 TRUE RED: both manual/imported cases failed9.5s/11.8s at after-restart authority comparison, phase deleted received instead of original deleting. Actual writer files/native first unlink/main exit and controlled NEW distinct mixed-case source-copy arrival all passed beforehand. Reached-boundaries observations independently show alias present while original targets were purged; later byte/inode assertions were not reached. Evidence Temp/companion-ticket13-title-prefix-red-20261110. No product change preceded this result. Root-approved minimum shared CaptureDeletion prefix inspector follows; exact canonical ownership remains unchanged.
