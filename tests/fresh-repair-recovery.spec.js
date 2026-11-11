const { test, expect } = require('@playwright/test');
const fs = require('node:fs/promises');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { createHash } = require('node:crypto');
const { Vault } = require('../app/vault');
const { Intake } = require('../app/intake');
const draft = require('./fixtures/reel-draft/example.json');

const first = '2026-11-08T06:59:00.000Z';
const later = '2026-11-09T06:59:00.000Z';
const independentHash = 'd'.repeat(64);
const json = async file => JSON.parse(await fs.readFile(file, 'utf8'));
const identity = async file => {
  const { dev, ino, nlink } = await fs.lstat(file, { bigint: true });
  return { dev, ino, nlink };
};

async function exitDuringRepair(directory, shared, input, checkpoint = '') {
  const code = String.raw`
    const fs = require('node:fs/promises');
    const path = require('node:path');
    const { Vault } = require('./app/vault');
    const { Intake } = require('./app/intake');
    const [directory, shared, rawInput, now, stopAt] = process.argv.slice(1);
    const input = JSON.parse(rawInput), link = fs.link, unlink = fs.unlink;
    let exactStage;
    fs.link = async (from, to) => {
      await link(from, to);
      if (to !== shared || !/^journal-[a-f0-9-]{36}\.stage$/.test(path.basename(from))) return;
      const tx = JSON.parse(await fs.readFile(to, 'utf8'));
      if (tx.sourceHash === input.sourceHash && tx.keptCurrent && tx.resolution) exactStage = from;
    };
    fs.unlink = async file => {
      await unlink(file);
      if (file === exactStage) process.exit(77);
    };
    const intake = new Intake(new Vault(directory, 'Companion', { checkpoint: async boundary => {
      if (boundary !== stopAt) return;
      const tx = JSON.parse(await fs.readFile(shared, 'utf8'));
      if (tx.sourceHash === input.sourceHash && tx.keptCurrent && tx.resolution) process.exit(77);
    } }));
    const operation = stopAt ? intake.reconcile({ now }) : intake.resolveConflict(input, now);
    operation.then(() => process.exit(78), error => {
      console.error(error);
      process.exit(79);
    });
  `;
  const child = spawn(process.execPath, ['-e', code, directory, shared, JSON.stringify(input), later, checkpoint], {
    cwd: path.join(__dirname, '..'), stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true
  });
  let stderr = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', part => { stderr += part; });
  const result = await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code, signal) => resolve({ code, signal }));
  });
  expect(result, stderr).toEqual({ code: 77, signal: null });
}

