const { test, expect } = require('@playwright/test');
const fs = require('node:fs/promises');
const native = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { createHash } = require('node:crypto');
const { Vault } = require('../app/vault');
const { Intake } = require('../app/intake');
const { CaptureDeletion } = require('../app/capture-deletion');
const { Conversations } = require('../app/conversations');
const draft = require('./fixtures/reel-draft/example.json');

const now = '2026-11-08T06:59:00.000Z';
const later = '2026-11-09T06:59:00.000Z';
const readJson = async file => JSON.parse(await fs.readFile(file, 'utf8'));
const identity = async file => {
  const { dev, ino } = await fs.lstat(file, { bigint: true });
  return [dev, ino];
};
const readOptional = file => fs.readFile(file).catch(error => {
  if (error.code === 'ENOENT') return null;
  throw error;
});

async function writeDraft(producer, name, attempt, input) {
  const folder = path.join(producer, name);
  await fs.mkdir(folder, { recursive: true });
  const clip = 'b'.repeat(64);
  await fs.writeFile(path.join(folder, 'run.json'), JSON.stringify({
    job_id: clip, attempt_id: attempt.repeat(32), started_utc: now, input_sha256: input.repeat(64),
    input_kind: 'local_video', result_kind: 'local_video_unreviewed', state: 'partial', validation: 'passed'
  }));
  await fs.writeFile(path.join(folder, 'evidence.json'), JSON.stringify({ ...draft.input, clip_id: clip }));
  await fs.writeFile(path.join(folder, 'first-pass-target.json'), JSON.stringify(draft.target));
  await fs.copyFile(path.join(__dirname, 'fixtures/reel-draft/notes.md'), path.join(folder, 'notes.md'));
  return folder;
}

async function fixture(testInfo, checkpoint, { existing = false } = {}) {
  const vaultDirectory = testInfo.outputPath('vault');
  const producer = testInfo.outputPath('producer');
  const folder = await writeDraft(producer, 'draft', '1', 'a');
  if (existing) await writeDraft(producer, 'existing', '2', 'c');
  await fs.mkdir(vaultDirectory, { recursive: true });
  const vault = new Vault(await fs.realpath(vaultDirectory), 'Companion', { checkpoint });
  await vault.setup();
  const intake = new Intake(vault);
  const accepted = await intake.connect(producer, true, now);
  expect(accepted.lastCheck.status).toBe('complete');
  const sourceHash = 'a'.repeat(64), capture = accepted.captures[sourceHash];
  const getVault = () => vault, clock = () => ({ now: later });
  const conversations = new Conversations({ dataRoot: testInfo.outputPath('history'), getVault, clock });
  await conversations.lock(async () => {});
  const deletion = new CaptureDeletion({ getVault, conversations, clock, clearApprovals() {} });
  const removal = await deletion.preview(capture.id);
  await deletion.confirm(removal.token);
  const restoration = await deletion.previewRestoration({ id: capture.id, kind: 'draft', folder });
  return { vault, intake, deletion, restoration, producer, sourceHash, id: capture.id, ledgerFile: path.join(intake.dir, 'ledger.json') };
}

async function stopAfterActivation(testInfo) {
  const interruption = Error('Stopped immediately after the activation ledger was replaced.');
  let context, witness;
  context = await fixture(testInfo, async boundary => {
    if (!context || boundary !== 'intake-ledger') return;
    const { id, intake, ledgerFile } = context;
    const ledger = await readJson(ledgerFile);
    const restoration = ledger.sourceAuthority[id]?.restoration;
    if (!restoration || witness || !ledger.admissions[restoration.revision]) return;
    const journal = path.join(intake.dir, restoration.journal);
    witness = { journal, bytes: await fs.readFile(journal), identity: await identity(journal) };
  });
  const { vault, intake, deletion, restoration, id, sourceHash, ledgerFile } = context;
  const rename = native.renameSync;
  let committed;
  native.renameSync = (from, to) => {
    if (to === ledgerFile && path.dirname(from) === intake.dir && /^ledger-.*\.tmp$/.test(path.basename(from))) {
      const staged = JSON.parse(native.readFileSync(from, 'utf8'));
      if (staged.sourceAuthority?.[id]?.phase === 'active' && !committed) {
        rename(from, to);
        committed = staged;
        throw interruption;
      }
    }
    return rename(from, to);
  };
  let failure;
  try { await deletion.confirmRestoration(restoration.token); }
  catch (error) { failure = error; }
  finally { native.renameSync = rename; }

  expect(failure).toBe(interruption);
  expect(committed, 'the active ledger was replaced before interruption').toBeDefined();
  expect(witness, 'the selected journal was present at restoration admission').toBeDefined();
  expect(await readJson(ledgerFile)).toEqual(committed);
  expect(committed.suppressed).not.toContain(sourceHash);
  return { ...context, committed, witness };
}

test('imported restoration restart retires only the selected journal after activation commits', async ({}, testInfo) => {
  const { vault, intake, id, sourceHash, ledgerFile, committed, witness } = await stopAfterActivation(testInfo);
  const journal = await readOptional(witness.journal);
  expect.soft(journal).toEqual(witness.bytes);
  if (journal) expect(await identity(witness.journal)).toEqual(witness.identity);
  const capture = committed.captures[sourceHash];
  const destination = intake.destination(capture), snapshot = path.join(vault.root, 'Revisions', capture.currentRevision + '.json');
  const [captureIdentity, snapshotIdentity] = await Promise.all([identity(destination), identity(snapshot)]);

  const restarted = new Intake(new Vault(vault.vault, 'Companion'));
  await restarted.info();
  expect(await readOptional(witness.journal)).toBeNull();
  const final = await readJson(ledgerFile);
  expect(final.sourceAuthority[id]).toMatchObject({
    phase: 'active', generation: committed.sourceAuthority[id].generation, operationId: committed.sourceAuthority[id].operationId
  });
  expect(final.suppressed).not.toContain(sourceHash);
  expect(final.admissions).toEqual(committed.admissions);
  expect(final.attempts).toEqual(committed.attempts);
  expect(await identity(destination)).toEqual(captureIdentity);
  expect(await identity(snapshot)).toEqual(snapshotIdentity);
});

test('restoration hold allows independent import after a published output changes', async ({}, testInfo) => {
  const interruption = Error('Stopped after restoration publication.');
  const { vault, intake, deletion, restoration, producer, sourceHash, id, ledgerFile } = await fixture(testInfo, async boundary => {
    if (boundary === 'capture-restoration-published') throw interruption;
  });
  await expect(deletion.confirmRestoration(restoration.token)).rejects.toThrow(interruption.message);
  const before = await readJson(ledgerFile), authority = before.sourceAuthority[id];
  expect(authority).toMatchObject({ phase: 'restoring', restoration: { published: true } });
  expect(before.suppressed).toContain(sourceHash);
  const journal = path.join(intake.dir, authority.restoration.journal), journalBytes = await fs.readFile(journal);
  const journalIdentity = await identity(journal);
  const destination = intake.destination(before.captures[sourceHash]), displaced = testInfo.outputPath('original-capture.md');
  const originalBytes = await fs.readFile(destination), originalIdentity = await identity(destination);
  await fs.rename(destination, displaced);
  await fs.writeFile(destination, originalBytes, { flag: 'wx' });
  const replacementIdentity = await identity(destination);
  expect(replacementIdentity).not.toEqual(originalIdentity);
  const shared = path.join(intake.dir, 'transaction.json');
  expect(await readOptional(shared)).toBeNull();
  await writeDraft(producer, 'independent', '2', 'c');

  // An unrecognised shared transaction remains a global stop.
  const sharedBytes = Buffer.from('{"schema":0,"fixture":"independent unknown transaction"}');
  await fs.writeFile(shared, sharedBytes, { flag: 'wx' });
  const blocked = new Intake(new Vault(vault.vault, 'Companion'));
  await expect(blocked.reconcile({ now: later })).rejects.toThrow();
  expect(await fs.readFile(shared)).toEqual(sharedBytes);
  expect(await readJson(ledgerFile)).toEqual(before);
  await fs.rename(shared, testInfo.outputPath('independent-unknown-transaction.json'));

  const restarted = new Intake(new Vault(vault.vault, 'Companion'));
  const result = await restarted.reconcile({ now: later });
  const visible = await restarted.vault.list();
  const independent = result.captures['c'.repeat(64)];
  expect(independent).toBeDefined();
  expect(visible.map(note => note.id)).toContain(independent.id);
  expect(visible.map(note => note.id)).not.toContain(id);
  expect(await readOptional(restarted.destination(independent))).not.toBeNull();
  expect((await restarted.info()).captures['c'.repeat(64)]).toMatchObject(independent);
  expect(restarted.vault.warnings.join('\n')).toContain('A published restoration output changed.');
  expect(result.captures[sourceHash]).toEqual(before.captures[sourceHash]);
  expect(result.sourceAuthority[id]).toEqual(authority);
  expect(result.suppressed).toContain(sourceHash);
  expect(result.admissions).toEqual(before.admissions);
  expect(result.attempts[Object.keys(before.attempts)[0]]).toEqual(Object.values(before.attempts)[0]);
  expect(await fs.readFile(destination)).toEqual(originalBytes);
  expect(await identity(destination)).toEqual(replacementIdentity);
  expect(await identity(displaced)).toEqual(originalIdentity);
  expect(await fs.readFile(journal)).toEqual(journalBytes);
  expect(await identity(journal)).toEqual(journalIdentity);
  expect(await readOptional(shared)).toBeNull();
});

