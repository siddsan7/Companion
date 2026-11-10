# Ticket 13: kept-current mixed retention verification

The bounded kept-current repair flow and its material guards have passed. The schema correction has independent approval. The lifecycle test passed without a product change. Primary/editor composition with the 141-case gate, final Standards/Spec review, and final merge remain open. This report does not claim ticket completion or live readiness.

Earlier “pending,” “syntax only,” and “not authored” statements are superseded by the measured results below. All failed runs remain part of the record. Source failures and test-observer failures are distinguished explicitly.

## Scope and measured behavior

The fixture uses the real finalized-review importer, public transfer and deletion UI, persisted vault files, existing fault/checkpoint controls, and actual Electron main/wrapper exits. It imports accepted A, appends whole local version Y, then imports distinct same-source B into a conflict. Transfer proposes different annotation X. The real writer publishes a repair intent; after actual main exit, restart with `kept-current-read` EACCES archives the held repair before annotation publication. Removing the fault does not replay transfer or reconcile intake before deletion review.

The five actual ordinary, single-link origins are current Y, A's snapshot, original B conflict, B/R resolution conflict, and R repair. Evidence records raw buffers, paths, SHA-256, device/inode/size/link count, producer bytes, admission facts and process exits before family-count and feature assertions. A remains admitted; B has no admission or snapshot. Unexpected or missing leaves fail fixture verification.

The implementation preserves exact X at original annotation R and complete Y inside a separate visible annotation V titled `Retained whole local version`. Preview shows both complete variants, concrete IDs/paths, all five origins and the source-quotation disclosure. Cancel preserves vault/ledger bytes. The original journey checks contiguous Y, including its source text/frontmatter and six-backtick stress case, a longer safe fence, complete purge, truthful suppression outcomes, immutable producer/admission facts, and output persistence across restart.

The first journey observes both receipts immediately after the first actual source unlink. Its original ordering limitation remains explicit: that observation alone does not prove the pre-unlink barrier. The later native observer measures both receipts and absent stages before any source unlink is delegated.

## Publication and authority contract

`mixedRecovery` proves the exact five-origin writer relation. Two `preservedWriting` plans bind fixed payload roles, payload/output hashes and sizes, output IDs/paths, creation time, source link, original generation and immutable publication owner. Three JSON origins use target kind `mixed-recovery`. Authority contains no payload bodies. Unknown fields, additional variants, unsupported title/selection/detach combinations and extra source copies HOLD. Other-capture repair records do not authorize selected-sidecar reads.

Preview chooses V, its timestamp and publication owner in memory; confirm reuses them during scope revalidation. Ordinary output/stage parents are bound before consent. Deletion commits suppression and both plans before staging. An exclusive flushed stage receives a durable identity before destination linking. The exact link pair receives a publication receipt before stage cleanup. Receipted output is verify only: disappearance, edits, replacement or extra aliases HOLD without recreation. Both outputs, receipts, parents, sources, unknown-copy checks, raw owned ledger baseline and annotation fences are checked before each source unlink and completion. Automatic continuation stays within Intake and does not acquire Conversation.

Completed receipts are historical metadata. Restoring/active plans must match exactly one deleted historical owner. Their original owner, stage paths and origin G do not change to the restoration operation/generation. Pure history validation does not read retained output files or apply live removal fences. The lifecycle test measures this distinction.

## Run ledger

All listed runs had no skips. Durations are exact launcher `durationMs` values from each `exit.json`; counts come from recorded stdout. Every evidence name below is a directory under `C:/Users/sidds/AppData/Local/Temp`, containing `exit.json`, `run.stdout.log` and per-test observations. A directory name containing “green” does not establish a pass; the result column is authoritative.

