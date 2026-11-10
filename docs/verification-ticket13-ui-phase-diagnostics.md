# Ticket 13 UI phase diagnostics

Temporary test-only observers cover exactly these existing cases:

- `fresh staged-title authority rejects unowned-sidecars after an actual first unlink`
- `external writing survives restart and transfers to an annotation before incoming source applies`

Enable with `COMPANION_UI_PHASE_DIAGNOSTICS=1`. The flag does not select tests. Root must discover and run the two exact cases serially. Static exact-name filter count: **2**. The author ran syntax checks only; root owns runtime execution.

Use an unanchored case-name filter: Playwright includes filename prefixes in the matched title. Timeline elapsed time starts at observer creation: repair excludes `beforeEach`, and restoration excludes setup and preview. `estimatedRemainingFromObserverMs` subtracts only this observed elapsed time from the configured budget; it is an upper estimate, not the actual framework deadline. `clockStart` records the wall/monotonic start and boundary.

No product files change. Original fixture actions, assertions, the pending-title 150s budget, the Source restored 5s expectation, repair's default 30s overall budget, and retry settings remain. Observers add work when enabled and can affect timing; their measurements do not reproduce an uninstrumented duration exactly.

Main events observe the actual `confirmRestoration`, restoration `Intake.finish`, conditional repair `resolveConflict`/`finishRepair`, proposed ledger replacements and the real vault instance checkpoint. Wrappers return the original promise and record its actual settlement without an extra filesystem read. The ledger event holds the proposed digest, phase, generation, revision and small synthetic counts. `Intake.load` attaches a checkpoint observer to the configured instance before repair work. Buffers retain the latest 256 events.

Renderer events observe refresh calls and caller stacks, real DOM click dispatch, status, restoration article removal, capture counts, repair-region replacements and focus/visibility events. The critical action snapshot records button bounds and connection/disabled state. No observer clicks, refreshes, focuses the window, replaces a callback result or triggers a checkpoint. Installation follows each actual restart; buffers are collected before the repair test closes its prior process.

The first diagnostic pair at tree `29391ab` failed in both observers, exit 1 after 41,092ms (`Temp/companion-ticket13-ui-phase-two-20261110`). Both reported `Missing renderer refresh seam`: restart installation ran before the original timezone readiness assertion. These are observer failures, with partial events retained; they establish no original failure cause. Both launch helpers now install observers after that existing readiness assertion. This correction adds no wait, focus action or budget change.

The corrected pair at tree `4f2b280` passed both cases in 40,567ms (`Temp/companion-ticket13-ui-phase-ready-two-20261110`). Restoration backend took about 171ms, repair about 146ms, with no competing refresh during their critical click intervals. Click requests preceded trusted dispatch by roughly two seconds. These are diagnostic passes; neither historical failure was reproduced or explained.

An empty, unconfigured hidden-window ABA probe measured about 16ms between frames with native background throttling true, false, then true (`Temp/companion-hidden-frame-cadence-20261110.json`). This negative control does not justify a harness or product correction. It did not include either real form.

## Controlled actual-form rendering comparison

Root ran A with `COMPANION_UI_PHASE_DIAGNOSTICS=1` and no render-control override, then B separately with that flag plus `COMPANION_UI_RENDER_CONTROL=unthrottled`. B changes only the single owned disposable window's native background-throttling policy after its existing readiness marker. The native policy is untouched in baseline A. Normal process close removes condition B with its owned window. These are controlled experiments, not verification gates or retries.

Each install records native visibility, focus, window/web-contents identities and background-throttling policy before and after control selection. The artifact records `renderControl`. Each existing critical action snapshot schedules exactly five passive `requestAnimationFrame` callbacks. It returns immediately without awaiting frames. Samples retain request/actual times and deltas, the original critical button's bounds/connection state and center hit-target tag/id/match flags. There is no added UI wait, focus action, click, timer change or completion criterion. All frame events share the existing latest-256 buffer; a close or blocked frame may leave fewer than five observations.

Both actual-form pairs passed at the same tree `001a0d7`: baseline A in 42,819ms and unthrottled B in 43,301ms. Raw evidence is in `Temp/companion-ticket13-ui-control-a-two-20261110` and `Temp/companion-ticket13-ui-control-b-two-20261110`. Both retained the original actions, assertions and budgets. At both critical controls, passive frame samples were about 1,000ms apart and native visibility was false. B verified background throttling false, yet measured cadence remained about 1Hz. The setter did not discriminate this measured pacing and is not a demonstrated correction. The empty-window 16ms probe was not representative of these real form phases. No source fix or historical latency cause is established.

