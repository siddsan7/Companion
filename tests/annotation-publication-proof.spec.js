const { test, expect } = require('@playwright/test');
const fs = require('node:fs/promises');
const native = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { createHash, randomUUID } = require('node:crypto');
const { Vault } = require('../app/vault');
const { Intake } = require('../app/intake');
const { AnnotationRemoval } = require('../app/annotation-removal');
const { CaptureDeletion } = require('../app/capture-deletion');
const { Conversations } = require('../app/conversations');
const draft = require('./fixtures/reel-draft/example.json');

const now = '2026-11-08T06:59:00.000Z';
const later = '2026-11-09T06:59:00.000Z';
const id = 'd081d203-1749-4f98-8b86-b140f491f7ba';
const selectedWriting = 'Writing selected for a standalone annotation.';
const identity = async file => {
  const { dev, ino, nlink } = await fs.lstat(file, { bigint: true });
  return { dev, ino, nlink };
};
const readOptional = file => fs.readFile(file).catch(error => {
  if (error.code === 'ENOENT') return null;
  throw error;
});

async function writeDraft(producer, attempt, startedAt, { sourceHash = 'a'.repeat(64), clip = 'b'.repeat(64) } = {}) {
  const folder = path.join(producer, attempt);
  await fs.mkdir(folder, { recursive: true });
  await fs.writeFile(path.join(folder, 'run.json'), JSON.stringify({
    job_id: clip, attempt_id: attempt.repeat(32), started_utc: startedAt, input_sha256: sourceHash,
    input_kind: 'local_video', result_kind: 'local_video_unreviewed', state: 'partial', validation: 'passed'
  }));
  await fs.writeFile(path.join(folder, 'evidence.json'), JSON.stringify({ ...draft.input, clip_id: clip }));
  await fs.writeFile(path.join(folder, 'first-pass-target.json'), JSON.stringify(draft.target));
  await fs.copyFile(path.join(__dirname, 'fixtures/reel-draft/notes.md'), path.join(folder, 'notes.md'));
}

async function fixture(testInfo, checkpoint, kind = 'review') {
  const directory = testInfo.outputPath('vault'), producer = testInfo.outputPath('producer');
  await fs.mkdir(directory, { recursive: true });
  if (kind === 'draft') await writeDraft(producer, '1', now);
  else await fs.cp(path.join(__dirname, 'fixtures/reel-review/accept'), path.join(producer, 'accept'), { recursive: true });
  const vault = new Vault(await fs.realpath(directory), 'Companion', { checkpoint });
  await vault.setup();
  const intake = new Intake(vault), ledger = await intake.connect(producer, true, now, kind);
  expect(ledger.lastCheck.status).toBe('complete');
  const [[sourceHash, capture]] = Object.entries(ledger.captures);
  expect(capture).toBeDefined();
  return { vault, intake, producer, sourceHash, capture, input: { id, captureId: capture.id, text: selectedWriting },
    journal: path.join(intake.dir, 'annotation-intent.json'),
    stage: path.join(intake.dir, `annotation-${id}.stage`),
    note: path.join(vault.root, 'Annotations', `${id}.md`) };
}

async function published(context) {
  const { journal, stage, note, input } = context;
  const journalBytes = await fs.readFile(journal), intent = JSON.parse(journalBytes), journalIdentity = await identity(journal);
  const original = await identity(note);
  expect(intent).toMatchObject({ id: input.id, captureId: input.captureId });
  expect(intent.annotation).toContain(selectedWriting);
  expect(original.nlink).toBe(2n);
  expect(await identity(stage)).toEqual(original);
  for (const file of [stage, note]) expect(await fs.readFile(file, 'utf8')).toBe(intent.annotation);
  return { journalBytes, journalIdentity, intent, original };
}

test('standalone annotation preserves an equal-byte stage replacement after publication', async ({}, testInfo) => {
  const displaced = testInfo.outputPath('original-annotation.stage');
  let context, witness;
  context = await fixture(testInfo, async boundary => {
    if (boundary !== 'annotation-published') return;
    const proof = await published(context);
    await fs.rename(context.stage, displaced);
    await fs.writeFile(context.stage, proof.intent.annotation, { flag: 'wx' });
    const replacement = await identity(context.stage);
    expect(replacement).not.toEqual(proof.original);
    expect(replacement.nlink).toBe(1n);
    witness = { ...proof, replacement };
  });
  let refusal;
  try { await context.intake.addAnnotation(context.input, now); }
  catch (error) { refusal = error; }
  expect(witness, 'the exact published stage was displaced before retirement').toBeDefined();
  expect.soft(refusal).toBeInstanceOf(Error);
  expect.soft(await identity(context.stage).catch(error => error.code)).toEqual(witness.replacement);
  expect.soft((await readOptional(context.stage))?.toString('utf8')).toBe(witness.intent.annotation);
  expect.soft(await identity(context.journal).catch(error => error.code)).toEqual(witness.journalIdentity);
  expect.soft(await readOptional(context.journal)).toEqual(witness.journalBytes);
  for (const file of [context.note, displaced]) {
    expect(await identity(file)).toEqual(witness.original);
    expect(await fs.readFile(file, 'utf8')).toBe(witness.intent.annotation);
  }
});

test('standalone annotation preserves an in-place edit after publication', async ({}, testInfo) => {
  const addition = '\nIndependent annotation writing.\n';
  let context, witness;
  context = await fixture(testInfo, async boundary => {
    if (boundary !== 'annotation-published') return;
    const proof = await published(context);
    await fs.appendFile(context.note, addition);
    expect(await identity(context.stage)).toEqual(proof.original);
    expect(await fs.readFile(context.stage, 'utf8')).toBe(proof.intent.annotation + addition);
    witness = proof;
  });
  let refusal;
  try { await context.intake.addAnnotation(context.input, now); }
  catch (error) { refusal = error; }
  expect(witness, 'the published note and its stage share the edited inode').toBeDefined();
  expect.soft(refusal).toBeInstanceOf(Error);
  expect.soft(await identity(context.journal).catch(error => error.code)).toEqual(witness.journalIdentity);
  expect.soft(await readOptional(context.journal)).toEqual(witness.journalBytes);
  for (const file of [context.note, context.stage]) {
    expect.soft(await identity(file).catch(error => error.code)).toEqual(witness.original);
    expect.soft((await readOptional(file))?.toString('utf8')).toBe(witness.intent.annotation + addition);
  }
  const restarted = new Intake(new Vault(context.vault.vault, 'Companion'));
  await restarted.info();
  expect(await readOptional(context.journal)).toBeNull();
  expect(await readOptional(context.stage)).toBeNull();
  expect(await identity(context.note)).toEqual({ ...witness.original, nlink: 1n });
  expect(await fs.readFile(context.note, 'utf8')).toBe(witness.intent.annotation + addition);
  const held = path.join(context.intake.dir, `annotation-${id}.held.json`);
  expect(await fs.readFile(held)).toEqual(witness.journalBytes);
  expect(await restarted.annotations(context.input.captureId)).toMatchObject([{ id, content: witness.intent.annotation + addition }]);
  const removal = new AnnotationRemoval({ getVault: () => context.vault, clearApprovals() {} });
  expect(await removal.list()).toContainEqual(expect.objectContaining({ id, text: witness.intent.annotation, pending: true }));
  const preview = await removal.preview(id);
  expect(preview.targets).toEqual(expect.arrayContaining([context.note, held].map(file => path.relative(context.vault.vault, file).split(path.sep).join('/'))));
  await removal.confirm(preview.token);
  expect(await readOptional(held)).toBeNull();
  expect(await readOptional(context.note)).toBeNull();
});