async function withRestorationReadRefusal(locked, work) {
  const script = [
    '$ErrorActionPreference = "Stop"',
    '$stream = [IO.File]::Open($env:COMPANION_RESTORATION_LOCK_FIXTURE, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::None)',
    'try { [Console]::WriteLine("READY:" + $PID); [void][Console]::ReadLine() } finally { $stream.Dispose(); [Console]::WriteLine("RELEASED:" + $PID) }'
  ].join('; ');
  const child = spawn('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script], {
    windowsHide: true, env: { ...process.env, COMPANION_RESTORATION_LOCK_FIXTURE: locked }, stdio: ['pipe', 'pipe', 'pipe']
  });
  const helper = { pid: child.pid, stdout: '', stderr: '' };
  child.stdout.on('data', chunk => { helper.stdout += chunk.toString(); });
  child.stderr.on('data', chunk => { helper.stderr += chunk.toString(); });
  child.stdin.on('error', error => { helper.inputError = error.message; });
  child.on('error', error => { helper.error = error.message; });
  const closed = new Promise(resolve => child.once('close', (code, signal) => {
    helper.exit = { code, signal };
    resolve();
  }));
  try {
    await expect.poll(() => {
      if (helper.error || helper.exit) throw Error(JSON.stringify(helper));
      return helper.stdout;
    }).toContain('READY:' + child.pid);
    let refusal;
    try { native.readFileSync(locked); }
    catch (error) { refusal = error.code; }
    expect(['EPERM', 'EBUSY', 'EACCES']).toContain(refusal);
    return await work();
  } finally {
    child.stdin.end('\n');
    await closed;
    expect(helper.exit).toEqual({ code: 0, signal: null });
    expect(helper.stdout).toContain('RELEASED:' + child.pid);
  }
}

async function observeLedgerStageWrites(intake, count, work) {
  const open = fs.open;
  let writes = 0;
  fs.open = async (file, ...args) => {
    if (count() && args[0] === 'wx' && path.dirname(String(file)) === intake.dir && /^ledger-.*\.tmp$/.test(path.basename(String(file)))) writes++;
    return open(file, ...args);
  };
  try { return { outcome: await work().catch(error => error), writes }; }
  finally { fs.open = open; }
}

for (const target of ['capture', 'snapshot', 'shared ledger']) {
  test(`Windows published restoration read refusal at the ${target}`, async ({}, testInfo) => {
    test.skip(process.platform !== 'win32', 'Requires an actual Windows FileShare.None handle.');
    const interruption = Error('Stopped after restoration publication.');
    const { vault, intake, deletion, restoration, producer, sourceHash, id, ledgerFile } = await fixture(testInfo, async name => {
      if (name === 'capture-restoration-published') throw interruption;
    }, { existing: target === 'capture' });
    await expect(deletion.confirmRestoration(restoration.token)).rejects.toThrow(interruption.message);
    const beforeBytes = await fs.readFile(ledgerFile), before = JSON.parse(beforeBytes);
    const authority = before.sourceAuthority[id], revision = authority.restoration.revision;
    expect(authority).toMatchObject({ phase: 'restoring', restoration: { published: true } });
    expect(before.suppressed).toContain(sourceHash);
    const capture = intake.destination(before.captures[sourceHash]);
    const snapshot = path.join(vault.root, 'Revisions', revision + '.json');
    const selected = path.join(intake.dir, authority.restoration.journal);
    const files = await Promise.all([capture, snapshot, selected].map(async file => ({
      file, bytes: await fs.readFile(file), stat: await fs.lstat(file, { bigint: true })
    })));
    const shared = path.join(intake.dir, 'transaction.json');
    expect(await readOptional(shared)).toBeNull();
    const bHash = 'c'.repeat(64), cHash = 'd'.repeat(64);
    if (target === 'capture') await writeDraft(producer, 'existing-update', '3', 'c');
    await writeDraft(producer, 'new-independent', '4', 'd');

    const locked = { capture, snapshot, 'shared ledger': ledgerFile }[target];
    const outcome = await withRestorationReadRefusal(locked, async () => {
      const restarted = new Intake(new Vault(vault.vault, 'Companion'));
      const result = await restarted.reconcile({ now: later }).catch(error => error);
      if (target === 'capture' && !(result instanceof Error)) {
        await expect(restarted.vault.list()).rejects.toThrow();
      }
      return result;
    });
    for (const { file, bytes, stat } of files) {
      expect(await fs.readFile(file)).toEqual(bytes);
      const after = await fs.lstat(file, { bigint: true });
      expect([after.dev, after.ino, after.nlink]).toEqual([stat.dev, stat.ino, stat.nlink]);
    }
    expect(await readOptional(shared)).toBeNull();
    if (target === 'shared ledger') {
      expect(outcome).toBeInstanceOf(Error);
      expect(await fs.readFile(ledgerFile)).toEqual(beforeBytes);
      return;
    }
    expect(outcome instanceof Error ? { code: outcome.code, message: outcome.message } : null).toBeNull();
    expect(outcome.captures[cHash]).toBeDefined();
    expect(await readOptional(intake.destination(outcome.captures[cHash]))).not.toBeNull();
    expect(outcome.sourceAuthority[id]).toEqual(authority);
    expect(outcome.suppressed).toContain(sourceHash);
    expect(outcome.admissions).toEqual(before.admissions);
    if (target === 'capture') {
      expect(outcome.captures[bHash].currentRevision).toBe(before.captures[bHash].currentRevision);
      expect(outcome.attempts[`${'b'.repeat(64)}:${'3'.repeat(32)}`]).toBeUndefined();
    }
  });
}

for (const target of ['active intake journal', 'selected restoration journal', 'existing-source update']) {
  const updating = target === 'existing-source update';
  const boundary = updating ? 'selected restoration journal is replaced during an existing-source update' : target + ' is replaced';
  test(`Windows held restoration stops before ledger writes when the ${boundary}`, async ({}, testInfo) => {
    test.skip(process.platform !== 'win32', 'Requires an actual Windows FileShare.None handle.');
    const interruption = Error('Stopped after restoration publication.');
    const { vault, intake, deletion, restoration, producer, sourceHash, id, ledgerFile } = await fixture(testInfo, async name => {
      if (name === 'capture-restoration-published') throw interruption;
    }, { existing: updating });
    await expect(deletion.confirmRestoration(restoration.token)).rejects.toThrow(interruption.message);
    const initial = await readJson(ledgerFile), authority = initial.sourceAuthority[id];
    const capture = intake.destination(initial.captures[sourceHash]);
    const snapshot = path.join(vault.root, 'Revisions', authority.restoration.revision + '.json');
    const selected = path.join(intake.dir, authority.restoration.journal), shared = path.join(intake.dir, 'transaction.json');
    const locked = target === 'active intake journal' ? capture : snapshot;
    const captureBytes = await fs.readFile(capture), captureIdentity = await identity(capture);
    const snapshotBytes = await fs.readFile(snapshot), snapshotIdentity = await identity(snapshot);
    const selectedBytes = await fs.readFile(selected), selectedIdentity = await identity(selected);
    const firstHash = 'c'.repeat(64), secondHash = 'd'.repeat(64);
    const existing = initial.captures[firstHash];
    const existingFile = updating ? intake.destination(existing) : undefined;
    const existingBytes = updating ? await fs.readFile(existingFile) : undefined;
    const existingIdentity = updating ? await identity(existingFile) : undefined;
    const existingSnapshot = updating ? path.join(vault.root, 'Revisions', existing.currentRevision + '.json') : undefined;
    const existingSnapshotBytes = updating ? await fs.readFile(existingSnapshot) : undefined;
    const existingSnapshotIdentity = updating ? await identity(existingSnapshot) : undefined;
    await writeDraft(producer, 'independent-first', '3', 'c');
    let fault;
    const replace = async (file, tx) => {
      const before = await fs.readFile(ledgerFile), bytes = await fs.readFile(file), originalIdentity = await identity(file);
      const sharedBytes = await fs.readFile(shared), sharedIdentity = await identity(shared);
      const displaced = testInfo.outputPath('original-controlled-journal.json');
      await fs.rename(file, displaced);
      await fs.writeFile(file, bytes, { flag: 'wx' });
      const foreignIdentity = await identity(file);
      expect(foreignIdentity).not.toEqual(originalIdentity);
      fault = { before, bytes, originalIdentity, foreignIdentity, file, displaced, tx, sharedBytes, sharedIdentity };
    };
    const { outcome, writes } = await withRestorationReadRefusal(locked, async () => {
      if (target === 'active intake journal' || updating) {
        await writeDraft(producer, 'independent-second', '4', 'd');
        const checkpoint = async name => {
          if (name !== 'intake-journaled' || fault) return;
          const tx = await readJson(shared);
          expect(tx.sourceHash).toBe(firstHash);
          if (updating) {
            expect(tx.capture.id).toBe(existing.id);
            expect(tx.previousHash).toBe(existing.currentHash);
            expect(tx.revision.id).not.toBe(existing.currentRevision);
          }
          await replace(updating ? selected : shared, tx);
        };
        const restarted = new Intake(new Vault(vault.vault, 'Companion', { checkpoint }));
        return observeLedgerStageWrites(intake, () => !!fault, () => restarted.reconcile({ now: later }));
      }
      await stopChildIntake(vault.vault, 'intake-journaled');
      const tx = await readJson(shared);
      expect(tx.sourceHash).toBe(firstHash);
      expect((await fs.lstat(shared, { bigint: true })).nlink).toBe(1n);
      await replace(selected, tx);
      await writeDraft(producer, 'independent-second', '4', 'd');
      const restarted = new Intake(new Vault(vault.vault, 'Companion'));
      return observeLedgerStageWrites(intake, () => true, () => restarted.reconcile({ now: later }));
    });
    expect(fault, 'the replacement occurred after the first draft owned its exact shared journal').toBeDefined();
    expect.soft(outcome).toBeInstanceOf(Error);
    expect.soft(writes).toBe(0);
    expect.soft(await fs.readFile(ledgerFile)).toEqual(fault.before);
    const ledger = await readJson(ledgerFile), faultLedger = JSON.parse(fault.before);
    expect.soft(ledger.captures[firstHash]).toEqual(faultLedger.captures[firstHash]);
    expect.soft(ledger.captures[secondHash]).toBeUndefined();
    expect.soft(ledger.attempts[fault.tx.revision.identity]).toBeUndefined();
    expect.soft(ledger.attempts).toEqual(faultLedger.attempts);
    expect.soft(ledger.outcomes[fault.tx.key]).toEqual(faultLedger.outcomes[fault.tx.key]);
    expect(ledger.sourceAuthority[id]).toEqual(authority);
    expect(ledger.suppressed).toContain(sourceHash);
    if (updating) {
      expect.soft(await fs.readFile(existingFile)).toEqual(existingBytes);
      expect.soft(await identity(existingFile)).toEqual(existingIdentity);
      expect(await fs.readFile(existingSnapshot)).toEqual(existingSnapshotBytes);
      expect(await identity(existingSnapshot)).toEqual(existingSnapshotIdentity);
    } else expect.soft(await readOptional(intake.destination(fault.tx.capture))).toBeNull();
    expect.soft(await readOptional(path.join(vault.root, 'Revisions', fault.tx.revision.id + '.json'))).toBeNull();
    const retainedShared = await readOptional(shared);
    expect.soft(retainedShared).toEqual(fault.sharedBytes);
    if (retainedShared && target !== 'active intake journal') expect(await identity(shared)).toEqual(fault.sharedIdentity);
    const foreign = await readOptional(fault.file);
    expect.soft(foreign).toEqual(fault.bytes);
    if (foreign) expect(await identity(fault.file)).toEqual(fault.foreignIdentity);
    expect(await fs.readFile(fault.displaced)).toEqual(fault.bytes);
    expect(await identity(fault.displaced)).toEqual(fault.originalIdentity);
    expect(await fs.readFile(capture)).toEqual(captureBytes);
    expect(await identity(capture)).toEqual(captureIdentity);
    expect(await fs.readFile(snapshot)).toEqual(snapshotBytes);
    expect(await identity(snapshot)).toEqual(snapshotIdentity);
    expect(await fs.readFile(selected)).toEqual(selectedBytes);
    if (target === 'active intake journal') expect(await identity(selected)).toEqual(selectedIdentity);
  });
}

