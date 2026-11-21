const { test, expect, _electron: electron } = require('@playwright/test');
const replay = require('../app/revisit-replay');
const { runReplay, renderReport, cells } = require('../scripts/revisit-replay.cjs');
const fixture = require('./fixtures/revisit-replay/fixture-v1.json');

// Harness tests (D56-I01): they verify the replay, scoring and attribution code with
// controlled gate replies. They are not evidence about model judgment.
const small = () => ({ ...fixture, timelines: fixture.timelines.filter(timeline => ['B-decoder', 'N1-unrelated', 'N2-no-conditions'].includes(timeline.id)) });
const meta = { fixturePath: 'tests/fixtures/revisit-replay/fixture-v1.json', commit: 'test', dirty: false, rawPath: 'raw.json', generatedAt: 'GENERATED' };

test('Set-F1 and its parts match a hand-computed three-step toy timeline with silence and a repeat', () => {
  const toy = { fixture: 'revisit-replay', version: 0, timelines: [
    { id: 'T', steps: [
      { id: 'T1', at: '1', type: 'decision', decision: 'D', due: [], draft: { conditions: [{ ref: 'C' }] } },
      { id: 'T2', at: '2', type: 'evidence', evidence: 'E1', kind: 'trigger:cue', relevant: ['D/C'], due: [{ decision: 'D', condition: 'C', conditionVersion: 1, evidence: 'E1' }] },
      { id: 'T3', at: '3', type: 'evidence', evidence: 'E2', kind: 'near-miss:opposite', relevant: ['D/C'], due: [{ decision: 'D', condition: 'C', conditionVersion: 1, evidence: 'E1' }] },
      { id: 'T4', at: '4', type: 'evidence', evidence: 'E3', kind: 'trigger:paraphrase', relevant: ['D/C'], due: [{ decision: 'D', condition: 'C', conditionVersion: 1, evidence: 'E1' }, { decision: 'D', condition: 'C', conditionVersion: 1, evidence: 'E3' }] }
    ] },
    { id: 'N', negative: true, steps: [{ id: 'N1', at: '1', type: 'evidence', evidence: 'X', kind: 'unrelated', relevant: [], due: [] }] }
  ] };
  const notice = evidence => ({ decision: 'D', condition: 'C', conditionVersion: 1, evidence });
  // Step T2: the due notice (TP). Step T3: a false alarm on the near miss and a repeat of
  // E1 (2 FP). Step T4: E3 is missed (FN). Negative timeline: one false trigger (FP).
  const raised = [[[], [notice('E1')], [notice('E2'), notice('E1')], []], [[notice('X')]]];
  const result = replay.score(toy, raised);
  expect({ tp: result.tp, fp: result.fp, fn: result.fn, repeats: result.repeats }).toEqual({ tp: 1, fp: 3, fn: 1, repeats: 1 });
  expect(result.setF1).toBeCloseTo(2 / (2 + 3 + 1), 10);
  expect(result.precision).toBeCloseTo(1 / 4, 10);
  expect(result.recall).toBeCloseTo(1 / 2, 10);
  expect(result.falseTriggerRate).toBe(1);
  expect(result.byKind['near-miss:opposite']).toEqual({ tp: 0, fp: 1, fn: 0 });
});

test('D51-I04: the perfect-answer run scores 100% on the frozen fixture and a corrupted label makes it fail', () => {
  expect(replay.validateFixture(fixture)).toEqual({ triggers: 12, nearMisses: 12, negatives: 2 });
  const perfect = replay.score(fixture, fixture.timelines.map(replay.perfectAnswers));
  expect({ setF1: perfect.setF1, fp: perfect.fp, fn: perfect.fn, updateHitRate: perfect.updateHitRate }).toEqual({ setF1: 1, fp: 0, fn: 0, updateHitRate: 1 });
  const corrupted = structuredClone(fixture);
  corrupted.timelines[1].steps[2].due[0].conditionVersion = 1;
  expect(() => replay.validateFixture(corrupted)).not.toThrow();
  expect(replay.score(corrupted, corrupted.timelines.map(replay.perfectAnswers)).setF1).toBeLessThan(1);
  const invalid = structuredClone(fixture);
  invalid.timelines[0].steps[1].due[0].conditionVersion = 3;
  expect(() => replay.validateFixture(invalid)).toThrow(/before it exists/);
});

test('D53-I02 D56: with the gate closed, the baseline is scored, a superseded near miss is a stale-state error, and gate cells are not run', async () => {
  test.setTimeout(120000);
  const subset = small(), runs = await runReplay(subset, { electron });
  const result = cells(subset, runs, { gateRan: false });
  const stale = result.baseline.score.errors.find(error => error.notice?.evidence === 'EB2');
  expect(stale).toMatchObject({ type: 'stale-state error', kind: 'near-miss:superseded' });
  expect(result.proposed.status).toBe('not run');
  expect(result.labelledGate.status).toBe('not run');
  // The paraphrase trigger shares no cue term with its condition: a retrieval miss.
  expect(result.retrieval.errors).toContainEqual(expect.objectContaining({ type: 'retrieval miss', kind: 'trigger:paraphrase' }));
  const report = renderReport(subset, runs, { ...meta, gateRan: false });
  expect(report).toContain('| Retrieved evidence, gate decides (proposed system) | **not run** |');
  expect(report).toContain('| Labelled evidence, gate decides (gate measured alone) | **not run** |');
  expect(report).toMatch(/\| Retrieved evidence, notify on any match \(document-search baseline\) \| passed \| \d\.\d{3} \|/);
  expect(report).toContain('on these authored fixtures only');
});

test('D55 determinism: controlled replies attribute a gate miss and a retrieval miss, and two replays give identical reports', async () => {
  test.setTimeout(180000);
  const gate = { chatReady: true, workerIsolation: true, replies: [
    { contains: 'two FLAC files and one Opus file', reply: { outcome: 'does not meet', reason: 'Controlled: deliberately wrong.', quote: '' } },
    { reply: { outcome: 'does not meet', reason: 'Controlled: not met.', quote: '' } }
  ] };
  const subset = small();
  const first = await runReplay(subset, { electron, gate, automatic: true });
  const result = cells(subset, first, { gateRan: true });
  expect(result.proposed.score.tp).toBe(0);
  expect(result.proposed.score.errors).toContainEqual(expect.objectContaining({ type: 'gate miss', kind: 'trigger:cue' }));
  expect(result.proposed.score.errors).toContainEqual(expect.objectContaining({ type: 'retrieval miss', kind: 'trigger:paraphrase' }));
  const second = await runReplay(subset, { electron, gate, automatic: true });
  expect(renderReport(subset, second, { ...meta, gateRan: true })).toBe(renderReport(subset, first, { ...meta, gateRan: true }));
});
