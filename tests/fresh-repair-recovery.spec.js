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
const json = async file => JSON.parse(await fs.readFile(file, 'utf8'));
const identity = async file => {
  const { dev, ino, nlink } = await fs.lstat(file, { bigint: true });
  return { dev, ino, nlink };
};

async function exitAfterRepairJournal(directory, shared, input) {
  const code = String.raw`
    const fs = require('node:fs/promises');
    const path = require('node:path');
    const { Vault } = require('./app/vault');
    const { Intake } = require('./app/intake');
    const [directory, shared, rawInput, now] = process.argv.slice(1);
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
    const intake = new Intake(new Vault(directory, 'Companion'));
    intake.resolveConflict(input, now).then(() => process.exit(78), error => {
      console.error(error);
      process.exit(79);
    });
  `;
  const child = spawn(process.execPath, ['-e', code, directory, shared, JSON.stringify(input), later], {
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

test('restart finishes a fresh kept-current repair after publishing its active journal', async ({}, testInfo) => {
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
  await exitAfterRepairJournal(vault.vault, shared, input);
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
  const clip = 'b'.repeat(64), independentHash = 'd'.repeat(64);
  await fs.writeFile(path.join(independent, 'run.json'), JSON.stringify({
    job_id: clip, attempt_id: '4'.repeat(32), started_utc: first, input_sha256: independentHash,
    input_kind: 'local_video', result_kind: 'local_video_unreviewed', state: 'partial', validation: 'passed'
  }));
  await fs.writeFile(path.join(independent, 'evidence.json'), JSON.stringify({ ...draft.input, clip_id: clip }));
  await fs.writeFile(path.join(independent, 'first-pass-target.json'), JSON.stringify(draft.target));
  await fs.copyFile(path.join(__dirname, 'fixtures/reel-draft/notes.md'), path.join(independent, 'notes.md'));

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
});
