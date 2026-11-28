const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test, expect, _electron: electron } = require('@playwright/test');
const replay = require('../app/revisit-replay');
const { ControlledGate } = require('../app/revisit-gate');
const { runReplay, cells } = require('../scripts/revisit-replay.cjs');
const { startRelay } = require('../scripts/revisit-gate-eval.cjs');
const { SpendLedger, createJudge } = require('../scripts/gate-eval/anthropic-gate.cjs');
const { labelledGate, labelledMissAttribution } = require('../scripts/gate-eval/labelled-gate.cjs');
const fixture = require('./fixtures/revisit-replay/fixture-v1.json');

// Harness tests for the API gate evaluation. Every judge here is a local function: no
// network, no key, no spend. They verify the evaluation code, not model judgment.

// Answers from the fixture labels, keyed by evidence id and condition label.
function labelJudge() {
  const answers = new Map();
  for (const timeline of fixture.timelines) {
    const drafts = new Map();
    for (const step of timeline.steps) {
      if (step.type === 'decision') drafts.set(step.decision, step.draft);
      if (step.type !== 'evidence') continue;
      for (const ref of step.relevant) {
        const [decision, condition] = ref.split('/'), label = drafts.get(decision).conditions.find(item => item.ref === condition).label;
        answers.set(`${step.evidence}|${label}`, { meets: (step.meets || []).includes(ref), text: step.text });
      }
    }
  }
  return async text => {
    const evidence = text.match(/^Source: (\S+)\.md\./m)[1], label = text.match(/^Label: (.*)$/m)[1];
    const answer = answers.get(`${evidence}|${label}`);
    return { reply: JSON.stringify(answer.meets ? { outcome: 'meets', reason: 'Label.', quote: answer.text } : { outcome: 'does not meet', reason: 'Label.', quote: '' }), model: 'label-judge', usage: null };
  };
}

test('gate measured alone: a judge answering from the labels scores 1.000 and sends each labelled condition once', async () => {
  const { raised, calls } = await labelledGate(fixture, labelJudge());
  const score = replay.score(fixture, raised, { attribute: { falseAlarm: 'gate false alarm', miss: labelledMissAttribution(calls) } });
  expect({ setF1: score.setF1, fp: score.fp, fn: score.fn }).toEqual({ setF1: 1, fp: 0, fn: 0 });
  const expected = fixture.timelines.flatMap(t => t.steps).filter(s => s.type === 'evidence').reduce((n, s) => n + s.relevant.length, 0);
  expect(calls).toHaveLength(expected);
  // A repeat near miss carries the earlier outcome for its condition in the package.
  const repeat = calls.find(call => call.kind === 'near-miss:repeat');
  expect(repeat.text).toMatch(/## Earlier outcomes for this condition\n- .*: meets\./);
});

test('gate measured alone: unparseable replies are attributed as invalid, not as wrong judgments', async () => {
  const { raised, calls } = await labelledGate(fixture, async () => ({ reply: 'Yes, it meets the condition.' }));
  const score = replay.score(fixture, raised, { attribute: { falseAlarm: 'gate false alarm', miss: labelledMissAttribution(calls) } });
  expect(score.tp).toBe(4); // review-by dates need no model
  expect(score.errors.filter(error => error.type === 'invalid gate reply').length).toBeGreaterThan(0);
  expect(score.errors.some(error => error.type === 'gate miss')).toBe(false);
});

test('D51-I04 D52-I04: model-written fixture v2 passes every structural check and its perfect-answer audit, and its due sets are the cumulative labels', () => {
  const { extraProblems, withDue } = require('../scripts/gate-eval/generate-fixture.cjs');
  const v2 = require('./fixtures/revisit-replay/fixture-v2.json');
  expect(replay.validateFixture(v2)).toEqual({ triggers: 14, nearMisses: 15, negatives: 2 });
  expect(extraProblems(v2)).toEqual([]);
  expect(replay.score(v2, v2.timelines.map(replay.perfectAnswers)).setF1).toBe(1);
  expect(withDue(structuredClone(v2))).toEqual(v2);
  // The same derivation reproduces the hand-written v1 due sets exactly.
  expect(withDue(structuredClone(fixture))).toEqual(fixture);
});

test('spend ledger refuses a call whose worst case passes the cumulative cap, and records actual cost', async () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'companion-spend-')), 'spend.jsonl');
  const ledger = new SpendLedger({ cap: 0.5, file });
  const client = { messages: { create: async () => ({ model: 'claude-opus-5-5', stop_reason: 'end_turn', content: [{ type: 'text', text: 'ok' }], usage: { input_tokens: 1000, output_tokens: 1000 } }) } };
  const judge = createJudge({ model: 'claude-opus-5-5', effort: 'medium', ledger, client });
  const result = await judge('package');
  expect(result.costUsd).toBeCloseTo((1000 * 4 + 1000 * 20) / 1e6, 10);
  expect(ledger.total()).toBeCloseTo(0.024, 10);
  fs.appendFileSync(file, JSON.stringify({ costUsd: 0.4 }) + '\n');
  await expect(judge('package')).rejects.toThrow(/Spend cap reached/);
});

test('controlled gate accepts only a loopback relay URL', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'companion-relay-'));
  fs.writeFileSync(path.join(root, 'revisit-gate.json'), JSON.stringify({ chatReady: true, workerIsolation: true, relay: 'https://example.com/gate' }));
  const gate = new ControlledGate(root);
  await expect(gate.send('text', 'automatic', {}, async () => () => {}, [])).rejects.toThrow(/loopback/);
});

test('proposed system through the relay: the desktop app forwards packages and the replay scores the replies', async () => {
  test.setTimeout(180000);
  const subset = { ...fixture, timelines: fixture.timelines.filter(timeline => ['B-decoder', 'N1-unrelated', 'N2-no-conditions'].includes(timeline.id)) };
  const calls = [], relay = await startRelay(async () => ({ reply: JSON.stringify({ outcome: 'does not meet', reason: 'Relay test.', quote: '' }), model: 'relay-test', usage: null }), calls);
  try {
    const runs = await runReplay(subset, { electron, gate: { chatReady: true, workerIsolation: true, relay: relay.url }, automatic: true });
    const result = cells(subset, runs, { gateRan: true });
    expect(calls.length).toBeGreaterThan(0);
    expect(calls[0].text).toContain('Companion revisit gate.');
    expect(result.proposed.score.tp).toBe(0);
    expect(result.proposed.score.errors).toContainEqual(expect.objectContaining({ type: 'gate miss', kind: 'trigger:cue' }));
  } finally { await relay.close(); }
});
