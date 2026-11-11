const { test, expect } = require('@playwright/test');
const fs = require('node:fs/promises');
const native = require('node:fs');
const path = require('node:path');
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

async function fixture(testInfo, checkpoint) {
  const vaultDirectory = testInfo.outputPath('vault');
  const producer = testInfo.outputPath('producer');
  const folder = await writeDraft(producer, 'draft', '1', 'a');
  await fs.mkdir(vaultDirectory, { recursive: true });
  const vault = new Vault(await fs.realpath(vaultDirectory), 'Companion', { checkpoint });
  await vault.setup();
  const intake = new Intake(vault);
  const accepted = await intake.connect(producer, true, now);
  expect(accepted.lastCheck.status).toBe('complete');
  const [sourceHash, capture] = Object.entries(accepted.captures)[0];
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
  const independent = result.captures['c'.repeat(64)];
  expect(independent).toBeDefined();
  expect(await readOptional(restarted.destination(independent))).not.toBeNull();
  expect((await restarted.info()).captures['c'.repeat(64)]).toEqual(independent);
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
  expect((await restarted.info()).captures['c'.repeat(64)]).toEqual(independent);
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
    let failure;
    try {
      if (restart) await new Intake(new Vault(vault.vault, 'Companion')).info();
      else await deletion.confirmRestoration(restoration.token);
    } catch (error) { failure = error; }
    finally { fs.open = open; }

    expect(replacement, 'the staged active ledger reached its last awaited write boundary').toBeDefined();
    expect(witness, 'the selected journal was present at restoration admission').toBeDefined();
    const after = await readJson(ledgerFile);
    expect.soft(failure?.message).toMatch(/changed|preserv|remain/i);
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