test('standalone annotation restart preserves a foreign equal-byte output and allows a separate save', async ({}, testInfo) => {
  const interrupted = Error('Stopped after the annotation link.');
  const context = await fixture(testInfo, boundary => { if (boundary === 'annotation-published') throw interrupted; });
  await expect(context.intake.addAnnotation(context.input, now)).rejects.toBe(interrupted);
  const witness = await published(context);
  await fs.unlink(context.note);
  await fs.writeFile(context.note, witness.intent.annotation, { flag: 'wx' });
  const foreign = await identity(context.note);
  const restarted = new Intake(new Vault(context.vault.vault, 'Companion'));
  await restarted.addAnnotation({ ...context.input, id: randomUUID() }, later);
  expect(await identity(context.note)).toEqual(foreign);
  expect(await identity(context.stage)).toEqual({ ...witness.original, nlink: 1n });
  expect(await readOptional(context.journal)).toBeNull();
  expect(await fs.readFile(path.join(context.intake.dir, `annotation-${id}.held.json`))).toEqual(witness.journalBytes);
  const removal = new AnnotationRemoval({ getVault: () => context.vault, clearApprovals() {} });
  await expect(removal.preview(id)).rejects.toThrow(/scope changed|unknown copy/i);
});

for (const scenario of ['settles the unchanged published pair', 'preserves an absent output and its retained writing', 'allows explicit removal after interruption while retaining the intent']) test(`standalone annotation restart ${scenario}`, async ({}, testInfo) => {
  const context = await fixture(testInfo);
  const code = String.raw`
    const { Intake } = require('./app/intake');
    const { Vault } = require('./app/vault');
    const [directory, input, now] = process.argv.slice(1);
    const vault = new Vault(directory, 'Companion', { checkpoint: boundary => {
      if (boundary === 'annotation-published') process.exit(77);
    } });
    new Intake(vault).addAnnotation(JSON.parse(input), now).then(() => process.exit(78), error => {
      console.error(error);
      process.exit(79);
    });
  `;
  const child = spawn(process.execPath, ['-e', code, context.vault.vault, JSON.stringify(context.input), now], {
    cwd: path.join(__dirname, '..'), stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true
  });
  let stderr = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', part => { stderr += part; });
  const exit = await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code, signal) => resolve({ code, signal }));
  });
  expect(exit, stderr).toEqual({ code: 77, signal: null });
  const witness = await published(context);
  const restarted = new Intake(new Vault(context.vault.vault, 'Companion'));
  const removal = new AnnotationRemoval({ getVault: () => context.vault, clearApprovals() {} });
  const held = path.join(context.intake.dir, `annotation-${id}.held.json`);
  if (scenario === 'allows explicit removal after interruption while retaining the intent') {
    await fs.unlink(context.note);
    await fs.unlink(context.stage);
    const link = native.linkSync, interrupted = Error('Stopped with both names for the retained annotation intent.');
    native.linkSync = (from, to) => {
      link(from, to);
      if (from === context.journal && to === held) throw interrupted;
    };
    try { await expect(restarted.info()).rejects.toBe(interrupted); }
    finally { native.linkSync = link; }
    for (const file of [context.journal, held]) {
      expect(await identity(file)).toEqual({ ...witness.journalIdentity, nlink: 2n });
      expect(await fs.readFile(file)).toEqual(witness.journalBytes);
    }
    expect(await removal.list()).toContainEqual(expect.objectContaining({ id, text: witness.intent.annotation, pending: true }));
    const preview = await removal.preview(id);
    expect(preview.targets).toHaveLength(2);
    await removal.confirm(preview.token);
    await restarted.info();
    for (const file of [context.journal, held, context.note, context.stage]) expect(await readOptional(file)).toBeNull();
    return;
  }
  const withdrawn = scenario === 'preserves an absent output and its retained writing';
  if (withdrawn) await fs.unlink(context.note);
  await restarted.locked(() => restarted.load());
  if (withdrawn) {
    const independent = { ...context.input, id: randomUUID(), text: 'A separate standalone annotation.' };
    await restarted.addAnnotation(independent, later);
    expect.soft(await readOptional(context.note)).toBeNull();
    expect.soft(await identity(context.stage).catch(error => error.code)).toEqual({ ...witness.original, nlink: 1n });
    expect.soft(await readOptional(context.journal)).toBeNull();
    expect.soft(await readOptional(held)).toEqual(witness.journalBytes);
    expect.soft(await identity(held)).toEqual(witness.journalIdentity);
    expect(await removal.list()).toContainEqual(expect.objectContaining({ id, text: witness.intent.annotation, pending: true }));
    const preview = await removal.preview(id);
    expect(preview.targets).toEqual(expect.arrayContaining([context.stage, held].map(file => path.relative(context.vault.vault, file).split(path.sep).join('/'))));
    await removal.confirm(preview.token);
    expect(await readOptional(held)).toBeNull();
    expect(await readOptional(context.stage)).toBeNull();
    expect(await restarted.annotations(context.input.captureId)).toMatchObject([{ id: independent.id }]);
    await expect(restarted.info()).resolves.toMatchObject({ captures: expect.objectContaining({ [context.sourceHash]: expect.any(Object) }) });
    return;
  }
  expect(await fs.readFile(context.note, 'utf8')).toBe(witness.intent.annotation);
  expect(await identity(context.note)).toEqual({ ...witness.original, nlink: 1n });
  for (const file of [context.stage, context.journal]) await expect(fs.lstat(file)).rejects.toMatchObject({ code: 'ENOENT' });
  expect(await restarted.annotations(context.input.captureId)).toMatchObject([{ id, captureId: context.input.captureId }]);
});

