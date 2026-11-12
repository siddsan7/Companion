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

test('a fresh intake conflict never retires an equal-byte replacement of its original journal', async ({}, testInfo) => {
  const producer = testInfo.outputPath('producer'), retained = testInfo.outputPath('original-transaction.json');
  let armed = false, original, journal;
  const { intake, ledgerFile } = await setup(testInfo, async boundary => {
    if (!armed || boundary !== 'intake-journaled') return;
    journal = path.join(intake.dir, 'transaction.json');
    original = await fs.readFile(journal);
    await fs.rename(journal, retained);
    await fs.writeFile(journal, original, { flag: 'wx' });
  });
  await writeDraft(producer);
  const baseline = await intake.connect(producer, true, now);
  const capture = Object.values(baseline.captures)[0], captureFile = intake.destination(capture);
  await fs.appendFile(captureFile, '\nIndependent local edit.\n');
  const localWriting = await fs.readFile(captureFile);
  await writeDraft(producer, 'second', '2');
  armed = true;
  await expect(intake.reconcile({ now: later })).rejects.toThrow(/intake journal.*changed/i);
  expect(await fs.readFile(journal)).toEqual(original);
  expect(await fs.readFile(retained)).toEqual(original);
  expect((await fs.readdir(intake.dir)).filter(name => name.startsWith('conflict-'))).toEqual([]);
  expect(await fs.readFile(captureFile)).toEqual(localWriting);
  expect((await readJson(ledgerFile)).attempts).toEqual(baseline.attempts);
});

for (const kind of ['snapshot', 'capture']) for (const equal of [false, true]) {
  test(`fresh intake preserves an unowned ${kind} stage with ${equal ? 'equal' : 'different'} bytes`, async ({}, testInfo) => {
    const producer = testInfo.outputPath('producer');
    let stage, destination, bytes, original;
    const { vault, intake } = await setup(testInfo, async boundary => {
      if (boundary !== 'intake-journaled') return;
      const tx = await readJson(path.join(intake.dir, 'transaction.json'));
      stage = path.join(intake.dir, tx.revision.id + (kind === 'snapshot' ? '.snapshot.stage' : '.stage'));
      destination = kind === 'snapshot' ? path.join(vault.root, 'Revisions', tx.revision.id + '.json') : intake.destination(tx.capture);
      bytes = equal ? kind === 'snapshot' ? JSON.stringify(tx.revision, null, 2) : tx.content : 'Independent writing at a reserved stage.\n';
      await fs.writeFile(stage, bytes, { flag: 'wx' });
      original = await fs.lstat(stage, { bigint: true });
    });
    await writeDraft(producer);
    const result = await intake.connect(producer, true, now);
    expect(original, 'the independent file occupied the stage after the journal was published').toBeDefined();
    expect(await readOptional(stage)).toBe(bytes);
    expect(await readOptional(destination)).toBeNull();
    expect(result.lastCheck.status).toBe('held');
    expect(Object.values(result.attempts)).toHaveLength(0);
    const retained = await fs.lstat(stage, { bigint: true });
    expect([retained.dev, retained.ino, retained.nlink]).toEqual([original.dev, original.ino, 1n]);
  });
}

test('fresh intake refuses an equal-byte snapshot stage replacement after the exclusive write closes', async ({}, testInfo) => {
  const producer = testInfo.outputPath('producer'), displaced = testInfo.outputPath('created-snapshot.json');
  let stage, destination, replacement;
  const { vault, intake } = await setup(testInfo, async boundary => {
    if (boundary !== 'intake-journaled') return;
    const tx = await readJson(path.join(intake.dir, 'transaction.json'));
    stage = path.join(intake.dir, tx.revision.id + '.snapshot.stage');
    destination = path.join(vault.root, 'Revisions', tx.revision.id + '.json');
  });
  await writeDraft(producer);
  const { open, writeFile } = fs;
  async function replace() {
    const bytes = await fs.readFile(stage);
    await fs.rename(stage, displaced);
    await writeFile(stage, bytes, { flag: 'wx' });
    replacement = await fs.lstat(stage, { bigint: true });
  }
  fs.open = async (file, flag, ...args) => {
    const handle = await open(file, flag, ...args);
    if (file === stage && flag === 'wx') {
      const close = handle.close.bind(handle);
      handle.close = async () => { await close(); await replace(); };
    }
    return handle;
  };
  fs.writeFile = async (file, content, options) => {
    await writeFile(file, content, options);
    if (file === stage && options?.flag === 'wx') await replace();
  };
  let result;
  try { result = await intake.connect(producer, true, now); }
  finally { fs.open = open; fs.writeFile = writeFile; }

  expect(replacement, 'the exact creation boundary was reached').toBeDefined();
  expect(await readOptional(destination)).toBeNull();
  expect(await fs.readFile(stage)).toEqual(await fs.readFile(displaced));
  const retained = await fs.lstat(stage, { bigint: true });
  expect([retained.dev, retained.ino, retained.nlink]).toEqual([replacement.dev, replacement.ino, 1n]);
  expect(result.lastCheck.status).toBe('held');
  expect(Object.values(result.attempts)).toHaveLength(0);
});

for (const kind of ['snapshot', 'capture']) test(`fresh intake holds an equal-byte ${kind} at its final path without the writer's stage identity`, async ({}, testInfo) => {
  const producer = testInfo.outputPath('producer');
  let stage, destination, foreign, bytes;
  const { vault, intake } = await setup(testInfo, async boundary => {
    if (boundary !== `intake-${kind}-staged`) return;
    const tx = await readJson(path.join(intake.dir, 'transaction.json'));
    stage = path.join(intake.dir, tx.revision.id + (kind === 'snapshot' ? '.snapshot.stage' : '.stage'));
    destination = kind === 'snapshot' ? path.join(vault.root, 'Revisions', tx.revision.id + '.json') : intake.destination(tx.capture);
    bytes = await fs.readFile(stage);
    await fs.writeFile(destination, bytes, { flag: 'wx' });
    foreign = await fs.lstat(destination, { bigint: true });
  });
  await writeDraft(producer);
  const result = await intake.connect(producer, true, now);

  expect(foreign, 'the independent file occupied the final path before linking').toBeDefined();
  expect(result.lastCheck.status).toBe('held');
  expect(Object.values(result.attempts)).toHaveLength(0);
  expect(await fs.readFile(stage)).toEqual(bytes);
  expect(await fs.readFile(destination)).toEqual(bytes);
  const retained = await fs.lstat(destination, { bigint: true });
  expect([retained.dev, retained.ino, retained.nlink]).toEqual([foreign.dev, foreign.ino, 1n]);
});

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

async function exitDuringOrdinaryIntake(vault, producer, boundary, selection) {
  const script = `
    const path = require('node:path');
    const [app, directory, producer, now, boundary, selection] = process.argv.slice(1);
    const { Vault } = require(path.join(app, 'vault'));
    const { Intake } = require(path.join(app, 'intake'));
    const vault = new Vault(directory, 'Companion', { checkpoint: name => {
      if (name === boundary) process.exit(77);
    } });
    if (boundary === 'journal-linked' || boundary === 'pending-linked') {
      const local = require('node:fs'), link = local.linkSync;
      const journal = path.join(vault.root, '.intake', 'transaction.json');
      local.linkSync = function (from, to) {
        const result = link.call(this, from, to);
        if (to === journal && (boundary === 'journal-linked' || path.basename(from).startsWith('pending-'))) process.exit(77);
        return result;
      };
    }
    if (boundary === 'snapshot-stage-flushed' || boundary === 'capture-stage-flushed') {
      const fs = require('node:fs/promises'), open = fs.open;
      fs.open = async function (file, flags, ...args) {
        const handle = await open.call(this, file, flags, ...args);
        const name = path.basename(file);
        const selected = boundary === 'snapshot-stage-flushed'
          ? /^[a-f0-9-]{36}[.]snapshot[.]stage$/.test(name) : /^[a-f0-9-]{36}[.]stage$/.test(name);
        if (flags === 'wx' && selected) {
          const sync = handle.sync.bind(handle);
          handle.sync = async () => {
            await sync();
            await handle.close();
            process.exit(77);
          };
        }
        return handle;
      };
    }
    const intake = new Intake(vault);
    const work = boundary === 'pending-linked' ? intake.reconcile({ now })
      : selection ? intake.selectCurrent(...JSON.parse(selection))
      : intake.connect(producer, true, now);
    work.catch(error => {
      console.error(error);
      process.exitCode = 1;
    });`;
  const child = spawn(process.execPath, ['-e', script, path.resolve(__dirname, '../app'), vault.vault, producer, now, boundary,
    ...(selection ? [JSON.stringify(selection)] : [])], {
    stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true
  });
  let stderr = '';
  child.stderr.on('data', chunk => { stderr += chunk.toString(); });
  const exit = await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code, signal) => resolve({ code, signal }));
  });
  expect(exit, stderr).toEqual({ code: 77, signal: null });
}

