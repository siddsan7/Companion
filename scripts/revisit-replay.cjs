#!/usr/bin/env node
// D51-D57: replays a frozen fixture through the real desktop app and writes a results
// report plus the raw per-step outputs. Usage:
//   node scripts/revisit-replay.cjs [--fixture tests/fixtures/revisit-replay/fixture-v1.json]
// Model-free cells are scored. Cells that need the gate are reported as "not run" until
// the signed-in Codex readiness gate passes (D56-I02); this script never calls a model.
const fs = require('node:fs/promises');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const replay = require('../app/revisit-replay');
const { runTimeline } = require('./revisit-replay-runner.cjs');

const percent = value => value === null || value === undefined ? 'n/a' : `${(value * 100).toFixed(1)}%`;

// Raises the error labels of D55 for misses, using the recorded stage outputs.
function missAttribution(runs) {
  return (entry, timelineIndex) => {
    if (entry.evidence.startsWith('clock:')) return 'due check miss';
    const candidate = runs[timelineIndex].finalCandidates.find(item => item.decision === entry.decision && item.condition === entry.condition && item.conditionVersion === entry.conditionVersion && item.evidence === entry.evidence);
    if (!candidate) return 'retrieval miss';
    return ['pending', 'held', 'held-oversize', 'sending'].includes(candidate.status) ? 'gate not run' : 'gate miss';
  };
}

async function runReplay(fixture, { electron, gate = null, automatic = false, statusTimeoutMs } = {}) {
  replay.validateFixture(fixture);
  const runs = [];
  for (const timeline of fixture.timelines) runs.push(await runTimeline(timeline, { electron, gate, automatic, statusTimeoutMs }));
  return runs;
}

// Scores every D53 cell that can be scored from this run. Gate cells are scored only
// when the run had an open gate (controlled harness runs); otherwise they are "not run".
function cells(fixture, runs, { gateRan }) {
  const stepsOf = select => runs.map(run => run.records.map(select));
  const timeNotices = stepsOf(record => record.notices.filter(notice => notice.evidence.startsWith('clock:')));
  return {
    baseline: { status: 'passed', score: replay.score(fixture, stepsOf(record => record.baseline), { attribute: { falseAlarm: 'match false alarm', miss: entry => entry.evidence.startsWith('clock:') ? 'no clock in document search' : 'no match' } }) },
    labelledMatch: { status: 'passed', score: replay.score(fixture, fixture.timelines.map(replay.labelledMatch), { attribute: { falseAlarm: 'match false alarm' } }) },
    proposed: gateRan
      ? { status: 'passed', score: replay.score(fixture, stepsOf(record => record.notices), { attribute: { miss: missAttribution(runs) } }) }
      : { status: 'not run', reason: 'The automatic gate needs the signed-in Codex readiness gate, which is deferred (D56-I02).' },
    labelledGate: { status: 'not run', reason: 'Needs a model judgment on labelled evidence; waits on the same readiness gate (D56-I02).' },
    // Model-free stage diagnostics from the proposed system's own records (D55-I01).
    // Candidates that never reach the gate (duplicates, removed evidence) are excluded.
    retrieval: replay.score(only(fixture, entry => !entry.evidence.startsWith('clock:')), stepsOf(record => record.candidates.filter(candidate => !['duplicate', 'withdrawn'].includes(candidate.status))), { attribute: { falseAlarm: 'candidate on a near miss', miss: missAttribution(runs) } }),
    timeBased: replay.score(only(fixture, entry => entry.evidence.startsWith('clock:')), timeNotices)
  };
}
// The same fixture with only some due entries, for scoring one stage on its own.
const only = (fixture, keep) => ({ ...fixture, timelines: fixture.timelines.map(timeline => ({ ...timeline, steps: timeline.steps.map(step => ({ ...step, due: step.due.filter(keep) })) })) });

