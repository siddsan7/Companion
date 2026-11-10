# Ticket 13 plain manual authority corrections

Both manual authority defects are fixed and have independent Standards and Spec approval at tree `330dab30e00728b8adceceeedcb017364125290d`, committed as `2ae433391886f1f270ad11389158a8d6e940de2c`. Both unchanged regressions and six relevant controls passed. The complete gate remains pending: expected 144 cases across 18 files, subject to actual discovery. These bounded passes and approvals do not approve ticket integration, the full PR, main merge or deployment.

## Actual evidence

Durations are elapsed milliseconds. All completed runs below had zero skips. Tree prefixes identify the tested state; result-only documentation may have been committed later. Evidence folders are under `C:/Users/sidds/AppData/Local/Temp/`.

| Run | Tested tree | Actual result | Duration (ms) | Evidence folder |
| --- | --- | --- | ---: | --- |
| P1 foreign ledger, RED | `fa1965631f8bcffad132ce7f43949858fc2daad5` | 1 failed; exit 1 | 10,364 | `companion-ticket13-manual-ledger-red-20261110` |
| P1 unchanged regression, GREEN | `ee379c076295819720a7d3d71200679811d896fc` | 1 passed; exit 0 | 10,673 | `companion-ticket13-manual-ledger-green-20261110` |
| P2 reserved copy, RED | `9ad6c505dc1f322af063bff4aa9f1df39621ee69` | 1 failed; exit 1 | 8,270 | `companion-ticket13-manual-completion-red-20261110` |
| P2 unchanged regression, GREEN | `174b6eccb7fe6d4dd1fa5f72818de6cb18026b4c` | 1 passed; exit 0 | 9,850 | `companion-ticket13-manual-completion-green-20261110` |
| Six relevant controls | `fce9cf95bfdb996beed40185e5e04d50b77451d5` | 6 passed; exit 0 | 88,807 | `companion-ticket13-manual-authority-coupled-six-20261110` |
| Earlier 142-case gate, stopped | corrected candidate before manual fixes | 13 completed passes, 0 completed failures; stopped, exit 1 | 299,371 | `companion-ticket13-corrected-final-142-20261110` |

The stopped 142-case run is incomplete, never a full pass. Root stopped its owned Playwright process tree after the independent P1 finding. The original full 141-case gate also remains failed: 138 passed, 3 failed, no skips, exit 1, 3,374,493 ms. See [the composed-gate report](verification-ticket13-gate-fixes.md).

## P1: validate the live ledger before source removal

A plain saved thought with no title backups has no inventoryVersion authority. The public Electron UI test chooses a vault, saves that thought, reviews the actual one-target preview and pauses at the existing capture-deletion-authorized checkpoint. Source bytes and identity are still present. It externally replaces the committed ledger with a new ordinary single-link inode retaining the same operation and manifest plus one distinct valid suppression entry. No authority or admission is fabricated.

Actual RED saved the source, ledger and UI observations before the first feature assertion. After release, the source was absent, foreign ledger bytes remained exact, authority remained deleting and the later save reported ledger changed. Source-preservation assertion 70 failed; later recovery assertions were not reached. This was real removal before a live authority check, not setup failure.

The bounded fix applies the existing full ledger parent/physical identity/digest guard before every unlink and completion. The unchanged GREEN preserved the source and exact foreign ledger during HOLD and showed the specific ledger-changed reason. Explicit Refresh then completed the same committed operation and manifest, advancing only phase to deleted while retaining foreign suppression.

## P2: hold completion when an unknown reserved copy arrives

The second public UI test pauses at the existing capture-deletion-unlinked checkpoint. Here the source is already absent through an authorized unlink; that is distinct from P1's loss before validating changed authority. Actual authority is deleting, legacy and single-target. The test creates one ordinary single-link `.BeFoRe-TiTlE-<UUID>.md` sidecar with the original whole source bytes under the reserved prefix. Literal ledger bytes remain unchanged.

Actual RED recorded source, copy, ledger and UI before the first feature assertion. The app marked the operation deleted and reported Capture deleted while the exact new copy survived. Expected-deleting assertion 138 failed; later HOLD/recovery assertions were not reached. This proves false completion, not resurrection or adoption of a forged title writer.

The further fix removes two conditions around existing inventory inspections. Every family now runs full inventory/namespace inspection and the owned-ledger guard before each unlink and completion. Final family-specific target, parent, peer and mixed-writing receipt checks retain their ordering after the guard; no awaited ledger read moves after the last leaf check. The unchanged GREEN holds phase deleting and preserves exact ledger/copy without granting deletion authority over the new copy. Only after verifying and removing its own controlled external arrival does the test use explicit Refresh to finish the same authority. It reconstructs no source and expands no consent.

## Preserved changes, review and limits

The P1 regression/report is separate in `f69fda2`; its source fix is `a537172`. The P2 regression/report is separate in `b0de1a6`; its source fix is `2ae4333`. No test actions, assertions or timeouts changed between each actual RED and GREEN. All earlier commits remain in ancestry.

The six-case pass covers both new manual regressions, imported external-ledger recovery, titled-manual deletion/Cancel, kept-current two-output writing retention and persistent detached-editor whole-writing retention. These representative controls verify the shared-loop ordering; they do not cover every family or replace the complete gate. The agreed seam is actual Electron UI/public bridge, persisted files and existing pause controls. No fake failure, unlink, authority or model behavior supplies the outcome.

Independent reports `Temp/companion-ticket13-manual-ledger-fix-review.md` and `Temp/companion-ticket13-manual-spec-rereview.md` approve the exact bounded tree and close P1/P2. Final 144-case discovery/run, final-tip reviews and assigned merger approval remain required. No GUI run is active at this checkpoint. Live sign-in/model/managed-home work remains deferred, readiness closed, hosted Actions billing unverified, and deployment unauthorized.
