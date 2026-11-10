# Ticket 13 gate failure diagnostics

Status: diagnostic patch authored; runtime trace and product correction pending.

The frozen 141-case candidate has recorded failures in restored imported citations and external ledger replacement after a confirmed unlink. The full run is root-owned; this note does not infer its final outcome.

Only those two existing tests install a temporary main-process observer. Original actions, assertions, timeouts and retries remain unchanged. It records real inventory results and their first selected/fresh difference, original error stacks, existing ledger read identities/digests, ledger write callers and authority phases. A synchronous ledger snapshot occurs only after the original confirmation error. Active-path observation adds no filesystem calls; wrapper overhead can still affect a race. Each wrapper returns the original result or rethrows the original error object.

Before fixture cleanup, each test writes its trace to its Playwright output directory. The external-replacement test also saves literal expected foreign bytes and observed after-test bytes separately. The after-test bytes and after-error snapshot are not atomic observations at the failing guard. Root added opt-in failed-fixture retention: COMPANION_KEEP_FAILED_FIXTURE=1 preserves only an unexpectedly failed disposable fixture after closing the app, with its exact path in preserved-fixture.json. Root will scope that flag to the two-case diagnostic run and restore the environment afterward. This permits inspection if the original guard identifies an unknown leaf; ordinary runs keep existing cleanup.

After the 141-case run ends, root will run exactly these two existing cases once with one worker and zero retries, using the validated project environment. Exact grep expression:

```text
restored imported citations bind the fresh admitted revision and preserve unavailable earlier citations without substitution|intake authority never overwrites an external ledger replacement after a confirmed unlink
```

Acceptance: retain original assertions, obtain the original failing guard stack and phase, preserve selected/fresh inventory evidence, and record foreign-byte equality separately. Case 49 cause is unproved. Case 75 preservation passed in the original run, but its specific diagnostic and subsequent recovery assertions still require execution. No product fix is justified by this patch alone. A passing instrumented run cannot establish that the original race is absent.

Static checks: `node --check tests/deletion.spec.js` passed; static title matching finds two existing cases; no trailing whitespace found in the edited test file. Static title matching does not prove Playwright discovery: its full titles include filename prefixes, so the grep union is unanchored. Root must verify exactly two cases with actual `--list` discovery before execution; that discovery has not been run for this patch. Runtime tests: not run by this diagnostic author. Source files: unchanged.

Actual first diagnostic pair: one passed, one failed; exit 1 in 93,875 ms at staged tree 498b6eb8decdf6227d27ff1a2888b7c29386142f. Evidence: Temp/companion-ticket13-gate-diagnostics-two-20261110. Restored imported citations passed under instrumentation with equal selected/fresh scopes and no confirm error; this does not resolve its intermittent full-gate failure. The ledger-replacement case reproduced the same status mismatch. Original stack identifies finishDeletion at app/capture-deletion.js:420, and exact expected/observed foreign bytes match. Authority remained deleting. Its actual failed fixture was retained at Temp/companion-deletion-IcAQ2f; preserve until the relevant correction is checked, then clean only this verified owned path. No product change has been made.

The completed full gate separately had 138 passed, 3 failed, no skips, exit 1 in 3,374,493 ms. The third failure is tests/intake.spec.js:315 after the last restart: Check now returned the existing already-running refusal. It had passed preserved editor/source evidence checks before that click. Cause classification remains pending; no retry or lock weakening is authorized.