function metricRow(name, cell) {
  if (cell.status === 'not run') return `| ${name} | **not run** | | | | | | | ${cell.reason} |`;
  const s = cell.score;
  return `| ${name} | ${cell.status} | ${s.setF1.toFixed(3)} | ${percent(s.precision)} | ${percent(s.recall)} | ${s.tp} / ${s.fp} / ${s.fn} | ${s.repeats} | ${percent(s.updateHitRate)} | false-trigger rate ${percent(s.falseTriggerRate)} |`;
}
function kindTable(score) {
  const kinds = [...replay.triggerKinds, ...replay.nearMissKinds, 'unrelated'];
  return ['| Kind | TP | FP | FN |', '| --- | --- | --- | --- |', ...kinds.map(kind => { const k = score.byKind[kind] || { tp: 0, fp: 0, fn: 0 }; return `| ${kind} | ${k.tp} | ${k.fp} | ${k.fn} |`; })].join('\n');
}
function errorTable(score) {
  const counts = {};
  for (const error of score.errors) counts[error.type] = (counts[error.type] || 0) + 1;
  const rows = Object.entries(counts).sort(([a], [b]) => a.localeCompare(b)).map(([type, count]) => `| ${type} | ${count} |`);
  return ['| Error label | Count |', '| --- | --- |', ...(rows.length ? rows : ['| none | 0 |'])].join('\n');
}

function renderReport(fixture, runs, meta) {
  const counts = replay.validateFixture(fixture), perfect = replay.score(fixture, fixture.timelines.map(replay.perfectAnswers));
  const result = cells(fixture, runs, meta);
  return `# Revisit Replay Report

Status of this report: **model-free cells scored; gate cells not run.** It measures the feature in [Decision Ledger and Revisit Notices](decision-revisit-spec.md) using the method in [Revisit Replay Evaluation](revisit-replay-evaluation-spec.md).

Every number below is **on these authored fixtures only**. The fixture is small, synthetic and written by the same person who wrote the conditions, so it shows whether the mechanism behaves as designed on known cases. It does not establish accuracy on real decisions, it is not a statistical sample, and it is not comparable to PM-Bench or MemoProAgent scores (different task, scale and data).

## Run

| Item | Value |
| --- | --- |
| Fixture | \`${meta.fixturePath}\`, version ${fixture.version}, sha256 \`${replay.fixtureHash(fixture)}\` |
| Fixture content | ${counts.triggers} true triggers, ${counts.nearMisses} near misses, ${counts.negatives} negative timelines, ${fixture.timelines.length} timelines |
| Source commit | \`${meta.commit}\`${meta.dirty ? ' (working tree had uncommitted changes)' : ''} |
| Model and settings | none: no model was called in this run |
| Gate | ${meta.gateRan ? 'controlled replies (harness only, not evidence about model judgment)' : 'closed: production chat readiness has not passed (D46-I10)'} |
| Perfect-answer audit (D51-I04) | Set-F1 ${perfect.setF1.toFixed(3)} (${perfect.tp} / ${perfect.fp} / ${perfect.fn}) |
| Raw outputs | \`${meta.rawPath}\` |
| Generated | ${meta.generatedAt} |

## D53 comparison

TP / FP / FN are summed over every step. Set-F1 = 2·TP / (2·TP + FP + FN). Each step compares the notices first raised in it with the notices that became due in it, so a correct notice counts once. A second notice for the same condition version and evidence counts as a false positive and as a repeat (D54-I05). No composite score or pass threshold is set (D54-I07).

| Cell | Status | Set-F1 | Precision | Recall | TP / FP / FN | Repeats | Update hit rate | Notes |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
${metricRow('Retrieved evidence, notify on any match (document-search baseline)', result.baseline)}
${metricRow('Retrieved evidence, gate decides (proposed system)', result.proposed)}
${metricRow('Labelled evidence, notify on any match (upper bound for matching alone)', result.labelledMatch)}
${metricRow('Labelled evidence, gate decides (gate measured alone)', result.labelledGate)}

The document-search baseline (D53-I02) searches every decision note on disk, all versions, for each new capture and notifies a decision when one paragraph shares at least two distinctive words with the capture. It has no conditions, versions, state, notice history or clock, so it cannot raise time-based notices. Its notices name a decision, not a condition, and match any due notice for that decision and evidence.

## D55 error attribution

### Document-search baseline

${errorTable(result.baseline.score)}

### Labelled evidence, notify on any match

${errorTable(result.labelledMatch.score)}

### Proposed system: retrieval stage (model-free)

The proposed system's retrieval stage ran for real in this replay. A candidate is what retrieval hands to the gate. A due evidence notice with no candidate is a **retrieval miss**; no gate can recover it. A candidate on a near miss must be rejected by the gate. Candidates are counted on the same per-step basis; repeated text that retrieval marked as a duplicate is not sent to the gate and is not counted.

| Measure | Value |
| --- | --- |
| Due evidence notices with a candidate | ${result.retrieval.tp} |
| Retrieval misses | ${result.retrieval.errors.filter(error => error.type === 'retrieval miss').length} |
| Candidates on near misses or unrelated evidence (gate must reject) | ${result.retrieval.fp} |

${errorTable(result.retrieval)}

### Proposed system: time-based notices (model-free)

Time-based conditions need no model and ran for real: Set-F1 ${result.timeBased.setF1.toFixed(3)}, TP / FP / FN ${result.timeBased.tp} / ${result.timeBased.fp} / ${result.timeBased.fn}, update hit rate ${percent(result.timeBased.updateHitRate)}.

## D54 results by kind

### Document-search baseline

${kindTable(result.baseline.score)}

### Labelled evidence, notify on any match

${kindTable(result.labelledMatch.score)}

### Proposed system: retrieval stage

${kindTable(result.retrieval)}

## Not run

- **Proposed system** and **gate measured alone**: both need the automatic gate (D46, ADR 0007), which needs the signed-in Codex readiness gate. That check is deferred, so these cells are not run and no score is claimed for them (D56-I02). Running them needs approval for model usage (D56-I04).
- Harness tests exercise the same scoring and attribution code with controlled gate replies. Those runs verify the code, not model judgment, and are not reported here (D56-I01).

## Limits

- Authored by one person, labelled before any scored run, and small: ${counts.triggers} true triggers and ${counts.nearMisses} near misses. Results describe behaviour on these fixtures only.
- Paraphrase triggers were written to share no cue terms with their condition. Retrieval misses on them measure the known weakness of lexical matching (D25); they are not a bug to be tuned away against this fixture (out of scope: tuning against frozen fixtures).
- A deleted near miss is captured and deleted within one step; a notice whose evidence was removed in that step is not counted as raised.
`;
}

