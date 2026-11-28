# Revisit Replay Evaluation

Status: **implemented on branch `spec/decision-revisit`; acceptance review pending.** Results: [Revisit Replay Report](revisit-replay-report.md). Run with `node scripts/revisit-replay.cjs`; harness tests are in `tests/revisit-replay.spec.js`. Decision IDs D51–D57 continue the numbering in [the first spec](local-second-brain-spec.md). This draft measures the feature described in [Decision Ledger and Revisit Notices](decision-revisit-spec.md) and does not repeat its design.

## Problem Statement

A revisit notice that fires on a hand-picked example proves nothing. Two things can go wrong and they look alike from the outside: the system stays quiet when it should speak (a miss), or it speaks when it should stay quiet (a false alarm). A system can hide either failure by leaning the other way. PM-Bench makes this point about its own metric: scoring only precision rewards doing too little, and scoring only recall rewards acting at every step (Liu & Gabriel 2026, §4.1).

I also need to know which stage failed. MemoProAgent shows that finding the right evidence and deciding to speak break independently: a model given perfect evidence and timing scores 96.0, and the same model with retrieved evidence scores 15.3 (Zeng et al. 2026, Table 4). And I need to know whether the ledger and gate beat the obvious cheaper alternative, which is searching my decision notes for each new capture.

## Solution

Build a **replay**: a fixed, authored timeline of ledger changes and evidence arrivals, each step labelled with the notices that should exist at that point. Play the same timeline through several system variants and score every step.

The timeline mixes **true triggers** (evidence that meets a revisit condition) with **near misses** (evidence that looks like it should, and does not), plus stretches where nothing should fire. The comparison is against a **document-search baseline**: the existing local text search over decision notes, notifying on any match.

## Research basis

| Method element | Source | Use here |
| --- | --- | --- |
| A step-by-step simulated timeline with a known set of due tasks at each step. | PM-Bench §3.1 | D51: replay steps with a labelled due set. |
| Lures mixed into the action menu at roughly one per task (74 lures, 81 scored tasks). | PM-Bench Table 1 | D52: at least one near miss per true trigger. |
| Update events that cancel, override or reschedule a task (11 in the benchmark), with cancelled tasks left selectable. | PM-Bench Table 1, §3 | D52: near misses that match a superseded or withdrawn condition. |
| Set-F1 from summed true positives, false positives and false negatives. Separate hit rates for updated tasks. | PM-Bench §4.1, Table 2 | D54: primary score and update hit rate. |
| A validity audit that confirms the benchmark is fully solvable. | PM-Bench §3.3 | D51: every fixture is checked against a perfect-answer run. |
| A 2×2 study crossing evidence quality with the timing decision. | MemoProAgent Table 4 | D53: evidence source crossed with decision rule. |
| Always-on retrieval as the baseline. Negative clips with the target memory removed, scored by false-trigger rate. | MemoProAgent §4.2, §6.3 | D53 baseline, D52 negative timelines, D54 false-trigger rate. |
| Removing the gate as an ablation (37.3 to 24.0). | MemoProAgent §6.3 | D53: the "retrieved evidence, notify on match" cell is that ablation. |
| Exactly one correct intervention per trigger. Repetition counts as failure. | MemoProAgent §3.1, §3.3 | D54: repeat notices are counted as false positives. |

### Limits stated up front

