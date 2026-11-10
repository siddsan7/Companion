# Ticket 13: persistent detached editor writing

Three focused cases have passed: deletion of the observed nine-file editor family, an outside hardlink HOLD, and deletion after restoring the original accepted draft. The independent P2 admission finding is closed for the exact correction committed as `c2d27ff`. These results establish bounded behavior. They do not establish a passing final composition, completion of ticket 13, or release readiness.

## Behavior and authority

The tests use the real importer and rendered deletion controls. After importing draft A, they stage same-source B and introduce a controlled outside alias to B's stage. The actual conflict writer restores the current capture C and backup P as a hardlink pair. After closing the app, the tests remove only that controlled alias. They restart at the existing `intake-restored-backup-publish` checkpoint and replace P externally with the complete editor buffer E. The real writer renames E to retained file R and writes hold archive H. H contains the literal intent bytes and ordered evidence for R and source copy S. A normal restart preserves this hold and exposes Delete capture. No repair annotation X is created.

The verified source family contains nine files: C, A's snapshot, B's snapshot and snapshot-stage pair, B's capture stage, original conflict journal J, S, R, and H. Only B's known pair shares an inode and has two links. Other origins are independent single-link files. Evidence records every buffer, SHA-256, device/inode/size/link count, ordinary-file status, producer files, ledger facts and rendered UI before family counts or preview assertions. B remains unadmitted.

Deletion reviews all nine paths and one new visible annotation V titled “Retained whole local version.” V preserves all E contiguously, including its source quotation, eight-backtick stress case and Unicode. The preview discloses the quotations and concrete destination. Cancel leaves every byte and physical identity unchanged and creates nothing. A fresh preview supplies its own destination.

A native filesystem observer pauses before the first source unlink. At that boundary, all nine origins still exist and the one output has durable stage/publication receipts. The tests verify V's exact E payload, fence length, output hash and original source generation, or genuine legacy absence. They then require complete source purge, unavailable-evidence disclosure, unchanged producer/admission facts, suppression and restart. The observer is test instrumentation; it creates no product checkpoint or authority.

The outside-alias case pauses public confirmation after authority is committed and before publication. It links actual R to one controlled path outside the vault. R and that alias must have identical bytes and inode with link count two. Initial continuation, normal restart and public recovery/resume must HOLD without a stage, output, source unlink or alias adoption. The vault, raw ledger, operation, plans, outside alias and producers remain exact. The only allowed cleanup is removal of the exact observed `current.lock` owned by that main process.

The restored-A case publicly deletes and restores the same original producer before creating B and the editor hold. It proves that restoration creates a fresh revision, snapshot admission and generation G while the original accepted attempt remains unchanged. V and the origin proof retain G; deletion gets a different generation. Check now updates the two producer-locator outcomes and preserves the separate historical restoration outcome.

## Measured runs

Durations below come from `exit.json`, not Playwright's rounded display. Every executed row selected and ran one test with no skips. All evidence directories are under `C:/Users/sidds/AppData/Local/Temp/`; they contain the run records, stdout/stderr and copied test results. Trees identify the tested files, not a later documentation commit.

| Case | Result | Duration | Tested tree | Evidence directory |
| --- | --- | ---: | --- | --- |
| First nine-file family | Feature RED; exit 1 | 15,910 ms | `1a7dc8cd98a26ee27f5247ac4f766eb5f1aabafa` | `companion-ticket13-detached-editor-first-20261110` |
| First source candidate | Fixture failure; exit 1 | 13,334 ms | `b6d2ebca223c6c3e50815c190390f590edcac6ca` | `companion-ticket13-detached-editor-candidate-20261110` |
| Corrected native observer | Fixture completion failure; exit 1 | 18,524 ms | `db9e3b11576b6b4b196409ce2bb8ac8adb7b511a` | `companion-ticket13-detached-editor-observer-corrected-20261110` |
| Complete first journey | PASS; exit 0 | 19,211 ms | `f703d300f10016b2fd31da290aca06127adbd2af` | `companion-ticket13-detached-editor-completion-20261110` |
| Outside R alias | PASS; exit 0 | 16,186 ms | `97bcba2d038c39ae0d27372b2ccb09e0295381f9` | `companion-ticket13-detached-editor-outside-alias-20261110` |
| Restored A before correction | Feature RED; exit 1 | 26,319 ms | `4237f2a792c36305310cfb56d24c223e4ea62906` | `companion-ticket13-detached-editor-restored-a-red-v2-20261110` |
| First corrected restored A | Fixture readiness failure; exit 1 | 19,393 ms | `187d20c382b657786a7417a96988c84bff3ecde6` | `companion-ticket13-detached-editor-restored-a-green-20261110` |
| Restored A with completion waits | PASS; exit 0 | 29,248 ms | `2009d0db5b1e96236fb23f5c6e9cdead306255b1` | `companion-ticket13-detached-editor-restored-a-green-v2-20261110` |

