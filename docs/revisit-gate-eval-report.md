# Revisit Gate Evaluation (Anthropic API)

Status: **gate prompt measured with Claude models over the Anthropic API, on authored fixtures only.** This fills the two gate cells that the [revisit replay report](revisit-replay-report.md) leaves "not run", with a clearly different setup: the production gate runs through the signed-in Codex route (D56-I02) and has still not been run. These numbers describe the gate's prompt (`buildPackage`) and strict reply parser (`parseReply`) answered by API models. They are not a measurement of the shipped gate or its model.

Every number is **on these authored fixtures only**: small, synthetic, written before any scored run. They are not a statistical sample, not accuracy on real decisions, and not comparable to PM-Bench or MemoProAgent.

## Method

- **Gate measured alone** sends every labelled relevant condition for every evidence step to the model, in fixture order, with earlier outcomes for that condition in the package. Review-by dates are notified from the labels without a model, as the proposed system does. The package differs from production in two ways: the whole evidence text is the only passage, and provenance reads "Authored fixture capture (synthetic)."
- **Proposed system** replays each timeline through the real desktop app with automatic gate checks on. The app's controlled test gate forwards each package to a loopback relay in the evaluation script, which calls the API. Retrieval, duplicate suppression, notice rules and parsing are the app's own code.
- One model call per package and no rerolls (D56-I04). A run is one pass over the fixture; repeated runs measure how much the result moves between identical runs. Every run is kept, including failed ones (D57).
- System text is the Codex catalog's `base_instructions`. Thinking is the model default (adaptive); effort is set explicitly. No refusal fallback is used, because it would change the model under test.
- Scoring is the replay's own D54 code. Set-F1 = 2·TP / (2·TP + FP + FN). No composite score or pass threshold (D54-I07).
- Spend is checked against a cumulative cap before each call; total recorded spend for the runs below is **$0.0067** (list prices, recomputed from reported usage).

## Results

### `tests/fixtures/revisit-replay/fixture-v1.json`

sha256 `213f829b2186c63324af0f40d75e3260efc7dec1fe52550c8f7a9a7351418a54`

| Cell | Model (effort) | Runs | Set-F1 mean (sd) | Set-F1 min–max | Precision mean | Recall mean | Mean TP / FP / FN | Invalid replies | Mean latency per call | Cost |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Labelled evidence, gate decides (gate measured alone) | claude-haiku-5-5 (medium) | 1 | 0.800 | 0.800–0.800 | 100.0% | 66.7% | 8.0 / 0.0 / 4.0 | 0 | 1.9 s | $0.0039 |
| Retrieved evidence, gate decides (proposed system) | claude-haiku-5-5 (medium) | 1 | 0.800 | 0.800–0.800 | 100.0% | 66.7% | 8.0 / 0.0 / 4.0 | 0 | 1.9 s | $0.0028 |

#### Error attribution, summed over runs

| Cell | Model | Error label | Count |
| --- | --- | --- | --- |
| labelled | claude-haiku-5-5 | gate miss (trigger:paraphrase) | 4 |
| proposed | claude-haiku-5-5 | retrieval miss (trigger:paraphrase) | 4 |


## Raw outputs

Each run's packages, replies, parse results, usage, latency and scores are in `docs/evaluation/gate-eval/`. Source commit and whether the app or scripts had uncommitted changes are recorded per run.

## Limits

- Same limits as the replay report: one author, small fixtures, labelled before scoring. A model-written fixture (version 2) reduces but does not remove author bias, and the generating model may share blind spots with the models it is used to test.
- Retrieval misses on paraphrase triggers cap the proposed system's recall; no gate can recover them (D25).
- API models are not the production model. A different model, effort or route can behave differently.