test('ordinary conflict transfer preserves its only-copy writing when the published annotation moves', async ({}, testInfo) => {
  const displaced = testInfo.outputPath('moved-transfer.md');
  const transfer = 'Only-copy writing authored in the conflict transfer field.';
  let context, witness;
  context = await fixture(testInfo, async boundary => {
    if (boundary !== 'repair-annotation-published') return;
    const { vault, intake } = context;
    const journal = path.join(intake.dir, 'repair-intent.json');
    const bytes = await fs.readFile(journal), intent = JSON.parse(bytes), journalIdentity = await identity(journal);
    const note = path.join(vault.root, 'Annotations', `${intent.annotationId}.md`);
    const stage = path.join(intake.dir, `annotation-${intent.annotationId}.stage`);
    const original = await identity(note);
    expect(intent.tx.keptCurrent).toBeUndefined();
    expect(intent.annotation).toContain(transfer);
    expect(intent.tx.previous).not.toContain(transfer);
    expect(intent.tx.content).not.toContain(transfer);
    expect(original.nlink).toBe(2n);
    expect(await identity(stage)).toEqual(original);
    expect(await fs.readFile(note, 'utf8')).toBe(intent.annotation);
    await fs.rename(note, displaced);
    expect(await identity(displaced)).toEqual(original);
    witness = { journal, bytes, intent, journalIdentity, note, stage, original };
  }, 'draft');
  const { intake, producer, sourceHash, capture } = context;
  const destination = intake.destination(capture);
  await fs.appendFile(destination, '\nIndependent local capture writing.\n');
  const local = await fs.readFile(destination), localIdentity = await identity(destination);
  await writeDraft(producer, '2', later);
  const before = await intake.reconcile({ now: later }), block = before.blocks[sourceHash];
  expect(block).toBeDefined();
  const older = path.join(intake.dir, block.journal), olderBytes = await fs.readFile(older), olderIdentity = await identity(older);
  const ledger = path.join(intake.dir, 'ledger.json');
  const ledgerBytes = await fs.readFile(ledger);

  let refusal;
  try { await intake.resolveConflict({ sourceHash, text: transfer, localHash: createHash('sha256').update(local).digest('hex') }, later); }
  catch (error) { refusal = error; }
  expect(witness, 'the real annotation moved after it was linked and before the source transfer').toBeDefined();
  expect.soft(refusal).toBeInstanceOf(Error);
  expect.soft(await fs.readFile(ledger)).toEqual(ledgerBytes);
  expect.soft(JSON.parse(await fs.readFile(ledger)).attempts[witness.intent.tx.revision.identity]).toBeUndefined();
  expect.soft(await fs.readFile(destination)).toEqual(local);
  expect.soft(await identity(destination)).toEqual(localIdentity);
  expect(await fs.readFile(older)).toEqual(olderBytes);
  expect(await identity(older)).toEqual(olderIdentity);
  expect.soft(await readOptional(witness.journal)).toEqual(witness.bytes);
  expect.soft(await identity(witness.journal).catch(error => error.code)).toEqual(witness.journalIdentity);
  expect.soft((await readOptional(witness.stage))?.toString('utf8')).toBe(witness.intent.annotation);
  expect.soft(await identity(witness.stage).catch(error => error.code)).toEqual(witness.original);
  expect(await fs.readFile(displaced, 'utf8')).toBe(witness.intent.annotation);
  expect.soft(await identity(displaced)).toEqual(witness.original);
  for (const file of [witness.note, path.join(intake.dir, 'transaction.json')]) await expect(fs.lstat(file)).rejects.toMatchObject({ code: 'ENOENT' });
});

for (const altered of [true, false]) test(altered ?
  'ordinary conflict transfer preserves the prior conflict and capture when its annotation changes before admission' :
  'ordinary conflict transfer admits the incoming capture with the unchanged exact annotation', async ({}, testInfo) => {
  const transfer = 'Only-copy annotation text selected for final conflict admission.';
  const displaced = testInfo.outputPath('annotation-moved-at-final-admission.md');
  let context, witness;
  context = await fixture(testInfo, async boundary => {
    if (boundary !== 'intake-published' || !context) return;
    const { intake, vault } = context;
    const shared = path.join(intake.dir, 'transaction.json');
    const tx = JSON.parse(await fs.readFile(shared));
    if (!tx.resolution || tx.keptCurrent) return;
    const journal = path.join(intake.dir, 'repair-intent.json');
    const bytes = await fs.readFile(journal), intent = JSON.parse(bytes), journalIdentity = await identity(journal);
    expect(intent.tx).toEqual(tx);
    expect(intent.annotation).toContain(transfer);
    const note = path.join(vault.root, 'Annotations', `${intent.annotationId}.md`);
    const stage = path.join(intake.dir, `annotation-${intent.annotationId}.stage`);
    const original = await identity(note);
    expect(original.nlink).toBe(2n);
    expect(await identity(stage)).toEqual(original);
    expect(await fs.readFile(note, 'utf8')).toBe(intent.annotation);
    const ledger = JSON.parse(await fs.readFile(path.join(intake.dir, 'ledger.json')));
    expect(ledger.attempts[tx.revision.identity]).toBeUndefined();
    if (altered) await fs.rename(note, displaced);
    witness = { tx, journal, bytes, journalIdentity, intent, note, stage, original, shared };
  }, 'draft');
  const { intake, producer, sourceHash, capture } = context;
  const destination = intake.destination(capture);
  await fs.appendFile(destination, '\nLocal capture writing before final conflict admission.\n');
  const local = await fs.readFile(destination), localIdentity = await identity(destination);
  await writeDraft(producer, '2', later);
  const before = await intake.reconcile({ now: later }), block = before.blocks[sourceHash];
  expect(block).toBeDefined();
  const older = path.join(intake.dir, block.journal), olderBytes = await fs.readFile(older), olderIdentity = await identity(older);

  let refusal;
  try { await intake.resolveConflict({ sourceHash, text: transfer, localHash: createHash('sha256').update(local).digest('hex') }, later); }
  catch (error) { refusal = error; }
  expect(witness, 'the ordinary source reached its actual pre-admission publication checkpoint').toBeDefined();
  const ledger = JSON.parse(await fs.readFile(path.join(intake.dir, 'ledger.json')));
  const { tx, journal, bytes, journalIdentity, intent, note, stage, original, shared } = witness;
  expect(await fs.readFile(older)).toEqual(olderBytes);
  expect(await identity(older)).toEqual(olderIdentity);
  if (altered) {
    expect(refusal).toBeInstanceOf(Error);
    expect.soft(ledger.blocks[sourceHash]).toMatchObject({ incomingRevision: block.incomingRevision });
    expect.soft(ledger.captures[sourceHash].currentRevision).toBe(before.captures[sourceHash].currentRevision);
    expect(ledger.attempts[tx.revision.identity]).toBeUndefined();
    expect.soft(await readOptional(destination)).toEqual(local);
    const restored = await identity(destination).catch(error => ({ code: error.code }));
    expect.soft(restored).toMatchObject({ dev: localIdentity.dev, ino: localIdentity.ino });
    expect(await readOptional(note)).toBeNull();
    expect(await fs.readFile(displaced, 'utf8')).toBe(intent.annotation);
    expect(await identity(displaced)).toEqual(original);
    expect(await fs.readFile(stage, 'utf8')).toBe(intent.annotation);
    expect(await identity(stage)).toEqual(original);
    const archivedIntent = path.join(intake.dir, `repair-${intent.annotationId}.json`);
    expect.soft(await readOptional(archivedIntent)).toEqual(bytes);
    expect.soft(await identity(archivedIntent).catch(error => error.code)).toEqual(journalIdentity);
    for (const file of [journal, shared]) expect.soft(await readOptional(file)).toBeNull();
  } else {
    expect(refusal).toBeUndefined();
    expect(ledger.blocks[sourceHash]).toBeUndefined();
    expect(ledger.attempts[tx.revision.identity]).toMatchObject({ status: 'imported', revision: tx.revision.id });
    expect(ledger.captures[sourceHash].currentRevision).toBe(tx.revision.id);
    expect(await fs.readFile(destination, 'utf8')).toBe(tx.content);
    expect(await fs.readFile(note, 'utf8')).toBe(intent.annotation);
    expect(await identity(note)).toEqual({ ...original, nlink: 1n });
    for (const file of [journal, stage, shared]) await expect(fs.lstat(file)).rejects.toMatchObject({ code: 'ENOENT' });
  }
});

