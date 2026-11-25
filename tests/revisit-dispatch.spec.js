const { test, expect } = require('@playwright/test');
const fs = require('node:fs/promises');
const path = require('node:path');
const { Vault } = require('../app/vault');
const { Context } = require('../app/context');
const { Revisit } = require('../app/revisit');
const { Conversations } = require('../app/conversations');
const { CaptureDeletion } = require('../app/capture-deletion');
const { Intake } = require('../app/intake');
const { revisionAdmission } = require('../app/source-authority');

const now = '2026-11-25T09:00:00Z';
async function fixture(testInfo) {
  const vault = new Vault(testInfo.outputPath('vault'), 'Companion');
  await vault.setup();
  const context = new Context(vault, { scopeFile: testInfo.outputPath('scope.json') });
  const inputs = [], gate = {
    status: async () => ({ open: true }),
    async send(text, mode, status, beforeStart, passages) {
      const verify = await beforeStart();
      await gate.beforeVerify?.();
      verify(); inputs.push(text);
      await gate.afterSend?.();
      return { model: 'fixture', usage: { total: 23 }, effective: { modelProvider: 'fixture' }, evidence: 'controlled',
        reply: JSON.stringify({ outcome: 'meets', quote: passages[0].text, reason: 'Controlled model reason CANARY-REASON.' }) };
    }
  };
  const revisit = new Revisit(vault, { getEvidence: (_, options) => context.corpus(options), gate });
  const record = revisit.decisions.build({ title: 'Threshold decision', choice: 'Keep the threshold.', conditions: [
    { kind: 'evidence', label: 'Threshold', trigger: 'A threshold was measured.', action: 'Review measurement.', cueTerms: ['threshold', 'retries'] }
  ] }, null, now);
  await revisit.publishDecision(record, 0, { now });
  await revisit.settings({ automatic: true, cap: 2, now });
  const capture = async text => (await vault.find(await vault.capture({ text }, now))).file;
  const check = (trigger = 'scheduled', gate = true) => revisit.check({ trigger, gate, now, timezone: 'UTC' });
  return { vault, revisit, gate, inputs, capture, check, state: () => revisit.readState().state };
}

async function restore(vault, info, selection) {
  const getVault = () => vault, clock = () => ({ now });
  const conversations = new Conversations({ dataRoot: info.outputPath('history'), getVault, clock });
  await conversations.lock(async () => {});
  const deletion = new CaptureDeletion({ getVault, clock, conversations, clearApprovals() {} });
  await deletion.confirm((await deletion.preview(selection.id)).token);
  await deletion.confirmRestoration((await deletion.previewRestoration(selection)).token);
}

function orderCorpus(f, firstKey, originalFirst) {
  const read = f.revisit.getEvidence;
  f.revisit.getEvidence = async (...args) => {
    const corpus = await read(...args);
    corpus.all.sort((a, b) => ((b.key === firstKey) - (a.key === firstKey)) * (originalFirst ? 1 : -1) || a.key.localeCompare(b.key));
    return corpus;
  };
}

