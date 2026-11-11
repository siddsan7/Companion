const { test, expect } = require('@playwright/test');
const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
const { Vault } = require('../app/vault');
const { Intake } = require('../app/intake');
const { CaptureDeletion } = require('../app/capture-deletion');
const { AnnotationRemoval } = require('../app/annotation-removal');
const { Conversations } = require('../app/conversations');
const mixedDeletion = require('../app/mixed-deletion');
const draft = require('./fixtures/reel-draft/example.json');

const now = '2026-11-08T06:59:00.000Z';
const later = '2026-11-09T06:59:00.000Z';
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const readJson = async file => JSON.parse(await fs.readFile(file, 'utf8'));
const readOptional = file => fs.readFile(file, 'utf8').catch(error => {
  if (error.code === 'ENOENT') return null;
  throw error;
});

async function setup(testInfo, checkpoint) {
  const directory = testInfo.outputPath('vault');
  await fs.mkdir(directory, { recursive: true });
  const vault = new Vault(await fs.realpath(directory), 'Companion', { checkpoint });
  await vault.setup();
  const intake = new Intake(vault);
  return { vault, intake, ledgerFile: path.join(intake.dir, 'ledger.json') };
}

async function writeDraft(root, name = 'first', attempt = '1') {
  const directory = path.join(root, name), clip = 'b'.repeat(64);
  await fs.mkdir(directory, { recursive: true });
  await fs.writeFile(path.join(directory, 'run.json'), JSON.stringify({
    job_id: clip, attempt_id: attempt.repeat(32), started_utc: now, input_sha256: 'a'.repeat(64),
    input_kind: 'local_video', result_kind: 'local_video_unreviewed', state: 'partial', validation: 'passed'
  }));
  await fs.writeFile(path.join(directory, 'evidence.json'), JSON.stringify({ ...draft.input, clip_id: clip }));
  await fs.writeFile(path.join(directory, 'first-pass-target.json'), JSON.stringify(draft.target));
  await fs.copyFile(path.join(__dirname, 'fixtures/reel-draft/notes.md'), path.join(directory, 'notes.md'));
}

for (const kind of ['snapshot', 'capture']) test(`intake holds changed ${kind} stage bytes before publishing their final path`, async ({}, testInfo) => {
  const producer = testInfo.outputPath('producer');
  const replacement = `Independent writing at the ${kind} stage.\n`;
  let stage, destination;
  const { vault, intake } = await setup(testInfo, async boundary => {
    if (boundary !== `intake-${kind}-staged`) return;
    const tx = await readJson(path.join(intake.dir, 'transaction.json'));
    stage = path.join(intake.dir, tx.revision.id + (kind === 'snapshot' ? '.snapshot.stage' : '.stage'));
    destination = kind === 'snapshot' ? path.join(vault.root, 'Revisions', tx.revision.id + '.json') : intake.destination(tx.capture);
    expect(await readOptional(stage)).not.toBeNull();
    await fs.writeFile(stage, replacement);
  });
  await writeDraft(producer);
  const result = await intake.connect(producer, true, now);

  expect(stage, 'the real staging checkpoint was reached').toBeTruthy();
  expect.soft(await readOptional(destination), 'changed stage never acquires the final name').toBeNull();
  expect(await readOptional(stage)).toBe(replacement);
  expect(result.lastCheck.status).toBe('held');
  expect(Object.values(result.attempts)).toHaveLength(0);
});

test('intake preserves a newly occupied backup path and its current capture', async ({}, testInfo) => {
  const producer = testInfo.outputPath('producer');
  const independent = 'Independent writing that arrived at the unused backup path.\n';
  let backup, current;
  const { intake } = await setup(testInfo, async boundary => {
    if (boundary !== 'intake-before-move') return;
    const tx = await readJson(path.join(intake.dir, 'transaction.json'));
    backup = path.join(intake.dir, tx.backup);
    current = intake.destination(tx.capture);
    await fs.writeFile(backup, independent, { flag: 'wx' });
  });
  await writeDraft(producer);
  const first = await intake.connect(producer, true, now);
  expect(first.lastCheck.status).toBe('complete');
  const [capture] = Object.values(first.captures);
  const original = await fs.readFile(intake.destination(capture), 'utf8');
  await writeDraft(producer, 'second', '2');
  const updated = await intake.reconcile({ now: later });

  expect(backup, 'the real pre-move checkpoint was reached').toBeTruthy();
  expect.soft(await readOptional(backup)).toBe(independent);
  expect.soft(await readOptional(current)).toBe(original);
  expect(updated.lastCheck.status).toBe('held');
  expect(Object.keys(updated.attempts)).toEqual(Object.keys(first.attempts));
});

test('an edited ledger stage cannot replace the only committed intake ledger', async ({}, testInfo) => {
  const { intake, ledgerFile } = await setup(testInfo);
  const producer = testInfo.outputPath('producer');
  await writeDraft(producer);
  await intake.connect(producer, false, now);
  const ledger = await intake.load(), original = await fs.readFile(ledgerFile, 'utf8');
  ledger.lastCheck = { at: later, trigger: 'manual', status: 'complete' };
  const replacement = JSON.stringify({ ...ledger, suppressed: ['a'.repeat(64)] }, null, 2);
  const view = intake.storage.view.bind(intake.storage);
  let stage, edited = false;
  intake.storage.view = async file => {
    const observed = await view(file);
    if (file && /^ledger-.*\.tmp$/.test(path.basename(file))) stage = file;
    else if (stage && !edited) {
      edited = true;
      await fs.writeFile(stage, replacement);
    }
    return observed;
  };
  const outcome = await intake.save(ledger).then(() => null, error => error.message);

  expect(edited, 'the actual live ledger was read after the staged proof').toBe(true);
  expect.soft(await readOptional(ledgerFile)).toBe(original);
  expect.soft(await readOptional(stage)).toBe(replacement);
  expect(outcome).toMatch(/ledger.*changed/i);
});