async function ordinaryConflict(testInfo, checkpoint) {
  const context = await fixture(testInfo, checkpoint, 'draft');
  const { intake, producer, sourceHash, capture } = context;
  const destination = intake.destination(capture), ledgerFile = path.join(intake.dir, 'ledger.json');
  await fs.appendFile(destination, '\nLocal writing before the interrupted ordinary transfer.\n');
  const local = await fs.readFile(destination), localIdentity = await identity(destination);
  await writeDraft(producer, '2', later);
  const before = await intake.reconcile({ now: later }), block = before.blocks[sourceHash];
  expect(block).toBeDefined();
  const older = path.join(intake.dir, block.journal), olderBytes = await fs.readFile(older), olderIdentity = await identity(older);
  const input = { sourceHash, localHash: createHash('sha256').update(local).digest('hex'), text: 'Only-copy interrupted transfer writing.' };
  return { ...context, destination, ledgerFile, local, localIdentity, before, block, older, olderBytes, olderIdentity, input };
}

async function exactTransfer(context) {
  const { intake, vault, input } = context;
  const journal = path.join(intake.dir, 'repair-intent.json'), bytes = await fs.readFile(journal), intent = JSON.parse(bytes);
  const note = path.join(vault.root, 'Annotations', `${intent.annotationId}.md`);
  const stage = path.join(intake.dir, `annotation-${intent.annotationId}.stage`);
  const original = await identity(note);
  expect(intent.tx.keptCurrent).toBeUndefined();
  expect(intent.annotation).toContain(input.text);
  expect(original.nlink).toBe(2n);
  expect(await identity(stage)).toEqual(original);
  expect(await fs.readFile(note, 'utf8')).toBe(intent.annotation);
  return { journal, bytes, intent, note, stage, original };
}

test('ordinary transfer restart holds an annotation withdrawn before the source journal', async ({}, testInfo) => {
  const interrupted = Error('Stopped after annotation publication.');
  const context = await ordinaryConflict(testInfo, boundary => {
    if (boundary === 'repair-annotation-published') throw interrupted;
  });
  const { vault, intake, sourceHash, destination, local, block, input } = context;
  await expect(intake.resolveConflict(input, later)).rejects.toBe(interrupted);
  const { intent, note, stage } = await exactTransfer(context);
  await expect(fs.lstat(path.join(intake.dir, 'transaction.json'))).rejects.toMatchObject({ code: 'ENOENT' });
  await fs.unlink(note);
  const staged = await identity(stage);

  const restarted = new Intake(new Vault(vault.vault, 'Companion'));
  const ledger = await restarted.info();
  expect.soft(ledger.attempts[intent.tx.revision.identity]).toBeUndefined();
  expect.soft(ledger.blocks[sourceHash]?.incomingRevision).toBe(block.incomingRevision);
  expect.soft(await readOptional(note)).toBeNull();
  expect.soft(await fs.readFile(destination)).toEqual(local);
  expect(await fs.readFile(stage, 'utf8')).toBe(intent.annotation);
  expect(await identity(stage)).toEqual(staged);
  expect(await restarted.repairs()).toContainEqual(expect.objectContaining({ sourceHash }));
});

test('ordinary transfer restart restores its prior capture when the published annotation is withdrawn', async ({}, testInfo) => {
  const interrupted = Error('Stopped at the exact ordinary pre-admission publication.');
  const displaced = testInfo.outputPath('withdrawn-after-interruption.md');
  let context, witness;
  context = await ordinaryConflict(testInfo, async boundary => {
    if (boundary !== 'intake-published' || !context) return;
    witness = await exactTransfer(context);
    const shared = path.join(context.intake.dir, 'transaction.json');
    expect(JSON.parse(await fs.readFile(shared))).toEqual(witness.intent.tx);
    throw interrupted;
  });
  const { vault, intake, producer, sourceHash, destination, ledgerFile, local, localIdentity, block, older, olderBytes, olderIdentity, input } = context;
  await expect(intake.resolveConflict(input, later)).rejects.toBe(interrupted);
  expect(witness).toBeDefined();
  const { intent, note, stage, original, journal, bytes } = witness;
  const backup = path.join(intake.dir, intent.tx.backup);
  expect(await fs.readFile(backup)).toEqual(local);
  expect(await identity(backup)).toMatchObject({ dev: localIdentity.dev, ino: localIdentity.ino });
  const stopped = JSON.parse(await fs.readFile(ledgerFile));
  expect(stopped.blocks[sourceHash]).toEqual(block);
  expect(stopped.attempts[intent.tx.revision.identity]).toBeUndefined();
  await fs.rename(note, displaced);

  const restarted = new Intake(new Vault(vault.vault, 'Companion'));
  const after = await restarted.info();
  const held = after.blocks[sourceHash];
  expect(held).toMatchObject({ incomingRevision: block.incomingRevision });
  expect(held.journal).not.toBe(block.journal);
  expect(after.attempts[intent.tx.revision.identity]).toBeUndefined();
  expect.soft(await readOptional(destination)).toEqual(local);
  expect.soft(await identity(destination).catch(error => error.code)).toMatchObject({ dev: localIdentity.dev, ino: localIdentity.ino });
  expect(await fs.readFile(older)).toEqual(olderBytes);
  expect(await identity(older)).toEqual(olderIdentity);
  expect(await fs.readFile(path.join(intake.dir, `repair-${intent.annotationId}.json`))).toEqual(bytes);
  const heldSource = path.join(intake.dir, held.journal), heldBytes = await fs.readFile(heldSource);
  expect(JSON.parse(heldBytes)).toEqual(intent.tx);
  for (const file of [journal, path.join(intake.dir, 'transaction.json')]) expect(await readOptional(file)).toBeNull();
  for (const file of [stage, displaced]) {
    expect(await identity(file)).toEqual(original);
    expect(await fs.readFile(file, 'utf8')).toBe(intent.annotation);
  }
  const independentHash = 'c'.repeat(64);
  await writeDraft(producer, '3', later, { sourceHash: independentHash, clip: 'd'.repeat(64) });
  const independent = await restarted.reconcile({ now: later });
  expect(independent.captures[independentHash]?.id).toBeDefined();
  expect(independent.blocks[sourceHash]).toEqual(held);

  await restarted.resolveConflict({ ...input, text: 'Fresh explicit transfer of the local writing.' }, later);
  const resolved = await restarted.info();
  expect(resolved.blocks[sourceHash]).toBeUndefined();
  expect(resolved.attempts[intent.tx.revision.identity]).toMatchObject({ status: 'imported', revision: intent.tx.revision.id });
  expect(await fs.readFile(older)).toEqual(olderBytes);
  expect(await fs.readFile(heldSource)).toEqual(heldBytes);
  expect(await fs.readFile(displaced, 'utf8')).toBe(intent.annotation);
});

