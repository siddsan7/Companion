#!/usr/bin/env node
// Runs the two gate cells of the revisit replay (D53) with Claude models over the
// Anthropic API, then writes docs/revisit-gate-eval-report.md from every raw result on
// disk. This measures the gate prompt and parser with API models on authored fixtures. It
// is not the production gate, which runs through the signed-in Codex route (D56-I02).
//
//   node scripts/revisit-gate-eval.cjs --fixture tests/fixtures/revisit-replay/fixture-v1.json \
//     --models claude-haiku-5-5,claude-sonnet-5-5 --repeats 3 [--cells labelled,proposed] [--effort medium] [--cap 40]
//   node scripts/revisit-gate-eval.cjs --report-only
const fs = require('node:fs/promises');
const http = require('node:http');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const replay = require('../app/revisit-replay');
const { runReplay, cells } = require('./revisit-replay.cjs');
const { createJudge, SpendLedger, prices } = require('./gate-eval/anthropic-gate.cjs');
const { labelledGate, labelledMissAttribution } = require('./gate-eval/labelled-gate.cjs');

const repo = path.join(__dirname, '..');
const outDir = 'docs/evaluation/gate-eval';
const reportPath = 'docs/revisit-gate-eval-report.md';

function option(args, name, fallback) { const index = args.indexOf(`--${name}`); return index < 0 ? fallback : args[index + 1]; }