for (const incremental of [false, true]) for (const originalFirst of [false, true]) {
  const ordering = `${incremental ? 'incremental' : 'batched'}, original ${originalFirst ? 'first' : 'last'}`;
  test(`a current judgment suppresses all matching members across a changed digest (${ordering})`, async ({}, info) => {
    const f = await fixture(info), original = await f.capture('Threshold < 5');
    await f.check();
    const [judged] = f.state().candidates;
    orderCorpus(f, judged.evidence.key, originalFirst);
    await fs.appendFile(original, '\nIndependent editorial note.\n');
    if (incremental) await f.check();
    await f.capture('Threshold < 5');
    await f.check(); await f.check();
    const peers = f.state().candidates.filter(candidate => candidate.id !== judged.id);
    expect(peers).toHaveLength(2);
    for (const peer of peers) expect(peer).toMatchObject({ status: 'duplicate', duplicateOf: judged.id });
    expect(f.inputs).toHaveLength(1);
    expect(f.state().notices).toHaveLength(1);
  });

  test(`loss of an unjudged representative promotes exactly one surviving match (${ordering})`, async ({}, info) => {
    const f = await fixture(info);
    f.gate.status = async () => ({ open: false, reason: 'Closed for controlled intake.' });
    const first = await f.capture('Threshold < 5'), id = (await f.vault.list()).find(note => note.file === first).id;
    orderCorpus(f, 'capture:' + id, originalFirst);
    if (incremental) await f.check();
    await f.capture('Threshold < 5'); await f.capture('Threshold < 5'); await f.check();
    const before = f.state().candidates;
    const representatives = before.filter(candidate => candidate.status === 'pending');
    expect(representatives).toHaveLength(1);
    const [representative] = representatives;
    expect(representative.evidence.key).toBe(before.map(candidate => candidate.evidence.key).sort()[0]);
    const file = (await f.vault.find(representative.evidence.key.slice('capture:'.length))).file;
    await fs.unlink(file);
    await f.check(); await f.check();
    const after = f.state().candidates;
    expect(after.find(candidate => candidate.id === representative.id).status).toBe('withdrawn');
    const survivors = after.filter(candidate => candidate.status === 'pending');
    expect(survivors).toHaveLength(1);
    expect(after.find(candidate => candidate.status === 'duplicate').duplicateOf).toBe(survivors[0].id);
    expect(f.inputs).toHaveLength(0);
    f.gate.status = async () => ({ open: true });
    await f.check(); await f.check();
    expect(f.inputs).toHaveLength(1);
    expect(f.state().notices.map(n => n.candidateId)).toEqual([survivors[0].id]);
    expect(f.inputs[0]).not.toMatch(/Earlier matched passage/);
  });
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

test('a surviving peer retains completed local judgment coverage until its own source is withdrawn', async ({}, info) => {
  const f = await fixture(info);
  await f.capture('Threshold < 5'); await f.capture('Threshold < 5');
  await f.check(); await f.check();
  const judged = f.state().candidates.find(candidate => candidate.status === 'meets');
  const covered = f.state().candidates.find(candidate => candidate.status === 'duplicate');
  expect(covered.judgedBy).toBe(judged.id);
  await fs.unlink((await f.vault.find(judged.evidence.key.slice('capture:'.length))).file);
  await f.check(); await f.check();
  expect(f.inputs).toHaveLength(1);
  expect(f.state().notices).toHaveLength(1);
  expect(f.state().notices[0].status).toBe('evidence removed');
  await fs.unlink((await f.vault.find(covered.evidence.key.slice('capture:'.length))).file);
  await f.check();
  await f.capture('Threshold < 5'); await f.check(); await f.check();
  expect(f.inputs).toHaveLength(2);
  expect(f.inputs[1]).not.toMatch(/Earlier matched passage|CANARY-REASON/);
  expect(f.state().notices).toHaveLength(2);
});

test('a later identical copy cannot bypass a held representative’s retry budget', async ({}, info) => {
  const f = await fixture(info);
  f.gate.afterSend = async () => { throw Error('Controlled malformed response.'); };
  await f.capture('Threshold < 5');
  for (let i = 0; i < 3; i++) await f.check();
  const [held] = f.state().candidates;
  expect(held.status).toBe('held');
  await f.capture('Threshold < 5'); await f.check(); await f.check();
  expect(f.inputs).toHaveLength(3);
  expect(f.state().candidates.at(-1)).toMatchObject({ status: 'duplicate', duplicateOf: held.id });
  await f.revisit.retry({ candidate: held.id, now });
  await f.check(); await f.check();
  expect(f.inputs).toHaveLength(4);
  expect(f.state().candidates.find(c => c.id === held.id).status).toBe('held');
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
  const secondFile = await f.capture('Threshold > 5'); await f.check('manual', false);
  expect(f.state().candidates.map(c => c.status)).toEqual(['meets', 'pending']);
  await f.revisit.decisions.lock(async () => {
    const { state, proof } = f.revisit.readState();
    const [first, second] = state.candidates;
    first.fingerprint = second.fingerprint = 'legacy-colliding-hash';
    Object.assign(second, { status: 'duplicate', duplicateOf: first.id });
    await f.revisit.writeState(state, proof);
  });
  const offlineFile = info.outputPath('temporarily-unavailable.md');
  await fs.rename(secondFile, offlineFile);
  await f.check();
  expect(f.state().candidates[1]).toMatchObject({ status: 'duplicate', fingerprint: 'legacy-colliding-hash' });
  await fs.rename(offlineFile, secondFile);
  await f.check();
  expect(f.inputs).toHaveLength(2);
  expect(f.state().notices).toHaveLength(2);
  await f.capture('Threshold > 5'); await f.check();
  expect(f.state().candidates.at(-1).status).toBe('duplicate');
  expect(f.inputs).toHaveLength(2);
});

test('unrelated edits preserve the local duplicate marker without admitting stale history, while a changed threshold gets a new judgment', async ({}, info) => {
  const f = await fixture(info), file = await f.capture('Threshold < 5');
  await f.check();
  const [original] = f.state().candidates;
  await fs.appendFile(file, '\nAn unrelated editorial note.\n');
  await f.check();
  await f.check();
  const edited = f.state().candidates.at(-1);
  expect(edited.evidence.digest).not.toBe(original.evidence.digest);
  expect(edited).toMatchObject({ status: 'duplicate', duplicateOf: original.id, fingerprint: original.fingerprint });
  await f.capture('Threshold < 5'); await f.check();
  expect(f.state().candidates.at(-1)).toMatchObject({ status: 'duplicate', duplicateOf: original.id });
  expect(f.inputs).toHaveLength(1);
  expect(f.state().notices).toHaveLength(1);
  const text = await fs.readFile(file, 'utf8');
  await fs.writeFile(file, text.replaceAll('Threshold < 5', 'Threshold > 5'));
  await f.check();
  expect(f.inputs).toHaveLength(2);
  expect(f.inputs[1]).toContain('Threshold > 5');
  expect(f.inputs[1]).not.toMatch(/Threshold < 5|CANARY-REASON|Earlier matched passage/);
  expect(f.state().notices).toHaveLength(2);
});

test('same-byte manual restoration cannot revive a prior verdict or a current reviewed package', async ({}, info) => {
  const f = await fixture(info), file = await f.capture('Threshold original reading.');
  const backup = info.outputPath('manual-backup.md');
  await fs.copyFile(file, backup);
  await f.check();
  const [old] = f.state().candidates, id = old.evidence.key.slice('capture:'.length);
  await f.capture('Threshold separate reading.'); await f.check('manual', false);
  const reviewed = await f.revisit.previewPackage({ candidate: f.state().candidates[1].id });
  expect(reviewed.text).toContain('Earlier matched passage');
  await restore(f.vault, info, { id, file: backup });
  expect(await fs.readFile(file)).toEqual(await fs.readFile(backup));
  expect((await f.revisit.sendReviewed({ ...reviewed, now })).error).toBeTruthy();
  expect(f.inputs).toHaveLength(1);
  await f.check('manual', false);
  const ledger = await new Intake(f.vault).info(), generation = ledger.sourceAuthority[id].generation;
  const fresh = f.state().candidates.find(c => c.evidence.sourceGenerations?.[0].generation === generation);
  expect(fresh).toMatchObject({ status: 'pending', evidence: { key: old.evidence.key, digest: old.evidence.digest } });
  expect(f.state().notices[0].status).toBe('evidence removed');
  const current = await f.revisit.previewPackage({ candidate: fresh.id });
  expect(current.text).not.toContain('Earlier matched passage');
  f.gate.beforeVerify = () => restore(f.vault, info, { id, file: backup });
  expect((await f.revisit.sendReviewed({ ...current, now })).error).toBeTruthy();
  expect(f.inputs).toHaveLength(1);
  f.gate.beforeVerify = undefined;
  await f.check();
  const newest = f.state().candidates.at(-1);
  expect(newest.status).toBe('meets');
  expect(newest.evidence.sourceGenerations[0].generation).not.toBe(generation);
  expect(f.state().notices.at(-1).evidence.sourceGenerations).toEqual(newest.evidence.sourceGenerations);
});

test('restored imported evidence retains its fresh revision admission and rejects legacy attribution', async ({}, info) => {
  const f = await fixture(info), intake = new Intake(f.vault);
  const producer = info.outputPath('producer'), folder = path.join(producer, 'draft'), clip = 'b'.repeat(64), hash = 'a'.repeat(64);
  const draft = require('./fixtures/reel-draft/example.json');
  await fs.mkdir(folder, { recursive: true });
  await fs.writeFile(path.join(folder, 'run.json'), JSON.stringify({ job_id: clip, attempt_id: '1'.repeat(32), started_utc: now, input_sha256: hash, input_kind: 'local_video', result_kind: 'local_video_unreviewed', state: 'partial', validation: 'passed' }));
  await fs.writeFile(path.join(folder, 'evidence.json'), JSON.stringify({ ...draft.input, clip_id: clip }));
  await fs.writeFile(path.join(folder, 'first-pass-target.json'), JSON.stringify(draft.target));
  await fs.copyFile(path.join(__dirname, 'fixtures/reel-draft/notes.md'), path.join(folder, 'notes.md'));
  const { captures } = await intake.connect(producer, true, now);
  await f.check();
  const [original] = f.state().candidates, id = captures[hash].id;
  await restore(f.vault, info, { id, kind: 'draft', folder });
  await f.check('manual', false);
  const fresh = f.state().candidates.at(-1), ledger = await intake.info();
  expect(fresh.evidence.revisionId).not.toBe(original.evidence.revisionId);
  const admission = revisionAdmission(ledger, fresh.evidence.revisionId);
  expect(fresh.evidence.sourceGenerations).toEqual([{ captureId: id, generation: admission.sourceGeneration }]);
  await f.revisit.decisions.lock(async () => {
    const { state, proof } = f.revisit.readState();
    delete state.candidates.at(-1).evidence.sourceGenerations;
    await f.revisit.writeState(state, proof);
  });
  const legacy = await f.revisit.previewPackage({ candidate: fresh.id });
  expect((await f.revisit.sendReviewed({ ...legacy, now })).error).toContain('unavailable');
  expect(f.inputs).toHaveLength(1);
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
  await f.capture('Threshold CANARY-SOURCE was measured.'); await f.check();
  expect(f.inputs).toHaveLength(2);
  expect(f.inputs[1]).not.toMatch(/CANARY-REASON|Earlier matched passage/);
  expect(f.state().notices).toHaveLength(1);
});
