# Revisit Gate Evaluation (Anthropic API)

Status: **gate prompt measured with Claude models over the Anthropic API, on authored fixtures only.** This fills the two gate cells that the [revisit replay report](revisit-replay-report.md) leaves "not run", with a clearly different setup: the production gate runs through the signed-in Codex route (D56-I02) and has still not been run. These numbers describe the gate's prompt (`buildPackage`) and strict reply parser (`parseReply`) answered by API models. They are not a measurement of the shipped gate or its model.

Every number is **on these authored fixtures only**: small, synthetic, written before any scored run. They are not a statistical sample, not accuracy on real decisions, and not comparable to PM-Bench or MemoProAgent.

## Method

- **Gate measured alone** sends every labelled relevant condition for every evidence step to the model, in fixture order, with earlier outcomes for that condition in the package. Review-by dates are notified from the labels without a model, as the proposed system does. The package differs from production in two ways: the whole evidence text is the only passage, and provenance reads "Authored fixture capture (synthetic)."
- **Proposed system** replays each timeline through the real desktop app with automatic gate checks on. The app's controlled test gate forwards each package to a loopback relay in the evaluation script, which calls the API. Retrieval, duplicate suppression, notice rules and parsing are the app's own code.
- One model call per package and no rerolls (D56-I04). A run is one pass over the fixture; repeated runs measure how much the result moves between identical runs. Every run is kept, including failed ones (D57).
- System text is the Codex catalog's `base_instructions`. Thinking is the model default (adaptive); effort is set explicitly. No refusal fallback is used, because it would change the model under test.
- Scoring is the replay's own D54 code. Set-F1 = 2·TP / (2·TP + FP + FN). No composite score or pass threshold (D54-I07).
- Spend is checked against a cumulative cap before each call; recorded spend is **$3.2747** for the runs below plus **$0.4804** for 1 fixture generation call(s), at list prices recomputed from reported usage.

## Results

### `tests/fixtures/revisit-replay/fixture-v1.json`

sha256 `213f829b2186c63324af0f40d75e3260efc7dec1fe52550c8f7a9a7351418a54`

| Cell | Model (effort) | Runs | Set-F1 mean (sd) | Set-F1 min–max | Precision mean | Recall mean | Mean TP / FP / FN | Invalid replies | Mean latency per call | Cost |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Labelled evidence, gate decides (gate measured alone) | claude-haiku-5-5 (medium) | 5 | 0.800 (0.000) | 0.800–0.800 | 100.0% | 66.7% | 8.0 / 0.0 / 4.0 | 2 | 2.1 s | $0.0205 |
| Labelled evidence, gate decides (gate measured alone) | claude-opus-5-5 (medium) | 5 | 0.800 (0.000) | 0.800–0.800 | 100.0% | 66.7% | 8.0 / 0.0 / 4.0 | 0 | 2.6 s | $0.5178 |
| Labelled evidence, gate decides (gate measured alone) | claude-sonnet-5-5 (medium) | 5 | 0.800 (0.000) | 0.800–0.800 | 100.0% | 66.7% | 8.0 / 0.0 / 4.0 | 0 | 1.9 s | $0.2245 |
| Retrieved evidence, gate decides (proposed system) | claude-haiku-5-5 (medium) | 5 | 0.800 (0.000) | 0.800–0.800 | 100.0% | 66.7% | 8.0 / 0.0 / 4.0 | 0 | 2.0 s | $0.0151 |
| Retrieved evidence, gate decides (proposed system) | claude-opus-5-5 (medium) | 5 | 0.800 (0.000) | 0.800–0.800 | 100.0% | 66.7% | 8.0 / 0.0 / 4.0 | 0 | 1.7 s | $0.3399 |
| Retrieved evidence, gate decides (proposed system) | claude-sonnet-5-5 (medium) | 5 | 0.800 (0.000) | 0.800–0.800 | 100.0% | 66.7% | 8.0 / 0.0 / 4.0 | 0 | 1.3 s | $0.1634 |

#### Error attribution, summed over runs

| Cell | Model | Error label | Count |
| --- | --- | --- | --- |
| labelled | claude-haiku-5-5 | gate miss (trigger:paraphrase) | 18 |
| labelled | claude-haiku-5-5 | invalid gate reply (trigger:paraphrase) | 2 |
| labelled | claude-opus-5-5 | gate miss (trigger:paraphrase) | 20 |
| labelled | claude-sonnet-5-5 | gate miss (trigger:paraphrase) | 20 |
| proposed | claude-haiku-5-5 | retrieval miss (trigger:paraphrase) | 20 |
| proposed | claude-opus-5-5 | retrieval miss (trigger:paraphrase) | 20 |
| proposed | claude-sonnet-5-5 | retrieval miss (trigger:paraphrase) | 20 |

### `tests/fixtures/revisit-replay/fixture-v2.json`

sha256 `429152a638a49f29bce336cfa2e7433888b2143fcc903e92323fc0cb2cdafddd`

