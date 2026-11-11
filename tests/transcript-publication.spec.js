const { test, expect } = require('@playwright/test');
const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { Transcripts } = require('../app/transcripts');
const { pureWritingPending } = require('../app/deletion-dependents');

const identity = stat => [stat.dev, stat.ino];
const absent = file => fs.lstat(file).catch(error => error.code);
const read = file => fs.readFile(file, 'utf8');

async function transcriptFixture(testInfo, checkpoint) {
  const vaultPath = testInfo.outputPath('vault');
  await fs.mkdir(vaultPath, { recursive: true });
  const vault = { vault: await fs.realpath(vaultPath) };
  vault.root = path.join(vault.vault, 'Companion');
  await fs.mkdir(vault.root);
  const destination = path.join(vault.vault, 'Published transcript.md');
  const directory = path.join(vault.root, '.transcripts');
  const record = {
    id: randomUUID(), vault: { root: vault.root }, brief: { id: randomUUID(), version: 1, digest: 'a'.repeat(64) },
    requests: [{
      id: randomUUID(), status: 'completed', question: 'Retained question', reply: 'Retained reply',
      package: { digest: 'b'.repeat(64), text: 'Reviewed context', dependencies: [], historyRefs: [], historyIds: [] }
    }]
  };
  const text = JSON.stringify(record);
  const createStore = hook => new Transcripts({
    conversations: {
      unsaved: new Set(), readStored: async () => ({ record, text }),
      historyResolver: () => async () => {}, lock: work => work()
    },
    getVault: () => vault,
    getContext: async () => ({ corpus: async () => ({ all: [] }) }),
    clock: () => ({ now: '2026-11-08T12:00:00Z' }),
    checkpoint: hook ?? (async () => {}),
    choose: async () => destination
  });
  const store = createStore(checkpoint);
  const preview = await store.preview({ conversationId: record.id });
  return { vault, destination, directory, store, preview, createStore };
}

async function interruptedTranscript(testInfo, boundary) {
  const fixture = await transcriptFixture(testInfo, async current => {
    if (current === boundary) throw Error('Controlled interruption');
  });
  await expect(fixture.store.confirm(fixture.preview.token)).rejects.toThrow('Controlled interruption');
  const name = (await fs.readdir(fixture.directory)).find(name => name.endsWith('.intent.json'));
  const journal = path.join(fixture.directory, name), journalBytes = await read(journal);
  const intent = JSON.parse(journalBytes);
  const stage = path.join(fixture.directory, `${intent.operation}.md.pending`);
  const receipt = path.join(fixture.directory, `${intent.operation}.published.json`);
  const original = await fs.lstat(stage, { bigint: true });
  expect(original.nlink).toBe(2n);
  expect(identity(await fs.lstat(fixture.destination, { bigint: true }))).toEqual(identity(original));
  return { ...fixture, intent, journal, journalBytes, stage, receipt, original };
}

test('transcript cleanup preserves independent stage writing introduced during the removal fence', async ({}, testInfo) => {
  let afterReceipt = false;
  const { vault, destination, directory, store, preview } = await transcriptFixture(testInfo, async boundary => {
    if (boundary === 'transcript-after-receipt') afterReceipt = true;
  });
  const retained = path.join(vault.vault, 'Retained exact stage.md');
  const foreign = '# Independent stage writing\n';
  const actualFence = store.removal.fence.bind(store.removal);
  let fencesAfterReceipt = 0, swap;
  store.removal.fence = async (intent, currentVault) => {
    await actualFence(intent, currentVault);
    if (!afterReceipt || ++fencesAfterReceipt !== 2) return;
    const stage = path.join(directory, `${intent.operation}.md.pending`);
    const receipt = path.join(directory, `${intent.operation}.published.json`);
    const journal = path.join(directory, `${intent.operation}.intent.json`);
    const original = await fs.lstat(stage, { bigint: true });
    expect(original.nlink).toBe(2n);
    expect(identity(await fs.lstat(destination, { bigint: true }))).toEqual(identity(original));
    const receiptBytes = await fs.readFile(receipt, 'utf8'), journalBytes = await fs.readFile(journal, 'utf8');
    await fs.rename(stage, retained);
    await fs.writeFile(stage, foreign, { flag: 'wx' });
    const replacement = await fs.lstat(stage, { bigint: true });
    expect(identity(replacement)).not.toEqual(identity(original));
    swap = { stage, receipt, journal, original, replacement, receiptBytes, journalBytes };
  };

  const outcome = await store.confirm(preview.token).then(result => ({ result }), error => ({ error: error.message }));
  expect(swap, 'the actual cleanup fence was reached after receipt publication').toBeDefined();
  expect.soft(outcome.error).toMatch(/identity|changed|preserve|linked/i);
  expect.soft(await fs.readFile(swap.stage, 'utf8').catch(error => error.code)).toBe(foreign);
  const stageStat = await fs.lstat(swap.stage, { bigint: true }).catch(error => error.code);
  expect.soft(identity(stageStat)).toEqual(identity(swap.replacement));
  expect(identity(await fs.lstat(destination, { bigint: true }))).toEqual(identity(swap.original));
  expect(identity(await fs.lstat(retained, { bigint: true }))).toEqual(identity(swap.original));
  expect(await fs.readFile(destination, 'utf8')).toBe(preview.text);
  expect(await fs.readFile(retained, 'utf8')).toBe(preview.text);
  expect(await fs.readFile(swap.receipt, 'utf8')).toBe(swap.receiptBytes);
  expect(await fs.readFile(swap.journal, 'utf8')).toBe(swap.journalBytes);
});