for (const state of ['withdrawn', 'replaced', 'edited']) test(`ordinary transfer restart holds ${state} writing after durable source admission`, async ({}, testInfo) => {
  const interrupted = Error('Stopped after the ordinary transfer ledger was saved.');
  let context, witness;
  context = await ordinaryConflict(testInfo, async boundary => {
    if (boundary !== 'intake-ledger' || !context) return;
    witness = await exactTransfer(context);
    throw interrupted;
  });
  const { vault, intake, input, sourceHash, destination, local, older, olderBytes } = context;
  await expect(intake.resolveConflict(input, later)).rejects.toBe(interrupted);
  const { journal, intent, note, stage, original } = witness;
  const replacement = state === 'replaced', edited = state === 'edited';
  if (!edited) await fs.unlink(note);
  const current = replacement ? intent.annotation.replace(intent.annotationId, randomUUID()).replace(input.text, 'Foreign annotation writing.')
    : edited ? intent.annotation + '\nIndependent edits after source admission.\n' : null;
  if (replacement) await fs.writeFile(note, current, { flag: 'wx' });
  if (edited) await fs.writeFile(note, current);
  const noteIdentity = current ? { ...await identity(note), nlink: 1n } : null;
  const restarted = new Intake(new Vault(vault.vault, 'Companion'));
  const ledger = await restarted.info();
  expect(ledger.captures[sourceHash].currentRevision).toBe(intent.tx.revision.id);
  expect(ledger.attempts[intent.tx.revision.identity]).toMatchObject({ status: 'imported', revision: intent.tx.revision.id });
  expect(await fs.readFile(destination, 'utf8')).toBe(intent.tx.content);
  expect((await readOptional(note))?.toString('utf8') || null).toBe(current);
  if (edited) expect(await readOptional(stage)).toBeNull();
  else {
    expect(await fs.readFile(stage, 'utf8')).toBe(intent.annotation);
    expect(await identity(stage)).toEqual({ ...original, nlink: 1n });
  }
  expect(await readOptional(journal)).toBeNull();
  const held = path.join(intake.dir, `annotation-${intent.annotationId}.held.json`);
  const heldBytes = await fs.readFile(held);
  expect(JSON.parse(heldBytes)).toMatchObject({ id: intent.annotationId, captureId: intent.tx.capture.id, annotation: intent.annotation, annotationProof: intent.annotationProof });
  expect(await readOptional(path.join(intake.dir, `repair-${intent.annotationId}.json`))).toBeNull();
  if (edited) {
    const removal = new AnnotationRemoval({ getVault: () => vault, clearApprovals() {} });
    const preview = await removal.preview(intent.annotationId);
    expect(preview.targets).toEqual(expect.arrayContaining([note, held].map(file => path.relative(vault.vault, file).split(path.sep).join('/'))));
  }
  await restarted.addAnnotation({ captureId: intent.tx.capture.id, id: randomUUID(), text: 'Independent writing after accepted transfer.' }, later);
  const getVault = () => restarted.vault, clock = () => ({ now: later });
  const conversations = new Conversations({ dataRoot: testInfo.outputPath('history'), getVault, clock });
  await conversations.lock(async () => {});
  const deletion = new CaptureDeletion({ getVault, conversations, clock, clearApprovals() {} });
  const backup = path.join(intake.dir, intent.tx.backup), preservedBackup = testInfo.outputPath('independent-previous-writing.md');
  expect(await fs.readFile(backup)).toEqual(local);
  await expect(deletion.preview(intent.tx.capture.id)).rejects.toMatchObject({ code: 'SOURCE_FILE_CHANGED' });
  const preservedConflict = testInfo.outputPath('independent-prior-conflict.json');
  expect(await fs.readFile(older)).toEqual(olderBytes);
  await fs.rename(backup, preservedBackup);
  await fs.rename(older, preservedConflict);
  const preview = await deletion.preview(intent.tx.capture.id);
  expect(preview.dependents).toContainEqual(expect.objectContaining({ id: intent.annotationId, text: intent.annotation }));
  await deletion.confirm(preview.token);
  expect(await readOptional(destination)).toBeNull();
  expect(await fs.readFile(held)).toEqual(heldBytes);
  expect((await readOptional(stage))?.toString('utf8') || null).toBe(edited ? null : intent.annotation);
  expect(await fs.readFile(preservedBackup)).toEqual(local);
  expect(await fs.readFile(preservedConflict)).toEqual(olderBytes);
  if (current) {
    expect(await identity(note)).toEqual(noteIdentity);
    expect(await fs.readFile(note, 'utf8')).toBe(current);
  }
});

test('ordinary transfer keeps a foreign backup created at the native move boundary', async ({}, testInfo) => {
  const context = await ordinaryConflict(testInfo);
  const { intake, vault, destination, local, localIdentity, input, sourceHash } = context;
  const foreign = 'Independent writing created at the native backup boundary.\n';
  const rename = fs.rename, link = native.linkSync;
  let witness;
  const arrive = (from, to) => {
    if (from !== destination || !/\.before-[a-f0-9-]{36}\.md$/.test(to)) return;
    const tx = JSON.parse(native.readFileSync(path.join(intake.dir, 'transaction.json'), 'utf8'));
    expect(to).toBe(path.join(intake.dir, tx.backup));
    native.writeFileSync(to, foreign, { flag: 'wx' });
    const { dev, ino, nlink } = native.lstatSync(to, { bigint: true });
    witness = { tx, backup: to, identity: { dev, ino, nlink } };
  };
  fs.rename = (from, to) => { arrive(from, to); return rename(from, to); };
  native.linkSync = (from, to) => { arrive(from, to); return link(from, to); };
  try { await expect(intake.resolveConflict(input, later)).rejects.toThrow(); }
  finally { fs.rename = rename; native.linkSync = link; }
  expect(witness, 'the independent backup appeared inside the native operation').toBeDefined();
  expect.soft(await fs.readFile(witness.backup, 'utf8')).toBe(foreign);
  expect.soft(await identity(witness.backup)).toEqual(witness.identity);
  expect.soft(await fs.readFile(destination)).toEqual(local);
  expect.soft(await identity(destination)).toEqual(localIdentity);
  const restarted = new Intake(new Vault(vault.vault, 'Companion'));
  const ledger = await restarted.info();
  expect(ledger.blocks[sourceHash]?.incomingRevision).toBe(witness.tx.revision.id);
  expect(ledger.attempts[witness.tx.revision.identity]).toBeUndefined();
});