for (const role of ['snapshot', 'capture']) test(`first intake resumes after moving aside an unproved ${role} stage flushed before process exit`, async ({}, testInfo) => {
  const producer = testInfo.outputPath('producer'), originalStage = testInfo.outputPath('preserved.stage');
  const { vault, intake, ledgerFile } = await setup(testInfo);
  await writeDraft(producer);
  await exitDuringOrdinaryIntake(vault, producer, role + '-stage-flushed');
  const active = path.join(intake.dir, 'transaction.json'), journalBytes = await fs.readFile(active);
  const tx = JSON.parse(journalBytes);
  const stage = path.join(intake.dir, tx.revision.id + (role === 'snapshot' ? '.snapshot.stage' : '.stage'));
  const destination = intake.destination(tx.capture), before = await readJson(ledgerFile);
  const bytes = await fs.readFile(stage), identity = await fs.lstat(stage, { bigint: true });
  expect(before.intakeStageRecords?.[hash(journalBytes)]?.[role + 'Stage']).toBeUndefined();
  expect(bytes.toString('utf8')).toBe(role === 'snapshot' ? JSON.stringify(tx.revision, null, 2) : tx.content);
  expect(await readOptional(destination)).toBeNull();
  await writeDraft(producer, 'z-independent', '3', 'c');

  const restarted = new Intake(new Vault(vault.vault, 'Companion'));
  const held = await restarted.reconcile({ now: later });
  expect(held.lastCheck.status).toBe('held');
  expect(held.attempts[tx.revision.identity]).toBeUndefined();
  expect(held.captures[tx.sourceHash]).toBeUndefined();
  expect(Object.values(held.captures)).toHaveLength(1);
  expect(held.pending[tx.sourceHash]?.reason).toMatch(/move.*aside.*Check now/i);
  const journal = path.join(intake.dir, held.pending[tx.sourceHash].journal);
  expect(await fs.readFile(journal)).toEqual(journalBytes);
  expect(await readOptional(active)).toBeNull();
  expect(await fs.readFile(stage)).toEqual(bytes);
  expect((await fs.lstat(stage, { bigint: true })).ino).toBe(identity.ino);

  await fs.rename(stage, originalStage);
  const completed = await restarted.reconcile({ now: '2026-11-10T06:59:00.000Z' });
  expect(completed.lastCheck.status).toBe('complete');
  expect(completed.attempts[tx.revision.identity]?.revision).toBe(tx.revision.id);
  expect(completed.captures[tx.sourceHash].currentRevision).toBe(tx.revision.id);
  expect(completed.pending[tx.sourceHash]).toBeUndefined();
  expect(await readOptional(journal)).toBeNull();
  expect(await readOptional(stage)).toBeNull();
  expect(await fs.readFile(destination, 'utf8')).toBe(tx.content);
  expect(await fs.readFile(originalStage)).toEqual(bytes);
  expect((await fs.lstat(originalStage, { bigint: true })).ino).toBe(identity.ino);
});

test('an equal-byte replacement of one deferred intake journal preserves the hold and allows independent Check now intake', async ({}, testInfo) => {
  const producer = testInfo.outputPath('producer'), originalJournal = testInfo.outputPath('preserved-pending.json');
  let busy = false;
  const { vault, intake } = await setup(testInfo, boundary => {
    if (busy && boundary === 'intake-before-move') throw Object.assign(Error('Fixture capture is busy.'), { code: 'EACCES' });
  });
  await writeDraft(producer);
  const original = await intake.connect(producer, true, now), [sourceHash] = Object.keys(original.captures);
  const destination = intake.destination(original.captures[sourceHash]), previous = await fs.readFile(destination);
  await writeDraft(producer, 'second', '2');
  busy = true;
  const deferred = await intake.reconcile({ now: later });
  busy = false;
  expect(deferred.lastCheck.status).toBe('held');
  const pending = deferred.pending[sourceHash], file = path.join(intake.dir, pending.journal);
  const bytes = await fs.readFile(file), tx = JSON.parse(bytes), old = await fs.lstat(file, { bigint: true });
  await fs.rename(file, originalJournal);
  await fs.writeFile(file, bytes, { flag: 'wx' });
  const replacement = await fs.lstat(file, { bigint: true });
  expect(replacement.ino).not.toBe(old.ino);
  await writeDraft(producer, 'z-independent', '3', 'c');

  const restarted = new Intake(new Vault(vault.vault, 'Companion'));
  const checked = await restarted.reconcile({ now: '2026-11-10T06:59:00.000Z' });
  expect(checked.lastCheck.status).toBe('held');
  expect(checked.pending[sourceHash]).toMatchObject({ journal: pending.journal, key: pending.key });
  expect(checked.pending[sourceHash].reason).toMatch(/journal.*restore.*Check now/i);
  expect(checked.outcomes[pending.key]).toMatchObject({ status: 'held', reason: checked.pending[sourceHash].reason });
  expect(checked.captures[sourceHash]).toEqual(deferred.captures[sourceHash]);
  expect(checked.attempts[Object.keys(original.attempts)[0]]).toEqual(Object.values(original.attempts)[0]);
  expect(checked.attempts[tx.revision.identity]).toBeUndefined();
  expect(Object.values(checked.attempts)).toHaveLength(2);
  expect(Object.values(checked.captures)).toHaveLength(2);
  expect(await fs.readFile(destination)).toEqual(previous);
  expect(await readOptional(path.join(intake.dir, 'transaction.json'))).toBeNull();
  expect(await fs.readFile(file)).toEqual(bytes);
  expect(await fs.readFile(originalJournal)).toEqual(bytes);
  expect((await fs.lstat(file, { bigint: true })).ino).toBe(replacement.ino);
  expect((await fs.lstat(originalJournal, { bigint: true })).ino).toBe(old.ino);

  const movedReplacement = testInfo.outputPath('replacement-pending.json');
  await fs.rename(file, movedReplacement);
  await fs.rename(originalJournal, file);
  const completed = await restarted.reconcile({ now: '2026-11-11T06:59:00.000Z' });
  expect(completed.lastCheck.status).toBe('complete');
  expect(completed.attempts[tx.revision.identity]?.revision).toBe(tx.revision.id);
  expect(completed.pending[sourceHash]).toBeUndefined();
  expect(await readOptional(file)).toBeNull();
  expect(await fs.readFile(movedReplacement)).toEqual(bytes);
  expect((await fs.lstat(movedReplacement, { bigint: true })).ino).toBe(replacement.ino);
});

test('reviewed selection resumes after moving aside an unproved stage for the exact admitted snapshot', async ({}, testInfo) => {
  const producer = testInfo.outputPath('producer'), aside = testInfo.outputPath('preserved.stage');
  const { vault, intake, ledgerFile } = await setup(testInfo);
  await fs.cp(path.join(__dirname, 'fixtures/reel-review/accept'), path.join(producer, 'accept'), { recursive: true });
  await intake.connect(producer, true, now, 'review');
  await fs.cp(path.join(__dirname, 'fixtures/reel-review/edit'), path.join(producer, 'edit'), { recursive: true });
  const ready = await intake.reconcile({ now: later }), [sourceHash, capture] = Object.entries(ready.captures)[0];
  const revision = capture.reviewChoices.find(id => id !== capture.currentRevision);
  const snapshot = path.join(vault.root, 'Revisions', revision + '.json');
  const original = await fs.readFile(snapshot), identity = await fs.lstat(snapshot, { bigint: true });
  await exitDuringOrdinaryIntake(vault, producer, 'snapshot-stage-flushed', [capture.id, revision, later]);
  const journal = path.join(intake.dir, 'transaction.json'), journalBytes = await fs.readFile(journal);
  const stage = path.join(intake.dir, revision + '.snapshot.stage'), staged = await fs.lstat(stage, { bigint: true });
  expect(await fs.readFile(stage)).toEqual(original);
  expect(staged.ino).not.toBe(identity.ino);
  expect((await readJson(ledgerFile)).intakeStageRecords?.[hash(journalBytes)]?.snapshotStage).toBeUndefined();

  const restarted = new Intake(new Vault(vault.vault, 'Companion'));
  const held = await restarted.reconcile({ now: '2026-11-10T06:59:00.000Z' });
  expect(held.pending[sourceHash]?.reason).toMatch(/move.*aside.*Check now/i);
  expect(held.captures[sourceHash]).toEqual(capture);
  expect(held.attempts).toEqual(ready.attempts);
  expect(await fs.readFile(stage)).toEqual(original);
  expect((await fs.lstat(stage, { bigint: true })).ino).toBe(staged.ino);
  await fs.rename(stage, aside);

  const completed = await restarted.reconcile({ now: '2026-11-11T06:59:00.000Z' });
  expect(completed.lastCheck.status).toBe('complete');
  expect(completed.captures[sourceHash].currentRevision).toBe(revision);
  expect(completed.attempts).toEqual(ready.attempts);
  expect(completed.pending[sourceHash]).toBeUndefined();
  expect(await fs.readFile(snapshot)).toEqual(original);
  expect((await fs.lstat(snapshot, { bigint: true })).ino).toBe(identity.ino);
  expect(await fs.readFile(aside)).toEqual(original);
  expect((await fs.lstat(aside, { bigint: true })).ino).toBe(staged.ino);
});