| Run | Result / exit | Duration (ms) | Tested tree | Evidence directory |
| --- | --- | ---: | --- | --- |
| First feature RED | 1 failed / 1 | 23,404 | `73e04491a0a19e69f43dc8cdeac695d0ba14da89` | `companion-ticket13-mixed-retention-first-20261110` |
| First product candidate; stale preview observer | 1 failed / 1 | 24,166 | `4f7738d664b1a3d075748fcbd836725cf5546632` | `companion-ticket13-mixed-retention-first-candidate-20261110` |
| Corrected preview; suppression observer | 1 failed / 1 | 29,937 | `60c6b2d33940b2dcb71f6d48b309294c5b6ff62b` | `companion-ticket13-mixed-retention-corrected-review-20261110` |
| Unsupported outcome-field observer | 1 failed / 1 | 27,130 | `45dbebc695f261335e5e2a141519b98594b78360` | `companion-ticket13-mixed-retention-suppression-20261110` |
| Complete first journey | 1 passed / 0 | 28,177 | `5c15e847736ad98ba0cd85da8280b57f77b22ea6` | `companion-ticket13-mixed-retention-end-to-end-20261110` |
| Destination collision | 1 passed / 0 | 12,045 | `226093a3b62e56e7d453f48882295cf9eea63c16` | `companion-ticket13-mixed-retention-collision-20261110` |
| Late adjacent-copy P1 RED | 1 failed / 1 | 17,628 | `a812f472295a08dba683130053ad3cbeb7b7d2ae` | `companion-ticket13-mixed-peer-red-20261110` |
| P1 fix; exact-lock observer failure | 1 failed / 1 | 15,068 | `33ac1cf2a20f3b3228e4747801426cb1e06c3141` | `companion-ticket13-mixed-peer-green-20261110` |
| Corrected P1 regression | 1 passed / 0 | 16,039 | `b2126c85bd59ffb10fe5f41c9e52f70362c5c57e` | `companion-ticket13-mixed-peer-corrected-20261110` |
| Happy path + P1 | 2 passed / 0 | 36,969 | `fc0b3266b2fe5c04eafd9189002d7e97e942ac38` | `companion-ticket13-mixed-peer-coupled-20261110` |
| Integrated happy/collision/P1 | 3 passed / 0 | 50,422 | `1bc8ad81c4399c860163ea92134fd260a7fd7d99` | `companion-ticket13-mixed-peer-integrated-three-20261110` |
| Restored-G setup; locator failure | 1 failed / 1 | 43,338 | `a9651b60bd5efe23e6e203bd7347415f9cfa3321` | `companion-ticket13-mixed-retention-link-before-receipt-20261110` |
| Restored-G real link before receipt | 1 passed / 0 | 31,637 | `1d11bdc3bff446911dd4438df91155f479ceae95` | `companion-ticket13-mixed-retention-link-before-receipt-v2-20261110` |
| Missing receipted output | 1 passed / 0 | 23,429 | `fa4b9fe7eb34a4fc8d80ba92a0b6f74a71ea741b` | `companion-ticket13-mixed-retention-missing-output-20261110` |
| Malformed proof-object RED | 1 failed / 1 | 16,373 | `62b6230df18cf12a3b05d2056994e378750ff671` | `companion-ticket13-mixed-proof-schema-red-20261110` |
| Unchanged schema regression after fix | 1 passed / 0 | 14,655 | `0893f930e6178e09d8a4a09a3d2e75fda6f12f9a` | `companion-ticket13-mixed-proof-schema-green-20261110` |
| Schema-fix coupled gate | 6 passed / 0 | 117,459 | `83e0f0168ea20eb8b2ab968b91630c941a929c03` | `companion-ticket13-mixed-schema-coupled-six-20261110` |
| Completed-retention lifecycle | 1 passed / 0 | 38,127 | `f336d0f7074447c36e1ab13d7d1bc4e75c16a2f6` | `companion-ticket13-mixed-lifecycle-20261110` |

## Failures and corrections

The first feature RED ran on base `e527b9cb4f7e58aa1f08042bdc53431916e03045`. Actual five-origin, distinct-inode, A-only admission, B-unadmitted, X/Y/transaction and process-exit assertions passed. Preview visibility failed at line 124. The final status was “Capture deletion files changed or contain unreviewed writing. Preserve them and preview the scope again.” The immediate click observation was empty because the response had not settled. No positive preview, Cancel, publication or purge assertion had been reached. This was a feature gap after a verified writer fixture, not a fixture failure or authorization to weaken ordinary current-hash checks. Root then authorized the bounded implementation; test-first milestone `a3aabf3` is preserved.

Three observer failures followed on unchanged candidate product source:

| Failure | What had already passed | Correction and scope |
| --- | --- | --- |
| Stale V path after Cancel | Complete X/Y/five-origin preview, exact Cancel, confirm, first actual unlink; both files and both receipts existed | `cb2fb13` waits for the fresh visible review before reading paths. The hidden old DOM had supplied canceled V. No source publication was missing; no product/assertion/timeout change. |
| Expected `complete`, actual `held` after Check now | Both outputs, safe fence, all-origin purge, deleted phase, suppression, immutable facts and no recovery remnants | `dfb9020` requires existing suppression behavior: exactly two original producer locators, `held`, exact reason and current `checkedAt`. Root reassessed after two observer failures; no product fallback, retry or timeout change. |
| Added `outcome.sourceHash` assertion | All physical checks and truthful held classification | `fc55a3c` removes only that unsupported field assertion and saves post-suppression evidence. The ordinary catch writer stores status/reason/locator/checkedAt. Ledger source binding and all count/locator/reason/time checks remain. |

The first full journey passed after those test-only corrections. Its product source matched the first candidate tree `4f7738d`; feature commit `be5e7f004cf09f5d9d0852bc0890e26189896471` preserves that implementation. The collision guard also passed on unchanged product. It creates actual R's destination with X plus unique third writing, then requires collision HOLD, hidden preview, no authority/suppression/purge, and exact vault/ledger/physical/producer preservation. It does not independently measure an unknown same-byte stage with a different inode.