- The fixtures are authored by me and small. They show whether the mechanism behaves as designed on known cases. They do not establish reliability on real decisions, and three or thirty cases are not a statistical sample (the same caution as the first spec's comparison protocol).
- The papers' numbers are quoted to explain method choices. Companion's results are not comparable to them: different task, scale and data.
- An author who writes both the conditions and the near misses can unconsciously make them easy. D52 fixes the fixture set before any system variant is run, and D57 keeps every result.

## User Stories

1. As the developer, I want one command to replay a fixed timeline, so that results are repeatable.
2. As the developer, I want misses and false alarms reported separately, so that a quiet system cannot look good.
3. As the developer, I want each error attributed to retrieval or to the gate, so that I know what to fix.
4. As the developer, I want the same timeline run through plain document search, so that I know whether the ledger earns its complexity.
5. As a reader of the project, I want the fixtures, labels and every raw result in the repository, so that I can check the claims.
6. As a reader of the project, I want unverified and failed runs reported as such, so that I can trust the passed ones.

## Implementation Decisions

### D51 · Replay a versioned timeline with a labelled due set

- **D51-I01**. A replay fixture is an ordered list of steps. A step is either a ledger event (create, edit condition, withdraw, supersede, resolve) or an evidence event (D44-I01), with a controlled clock.
- **D51-I02**. Each step carries its **due set**: the notices that should exist after that step, each naming a decision version, condition version and evidence revision. An empty due set means silence is correct.
- **D51-I03**. Fixtures are authored synthetic material, labelled as Comparison Fixtures and kept apart from real imports (D28). Each fixture file has a version and a content hash.
- **D51-I04**. A perfect-answer run, driven directly from the labels, must score 100% on every fixture before any system is evaluated. This catches labelling mistakes.
- **D51-I05**. The replay drives the real desktop workflow and files (D40), not a separate simulator.

### D52 · Author true triggers and named kinds of near miss

- **D52-I01**. True triggers come in three kinds: wording that matches the cue terms, a paraphrase that does not, and a time-based due date.
- **D52-I02**. Near misses come in six named kinds:
  1. Same topic, condition not met (for example the right benchmark on the wrong hardware).
  2. Same cue words, opposite finding.
  3. Meets an earlier, superseded version of the condition.
  4. Meets a condition on a withdrawn decision.
  5. Meets the condition, but the source is rejected or deleted (D19, D37).
  6. Repeats evidence that already raised a notice (re-import or retitled copy).
- **D52-I03**. Include at least one near miss for every true trigger, and at least two **negative timelines** in which nothing should fire.
- **D52-I04**. Freeze the fixture set, with its hashes, before the first scored run. Later additions get a new fixture version and are reported separately.

### D53 · Compare four variants in a 2×2, including the baseline

- **D53-I01**. Cross two evidence sources with two decision rules:

  | | Notify on any match | Gate decides |
  | --- | --- | --- |
  | **Retrieved evidence** | Document-search baseline | Proposed system |
  | **Labelled evidence** | Upper bound for matching alone | Gate measured alone |

- **D53-I02**. The **document-search baseline** runs D25 local search over decision notes for each evidence event and notifies on any match, with no condition versions, state or notice history. It is the always-on retrieval baseline.
- **D53-I03**. "Labelled evidence" hands the correct passage and condition to the decision rule, removing retrieval error. This uses the D50-I02 test seam.
- **D53-I04**. Every variant sees the same fixtures, the same step order and, where a model is used, the same model and settings.

### D54 · Score every step with Set-F1 and report its parts

- **D54-I01**. For each step, compare the notices raised with the due set. Sum over all steps: TP is notices raised and due, FP is notices raised and not due, FN is notices due and not raised. **Set-F1 = 2·TP / (2·TP + FP + FN)**, as in PM-Bench §4.1.
- **D54-I02**. Always report precision, recall, and the raw TP, FP and FN counts beside Set-F1.
- **D54-I03**. Report **update hit rate**: the share of due notices raised correctly on conditions that were edited earlier in the timeline.
- **D54-I04**. Report **false-trigger rate**: the share of negative timelines with one or more notices.
- **D54-I05**. A second notice for the same condition version and evidence revision counts as a false positive and is also reported as a **repeat notice** count.
- **D54-I06**. Report results per kind of true trigger and per kind of near miss.
- **D54-I07**. No composite score and no numeric pass threshold are chosen in this increment.

### D55 · Attribute each error to a stage

- **D55-I01**. Using the D50 stage records, label each false negative as a **retrieval miss** (no candidate was created) or a **gate miss** (candidate created, gate said no or cannot tell).
- **D55-I02**. Label each false positive as a **gate false alarm**, a **stale-state error** (fired on a superseded, withdrawn or removed item) or a **repeat**.
- **D55-I03**. These map onto the existing distinction between No Relevant Context and No Supported Connection (D32).

### D56 · Separate controlled runs from the live model run

- **D56-I01**. Harness tests use controlled gate replies. They verify the replay, scoring and attribution code. They are not evidence about model judgment.
- **D56-I02**. The live run uses the real automatic gate (D46, ADR 0007), with its cap raised for the run to cover every fixture candidate. It needs the signed-in Codex readiness gate, which is currently deferred. Until that passes, the gate columns of D53 are reported as "not run".
- **D56-I03**. The baseline and the "labelled evidence, notify on match" cell need no model and can be scored now.
- **D56-I04**. One model turn per candidate, no automatic rerolls, with model, settings, elapsed time and usage recorded where available (D39). Any model usage beyond what the readiness gate already covers needs my approval first.

### D57 · Publish a results report that keeps failures

- **D57-I01**. Write one report with fixture version and hashes, source commit, model and settings, the D53 table filled with D54 scores, the D55 breakdown, and each cell marked passed, failed, or not run.
- **D57-I02**. Keep the raw per-step outputs for every variant, including failed and interrupted runs.
- **D57-I03**. State the D52 limits in the report itself. Describe a result as "on these authored fixtures", never as general accuracy.
- **D57-I04**. Link the report from the README beside the paper citations, so that claims about the feature point at evidence.

### D58 · Measure the gate prompt with API models while the Codex gate is deferred

- **D58-I01**. Approved by me on 2026-11-28 under D56-I04: the two gate cells are also run with Claude models over the Anthropic API, paid from API credits. They are reported in a separate [gate evaluation report](revisit-gate-eval-report.md), never in place of the D56-I02 cells, which stay "not run".
- **D58-I02**. The API run reuses the production package builder, reply parser, retrieval and notice code. The proposed-system cell runs in the desktop app; its controlled test gate forwards packages to a loopback relay owned by the evaluation script, so the app never holds a key.
- **D58-I03**. Each run is one pass with one call per package and no rerolls. Several identical runs are reported with mean, spread and every raw result, so run-to-run variation is visible.
- **D58-I04**. A second fixture (version 2) is written by a model and reviewed before any scored run, to reduce the single-author bias of D52. It is reported separately from version 1 (D52-I04).
- **D58-I05**. Spend is checked against a cumulative cap before every call and recorded per run.

## Testing Decisions

- **Scoring**. Hand-computed TP, FP, FN and Set-F1 for a three-step toy timeline match the scorer's output, including a step with an empty due set and a repeat notice.
- **Perfect-answer run** (D51-I04). Scores 100% on every fixture. Deliberately corrupting one label makes it fail.
- **Attribution** (D55). A fixture with no cue-term overlap is reported as a retrieval miss. A controlled "does not meet" reply on a true trigger is reported as a gate miss.
- **Baseline** (D53-I02). On a superseded-condition near miss, the baseline notifies and the report labels it a stale-state error.
- **Determinism**. Two replays of the same fixture and controlled replies give byte-identical reports apart from timestamps.
- **Honest status**. With chat readiness closed, the report marks gate cells "not run" and still fills the two model-free cells.

## Out of Scope

- Running the PM-Bench or MemoProBench datasets themselves, or claiming scores on them.
- A study with real decisions over real months, and any human-subject study.
- Tuning retrieval or prompts against the frozen fixtures. A change made after seeing results needs a new fixture version.
- Latency and cost optimisation.

## Open Questions

1. **Fixture size.** Recommended starting point: 12 true triggers (4 of each kind), 12 near misses (2 of each kind) and 2 negative timelines, all for MyTune decisions. Small enough to author carefully and review by hand.
2. **Who labels?** Recommended: I author and label, and a second pass by a separate model session flags labels it disagrees with before the freeze. Disagreements are recorded, not silently resolved.
3. **Live run now or later?** The model-free half can run as soon as the feature exists. The gate half waits on the deferred Codex sign-in check.

## References

- Genglin Liu and Saadia Gabriel. "PM-Bench: Evaluating Prospective Memory in LLM Agents." COLM 2026. [arXiv:2607.12385](https://arxiv.org/abs/2607.12385).
- Shenglai Zeng, Xiao Yang, Tiffany Ma, et al. "MemoProAgent: Toward Memory-Driven Proactive Assistance." 2026. [arXiv:2610.22671](https://arxiv.org/abs/2610.22671).