test('startup preserves an edited deferred journal pair after the retry links its active alias and exits', async ({}, testInfo) => {
  const producer = testInfo.outputPath('producer');
  let busy = false;
  const { vault, intake, ledgerFile } = await setup(testInfo, boundary => {
    if (busy && boundary === 'intake-before-move') throw Object.assign(Error('Fixture capture is busy.'), { code: 'EACCES' });
  });
  await writeDraft(producer);
  const original = await intake.connect(producer, true, now), [sourceHash] = Object.keys(original.captures);
  await writeDraft(producer, 'second', '2');
  busy = true;
  const deferred = await intake.reconcile({ now: later });
  const active = path.join(intake.dir, 'transaction.json'), pending = path.join(intake.dir, deferred.pending[sourceHash].journal);
  const before = await fs.readFile(pending), identity = await fs.lstat(pending, { bigint: true });
  await exitDuringOrdinaryIntake(vault, producer, 'pending-linked');
  expect(await fs.readFile(active)).toEqual(before);
  const tx = JSON.parse(before);
  tx.revision.locator += '-edited';
  const edited = JSON.stringify(tx), ledger = await fs.readFile(ledgerFile), destination = intake.destination(original.captures[sourceHash]);
  const priorCapture = await fs.readFile(destination);
  await fs.writeFile(active, edited);

  const restarted = new Intake(new Vault(vault.vault, 'Companion'));
  await expect(restarted.reconcile({ now: later })).rejects.toThrow(/journal.*changed|journal.*proof/i);
  expect(await fs.readFile(ledgerFile)).toEqual(ledger);
  for (const file of [active, pending]) {
    const retained = await fs.lstat(file, { bigint: true });
    expect([retained.dev, retained.ino, retained.nlink]).toEqual([identity.dev, identity.ino, 2n]);
    expect(await fs.readFile(file, 'utf8')).toBe(edited);
  }
  expect(await fs.readFile(destination)).toEqual(priorCapture);
});

for (const role of ['snapshot', 'capture', 'no foreign stage']) {
  test(`ordinary intake restart after journaling with ${role === 'no foreign stage' ? role : 'an equal-byte foreign ' + role + ' stage'}`, async ({}, testInfo) => {
    const producer = testInfo.outputPath('producer');
    const { vault, intake } = await setup(testInfo);
    await writeDraft(producer);
    await exitDuringOrdinaryIntake(vault, producer, 'intake-journaled');
    const tx = await readJson(path.join(intake.dir, 'transaction.json'));
    const stage = path.join(intake.dir, tx.revision.id + (role === 'snapshot' ? '.snapshot.stage' : '.stage'));
    const destination = role === 'snapshot' ? path.join(vault.root, 'Revisions', tx.revision.id + '.json') : intake.destination(tx.capture);
    const bytes = role === 'snapshot' ? JSON.stringify(tx.revision, null, 2) : tx.content;
    if (role !== 'no foreign stage') await fs.writeFile(stage, bytes, { flag: 'wx' });
    const foreign = role === 'no foreign stage' ? null : await fs.lstat(stage, { bigint: true });

    const restarted = new Intake(new Vault(vault.vault, 'Companion'));
    const result = await restarted.reconcile({ now: later });
    if (foreign) {
      expect.soft(result.attempts[tx.revision.identity]).toBeUndefined();
      expect.soft(result.pending[tx.sourceHash]?.journal).toBe(`pending-${tx.revision.id}.json`);
      expect.soft(result.pending[tx.sourceHash]?.reason).toMatch(/move.*aside.*Check now/i);
      expect.soft(await readOptional(destination)).toBeNull();
      expect.soft(await readOptional(stage)).toBe(bytes);
      const retained = await fs.lstat(stage, { bigint: true });
      expect([retained.dev, retained.ino, retained.nlink]).toEqual([foreign.dev, foreign.ino, 1n]);
    } else {
      expect(result.attempts[tx.revision.identity]?.status).toBe('imported');
      expect(await fs.readFile(destination, 'utf8')).toBe(bytes);
      expect(await readOptional(stage)).toBeNull();
    }
  });
}

test('deferred ordinary retry preserves an equal-byte foreign capture stage', async ({}, testInfo) => {
  const producer = testInfo.outputPath('producer');
  const { vault, intake } = await setup(testInfo, boundary => {
    if (boundary === 'intake-before-move') throw Object.assign(Error('Fixture capture is busy.'), { code: 'EACCES' });
  });
  await writeDraft(producer);
  const baseline = await intake.connect(producer, true, now);
  const [sourceHash] = Object.keys(baseline.captures), capture = baseline.captures[sourceHash];
  const file = intake.destination(capture), original = await fs.readFile(file);
  await writeDraft(producer, 'second', '2');
  const deferred = await intake.reconcile({ now: later });
  const tx = await readJson(path.join(intake.dir, deferred.pending[sourceHash].journal));
  const stage = path.join(intake.dir, tx.revision.id + '.stage');
  await fs.writeFile(stage, tx.content, { flag: 'wx' });
  const foreign = await fs.lstat(stage, { bigint: true });

  const result = await new Intake(new Vault(vault.vault, 'Companion')).reconcile({ now: later });
  expect.soft(result.attempts[tx.revision.identity]).toBeUndefined();
  expect.soft(result.blocks[sourceHash]?.incomingRevision).toBe(tx.revision.id);
  expect.soft(await fs.readFile(file)).toEqual(original);
  expect.soft(await readOptional(stage)).toBe(tx.content);
  const retained = await fs.lstat(stage, { bigint: true });
  expect([retained.dev, retained.ino, retained.nlink]).toEqual([foreign.dev, foreign.ino, 1n]);
});

test('source deletion cannot claim an equal-byte foreign stage in a current Intake hold', async ({}, testInfo) => {
  const producer = testInfo.outputPath('producer');
  let stage, bytes;
  const { vault, intake } = await setup(testInfo, async boundary => {
    if (boundary !== 'intake-journaled' || stage) return;
    const tx = await readJson(path.join(intake.dir, 'transaction.json'));
    if (tx.previous === null) return;
    stage = path.join(intake.dir, tx.revision.id + '.snapshot.stage');
    bytes = JSON.stringify(tx.revision, null, 2);
    await fs.writeFile(stage, bytes, { flag: 'wx' });
  });
  await writeDraft(producer);
  const baseline = await intake.connect(producer, true, now);
  const capture = Object.values(baseline.captures)[0];
  await writeDraft(producer, 'second', '2');
  expect((await intake.reconcile({ now: later })).lastCheck.status).toBe('held');
  const foreign = await fs.lstat(stage, { bigint: true });

  const restartedVault = new Vault(vault.vault, 'Companion');
  const getVault = () => restartedVault, clock = () => ({ now: later });
  const conversations = new Conversations({ dataRoot: testInfo.outputPath('history'), getVault, clock });
  await conversations.lock(async () => {});
  const removal = new CaptureDeletion({ getVault, conversations, clock, clearApprovals() {} });
  await expect(removal.preview(capture.id)).rejects.toThrow(/source recovery inventory/i);
  expect(await readOptional(stage)).toBe(bytes);
  const retained = await fs.lstat(stage, { bigint: true });
  expect([retained.dev, retained.ino, retained.nlink]).toEqual([foreign.dev, foreign.ino, 1n]);
});