// Loopback relay for the desktop app's controlled gate. Each request is answered by one
// judge call; the call record keeps the exact package and reply.
async function startRelay(judge, calls) {
  const server = http.createServer((request, response) => {
    let body = '';
    request.on('data', chunk => { body += chunk; });
    request.on('end', async () => {
      try {
        const { text, mode } = JSON.parse(body);
        const result = await judge(text);
        calls.push({ mode, text, ...result });
        response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ reply: result.reply, model: result.model, usage: result.usage }));
      } catch (error) {
        calls.push({ error: error.message });
        response.writeHead(502, { 'content-type': 'application/json' }).end(JSON.stringify({ error: error.message }));
      }
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return { url: `http://127.0.0.1:${server.address().port}/gate`, close: () => new Promise(resolve => server.close(resolve)) };
}

const summary = score => ({ setF1: score.setF1, precision: score.precision, recall: score.recall, tp: score.tp, fp: score.fp, fn: score.fn, repeats: score.repeats, falseTriggerRate: score.falseTriggerRate, updateHitRate: score.updateHitRate, byKind: score.byKind, errors: score.errors.map(error => ({ timeline: error.timeline, step: error.step, type: error.type, kind: error.kind ?? null })) });

async function runCell({ cell, fixture, model, effort, ledger }) {
  const judge = createJudge({ model, effort, ledger });
  if (cell === 'labelled') {
    const { raised, calls } = await labelledGate(fixture, judge, { onCall: call => process.stdout.write(call.parseError ? 'x' : call.parsed.outcome === 'meets' ? 'M' : '.') });
    const score = replay.score(fixture, raised, { attribute: { falseAlarm: 'gate false alarm', miss: labelledMissAttribution(calls) } });
    return { score, calls, raised };
  }
  const calls = [], relay = await startRelay(async text => { const result = await judge(text); process.stdout.write('g'); return result; }, calls);
  try {
    const { _electron: electron } = require('@playwright/test');
    const runs = await runReplay(fixture, { electron, gate: { chatReady: true, workerIsolation: true, relay: relay.url }, automatic: true, statusTimeoutMs: 15 * 60 * 1000 });
    const score = cells(fixture, runs, { gateRan: true }).proposed.score;
    return { score, calls, runs };
  } finally { await relay.close(); }
}

async function run(args) {
  const fixturePath = path.relative(repo, path.resolve(option(args, 'fixture', 'tests/fixtures/revisit-replay/fixture-v1.json'))).split(path.sep).join('/');
  const fixture = JSON.parse(await fs.readFile(path.join(repo, fixturePath), 'utf8'));
  replay.validateFixture(fixture);
  const perfect = replay.score(fixture, fixture.timelines.map(replay.perfectAnswers));
  if (perfect.setF1 !== 1) throw Error('Perfect-answer audit failed. Fix the labels before any scored run (D51-I04).');
  const models = option(args, 'models', 'claude-haiku-5-5').split(','), repeats = Number(option(args, 'repeats', '1'));
  const cellNames = option(args, 'cells', 'labelled,proposed').split(','), effort = option(args, 'effort', 'medium');
  const ledger = new SpendLedger({ cap: Number(option(args, 'cap', '40')) });
  for (const model of models) if (!prices[model]) throw Error(`Unknown model ${model}.`);
  const commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim();
  const dirty = execFileSync('git', ['status', '--porcelain', '--', 'app', 'scripts'], { cwd: repo, encoding: 'utf8' }).trim().length > 0;
  console.log(`Spent so far (all runs on this PC): $${ledger.total().toFixed(4)} of cap $${ledger.cap}.`);
  await fs.mkdir(path.join(repo, outDir), { recursive: true });
  for (const model of models) for (let repeat = 1; repeat <= repeats; repeat++) for (const cell of cellNames) {
    process.stdout.write(`${model} ${cell} fixture-v${fixture.version} repeat ${repeat}: `);
    const started = new Date().toISOString(), spentBefore = ledger.total();
    let result, failure = null;
    try { result = await runCell({ cell, fixture, model, effort, ledger }); }
    catch (error) { failure = error.message; }
    const record = {
      fixture: fixturePath, fixtureVersion: fixture.version, sha256: replay.fixtureHash(fixture), cell, model, effort, repeat, commit, dirty, started, finished: new Date().toISOString(),
      status: failure ? 'failed' : 'passed', failure,
      // From the spend ledger, so calls made before a failure are still counted.
      score: result && summary(result.score), costUsd: ledger.total() - spentBefore,
      calls: result?.calls ?? [],
      ...(result?.runs && { runs: result.runs }), ...(result?.raised && { raised: result.raised })
    };
    const file = `${outDir}/v${fixture.version}-${cell}-${model}-r${repeat}-${started.replace(/[:.]/g, '')}.json`;
    await fs.writeFile(path.join(repo, file), JSON.stringify(record, null, 2) + '\n');
    console.log(failure ? ` FAILED: ${failure}` : ` Set-F1 ${result.score.setF1.toFixed(3)}, $${record.costUsd.toFixed(4)}`);
    if (failure && /Spend cap reached/.test(failure)) return;
  }
}

// Report ---------------------------------------------------------------------------------
const pct = value => value === null || value === undefined ? 'n/a' : `${(value * 100).toFixed(1)}%`;
const mean = values => values.reduce((a, b) => a + b, 0) / values.length;
const sd = values => { if (values.length < 2) return null; const m = mean(values); return Math.sqrt(values.reduce((s, v) => s + (v - m) ** 2, 0) / (values.length - 1)); };
const cellNames = { labelled: 'Labelled evidence, gate decides (gate measured alone)', proposed: 'Retrieved evidence, gate decides (proposed system)' };

async function report() {
  const files = (await fs.readdir(path.join(repo, outDir))).filter(name => name.endsWith('.json')).sort();
  const records = [];
  for (const name of files) records.push({ file: `${outDir}/${name}`, ...JSON.parse(await fs.readFile(path.join(repo, outDir, name), 'utf8')) });
  const groups = new Map();
  for (const record of records) {
    const key = `${record.fixture}|${record.cell}|${record.model}|${record.effort}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(record);
  }
  const fixtures = [...new Set(records.map(record => `${record.fixture}|${record.sha256}`))];
  const total = records.reduce((sum, record) => sum + (record.costUsd || 0), 0);
  const lines = [];
  for (const fixtureKey of fixtures) {
    const [fixturePath, sha] = fixtureKey.split('|');
    lines.push(`### \`${fixturePath}\``, '', `sha256 \`${sha}\``, '');
    lines.push('| Cell | Model (effort) | Runs | Set-F1 mean (sd) | Set-F1 min–max | Precision mean | Recall mean | Mean TP / FP / FN | Invalid replies | Mean latency per call | Cost |', '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |');
    for (const [key, group] of [...groups].filter(([key]) => key.startsWith(`${fixturePath}|`)).sort()) {
      const [, cell, model, effort] = key.split('|'), passed = group.filter(record => record.status === 'passed');
      const f1 = passed.map(record => record.score.setF1), calls = passed.flatMap(record => record.calls.filter(call => call.elapsedMs));
      const invalid = passed.reduce((sum, record) => sum + record.score.errors.filter(error => error.type === 'invalid gate reply').length, 0);
      const failed = group.length - passed.length;
      if (!passed.length) { lines.push(`| ${cellNames[cell]} | ${model} (${effort}) | 0 passed, ${failed} failed | | | | | | | | |`); continue; }
      const deviation = sd(f1);
      lines.push(`| ${cellNames[cell]} | ${model} (${effort}) | ${passed.length}${failed ? ` (+${failed} failed)` : ''} | ${mean(f1).toFixed(3)}${deviation === null ? '' : ` (${deviation.toFixed(3)})`} | ${Math.min(...f1).toFixed(3)}–${Math.max(...f1).toFixed(3)} | ${pct(mean(passed.map(r => r.score.precision ?? 0)))} | ${pct(mean(passed.map(r => r.score.recall ?? 0)))} | ${['tp', 'fp', 'fn'].map(k => mean(passed.map(r => r.score[k])).toFixed(1)).join(' / ')} | ${invalid} | ${calls.length ? `${(mean(calls.map(c => c.elapsedMs)) / 1000).toFixed(1)} s` : 'n/a'} | $${group.reduce((s, r) => s + (r.costUsd || 0), 0).toFixed(4)} |`);
    }
    lines.push('', '#### Error attribution, summed over runs', '', '| Cell | Model | Error label | Count |', '| --- | --- | --- | --- |');
    for (const [key, group] of [...groups].filter(([key]) => key.startsWith(`${fixturePath}|`)).sort()) {
      const [, cell, model] = key.split('|'), counts = {};
      for (const record of group.filter(r => r.status === 'passed')) for (const error of record.score.errors) { const label = `${error.type}${error.kind ? ` (${error.kind})` : ''}`; counts[label] = (counts[label] || 0) + 1; }
      for (const [label, count] of Object.entries(counts).sort()) lines.push(`| ${cell} | ${model} | ${label} | ${count} |`);
    }
    lines.push('');
  }
  const failures = records.filter(record => record.status === 'failed');
  const text = `# Revisit Gate Evaluation (Anthropic API)

Status: **gate prompt measured with Claude models over the Anthropic API, on authored fixtures only.** This fills the two gate cells that the [revisit replay report](revisit-replay-report.md) leaves "not run", with a clearly different setup: the production gate runs through the signed-in Codex route (D56-I02) and has still not been run. These numbers describe the gate's prompt (\`buildPackage\`) and strict reply parser (\`parseReply\`) answered by API models. They are not a measurement of the shipped gate or its model.

Every number is **on these authored fixtures only**: small, synthetic, written before any scored run. They are not a statistical sample, not accuracy on real decisions, and not comparable to PM-Bench or MemoProAgent.

## Method

- **Gate measured alone** sends every labelled relevant condition for every evidence step to the model, in fixture order, with earlier outcomes for that condition in the package. Review-by dates are notified from the labels without a model, as the proposed system does. The package differs from production in two ways: the whole evidence text is the only passage, and provenance reads "Authored fixture capture (synthetic)."
- **Proposed system** replays each timeline through the real desktop app with automatic gate checks on. The app's controlled test gate forwards each package to a loopback relay in the evaluation script, which calls the API. Retrieval, duplicate suppression, notice rules and parsing are the app's own code.
- One model call per package and no rerolls (D56-I04). A run is one pass over the fixture; repeated runs measure how much the result moves between identical runs. Every run is kept, including failed ones (D57).
- System text is the Codex catalog's \`base_instructions\`. Thinking is the model default (adaptive); effort is set explicitly. No refusal fallback is used, because it would change the model under test.
- Scoring is the replay's own D54 code. Set-F1 = 2·TP / (2·TP + FP + FN). No composite score or pass threshold (D54-I07).
- Spend is checked against a cumulative cap before each call; total recorded spend for the runs below is **$${total.toFixed(4)}** (list prices, recomputed from reported usage).

## Results

${lines.join('\n')}
${failures.length ? `## Failed runs\n\n${failures.map(record => `- \`${record.file}\`: ${record.failure}`).join('\n')}\n` : ''}
## Raw outputs

Each run's packages, replies, parse results, usage, latency and scores are in \`${outDir}/\`. Source commit and whether the app or scripts had uncommitted changes are recorded per run.

## Limits

- Same limits as the replay report: one author, small fixtures, labelled before scoring. A model-written fixture (version 2) reduces but does not remove author bias, and the generating model may share blind spots with the models it is used to test.
- Retrieval misses on paraphrase triggers cap the proposed system's recall; no gate can recover them (D25).
- API models are not the production model. A different model, effort or route can behave differently.
`;
  await fs.writeFile(path.join(repo, reportPath), text);
  console.log(`Wrote ${reportPath} from ${records.length} run(s).`);
}

async function main() {
  const args = process.argv.slice(2);
  if (!args.includes('--report-only')) await run(args);
  await report();
}
if (require.main === module) main().catch(error => { console.error(error.message); process.exit(1); });
module.exports = { startRelay, report };
