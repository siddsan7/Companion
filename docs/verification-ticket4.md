# Ticket #4 human review imports

Base: reviewed integration `2c27097`. The approved acceptance boundary is the Electron desktop workflow plus resulting vault Markdown and immutable revision history. Scope is finalized review admission, separate processing/extraction/review judgments, reviewed precedence, rejection, explicit current choices and changed-byte associations.

## Contract

- Finalizations require ordinary contained files, declared SHA256 integrity, a stable second read, Python-compatible source digest, supported identity/classification, complete human labels, recomputed scores and exports matching the selected accepted/edited target. Original producer paths are retained as provenance and never opened.
- Rejections retain findings and original source metadata even when the original target and reviewed Markdown are absent. Their snapshots and current captures have `supportEligible: false`. Extraction may be unknown while processing failed and human review rejected.
- Later drafts and competing finalized reviews are retained as immutable revisions. A reviewed current note stays unchanged. Competing reviewed revisions pause capture eligibility until an explicit choice; producer timestamps do not establish succession.
- Current selection journals publication of the exact existing snapshot, with unique recovery backups. User-selected changed-byte links record associations; they preserve both captures, notes, hashes and histories.
- Connections use canonical folder plus source kind, so one mixed producer root can supply drafts and reviews. Old connections without a kind remain drafts.
- Source parsing bounds text to 16 MiB, nesting to 64 and numeric tokens to 4,300 characters. Individual declared assets are limited to 100 MiB and each bundle read pass to 256 MiB. Unsafe integers in trusted review semantics are held; original numeric tokens remain available for canonical digest verification.

## Executed evidence

Root ran GUI checks. The worker ran syntax and whitespace checks only. Each implementation followed a desktop/file RED:

| Slice | Actual RED | Confirmed full GREEN |
| --- | --- | --- |
| Portable acceptance | Missing finalized-review control; actual Electron numeric reviver passed first | 1 test, 9.1s |
| Edit and later draft | Only one snapshot retained | 2 tests, 20.3s |
| Competing reviews | Current note changed automatically | 3 tests, 35.6s |
| Rejection without target | Missing public eligibility summary | 4 tests, 47.4s |
| Changed-byte association | Missing explicit link control | 5 tests, 1.1m |
| Invalid review guards | Four snapshots admitted where only one was valid | 6 tests, 1.2m |
| Shared producer root | Review connection lost behind existing draft connection | 7 tests, 1.3m |
| Choice crash and later successor | Crash recovery, exact snapshots and durable choice passed; the next choice set omitted current | 8 tests, 1.6m |

The acceptance helper advances controlled time and waits for the new visible completed Last check, avoiding stale status-text races. Early harness corrections and the DOM status-variable shadow were fixed without weakening assertions.

Producer `initialize`, `finalize` and `load_finalized` independently generated/validated authored synthetic accept, edit, reject and missing-target reject fixtures. A separate producer-backed script classified 14 malformed/unsupported cases, explicitly distinguishing consumer admission gaps from producer rejection. The desktop guard also covers malformed JSON without source-fragment diagnostics and invalid UTF-8. Guarded cases include legacy classification/metadata, pending findings, source digest, score/export/asset/path integrity, rejected evidence semantics, clip identity, unsafe integers and date-only source time.

Actual Electron `JSON.parse` numeric reviver support passed. The canonical fixture exercises Unicode key ordering/escaping, int versus float tokens, signed zero, exponent thresholds, subnormal floats and large integers. Prior independent research compared the float algorithm against 174,359 Python oracle cases with zero mismatches; that is empirical evidence, not an exhaustive proof or a new full-module oracle run.

The independent interim reviewer identified missing processing display and permissive review timestamps. Both fixes and desktop regressions are included. Exact synchronized-tip review remains required.

## Remaining gates and handoff

- Final scoped review suite: **8 passed in 1.6 minutes**. Synchronize latest integration `846e608`, then run combined capture/intake/brief/Codex regressions and required checks. Preserve the draft fixture LF rule and the more specific finalized fixture `-text` rule: finalized manifests hash exact Windows producer bytes.
- Obtain fresh independent approval of the exact synchronized candidate before merge. No worker commit, merge, push, deployment or producer mutation occurred.
- Natural finalized-review handoff: **skipped**. Prior producer inspection found no genuine finalized review bundle. Synthetic producer-library fixtures establish mechanics only. Full real producer/conversation/saved-proposal, Obsidian, scheduler and signed-in isolated Codex release gates remain separate; the sign-in deferral stays in force.
- Downstream discovery/context must honor capture eligibility/ambiguity and rejected snapshot eligibility. Links do not confer approval or merge identities. Exact original source JSON can contain private provenance/raw response; it is retained for inspection/integrity, not automatically selected as outgoing context.