test('ordinary intake cannot recreate a moved capture from an equal-byte foreign backup', async ({}, testInfo) => {
  const producer = testInfo.outputPath('producer'), moved = testInfo.outputPath('moved.md');
  let backup, file, original;
  const { intake } = await setup(testInfo, async boundary => {
    if (boundary !== 'intake-snapshot' || backup) return;
    const tx = await readJson(path.join(intake.dir, 'transaction.json'));
    if (tx.previous === null) return;
    file = intake.destination(tx.capture);
    backup = path.join(intake.dir, tx.backup);
    original = await fs.readFile(file, 'utf8');
    await fs.rename(file, moved);
    await fs.writeFile(backup, original, { flag: 'wx' });
  });
  await writeDraft(producer);
  const baseline = await intake.connect(producer, true, now);
  await writeDraft(producer, 'second', '2');
  const result = await intake.reconcile({ now: later });

  expect(result.lastCheck.status).toBe('held');
  expect(result.attempts).toEqual(baseline.attempts);
  expect(await readOptional(file)).toBeNull();
  expect(await readOptional(backup)).toBe(original);
  expect(await readOptional(moved)).toBe(original);
});

test('ordinary intake restart uses the exact prior capture after its checked move', async ({}, testInfo) => {
  const producer = testInfo.outputPath('producer');
  const { vault, intake } = await setup(testInfo);
  await writeDraft(producer);
  await intake.connect(producer, true, now);
  await writeDraft(producer, 'second', '2');
  await exitDuringOrdinaryIntake(vault, producer, 'intake-moved');
  const tx = await readJson(path.join(intake.dir, 'transaction.json'));
  const backup = path.join(intake.dir, tx.backup), destination = intake.destination(tx.capture);
  const original = await fs.lstat(backup, { bigint: true });
  expect(await readOptional(destination)).toBeNull();
  expect(await readOptional(backup)).toBe(tx.previous);

  const result = await new Intake(new Vault(vault.vault, 'Companion')).reconcile({ now: later });
  expect(result.attempts[tx.revision.identity]?.status).toBe('imported');
  expect(await readOptional(destination)).toBe(tx.content);
  const retained = await fs.lstat(backup, { bigint: true });
  expect([retained.dev, retained.ino, retained.nlink]).toEqual([original.dev, original.ino, 1n]);
});

for (const detached of ['verified copy', 'equal-byte foreign stage', 'edited intent on restart', 'foreign linked pair']) {
  test(`source deletion after an ordinary rollback handles a detached backup with ${detached}`, async ({}, testInfo) => {
    const producer = testInfo.outputPath('producer');
    let tx;
    const { vault, intake } = await setup(testInfo, async boundary => {
      if (boundary !== 'intake-capture-staged') return;
      const observed = await readJson(path.join(intake.dir, 'transaction.json'));
      if (observed.previous === null) return;
      tx = observed;
      await fs.unlink(path.join(intake.dir, tx.revision.id + '.stage'));
    });
    await writeDraft(producer);
    const baseline = await intake.connect(producer, true, now);
    const capture = Object.values(baseline.captures)[0], file = intake.destination(capture);
    await writeDraft(producer, 'second', '2');
    expect((await intake.reconcile({ now: later })).lastCheck.status).toBe('held');
    const backup = path.join(intake.dir, tx.backup), stage = backup + '.independent';
    const original = await fs.lstat(file, { bigint: true });
    expect((await fs.lstat(backup, { bigint: true })).ino).toBe(original.ino);
    expect(original.nlink).toBe(2n);
    const restartedVault = new Vault(vault.vault, 'Companion');
    const restarted = new Intake(restartedVault);
    if (detached === 'edited intent on restart') {
      await exitDuringOrdinaryIntake(vault, producer, 'intake-restored-backup-cleaned');
      const intentFile = backup + '.detach.json', intent = await readJson(intentFile), displaced = testInfo.outputPath('detached-backup.md');
      const intentIdentity = await fs.lstat(intentFile, { bigint: true });
      await fs.rename(backup, displaced);
      await fs.writeFile(backup, tx.previous, { flag: 'wx' });
      const foreign = await fs.lstat(backup, { bigint: true });
      const edited = JSON.stringify({ ...intent, stageDev: String(foreign.dev), stageIno: String(foreign.ino) });
      await fs.writeFile(intentFile, edited);
      expect((await fs.lstat(intentFile, { bigint: true })).ino).toBe(intentIdentity.ino);
      await expect(restarted.info()).rejects.toThrow(/changed|preserved/i);
      expect(await readOptional(intentFile)).toBe(edited);
      expect(await readOptional(displaced)).toBe(tx.previous);
      expect(await readOptional(backup)).toBe(tx.previous);
      expect((await fs.lstat(backup, { bigint: true })).ino).toBe(foreign.ino);
    } else if (detached === 'foreign linked pair') {
      const displaced = testInfo.outputPath('original-capture.md');
      await fs.rename(file, displaced);
      await fs.unlink(backup);
      await fs.writeFile(file, tx.previous, { flag: 'wx' });
      await fs.link(file, backup);
      const foreign = await fs.lstat(file, { bigint: true });
      await expect(restarted.info()).rejects.toThrow(/changed|preserved/i);
      expect(await readOptional(stage)).toBeNull();
      expect(await readOptional(backup + '.detach.json')).toBeNull();
      expect(await readOptional(displaced)).toBe(tx.previous);
      for (const leaf of [file, backup]) {
        const retained = await fs.lstat(leaf, { bigint: true });
        expect([retained.ino, retained.nlink]).toEqual([foreign.ino, 2n]);
        expect(await readOptional(leaf)).toBe(tx.previous);
      }
    } else if (detached === 'equal-byte foreign stage') {
      await fs.writeFile(stage, tx.previous, { flag: 'wx' });
      const foreign = await fs.lstat(stage, { bigint: true });
      await expect(restarted.info()).rejects.toThrow(/independent restored capture backup/i);
      expect(await readOptional(stage)).toBe(tx.previous);
      expect((await fs.lstat(stage, { bigint: true })).ino).toBe(foreign.ino);
      expect((await fs.lstat(backup, { bigint: true })).ino).toBe(original.ino);
      expect((await fs.lstat(file, { bigint: true })).nlink).toBe(2n);
    } else {
      await restarted.info();
      const independent = await fs.lstat(backup, { bigint: true });
      expect(independent.ino).not.toBe(original.ino);
      expect(independent.nlink).toBe(1n);
      expect(await readOptional(stage)).toBeNull();
      expect(await readOptional(backup)).toBe(tx.previous);
      const getVault = () => restartedVault, clock = () => ({ now: later });
      const conversations = new Conversations({ dataRoot: testInfo.outputPath('history'), getVault, clock });
      await conversations.lock(async () => {});
      const deletion = new CaptureDeletion({ getVault, conversations, clock, clearApprovals() {} });
      const preview = await deletion.preview(capture.id);
      expect(preview.targets).toContain(path.relative(vault.vault, backup).split(path.sep).join('/'));
      deletion.cancel(preview.token);
      const displaced = testInfo.outputPath('detached-backup.md');
      await fs.rename(backup, displaced);
      await fs.writeFile(backup, tx.previous, { flag: 'wx' });
      await expect(deletion.preview(capture.id)).rejects.toThrow(/source recovery inventory/i);
      expect(await readOptional(backup)).toBe(tx.previous);
      expect(await readOptional(displaced)).toBe(tx.previous);
    }
  });
}

test('an older ordinary journal can recover its exact snapshot stage', async ({}, testInfo) => {
  const producer = testInfo.outputPath('producer');
  const { vault, intake } = await setup(testInfo);
  await writeDraft(producer);
  await exitDuringOrdinaryIntake(vault, producer, 'intake-journaled');
  const journal = path.join(intake.dir, 'transaction.json');
  const tx = await readJson(journal);
  delete tx.publicationVersion;
  delete tx.previousProof;
  delete tx.journalIdentity;
  await fs.writeFile(journal, JSON.stringify(tx));
  const stage = path.join(intake.dir, tx.revision.id + '.snapshot.stage');
  await fs.writeFile(stage, JSON.stringify(tx.revision, null, 2), { flag: 'wx' });
  const original = await fs.lstat(stage, { bigint: true });

  const result = await new Intake(new Vault(vault.vault, 'Companion')).reconcile({ now: later });
  expect(result.attempts[tx.revision.identity]?.status).toBe('imported');
  const snapshot = await fs.lstat(path.join(vault.root, 'Revisions', tx.revision.id + '.json'), { bigint: true });
  expect([snapshot.dev, snapshot.ino, snapshot.nlink]).toEqual([original.dev, original.ino, 1n]);
});