test('transcript published resume never recreates a destination lost after review', async ({}, testInfo) => {
  const fixture = await interruptedTranscript(testInfo, 'transcript-after-link');
  const { destination, intent, stage, receipt, original, journal, journalBytes, preview } = fixture;
  expect(await absent(receipt)).toBe('ENOENT');
  const restarted = fixture.createStore();
  const resumed = await restarted.resume(intent.operation);
  expect(resumed.text).toBe(preview.text);
  await fs.unlink(destination);
  expect((await fs.lstat(stage)).nlink).toBe(1);

  await expect.soft(restarted.confirm(resumed.token)).rejects.toThrow(/published|identity|changed|preserve|missing/i);
  expect.soft(await absent(destination)).toBe('ENOENT');
  expect.soft(await absent(receipt)).toBe('ENOENT');
  expect.soft(await read(stage).catch(error => error.code)).toBe(preview.text);
  const staged = await fs.lstat(stage, { bigint: true }).catch(error => error.code);
  expect.soft(identity(staged)).toEqual(identity(original));
  expect(await read(journal)).toBe(journalBytes);
});

test('transcript restart holds an unreceipted publication whose destination disappeared before review', async ({}, testInfo) => {
  const fixture = await interruptedTranscript(testInfo, 'transcript-after-link');
  const { destination, intent, stage, receipt, original, journal, journalBytes, preview } = fixture;
  expect(await absent(receipt)).toBe('ENOENT');
  await fs.unlink(destination);
  expect((await fs.lstat(stage)).nlink).toBe(1);

  const restarted = fixture.createStore();
  const pending = await restarted.pending();
  expect.soft(pending.records).toContainEqual(expect.objectContaining({
    operation: intent.operation, destination, text: preview.text, canResume: false
  }));
  const outcome = await restarted.resume(intent.operation).then(result => ({ result }), error => ({ error: error.message }));
  expect.soft(outcome).toMatchObject({ error: expect.stringMatching(/published|identity|changed|preserve|missing/i) });
  if (outcome.result) await restarted.confirm(outcome.result.token);
  expect.soft(await absent(destination)).toBe('ENOENT');
  expect.soft(await absent(receipt)).toBe('ENOENT');
  expect.soft(await read(stage).catch(error => error.code)).toBe(preview.text);
  const staged = await fs.lstat(stage, { bigint: true }).catch(error => error.code);
  expect.soft(identity(staged)).toEqual(identity(original));
  expect(await read(journal)).toBe(journalBytes);
});

for (const state of ['missing', 'replaced', 'exact']) {
  test(`transcript receipt without its stage reports only an exact existing destination: ${state}`, async ({}, testInfo) => {
    const fixture = await interruptedTranscript(testInfo, 'transcript-after-receipt');
    const { vault, destination, intent, stage, receipt, original, journal, journalBytes, preview } = fixture;
    const receiptBytes = await read(receipt);
    const restarted = fixture.createStore();
    const resumed = await restarted.resume(intent.operation);
    await fs.unlink(stage);
    const retained = path.join(vault.vault, 'Retained published transcript.md');
    let replacement;
    if (state === 'missing') await fs.unlink(destination);
    if (state === 'replaced') {
      await fs.rename(destination, retained);
      await fs.writeFile(destination, preview.text, { flag: 'wx' });
      replacement = await fs.lstat(destination, { bigint: true });
      expect(identity(replacement)).not.toEqual(identity(original));
    }

    const confirmation = restarted.confirm(resumed.token);
    if (state === 'exact') await expect(confirmation).resolves.toEqual({ destination, completed: true });
    else await expect.soft(confirmation).rejects.toThrow(/published|identity|changed|preserve|missing|ENOENT/i);
    expect(await absent(stage)).toBe('ENOENT');
    expect(await read(receipt)).toBe(receiptBytes);
    expect(await read(journal)).toBe(journalBytes);
    if (state === 'missing') expect(await absent(destination)).toBe('ENOENT');
    else {
      expect(await read(destination)).toBe(preview.text);
      expect(identity(await fs.lstat(destination, { bigint: true }))).toEqual(identity(replacement || original));
    }
    if (state === 'replaced') {
      expect(await read(retained)).toBe(preview.text);
      expect(identity(await fs.lstat(retained, { bigint: true }))).toEqual(identity(original));
    }
  });
}

