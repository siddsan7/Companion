# Revisit Replay Report

Status of this report: **model-free cells scored; gate cells not run.** It measures the feature in [Decision Ledger and Revisit Notices](decision-revisit-spec.md) using the method in [Revisit Replay Evaluation](revisit-replay-evaluation-spec.md).

Every number below is **on these authored fixtures only**. The fixture is small, synthetic and written by the same person who wrote the conditions, so it shows whether the mechanism behaves as designed on known cases. It does not establish accuracy on real decisions, it is not a statistical sample, and it is not comparable to PM-Bench or MemoProAgent scores (different task, scale and data).

## Run

| Item | Value |
| --- | --- |
| Fixture | `tests/fixtures/revisit-replay/fixture-v1.json`, version 1, sha256 `213f829b2186c63324af0f40d75e3260efc7dec1fe52550c8f7a9a7351418a54` |
| Fixture content | 12 true triggers, 12 near misses, 2 negative timelines, 8 timelines |
| Source commit | `2f82a386b6fce4af36a703718ae8547fba9b3096` |
| Model and settings | none: no model was called in this run |
| Gate | closed: production chat readiness has not passed (D46-I10) |
| Perfect-answer audit (D51-I04) | Set-F1 1.000 (12 / 0 / 0) |
| Raw outputs | `docs/evaluation/revisit-replay/fixture-v1-2f82a386b6fc.json` |
| Generated | 2026-11-21T10:01:09.772Z |

## D53 comparison

TP / FP / FN are summed over every step. Set-F1 = 2·TP / (2·TP + FP + FN). Each step compares the notices first raised in it with the notices that became due in it, so a correct notice counts once. A second notice for the same condition version and evidence counts as a false positive and as a repeat (D54-I05). No composite score or pass threshold is set (D54-I07).

| Cell | Status | Set-F1 | Precision | Recall | TP / FP / FN | Repeats | Update hit rate | Notes |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Retrieved evidence, notify on any match (document-search baseline) | passed | 0.400 | 33.3% | 50.0% | 6 / 12 / 6 | 2 | 33.3% | false-trigger rate 0.0% |
| Retrieved evidence, gate decides (proposed system) | **not run** | | | | | | | The automatic gate needs the signed-in Codex readiness gate, which is deferred (D56-I02). |
| Labelled evidence, notify on any match (upper bound for matching alone) | passed | 0.750 | 60.0% | 100.0% | 12 / 8 / 0 | 2 | 100.0% | false-trigger rate 0.0% |
| Labelled evidence, gate decides (gate measured alone) | **not run** | | | | | | | Needs a model judgment on labelled evidence; waits on the same readiness gate (D56-I02). |

The document-search baseline (D53-I02) searches every decision note on disk, all versions, for each new capture and notifies a decision when one paragraph shares at least two distinctive words with the capture. It has no conditions, versions, state, notice history or clock, so it cannot raise time-based notices. Its notices name a decision, not a condition, and match any due notice for that decision and evidence.

## D55 error attribution

### Document-search baseline

| Error label | Count |
| --- | --- |
| match false alarm | 4 |
| no clock in document search | 4 |
| no match | 2 |
| repeat | 2 |
| stale-state error | 6 |

### Labelled evidence, notify on any match

| Error label | Count |
| --- | --- |
| match false alarm | 4 |
| repeat | 2 |
| stale-state error | 2 |

### Proposed system: retrieval stage (model-free)

The proposed system's retrieval stage ran for real in this replay. A candidate is what retrieval hands to the gate. A due evidence notice with no candidate is a **retrieval miss**; no gate can recover it. A candidate on a near miss must be rejected by the gate. Candidates are counted on the same per-step basis; repeated text that retrieval marked as a duplicate is not sent to the gate and is not counted.

| Measure | Value |
| --- | --- |
| Due evidence notices with a candidate | 4 |
| Retrieval misses | 4 |
| Candidates on near misses or unrelated evidence (gate must reject) | 6 |

| Error label | Count |
| --- | --- |
| candidate on a near miss | 4 |
| retrieval miss | 4 |
| stale-state error | 2 |

### Proposed system: time-based notices (model-free)

Time-based conditions need no model and ran for real: Set-F1 1.000, TP / FP / FN 4 / 0 / 0, update hit rate 100.0%.

## D54 results by kind

### Document-search baseline

| Kind | TP | FP | FN |
| --- | --- | --- | --- |
| trigger:cue | 4 | 0 | 0 |
| trigger:paraphrase | 2 | 0 | 2 |
| trigger:time | 0 | 0 | 4 |
| near-miss:same-topic | 0 | 2 | 0 |
| near-miss:opposite | 0 | 2 | 0 |
| near-miss:superseded | 0 | 2 | 0 |
| near-miss:withdrawn | 0 | 2 | 0 |
| near-miss:deleted | 0 | 2 | 0 |
| near-miss:repeat | 0 | 2 | 0 |
| unrelated | 0 | 0 | 0 |

### Labelled evidence, notify on any match

| Kind | TP | FP | FN |
| --- | --- | --- | --- |
| trigger:cue | 4 | 0 | 0 |
| trigger:paraphrase | 4 | 0 | 0 |
| trigger:time | 4 | 0 | 0 |
| near-miss:same-topic | 0 | 2 | 0 |
| near-miss:opposite | 0 | 2 | 0 |
| near-miss:superseded | 0 | 2 | 0 |
| near-miss:withdrawn | 0 | 0 | 0 |
| near-miss:deleted | 0 | 0 | 0 |
| near-miss:repeat | 0 | 2 | 0 |
| unrelated | 0 | 0 | 0 |

### Proposed system: retrieval stage

| Kind | TP | FP | FN |
| --- | --- | --- | --- |
| trigger:cue | 4 | 0 | 0 |
| trigger:paraphrase | 0 | 0 | 4 |
| trigger:time | 0 | 0 | 0 |
| near-miss:same-topic | 0 | 2 | 0 |
| near-miss:opposite | 0 | 2 | 0 |
| near-miss:superseded | 0 | 2 | 0 |
| near-miss:withdrawn | 0 | 0 | 0 |
| near-miss:deleted | 0 | 0 | 0 |
| near-miss:repeat | 0 | 0 | 0 |
| unrelated | 0 | 0 | 0 |

## Not run

- **Proposed system** and **gate measured alone**: both need the automatic gate (D46, ADR 0007), which needs the signed-in Codex readiness gate. That check is deferred, so these cells are not run and no score is claimed for them (D56-I02). Running them needs approval for model usage (D56-I04).
- The same two cells measured with Claude models over the Anthropic API, a different setup from the production gate, are in the [gate evaluation report](revisit-gate-eval-report.md) (D58).
- Harness tests exercise the same scoring and attribution code with controlled gate replies. Those runs verify the code, not model judgment, and are not reported here (D56-I01).

## Limits

- Authored by one person, labelled before any scored run, and small: 12 true triggers and 12 near misses. Results describe behaviour on these fixtures only.
- Paraphrase triggers were written to share no cue terms with their condition. Retrieval misses on them measure the known weakness of lexical matching (D25); they are not a bug to be tuned away against this fixture (out of scope: tuning against frozen fixtures).
- A deleted near miss is captured and deleted within one step; a notice whose evidence was removed in that step is not counted as raised.