| Cell | Model (effort) | Runs | Set-F1 mean (sd) | Set-F1 min–max | Precision mean | Recall mean | Mean TP / FP / FN | Invalid replies | Mean latency per call | Cost |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Labelled evidence, gate decides (gate measured alone) | claude-haiku-5-5 (medium) | 5 | 0.985 (0.020) | 0.963–1.000 | 100.0% | 97.1% | 13.6 / 0.0 / 0.4 | 0 | 2.4 s | $0.0300 |
| Labelled evidence, gate decides (gate measured alone) | claude-opus-5-5 (medium) | 5 | 1.000 (0.000) | 1.000–1.000 | 100.0% | 100.0% | 14.0 / 0.0 / 0.0 | 0 | 2.6 s | $0.7668 |
| Labelled evidence, gate decides (gate measured alone) | claude-sonnet-5-5 (medium) | 5 | 0.880 (0.000) | 0.880–0.880 | 100.0% | 78.6% | 11.0 / 0.0 / 3.0 | 10 | 1.5 s | $0.3176 |
| Retrieved evidence, gate decides (proposed system) | claude-haiku-5-5 (medium) | 5 | 0.833 (0.000) | 0.833–0.833 | 100.0% | 71.4% | 10.0 / 0.0 / 4.0 | 0 | 2.4 s | $0.0251 |
| Retrieved evidence, gate decides (proposed system) | claude-opus-5-5 (medium) | 5 | 0.833 (0.000) | 0.833–0.833 | 100.0% | 71.4% | 10.0 / 0.0 / 4.0 | 0 | 2.1 s | $0.5932 |
| Retrieved evidence, gate decides (proposed system) | claude-sonnet-5-5 (medium) | 5 | 0.833 (0.000) | 0.833–0.833 | 100.0% | 71.4% | 10.0 / 0.0 / 4.0 | 0 | 1.4 s | $0.2607 |

#### Error attribution, summed over runs

| Cell | Model | Error label | Count |
| --- | --- | --- | --- |
| labelled | claude-haiku-5-5 | gate miss (trigger:paraphrase) | 2 |
| labelled | claude-sonnet-5-5 | gate miss (trigger:paraphrase) | 5 |
| labelled | claude-sonnet-5-5 | invalid gate reply (trigger:paraphrase) | 10 |
| proposed | claude-haiku-5-5 | retrieval miss (trigger:paraphrase) | 20 |
| proposed | claude-opus-5-5 | retrieval miss (trigger:paraphrase) | 20 |
| proposed | claude-sonnet-5-5 | retrieval miss (trigger:paraphrase) | 20 |

## Findings (runs of 2026-11-28)

Read from the raw replies of the runs above; counts are over 5 runs per model, cell and fixture.

1. **No false alarms.** Every run of every model in both cells had zero false positives. Same-topic, opposite, superseded, withdrawn, deleted, repeat and unrelated notes never raised a notice.
2. **Retrieval, not the model, sets the proposed system's score.** Every paraphrase trigger in both fixtures was a retrieval miss in every proposed-system run, so the gate never saw it. The proposed system scores the same with all three models (0.800 on v1, 0.833 on v2). This is the known limit of lexical matching (D25).
3. **v1's paraphrase triggers are ambiguous, not just hard.** All three models rejected all four in every run. The replies say why: each one closely restates an earlier cue trigger, so models applied the prompt's "already raised" rule (EA3, ED5), or it drops the detail that identifies the subject, such as SQLite or FLAC (EC3 "does not meet", EB4 "cannot tell"). The fixture labels them as new due notices. On v2, where each paraphrase reports a new observation, Opus met all of them in every run.
4. **The prompt's "same point" rule over-applies.** On v2, ED5 reports a different site and incident from the earlier trigger. Sonnet rejected it as an already-raised point in 5 of 5 runs and Haiku in 2 of 5. The rule does not say whether "the same point" means the same observation or the same kind of event.
5. **Strict parsing fails safe.** Sonnet wrote its arithmetic in prose before the JSON for EA3 and EC4 on v2 in all 5 runs (10 replies); Haiku did so twice on v1. The parser rejected every such reply, so no notice was raised from an unchecked answer, at the cost of recall.
6. **Runs repeat closely.** Opus and Sonnet gave the same score in every run of a cell; Haiku varied on v2 (0.963–1.000).

Not changed in response: the gate prompt, retrieval and fixtures are untouched, because tuning against frozen fixtures is out of scope. A clarified repeat rule or a JSON-only reply format would need a new fixture version to be measured fairly.


## Raw outputs

Each run's packages, replies, parse results, usage, latency and scores are in `docs/evaluation/gate-eval/`. Source commit and whether the app or scripts had uncommitted changes are recorded per run.

## Limits

- Same limits as the replay report: one author, small fixtures, labelled before scoring. A model-written fixture (version 2) reduces but does not remove author bias, and the generating model may share blind spots with the models it is used to test.
- Retrieval misses on paraphrase triggers cap the proposed system's recall; no gate can recover them (D25).
- API models are not the production model. A different model, effort or route can behave differently.