test('ordinary transfer restart settles an exact linked capture backup', async ({}, testInfo) => {
  const context = await ordinaryConflict(testInfo);
  const { intake, vault, destination, local, localIdentity, input, sourceHash } = context;
  const interrupted = Error('Stopped with both exact names for the original capture.');
  const link = native.linkSync;
  let witness;
  native.linkSync = (from, to) => {
    link(from, to);
    if (from !== destination || !/\.before-[a-f0-9-]{36}\.md$/.test(to)) return;
    const tx = JSON.parse(native.readFileSync(path.join(intake.dir, 'transaction.json'), 'utf8'));
    expect(to).toBe(path.join(intake.dir, tx.backup));
    witness = { tx, backup: to };
    throw interrupted;
  };
  try { await expect(intake.resolveConflict(input, later)).rejects.toBe(interrupted); }
  finally { native.linkSync = link; }
  expect(witness).toBeDefined();
  for (const file of [destination, witness.backup]) {
    expect(await fs.readFile(file)).toEqual(local);
    expect(await identity(file)).toEqual({ ...localIdentity, nlink: 2n });
  }
  const restarted = new Intake(new Vault(vault.vault, 'Companion'));
  const ledger = await restarted.info();
  expect(ledger.blocks[sourceHash]).toBeUndefined();
  expect(ledger.attempts[witness.tx.revision.identity]).toMatchObject({ status: 'imported', revision: witness.tx.revision.id });
  expect(await fs.readFile(witness.backup)).toEqual(local);
  expect(await identity(witness.backup)).toEqual(localIdentity);
  expect(await fs.readFile(destination, 'utf8')).toBe(witness.tx.content);
});

test('ordinary transfer retry cannot admit after a deferred transfer annotation is withdrawn', async ({}, testInfo) => {
  const displaced = testInfo.outputPath('withdrawn-before-retry.md');
  let context, witness;
  context = await ordinaryConflict(testInfo, async boundary => {
    if (boundary !== 'intake-before-move' || !context) return;
    witness = await exactTransfer(context);
    throw Object.assign(Error('Fixture native capture move refused.'), { code: 'EACCES' });
  });
  const { vault, intake, sourceHash, destination, ledgerFile, local, localIdentity, older, olderBytes, olderIdentity, input } = context;
  await expect(intake.resolveConflict(input, later)).rejects.toThrow();
  expect(witness, 'the exact ordinary transfer hit the native refusal seam').toBeDefined();
  const { intent, note } = witness;
  const deferred = JSON.parse(await fs.readFile(ledgerFile));
  expect(deferred.attempts[intent.tx.revision.identity]).toBeUndefined();
  expect(await fs.readFile(destination)).toEqual(local);
  const withdrawnIdentity = await identity(note);
  await fs.rename(note, displaced);

  const restarted = new Intake(new Vault(vault.vault, 'Companion'));
  await restarted.reconcile({ now: later }).catch(() => {});
  const after = JSON.parse(await fs.readFile(ledgerFile));
  expect.soft(after.attempts[intent.tx.revision.identity]).toBeUndefined();
  expect.soft(after.blocks[sourceHash] || after.pending[sourceHash]).toBeDefined();
  expect.soft(await readOptional(destination)).toEqual(local);
  expect.soft(await identity(destination).catch(error => error.code)).toMatchObject({ dev: localIdentity.dev, ino: localIdentity.ino });
  expect(await fs.readFile(older)).toEqual(olderBytes);
  expect(await identity(older)).toEqual(olderIdentity);
  expect(await fs.readFile(displaced, 'utf8')).toBe(intent.annotation);
  expect(await identity(displaced)).toEqual(withdrawnIdentity);
});

test('relationship repair preserves an independent backup created during authority verification', async ({}, testInfo) => {
  const foreignText = 'Independent backup writing created after the backup was observed absent.\n';
  let armed = false, views = 0, context, witness;
  context = await fixture(testInfo, boundary => { if (boundary === 'link-intent-published') armed = true; });
  const { intake, input, note } = context;
  await intake.addAnnotation(input, now);
  const original = await fs.readFile(note), noteIdentity = await identity(note);
  const moved = path.join(path.dirname(note), 'Nested', path.basename(note));
  await fs.mkdir(path.dirname(moved));
  await fs.rename(note, moved);
  const view = intake.storage.view.bind(intake.storage);
  intake.storage.view = async (...args) => {
    const observed = await view(...args);
    if (!armed || args.length || ++views !== 2) return observed;
    const journal = path.join(intake.dir, 'link-intent.json');
    const bytes = await fs.readFile(journal), intent = JSON.parse(bytes), journalIdentity = await identity(journal);
    const backup = path.join(intake.dir, `link-${intent.id}.before.md`);
    expect(intake.destination({ relative: intent.file })).toBe(moved);
    expect(intent.before).toBe(original.toString('utf8'));
    expect(intent.content).not.toBe(intent.before);
    expect(await identity(moved)).toEqual(noteIdentity);
    await expect(fs.lstat(backup)).rejects.toMatchObject({ code: 'ENOENT' });
    await fs.writeFile(backup, foreignText, { flag: 'wx' });
    const backupIdentity = await identity(backup);
    expect(backupIdentity).not.toEqual(noteIdentity);
    witness = { journal, bytes, intent, journalIdentity, backup, backupIdentity };
    return observed;
  };

  await intake.info().catch(() => {});
  expect(witness, 'an independent backup arrived during the last authority view before the move').toBeDefined();
  expect.soft(await fs.readFile(witness.backup, 'utf8')).toBe(foreignText);
  expect.soft(await identity(witness.backup)).toEqual(witness.backupIdentity);
  expect.soft(await readOptional(moved)).toEqual(original);
  expect.soft(await identity(moved).catch(error => error.code)).toEqual(noteIdentity);
  const archive = path.join(intake.dir, `link-${witness.intent.id}.json`);
  const evidence = await readOptional(witness.journal) ? witness.journal : archive;
  expect.soft(await readOptional(evidence)).toEqual(witness.bytes);
  expect.soft(await identity(evidence).catch(error => error.code)).toEqual(witness.journalIdentity);
});