test('annotation removal holds a note changed during its final ledger check', async ({}, testInfo) => {
  const producer = testInfo.outputPath('producer');
  const id = randomUUID(), independent = '\nIndependent annotation edit after the selected file was reviewed.\n';
  let armed = false, noteReads = 0, edited = false;
  const { vault, intake, ledgerFile } = await setup(testInfo, async boundary => {
    if (boundary === 'annotation-removal-before-unlink') armed = true;
  });
  await writeDraft(producer);
  const result = await intake.connect(producer, true, now);
  const [capture] = Object.values(result.captures);
  await intake.addAnnotation({ id, captureId: capture.id, text: 'Initial independent observation.' }, now);
  const file = path.join(vault.root, 'Annotations', id + '.md');
  const original = await fs.readFile(file, 'utf8');
  const removal = new AnnotationRemoval({ getVault: () => vault, clearApprovals() {} });
  const { token } = await removal.preview(id);
  const open = fs.open;
  fs.open = async (target, ...args) => {
    const handle = await open(target, ...args);
    if (!armed || target !== file && target !== ledgerFile) return handle;
    const close = handle.close.bind(handle);
    handle.close = async () => {
      await close();
      if (target === file) noteReads++;
      if (target === ledgerFile && noteReads >= 2 && !edited) {
        edited = true;
        await fs.appendFile(file, independent);
      }
    };
    return handle;
  };
  let outcome;
  try { outcome = await removal.confirm(token).then(() => null, error => error.message); }
  finally { fs.open = open; }

  expect(edited, 'the real final ledger read followed the note observations').toBe(true);
  expect.soft(await readOptional(file)).toBe(original + independent);
  expect.soft((await readJson(ledgerFile)).annotationRemovals[id].phase).toBe('removing');
  expect(outcome).toMatch(/changed|preserv/i);
});

for (const role of ['retained writing', 'reviewed origin']) test(`mixed source deletion holds ${role} changed after its final inspection`, async ({}, testInfo) => {
  const producer = testInfo.outputPath('producer');
  let keptCurrentRead = false;
  const { vault, intake, ledgerFile } = await setup(testInfo, async boundary => {
    if (boundary === 'repair-intent-published') keptCurrentRead = true;
    if (boundary === 'kept-current-read' && keptCurrentRead) {
      throw Object.assign(Error('Controlled kept-current file access failure.'), { code: 'EACCES' });
    }
  });
  await fs.cp(path.join(__dirname, 'fixtures/reel-review/accept'), path.join(producer, 'accept'), { recursive: true });
  const first = await intake.connect(producer, true, now, 'review');
  expect(first.lastCheck.status).toBe('complete');
  const [sourceHash, capture] = Object.entries(first.captures)[0];
  const captureFile = intake.destination(capture);
  await fs.appendFile(captureFile, '\nWhole independent local observation.\n');
  const whole = await fs.readFile(captureFile);
  await fs.cp(path.join(__dirname, 'fixtures/reel-review/edit'), path.join(producer, 'edit'), { recursive: true });
  expect((await intake.reconcile({ now: later })).lastCheck.status).toBe('held');
  await expect(intake.resolveConflict({ sourceHash, text: 'Selected independent annotation.', localHash: hash(whole) }, later))
    .rejects.toThrow(/annotation preserved/i);
  expect(keptCurrentRead).toBe(true);

  const getVault = () => vault, clock = () => ({ now: later });
  const conversations = new Conversations({ dataRoot: testInfo.outputPath('history'), getVault, clock });
  await conversations.lock(async () => {});
  const removal = new CaptureDeletion({ getVault, conversations, clock, clearApprovals() {} });
  const preview = await removal.preview(capture.id);
  const origins = new Map(await Promise.all(preview.targets.map(async name => {
    const file = path.join(vault.vault, name);
    return [file, await fs.readFile(file, 'utf8')];
  })));
  const independent = '\nIndependent edit after the final deletion inspection.\n';
  const inspect = mixedDeletion.inspect;
  let edited, editedBytes;
  mixedDeletion.inspect = async (owner, ledger, id, requirePublished) => {
    const observed = await inspect(owner, ledger, id, requirePublished);
    if (requirePublished && id === capture.id && !edited) {
      const authority = ledger.sourceAuthority[id];
      const name = role === 'retained writing' ? authority.preservedWriting[0].file : observed[0].file;
      edited = path.join(vault.vault, name);
      editedBytes = (await fs.readFile(edited, 'utf8')) + independent;
      await fs.writeFile(edited, editedBytes);
    }
    return observed;
  };
  let outcome;
  try { outcome = await removal.confirm(preview.token).then(() => null, error => error.message); }
  finally { mixedDeletion.inspect = inspect; }

  expect(edited, 'the actual final mixed source inspection was reached').toBeTruthy();
  for (const [file, bytes] of origins) expect.soft(await readOptional(file), path.basename(file)).toBe(file === edited ? editedBytes : bytes);
  expect.soft(await readOptional(edited)).toBe(editedBytes);
  expect((await readJson(ledgerFile)).sourceAuthority[capture.id].phase).toBe('deleting');
  expect(outcome).toMatch(/changed|preserv/i);
});