test('restoration reserves the selected capture path as soon as authorization is durable', async ({}, testInfo) => {
  const interruption = Error('Stopped after restoration authorization.');
  const { vault, intake, deletion, restoration, sourceHash, id, ledgerFile } = await fixture(testInfo, async name => {
    if (name === 'capture-restoration-authorized') throw interruption;
  }, { existing: true });
  await expect(deletion.confirmRestoration(restoration.token)).rejects.toThrow(interruption.message);
  const ledger = await intake.load(), authority = ledger.sourceAuthority[id], other = ledger.captures['c'.repeat(64)];
  expect(authority.phase).toBe('restoring');
  expect(authority.restoration.published).toBeUndefined();
  expect(ledger.suppressed).toContain(sourceHash);
  const journal = path.join(intake.dir, authority.restoration.journal), tx = await readJson(journal);
  const reserved = intake.destination(tx.capture), existing = intake.destination(other);
  expect(reserved).toBe(intake.destination(ledger.captures[sourceHash]));
  expect(await readOptional(reserved)).toBeNull();
  const bytes = await fs.readFile(existing), existingIdentity = await identity(existing);
  await fs.writeFile(reserved, bytes, { flag: 'wx' });
  const foreignIdentity = await identity(reserved);
  expect(foreignIdentity).not.toEqual(existingIdentity);

  const reservations = vault.reservedRestorationIdentities(ledger);
  expect.soft(reservations.heldRestorations.get(id)).toBe(reserved);
  expect.soft(reservations.captures.has(other.id)).toBe(true);
  const inventory = await vault.captureInventory({ ledger, guardLedger: () => intake.storage.guard() });
  expect.soft(inventory.notes.some(note => note.file === reserved)).toBe(false);
  expect.soft([...inventory.owned].some(note => note.id === other.id)).toBe(false);
  expect(await readJson(ledgerFile)).toEqual(ledger);
  expect(await readOptional(path.join(intake.dir, 'transaction.json'))).toBeNull();
  expect(await fs.readFile(reserved)).toEqual(bytes);
  expect(await identity(reserved)).toEqual(foreignIdentity);
  expect(await fs.readFile(existing)).toEqual(bytes);
  expect(await identity(existing)).toEqual(existingIdentity);
});

test('direct restoration reservation read refuses an ordinary replacement of a recorded parent', async ({}, testInfo) => {
  const interruption = Error('Stopped after restoration publication.');
  const { vault, intake, deletion, restoration, sourceHash, id, ledgerFile } = await fixture(testInfo, async name => {
    if (name === 'capture-restoration-published') throw interruption;
  });
  await expect(deletion.confirmRestoration(restoration.token)).rejects.toThrow(interruption.message);
  const ledger = await readJson(ledgerFile), authority = ledger.sourceAuthority[id];
  expect(authority.restoration.published).toBe(true);
  const destination = intake.destination(ledger.captures[sourceHash]), parent = path.dirname(destination);
  const relative = path.relative(vault.vault, parent).split(path.sep).join('/');
  const recorded = authority.directories.find(item => item.file === relative);
  const parentIdentity = await identity(parent), originalBytes = await fs.readFile(destination);
  expect(recorded).toMatchObject({ dev: String(parentIdentity[0]), ino: String(parentIdentity[1]) });
  const displaced = testInfo.outputPath('original-restoration-parent');
  await fs.rename(parent, displaced);
  await fs.mkdir(parent);
  await fs.writeFile(destination, originalBytes, { flag: 'wx' });
  const replacementIdentity = await identity(parent);
  expect(replacementIdentity).not.toEqual(parentIdentity);

  expect.soft(() => vault.reservedRestorationIdentities(ledger)).toThrow(/folder|parent|identity/i);
  expect(await identity(parent)).toEqual(replacementIdentity);
  expect(await identity(displaced)).toEqual(parentIdentity);
  expect(await fs.readFile(destination)).toEqual(originalBytes);
  expect(await fs.readFile(path.join(displaced, path.basename(destination)))).toEqual(originalBytes);
  expect(await readJson(ledgerFile)).toEqual(ledger);
});

test('restoration hold preserves a reserved identity collision and imports a disjoint draft', async ({}, testInfo) => {
  const interruption = Error('Stopped after restoration publication.');
  const { vault, intake, deletion, restoration, producer, sourceHash, id, ledgerFile } = await fixture(testInfo, async boundary => {
    if (boundary === 'capture-restoration-published') throw interruption;
  }, { existing: true });
  await expect(deletion.confirmRestoration(restoration.token)).rejects.toThrow(interruption.message);
  const before = await readJson(ledgerFile), authority = before.sourceAuthority[id];
  const existingHash = 'c'.repeat(64), independentHash = 'd'.repeat(64), existing = before.captures[existingHash];
  const ordinary = intake.destination(existing), reserved = intake.destination(before.captures[sourceHash]);
  const ordinaryBytes = await fs.readFile(ordinary), ordinaryIdentity = await identity(ordinary);
  const displaced = testInfo.outputPath('original-restored-capture.md');
  await fs.rename(reserved, displaced);
  await fs.writeFile(reserved, ordinaryBytes, { flag: 'wx' });
  const reservedIdentity = await identity(reserved);
  expect(reservedIdentity).not.toEqual(ordinaryIdentity);
  await writeDraft(producer, 'existing-update', '3', 'c');
  await writeDraft(producer, 'independent', '4', 'd');

  const restarted = new Intake(new Vault(vault.vault, 'Companion'));
  const result = await restarted.reconcile({ now: later });
  const independent = result.captures[independentHash];
  expect(independent).toBeDefined();
  expect(await readOptional(restarted.destination(independent))).not.toBeNull();
  const visible = await restarted.vault.list();
  expect(visible.map(note => note.id)).toContain(independent.id);
  expect.soft(visible.map(note => note.id)).not.toContain(existing.id);
  expect(visible.map(note => note.id)).not.toContain(id);
  expect.soft(result.captures[existingHash].currentRevision).toBe(existing.currentRevision);
  expect.soft(result.captures[existingHash].identityIssue).toMatch(/identity/i);
  expect.soft(result.attempts[`${'b'.repeat(64)}:${'3'.repeat(32)}`]).toBeUndefined();
  expect(result.sourceAuthority[id]).toEqual(authority);
  expect(result.suppressed).toContain(sourceHash);
  expect.soft(await fs.readFile(ordinary)).toEqual(ordinaryBytes);
  expect.soft(await identity(ordinary)).toEqual(ordinaryIdentity);
  expect(await fs.readFile(reserved)).toEqual(ordinaryBytes);
  expect(await identity(reserved)).toEqual(reservedIdentity);
  expect(await readOptional(path.join(intake.dir, 'transaction.json'))).toBeNull();
});

