const { test, expect } = require('@playwright/test');
const fs = require('node:fs/promises');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { Vault } = require('../app/vault');
const { Intake } = require('../app/intake');

const now = '2026-11-08T06:59:00.000Z';
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

async function fixture(testInfo, checkpoint) {
  const directory = testInfo.outputPath('vault'), review = testInfo.outputPath('review');
  await fs.mkdir(directory, { recursive: true });
  await fs.cp(path.join(__dirname, 'fixtures/reel-review/accept'), path.join(review, 'accept'), { recursive: true });
  const vault = new Vault(await fs.realpath(directory), 'Companion', { checkpoint });
  await vault.setup();
  const intake = new Intake(vault), ledger = await intake.connect(review, true, now, 'review');
  expect(ledger.lastCheck.status).toBe('complete');
  const [capture] = Object.values(ledger.captures);
  expect(capture).toBeDefined();
  return { vault, intake, input: { id, captureId: capture.id, text: selectedWriting },
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
