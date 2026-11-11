const { test, expect } = require('@playwright/test');
const fs = require('node:fs/promises');
const native = require('node:fs');
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
    const native = require('node:fs');
    const path = require('node:path');
    const { Vault } = require('./app/vault');
    const { Intake } = require('./app/intake');
    const [directory, shared, rawInput, now, stopAt] = process.argv.slice(1);
    const input = JSON.parse(rawInput), link = fs.link, unlink = fs.unlink;
    const linkSync = native.linkSync, unlinkSync = native.unlinkSync;
    const intent = path.join(path.dirname(shared), 'repair-intent.json');
    const ledgerFile = path.join(path.dirname(shared), 'ledger.json');
    const selected = tx => tx.sourceHash === input.sourceHash && tx.keptCurrent && tx.resolution;
    let exactStage;
    const observeLink = (from, to) => {
      if (stopAt === 'repair-hold-intent-link' && from === intent) {
        const repair = JSON.parse(native.readFileSync(intent, 'utf8'));
        if (repair.sourceProof && selected(repair.tx) && to === path.join(path.dirname(intent), 'repair-' + repair.annotationId + '.json')) process.exit(77);
      }
      if (to !== shared || !/^journal-[a-f0-9-]{36}\.stage$/.test(path.basename(from))) return;
      if (!selected(JSON.parse(native.readFileSync(to, 'utf8')))) return;
      if (stopAt === 'repair-source-first-link') process.exit(77);
      exactStage = from;
    };
    const beforeLink = (from, to) => {
      if (stopAt !== 'repair-hold-ledger-before-source-link' || from !== shared) return;
      const tx = JSON.parse(native.readFileSync(shared, 'utf8'));
      if (!selected(tx) || to !== path.join(path.dirname(shared), 'conflict-' + tx.revision.id + '-' + tx.resolution + '.json')) return;
      const ledger = JSON.parse(native.readFileSync(ledgerFile, 'utf8'));
      const hold = ledger.blocks[tx.sourceHash];
      if (hold?.journal === path.basename(to) && hold.outputHold?.mode === 'precommit-conflict') process.exit(77);
    };
    fs.link = async (from, to) => {
      beforeLink(from, to);
      await link(from, to);
      observeLink(from, to);
    };
    native.linkSync = (from, to) => {
      beforeLink(from, to);
      linkSync(from, to);
      observeLink(from, to);
    };
    fs.unlink = async file => {
      await unlink(file);
      if (!stopAt && file === exactStage) process.exit(77);
    };
    native.unlinkSync = file => {
      unlinkSync(file);
      if (!stopAt && file === exactStage) process.exit(77);
    };
    const intake = new Intake(new Vault(directory, 'Companion', { checkpoint: async boundary => {
      if (boundary !== stopAt) return;
      const tx = boundary === 'repair-intent-published' ? JSON.parse(await fs.readFile(intent, 'utf8')).tx :
        JSON.parse(await fs.readFile(shared, 'utf8'));
      if (selected(tx)) process.exit(77);
    } }));
    const startRepair = !stopAt || stopAt === 'repair-source-first-link' || stopAt === 'repair-intent-published';
    const operation = startRepair ? intake.resolveConflict(input, now) : intake.reconcile({ now });
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

async function repairConflict(testInfo) {
  const directory = testInfo.outputPath('vault'), reviews = testInfo.outputPath('reviews'), drafts = testInfo.outputPath('drafts');
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
  return { vault, intake, drafts, sourceHash, current, destination, local, ledgerFile, block, older, previous, previousIdentity,
    writing, input, shared, intentFile };
}

