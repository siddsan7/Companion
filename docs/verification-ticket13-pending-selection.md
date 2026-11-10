# Ticket 13: deferred reviewed selection deletion

## Bounded behavior

A reviewed Make current action can fail at the native current-to-backup rename. The existing writer retains a pending selection. Normal startup does not retry it. Deletion now reviews that exact deferred family without completing its prospective history transition.

The SourceInventory change binds the exact pending journal, key, reason and held outcome. It retains the existing A/B admissions, generation, current rendering, history and known-peer checks. The snapshot stage must exist; the capture stage and backup must be absent at this measured boundary. The archived conflict branch is unchanged. No new owner, authority format, retry path or acceptance is added.

## Measured evidence

| Check | Result | Duration | Evidence directory in Temp |
| --- | --- | --- | --- |
| Native deferred selection before the fix | Feature RED, exit 1 | 20,476 ms | companion-ticket13-pending-selection-first-20261110 |
| Same test after the source change | Passed, exit 0 | 22,610 ms | companion-ticket13-pending-selection-green-20261110 |
| Contradictory prospective history | Passed HOLD check, exit 0 | 16,463 ms | companion-ticket13-pending-selection-history-guard-20261110 |
| Restored generation and first-unlink recovery | Passed, exit 0 | 33,902 ms | companion-ticket13-pending-selection-g-survivor-20261110 |

All four runs had no skips on Windows. The first RED reached the normal deletion preview after all native and five-file setup checks passed; the preview remained hidden with a source-inventory HOLD. Later assertions were not reached in that failed run. Test commit 4d90c05 preserves the RED; b7da682 adds the source change. e293804 and 4149df0 add the two guards.

The hidden test-owned PowerShell child opened only the disposable current note with FileAccess.Read and FileShare.Read. The original native rename returned EBUSY. Readiness, PID, release and exit 0 were recorded; no rename error was injected. The handle was released before normal restart. The actual family had five files: current A, A/B snapshots, the B snapshot-stage peer and the pending selection journal. No missing capture stage or backup was fabricated.

The positive run verified exact raw/rendered preview, unchanged Cancel, complete purge, immutable admissions and producer files, suppression and restart without committing the selection. The history guard changed only the actual journal's last prospective selected revision from B to known A, then verified HOLD and exact file/ledger preservation.

The survivor run deliberately deleted and restored A to obtain fresh G before B. It observed the real first snapshot-stage unlink and the B peer count falling from two to one. Four exact files survived with deleting H distinct from G. After actual main/wrapper exit, normal recovery completed only the committed scope. Seed history, both admissions, producer bytes and the unfinished selection remained unchanged. No extra source omissions were used.

## Current synchronization

The helper is staged with current primary 8228093. The product delta remains only the narrow SourceInventory selection change. Primary's capture-ID title validation, verified-current proof, pending-title exception, manual controls, annotation controls and source-copy guards remain. The original three test bodies and source change are unchanged after their individual passes.

The synchronized six-case gate passed all six tests with no skips in 133,444 ms (exit 0). It includes all three native cases plus completed selection, interrupted archived selection and its contradictory-history guard. Evidence is in Temp/companion-ticket13-pending-selection-composed-six-20261110: started.json, exit.json and run.stdout.log. The tested staged tree was dbdc2e5471a2354e672258d970508b562693f96d; this result paragraph is the only subsequent change. Final independent merger review remains required. This report does not claim full ticket 13 approval, a live provider check or release readiness. Full live sign-in remains deferred.