Both feature REDs reached and verified the real persistent family before the preview stayed hidden. The saved status was “Source recovery inventory contains changed or unsupported writing. Preserve it for explicit review.” The first RED occurred on source baseline `3a908db`, before the new family was supported. The restored-A RED independently reproduced the P2 admission overconstraint. Neither run reached its publication or purge assertions.

The 13,334 ms failure was test instrumentation: evaluated Electron main code had no CommonJS `require`. Test-only commit `a84ac6d` switched to `process.getBuiltinModule('fs').promises`. The 18,524 ms run passed preview, Cancel, receipt-before-unlink and purge, then observed a live ledger temporary file before asynchronous repair/support work finished. Initial explanations about changed outcomes or a stale timestamp were incorrect; the recorded timestamps were distinct. The correction waited for the final intake action status and existing “Current support inspected.” status. It did not filter temporary files, remove assertions, increase timeouts or change product code. The 19,211 ms pass used the same product files as candidate `b6d2ebca`.

The first restored-A command used an anchored grep that matched zero filename-prefixed Playwright titles. It launched no desktop test and established no feature RED. Its evidence pointer is `companion-ticket13-detached-editor-restored-a-red-20261110`; no execution duration/tree record is claimed for that discovery attempt. Removing only the anchor selected the unchanged regression.

The 19,393 ms corrected-source run also caught a live ledger temporary file, this time before preview. Visible Delete capture preceded the saved-idea support inspection's completion. Test-only commit `056da41` added exactly three waits for the existing completion status before persistent-family snapshots. Product code, source assertions, timeouts and file accounting were unchanged. The 29,248 ms pass then reached the complete restored-A journey.

## Source and review disposition

`source-inventory.js` exposes only the bounded `inventoryDetachedEditor` entry for this family. Its private proof validates canonical C/A/S, compact J/H and embedded intent, exact paths/identities, ordered evidence, original admission, immutable acceptance, actual generic draft outcome and connected producer key. It never reads a producer locator. The ordinary inventory scan reobserves S/R/H hashes and physical identities before accounting for those exact roles. Existing transaction, normalized-draft, layout and known-pair checks remain shared.

`mixed-deletion.js` dispatches strict formats: the existing five-target/two-plan kept-current family and the new nine-target/one-plan detached-editor family. Both use the same publication loop, raw ledger baseline, bound parents, stage-before-link receipts, verify-only outputs, permanent annotation-removal fences and historical publication-owner rules. Authority contains identities/hashes/roles, not E or intent bodies. Shared P1 peer inspection remains in every mixed inspection. Recovery can inspect survivors and retire exact pointers after source payloads are gone.

The independent P2 review approved removing only the original attempt's equality checks against the fresh admitted revision and snapshot. The current admission still binds the fresh revision/snapshot/G. The original attempt still binds imported status, identity, fingerprint, source and capture, plus its complete committed acceptance digest. No producer fact was rewritten and no normalized-draft or schema rule was relaxed. The approved final correction tree was `12b774bacf47add4a636def18b0b337e43695c58`; its app/tests match passing tree `2009d0d`. Review records are `companion-detached-editor13-source-audit.md` and `companion-detached-editor13-restored-a-fix-review.md` under the same Temp directory.

The old-format malformed-title-proof defect has a separate fix, `b83700c`. Its preserving schema/lifecycle branch `54bdbb0a9348b926b5014a4192a7a79fbc77158c` still needs integration here. This is a pending composition step, not an unresolved restored-A P2. Preserve explicit rejection of `titleProofs`/`titleRecovery` in both mixed formats.

Root must then synchronize primary `e819d85ccc65be91f86c54c666960b60ce941421` and current root integration (`96fbec9`), preserving ancestry. Resolve the coupled inventory/title/current/pending seams explicitly: retain id-aware title validation, `verifiedCurrent`, the exact pending exception, known peers and the shared publication kernel. The planned frozen ticket gate is 141 cases; it has not been run on this final composition. Fresh Standards, Spec and independent merger reviews remain required. The committed root plan is `.brain/plan-ticket13-final-composition.md`; its detailed gate plan is `C:/Users/sidds/AppData/Local/Temp/companion-ticket13-final-composition-gate-plan.md`.

The three focused cases can be selected with:

```powershell
npx playwright test tests/detached-editor-deletion.spec.js --workers=1 --reporter=list
npx playwright test tests/detached-editor-deletion.spec.js --grep "outside alias" --workers=1 --reporter=list
npx playwright test tests/detached-editor-deletion.spec.js --grep "restored draft A retains detached editor writing" --workers=1 --reporter=list
```

The full file contains three cases; each grep selects one. Source/test syntax checks passed during their respective changes. This report rewrite ran no tests, source changes, Git actions or network calls. No whole-repository, ticket 16, live sign-in/inference, deployment or release result is claimed.