test('ordinary intake restart preserves an equal-byte journal replacement before staging', async ({}, testInfo) => {
  const producer = testInfo.outputPath('producer'), displaced = testInfo.outputPath('original-transaction.json');
  const { vault, intake, ledgerFile } = await setup(testInfo);
  await writeDraft(producer);
  await exitDuringOrdinaryIntake(vault, producer, 'intake-journaled');
  const journal = path.join(intake.dir, 'transaction.json'), original = await fs.readFile(journal), tx = JSON.parse(original);
  await fs.rename(journal, displaced);
  await fs.writeFile(journal, original, { flag: 'wx' });
  const foreign = await fs.lstat(journal, { bigint: true });

  await expect(new Intake(new Vault(vault.vault, 'Companion')).reconcile({ now: later })).rejects.toThrow(/journal.*changed|invalid intake recovery journal/i);
  expect(await fs.readFile(displaced)).toEqual(original);
  expect(await fs.readFile(journal)).toEqual(original);
  expect((await fs.lstat(journal, { bigint: true })).ino).toBe(foreign.ino);
  expect(await readOptional(intake.destination(tx.capture))).toBeNull();
  expect((await readJson(ledgerFile)).attempts[tx.revision.identity]).toBeUndefined();
});

for (const change of ['exact pair', 'replaced writer stage', 'replaced active journal']) {
  test(`ordinary intake and read-only deletion verify the initial journal publication with ${change}`, async ({}, testInfo) => {
    const producer = testInfo.outputPath('producer'), displaced = testInfo.outputPath('original-journal-peer.json');
    const { vault, intake, ledgerFile } = await setup(testInfo);
    await writeDraft(producer);
    const first = await intake.connect(producer, true, now);
    const existing = Object.values(first.captures)[0];
    await writeDraft(producer, 'second-source', '2', 'c');
    await exitDuringOrdinaryIntake(vault, producer, change === 'replaced active journal' ? 'intake-journaled' : 'journal-linked');
    const journal = path.join(intake.dir, 'transaction.json'), original = await fs.readFile(journal), tx = JSON.parse(original);
    const writerStages = (await fs.readdir(intake.dir)).filter(name => /^journal-.*\.stage$/.test(name));
    expect(writerStages).toHaveLength(change === 'replaced active journal' ? 0 : 1);
    const stage = writerStages.length ? path.join(intake.dir, writerStages[0]) : null;
    const initial = await fs.lstat(journal, { bigint: true });
    if (stage) expect((await fs.lstat(stage, { bigint: true })).ino).toBe(initial.ino);
    const replaced = change === 'exact pair' ? null : stage || journal;
    if (replaced) {
      await fs.rename(replaced, displaced);
      await fs.writeFile(replaced, original, { flag: 'wx' });
    }
    const getVault = () => vault, clock = () => ({ now: later });
    const conversations = new Conversations({ dataRoot: testInfo.outputPath('history'), getVault, clock });
    await conversations.lock(async () => {});
    const deletion = new CaptureDeletion({ getVault, conversations, clock, clearApprovals() {} });
    const restarted = new Intake(new Vault(vault.vault, 'Companion'));
    if (replaced) {
      await expect(deletion.preview(existing.id)).rejects.toThrow(/journal|alias|peer/i);
      await expect(restarted.reconcile({ now: later })).rejects.toThrow(/journal|alias|peer/i);
      expect(await fs.readFile(displaced)).toEqual(original);
      expect(await fs.readFile(replaced)).toEqual(original);
      expect(await readOptional(intake.destination(tx.capture))).toBeNull();
      expect((await readJson(ledgerFile)).attempts).toEqual(first.attempts);
    } else {
      expect((await deletion.preview(existing.id)).targets).toContain(path.relative(vault.vault, intake.destination(existing)).split(path.sep).join('/'));
      expect((await fs.lstat(journal, { bigint: true })).nlink).toBe(2n);
      expect(await fs.readFile(stage)).toEqual(original);
      const result = await restarted.reconcile({ now: later });
      expect(result.attempts[tx.revision.identity]?.status).toBe('imported');
      expect(await readOptional(journal)).toBeNull();
      expect(await readOptional(stage)).toBeNull();
      expect(await readOptional(intake.destination(tx.capture))).toBe(tx.content);
    }
  });
}

test('ordinary intake preserves its prior capture when the journal disappears after the move proof commits', async ({}, testInfo) => {
  const producer = testInfo.outputPath('producer'), displaced = testInfo.outputPath('original-transaction.json');
  const { intake } = await setup(testInfo);
  await writeDraft(producer);
  const baseline = await intake.connect(producer, true, now);
  const file = intake.destination(Object.values(baseline.captures)[0]), original = await fs.readFile(file);
  await writeDraft(producer, 'second', '2');
  const journal = path.join(intake.dir, 'transaction.json'), view = intake.storage.view.bind(intake.storage);
  let tx;
  intake.storage.view = async observedFile => {
    const observed = await view(observedFile);
    if (!observedFile && !tx && Object.values(JSON.parse(observed.text).intakeStageRecords || {}).some(record => record.backup)) {
      tx = await readJson(journal);
      await fs.rename(journal, displaced);
    }
    return observed;
  };
  await intake.reconcile({ now: later }).catch(error => error);

  expect(tx, 'the exact backup proof was durable before the journal moved').toBeDefined();
  expect(await readJson(displaced)).toEqual(tx);
  expect(await readOptional(path.join(intake.dir, tx.backup))).toBeNull();
  expect(await fs.readFile(file)).toEqual(original);
});

test('ordinary intake preserves an equal-byte replacement of the prior capture after journaling', async ({}, testInfo) => {
  const producer = testInfo.outputPath('producer'), displaced = testInfo.outputPath('original-capture.md');
  let tx, file, original;
  const { intake } = await setup(testInfo, async boundary => {
    if (boundary !== 'intake-journaled') return;
    const observed = await readJson(path.join(intake.dir, 'transaction.json'));
    if (observed.previous === null) return;
    tx = observed;
    file = intake.destination(tx.capture);
    original = await fs.readFile(file);
    await fs.rename(file, displaced);
    await fs.writeFile(file, original, { flag: 'wx' });
  });
  await writeDraft(producer);
  const baseline = await intake.connect(producer, true, now);
  await writeDraft(producer, 'second', '2');
  const result = await intake.reconcile({ now: later });

  expect(result.lastCheck.status).toBe('held');
  expect(result.attempts).toEqual(baseline.attempts);
  expect(await readOptional(path.join(intake.dir, tx.backup))).toBeNull();
  expect(await fs.readFile(file)).toEqual(original);
  expect(await fs.readFile(displaced)).toEqual(original);
});

test('explicit missing-note restore preserves an equal-byte replacement of its published journal', async ({}, testInfo) => {
  const producer = testInfo.outputPath('producer'), displaced = testInfo.outputPath('original-transaction.json');
  const { intake } = await setup(testInfo);
  await writeDraft(producer);
  const baseline = await intake.connect(producer, true, now);
  const capture = Object.values(baseline.captures)[0], file = intake.destination(capture);
  await fs.unlink(file);
  const { token } = (await intake.info()).identityIssues[capture.id];
  const publish = intake.publishJournal.bind(intake);
  let original, journal;
  intake.publishJournal = async (destination, tx) => {
    const proof = await publish(destination, tx);
    if (tx.restore) {
      journal = destination;
      original = await fs.readFile(journal);
      await fs.rename(journal, displaced);
      await fs.writeFile(journal, original, { flag: 'wx' });
    }
    return proof;
  };
  await expect(intake.restoreMissing({ id: capture.id, token }, later)).rejects.toThrow(/changed|preserved/i);
  expect(await fs.readFile(journal)).toEqual(original);
  expect(await fs.readFile(displaced)).toEqual(original);
  expect(await readOptional(file)).toBeNull();
});