Installed Electron 45 types declare the native visibility/focus and background-throttling methods used here. The official [BrowserWindow documentation](https://www.electronjs.org/docs/latest/api/browser-window) describes window visibility, and the official [webContents documentation](https://www.electronjs.org/docs/latest/api/web-contents) describes `getBackgroundThrottling` and `setBackgroundThrottling`. These describe APIs and policy; they do not prove the cadence measured in a particular fixture. The passive frame timestamps are the cadence evidence.

Native-visibility condition C uses `COMPANION_UI_PHASE_DIAGNOSTICS=1` and `COMPANION_UI_RENDER_CONTROL=visible-unthrottled`. It uses the same owned-window background-throttling policy as B, then calls that window's `showInactive()`. This may briefly display the disposable fixture window without requesting focus. Installation records visibility and focus before and after, alongside the existing native identities and policy. Baseline and B behavior remain unchanged. No focus call, timer change, source change or original test action/assertion/budget change accompanies C; window visibility is the explicit controlled difference from B.

C passed both cases, exit 0 in 20,432ms, at tree `101bcdd4e98d3256681f194651f152b5cff2c2d2` (`Temp/companion-ticket13-ui-control-c-two-20261110`). Independent analysis in `Temp/companion-ui-phase13-frame-ab-analysis-20261110.md` compares the actual samples:

| Control | Native visible / focused / background throttling | Critical frame intervals: restoration / repair | Confirm / Apply request to trusted dispatch | Runner wall time |
| --- | --- | --- | --- | --- |
| A baseline | false / false / true | about 1,000ms / 1,016ms | 1,977ms / 2,022ms | 42,819ms; both passed |
| B setter only | false / false / false | about 1,000ms / 1,016ms | 1,984ms / 2,002ms | 43,301ms; both passed |
| C B policy plus `showInactive()` | true / false / false | 14.8–18.4ms / 16.1–16.8ms | 71ms / 41ms | 20,432ms; both passed |

Playwright API logs place about two seconds in the combined visible/enabled/stable check for A/B and 27ms for C, with no logged critical retry or obstruction. Local Playwright implementation checks stable bounding rectangles through animation frames. Together these observations demonstrate hidden-fixture actionability overhead in these samples. They do not establish the original post-click Source restored 5s failure: the measured pre-dispatch delay precedes that assertion. C also retains B's false policy, so visible-with-default-policy behavior was not tested. These sequential samples are controlled observations, not statistical benchmarks.

Repair samples retained a connected/enabled button with matching center hit and unchanged sampled bounds. Restoration A/B center hits were offscreen before successful scrolling; C's passive restoration button sample was empty, so no equivalent hit comparison is available. No sampled hit flag proves the failed historical run's state. Original repair timing was not captured; cumulative actionability overhead is a plausible contributor to its overall 30s timeout, not a proven historical cause.

The verified A/B diagnostic source and report were committed at `fb2dd047205d6adb71df5bff8c27ea42c6e41a51` before adding C. Only the shared helper and this report changed for C; both test specs remain byte-identical. Installed Electron 45 types declare `showInactive`; the official BrowserWindow documentation describes the API, not its measured effect in this experiment. No final harness strategy or production correction is selected. Both original full-gate failures remain unresolved.

The pending-title assertion catch retains and rethrows the same original error after an evidence-only tail. Repair's overall timeout is retained, with its tail in `afterEach` before close under the unchanged teardown budget. A tail waits six seconds and reserves four seconds for two individually bounded buffer reads; it never retries an assertion or cancelled click. Later observations are labeled separately.

`ticket13-ui-phase-diagnostics.json` is written through `testInfo.outputPath` before fixture cleanup. It contains original status/errors, the action timeline, process buffers, and only the known synthetic ledger/fault/checkpoint/repair-intent digest or phase summaries. There is no whole app-data or managed-home read/copy. Each buffer read is bounded to two seconds; unavailable processes are recorded as collection errors. The original fixture cleanup remains active.

Acceptance is diagnostic evidence that distinguishes pre-dispatch budget consumption, backend progress, and post-backend refresh progress. A passing instrumented case establishes no historical cause or correction. The full gate remains failed (160 passed, 2 failed, 0 skipped); issue 13 is open and issue 16 remains blocked.

Static checks: `node --check` passed for both edited specs and the shared helper. Root owns runtime discovery, serial execution, independent review, Git, and final disposition. Remove this temporary instrumentation separately after diagnosis.