test('restoration hold lets an exact interrupted independent intake settle before a new draft', async ({}, testInfo) => {
  const interruption = Error('Stopped after restoration publication.');
  const { vault, intake, deletion, restoration, producer, sourceHash, id, ledgerFile } = await fixture(testInfo, async boundary => {
    if (boundary === 'capture-restoration-published') throw interruption;
  });
  await expect(deletion.confirmRestoration(restoration.token)).rejects.toThrow(interruption.message);
  const before = await readJson(ledgerFile), authority = before.sourceAuthority[id];
  const destination = intake.destination(before.captures[sourceHash]);
  const original = testInfo.outputPath('original-held-restoration.md');
  const replacement = Buffer.from('Independent writing replacing a held restoration output.\n');
  await fs.rename(destination, original);
  await fs.writeFile(destination, replacement, { flag: 'wx' });
  const replacementIdentity = await identity(destination);
  const selected = path.join(intake.dir, authority.restoration.journal);
  const selectedBytes = await fs.readFile(selected), selectedIdentity = await identity(selected);
  const bHash = 'c'.repeat(64), cHash = 'd'.repeat(64), shared = path.join(intake.dir, 'transaction.json');
  await writeDraft(producer, 'interrupted-independent', '2', 'c');

  await stopChildIntake(vault.vault, 'intake-journaled');
  const interrupted = await readJson(shared);
  const proof = await fs.lstat(shared, { bigint: true });
  expect(proof.isFile() && !proof.isSymbolicLink() && proof.nlink === 1n).toBe(true);
  expect(interrupted.sourceHash).toBe(bHash);
  expect(interrupted.capture.id).not.toBe(id);
  expect((await readJson(ledgerFile)).captures[bHash]).toBeUndefined();
  await writeDraft(producer, 'new-independent', '3', 'd');

  const restarted = new Intake(new Vault(vault.vault, 'Companion'));
  const result = await restarted.reconcile({ now: later });
  expect(result.captures[bHash].id).toBe(interrupted.capture.id);
  expect(result.captures[bHash].revisions).toEqual([interrupted.revision.id]);
  expect(await readOptional(restarted.destination(result.captures[bHash]))).not.toBeNull();
  expect(await readOptional(restarted.destination(result.captures[cHash]))).not.toBeNull();
  expect(await readOptional(shared)).toBeNull();
  expect(result.sourceAuthority[id]).toEqual(authority);
  expect(result.suppressed).toContain(sourceHash);
  expect(await fs.readFile(destination)).toEqual(replacement);
  expect(await identity(destination)).toEqual(replacementIdentity);
  expect(await fs.readFile(selected)).toEqual(selectedBytes);
  expect(await identity(selected)).toEqual(selectedIdentity);
});