for (const state of ['removed', 'replaced', 'removed with a replaced backup']) test(`relationship restart holds when its recorded stage is ${state}`, async ({}, testInfo) => {
  const { vault, intake, input, note } = await fixture(testInfo);
  await intake.addAnnotation(input, now);
  const original = await fs.readFile(note), originalIdentity = await identity(note);
  const moved = path.join(path.dirname(note), 'Nested', path.basename(note));
  await fs.mkdir(path.dirname(moved));
  await fs.rename(note, moved);
  const journal = path.join(intake.dir, 'link-intent.json');
  const interrupted = Error('Stopped after the relationship stage proof was saved.');
  const rename = native.renameSync;
  native.renameSync = (from, to) => {
    rename(from, to);
    if (to === journal) throw interrupted;
  };
  try { await expect(intake.info()).rejects.toBe(interrupted); }
  finally { native.renameSync = rename; }
  const bytes = await fs.readFile(journal), intent = JSON.parse(bytes);
  const backup = path.join(intake.dir, `link-${intent.id}.before.md`), stage = path.join(intake.dir, `link-${intent.id}.stage`);
  expect(intent.stageProof).toBeDefined();
  expect(await identity(backup)).toEqual(originalIdentity);
  expect(await readOptional(moved)).toBeNull();
  const displaced = testInfo.outputPath('displaced-relationship-stage.md');
  await fs.rename(stage, displaced);
  const replacement = state === 'replaced', replacedBackup = state === 'removed with a replaced backup';
  if (replacement) await fs.writeFile(stage, intent.content, { flag: 'wx' });
  const foreign = replacement ? await identity(stage) : null;
  const displacedBackup = testInfo.outputPath('displaced-relationship-backup.md');
  if (replacedBackup) {
    await fs.rename(backup, displacedBackup);
    await fs.writeFile(backup, original, { flag: 'wx' });
  }
  const backupIdentity = replacedBackup ? await identity(backup) : null;

  const restarted = new Intake(new Vault(vault.vault, 'Companion'));
  const ledger = await restarted.info();
  const archive = `link-${intent.id}.json`;
  expect(ledger.linkHolds?.[input.id]).toMatchObject({ journal: archive });
  expect(await readOptional(moved)).toEqual(replacedBackup ? null : original);
  if (replacedBackup) {
    expect(await identity(backup)).toEqual(backupIdentity);
    expect(await identity(displacedBackup)).toEqual(originalIdentity);
    const removal = new AnnotationRemoval({ getVault: () => vault, clearApprovals() {} });
    await expect(removal.preview(input.id)).rejects.toThrow(/scope changed|unknown copy/i);
    expect(await identity(backup)).toEqual(backupIdentity);
  } else {
    expect(await identity(moved)).toEqual(originalIdentity);
    expect(await readOptional(backup)).toBeNull();
  }
  expect(await readOptional(journal)).toBeNull();
  expect(await fs.readFile(path.join(intake.dir, archive))).toEqual(bytes);
  if (replacement) expect(await identity(stage)).toEqual(foreign);
  else expect(await readOptional(stage)).toBeNull();
  expect(await fs.readFile(displaced, 'utf8')).toBe(intent.content);
});

for (const state of ['edited', 'legacy', 'replaced']) test(`relationship restart preserves ${state} publication writing`, async ({}, testInfo) => {
  const { vault, intake, input, note } = await fixture(testInfo);
  await intake.addAnnotation(input, now);
  const moved = path.join(path.dirname(note), 'Nested', path.basename(note));
  await fs.mkdir(path.dirname(moved));
  await fs.rename(note, moved);
  const journal = path.join(intake.dir, 'link-intent.json'), link = native.linkSync;
  const interrupted = Error('Stopped with both names for the relationship publication.');
  native.linkSync = (from, to) => {
    link(from, to);
    if (to === moved && /^link-.*\.stage$/.test(path.basename(from))) throw interrupted;
  };
  try { await expect(intake.info()).rejects.toBe(interrupted); }
  finally { native.linkSync = link; }
  const intent = JSON.parse(await fs.readFile(journal));
  const stage = path.join(intake.dir, `link-${intent.id}.stage`), published = await identity(moved);
  expect(published.nlink).toBe(2n);
  expect(await identity(stage)).toEqual(published);
  const legacy = state === 'legacy', replaced = state === 'replaced';
  if (legacy) {
    delete intent.stageProof;
    delete intent.originalProof;
    await fs.writeFile(journal, JSON.stringify(intent));
  } else if (replaced) {
    await fs.unlink(moved);
    await fs.writeFile(moved, intent.content, { flag: 'wx' });
  } else await fs.appendFile(moved, '\nIndependent writing edited after relationship publication.\n');
  const writing = await fs.readFile(moved, 'utf8');
  const canonical = await identity(moved);
  const restarted = new Intake(new Vault(vault.vault, 'Companion'));
  const ledger = await restarted.info();
  const hold = ledger.linkHolds?.[input.id];
  const retained = hold?.evidence.find(name => replaced ? name.endsWith('.stage') : name.includes('.held-stage-'));
  expect(retained).toBeDefined();
  expect(await fs.readFile(path.join(intake.dir, retained), 'utf8')).toBe(writing);
  expect(await fs.readFile(moved, 'utf8')).toBe(writing);
  expect(await identity(moved)).toEqual({ ...canonical, nlink: 1n });
  if (replaced) expect(await identity(stage)).toEqual({ ...published, nlink: 1n });
  else expect(await readOptional(stage)).toBeNull();
  expect(await restarted.annotations(input.captureId)).toMatchObject([{ id: input.id, content: writing }]);
});

