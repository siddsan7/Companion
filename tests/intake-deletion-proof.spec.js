const { test, expect } = require('@playwright/test');
const fs = require('node:fs/promises');
const local = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
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

async function writeDraft(root, name = 'first', attempt = '1', input = 'a') {
  const directory = path.join(root, name), clip = 'b'.repeat(64);
  await fs.mkdir(directory, { recursive: true });
  await fs.writeFile(path.join(directory, 'run.json'), JSON.stringify({
    job_id: clip, attempt_id: attempt.repeat(32), started_utc: now, input_sha256: input.repeat(64),
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

for (const phase of ['before ledger replacement', 'after ledger commit']) {
  for (const kind of ['snapshot', 'capture']) test(`intake holds an independently replaced ${kind} ${phase}`, async ({}, testInfo) => {
    const producer = testInfo.outputPath('producer');
    const foreign = `Independent file at the published ${kind} path.\n`;
    const checkIndependent = kind === 'capture' && phase === 'after ledger commit';
    let armed = false, mutation;
    const { vault, intake, ledgerFile } = await setup(testInfo, async boundary => {
      if (boundary === 'intake-published') armed = true;
      if (boundary === 'intake-ledger' && phase === 'after ledger commit' && !mutation) await replaceOutput();
    });
    const journal = path.join(intake.dir, 'transaction.json');
    async function replaceOutput() {
      expect(mutation).toBeUndefined();
      const journalBytes = await fs.readFile(journal, 'utf8'), tx = JSON.parse(journalBytes);
      const captureStage = path.join(intake.dir, tx.revision.id + '.stage');
      const snapshotStage = path.join(intake.dir, tx.revision.id + '.snapshot.stage');
      const stage = kind === 'snapshot' ? snapshotStage : captureStage;
      const destination = kind === 'snapshot' ? path.join(vault.root, 'Revisions', tx.revision.id + '.json') : intake.destination(tx.capture);
      const stageBefore = await fs.lstat(stage, { bigint: true }), destinationBefore = await fs.lstat(destination, { bigint: true });
      expect(stageBefore.nlink).toBe(2n);
      expect([stageBefore.dev, stageBefore.ino]).toEqual([destinationBefore.dev, destinationBefore.ino]);
      const retained = new Map(await Promise.all([captureStage, snapshotStage, journal].map(async file => [file, await fs.readFile(file, 'utf8')])));
      const before = await readJson(ledgerFile);
      if (phase === 'after ledger commit') {
        expect(before.attempts[tx.revision.identity]).toMatchObject({ status: 'imported', revision: tx.revision.id, captureId: tx.capture.id });
      } else expect(before.attempts[tx.revision.identity]).toBeUndefined();
      // Detach the actual published name while retaining its exact original stage.
      await fs.unlink(destination);
      await fs.writeFile(destination, foreign, { flag: 'wx' });
      const foreignIdentity = await fs.lstat(destination, { bigint: true });
      expect([foreignIdentity.dev, foreignIdentity.ino]).not.toEqual([stageBefore.dev, stageBefore.ino]);
      mutation = { tx, retained, destination, stage, stageBefore, foreignIdentity };
    }
    await writeDraft(producer);
    if (checkIndependent) await writeDraft(producer, 'z-independent', '2', 'c');
    await intake.connect(producer, false, now);
    const open = fs.open;
    fs.open = async (file, ...args) => {
      const handle = await open(file, ...args);
      if (phase !== 'before ledger replacement' || !armed || mutation || args[0] !== 'wx' ||
        typeof file !== 'string' || path.dirname(file) !== intake.dir || !/^ledger-.*\.tmp$/.test(path.basename(file))) return handle;
      const close = handle.close.bind(handle);
      handle.close = async () => {
        await close();
        const prepared = await readJson(file), tx = await readJson(journal);
        expect(prepared.attempts[tx.revision.identity]).toMatchObject({ status: 'imported', revision: tx.revision.id });
        await replaceOutput();
      };
      return handle;
    };
    let result, error;
    try { result = await intake.reconcile({ now: later }); }
    catch (caught) { error = caught; }
    finally { fs.open = open; }

    expect(mutation, 'the real output pair and ledger boundary were reached').toBeDefined();
    const { tx, retained, destination, stage, stageBefore, foreignIdentity } = mutation;
    const committed = await readJson(ledgerFile);
    expect.soft(committed.lastCheck?.status).not.toBe('complete');
    expect.soft(result?.lastCheck?.status || error?.message).toMatch(/held|error|changed|preserv/i);
    if (phase === 'after ledger commit') {
      expect.soft(committed.attempts[tx.revision.identity]).toMatchObject({ status: 'imported', revision: tx.revision.id, captureId: tx.capture.id });
    } else {
      expect.soft(committed.attempts[tx.revision.identity]).toBeUndefined();
      expect.soft(committed.captures[tx.sourceHash]).toBeUndefined();
    }
    const heldName = committed.blocks[tx.sourceHash]?.journal;
    const heldJournal = heldName ? path.join(intake.dir, heldName) : journal;
    for (const [file, bytes] of retained) expect.soft(await readOptional(file === journal ? heldJournal : file), path.basename(file)).toBe(bytes);
    expect.soft(await readOptional(destination)).toBe(foreign);
    const actualForeign = await fs.lstat(destination, { bigint: true });
    expect([actualForeign.dev, actualForeign.ino]).toEqual([foreignIdentity.dev, foreignIdentity.ino]);
    const actualStage = await fs.lstat(stage, { bigint: true }).catch(error => {
      if (error.code === 'ENOENT') return null;
      throw error;
    });
    expect.soft(actualStage && [actualStage.dev, actualStage.ino, actualStage.nlink]).toEqual([stageBefore.dev, stageBefore.ino, 1n]);
    if (checkIndependent) {
      expect.soft(Object.values(committed.attempts)).toHaveLength(2);
      expect.soft(Object.values(committed.captures)).toHaveLength(2);
      const restarted = new Intake(new Vault(vault.vault, 'Companion'));
      const recovered = await restarted.reconcile({ now: '2026-11-10T06:59:00.000Z' });
      expect(recovered.lastCheck.status).toBe('held');
      expect(recovered.attempts).toEqual(committed.attempts);
      for (const [file, bytes] of retained) expect.soft(await readOptional(file === journal ? heldJournal : file)).toBe(bytes);
      expect(await fs.readFile(destination, 'utf8')).toBe(foreign);
    }
  });
}

for (const boundary of ['held ledger rename', 'held journal link', 'edited journal']) test(
  boundary === 'edited journal'
    ? 'deferred intake restart refuses a same-ID held journal edited in place'
    : `deferred intake hold resumes after interruption at the ${boundary}`,
  async ({}, testInfo) => {
  const producer = testInfo.outputPath('producer');
  const interruption = Error('Stopped after the real held-journal transition.');
  let deferMove = false, changeOutput = false, changed;
  const { vault, intake, ledgerFile } = await setup(testInfo, async name => {
    if (name === 'intake-before-move' && deferMove) throw Object.assign(Error('Fixture capture is busy.'), { code: 'EACCES' });
    if (name !== 'intake-published' || !changeOutput || changed) return;
    const journal = path.join(intake.dir, 'transaction.json'), tx = await readJson(journal);
    const destination = intake.destination(tx.capture);
    const captureStage = path.join(intake.dir, tx.revision.id + '.stage');
    const snapshotStage = path.join(intake.dir, tx.revision.id + '.snapshot.stage');
    const foreign = 'Independent capture replacement during deferred intake.\n';
    const retained = new Map(await Promise.all([captureStage, snapshotStage, journal].map(async file => [file, await fs.readFile(file, 'utf8')])));
    const before = await fs.lstat(destination, { bigint: true });
    expect(before.nlink).toBe(2n);
    await fs.unlink(destination);
    await fs.writeFile(destination, foreign, { flag: 'wx' });
    changed = { tx, journal, destination, foreign, retained };
  });
  await writeDraft(producer);
  const original = await intake.connect(producer, true, now);
  expect(original.lastCheck.status).toBe('complete');
  const [sourceHash] = Object.keys(original.captures);
  await writeDraft(producer, 'second', '2');
  deferMove = true;
  const deferred = await intake.reconcile({ now: later });
  deferMove = false;
  expect(deferred.lastCheck.status).toBe('held');
  const pending = path.join(intake.dir, deferred.pending[sourceHash].journal);
  const pendingBytes = await fs.readFile(pending, 'utf8'), pendingIdentity = await fs.lstat(pending, { bigint: true });
  const pendingTx = JSON.parse(pendingBytes);
  const held = path.join(intake.dir, `conflict-${pendingTx.revision.id}.json`);
  changeOutput = true;
  let stopped = false;
  const rename = local.renameSync, link = local.linkSync;
  local.renameSync = (from, to) => {
    const transition = boundary !== 'held journal link' && to === ledgerFile && /^ledger-.*\.tmp$/.test(path.basename(from)) &&
      JSON.parse(local.readFileSync(from, 'utf8')).blocks[sourceHash]?.journal === path.basename(held);
    rename(from, to);
    if (transition) { stopped = true; throw interruption; }
  };
  local.linkSync = (from, to) => {
    link(from, to);
    if (boundary === 'held journal link' && from === path.join(intake.dir, 'transaction.json') && to === held) {
      stopped = true;
      throw interruption;
    }
  };
  try { await expect(intake.reconcile({ now: later })).rejects.toThrow(interruption.message); }
  finally { local.renameSync = rename; local.linkSync = link; }
  expect(stopped).toBe(true);
  expect(changed?.tx).toEqual(pendingTx);
  const paused = await readJson(ledgerFile);
  expect(paused.blocks[sourceHash]?.journal).toBe(path.basename(held));
  expect(paused.attempts).toEqual(original.attempts);

  const restarted = new Intake(new Vault(vault.vault, 'Companion'));
  if (boundary === 'edited journal') {
    const originalLedger = await fs.readFile(ledgerFile);
    const edited = structuredClone(pendingTx);
    edited.revision.locator += '-independently-edited';
    const bytes = JSON.stringify(edited);
    expect(() => restarted.validateTransaction(edited)).not.toThrow();
    expect(bytes).not.toBe(pendingBytes);
    await fs.writeFile(changed.journal, bytes);
    for (const file of [changed.journal, pending]) {
      const observed = await fs.lstat(file, { bigint: true });
      expect([observed.dev, observed.ino, observed.nlink]).toEqual([pendingIdentity.dev, pendingIdentity.ino, 2n]);
      expect(await readOptional(file)).toBe(bytes);
    }
    await expect.soft(restarted.reconcile({ now: '2026-11-10T06:59:00.000Z' })).rejects.toThrow(/changed|preserv|proof/i);
    expect.soft(await fs.readFile(ledgerFile)).toEqual(originalLedger);
    expect.soft(await readOptional(held)).toBeNull();
    expect.soft(await readOptional(changed.journal)).toBe(bytes);
    expect.soft(await readOptional(pending)).toBe(bytes);
    expect(await readOptional(changed.destination)).toBe(changed.foreign);
    for (const [file, originalBytes] of changed.retained) if (file !== changed.journal) expect(await readOptional(file)).toBe(originalBytes);
    return;
  }

  await writeDraft(producer, 'z-independent', '3', 'c');
  const recovered = await restarted.reconcile({ now: '2026-11-10T06:59:00.000Z' });
  expect(recovered.lastCheck.status).toBe('held');
  expect(recovered.attempts[pendingTx.revision.identity]).toBeUndefined();
  expect(Object.values(recovered.attempts)).toHaveLength(2);
  expect(await readOptional(changed.destination)).toBe(changed.foreign);
  for (const [file, bytes] of changed.retained) expect(await readOptional(file === changed.journal ? held : file)).toBe(bytes);
  const completed = await fs.lstat(held, { bigint: true });
  expect([completed.dev, completed.ino, completed.nlink]).toEqual([pendingIdentity.dev, pendingIdentity.ino, 1n]);
  expect(await readOptional(changed.journal)).toBeNull();
  expect(await readOptional(pending)).toBeNull();
});

test('accepted deferred intake restart settles its unchanged journal pair without replay', async ({}, testInfo) => {
  const producer = testInfo.outputPath('producer'), interruption = Error('Stopped after successful deferred admission.');
  let deferMove = false, stop = false;
  const { vault, intake, ledgerFile } = await setup(testInfo, async boundary => {
    if (boundary === 'intake-before-move' && deferMove) throw Object.assign(Error('Fixture capture is busy.'), { code: 'EACCES' });
    if (boundary === 'intake-ledger' && stop) throw interruption;
  });
  await writeDraft(producer);
  const first = await intake.connect(producer, true, now);
  expect(first.lastCheck.status).toBe('complete');
  const [sourceHash] = Object.keys(first.captures);
  await writeDraft(producer, 'second', '2');
  deferMove = true;
  const deferred = await intake.reconcile({ now: later });
  deferMove = false;
  expect(deferred.lastCheck.status).toBe('held');
  const pending = path.join(intake.dir, deferred.pending[sourceHash].journal), journal = path.join(intake.dir, 'transaction.json');
  const raw = await fs.readFile(pending, 'utf8'), tx = JSON.parse(raw);
  stop = true;
  await expect(intake.reconcile({ now: later })).rejects.toThrow(interruption.message);
  const committed = await readJson(ledgerFile);
  expect(committed.attempts[tx.revision.identity]).toMatchObject({ status: 'imported', revision: tx.revision.id });
  expect(committed.captures[sourceHash].currentRevision).toBe(tx.revision.id);
  const active = await fs.lstat(journal, { bigint: true }), deferredAlias = await fs.lstat(pending, { bigint: true });
  expect([active.dev, active.ino, active.nlink]).toEqual([deferredAlias.dev, deferredAlias.ino, 2n]);
  expect(await readOptional(journal)).toBe(raw);
  expect(await readOptional(pending)).toBe(raw);
  const destination = intake.destination(tx.capture), snapshot = path.join(vault.root, 'Revisions', tx.revision.id + '.json');
  const captureBefore = await fs.lstat(destination, { bigint: true }), snapshotBefore = await fs.lstat(snapshot, { bigint: true });
  await writeDraft(producer, 'z-independent', '3', 'c');
  const restarted = new Intake(new Vault(vault.vault, 'Companion'));
  const completed = await restarted.reconcile({ now: '2026-11-10T06:59:00.000Z' });
  expect(completed.lastCheck.status).toBe('complete');
  expect(completed.attempts[tx.revision.identity]).toEqual(committed.attempts[tx.revision.identity]);
  expect(Object.values(completed.attempts)).toHaveLength(3);
  expect(completed.captures[sourceHash].revisions).toEqual(committed.captures[sourceHash].revisions);
  expect(await readOptional(journal)).toBeNull();
  expect(await readOptional(pending)).toBeNull();
  expect(completed.pending[sourceHash]).toBeUndefined();
  expect(await readOptional(path.join(intake.dir, tx.revision.id + '.stage'))).toBeNull();
  expect(await readOptional(path.join(intake.dir, tx.revision.id + '.snapshot.stage'))).toBeNull();
  expect(await fs.readFile(destination, 'utf8')).toBe(tx.content);
  expect(await fs.readFile(snapshot, 'utf8')).toBe(JSON.stringify(tx.revision, null, 2));
  const captureAfter = await fs.lstat(destination, { bigint: true }), snapshotAfter = await fs.lstat(snapshot, { bigint: true });
  expect([captureAfter.dev, captureAfter.ino, captureAfter.nlink]).toEqual([captureBefore.dev, captureBefore.ino, 1n]);
  expect([snapshotAfter.dev, snapshotAfter.ino, snapshotAfter.nlink]).toEqual([snapshotBefore.dev, snapshotBefore.ino, 1n]);
});

for (const restartBeforeCleanup of [false, true]) test(`accepted deferred output change stays held ${restartBeforeCleanup ? 'on restart' : 'before and after restart'}`, async ({}, testInfo) => {
  const producer = testInfo.outputPath('producer'), interruption = Error('Stopped after deferred output replacement.');
  let deferMove = false, retry = false, replacement, committed;
  const { vault, intake, ledgerFile } = await setup(testInfo, async boundary => {
    if (boundary === 'intake-before-move' && deferMove) throw Object.assign(Error('Fixture capture is busy.'), { code: 'EACCES' });
    if (boundary !== 'intake-ledger' || !retry || replacement) return;
    committed = await readJson(ledgerFile);
    const original = await fs.lstat(destination, { bigint: true });
    expect(await fs.readFile(destination, 'utf8')).toBe(tx.content);
    await fs.unlink(destination);
    await fs.writeFile(destination, tx.content, { flag: 'wx' });
    replacement = await fs.lstat(destination, { bigint: true });
    expect([replacement.dev, replacement.ino]).not.toEqual([original.dev, original.ino]);
    if (restartBeforeCleanup) throw interruption;
  });
  await writeDraft(producer);
  const first = await intake.connect(producer, true, now);
  expect(first.lastCheck.status).toBe('complete');
  const [sourceHash] = Object.keys(first.captures);
  await writeDraft(producer, 'second', '2');
  deferMove = true;
  const deferred = await intake.reconcile({ now: later });
  deferMove = false;
  expect(deferred.lastCheck.status).toBe('held');
  const pending = path.join(intake.dir, deferred.pending[sourceHash].journal), journal = path.join(intake.dir, 'transaction.json');
  const raw = await fs.readFile(pending, 'utf8'), tx = JSON.parse(raw);
  const journalIdentity = await fs.lstat(pending, { bigint: true });
  const held = path.join(intake.dir, `conflict-${tx.revision.id}.json`), destination = intake.destination(tx.capture);
  const captureStage = path.join(intake.dir, tx.revision.id + '.stage');
  const snapshotStage = path.join(intake.dir, tx.revision.id + '.snapshot.stage');
  await writeDraft(producer, 'z-independent', '3', 'c');
  retry = true;
  const outcome = await intake.reconcile({ now: later }).catch(error => error);
  expect(replacement, 'the accepted capture was replaced at the real ledger checkpoint').toBeDefined();
  expect(committed.attempts[tx.revision.identity]).toMatchObject({ status: 'imported', revision: tx.revision.id });
  expect(committed.captures[sourceHash].currentRevision).toBe(tx.revision.id);

  async function expectHeld(result, attemptCount) {
    expect(result.lastCheck.status).toBe('held');
    expect(result.attempts[tx.revision.identity]).toEqual(committed.attempts[tx.revision.identity]);
    expect(result.captures[sourceHash]).toEqual({ ...committed.captures[sourceHash], conflict: result.blocks[sourceHash]?.reason });
    expect(Object.values(result.attempts)).toHaveLength(attemptCount);
    expect(result.blocks[sourceHash]?.journal).toBe(path.basename(held));
    expect(result.pending[sourceHash]).toBeUndefined();
    expect(await readOptional(journal)).toBeNull();
    expect(await readOptional(pending)).toBeNull();
    expect(await fs.readFile(held, 'utf8')).toBe(raw);
    const retained = await fs.lstat(held, { bigint: true });
    expect([retained.dev, retained.ino, retained.nlink]).toEqual([journalIdentity.dev, journalIdentity.ino, 1n]);
    expect(await fs.readFile(captureStage, 'utf8')).toBe(tx.content);
    expect(await fs.readFile(snapshotStage, 'utf8')).toBe(JSON.stringify(tx.revision, null, 2));
    expect(await fs.readFile(destination, 'utf8')).toBe(tx.content);
    const current = await fs.lstat(destination, { bigint: true });
    expect([current.dev, current.ino]).toEqual([replacement.dev, replacement.ino]);
  }

  if (restartBeforeCleanup) {
    expect(outcome).toBe(interruption);
    expect(await readOptional(journal)).toBe(raw);
    expect(await readOptional(pending)).toBe(raw);
  } else {
    expect.soft(outcome instanceof Error ? outcome.message : null).toBeNull();
    if (!(outcome instanceof Error)) await expectHeld(outcome, 3);
    await writeDraft(producer, 'zz-next-independent', '4', 'd');
  }
  const restarted = new Intake(new Vault(vault.vault, 'Companion'));
  await expectHeld(await restarted.reconcile({ now: '2026-11-10T06:59:00.000Z' }), restartBeforeCleanup ? 3 : 4);
});

test('held explicit conflict repair does not adopt a byte-identical replacement on restart', async ({}, testInfo) => {
  const producer = testInfo.outputPath('producer');
  let repairing = false, replacement;
  const { vault, intake, ledgerFile } = await setup(testInfo, async boundary => {
    if (boundary === 'repair-intent-published') repairing = true;
    if (boundary !== 'intake-published' || !repairing || replacement) return;
    const intentFile = path.join(intake.dir, 'repair-intent.json'), intent = await fs.readFile(intentFile, 'utf8');
    const { tx, annotationId, annotation } = JSON.parse(intent);
    const destination = intake.destination(tx.capture), stage = path.join(intake.dir, tx.revision.id + '.stage');
    const snapshotStage = path.join(intake.dir, tx.revision.id + '.snapshot.stage');
    const exact = await fs.readFile(stage), snapshot = await fs.readFile(snapshotStage);
    const original = await fs.lstat(stage, { bigint: true });
    expect(original.nlink).toBe(2n);
    expect(await fs.readFile(destination)).toEqual(exact);
    await fs.unlink(destination);
    await fs.writeFile(destination, exact, { flag: 'wx' });
    const foreign = await fs.lstat(destination, { bigint: true });
    expect([foreign.dev, foreign.ino]).not.toEqual([original.dev, original.ino]);
    replacement = { tx, intent, intentFile, annotationId, annotation, destination, stage, snapshotStage, exact, snapshot, foreign };
  });
  await writeDraft(producer);
  const original = await intake.connect(producer, true, now);
  const [sourceHash, capture] = Object.entries(original.captures)[0];
  const current = intake.destination(capture);
  await fs.appendFile(current, '\nIndependent local observation to preserve.\n');
  const localHash = hash(await fs.readFile(current));
  await writeDraft(producer, 'second', '2');
  expect((await intake.reconcile({ now: later })).lastCheck.status).toBe('held');
  await expect(intake.resolveConflict({ sourceHash, text: 'An explicitly selected annotation.', localHash }, later))
    .rejects.toThrow(/preserv|paused|changed/i);
  expect(replacement).toBeDefined();
  const held = await readJson(ledgerFile);
  expect(held.attempts).toEqual(original.attempts);
  expect(held.blocks[sourceHash]?.incomingRevision).toBe(replacement.tx.revision.id);
  await writeDraft(producer, 'z-independent', '3', 'c');
  const restarted = new Intake(new Vault(vault.vault, 'Companion'));
  const recovered = await restarted.reconcile({ now: '2026-11-10T06:59:00.000Z' });
  expect.soft(recovered.lastCheck.status).toBe('held');
  expect.soft(recovered.attempts[replacement.tx.revision.identity]).toBeUndefined();
  expect(Object.values(recovered.attempts)).toHaveLength(2);
  expect(recovered.blocks[sourceHash]).toEqual(held.blocks[sourceHash]);
  expect(await fs.readFile(replacement.destination)).toEqual(replacement.exact);
  const foreign = await fs.lstat(replacement.destination, { bigint: true });
  expect([foreign.dev, foreign.ino]).toEqual([replacement.foreign.dev, replacement.foreign.ino]);
  expect(await fs.readFile(replacement.stage)).toEqual(replacement.exact);
  expect(await fs.readFile(replacement.snapshotStage)).toEqual(replacement.snapshot);
  expect(await readOptional(replacement.intentFile)).toBeNull();
  expect(await readOptional(path.join(intake.dir, `repair-${replacement.annotationId}.json`))).toBe(replacement.intent);
  expect(await readOptional(path.join(vault.root, 'Annotations', `${replacement.annotationId}.md`))).toBe(replacement.annotation);
  expect(await fs.readdir(path.join(vault.root, 'Annotations'))).toHaveLength(1);
});

test('accepted restoration restart retains its stage if a published peer is replaced during acknowledgement', async ({}, testInfo) => {
  const producer = testInfo.outputPath('producer'), interruption = Error('Stopped after durable restoration admission.');
  let stop = false;
  const { vault, intake, ledgerFile } = await setup(testInfo, async boundary => {
    if (boundary === 'intake-ledger' && stop) throw interruption;
  });
  await writeDraft(producer);
  const accepted = await intake.connect(producer, true, now);
  const [sourceHash, capture] = Object.entries(accepted.captures)[0];
  const getVault = () => vault, clock = () => ({ now: later });
  const conversations = new Conversations({ dataRoot: testInfo.outputPath('history'), getVault, clock });
  await conversations.lock(async () => {});
  const deletion = new CaptureDeletion({ getVault, conversations, clock, clearApprovals() {} });
  const removal = await deletion.preview(capture.id);
  await deletion.confirm(removal.token);
  const restoration = await deletion.previewRestoration({ id: capture.id, kind: 'draft', folder: path.join(producer, 'first') });
  stop = true;
  await expect(deletion.confirmRestoration(restoration.token)).rejects.toThrow(interruption.message);
  const before = await readJson(ledgerFile), authority = before.sourceAuthority[capture.id], revision = authority.restoration.revision;
  expect(before.admissions[revision].sourceGeneration).toBe(authority.generation);
  expect(authority.restoration.published).toBeUndefined();
  const stage = path.join(intake.dir, revision + '.stage'), destination = intake.destination(before.captures[sourceHash]);
  const other = path.join(intake.dir, revision + '.snapshot.stage'), transaction = path.join(intake.dir, 'transaction.json');
  const exact = await fs.readFile(stage), revisionBytes = await fs.readFile(other), journalBytes = await fs.readFile(transaction);
  const owned = await fs.lstat(stage, { bigint: true });
  expect(owned.nlink).toBe(2n);
  const read = fs.readFile;
  let replacement;
  fs.readFile = async (file, ...args) => {
    const data = await read(file, ...args);
    if (file === stage && !replacement) {
      await fs.unlink(destination);
      await fs.writeFile(destination, exact, { flag: 'wx' });
      replacement = await fs.lstat(destination, { bigint: true });
    }
    return data;
  };
  let error;
  try { await new Intake(new Vault(vault.vault, 'Companion')).info(); }
  catch (caught) { error = caught; }
  finally { fs.readFile = read; }
  expect(replacement).toBeDefined();
  expect([replacement.dev, replacement.ino]).not.toEqual([owned.dev, owned.ino]);
  const after = await readJson(ledgerFile);
  expect.soft(error?.message).toMatch(/changed|preserv|remain/i);
  expect.soft(after.sourceAuthority[capture.id].phase).toBe('restoring');
  expect.soft(after.sourceAuthority[capture.id].restoration?.published).toBeUndefined();
  expect.soft(after.suppressed).toContain(sourceHash);
  expect(after.admissions).toEqual(before.admissions);
  expect(after.attempts).toEqual(before.attempts);
  expect(await fs.readFile(destination)).toEqual(exact);
  const foreign = await fs.lstat(destination, { bigint: true });
  expect([foreign.dev, foreign.ino]).toEqual([replacement.dev, replacement.ino]);
  expect.soft(await readOptional(stage)).toBe(exact.toString('utf8'));
  expect.soft(await readOptional(other)).toBe(revisionBytes.toString('utf8'));
  expect.soft(await readOptional(transaction)).toBe(journalBytes.toString('utf8'));
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

for (const changedStage of [false, true]) test(`Windows intake ledger sharing refusal ${changedStage ? 'holds an edited stage' : 'publishes the exact original stage after release'}`, async ({}, testInfo) => {
  test.skip(process.platform !== 'win32', 'Requires a native Windows FileShare.Read refusal.');
  const { intake, ledgerFile } = await setup(testInfo);
  const producer = testInfo.outputPath('producer');
  await writeDraft(producer);
  await intake.connect(producer, false, now);
  const ledger = await intake.load(), baseline = await fs.readFile(ledgerFile, 'utf8');
  ledger.lastCheck = { at: later, trigger: 'manual', status: 'complete' };
  const exact = JSON.stringify(ledger, null, 2), independent = exact + '\n';
  const script = [
    '$ErrorActionPreference = "Stop"',
    '$stream = [IO.File]::Open($env:COMPANION_LEDGER_FIXTURE, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read)',
    'try { [Console]::WriteLine("READY:" + $PID); [void][Console]::ReadLine() } finally { $stream.Dispose(); [Console]::WriteLine("RELEASED:" + $PID) }'
  ].join('; ');
  const child = spawn('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script], {
    windowsHide: true, env: { ...process.env, COMPANION_LEDGER_FIXTURE: ledgerFile }, stdio: ['pipe', 'pipe', 'pipe']
  });
  const proof = { pid: child.pid, access: 'FileAccess.Read', share: 'FileShare.Read', stdout: '', stderr: '', attempts: [] };
  child.stdout.on('data', chunk => { proof.stdout += chunk.toString(); });
  child.stderr.on('data', chunk => { proof.stderr += chunk.toString(); });
  child.stdin.on('error', error => { proof.inputError = error.message; });
  child.on('error', error => { proof.error = error.message; });
  const closed = new Promise(resolve => child.once('close', (code, signal) => {
    proof.exit = { code, signal };
    resolve();
  }));
  const rename = local.renameSync, sharing = ['EPERM', 'EBUSY', 'EACCES'];
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    child.stdin.end('\n');
  };
  let outcome;
  try {
    await expect.poll(() => {
      if (proof.error || proof.exit) throw Error(JSON.stringify(proof));
      return proof.stdout;
    }).toContain(`READY:${child.pid}`);
    local.renameSync = (source, destination) => {
      if (destination !== ledgerFile || path.dirname(source) !== intake.dir || !/^ledger-.*\.tmp$/.test(path.basename(source))) {
        return rename(source, destination);
      }
      const stat = local.lstatSync(source, { bigint: true });
      const attempt = { source, dev: String(stat.dev), ino: String(stat.ino), sha256: hash(local.readFileSync(source)) };
      proof.attempts.push(attempt);
      try { rename(source, destination); attempt.code = null; }
      catch (error) {
        attempt.code = error.code;
        attempt.syscall = error.syscall;
        if (proof.attempts.length === 1 && sharing.includes(error.code)) {
          if (changedStage) local.writeFileSync(source, independent);
          release();
        }
        throw error;
      }
    };
    outcome = await intake.save(ledger).then(() => null, error => ({ code: error.code, message: error.message }));
  } finally {
    local.renameSync = rename;
    release();
    await closed;
  }

  await fs.writeFile(testInfo.outputPath('native-ledger-publication.json'), JSON.stringify({ ...proof, outcome }, null, 2));
  expect(proof.exit).toEqual({ code: 0, signal: null });
  expect(proof.stdout).toContain(`RELEASED:${child.pid}`);
  const [first] = proof.attempts;
  expect(first?.syscall).toBe('rename');
  expect(sharing).toContain(first.code);
  expect(first.sha256).toBe(hash(exact));
  if (changedStage) {
    expect(proof.attempts).toHaveLength(1);
    expect(await readOptional(ledgerFile)).toBe(baseline);
    expect(await readOptional(first.source)).toBe(independent);
    expect(outcome?.message).toMatch(/ledger.*changed/i);
  } else {
    expect(outcome).toBeNull();
    expect(proof.attempts.length).toBeGreaterThan(1);
    expect(proof.attempts.every(attempt => ['source', 'dev', 'ino', 'sha256'].every(key => attempt[key] === first[key]))).toBe(true);
    expect(proof.attempts.at(-1).code).toBeNull();
    expect(await readOptional(ledgerFile)).toBe(exact);
    const current = await fs.lstat(ledgerFile, { bigint: true });
    expect({ dev: String(current.dev), ino: String(current.ino) }).toEqual({ dev: first.dev, ino: first.ino });
    expect(await readOptional(first.source)).toBeNull();
  }
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