async function stopChildIntake(directory, boundary, pending = '', shared = '', claim = null) {
  const code = `
    const fs = require('node:fs/promises');
    const native = require('node:fs');
    const { Vault } = require('./app/vault');
    const { Intake } = require('./app/intake');
    const [directory, now, boundary, pending, shared, rawClaim] = process.argv.slice(1);
    const repair = boundary === 'held-repair-source-journal' ? JSON.parse(rawClaim) : null;
    const checkpoint = async name => {
      if (repair && name === 'repair-intent-published') {
        await fs.rename(repair.snapshot, repair.displaced);
        return;
      }
      if (name !== boundary) return;
      const claim = JSON.parse(rawClaim);
      if (claim) {
        await fs.rename(claim.reserved, claim.displaced);
        await fs.writeFile(claim.reserved, await fs.readFile(claim.existing), { flag: 'wx' });
      }
      process.exit(77);
    };
    if (boundary === 'pending-retry-link') {
      const link = fs.link;
      fs.link = async (from, to) => {
        await link(from, to);
        if (from === pending && to === shared) process.exit(77);
      };
    }
    if (boundary === 'held-conflict-ledger') {
      const details = JSON.parse(rawClaim), rename = native.renameSync;
      native.renameSync = (from, to) => {
        if (to === details.ledgerFile && /^ledger-.*\\.tmp$/.test(require('node:path').basename(from))) {
          const staged = JSON.parse(native.readFileSync(from, 'utf8'));
          if (staged.blocks[details.sourceHash]?.incomingRevision === details.revision &&
              !staged.pending[details.sourceHash]) {
            rename(from, to);
            process.exit(77);
          }
        }
        return rename(from, to);
      };
    }
    if (repair) {
      const link = fs.link, unlink = fs.unlink;
      let exactStage;
      fs.link = async (from, to) => {
        await link(from, to);
        if (to !== shared) return;
        const tx = JSON.parse(await fs.readFile(to, 'utf8'));
        if (tx.sourceHash === repair.input.sourceHash && tx.resolution && tx.resolution !== repair.priorResolution) exactStage = from;
      };
      fs.unlink = async file => {
        await unlink(file);
        if (file === exactStage) process.exit(77);
      };
    }
    const intake = new Intake(new Vault(directory, 'Companion', { checkpoint }));
    const operation = repair ? intake.resolveConflict(repair.input, now) : intake.reconcile({ now });
    operation.then(() => process.exit(78), error => { console.error(error); process.exit(79); });
  `;
  const child = spawn(process.execPath, ['-e', code, directory, later, boundary, pending, shared, JSON.stringify(claim)], {
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
}

for (const boundary of ['intake-ledger', 'pending-retry-link']) {
  test(`restoration hold settles an interrupted deferred retry at ${boundary} before independent intake`, async ({}, testInfo) => {
    const interruption = Error('Stopped after restoration publication.');
    const { vault, intake, deletion, restoration, producer, sourceHash, id, ledgerFile } = await fixture(testInfo, async name => {
      if (name === 'capture-restoration-published') throw interruption;
    }, { existing: true });
    await expect(deletion.confirmRestoration(restoration.token)).rejects.toThrow(interruption.message);
    const before = await readJson(ledgerFile), authority = before.sourceAuthority[id], bHash = 'c'.repeat(64), cHash = 'd'.repeat(64);
    const destination = intake.destination(before.captures[sourceHash]);
    const replacement = Buffer.from('Independent writing at the reserved restoration path.\n');
    await fs.rename(destination, testInfo.outputPath('original-reserved-capture.md'));
    await fs.writeFile(destination, replacement, { flag: 'wx' });
    const replacementIdentity = await identity(destination);
    const selected = path.join(intake.dir, authority.restoration.journal);
    const selectedBytes = await fs.readFile(selected), selectedIdentity = await identity(selected);
    await writeDraft(producer, 'existing-update', '3', 'c');
    const deferring = new Intake(new Vault(vault.vault, 'Companion', { checkpoint: async name => {
      if (name === 'intake-before-move') throw Object.assign(Error('Fixture capture is busy.'), { code: 'EACCES' });
    } }));
    const deferred = await deferring.reconcile({ now: later });
    expect(deferred.captures[bHash].currentRevision).toBe(before.captures[bHash].currentRevision);
    const pending = path.join(intake.dir, deferred.pending[bHash].journal), shared = path.join(intake.dir, 'transaction.json');
    const pendingBytes = await fs.readFile(pending), pendingIdentity = await identity(pending);
    const tx = JSON.parse(pendingBytes);
    expect(tx.sourceHash).toBe(bHash);
    expect(await readOptional(shared)).toBeNull();
    await stopChildIntake(vault.vault, boundary, pending, shared);

    const committed = await readJson(ledgerFile);
    expect(committed.captures[bHash].currentRevision).toBe(boundary === 'intake-ledger' ? tx.revision.id : before.captures[bHash].currentRevision);
    expect(await fs.readFile(shared)).toEqual(pendingBytes);
    expect(await fs.readFile(pending)).toEqual(pendingBytes);
    expect(await identity(shared)).toEqual(pendingIdentity);
    expect(await identity(pending)).toEqual(pendingIdentity);
    expect((await fs.lstat(shared, { bigint: true })).nlink).toBe(2n);
    expect((await fs.lstat(pending, { bigint: true })).nlink).toBe(2n);
    await writeDraft(producer, 'new-independent', '4', 'd');

    const restarted = new Intake(new Vault(vault.vault, 'Companion'));
    const result = await restarted.reconcile({ now: later });
    expect(result.captures[bHash].currentRevision).toBe(tx.revision.id);
    expect(result.captures[bHash].revisions).toEqual([...before.captures[bHash].revisions, tx.revision.id]);
    expect(result.attempts[tx.revision.identity]).toMatchObject({ status: 'imported', revision: tx.revision.id });
    expect(await readOptional(restarted.destination(result.captures[cHash]))).not.toBeNull();
    expect(await readOptional(shared)).toBeNull();
    expect(await readOptional(pending)).toBeNull();
    expect(result.sourceAuthority[id]).toEqual(authority);
    expect(result.suppressed).toContain(sourceHash);
    expect(await fs.readFile(destination)).toEqual(replacement);
    expect(await identity(destination)).toEqual(replacementIdentity);
    expect(await fs.readFile(selected)).toEqual(selectedBytes);
    expect(await identity(selected)).toEqual(selectedIdentity);
  });
}

test('a late reserved restoration identity claim holds only its exact journaled import', async ({}, testInfo) => {
  const interruption = Error('Stopped after restoration publication.');
  const { vault, intake, deletion, restoration, producer, sourceHash, id, ledgerFile } = await fixture(testInfo, async name => {
    if (name === 'capture-restoration-published') throw interruption;
  }, { existing: true });
  await expect(deletion.confirmRestoration(restoration.token)).rejects.toThrow(interruption.message);
  const before = await readJson(ledgerFile), authority = before.sourceAuthority[id], bHash = 'c'.repeat(64), cHash = 'd'.repeat(64);
  const reserved = intake.destination(before.captures[sourceHash]), existing = intake.destination(before.captures[bHash]);
  const initialReplacement = Buffer.from('Independent writing at the held restoration path.\n');
  await fs.rename(reserved, testInfo.outputPath('original-reserved-capture.md'));
  await fs.writeFile(reserved, initialReplacement, { flag: 'wx' });
  const existingBytes = await fs.readFile(existing), existingIdentity = await identity(existing);
  const selected = path.join(intake.dir, authority.restoration.journal);
  const selectedBytes = await fs.readFile(selected), selectedIdentity = await identity(selected);
  const shared = path.join(intake.dir, 'transaction.json');
  await writeDraft(producer, 'existing-update', '3', 'c');
  await writeDraft(producer, 'new-independent', '4', 'd');
  let observed;
  const restarted = new Intake(new Vault(vault.vault, 'Companion', { checkpoint: async name => {
    if (name !== 'intake-journaled' || observed) return;
    const bytes = await fs.readFile(shared), tx = JSON.parse(bytes);
    expect(tx.sourceHash).toBe(bHash);
    const prior = await readJson(ledgerFile);
    expect(prior.captures[bHash].identityIssue).toBeUndefined();
    const journalIdentity = await identity(shared);
    await fs.rename(reserved, testInfo.outputPath('first-foreign-reserved-file.md'));
    await fs.writeFile(reserved, existingBytes, { flag: 'wx' });
    observed = { bytes, tx, journalIdentity, replacementIdentity: await identity(reserved) };
  } }));
  const result = await restarted.reconcile({ now: later });
  expect(observed, 'the distinct claim appeared after the actual import journal was published').toBeDefined();
  expect.soft(result.attempts[observed.tx.revision.identity]).toBeUndefined();
  expect.soft(result.captures[bHash].currentRevision).toBe(before.captures[bHash].currentRevision);
  expect.soft(result.captures[cHash]).toBeDefined();
  expect.soft(await readOptional(shared)).toBeNull();
  const hold = result.blocks[bHash];
  expect(hold).toMatchObject({ incomingRevision: observed.tx.revision.id, reason: expect.stringMatching(/restoration path.*identity/i) });
  const archive = path.join(intake.dir, hold.journal);
  expect(await fs.readFile(archive)).toEqual(observed.bytes);
  expect(await identity(archive)).toEqual(observed.journalIdentity);
  expect(await identity(existing)).toEqual(existingIdentity);
  expect(await fs.readFile(existing)).toEqual(existingBytes);
  expect(await fs.readFile(reserved)).toEqual(existingBytes);
  expect(await identity(reserved)).toEqual(observed.replacementIdentity);
  expect(result.sourceAuthority[id]).toEqual(authority);
  expect(result.suppressed).toContain(sourceHash);
  expect(await fs.readFile(selected)).toEqual(selectedBytes);
  expect(await identity(selected)).toEqual(selectedIdentity);
});

async function fixtureForLaterClaim(testInfo) {
  const interruption = Error('Stopped after restoration publication.');
  const context = await fixture(testInfo, async name => {
    if (name === 'capture-restoration-published') throw interruption;
  }, { existing: true });
  const { intake, deletion, restoration, producer, sourceHash, id, ledgerFile } = context;
  await expect(deletion.confirmRestoration(restoration.token)).rejects.toThrow(interruption.message);
  const before = await readJson(ledgerFile), authority = before.sourceAuthority[id], bHash = 'c'.repeat(64), cHash = 'd'.repeat(64);
  const reserved = intake.destination(before.captures[sourceHash]), existing = intake.destination(before.captures[bHash]);
  await fs.rename(reserved, testInfo.outputPath('original-reserved-capture.md'));
  await fs.writeFile(reserved, 'Independent writing at the held restoration path.\n', { flag: 'wx' });
  const existingBytes = await fs.readFile(existing), existingIdentity = await identity(existing);
  const selected = path.join(intake.dir, authority.restoration.journal);
  const selectedBytes = await fs.readFile(selected), selectedIdentity = await identity(selected);
  const shared = path.join(intake.dir, 'transaction.json'), displaced = testInfo.outputPath('first-foreign-reserved-file.md');
  await writeDraft(producer, 'existing-update', '3', 'c');
  return {
    ...context, before, authority, bHash, cHash, reserved, existing, existingBytes, existingIdentity,
    selected, selectedBytes, selectedIdentity, shared, displaced
  };
}

test('restart archives the exact journal after a late reserved restoration claim and admits a disjoint draft', async ({}, testInfo) => {
  const context = await fixtureForLaterClaim(testInfo);
  const { vault, intake, producer, sourceHash, id, ledgerFile, before, authority, bHash, cHash,
    reserved, existing, existingBytes, existingIdentity, selected, selectedBytes, selectedIdentity, shared, displaced } = context;
  await stopChildIntake(vault.vault, 'intake-journaled', '', '', { reserved, existing, displaced });
  const raw = await fs.readFile(shared), tx = JSON.parse(raw), journalIdentity = await identity(shared);
  const original = await readJson(ledgerFile), replacementIdentity = await identity(reserved);
  expect(tx.sourceHash).toBe(bHash);
  expect(tx.capture.id).toBe(before.captures[bHash].id);
  expect(original.captures[bHash]).toMatchObject({ currentRevision: before.captures[bHash].currentRevision });
  expect(original.attempts[tx.revision.identity]).toBeUndefined();
  expect((await fs.lstat(shared, { bigint: true })).nlink).toBe(1n);
  await writeDraft(producer, 'new-independent', '4', 'd');

  const restarted = new Intake(new Vault(vault.vault, 'Companion'));
  const result = await restarted.reconcile({ now: later });
  expect(result.captures[cHash]).toBeDefined();
  expect(result.captures[bHash].currentRevision).toBe(before.captures[bHash].currentRevision);
  expect(result.attempts[tx.revision.identity]).toBeUndefined();
  const hold = result.blocks[bHash];
  expect(hold).toMatchObject({ incomingRevision: tx.revision.id, reason: expect.stringMatching(/restoration path.*identity/i) });
  expect(hold.outputHold?.committed).toBe(false);
  const archived = path.join(intake.dir, hold.journal);
  expect(await fs.readFile(archived)).toEqual(raw);
  expect(await identity(archived)).toEqual(journalIdentity);
  expect(await readOptional(shared)).toBeNull();
  expect(result.sourceAuthority[id]).toEqual(authority);
  expect(result.suppressed).toContain(sourceHash);
  expect(await fs.readFile(existing)).toEqual(existingBytes);
  expect(await identity(existing)).toEqual(existingIdentity);
  expect(await fs.readFile(reserved)).toEqual(existingBytes);
  expect(await identity(reserved)).toEqual(replacementIdentity);
  expect(await fs.readFile(selected)).toEqual(selectedBytes);
  expect(await identity(selected)).toEqual(selectedIdentity);
});

test('restart retires exact deferred aliases after an interrupted external edit conflict and continues independent intake', async ({}, testInfo) => {
  const context = await fixtureForLaterClaim(testInfo);
  const { vault, intake, producer, sourceHash, id, ledgerFile, before, authority, bHash, cHash,
    reserved, existing, selected, selectedBytes, selectedIdentity, shared } = context;
  const reservedBytes = await fs.readFile(reserved), reservedIdentity = await identity(reserved);
  const deferring = new Intake(new Vault(vault.vault, 'Companion', { checkpoint: async name => {
    if (name === 'intake-before-move') throw Object.assign(Error('Fixture capture is busy.'), { code: 'EACCES' });
  } }));
  const deferred = await deferring.reconcile({ now: later });
  const pending = path.join(intake.dir, deferred.pending[bHash].journal), raw = await fs.readFile(pending);
  const tx = JSON.parse(raw), journalIdentity = await identity(pending);
  expect(tx.sourceHash).toBe(bHash);
  await fs.appendFile(existing, '\nIndependent local editing while the draft was deferred.\n');
  const editedBytes = await fs.readFile(existing), editedIdentity = await identity(existing);
  await stopChildIntake(vault.vault, 'held-conflict-ledger', '', '', { ledgerFile, sourceHash: bHash, revision: tx.revision.id });
  const interrupted = await readJson(ledgerFile), pointer = interrupted.blocks[bHash];
  const held = path.join(intake.dir, pointer.journal);
  expect(interrupted.pending[bHash]).toBeUndefined();
  expect(interrupted.captures[bHash].currentRevision).toBe(before.captures[bHash].currentRevision);
  expect(interrupted.attempts[tx.revision.identity]).toBeUndefined();
  expect(await fs.readFile(shared)).toEqual(raw);
  expect(await fs.readFile(pending)).toEqual(raw);
  expect(await identity(shared)).toEqual(journalIdentity);
  expect(await identity(pending)).toEqual(journalIdentity);
  expect((await fs.lstat(shared, { bigint: true })).nlink).toBe(2n);
  expect(await readOptional(held)).toBeNull();
  await writeDraft(producer, 'new-independent', '4', 'd');

  const restarted = new Intake(new Vault(vault.vault, 'Companion'));
  const result = await restarted.reconcile({ now: later });
  expect(result.captures[cHash]).toBeDefined();
  expect(result.captures[bHash].currentRevision).toBe(before.captures[bHash].currentRevision);
  expect(result.attempts[tx.revision.identity]).toBeUndefined();
  expect(result.blocks[bHash]).toMatchObject({ incomingRevision: tx.revision.id });
  expect(result.blocks[bHash].outputHold?.committed).toBe(false);
  expect(await readOptional(shared)).toBeNull();
  expect(await readOptional(pending)).toBeNull();
  expect(await fs.readFile(held)).toEqual(raw);
  expect(await identity(held)).toEqual(journalIdentity);
  expect(await fs.readFile(existing)).toEqual(editedBytes);
  expect(await identity(existing)).toEqual(editedIdentity);
  expect(await fs.readFile(reserved)).toEqual(reservedBytes);
  expect(await identity(reserved)).toEqual(reservedIdentity);
  expect(result.sourceAuthority[id]).toEqual(authority);
  expect(result.suppressed).toContain(sourceHash);
  expect(await fs.readFile(selected)).toEqual(selectedBytes);
  expect(await identity(selected)).toEqual(selectedIdentity);
});

for (const replaceBackup of [false, true]) {
  test(`deferred capture stage loss ${replaceBackup ? 'does not adopt an unproved backup' : 'restores the exact previous capture for ordinary repair'}`, async ({}, testInfo) => {
    const context = await fixtureForLaterClaim(testInfo);
    const { vault, intake, producer, sourceHash, id, before, authority, bHash, cHash, reserved, existing,
      existingBytes, existingIdentity, selected, selectedBytes, selectedIdentity, shared } = context;
    const reservedBytes = await fs.readFile(reserved), reservedIdentity = await identity(reserved);
    const deferring = new Intake(new Vault(vault.vault, 'Companion', { checkpoint: async name => {
      if (name === 'intake-before-move') throw Object.assign(Error('Fixture capture is busy.'), { code: 'EACCES' });
    } }));
    const deferred = await deferring.reconcile({ now: later });
    const pending = path.join(intake.dir, deferred.pending[bHash].journal), raw = await fs.readFile(pending), tx = JSON.parse(raw);
    const journalIdentity = await identity(pending), backup = path.join(intake.dir, tx.backup);
    const stage = path.join(intake.dir, tx.revision.id + '.stage'), displacedStage = testInfo.outputPath('original-incoming-stage.md');
    const displacedBackup = testInfo.outputPath('original-prior-capture.md');
    expect(tx.sourceHash).toBe(bHash);
    await writeDraft(producer, 'new-independent', '4', 'd');
    let fault;
    const restarted = new Intake(new Vault(vault.vault, 'Companion', { checkpoint: async name => {
      if (name !== 'intake-capture-staged' || fault || (await readJson(shared)).sourceHash !== bHash) return;
      expect(await readOptional(existing)).toBeNull();
      expect(await fs.readFile(backup)).toEqual(existingBytes);
      expect(await identity(backup)).toEqual(existingIdentity);
      await fs.rename(stage, displacedStage);
      if (replaceBackup) {
        await fs.rename(backup, displacedBackup);
        await fs.writeFile(backup, existingBytes, { flag: 'wx' });
      }
      fault = { backupIdentity: await identity(backup), stageIdentity: await identity(displacedStage) };
    } }));
    const result = await restarted.reconcile({ now: later });
    expect(fault, 'the old capture had already moved when the exact new stage disappeared').toBeDefined();
    expect(result.captures[cHash]).toBeDefined();
    expect(result.captures[bHash].currentRevision).toBe(before.captures[bHash].currentRevision);
    expect(result.attempts[tx.revision.identity]).toBeUndefined();
    expect(result.sourceAuthority[id]).toEqual(authority);
    expect(result.suppressed).toContain(sourceHash);
    expect(await fs.readFile(reserved)).toEqual(reservedBytes);
    expect(await identity(reserved)).toEqual(reservedIdentity);
    expect(await fs.readFile(selected)).toEqual(selectedBytes);
    expect(await identity(selected)).toEqual(selectedIdentity);
    expect(await readOptional(shared)).toBeNull();
    expect(await readOptional(pending)).toBeNull();
    const block = result.blocks[bHash], held = path.join(intake.dir, block.journal);
    expect(await fs.readFile(held)).toEqual(raw);
    expect(await identity(held)).toEqual(journalIdentity);
    expect(await fs.readFile(displacedStage, 'utf8')).toBe(tx.content);
    expect(await identity(displacedStage)).toEqual(fault.stageIdentity);
    if (replaceBackup) {
      expect(fault.backupIdentity).not.toEqual(existingIdentity);
      expect(await readOptional(existing)).toBeNull();
      expect(await fs.readFile(backup)).toEqual(existingBytes);
      expect(await identity(backup)).toEqual(fault.backupIdentity);
      expect(await identity(displacedBackup)).toEqual(existingIdentity);
    } else {
      expect.soft(await readOptional(existing)).toEqual(existingBytes);
      if (await readOptional(existing)) expect.soft(await identity(existing)).toEqual(existingIdentity);
      const ordinary = (await restarted.repairs()).find(item => item.sourceHash === bHash);
      expect.soft(ordinary).toMatchObject({ id: before.captures[bHash].id, local: existingBytes.toString('utf8'), incoming: tx.revision.text });
      expect(await fs.readFile(backup)).toEqual(existingBytes);
    }
  });
}

for (const { title, restartAtLink, withHeldRestoration, restoreSnapshot, ordinaryConflict, priorPublicationHold } of [
  { title: 'a new retained-current repair cannot reuse an older deferred conflict witness' },
  { title: 'restart settles a distinct retained-current repair while another restoration is held', restartAtLink: true, withHeldRestoration: true },
  { title: 'a restored snapshot cannot replay a held repair while another restoration is held', restartAtLink: true, withHeldRestoration: true, restoreSnapshot: true },
  { title: 'a restored snapshot cannot replay a held repair in an ordinary vault', restartAtLink: true, restoreSnapshot: true },
  { title: 'restart settles the first held repair from an ordinary conflict', restartAtLink: true, restoreSnapshot: true, ordinaryConflict: true },
  { title: 'restart settles the first held repair from an ordinary conflict while another restoration is held', restartAtLink: true, withHeldRestoration: true, restoreSnapshot: true, ordinaryConflict: true },
  { title: 'restart settles a held repair from a precommit publication hold without replay', restartAtLink: true, withHeldRestoration: true, restoreSnapshot: true, priorPublicationHold: true }
]) test(title, async ({}, testInfo) => {
  const directory = testInfo.outputPath('vault'), reviewRoot = testInfo.outputPath('reviews'), draftRoot = testInfo.outputPath('drafts');
  await fs.mkdir(directory, { recursive: true });
  await fs.mkdir(draftRoot, { recursive: true });
  await fs.cp(path.join(__dirname, 'fixtures/reel-review/accept'), path.join(reviewRoot, 'accept'), { recursive: true });
  const hash = bytes => createHash('sha256').update(bytes).digest('hex');
  let defer = false, interruptRepair = false, observeIncoming = false, snapshot, movedIntent, incomingReplacement;
  const restorationInterruption = Error('Stopped after independent restoration publication.');
  const displaced = testInfo.outputPath('original-current-snapshot.json');
  const vault = new Vault(await fs.realpath(directory), 'Companion', { checkpoint: async boundary => {
    if (defer && boundary === 'intake-before-move') throw Object.assign(Error('Fixture capture is busy.'), { code: 'EACCES' });
    if (withHeldRestoration && boundary === 'capture-restoration-published') throw restorationInterruption;
    if (observeIncoming && !incomingReplacement && boundary === 'intake-published') {
      const tx = await readJson(shared);
      expect(tx.sourceHash).toBe(sourceHash);
      expect(tx.retainOnly).toBe(true);
      const file = path.join(vault.root, 'Revisions', tx.revision.id + '.json');
      const stage = path.join(intake.dir, tx.revision.id + '.snapshot.stage');
      const bytes = await fs.readFile(file), original = await identity(file);
      expect(await identity(stage)).toEqual(original);
      expect((await fs.lstat(file, { bigint: true })).nlink).toBe(2n);
      const displacedIncoming = testInfo.outputPath('original-unaccepted-incoming-snapshot.json');
      await fs.rename(file, displacedIncoming);
      await fs.writeFile(file, bytes, { flag: 'wx' });
      incomingReplacement = { file, bytes, original, displaced: displacedIncoming, replacement: await identity(file) };
    }
    if (interruptRepair && boundary === 'repair-intent-published') {
      movedIntent = await readJson(path.join(intake.dir, 'repair-intent.json'));
      await fs.rename(snapshot, displaced);
    }
  } });
  await vault.setup();
  const intake = new Intake(vault), ledgerFile = path.join(intake.dir, 'ledger.json'), shared = path.join(intake.dir, 'transaction.json');
  const initial = await intake.connect(reviewRoot, true, now, 'review');
  expect(initial.lastCheck.status).toBe('complete');
  const [sourceHash, capture] = Object.entries(initial.captures)[0];
  expect(capture.reviewed).toBe(true);
  const destination = intake.destination(capture);
  snapshot = path.join(vault.root, 'Revisions', capture.currentRevision + '.json');
  const snapshotBytes = await fs.readFile(snapshot), snapshotIdentity = await identity(snapshot);
  await intake.connect(draftRoot, false, now);
  let heldRestoration;
  if (withHeldRestoration) {
    const aHash = 'e'.repeat(64), folder = await writeDraft(draftRoot, 'held-restoration-source', '8', 'e');
    const accepted = await intake.reconcile({ now: later }), a = accepted.captures[aHash];
    const getVault = () => vault, clock = () => ({ now: later });
    const conversations = new Conversations({ dataRoot: testInfo.outputPath('history'), getVault, clock });
    await conversations.lock(async () => {});
    const deletion = new CaptureDeletion({ getVault, conversations, clock, clearApprovals() {} });
    const preview = await deletion.preview(a.id);
    await deletion.confirm(preview.token);
    const selected = await deletion.previewRestoration({ id: a.id, kind: 'draft', folder });
    await expect(deletion.confirmRestoration(selected.token)).rejects.toThrow(restorationInterruption.message);
    const ledger = await readJson(ledgerFile), authority = ledger.sourceAuthority[a.id];
    const file = intake.destination(ledger.captures[aHash]), journal = path.join(intake.dir, authority.restoration.journal);
    await fs.rename(file, testInfo.outputPath('original-held-restoration.md'));
    const replacement = Buffer.from('Independent writing at the held restoration path.\n');
    await fs.writeFile(file, replacement, { flag: 'wx' });
    heldRestoration = {
      aHash, id: a.id, authority, file, replacement, fileIdentity: await identity(file),
      journal, journalBytes: await fs.readFile(journal), journalIdentity: await identity(journal)
    };
  }
  if (!priorPublicationHold) await fs.appendFile(destination, '\nIndependent writing before the first transfer.\n');
  const firstLocal = await fs.readFile(destination);
  await fs.cp(path.join(__dirname, 'fixtures/reel-review/edit'), path.join(reviewRoot, 'edit'), { recursive: true });
  observeIncoming = !!priorPublicationHold;
  const firstHold = await intake.reconcile({ now: later });
  observeIncoming = false;
  const firstBlock = firstHold.blocks[sourceHash], firstArchive = path.join(intake.dir, firstBlock.journal);
  const firstTx = await readJson(firstArchive);
  expect(firstTx.retainOnly).toBe(true);
  let older = firstBlock, priorResolution = firstTx.resolution, olderIdentity = await identity(firstArchive);
  if (ordinaryConflict) {
    expect(older.outputHold).toBeUndefined();
    expect(older.journal).toBe(`conflict-${firstTx.revision.id}.json`);
  } else if (priorPublicationHold) {
    expect(incomingReplacement, 'the retained-only snapshot was replaced before ledger acceptance').toBeDefined();
    expect(older.reason).toMatch(/^Published intake output or recovery evidence changed\./);
    expect(older.outputHold).toMatchObject({ committed: false });
    expect(older.outputHold.mode).toBeUndefined();
    expect(firstHold.attempts[firstTx.revision.identity]).toBeUndefined();
    expect(firstHold.captures[sourceHash].currentRevision).toBe(capture.currentRevision);
    expect(incomingReplacement.replacement).not.toEqual(incomingReplacement.original);
    await fs.appendFile(destination, '\nIndependent writing before the first transfer.\n');
  } else {
    const firstWriting = 'Preserve the first local writing.';
    defer = true;
    await expect(intake.resolveConflict({ sourceHash, text: firstWriting, localHash: hash(firstLocal) }, later)).rejects.toThrow(/annotation preserved/i);
    defer = false;
    const waiting = await readJson(ledgerFile), pending = path.join(intake.dir, waiting.pending[sourceHash].journal);
    const pendingTx = await readJson(pending);
    olderIdentity = await identity(pending);
    priorResolution = pendingTx.resolution;
    expect(pendingTx.keptCurrent.id).toBe(capture.currentRevision);
    await fs.appendFile(destination, '\nIndependent writing during the deferred repair.\n');
    const deferredHold = await intake.reconcile({ now: later });
    older = deferredHold.blocks[sourceHash];
    expect(older.outputHold).toMatchObject({ mode: 'precommit-conflict', committed: false });
    expect(await readOptional(pending)).toBeNull();
  }
  const local = await fs.readFile(destination), localIdentity = await identity(destination);
  const olderArchive = path.join(intake.dir, older.journal), olderBytes = await fs.readFile(olderArchive);
  expect(await identity(olderArchive)).toEqual(olderIdentity);
  expect(await readOptional(shared)).toBeNull();

  const retryWriting = 'Preserve the second local writing.';
  const input = { sourceHash, text: retryWriting, localHash: hash(local) };
  const intentFile = path.join(intake.dir, 'repair-intent.json');
  let refusal, activeJournalIdentity;
  if (restartAtLink) {
    await stopChildIntake(vault.vault, 'held-repair-source-journal', '', shared, { input, snapshot, displaced, priorResolution });
    movedIntent = await readJson(intentFile);
    const retained = path.join(intake.dir, `repair-${movedIntent.annotationId}.json`);
    expect(await fs.readFile(retained)).toEqual(await fs.readFile(intentFile));
    expect(await identity(retained)).toEqual(await identity(intentFile));
    expect((await fs.lstat(intentFile, { bigint: true })).nlink).toBe(2n);
    expect(await readJson(shared)).toEqual(movedIntent.tx);
    expect((await fs.lstat(shared, { bigint: true })).nlink).toBe(1n);
    activeJournalIdentity = await identity(shared);
    expect((await readJson(ledgerFile)).blocks[sourceHash]).toEqual(older);
    if (restoreSnapshot) {
      expect(await readOptional(snapshot)).toBeNull();
      await fs.rename(displaced, snapshot);
      expect(await fs.readFile(snapshot)).toEqual(snapshotBytes);
      expect(await identity(snapshot)).toEqual(snapshotIdentity);
    }
  } else {
    interruptRepair = true;
    try { await intake.resolveConflict(input, later); }
    catch (error) { refusal = error; }
    expect.soft(refusal?.message).toMatch(/annotation preserved.*paused for repair/i);
    expect.soft(await readOptional(shared)).toBeNull();
    expect.soft(await readOptional(intentFile)).toBeNull();
  }
  expect(movedIntent, 'the new repair intent existed before its current reviewed snapshot was removed').toBeDefined();
  expect(movedIntent.tx.resolution).not.toBe(priorResolution);
  await writeDraft(draftRoot, 'independent', '4', 'd');
  const restarted = new Intake(new Vault(vault.vault, 'Companion'));
  const result = await restarted.reconcile({ now: later });
  expect(result.captures['d'.repeat(64)]).toBeDefined();
  const next = result.blocks[sourceHash];
  if (restoreSnapshot) {
    const annotations = path.join(vault.root, 'Annotations');
    const names = (await fs.readdir(annotations)).filter(name => name.endsWith('.md'));
    expect.soft(names).toHaveLength(ordinaryConflict || priorPublicationHold ? 0 : 1);
    expect.soft((await Promise.all(names.map(name => fs.readFile(path.join(annotations, name), 'utf8')))).join('\n')).not.toContain(retryWriting);
    expect.soft(await fs.readFile(destination)).toEqual(local);
    expect.soft(result.attempts[movedIntent.tx.revision.identity]).toBeUndefined();
  }
  expect(next, 'durable hold remains until a new explicit repair').toBeDefined();
  const newArchive = path.join(intake.dir, next.journal);
  expect(next.journal).not.toBe(older.journal);
  expect(await readJson(newArchive)).toEqual(movedIntent.tx);
  if (activeJournalIdentity) expect(await identity(newArchive)).toEqual(activeJournalIdentity);
  expect(await readOptional(shared)).toBeNull();
  expect(await readOptional(intentFile)).toBeNull();
  expect(await fs.readFile(olderArchive)).toEqual(olderBytes);
  expect(await identity(olderArchive)).toEqual(olderIdentity);
  const intentArchive = await readJson(path.join(intake.dir, `repair-${movedIntent.annotationId}.json`));
  expect(intentArchive).toEqual(movedIntent);
  expect(intentArchive.annotation).toContain(retryWriting);
  expect(result.captures[sourceHash].currentRevision).toBe(capture.currentRevision);
  expect(result.attempts[movedIntent.tx.revision.identity]).toBeUndefined();
  if (restoreSnapshot) {
    expect(await readOptional(displaced)).toBeNull();
    expect(await fs.readFile(snapshot)).toEqual(snapshotBytes);
    expect(await identity(snapshot)).toEqual(snapshotIdentity);
    const repair = (await restarted.repairs()).find(item => item.sourceHash === sourceHash);
    expect(repair).toMatchObject({ id: capture.id, local: local.toString('utf8'), incomingRevision: movedIntent.tx.revision.id });
  } else {
    expect(await readOptional(snapshot)).toBeNull();
    expect(await fs.readFile(displaced)).toEqual(snapshotBytes);
    expect(await identity(displaced)).toEqual(snapshotIdentity);
  }
  expect(await fs.readFile(destination)).toEqual(local);
  expect(await identity(destination)).toEqual(localIdentity);
  if (incomingReplacement) {
    const { file, bytes, original, displaced, replacement } = incomingReplacement;
    expect(await fs.readFile(file)).toEqual(bytes);
    expect(await identity(file)).toEqual(replacement);
    expect(await fs.readFile(displaced)).toEqual(bytes);
    expect(await identity(displaced)).toEqual(original);
  }
  if (heldRestoration) {
    const { aHash, id, authority, file, replacement, fileIdentity, journal, journalBytes, journalIdentity } = heldRestoration;
    expect(result.sourceAuthority[id]).toEqual(authority);
    expect(result.suppressed).toContain(aHash);
    expect(await fs.readFile(file)).toEqual(replacement);
    expect(await identity(file)).toEqual(fileIdentity);
    expect(await fs.readFile(journal)).toEqual(journalBytes);
    expect(await identity(journal)).toEqual(journalIdentity);
  }
});

for (const phase of ['staged ledger', 'committed ledger']) {
  test(`a reserved restoration claim at the ${phase} respects the intake commit boundary`, async ({}, testInfo) => {
    const context = await fixtureForLaterClaim(testInfo);
    const { vault, intake, producer, sourceHash, id, ledgerFile, before, authority, bHash, cHash,
      reserved, existing, existingBytes, selected, selectedBytes, selectedIdentity, shared, displaced } = context;
    await writeDraft(producer, 'new-independent', '4', 'd');
    let observed;
    const replaceReserved = async expectedCommitted => {
      if (observed) return;
      const raw = await fs.readFile(shared), tx = JSON.parse(raw);
      if (tx.sourceHash !== bHash) return;
      const ledger = await readJson(ledgerFile);
      if (expectedCommitted) {
        expect(ledger.attempts[tx.revision.identity]).toMatchObject({ status: 'imported', revision: tx.revision.id });
        expect(ledger.captures[bHash].currentRevision).toBe(tx.revision.id);
      } else {
        expect(ledger.attempts[tx.revision.identity]).toBeUndefined();
        expect(ledger.captures[bHash].currentRevision).toBe(before.captures[bHash].currentRevision);
      }
      const journalIdentity = await identity(shared);
      await fs.rename(reserved, displaced);
      await fs.writeFile(reserved, existingBytes, { flag: 'wx' });
      observed = { tx, raw, journalIdentity, replacementIdentity: await identity(reserved) };
    };
    const open = fs.open;
    if (phase === 'staged ledger') fs.open = async (file, ...args) => {
      const handle = await open(file, ...args);
      if (args[0] !== 'wx' || path.dirname(String(file)) !== intake.dir || !/^ledger-.*\.tmp$/.test(path.basename(String(file)))) return handle;
      const close = handle.close;
      handle.close = async () => {
        await close.call(handle);
        if (observed || !await readOptional(shared)) return;
        const tx = await readJson(shared), staged = await readJson(file);
        if (tx.sourceHash === bHash && staged.attempts[tx.revision.identity]?.revision === tx.revision.id) await replaceReserved(false);
      };
      return handle;
    };
    const restarted = new Intake(new Vault(vault.vault, 'Companion', { checkpoint: async name => {
      if (phase === 'committed ledger' && name === 'intake-ledger') await replaceReserved(true);
    } }));
    let result;
    try { result = await restarted.reconcile({ now: later }); }
    finally { fs.open = open; }
    expect(observed, 'the replacement occurred at the targeted native ledger boundary').toBeDefined();
    const { tx } = observed;
    expect(result.captures[cHash]).toBeDefined();
    expect(result.sourceAuthority[id]).toEqual(authority);
    expect(result.suppressed).toContain(sourceHash);
    expect(await fs.readFile(reserved)).toEqual(existingBytes);
    expect(await identity(reserved)).toEqual(observed.replacementIdentity);
    expect(await fs.readFile(selected)).toEqual(selectedBytes);
    expect(await identity(selected)).toEqual(selectedIdentity);
    expect(await readOptional(shared)).toBeNull();
    expect(await fs.readFile(existing, 'utf8')).toBe(tx.content);
    expect(await fs.readFile(path.join(intake.dir, tx.backup))).toEqual(existingBytes);
    if (phase === 'staged ledger') {
      expect(result.captures[bHash].currentRevision).toBe(before.captures[bHash].currentRevision);
      expect(result.attempts[tx.revision.identity]).toBeUndefined();
      const hold = result.blocks[bHash];
      expect(hold.outputHold?.committed).toBe(false);
      const archived = path.join(intake.dir, hold.journal);
      expect(await fs.readFile(archived)).toEqual(observed.raw);
      expect(await identity(archived)).toEqual(observed.journalIdentity);
    } else {
      expect(result.captures[bHash].currentRevision).toBe(tx.revision.id);
      expect(result.attempts[tx.revision.identity]).toMatchObject({ status: 'imported', revision: tx.revision.id });
      expect.soft(result.outcomes[tx.key]).toMatchObject({ status: 'imported', revision: tx.revision.id });
      expect.soft(result.blocks[bHash]).toBeUndefined();
    }
  });
}

test('restoration hold allows independent import with a foreign active cleanup journal', async ({}, testInfo) => {
  const { vault, intake, producer, id, sourceHash, committed, witness } = await stopAfterActivation(testInfo);
  expect(committed.sourceAuthority[id].restorationCleanup).toBeDefined();
  expect(await fs.readFile(witness.journal)).toEqual(witness.bytes);
  const displaced = testInfo.outputPath('original-selected-journal.json');
  await fs.rename(witness.journal, displaced);
  // A byte-identical copy is still a different file.
  await fs.writeFile(witness.journal, witness.bytes, { flag: 'wx' });
  const replacementIdentity = await identity(witness.journal);
  expect(replacementIdentity).not.toEqual(witness.identity);
  expect(await readOptional(path.join(intake.dir, 'transaction.json'))).toBeNull();
  await writeDraft(producer, 'independent', '2', 'c');

  const restarted = new Intake(new Vault(vault.vault, 'Companion'));
  const result = await restarted.reconcile({ now: later });
  const independent = result.captures['c'.repeat(64)];
  expect(independent).toBeDefined();
  expect(await readOptional(restarted.destination(independent))).not.toBeNull();
  expect((await restarted.info()).captures['c'.repeat(64)]).toMatchObject(independent);
  expect(restarted.vault.warnings.join('\n')).toContain('The selected cleanup journal changed.');
  expect(result.sourceAuthority[id]).toEqual(committed.sourceAuthority[id]);
  expect(result.suppressed).not.toContain(sourceHash);
  expect(result.admissions).toEqual(committed.admissions);
  expect(result.attempts[Object.keys(committed.attempts)[0]]).toEqual(Object.values(committed.attempts)[0]);
  expect(await fs.readFile(witness.journal)).toEqual(witness.bytes);
  expect(await identity(witness.journal)).toEqual(replacementIdentity);
  expect(await identity(displaced)).toEqual(witness.identity);
  expect(await readOptional(path.join(intake.dir, 'transaction.json'))).toBeNull();
});

for (const { output, restart } of [{ output: 'capture', restart: false }, { output: 'snapshot', restart: true }]) {
  test(`imported restoration activation holds a replaced ${output} ${restart ? 'on published restart' : 'in the fresh run'}`, async ({}, testInfo) => {
    const interruption = Error('Stopped after the restoration was marked published.');
    let context, witness;
    context = await fixture(testInfo, async boundary => {
      if (context && boundary === 'intake-ledger') {
        const { id, intake, ledgerFile } = context;
        const ledger = await readJson(ledgerFile);
        const restoration = ledger.sourceAuthority[id]?.restoration;
        if (!restoration || witness || !ledger.admissions[restoration.revision]) return;
        const journal = path.join(intake.dir, restoration.journal);
        witness = { journal, bytes: await fs.readFile(journal), identity: await identity(journal) };
      }
      if (boundary === 'capture-restoration-published' && restart) throw interruption;
    });
    const { vault, intake, deletion, restoration, id, sourceHash, ledgerFile } = context;
    if (restart) {
      await expect(deletion.confirmRestoration(restoration.token)).rejects.toThrow(interruption.message);
      const saved = await readJson(ledgerFile);
      expect(saved.sourceAuthority[id]).toMatchObject({ phase: 'restoring', restoration: { published: true } });
      expect(saved.suppressed).toContain(sourceHash);
    }
    const open = fs.open;
    let replacement;
    fs.open = async (file, ...args) => {
      const handle = await open(file, ...args);
      if (args[0] !== 'wx' || path.dirname(String(file)) !== intake.dir || !/^ledger-.*\.tmp$/.test(path.basename(String(file)))) return handle;
      const close = handle.close;
      handle.close = async () => {
        await close.call(handle);
        const staged = await readJson(file);
        if (staged.sourceAuthority?.[id]?.phase !== 'active' || replacement) return;
        const before = await readJson(ledgerFile);
        expect(before.sourceAuthority[id]).toMatchObject({ phase: 'restoring', restoration: { published: true } });
        expect(before.suppressed).toContain(sourceHash);
        const revision = before.sourceAuthority[id].restoration.revision;
        const target = output === 'capture'
          ? intake.destination(before.captures[sourceHash])
          : path.join(vault.root, 'Revisions', revision + '.json');
        const displaced = testInfo.outputPath('displaced-' + output);
        const bytes = await fs.readFile(target), original = await identity(target);
        await fs.rename(target, displaced);
        await fs.writeFile(target, bytes, { flag: 'wx' });
        const foreign = await identity(target);
        expect(foreign).not.toEqual(original);
        replacement = { before, target, displaced, bytes, original, foreign };
      };
      return handle;
    };
    let failure, restarted;
    try {
      if (restart) {
        restarted = new Intake(new Vault(vault.vault, 'Companion'));
        await restarted.info();
      }
      else await deletion.confirmRestoration(restoration.token);
    } catch (error) { failure = error; }
    finally { fs.open = open; }

    expect(replacement, 'the staged active ledger reached its last awaited write boundary').toBeDefined();
    expect(witness, 'the selected journal was present at restoration admission').toBeDefined();
    const after = await readJson(ledgerFile);
    if (restart) {
      expect.soft(failure).toBeUndefined();
      expect.soft(restarted.vault.warnings.join('\n')).toContain('A published restoration output changed.');
    } else expect.soft(failure?.message).toMatch(/changed|preserv|remain/i);
    expect.soft(after.sourceAuthority[id]).toMatchObject({ phase: 'restoring', restoration: { published: true } });
    expect.soft(after.suppressed).toContain(sourceHash);
    expect(after.admissions).toEqual(replacement.before.admissions);
    expect(after.attempts).toEqual(replacement.before.attempts);
    expect(await fs.readFile(replacement.target)).toEqual(replacement.bytes);
    expect(await identity(replacement.target)).toEqual(replacement.foreign);
    expect(await fs.readFile(replacement.displaced)).toEqual(replacement.bytes);
    expect(await identity(replacement.displaced)).toEqual(replacement.original);
    const journal = await readOptional(witness.journal);
    expect.soft(journal).toEqual(witness.bytes);
    if (journal) expect(await identity(witness.journal)).toEqual(witness.identity);
  });
}