The independent late adjacent-copy P1 was a separate real defect: a new pending copy of actual Y added after consent survived while deletion completed. The two-line fix exports existing `inspectManualPeers` and invokes it inside each live mixed inspection before publication/mutation. The first fixed run held correctly but failed a full-tree assertion because confirm legitimately released its exact owned current lock. The correction binds that ordinary single-link JSON lock to actual main PID and permits only its removal; all other entries remain exact. The corrected regression, two-case gate and integrated three-case gate passed. Independent non-author review approved helper `c40ecc831cb59611378ac816130a88c096c77aed` and preserving merge `4d5f2961bf3de1984c26d32c50c32d172cec57a6` (committed tree `5a62c923102aee8bb6378dda7e9b01d1e223b798`). See Temp `companion-mixed13-peer-final-review.md`. The title-transaction suffix was code-inspected in that review, not independently exercised by this peer test.

The first restored-G attempt failed before restoration/held-family setup: exact `getByLabel` did not match the select's wrapping accessible name, which includes option text. Root used the already tested combobox role with the artifact-kind name prefix. No assertion, timeout, retry or product source changed; that failed run proves no G or crash behavior.

## Crash, verify-only, schema and lifecycle evidence

The corrected restored-G test first deletes and explicitly restores accepted A through public controls. It records fresh G and an additive admission while original producer acceptance stays literal. A native `fs.promises.link` observer durably records stage identity and absent publication receipt before delegating the actual first annotation link. It records the resulting same-inode two-link pair and all five unchanged origins, then holds its return before receipt advancement. Actual main/wrapper exit follows. Normal restart completes both receipts, keeps the observed linked inode, purges all origins, preserves original G distinct from deleting H, leaves X exact with its original absent generation header, gives V original G, and preserves history/admissions/producers. Commit: `4a218271ca794a4a22c279a4a9036ab109029df7`; product remained unchanged from `4d5f296`.

The missing-output test pauses the exact first source unlink before delegation. Its native observation proves both durable receipts, both outputs, absent stages and all five origins. It is labeled `before-native-unlink`, not an actual source unlink. After actual main/wrapper exit, only receipted X is removed offline. Normal startup, public recovery and explicit Resume HOLD with the same authority, all five origins, Y and producer facts intact; X is not recreated despite surviving repair X. Full-tree comparison permits only cleanup of the exact lock owned by the exited main. Commit: `63e64d6b07ea283ac3fc996a7db4314fa5f0aefd`; product remained unchanged from `4a21827`.

The detached-editor interface audit identified that `titleProofs?.length` accepted malformed objects/null. The schema regression pauses a real authorized deletion before outputs, records main exit, and adds only `titleProofs = { unreviewedSourceCopy: actualWholeY }` offline. It saves actual terminal evidence before feature assertions. The RED reached deleted phase, purged all five origins and published both outputs while the nested source body remained in authority; the expected deleting assertion failed at line 558. Later preservation checks were not reached. Test-first commit: `fdf6c85640ed1017fe3b19f70df54509fa3b0bd7`.

The separate one-line fix rejects own `titleProofs` or `titleRecovery` properties in this canonical mixed format. It does not strip fields, repair scope, reconstruct payloads, rewrite history or broaden classification. Syntax passed. The unchanged regression then held with exact corrupted ledger, all five origins/producers and no outputs/stages. The six-case gate also passed. Independent review approved `b83700c5414fe892bf57d2163df9ab63606a5114`, committed tree `03de08cc4d95b426454fb1e62ca2e64a7cb23adc`; app/test bytes match both tested fix trees. See Temp `companion-mixed13-schema-final-review.md` and the originating `companion-detached-editor13-base-interface-audit.md`. This is bounded schema approval, not final composition approval.

The lifecycle test passed on product unchanged from `b83700c`. It completes deletion with original G, publicly removes exact R, restarts, loads suppressed source state and explicitly restores original A as a fresh source generation. R stays absent; V's bytes/inode, historical descriptors/plans/receipts/publication owner/origin G and literal producer facts remain unchanged. Exactly one matching deleted entry is added to history; only the fresh restoration admission is additive, and B stays unadmitted.

Its final public pure-load control reaches the specific inherited-owner check. Both plan owners and derived stage paths change to one well-shaped UUID. The matching current B purge-observation owner changes with them so the earlier incoming-owner check cannot mask history validation. The active restoration operation and deleted history remain literal; reversing only those fields yields the exact valid ledger. `captureDeletion.suppressed` rejects at `inherited retention owner`, with no file mutation or R republication. No private validator is imported. Lifecycle milestone: `54bdbb0`; full lifecycle commit recorded by root after the 38,127 ms pass.

## Remaining integration work

Run the primary/editor composition's 141-case gate on its frozen candidate, complete independent Standards/Spec review of the composed diff, and obtain final merge approval. Preserve the separate P1 and schema-fix histories. These are the current pending steps; earlier planned collision, crash, missing-output, schema and lifecycle guards above are measured.

Live sign-in and inference were deferred and are not claimed. This bounded family does not establish arbitrary mixed-family support, changed-consent rescoping, arbitrary external-copy inventory, release approval or full ticket-13 readiness.

For local reproduction with the project's existing dependencies:

```powershell
npx playwright test tests/mixed-retention-deletion.spec.js tests/mixed-peer-deletion.spec.js --workers=1 --reporter=list
```

The six-case coupled run preceded lifecycle addition. The lifecycle pass is separately recorded; this command is a reproduction target, not a claim that the now-expanded set has already run together.