test('source deletion preserves legacy pending transcript writing proved by its exact receipt', async ({}, testInfo) => {
  const { vault, destination, intent, stage, receipt, original, journal, preview } = await interruptedTranscript(testInfo, 'transcript-after-receipt');
  delete intent.stageProof;
  const legacy = JSON.stringify(intent, null, 2), receiptBytes = await read(receipt);
  await fs.writeFile(journal, legacy);
  const recognized = await pureWritingPending(vault, stage).catch(error => error.message);
  expect.soft(recognized).toBe(true);
  expect(await read(journal)).toBe(legacy);
  expect(await read(receipt)).toBe(receiptBytes);
  expect(await read(stage)).toBe(preview.text);
  expect(await read(destination)).toBe(preview.text);
  expect(identity(await fs.lstat(stage, { bigint: true }))).toEqual(identity(original));
  expect(identity(await fs.lstat(destination, { bigint: true }))).toEqual(identity(original));

  const oldStage = path.join(vault.vault, 'Retained original stage.md');
  const oldDestination = path.join(vault.vault, 'Retained original output.md');
  await fs.rename(stage, oldStage);
  await fs.rename(destination, oldDestination);
  await fs.writeFile(stage, preview.text, { flag: 'wx' });
  await fs.link(stage, destination);
  expect(identity(await fs.lstat(stage, { bigint: true }))).not.toEqual(identity(original));
  expect(await pureWritingPending(vault, stage).catch(() => false)).toBe(false);
  expect(await read(oldStage)).toBe(preview.text);
  expect(await read(oldDestination)).toBe(preview.text);
  expect(await read(stage)).toBe(preview.text);
  expect(await read(destination)).toBe(preview.text);
  expect(await read(receipt)).toBe(receiptBytes);
});

for (const change of ['equal-byte replacement', 'unchanged target']) {
  test(`transcript removal rechecks the selected target after its final guarded read: ${change}`, async ({}, testInfo) => {
    let armed = false, unlinks = 0;
    const { store, preview, vault, directory, destination } = await transcriptFixture(testInfo, async boundary => {
      if (boundary === 'transcript-remove-after-tombstone') armed = true;
      if (boundary === 'transcript-remove-after-unlink') unlinks++;
    });
    await store.confirm(preview.token);
    const name = (await fs.readdir(directory)).find(name => name.endsWith('.intent.json'));
    const target = path.join(directory, name), bytes = await fs.readFile(target);
    const { operation, id } = JSON.parse(bytes.toString('utf8'));
    const receipt = path.join(directory, `${operation}.published.json`), receiptBytes = await read(receipt);
    const marker = path.join(directory, `${id}.removed.json`);
    const retained = path.join(vault.vault, 'Retained original transcript intent.json');
    const original = await fs.lstat(target, { bigint: true });
    const output = await fs.lstat(destination, { bigint: true });
    const review = await store.removal.preview(operation);
    expect(review.files[0]).toBe(target);
    expect(await absent(marker)).toBe('ENOENT');

    const open = fs.open;
    let reads = 0, markerBytes, replacement;
    fs.open = async (file, ...args) => {
      const handle = await open(file, ...args);
      if (!armed || file !== target || args[0] !== 'r' || ++reads !== 3) return handle;
      // The third read is the final target check after both remaining-scope reads.
      const close = handle.close.bind(handle);
      handle.close = async () => {
        await close();
        markerBytes = await read(marker);
        if (change === 'unchanged target') return;
        await fs.rename(target, retained);
        await fs.writeFile(target, bytes, { flag: 'wx' });
        replacement = await fs.lstat(target, { bigint: true });
        expect(identity(replacement)).not.toEqual(identity(original));
      };
      return handle;
    };
    let outcome;
    try {
      outcome = await store.removal.confirm(review.token).then(result => ({ result }), error => ({ error: error.message }));
    } finally { fs.open = open; }
    expect(markerBytes, 'the real final guarded target handle was closed').toBeTruthy();
    expect(await read(marker)).toBe(markerBytes);
    expect(JSON.parse(markerBytes)).toMatchObject({ id, exportOperation: operation });
    if (change === 'unchanged target') {
      expect(outcome).toEqual({ result: { id, destination, completed: true } });
      expect(unlinks).toBe(review.files.length);
      for (const file of review.files) expect(await absent(file)).toBe('ENOENT');
    } else {
      expect(replacement, 'the original and replacement are distinct files').toBeDefined();
      expect.soft(outcome).toMatchObject({ error: expect.stringMatching(/identity|changed|scope|preserve/i) });
      expect.soft(unlinks).toBe(0);
      expect.soft(await fs.readFile(target).catch(error => error.code)).toEqual(bytes);
      expect.soft(identity(await fs.lstat(target, { bigint: true }).catch(error => error.code))).toEqual(identity(replacement));
      expect.soft(await read(receipt).catch(error => error.code)).toBe(receiptBytes);
      expect.soft(await read(destination).catch(error => error.code)).toBe(preview.text);
      expect.soft(identity(await fs.lstat(destination, { bigint: true }).catch(error => error.code))).toEqual(identity(output));
      expect(await fs.readFile(retained)).toEqual(bytes);
      expect(identity(await fs.lstat(retained, { bigint: true }))).toEqual(identity(original));
    }
  });
}