async function interruptedRepair(testInfo, checkpoint = '') {
  const context = await repairConflict(testInfo);
  const { vault, intake, drafts, sourceHash, current, ledgerFile, block, input, shared, intentFile } = context;
  await exitDuringRepair(vault.vault, shared, input, checkpoint);
  const intent = await json(intentFile), tx = intent.tx;
  const archive = path.join(intake.dir, `repair-${intent.annotationId}.json`);
  const stage = path.join(intake.dir, `annotation-${intent.annotationId}.stage`);
  const annotation = path.join(vault.root, 'Annotations', `${intent.annotationId}.md`);
  expect(tx).toMatchObject({ sourceHash, keptCurrent: { id: current.currentRevision }, revision: { id: block.incomingRevision } });
  expect(await json(shared)).toEqual(tx);
  const sourceIdentity = await identity(shared);
  let sourceStage;
  if (checkpoint === 'repair-source-first-link') {
    expect(sourceIdentity.nlink).toBe(2n);
    const names = (await fs.readdir(intake.dir)).filter(name => /^journal-[a-f0-9-]{36}\.stage$/.test(name));
    const candidates = await Promise.all(names.map(async name => {
      const file = path.join(intake.dir, name);
      return { file, identity: await identity(file) };
    }));
    const matching = candidates.filter(item => item.identity.dev === sourceIdentity.dev && item.identity.ino === sourceIdentity.ino);
    expect(matching).toHaveLength(1);
    sourceStage = matching[0].file;
    expect(matching[0].identity).toEqual(sourceIdentity);
    expect(await fs.readFile(sourceStage)).toEqual(await fs.readFile(shared));
  } else expect(sourceIdentity.nlink).toBe(1n);
  expect((await identity(intentFile)).nlink).toBe(1n);
  await expect(fs.lstat(archive)).rejects.toMatchObject({ code: 'ENOENT' });
  expect(await fs.readFile(annotation, 'utf8')).toBe(intent.annotation);
  const published = await identity(annotation);
  expect(published.nlink).toBe(2n);
  expect(await identity(stage)).toEqual(published);
  expect((await json(ledgerFile)).blocks[sourceHash]).toEqual(block);

  const independent = path.join(drafts, 'independent');
  await fs.mkdir(independent);
  const clip = 'b'.repeat(64);
  await fs.writeFile(path.join(independent, 'run.json'), JSON.stringify({
    job_id: clip, attempt_id: '4'.repeat(32), started_utc: first, input_sha256: independentHash,
    input_kind: 'local_video', result_kind: 'local_video_unreviewed', state: 'partial', validation: 'passed'
  }));
  await fs.writeFile(path.join(independent, 'evidence.json'), JSON.stringify({ ...draft.input, clip_id: clip }));
  await fs.writeFile(path.join(independent, 'first-pass-target.json'), JSON.stringify(draft.target));
  await fs.copyFile(path.join(__dirname, 'fixtures/reel-draft/notes.md'), path.join(independent, 'notes.md'));

  return { ...context, intent, tx, archive, stage, annotation, published, sourceStage };
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

test('restart retires the exact source stage after a fresh repair first links its journal', async ({}, testInfo) => {
  const context = await interruptedRepair(testInfo, 'repair-source-first-link');
  await expectFinished(context);
  await expect(fs.lstat(context.sourceStage)).rejects.toMatchObject({ code: 'ENOENT' });
});

test('an intent-only restart refuses a fresh repair after its original ledger block is removed', async ({}, testInfo) => {
  const { vault, intake, sourceHash, ledgerFile, block, older, previous, previousIdentity, destination, local,
    input, shared, intentFile } = await repairConflict(testInfo);
  await exitDuringRepair(vault.vault, shared, input, 'repair-intent-published');
  const originalIntent = await fs.readFile(intentFile), intentIdentity = await identity(intentFile);
  const intent = JSON.parse(originalIntent);
  const stage = path.join(intake.dir, `annotation-${intent.annotationId}.stage`);
  const annotation = path.join(vault.root, 'Annotations', `${intent.annotationId}.md`);
  const sourceArchive = path.join(intake.dir, `conflict-${intent.tx.revision.id}-${intent.tx.resolution}.json`);
  const ledger = await json(ledgerFile);
  expect(ledger.blocks[sourceHash]).toEqual(block);
  expect(ledger.attempts[intent.tx.revision.identity]).toBeUndefined();
  expect(intentIdentity.nlink).toBe(1n);
  for (const file of [shared, stage, annotation]) await expect(fs.lstat(file)).rejects.toMatchObject({ code: 'ENOENT' });
  delete ledger.blocks[sourceHash];
  const edited = JSON.stringify(ledger, null, 2);
  await fs.writeFile(ledgerFile, edited);

  const restarted = new Intake(new Vault(vault.vault, 'Companion'));
  await restarted.locked(() => restarted.load()).catch(() => {});
  expect.soft(await fs.readFile(ledgerFile, 'utf8')).toBe(edited);
  expect.soft((await json(ledgerFile)).attempts[intent.tx.revision.identity]).toBeUndefined();
  expect.soft(await fs.readFile(destination)).toEqual(local);
  for (const file of [shared, stage, annotation, sourceArchive]) await expect.soft(fs.lstat(file)).rejects.toMatchObject({ code: 'ENOENT' });
  expect.soft(await fs.readFile(intentFile).catch(error => error.code)).toEqual(originalIntent);
  expect.soft(await identity(intentFile).catch(error => error.code)).toEqual(intentIdentity);
  expect(await json(older)).toEqual(previous);
  expect(await identity(older)).toEqual(previousIdentity);
});

test('fresh repair does not rebase its conflict authority before the first annotation link', async ({}, testInfo) => {
  const { vault, intake, sourceHash, ledgerFile, block, older, previous, previousIdentity, destination, local,
    input, shared, intentFile } = await repairConflict(testInfo);
  await exitDuringRepair(vault.vault, shared, input, 'repair-intent-published');
  const originalIntent = await fs.readFile(intentFile), intent = JSON.parse(originalIntent), intentIdentity = await identity(intentFile);
  const stage = path.join(intake.dir, `annotation-${intent.annotationId}.stage`);
  const annotation = path.join(vault.root, 'Annotations', `${intent.annotationId}.md`);
  const restarted = new Intake(new Vault(vault.vault, 'Companion'));
  const bind = restarted.boundRepairConflict.bind(restarted);
  let edited;
  restarted.boundRepairConflict = (...args) => {
    const verify = bind(...args);
    if (edited) return verify;
    const ledger = JSON.parse(native.readFileSync(ledgerFile, 'utf8'));
    expect(ledger.blocks[sourceHash]).toEqual(block);
    delete ledger.blocks[sourceHash];
    edited = JSON.stringify(ledger, null, 2);
    native.writeFileSync(ledgerFile, edited);
    return verify;
  };

  await restarted.locked(() => restarted.load()).catch(() => {});
  expect(edited, 'the ledger changed after the original conflict was verified').toBeDefined();
  expect.soft(await fs.readFile(ledgerFile, 'utf8')).toBe(edited);
  expect.soft((await json(ledgerFile)).attempts[intent.tx.revision.identity]).toBeUndefined();
  expect.soft(await fs.readFile(destination)).toEqual(local);
  for (const file of [annotation, stage, shared]) await expect.soft(fs.lstat(file)).rejects.toMatchObject({ code: 'ENOENT' });
  expect.soft(await fs.readFile(intentFile).catch(error => error.code)).toEqual(originalIntent);
  expect.soft(await identity(intentFile).catch(error => error.code)).toEqual(intentIdentity);
  expect(await json(older)).toEqual(previous);
  expect(await identity(older)).toEqual(previousIdentity);
});

test('fresh repair does not rebase its conflict authority before the first source link', async ({}, testInfo) => {
  const { vault, intake, sourceHash, ledgerFile, block, older, previous, previousIdentity, destination, local,
    input, shared, intentFile } = await repairConflict(testInfo);
  let armed = false, witness;
  const restarted = new Intake(new Vault(vault.vault, 'Companion', { checkpoint: boundary => {
    if (boundary === 'repair-annotation-published') armed = true;
  } }));
  const view = restarted.storage.view.bind(restarted.storage);
  restarted.storage.view = async (...args) => {
    const observed = await view(...args);
    if (!armed || witness || args.length) return observed;
    const ledger = JSON.parse(observed.text);
    expect(ledger.blocks[sourceHash]).toEqual(block);
    const bytes = await fs.readFile(intentFile), intent = JSON.parse(bytes), intentIdentity = await identity(intentFile);
    const stage = path.join(intake.dir, `annotation-${intent.annotationId}.stage`);
    const annotation = path.join(vault.root, 'Annotations', `${intent.annotationId}.md`);
    const annotationIdentity = await identity(annotation);
    expect(annotationIdentity.nlink).toBe(2n);
    expect(await identity(stage)).toEqual(annotationIdentity);
    expect(intent.sourceProof).toBeUndefined();
    await expect(fs.lstat(shared)).rejects.toMatchObject({ code: 'ENOENT' });
    delete ledger.blocks[sourceHash];
    const edited = JSON.stringify(ledger, null, 2);
    await fs.writeFile(ledgerFile, edited);
    witness = { edited, bytes, intent, intentIdentity, stage, annotation, annotationIdentity };
    return observed;
  };

  await restarted.resolveConflict(input, later).catch(() => {});
  expect(witness, 'the ledger changed after its last authority view and before source publication').toBeDefined();
  expect.soft(await fs.readFile(ledgerFile, 'utf8')).toBe(witness.edited);
  expect.soft((await json(ledgerFile)).attempts[witness.intent.tx.revision.identity]).toBeUndefined();
  expect.soft(await fs.readFile(destination)).toEqual(local);
  await expect.soft(fs.lstat(shared)).rejects.toMatchObject({ code: 'ENOENT' });
  const sourceStage = path.join(intake.dir, `journal-${witness.intent.annotationId}.stage`);
  await expect.soft(fs.lstat(sourceStage)).rejects.toMatchObject({ code: 'ENOENT' });
  expect.soft(await fs.readFile(intentFile)).toEqual(witness.bytes);
  expect.soft(await identity(intentFile)).toEqual(witness.intentIdentity);
  for (const file of [witness.stage, witness.annotation]) {
    expect(await identity(file)).toEqual(witness.annotationIdentity);
    expect(await fs.readFile(file, 'utf8')).toBe(witness.intent.annotation);
  }
  expect(await json(older)).toEqual(previous);
  expect(await identity(older)).toEqual(previousIdentity);
});

test('a failed kept-current read does not adopt a separate equal-byte repair archive', async ({}, testInfo) => {
  const { vault, intake, input, sourceHash, block, ledgerFile, older, previous, previousIdentity, shared, intentFile } =
    await repairConflict(testInfo);
  let armed = false, witness;
  const restarted = new Intake(new Vault(vault.vault, 'Companion', { checkpoint: async boundary => {
    if (boundary === 'repair-intent-published') { armed = true; return; }
    if (!armed || witness || boundary !== 'kept-current-read') return;
    const bytes = await fs.readFile(intentFile), intent = JSON.parse(bytes), intentIdentity = await identity(intentFile);
    const archive = path.join(intake.dir, `repair-${intent.annotationId}.json`);
    const sourceArchive = path.join(intake.dir, `conflict-${intent.tx.revision.id}-${intent.tx.resolution}.json`);
    await fs.writeFile(archive, bytes, { flag: 'wx' });
    const archiveIdentity = await identity(archive);
    expect(intentIdentity.nlink).toBe(1n);
    expect(archiveIdentity.nlink).toBe(1n);
    expect(archiveIdentity).not.toEqual(intentIdentity);
    expect(await fs.readFile(archive)).toEqual(bytes);
    const ledger = await fs.readFile(ledgerFile);
    expect(JSON.parse(ledger).blocks[sourceHash]).toEqual(block);
    witness = { bytes, intentIdentity, archive, archiveIdentity, sourceArchive, ledger };
    throw Object.assign(Error('Fixture kept-current snapshot is inaccessible.'), { code: 'EACCES' });
  } }));

  await restarted.resolveConflict(input, later).catch(() => {});
  expect(witness, 'the equal-byte independent archive was written before the kept-current read failed').toBeDefined();
  expect.soft(await fs.readFile(ledgerFile)).toEqual(witness.ledger);
  expect.soft(await fs.readFile(intentFile).catch(error => error.code)).toEqual(witness.bytes);
  expect.soft(await identity(intentFile).catch(error => error.code)).toEqual(witness.intentIdentity);
  expect(await fs.readFile(witness.archive)).toEqual(witness.bytes);
  expect(await identity(witness.archive)).toEqual(witness.archiveIdentity);
  await expect(fs.lstat(shared)).rejects.toMatchObject({ code: 'ENOENT' });
  await expect.soft(fs.lstat(witness.sourceArchive)).rejects.toMatchObject({ code: 'ENOENT' });
  expect(await json(older)).toEqual(previous);
  expect(await identity(older)).toEqual(previousIdentity);
});

for (const { checkpoint, title, committed } of [
  { checkpoint: 'repair-hold-intent-link', title: 'held repair restart refuses an equal-byte replacement after archiving its intent', committed: false },
  { checkpoint: 'repair-hold-ledger-before-source-link', title: 'committed repair hold verifies its source before retiring annotation evidence', committed: true }
]) test(title, async ({}, testInfo) => {
  const { vault, intake, sourceHash, block, older, previous, previousIdentity, ledgerFile,
    shared, input, tx, intent, intentFile, archive, stage, annotation, published } = await interruptedRepair(testInfo);
  const snapshot = path.join(vault.root, 'Revisions', `${tx.keptCurrent.id}.json`);
  const displacedSnapshot = testInfo.outputPath('kept-snapshot-for-hold.json');
  const snapshotBytes = await fs.readFile(snapshot), snapshotIdentity = await identity(snapshot);
  await fs.rename(snapshot, displacedSnapshot);
  await exitDuringRepair(vault.vault, shared, input, checkpoint);
  const before = await fs.readFile(ledgerFile), ledger = JSON.parse(before);
  const originalSource = await identity(shared), sourceBytes = await fs.readFile(shared);
  expect(originalSource).toEqual({ dev: BigInt(intent.sourceProof.dev), ino: BigInt(intent.sourceProof.ino), nlink: 1n });
  expect(JSON.parse(sourceBytes)).toEqual(tx);
  expect(ledger.attempts[tx.revision.identity]).toBeUndefined();
  const sourceArchive = path.join(intake.dir, `conflict-${tx.revision.id}-${tx.resolution}.json`);
  if (committed) {
    expect(ledger.blocks[sourceHash]).toMatchObject({ journal: path.basename(sourceArchive), incomingRevision: tx.revision.id,
      outputHold: { mode: 'precommit-conflict', committed: false, journal: intent.sourceProof } });
  } else expect(ledger.blocks[sourceHash]).toEqual(block);
  await expect(fs.lstat(sourceArchive)).rejects.toMatchObject({ code: 'ENOENT' });
  const intentBytes = await fs.readFile(intentFile), intentIdentity = await identity(intentFile);
  expect(intentIdentity.nlink).toBe(2n);
  expect(await identity(archive)).toEqual(intentIdentity);
  expect(await fs.readFile(archive)).toEqual(intentBytes);
  expect(await identity(stage)).toEqual(published);
  expect(await identity(annotation)).toEqual(published);

  const displacedSource = testInfo.outputPath('original-active-repair-source.json');
  await fs.rename(shared, displacedSource);
  await fs.writeFile(shared, sourceBytes, { flag: 'wx' });
  const replacement = await identity(shared);
  expect(replacement).not.toEqual(originalSource);
  await fs.rename(displacedSnapshot, snapshot);
  expect(await identity(snapshot)).toEqual(snapshotIdentity);
  const restarted = new Intake(new Vault(vault.vault, 'Companion'));
  await restarted.locked(() => restarted.load()).catch(() => {});

  expect.soft(await fs.readFile(ledgerFile)).toEqual(before);
  expect.soft(await identity(shared).catch(error => error.code)).toEqual(replacement);
  expect.soft(await fs.readFile(shared).catch(error => error.code)).toEqual(sourceBytes);
  expect(await identity(displacedSource)).toEqual(originalSource);
  expect(await fs.readFile(displacedSource)).toEqual(sourceBytes);
  await expect.soft(fs.lstat(sourceArchive)).rejects.toMatchObject({ code: 'ENOENT' });
  for (const file of [intentFile, archive]) {
    expect.soft(await identity(file).catch(error => error.code)).toEqual(intentIdentity);
    expect.soft(await fs.readFile(file).catch(error => error.code)).toEqual(intentBytes);
  }
  for (const file of [stage, annotation]) {
    expect.soft(await identity(file).catch(error => error.code)).toEqual(published);
    expect.soft(await fs.readFile(file, 'utf8').catch(error => error.code)).toBe(intent.annotation);
  }
  expect(await json(older)).toEqual(previous);
  expect(await identity(older)).toEqual(previousIdentity);
  expect(await fs.readFile(snapshot)).toEqual(snapshotBytes);
  expect(await identity(snapshot)).toEqual(snapshotIdentity);
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

test('fresh repair does not adopt an equal-byte replacement of the exclusive annotation stage', async ({}, testInfo) => {
  const { vault, intake, sourceHash, input, ledgerFile, block, local, destination, shared, intentFile } = await repairConflict(testInfo);
  const displaced = testInfo.outputPath('original-exclusive-annotation.stage');
  const writeFile = fs.writeFile, open = fs.open;
  const isStage = file => typeof file === 'string' && path.dirname(file) === intake.dir &&
    /^annotation-[a-f0-9-]{36}\.stage$/.test(path.basename(file));
  let witness;
  const replaceStage = async file => {
    if (witness) return;
    const intent = await json(intentFile), original = await identity(file);
    expect(path.basename(file)).toBe(`annotation-${intent.annotationId}.stage`);
    expect(original.nlink).toBe(1n);
    const bytes = await fs.readFile(file);
    expect(bytes.toString('utf8')).toBe(intent.annotation);
    await fs.rename(file, displaced);
    await writeFile(file, bytes, { flag: 'wx' });
    const replacement = await identity(file);
    expect(replacement).not.toEqual(original);
    witness = { file, intent, bytes, original, replacement };
  };
  fs.writeFile = async (file, bytes, options) => {
    await writeFile(file, bytes, options);
    if (isStage(file) && options?.flag === 'wx') await replaceStage(file);
  };
  fs.open = async (file, flags, mode) => {
    const handle = await open(file, flags, mode);
    if (isStage(file) && flags === 'wx') {
      const close = handle.close.bind(handle);
      handle.close = async () => { await close(); await replaceStage(file); };
    }
    return handle;
  };
  try { await intake.resolveConflict(input, later).catch(() => {}); }
  finally { fs.writeFile = writeFile; fs.open = open; }
  expect(witness, 'the genuine stage was replaced immediately after its exclusive write').toBeDefined();
  const { file, intent, bytes, original, replacement } = witness;
  const annotation = path.join(vault.root, 'Annotations', `${intent.annotationId}.md`);
  const ledger = await json(ledgerFile);
  expect.soft(ledger.attempts[intent.tx.revision.identity]).toBeUndefined();
  expect.soft(ledger.blocks[sourceHash]).toEqual(block);
  expect.soft(await fs.readFile(destination)).toEqual(local);
  await expect(fs.lstat(shared)).rejects.toMatchObject({ code: 'ENOENT' });
  await expect.soft(fs.lstat(annotation)).rejects.toMatchObject({ code: 'ENOENT' });
  expect.soft(await identity(file).catch(error => error.code)).toEqual(replacement);
  expect.soft(await fs.readFile(file).catch(error => error.code)).toEqual(bytes);
  expect(await identity(displaced)).toEqual(original);
  expect(await fs.readFile(displaced)).toEqual(bytes);
});

test('accepted repair restart settles its annotation without reading the kept snapshot again', async ({}, testInfo) => {
  const { vault, sourceHash, ledgerFile, shared, input, tx, intentFile, intent, archive, stage, annotation, published } =
    await interruptedRepair(testInfo);
  await exitDuringRepair(vault.vault, shared, input, 'intake-ledger');
  const accepted = await json(ledgerFile);
  expect(accepted.attempts[tx.revision.identity]).toMatchObject({ status: 'imported', revision: tx.revision.id });
  expect(accepted.outcomes[tx.key]).toEqual(accepted.attempts[tx.revision.identity]);
  expect(accepted.acceptedCleanup).toMatchObject({ sourceHash, revision: tx.revision.id, resolution: tx.resolution });
  expect(accepted.blocks[sourceHash]).toBeUndefined();
  expect(await json(shared)).toEqual(tx);
  const keptSnapshot = path.join(vault.root, 'Revisions', `${tx.keptCurrent.id}.json`);
  const displaced = testInfo.outputPath('original-kept-snapshot.json');
  const snapshot = await fs.readFile(keptSnapshot), snapshotIdentity = await identity(keptSnapshot);
  await fs.rename(keptSnapshot, displaced);

  const restarted = new Intake(new Vault(vault.vault, 'Companion'));
  const link = fs.link, linkSync = native.linkSync;
  const recreated = [];
  fs.link = async (from, to) => {
    await link(from, to);
    if (to === shared) recreated.push(from);
  };
  native.linkSync = (from, to) => {
    linkSync(from, to);
    if (to === shared) recreated.push(from);
  };
  let recoveryError;
  try { await restarted.locked(() => restarted.load()); }
  catch (error) { recoveryError = error; }
  finally { fs.link = link; native.linkSync = linkSync; }
  const settled = await json(ledgerFile);
  expect.soft(recoveryError).toBeUndefined();
  expect.soft(recreated).toEqual([]);
  expect.soft(settled.blocks[sourceHash]).toBeUndefined();
  expect.soft(settled.captures[sourceHash]).toEqual(accepted.captures[sourceHash]);
  expect.soft(settled.attempts).toEqual(accepted.attempts);
  expect.soft(settled.outcomes[tx.key]).toEqual(accepted.outcomes[tx.key]);
  expect(settled.acceptedCleanup).toBeUndefined();
  for (const file of [shared, intentFile, stage, archive, keptSnapshot]) {
    await expect.soft(fs.lstat(file)).rejects.toMatchObject({ code: 'ENOENT' });
  }
  expect(await fs.readFile(annotation, 'utf8')).toBe(intent.annotation);
  expect.soft(await identity(annotation)).toEqual({ ...published, nlink: 1n });
  expect(await fs.readFile(displaced)).toEqual(snapshot);
  expect(await identity(displaced)).toEqual(snapshotIdentity);
});
