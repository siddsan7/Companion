const { test, expect } = require('@playwright/test');
const fs = require('node:fs/promises');
const { Vault } = require('../app/vault');
const { Context } = require('../app/context');
const { Revisit } = require('../app/revisit');

const now = '2026-11-25T09:00:00Z';
async function fixture(testInfo) {
  const vault = new Vault(testInfo.outputPath('vault'), 'Companion');
  await vault.setup();
  const context = new Context(vault, { scopeFile: testInfo.outputPath('scope.json') });
  const inputs = [], gate = {
    status: async () => ({ open: true }),
    async send(text, mode, status, beforeStart) {
      const verify = await beforeStart();
      await gate.beforeVerify?.();
      verify(); inputs.push(text);
      await gate.afterSend?.();
      return { model: 'fixture', usage: { total: 23 }, effective: { modelProvider: 'fixture' }, evidence: 'controlled',
        reply: JSON.stringify({ outcome: 'meets', quote: 'Threshold', reason: 'Controlled model reason CANARY-REASON.' }) };
    }
  };
  const revisit = new Revisit(vault, { getEvidence: (_, options) => context.corpus(options), gate });
  const record = revisit.decisions.build({ title: 'Threshold decision', choice: 'Keep the threshold.', conditions: [
    { kind: 'evidence', label: 'Threshold', trigger: 'A threshold was measured.', action: 'Review measurement.', cueTerms: ['threshold'] }
  ] }, null, now);
  await revisit.publishDecision(record, 0, { now });
  await revisit.settings({ automatic: true, cap: 2, now });
  const capture = async text => (await vault.find(await vault.capture({ text }, now))).file;
  const check = (trigger = 'scheduled', gate = true) => revisit.check({ trigger, gate, now, timezone: 'UTC' });
  return { revisit, gate, inputs, capture, check, state: () => revisit.readState().state };
}

test('a prior result contributes only its eligible source passage and its revision is checked at dispatch', async ({}, info) => {
  const f = await fixture(info);
  const old = await f.capture('Threshold CANARY-SOURCE was measured.');
  await f.check();
  await f.capture('Threshold changed in another measurement.');
  await f.check('manual', false);
  const candidate = f.state().candidates.find(item => item.status === 'pending');
  const preview = await f.revisit.previewPackage({ candidate: candidate.id });
  expect(preview.text).toContain('Earlier matched passage (untrusted): # Threshold CANARY-SOURCE was measured.');
  expect(preview.text).not.toContain('CANARY-REASON');
  f.gate.beforeVerify = () => fs.unlink(old);
  const stopped = await f.revisit.sendReviewed({ ...preview, now });
  expect(stopped.error).toBeTruthy();
  expect(f.inputs).toHaveLength(1);
  f.gate.beforeVerify = undefined;
  await f.check();
  expect(f.state().notices[0].status).toBe('evidence removed');
  expect(f.inputs).toHaveLength(2);
  expect(f.inputs[1]).not.toMatch(/CANARY|Earlier matched passage/);
});

test('an overlapping successful check cannot replace a scheduled quota stop returned to its worker', async ({}, info) => {
  const f = await fixture(info);
  await f.capture('Threshold first observation.');
  let later;
  f.gate.afterSend = async () => {
    later = await f.check('manual');
    throw Error('Controlled usage limit.');
  };
  const earlier = await f.check();
  expect(earlier.lastRun).toMatchObject({ trigger: 'scheduled', status: 'stopped', sent: 1 });
  expect(later.lastRun).toMatchObject({ trigger: 'manual', status: 'complete', sent: 0 });
  expect(earlier.lastRun.run).not.toBe(later.lastRun.run);
  expect(f.state().lastRun.run).toBe(later.lastRun.run);
});

test('opposite threshold operators remain distinct, including cached duplicates from the older fingerprint', async ({}, info) => {
  const f = await fixture(info);
  await f.capture('Threshold < 5'); await f.check();
  await f.capture('Threshold > 5'); await f.check('manual', false);
  expect(f.state().candidates.map(c => c.status)).toEqual(['meets', 'pending']);
  await f.revisit.decisions.lock(async () => {
    const { state, proof } = f.revisit.readState();
    const [first, second] = state.candidates;
    first.fingerprint = second.fingerprint = 'legacy-colliding-hash';
    Object.assign(second, { status: 'duplicate', duplicateOf: first.id });
    await f.revisit.writeState(state, proof);
  });
  await f.check();
  expect(f.inputs).toHaveLength(2);
  expect(f.state().notices).toHaveLength(2);
  await f.capture('Threshold > 5'); await f.check();
  expect(f.state().candidates.at(-1).status).toBe('duplicate');
  expect(f.inputs).toHaveLength(2);
});

test('withdrawal after submission retains reply and usage locally and suppresses the notice and future history', async ({}, info) => {
  const f = await fixture(info), file = await f.capture('Threshold CANARY-SOURCE was measured.');
  f.gate.afterSend = async () => { await fs.unlink(file); await f.check('removal', false); };
  await f.check();
  const [candidate] = f.state().candidates;
  expect(candidate.status).toBe('withdrawn');
  expect(candidate.outcome).toBeUndefined();
  expect(candidate.attempts[0]).toMatchObject({ status: 'answered', suppressed: 'candidate withdrawn', usage: { total: 23 },
    model: 'fixture', effective: { modelProvider: 'fixture' }, outcome: 'meets', evidence: 'controlled' });
  expect(candidate.attempts[0].reply).toContain('CANARY-REASON');
  expect(f.state().notices).toHaveLength(0);
  f.gate.afterSend = undefined;
  await f.capture('Threshold new observation.'); await f.check();
  expect(f.inputs[1]).not.toMatch(/CANARY/);
  expect(f.state().notices).toHaveLength(1);
});