const ordinaryRestartCases = [
  ...['unchanged', 'missing capture', 'missing snapshot', 'replaced capture', 'replaced snapshot'].map(change => ({ change })),
  { change: 'missing snapshot', legacy: true },
  { change: 'replaced capture', legacy: true }
];
for (const { change, legacy } of ordinaryRestartCases) {
  test('accepted ordinary intake restart preserves the exact publication with ' + change + (legacy ? ' on legacy upgrade' : ''), async ({}, testInfo) => {
    const producer = testInfo.outputPath('producer');
    const { vault, intake, ledgerFile } = await setup(testInfo);
    await writeDraft(producer);
    await exitDuringOrdinaryIntake(vault, producer, 'intake-ledger');

    const journal = path.join(intake.dir, 'transaction.json');
    const raw = await fs.readFile(journal, 'utf8'), tx = JSON.parse(raw);
    const committed = await readJson(ledgerFile);
    expect(committed.attempts[tx.revision.identity]).toMatchObject({ status: 'imported', revision: tx.revision.id });
    expect(committed.captures[tx.sourceHash].currentRevision).toBe(tx.revision.id);
    if (legacy) {
      const { acceptedCleanup, ...previousSchema } = committed;
      expect(acceptedCleanup).toMatchObject({ sourceHash: tx.sourceHash, key: tx.key, revision: tx.revision.id });
      await fs.writeFile(ledgerFile, JSON.stringify(previousSchema, null, 2));
      expect(await readJson(ledgerFile)).toEqual(previousSchema);
    }
    const originalJournal = await fs.lstat(journal, { bigint: true });
    expect(originalJournal.nlink).toBe(1n);
    const capture = intake.destination(tx.capture), snapshot = path.join(vault.root, 'Revisions', tx.revision.id + '.json');
    const files = [
      { file: capture, stage: path.join(intake.dir, tx.revision.id + '.stage'), bytes: tx.content },
      { file: snapshot, stage: path.join(intake.dir, tx.revision.id + '.snapshot.stage'), bytes: JSON.stringify(tx.revision, null, 2) }
    ];
    for (const item of files) {
      item.original = await fs.lstat(item.stage, { bigint: true });
      const published = await fs.lstat(item.file, { bigint: true });
      expect([published.dev, published.ino, published.nlink]).toEqual([item.original.dev, item.original.ino, 2n]);
      expect(await fs.readFile(item.file, 'utf8')).toBe(item.bytes);
    }
    const changed = change === 'unchanged' ? null : files[change.endsWith('capture') ? 0 : 1];
    let replacement;
    if (changed) {
      await fs.unlink(changed.file);
      if (change.startsWith('replaced')) {
        await fs.writeFile(changed.file, changed.bytes, { flag: 'wx' });
        replacement = await fs.lstat(changed.file, { bigint: true });
        expect([replacement.dev, replacement.ino]).not.toEqual([changed.original.dev, changed.original.ino]);
      }
    }

    let replay = false;
    const restarted = new Intake(new Vault(vault.vault, 'Companion', { checkpoint: async boundary => {
      if (boundary === 'intake-snapshot-staged' && await readOptional(journal) === raw) replay = true;
    } }));
    await writeDraft(producer, 'z-independent', '2', 'c');
    const recovered = await restarted.reconcile({ now: later });
    expect.soft(replay, 'recovery acknowledges the committed transaction without running publication again').toBe(false);
    expect(recovered.attempts[tx.revision.identity]).toEqual(committed.attempts[tx.revision.identity]);
    expect(Object.values(recovered.attempts)).toHaveLength(2);
    expect(await readOptional(journal)).toBeNull();
    if (changed) {
      expect.soft(recovered.lastCheck.status).toBe('held');
      const name = 'conflict-' + tx.revision.id + '.json', held = path.join(intake.dir, name);
      expect.soft(recovered.blocks[tx.sourceHash]?.journal).toBe(name);
      expect.soft(await readOptional(held)).toBe(raw);
      const heldJournal = await fs.lstat(held, { bigint: true }).catch(error => {
        if (error.code === 'ENOENT') return null;
        throw error;
      });
      expect.soft(heldJournal && [heldJournal.dev, heldJournal.ino, heldJournal.nlink]).toEqual([originalJournal.dev, originalJournal.ino, 1n]);
    } else {
      expect(recovered.lastCheck.status).toBe('complete');
      expect(recovered.blocks[tx.sourceHash]).toBeUndefined();
    }
    for (const item of files) {
      expect.soft(await readOptional(item.stage)).toBe(changed ? item.bytes : null);
      if (changed) {
        const stage = await fs.lstat(item.stage, { bigint: true }).catch(error => {
          if (error.code === 'ENOENT') return null;
          throw error;
        });
        expect.soft(stage && [stage.dev, stage.ino, stage.nlink]).toEqual([item.original.dev, item.original.ino, item === changed ? 1n : 2n]);
      }
      expect.soft(await readOptional(item.file)).toBe(item === changed && !replacement ? null : item.bytes);
      if (item === changed && !replacement) continue;
      const published = await fs.lstat(item.file, { bigint: true }), expected = item === changed ? replacement : item.original;
      expect([published.dev, published.ino, published.nlink]).toEqual([expected.dev, expected.ino, changed && item !== changed ? 2n : 1n]);
    }
  });
}