async function interruptedRepair(testInfo) {
  const directory = testInfo.outputPath('vault'), reviews = testInfo.outputPath('reviews'), drafts = testInfo.outputPath('drafts');
  const independent = path.join(drafts, 'independent');
  await fs.mkdir(directory, { recursive: true });
  await fs.mkdir(drafts, { recursive: true });
  await fs.cp(path.join(__dirname, 'fixtures/reel-review/accept'), path.join(reviews, 'accept'), { recursive: true });
  const vault = new Vault(await fs.realpath(directory), 'Companion');
  await vault.setup();
  const intake = new Intake(vault);
  const initial = await intake.connect(reviews, true, first, 'review');
  expect(initial.lastCheck.status).toBe('complete');
  const [sourceHash, current] = Object.entries(initial.captures)[0];
  expect(current.reviewed).toBe(true);
  await intake.connect(drafts, false, first);

  const destination = intake.destination(current), ledgerFile = path.join(intake.dir, 'ledger.json');
  await fs.appendFile(destination, '\nIndependent local writing before repair.\n');
  const local = await fs.readFile(destination);
  await fs.cp(path.join(__dirname, 'fixtures/reel-review/edit'), path.join(reviews, 'edit'), { recursive: true });
  const before = await intake.reconcile({ now: later });
  const block = before.blocks[sourceHash];
  expect(block).toBeDefined();
  expect(block.outputHold).toBeUndefined();
  const older = path.join(intake.dir, block.journal), previous = await json(older), previousIdentity = await identity(older);
  expect(previous.retainOnly).toBe(true);

  const writing = 'Preserve the selected local writing.';
  const input = { sourceHash, text: writing, localHash: createHash('sha256').update(local).digest('hex') };
  const shared = path.join(intake.dir, 'transaction.json'), intentFile = path.join(intake.dir, 'repair-intent.json');
  await exitDuringRepair(vault.vault, shared, input);
  const intent = await json(intentFile), tx = intent.tx;
  const archive = path.join(intake.dir, `repair-${intent.annotationId}.json`);
  const stage = path.join(intake.dir, `annotation-${intent.annotationId}.stage`);
  const annotation = path.join(vault.root, 'Annotations', `${intent.annotationId}.md`);
  expect(tx).toMatchObject({ sourceHash, keptCurrent: { id: current.currentRevision }, revision: { id: block.incomingRevision } });
  expect(await json(shared)).toEqual(tx);
  expect((await identity(shared)).nlink).toBe(1n);
  expect((await identity(intentFile)).nlink).toBe(1n);
  await expect(fs.lstat(archive)).rejects.toMatchObject({ code: 'ENOENT' });
  expect(await fs.readFile(annotation, 'utf8')).toBe(intent.annotation);
  const published = await identity(annotation);
  expect(published.nlink).toBe(2n);
  expect(await identity(stage)).toEqual(published);
  expect((await json(ledgerFile)).blocks[sourceHash]).toEqual(block);

  await fs.mkdir(independent);
  const clip = 'b'.repeat(64);
  await fs.writeFile(path.join(independent, 'run.json'), JSON.stringify({
    job_id: clip, attempt_id: '4'.repeat(32), started_utc: first, input_sha256: independentHash,
    input_kind: 'local_video', result_kind: 'local_video_unreviewed', state: 'partial', validation: 'passed'
  }));
  await fs.writeFile(path.join(independent, 'evidence.json'), JSON.stringify({ ...draft.input, clip_id: clip }));
  await fs.writeFile(path.join(independent, 'first-pass-target.json'), JSON.stringify(draft.target));
  await fs.copyFile(path.join(__dirname, 'fixtures/reel-draft/notes.md'), path.join(independent, 'notes.md'));

  return { vault, sourceHash, current, destination, local, ledgerFile, block, older, previous, previousIdentity,
    writing, input, shared, intentFile, intent, tx, archive, stage, annotation, published };
}

async function expectFinished(context) {
  const { vault, sourceHash, current, destination, older, previous, previousIdentity, writing, shared,
    intentFile, intent, tx, archive, stage, annotation, published } = context;

  const restarted = new Intake(new Vault(vault.vault, 'Companion'));
  const result = await restarted.reconcile({ now: later });
  expect(result.blocks[sourceHash]).toBeUndefined();
  expect(result.captures[sourceHash]).toMatchObject({ currentRevision: current.currentRevision, currentHash: tx.capture.currentHash });
  expect(result.attempts[tx.revision.identity]).toMatchObject({ status: 'imported', revision: tx.revision.id });
  expect(result.captures[independentHash]).toBeDefined();
  expect(await fs.readFile(destination, 'utf8')).toBe(tx.content);
  expect(await fs.readFile(annotation, 'utf8')).toBe(intent.annotation);
  expect(intent.annotation).toContain(writing);
  expect(await identity(annotation)).toEqual({ ...published, nlink: 1n });
  expect(await json(older)).toEqual(previous);
  expect(await identity(older)).toEqual(previousIdentity);
  for (const file of [shared, intentFile, stage, archive]) {
    await expect(fs.lstat(file)).rejects.toMatchObject({ code: 'ENOENT' });
  }
}

test('restart finishes a fresh kept-current repair after publishing its active journal', async ({}, testInfo) => {
  await expectFinished(await interruptedRepair(testInfo));
});