async function main() {
  const args = process.argv.slice(2), fixtureArg = args.includes('--fixture') ? args[args.indexOf('--fixture') + 1] : 'tests/fixtures/revisit-replay/fixture-v1.json';
  const repo = path.join(__dirname, '..'), fixturePath = path.relative(repo, path.resolve(fixtureArg)).split(path.sep).join('/');
  const fixture = JSON.parse(await fs.readFile(path.join(repo, fixturePath), 'utf8'));
  replay.validateFixture(fixture);
  const perfect = replay.score(fixture, fixture.timelines.map(replay.perfectAnswers));
  if (perfect.setF1 !== 1) throw Error(`Perfect-answer audit failed (Set-F1 ${perfect.setF1}). Fix the labels before any scored run.`);
  const commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim();
  const dirty = execFileSync('git', ['status', '--porcelain'], { cwd: repo, encoding: 'utf8' }).trim().length > 0;
  const { _electron: electron } = require('@playwright/test');
  const runs = await runReplay(fixture, { electron });
  const rawPath = `docs/evaluation/revisit-replay/fixture-v${fixture.version}-${commit.slice(0, 12)}.json`;
  await fs.mkdir(path.join(repo, path.dirname(rawPath)), { recursive: true });
  const generatedAt = new Date().toISOString();
  await fs.writeFile(path.join(repo, rawPath), JSON.stringify({ fixture: fixturePath, version: fixture.version, sha256: replay.fixtureHash(fixture), commit, dirty, generatedAt, gate: 'closed', runs }, null, 2) + '\n');
  const report = renderReport(fixture, runs, { fixturePath, commit, dirty, gateRan: false, rawPath, generatedAt });
  await fs.writeFile(path.join(repo, 'docs', 'revisit-replay-report.md'), report);
  console.log(`Wrote docs/revisit-replay-report.md and ${rawPath}`);
}
if (require.main === module) main().catch(error => { console.error(error.message); process.exit(1); });
module.exports = { runReplay, renderReport, cells, missAttribution };