for (const refusal of ['transient', 'replaced', 'persistent']) test(`relationship proof publication preserves ownership on a ${refusal} Windows rename refusal`, async ({}, testInfo) => {
  test.skip(process.platform !== 'win32', 'Windows rename retry');
  const { vault, intake, input, note } = await fixture(testInfo);
  await intake.addAnnotation(input, now);
  const original = await fs.readFile(note), originalIdentity = await identity(note);
  const moved = path.join(path.dirname(note), 'Nested', path.basename(note));
  await fs.mkdir(path.dirname(moved));
  await fs.rename(note, moved);
  const journal = path.join(intake.dir, 'link-intent.json'), displaced = testInfo.outputPath('displaced-relationship-intent.tmp');
  const rename = native.renameSync, attempts = [];
  let witness;
  native.renameSync = (from, to) => {
    if (to !== journal) return rename(from, to);
    attempts.push(from);
    if (attempts.length === 1) {
      const bytes = native.readFileSync(journal), intent = JSON.parse(bytes), stage = path.join(intake.dir, `link-${intent.id}.stage`);
      const replacement = native.readFileSync(from);
      if (refusal === 'replaced') {
        rename(from, displaced);
        native.writeFileSync(from, replacement, { flag: 'wx' });
      }
      const { dev, ino, nlink } = native.lstatSync(from, { bigint: true });
      witness = { bytes, intent, stage, replacement, identity: { dev, ino, nlink } };
    }
    if (refusal === 'transient' && attempts.length === 2) return rename(from, to);
    throw Object.assign(Error('Controlled native rename refusal.'), { code: 'EPERM', syscall: 'rename' });
  };
  let ledger;
  try { ledger = await intake.info(); }
  finally { native.renameSync = rename; }
  expect(witness).toBeDefined();
  expect(new Set(attempts).size).toBe(1);
  expect(await readOptional(journal)).toBeNull();
  if (refusal === 'transient') {
    expect(attempts).toHaveLength(2);
    expect(ledger.linkHolds?.[input.id]).toBeUndefined();
    expect(await fs.readFile(moved, 'utf8')).toBe(witness.intent.content);
    expect(await readOptional(witness.stage)).toBeNull();
  } else {
    const archive = `link-${witness.intent.id}.json`;
    expect(ledger.linkHolds?.[input.id]).toMatchObject({ journal: archive });
    expect(await fs.readFile(moved)).toEqual(original);
    expect(await identity(moved)).toEqual(originalIdentity);
    expect(await fs.readFile(witness.stage, 'utf8')).toBe(witness.intent.content);
    expect(await fs.readFile(path.join(intake.dir, archive))).toEqual(witness.bytes);
    if (refusal === 'replaced') {
      expect(attempts).toHaveLength(1);
      expect(await fs.readFile(attempts[0])).toEqual(witness.replacement);
      expect(await identity(attempts[0])).toEqual(witness.identity);
      expect(await fs.readFile(displaced)).toEqual(witness.replacement);
    } else expect(attempts.length).toBeGreaterThan(1);
  }
  expect(await new Intake(new Vault(vault.vault, 'Companion')).annotations(input.captureId)).toHaveLength(1);
});

for (const cut of ['no interruption', 'archive linked', 'hold saved']) test(`relationship repair refuses an independent equal-byte stage at its exclusive open (${cut})`, async ({}, testInfo) => {
  let armed = false, witness;
  const { vault, intake, input, note } = await fixture(testInfo, boundary => { if (boundary === 'link-intent-published') armed = true; });
  await intake.addAnnotation(input, now);
  const original = await fs.readFile(note), originalIdentity = await identity(note);
  const moved = path.join(path.dirname(note), 'Nested', path.basename(note));
  await fs.mkdir(path.dirname(moved));
  await fs.rename(note, moved);
  const open = fs.open, link = native.linkSync, unlink = native.unlinkSync;
  const interrupted = Error(`Stopped with the relationship ${cut}.`);
  native.linkSync = (from, to) => {
    link(from, to);
    if (cut === 'archive linked' && from === witness?.journal && to === witness.archive) throw interrupted;
  };
  native.unlinkSync = file => {
    if (cut === 'hold saved' && file === witness?.journal) throw interrupted;
    unlink(file);
  };
  fs.open = async (file, flags, ...args) => {
    if (armed && !witness && flags === 'wx' && path.dirname(file) === intake.dir && /^link-[a-f0-9-]{36}\.stage$/.test(path.basename(file))) {
      const journal = path.join(intake.dir, 'link-intent.json');
      const bytes = await fs.readFile(journal), intent = JSON.parse(bytes), journalIdentity = await identity(journal);
      const stage = path.join(intake.dir, `link-${intent.id}.stage`);
      const backup = path.join(intake.dir, `link-${intent.id}.before.md`);
      expect(file).toBe(stage);
      expect(intent.before).toBe(original.toString('utf8'));
      expect(intent.content).not.toBe(intent.before);
      const originalLocation = await readOptional(moved) ? moved : backup;
      expect(await fs.readFile(originalLocation)).toEqual(original);
      expect(await identity(originalLocation)).toMatchObject({ dev: originalIdentity.dev, ino: originalIdentity.ino });
      await expect(fs.lstat(stage)).rejects.toMatchObject({ code: 'ENOENT' });
      native.writeFileSync(stage, intent.content, { flag: 'wx' });
      const foreign = await identity(stage);
      expect(foreign.nlink).toBe(1n);
      witness = { journal, bytes, journalIdentity, intent, stage, backup, foreign, archive: path.join(intake.dir, `link-${intent.id}.json`) };
    }
    return open(file, flags, ...args);
  };
  try {
    if (cut === 'no interruption') await intake.info();
    else await expect(intake.info()).rejects.toBe(interrupted);
  } finally { fs.open = open; native.linkSync = link; native.unlinkSync = unlink; }
  expect(witness, 'the independent inode existed when the real exclusive open was attempted').toBeDefined();
  expect.soft(await identity(witness.stage).catch(error => error.code)).toEqual(witness.foreign);
  expect.soft((await readOptional(witness.stage))?.toString('utf8')).toBe(witness.intent.content);
  const destination = await readOptional(moved);
  expect.soft(destination).toEqual(original);
  expect.soft(await identity(moved).catch(error => error.code)).toMatchObject({ dev: originalIdentity.dev, ino: originalIdentity.ino });
  if (cut !== 'no interruption') {
    expect(await identity(witness.journal)).toEqual(await identity(witness.archive));
    const displaced = testInfo.outputPath('independent-relationship-stage.md');
    await fs.rename(witness.stage, displaced);
    const restarted = new Intake(new Vault(vault.vault, 'Companion'));
    const ledger = await restarted.info();
    expect.soft(ledger.linkHolds?.[input.id]).toMatchObject({ journal: path.basename(witness.archive) });
    expect.soft(await readOptional(witness.journal)).toBeNull();
    expect.soft(await readOptional(witness.backup)).toBeNull();
    expect.soft(await readOptional(moved)).toEqual(original);
    expect.soft(await identity(moved).catch(error => error.code)).toEqual(originalIdentity);
    expect(await identity(displaced)).toEqual(witness.foreign);
    expect(await fs.readFile(witness.archive)).toEqual(witness.bytes);
    return;
  }
  const locations = [moved, witness.backup];
  const surviving = (await Promise.all(locations.map(async file => {
    const bytes = await readOptional(file);
    return bytes?.equals(original) ? identity(file) : null;
  }))).filter(Boolean);
  expect(surviving).not.toHaveLength(0);
  for (const actual of surviving) expect(actual).toMatchObject({ dev: originalIdentity.dev, ino: originalIdentity.ino });
  const archive = path.join(intake.dir, `link-${witness.intent.id}.json`);
  const evidence = await readOptional(witness.journal) ? witness.journal : archive;
  expect.soft(await readOptional(evidence)).toEqual(witness.bytes);
  expect.soft(await identity(evidence).catch(error => error.code)).toMatchObject({ dev: witness.journalIdentity.dev, ino: witness.journalIdentity.ino });
  const removal = new AnnotationRemoval({ getVault: () => vault, clearApprovals() {} });
  const preview = await removal.preview(input.id).catch(() => null);
  const relativeStage = path.relative(vault.vault, witness.stage).split(path.sep).join('/');
  expect(preview?.targets || []).not.toContain(relativeStage);
});