test('restart does not adopt equal-byte replacements for both repair annotation names', async ({}, testInfo) => {
  const { vault, sourceHash, current, destination, local, ledgerFile, older, previousIdentity,
    intent, tx, stage, annotation, published } = await interruptedRepair(testInfo);
  const displacedNote = testInfo.outputPath('original-annotation.md'), displacedStage = testInfo.outputPath('original-annotation.stage');
  await fs.rename(annotation, displacedNote);
  await fs.rename(stage, displacedStage);
  await fs.writeFile(stage, intent.annotation, { flag: 'wx' });
  await fs.link(stage, annotation);
  const replacement = await identity(annotation);
  expect(replacement).not.toEqual(published);
  expect(await identity(stage)).toEqual(replacement);
  expect(await identity(displacedNote)).toEqual(published);
  expect(await identity(displacedStage)).toEqual(published);

  await new Intake(new Vault(vault.vault, 'Companion')).reconcile({ now: later }).catch(() => {});
  const ledger = await json(ledgerFile);
  expect.soft(ledger.attempts[tx.revision.identity]).toBeUndefined();
  expect.soft(ledger.captures[sourceHash]).toMatchObject({ currentRevision: current.currentRevision, currentHash: current.currentHash });
  expect.soft(await fs.readFile(destination)).toEqual(local);
  for (const file of [annotation, stage]) {
    expect.soft(await identity(file).catch(error => error.code)).toEqual(replacement);
    expect.soft(await fs.readFile(file, 'utf8').catch(error => error.code)).toBe(intent.annotation);
  }
  expect(await identity(displacedNote)).toEqual(published);
  expect(await identity(displacedStage)).toEqual(published);
  expect(await identity(older)).toEqual(previousIdentity);
});

test('fresh repair checks the annotation again before source admission', async ({}, testInfo) => {
  const { vault, sourceHash, current, ledgerFile, older, previousIdentity, shared, intent, tx, stage, annotation, published } =
    await interruptedRepair(testInfo);
  const displaced = testInfo.outputPath('displaced-annotation.md');
  const replacementBytes = 'Independent writing at the published annotation path.\n';
  let replacement;
  const restarted = new Intake(new Vault(vault.vault, 'Companion', { checkpoint: async boundary => {
    if (boundary !== 'intake-published' || replacement || (await json(shared)).resolution !== tx.resolution) return;
    expect(await identity(stage)).toEqual(published);
    expect(await identity(annotation)).toEqual(published);
    const ledger = await json(ledgerFile);
    expect(ledger.attempts[tx.revision.identity]).toBeUndefined();
    await fs.rename(annotation, displaced);
    await fs.writeFile(annotation, replacementBytes, { flag: 'wx' });
    replacement = await identity(annotation);
  } }));

  await restarted.reconcile({ now: later }).catch(() => {});
  expect(replacement, 'the annotation changed after source publication and before admission').toBeDefined();
  const ledger = await json(ledgerFile);
  expect.soft(ledger.attempts[tx.revision.identity]).toBeUndefined();
  expect.soft(ledger.captures[sourceHash]).toMatchObject({ currentRevision: current.currentRevision, currentHash: current.currentHash });
  expect(await fs.readFile(annotation, 'utf8')).toBe(replacementBytes);
  expect(await identity(annotation)).toEqual(replacement);
  for (const file of [stage, displaced]) {
    expect(await fs.readFile(file, 'utf8')).toBe(intent.annotation);
    expect(await identity(file)).toEqual(published);
  }
  expect(await identity(older)).toEqual(previousIdentity);
});

test('fresh repair retains its conflict proof across a second process exit before admission', async ({}, testInfo) => {
  const context = await interruptedRepair(testInfo);
  const { vault, sourceHash, ledgerFile, block, shared, input, tx, intentFile, intent, annotation, published } = context;
  await exitDuringRepair(vault.vault, shared, input, 'intake-snapshot');
  const ledger = await json(ledgerFile);
  expect(ledger.attempts[tx.revision.identity]).toBeUndefined();
  expect.soft(ledger.blocks[sourceHash], 'the old conflict still authorizes the exact in-flight repair').toEqual(block);
  expect(await json(shared)).toEqual(tx);
  expect(await json(intentFile)).toEqual(intent);
  expect(await identity(annotation)).toEqual(published);

  await expectFinished(context);
});
