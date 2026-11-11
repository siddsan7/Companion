const { test, expect } = require('@playwright/test');
const fs = require('node:fs/promises');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { createHash } = require('node:crypto');
const { Vault } = require('../app/vault');
const { Intake } = require('../app/intake');
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

async function writeDraft(producer, attempt, startedAt) {
  const folder = path.join(producer, attempt), clip = 'b'.repeat(64);
  await fs.mkdir(folder, { recursive: true });
  await fs.writeFile(path.join(folder, 'run.json'), JSON.stringify({
    job_id: clip, attempt_id: attempt.repeat(32), started_utc: startedAt, input_sha256: 'a'.repeat(64),
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
});

test('standalone annotation restart settles the unchanged published pair', async ({}, testInfo) => {
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
  await restarted.locked(() => restarted.load());
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