for (const target of ['published snapshot', 'published capture', 'shared journal']) test('Windows accepted intake read refusal at the ' + target, async ({}, testInfo) => {
  test.skip(process.platform !== 'win32', 'Requires a native Windows FileShare.None refusal.');
  const { vault, intake, ledgerFile } = await setup(testInfo);
  const producer = testInfo.outputPath('producer');
  await writeDraft(producer);
  await exitDuringOrdinaryIntake(vault, producer, 'intake-ledger');
  const journal = path.join(intake.dir, 'transaction.json'), raw = await fs.readFile(journal, 'utf8'), tx = JSON.parse(raw);
  const before = await fs.readFile(ledgerFile, 'utf8'), committed = JSON.parse(before);
  const originalJournal = await fs.lstat(journal, { bigint: true });
  const snapshot = path.join(vault.root, 'Revisions', tx.revision.id + '.json');
  const capture = intake.destination(tx.capture), captureStage = path.join(intake.dir, tx.revision.id + '.stage');
  const snapshotStage = path.join(intake.dir, tx.revision.id + '.snapshot.stage');
  const files = await Promise.all([capture, snapshot, captureStage, snapshotStage].map(async file => ({
    file, bytes: await fs.readFile(file, 'utf8'), stat: await fs.lstat(file, { bigint: true })
  })));
  const locked = { 'published snapshot': snapshot, 'published capture': capture, 'shared journal': journal }[target];
  const script = [
    '$ErrorActionPreference = "Stop"',
    '$stream = [IO.File]::Open($env:COMPANION_LOCKED_INTAKE_FIXTURE, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::None)',
    'try { [Console]::WriteLine("READY:" + $PID); [void][Console]::ReadLine() } finally { $stream.Dispose(); [Console]::WriteLine("RELEASED:" + $PID) }'
  ].join('; ');
  await writeDraft(producer, 'z-independent', '2', 'c');
  const child = spawn('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script], {
    windowsHide: true, env: { ...process.env, COMPANION_LOCKED_INTAKE_FIXTURE: locked }, stdio: ['pipe', 'pipe', 'pipe']
  });
  const native = { pid: child.pid, stdout: '', stderr: '' };
  child.stdout.on('data', chunk => { native.stdout += chunk.toString(); });
  child.stderr.on('data', chunk => { native.stderr += chunk.toString(); });
  child.stdin.on('error', error => { native.inputError = error.message; });
  child.on('error', error => { native.error = error.message; });
  const closed = new Promise(resolve => child.once('close', (code, signal) => {
    native.exit = { code, signal };
    resolve();
  }));
  const sharing = ['EPERM', 'EBUSY', 'EACCES'];
  let outcome, refusal;
  try {
    await expect.poll(() => {
      if (native.error || native.exit) throw Error(JSON.stringify(native));
      return native.stdout;
    }).toContain('READY:' + child.pid);
    try { local.readFileSync(locked); }
    catch (error) { refusal = error.code; }
    expect(sharing).toContain(refusal);
    const restarted = new Intake(new Vault(vault.vault, 'Companion'));
    outcome = await restarted.reconcile({ now: later }).catch(error => error);
  } finally {
    child.stdin.end('\n');
    await closed;
  }
  expect(native.exit).toEqual({ code: 0, signal: null });
  expect(native.stdout).toContain('RELEASED:' + child.pid);
  for (const { file, bytes, stat } of files) {
    expect(await fs.readFile(file, 'utf8')).toBe(bytes);
    const after = await fs.lstat(file, { bigint: true });
    expect([after.dev, after.ino, after.nlink]).toEqual([stat.dev, stat.ino, stat.nlink]);
  }
  if (target === 'shared journal') {
    expect(outcome).toBeInstanceOf(Error);
    expect(sharing).toContain(outcome.code);
    expect(await fs.readFile(ledgerFile, 'utf8')).toBe(before);
    expect(await fs.readFile(journal, 'utf8')).toBe(raw);
    return;
  }
  expect(outcome instanceof Error ? { code: outcome.code, message: outcome.message } : null).toBeNull();
  expect(outcome.lastCheck.status).toBe('held');
  expect(outcome.attempts[tx.revision.identity]).toEqual(committed.attempts[tx.revision.identity]);
  expect(Object.values(outcome.attempts)).toHaveLength(2);
  const held = path.join(intake.dir, 'conflict-' + tx.revision.id + '.json');
  expect(outcome.blocks[tx.sourceHash]?.journal).toBe(path.basename(held));
  expect(await readOptional(journal)).toBeNull();
  expect(await fs.readFile(held, 'utf8')).toBe(raw);
  const heldJournal = await fs.lstat(held, { bigint: true });
  expect([heldJournal.dev, heldJournal.ino, heldJournal.nlink]).toEqual([originalJournal.dev, originalJournal.ino, 1n]);
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

const deferredOutputChanges = [
  { kind: 'capture', restartBeforeCleanup: false, title: 'before and after restart' },
  { kind: 'capture', restartBeforeCleanup: true, title: 'on restart' },
  { kind: 'snapshot', restartBeforeCleanup: false, title: 'for a replaced snapshot before and after restart' }
];
for (const { kind, restartBeforeCleanup, title } of deferredOutputChanges) test(`accepted deferred output change stays held ${title}`, async ({}, testInfo) => {
  const producer = testInfo.outputPath('producer'), interruption = Error('Stopped after deferred output replacement.');
  let deferMove = false, retry = false, replacement, committed;
  const { vault, intake, ledgerFile } = await setup(testInfo, async boundary => {
    if (boundary === 'intake-before-move' && deferMove) throw Object.assign(Error('Fixture capture is busy.'), { code: 'EACCES' });
    if (boundary !== 'intake-ledger' || !retry || replacement) return;
    committed = await readJson(ledgerFile);
    const original = await fs.lstat(output, { bigint: true });
    expect(await fs.readFile(output, 'utf8')).toBe(outputBytes);
    await fs.unlink(output);
    await fs.writeFile(output, outputBytes, { flag: 'wx' });
    replacement = await fs.lstat(output, { bigint: true });
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
  const snapshot = path.join(vault.root, 'Revisions', tx.revision.id + '.json'), snapshotBytes = JSON.stringify(tx.revision, null, 2);
  const [output, outputBytes] = kind === 'capture' ? [destination, tx.content] : [snapshot, snapshotBytes];
  const captureStage = path.join(intake.dir, tx.revision.id + '.stage');
  const snapshotStage = path.join(intake.dir, tx.revision.id + '.snapshot.stage');
  await writeDraft(producer, 'z-independent', '3', 'c');
  retry = true;
  const outcome = await intake.reconcile({ now: later }).catch(error => error);
  expect(replacement, 'the accepted output was replaced at the real ledger checkpoint').toBeDefined();
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
    expect(await fs.readFile(snapshotStage, 'utf8')).toBe(snapshotBytes);
    expect(await fs.readFile(output, 'utf8')).toBe(outputBytes);
    const current = await fs.lstat(output, { bigint: true });
    expect([current.dev, current.ino]).toEqual([replacement.dev, replacement.ino]);
    if (kind === 'snapshot') {
      const capturePeer = await fs.lstat(captureStage, { bigint: true }), capture = await fs.lstat(destination, { bigint: true });
      expect([capture.dev, capture.ino, capture.nlink]).toEqual([capturePeer.dev, capturePeer.ino, 2n]);
    }
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
  const restartAt = '2026-11-10T06:59:00.000Z';
  let normalConflict;
  if (kind === 'snapshot' && !(outcome instanceof Error)) {
    const [otherSource, otherCapture] = Object.entries(outcome.captures).find(([source]) => source !== sourceHash);
    const file = restarted.destination(otherCapture);
    const localWriting = (await fs.readFile(file, 'utf8')) + '\nAn independent capture with an ordinary local edit.\n';
    await fs.writeFile(file, localWriting);
    await writeDraft(producer, 'zzz-independent-update', '5', 'c');
    normalConflict = { sourceHash: otherSource, id: otherCapture.id, local: localWriting };
  }
  const recovered = await restarted.reconcile({ now: restartAt });
  await expectHeld(recovered, restartBeforeCleanup ? 3 : 4);
  if (kind === 'snapshot') {
    expect(normalConflict).toBeDefined();
    expect(recovered.blocks[normalConflict.sourceHash]?.journal).toBeTruthy();
    const repairs = await restarted.repairs();
    const hold = repairs.find(item => item.sourceHash === sourceHash);
    expect(hold).toMatchObject({ kind: 'intake-output-hold', sourceHash, id: tx.capture.id, reason: recovered.blocks[sourceHash].reason });
    expect(hold).not.toHaveProperty('local');
    expect(hold).not.toHaveProperty('incoming');
    expect(repairs.find(item => item.sourceHash === normalConflict.sourceHash)).toMatchObject({ ...normalConflict, incoming: expect.any(String) });
    const before = await fs.readFile(ledgerFile);
    await expect(restarted.resolveConflict({ sourceHash, text: 'Selected local writing.', localHash: hash(tx.content) }, restartAt))
      .rejects.toThrow(/publication hold|published intake output/i);
    expect(await fs.readFile(ledgerFile)).toEqual(before);
    await expectHeld(await readJson(ledgerFile), 4);
  }
});

test('accepted deferred bookkeeping resumes after exact journal retirement and a later capture edit', async ({}, testInfo) => {
  const producer = testInfo.outputPath('producer'), interruption = Error('Stopped after retiring the deferred journal.');
  let deferMove = false;
  const { vault, intake, ledgerFile } = await setup(testInfo, boundary => {
    if (boundary === 'intake-before-move' && deferMove) throw Object.assign(Error('Fixture capture is busy.'), { code: 'EACCES' });
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
  const tx = await readJson(pending), destination = intake.destination(tx.capture), foreign = tx.content + '\nAn independent capture edit.\n';
  const unlink = local.unlinkSync;
  let retired = false;
  local.unlinkSync = file => {
    unlink(file);
    if (file !== pending) return;
    expect(local.existsSync(journal)).toBe(false);
    expect(local.existsSync(path.join(intake.dir, tx.revision.id + '.stage'))).toBe(false);
    expect(local.existsSync(path.join(intake.dir, tx.revision.id + '.snapshot.stage'))).toBe(false);
    local.writeFileSync(destination, foreign);
    retired = true;
    throw interruption;
  };
  try { await expect(intake.reconcile({ now: later })).rejects.toThrow(interruption.message); }
  finally { local.unlinkSync = unlink; }
  expect(retired).toBe(true);
  const committed = await readJson(ledgerFile);
  expect(committed.pending[sourceHash]).toBeDefined();
  expect(committed.attempts[tx.revision.identity]).toMatchObject({ status: 'imported', revision: tx.revision.id });
  await writeDraft(producer, 'z-independent', '3', 'c');
  const restarted = new Intake(new Vault(vault.vault, 'Companion'));
  const completed = await restarted.reconcile({ now: '2026-11-10T06:59:00.000Z' });
  expect(completed.attempts[tx.revision.identity]).toEqual(committed.attempts[tx.revision.identity]);
  expect(Object.values(completed.attempts)).toHaveLength(3);
  expect(completed.pending[sourceHash]).toBeUndefined();
  expect(completed.blocks[sourceHash]).toBeUndefined();
  expect(await readOptional(journal)).toBeNull();
  expect(await readOptional(pending)).toBeNull();
  expect(await readOptional(destination)).toBe(foreign);
});

test('precommit reviewed selection hold remains actionable for an already-admitted revision', async ({}, testInfo) => {
  const producer = testInfo.outputPath('producer');
  let selecting = false, replaced;
  const { vault, intake, ledgerFile } = await setup(testInfo, async boundary => {
    if (boundary !== 'intake-published' || !selecting || replaced) return;
    const raw = await fs.readFile(path.join(intake.dir, 'transaction.json'), 'utf8'), tx = JSON.parse(raw);
    const file = intake.destination(tx.capture), stage = path.join(intake.dir, tx.revision.id + '.stage');
    const proof = await fs.lstat(stage, { bigint: true });
    expect(await fs.readFile(file, 'utf8')).toBe(tx.content);
    expect(proof.nlink).toBe(2n);
    const localWriting = tx.previous + '\nIndependent local writing during the selection.\n';
    await fs.unlink(file);
    await fs.writeFile(file, localWriting, { flag: 'wx' });
    replaced = { tx, raw, file, stage, localWriting, proof };
  });
  await fs.cp(path.join(__dirname, 'fixtures/reel-review/accept'), path.join(producer, 'accept'), { recursive: true });
  const first = await intake.connect(producer, true, now, 'review');
  expect(first.lastCheck.status).toBe('complete');
  const [sourceHash, capture] = Object.entries(first.captures)[0];
  await fs.cp(path.join(__dirname, 'fixtures/reel-review/edit'), path.join(producer, 'edit'), { recursive: true });
  const choices = await intake.reconcile({ now: later });
  const candidate = Object.values(choices.attempts).find(item => item.revision !== capture.currentRevision);
  expect(candidate).toMatchObject({ status: 'imported', sourceHash, captureId: capture.id });
  expect(choices.captures[sourceHash].currentRevision).toBe(capture.currentRevision);
  selecting = true;
  const selectedAt = '2026-11-10T06:59:00.000Z';
  await expect(intake.selectCurrent(capture.id, candidate.revision, selectedAt)).rejects.toThrow(/published intake output/i);
  expect(replaced?.tx.revision.id).toBe(candidate.revision);
  const { tx, raw, file, stage, localWriting, proof } = replaced;
  const durable = await readJson(ledgerFile), hold = durable.blocks[sourceHash];
  expect(durable.captures[sourceHash].currentRevision).toBe(capture.currentRevision);
  expect(durable.captures[sourceHash].selectionHistory).toEqual(choices.captures[sourceHash].selectionHistory);
  expect(durable.attempts).toEqual(choices.attempts);
  expect(await fs.readFile(path.join(intake.dir, hold.journal), 'utf8')).toBe(raw);
  const staged = await fs.lstat(stage, { bigint: true });
  expect([staged.dev, staged.ino, staged.nlink]).toEqual([proof.dev, proof.ino, 1n]);
  expect(await fs.readFile(stage, 'utf8')).toBe(tx.content);
  expect(await fs.readFile(file, 'utf8')).toBe(localWriting);

  const restarted = new Intake(new Vault(vault.vault, 'Companion'));
  const repairs = await restarted.repairs();
  expect(repairs.find(item => item.sourceHash === sourceHash)).toMatchObject({
    id: capture.id, local: localWriting, incoming: tx.revision.text, incomingRevision: candidate.revision
  });
  const annotation = 'Preserve the independent writing from before selection.';
  await restarted.resolveConflict({ sourceHash, text: annotation, localHash: hash(localWriting) }, selectedAt);
  const resolved = await readJson(ledgerFile);
  expect(resolved.blocks[sourceHash]).toBeUndefined();
  expect(resolved.captures[sourceHash].currentRevision).toBe(candidate.revision);
  expect(resolved.attempts).toEqual(choices.attempts);
  expect(await fs.readFile(file, 'utf8')).toBe(tx.content);
  const annotations = path.join(vault.root, 'Annotations');
  const [annotationFile] = await fs.readdir(annotations);
  expect(await fs.readFile(path.join(annotations, annotationFile), 'utf8')).toContain(annotation);
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

test('intake preserves an equal-byte replacement at the final backup check', async ({}, testInfo) => {
  const producer = testInfo.outputPath('producer'), retained = testInfo.outputPath('original-capture.md');
  let selected, backup, replacement;
  const stat = local.lstatSync;
  const { intake, ledgerFile } = await setup(testInfo, async boundary => {
    if (boundary !== 'intake-before-move') return;
    const tx = await readJson(path.join(intake.dir, 'transaction.json'));
    backup = path.join(intake.dir, tx.backup);
    selected = intake.destination(tx.capture);
    local.lstatSync = function (file, ...args) {
      if (file === backup && /\bverifyAbsentSync\b/.test(new Error().stack)) {
        local.lstatSync = stat;
        const bytes = local.readFileSync(selected);
        local.renameSync(selected, retained);
        local.writeFileSync(selected, bytes, { flag: 'wx' });
        replacement = stat(selected, { bigint: true });
      }
      return stat.call(this, file, ...args);
    };
  });
  await writeDraft(producer);
  const baseline = await intake.connect(producer, true, now);
  const originalFile = intake.destination(Object.values(baseline.captures)[0]), original = await fs.readFile(originalFile);
  await writeDraft(producer, 'second', '2');
  try { await intake.reconcile({ now: later }); }
  finally { local.lstatSync = stat; }
  expect(replacement).toBeDefined();
  expect(await fs.readFile(retained)).toEqual(original);
  expect(await fs.readFile(selected)).toEqual(original);
  expect((await fs.lstat(selected, { bigint: true })).ino).toBe(replacement.ino);
  expect(await readOptional(backup)).toBeNull();
  expect((await readJson(ledgerFile)).attempts).toEqual(baseline.attempts);
});

test('ordinary startup recovery preserves an equal-byte transaction replacement after observing its journal', async ({}, testInfo) => {
  const producer = testInfo.outputPath('producer'), retained = testInfo.outputPath('original-transaction.json');
  let interrupt = false;
  const { vault, intake, ledgerFile } = await setup(testInfo, async boundary => {
    if (interrupt && boundary === 'intake-journaled') throw Error('Simulated interruption after publishing the transaction.');
  });
  await writeDraft(producer);
  const baseline = await intake.connect(producer, true, now);
  const captureFile = intake.destination(Object.values(baseline.captures)[0]), captureBytes = await fs.readFile(captureFile);
  await writeDraft(producer, 'second', '2');
  interrupt = true;
  expect((await intake.reconcile({ now: later })).lastCheck.status).toBe('held');
  const journal = path.join(intake.dir, 'transaction.json'), journalBytes = await fs.readFile(journal);
  const restarted = new Intake(new Vault(vault.vault, 'Companion'));
  const load = restarted.load.bind(restarted);
  let replacement;
  restarted.load = async function () {
    if (!replacement && /\bat Intake\.recoverOrdinaryIntake\b/.test(new Error().stack.split('\n')[2])) {
      await fs.rename(journal, retained);
      await fs.writeFile(journal, journalBytes, { flag: 'wx' });
      replacement = await fs.lstat(journal, { bigint: true });
    }
    return load();
  };
  let failure;
  try { await restarted.reconcile({ now: later }); }
  catch (error) { failure = error; }
  expect(replacement).toBeDefined();
  expect(failure?.message).toMatch(/journal.*changed/i);
  expect(await fs.readFile(journal)).toEqual(journalBytes);
  expect((await fs.lstat(journal, { bigint: true })).ino).toBe(replacement.ino);
  expect(await fs.readFile(retained)).toEqual(journalBytes);
  expect(await fs.readFile(captureFile)).toEqual(captureBytes);
  expect((await readJson(ledgerFile)).attempts).toEqual(baseline.attempts);
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
  const annotationStopped = Error('Stopped after the standalone annotation link.');
  let stopAnnotation = false;
  let keptCurrentRead = false;
  const { vault, intake, ledgerFile } = await setup(testInfo, async boundary => {
    if (boundary === 'annotation-published' && stopAnnotation) throw annotationStopped;
    if (boundary === 'repair-intent-published') keptCurrentRead = true;
    if (boundary === 'kept-current-read' && keptCurrentRead) {
      throw Object.assign(Error('Controlled kept-current file access failure.'), { code: 'EACCES' });
    }
  });
  await fs.cp(path.join(__dirname, 'fixtures/reel-review/accept'), path.join(producer, 'accept'), { recursive: true });
  const first = await intake.connect(producer, true, now, 'review');
  expect(first.lastCheck.status).toBe('complete');
  const [sourceHash, capture] = Object.entries(first.captures)[0];
  const independentHolds = new Map();
  if (role === 'retained writing') {
    const id = randomUUID(), text = 'Independent annotation already held before mixed deletion.';
    stopAnnotation = true;
    await expect(intake.addAnnotation({ id, captureId: capture.id, text }, now)).rejects.toBe(annotationStopped);
    stopAnnotation = false;
    await fs.unlink(path.join(vault.root, 'Annotations', `${id}.md`));
    await intake.info();
    for (const name of [`annotation-${id}.stage`, `annotation-${id}.held.json`]) {
      const file = path.join(intake.dir, name), bytes = await fs.readFile(file, 'utf8');
      expect(bytes).toContain(text);
      independentHolds.set(file, bytes);
    }
  }
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
  for (const file of independentHolds.keys()) expect(preview.targets).not.toContain(path.relative(vault.vault, file).split(path.sep).join('/'));
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
  for (const [file, bytes] of independentHolds) expect(await fs.readFile(file, 'utf8')).toBe(bytes);
  expect.soft(await readOptional(edited)).toBe(editedBytes);
  expect((await readJson(ledgerFile)).sourceAuthority[capture.id].phase).toBe('deleting');
  expect(outcome).toMatch(/changed|preserv/i);
});
