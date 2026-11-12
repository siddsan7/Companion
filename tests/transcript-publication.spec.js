const { test, expect } = require('@playwright/test');
const fs = require('node:fs/promises');
const local = require('node:fs');
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
  const attempt = path.join(fixture.directory, `${intent.operation}.link.json`);
  const original = await fs.lstat(stage, { bigint: true });
  expect(original.nlink).toBe(2n);
  expect(identity(await fs.lstat(fixture.destination, { bigint: true }))).toEqual(identity(original));
  return { ...fixture, intent, journal, journalBytes, stage, receipt, attempt, original };
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

test('transcript confirmation preserves a receipt that returns before the first link', async ({}, testInfo) => {
  const fixture = await interruptedTranscript(testInfo, 'transcript-after-receipt');
  const { destination, intent, stage, receipt, attempt, original, journal, journalBytes, preview } = fixture;
  const receiptBytes = await read(receipt);
  // An older interrupted publication could retire its attempt before the stage.
  await fs.unlink(attempt);
  await fs.unlink(destination);
  await fs.unlink(receipt);
  let restoredReceipt;
  const restarted = fixture.createStore(async boundary => {
    if (boundary !== 'transcript-before-publish') return;
    await fs.writeFile(receipt, receiptBytes, { flag: 'wx' });
    restoredReceipt = await fs.lstat(receipt, { bigint: true });
  });
  const resumed = await restarted.resume(intent.operation);

  await expect(restarted.confirm(resumed.token)).rejects.toThrow();
  expect(restoredReceipt).toBeDefined();
  expect.soft(await absent(destination)).toBe('ENOENT');
  expect.soft(await absent(attempt)).toBe('ENOENT');
  expect.soft(await read(stage)).toBe(preview.text);
  expect.soft(identity(await fs.lstat(stage, { bigint: true }))).toEqual(identity(original));
  expect(await read(receipt)).toBe(receiptBytes);
  expect(identity(await fs.lstat(receipt, { bigint: true }))).toEqual(identity(restoredReceipt));
  expect(await read(journal)).toBe(journalBytes);
});

test('transcript restart holds a surviving stage after its published output and receipt disappear', async ({}, testInfo) => {
  const fixture = await interruptedTranscript(testInfo, 'transcript-after-receipt');
  const { destination, intent, stage, receipt, original, journal, journalBytes, preview } = fixture;
  await fs.unlink(destination);
  await fs.unlink(receipt);
  expect((await fs.lstat(stage)).nlink).toBe(1);

  const restarted = fixture.createStore();
  expect.soft((await restarted.pending()).records).toContainEqual(expect.objectContaining({
    operation: intent.operation, destination, text: preview.text, canResume: false
  }));
  const outcome = await restarted.resume(intent.operation).then(result => ({ result }), error => ({ error: error.message }));
  expect.soft(outcome).toMatchObject({ error: expect.stringMatching(/published|identity|changed|preserve|missing/i) });
  if (outcome.result) await restarted.confirm(outcome.result.token);
  expect.soft(await absent(destination)).toBe('ENOENT');
  expect.soft(await absent(receipt)).toBe('ENOENT');
  expect.soft(await read(stage).catch(error => error.code)).toBe(preview.text);
  expect.soft(identity(await fs.lstat(stage, { bigint: true }).catch(error => error.code))).toEqual(identity(original));
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

for (const mode of ['fresh export', 'receipt-backed resume']) {
  test(`transcript confirmation verifies its output after exact stage unlink: ${mode}`, async ({}, testInfo) => {
    const fixture = mode === 'fresh export'
      ? await transcriptFixture(testInfo)
      : await interruptedTranscript(testInfo, 'transcript-after-receipt');
    const { destination, directory, vault, preview } = fixture;
    let { store } = fixture;
    let token = preview.token;
    if (mode === 'receipt-backed resume') {
      store = fixture.createStore();
      token = (await store.resume(fixture.intent.operation)).token;
    }
    const retained = path.join(vault.vault, 'Retained exact transcript.md');
    const unlink = local.unlinkSync;
    let swap;
    local.unlinkSync = file => {
      unlink(file);
      if (path.dirname(file) !== directory || !file.endsWith('.md.pending')) return;
      const operation = path.basename(file, '.md.pending');
      const journal = path.join(directory, `${operation}.intent.json`);
      const receipt = path.join(directory, `${operation}.published.json`);
      const journalBytes = local.readFileSync(journal, 'utf8'), receiptBytes = local.readFileSync(receipt, 'utf8');
      const original = local.lstatSync(destination, { bigint: true });
      expect(original.nlink).toBe(1n);
      const bytes = local.readFileSync(destination);
      expect(bytes.toString('utf8')).toBe(preview.text);
      local.renameSync(destination, retained);
      local.writeFileSync(destination, bytes, { flag: 'wx' });
      const replacement = local.lstatSync(destination, { bigint: true });
      expect(identity(replacement)).not.toEqual(identity(original));
      swap = { stage: file, original, replacement, journal, receipt, journalBytes, receiptBytes };
    };
    let outcome;
    try {
      outcome = await store.confirm(token).then(result => ({ result }), error => ({ error: error.message }));
    } finally { local.unlinkSync = unlink; }

    expect(swap, 'exact cleanup completed before the destination was replaced').toBeDefined();
    expect.soft(outcome).toMatchObject({ error: expect.stringMatching(/identity|changed|preserve|missing/i) });
    expect(await absent(swap.stage)).toBe('ENOENT');
    expect(await read(destination)).toBe(preview.text);
    expect(await read(retained)).toBe(preview.text);
    expect(identity(await fs.lstat(destination, { bigint: true }))).toEqual(identity(swap.replacement));
    expect(identity(await fs.lstat(retained, { bigint: true }))).toEqual(identity(swap.original));
    expect(await read(swap.journal)).toBe(swap.journalBytes);
    expect(await read(swap.receipt)).toBe(swap.receiptBytes);
  });
}

test('transcript confirmation checks one-link content after an in-place edit preserves metadata', async ({}, testInfo) => {
  const stamp = new Date('2025-01-01T00:00:00Z');
  const stampNs = BigInt(stamp.getTime()) * 1000000n;
  let linked, edit;
  const { store, preview, directory, destination } = await transcriptFixture(testInfo, async boundary => {
    if (boundary !== 'transcript-after-link') return;
    await fs.utimes(destination, stamp, stamp);
    linked = await fs.lstat(destination, { bigint: true });
    expect(linked.nlink).toBe(2n);
    expect(linked.mtimeNs).toBe(stampNs);
  });
  const open = fs.open, unlink = local.unlinkSync;
  fs.open = async (file, ...args) => {
    const handle = await open(file, ...args);
    if (path.dirname(file) !== directory || !file.endsWith('.md.pending') || args[0] !== 'wx') return handle;
    const stat = handle.stat.bind(handle);
    // Give the exact stage proof the same restorable mtime as its linked inode.
    handle.stat = async (...options) => {
      await handle.utimes(stamp, stamp);
      await handle.sync();
      return stat(...options);
    };
    return handle;
  };
  const checkedMetadata = stat => [stat.dev, stat.ino, stat.birthtimeNs, stat.mtimeNs, stat.size, stat.nlink];
  local.unlinkSync = file => {
    unlink(file);
    if (path.dirname(file) !== directory || !file.endsWith('.md.pending')) return;
    expect(linked, 'the exact first link was proved').toBeDefined();
    const before = local.lstatSync(destination, { bigint: true });
    expect(checkedMetadata(before)).toEqual([...checkedMetadata(linked).slice(0, -1), 1n]);
    const original = local.readFileSync(destination);
    expect(original.toString('utf8')).toBe(preview.text);
    const edited = Buffer.from(original);
    const position = original.indexOf('Retained question');
    expect(position).toBeGreaterThanOrEqual(0);
    edited[position] = 'X'.charCodeAt(0);
    const handle = local.openSync(destination, 'r+');
    try {
      expect(local.writeSync(handle, edited, position, 1, position)).toBe(1);
      local.fsyncSync(handle);
    } finally { local.closeSync(handle); }
    local.utimesSync(destination, stamp, stamp);
    const after = local.lstatSync(destination, { bigint: true });
    expect(checkedMetadata(after)).toEqual(checkedMetadata(before));
    expect(local.readFileSync(destination)).toEqual(edited);
    const operation = path.basename(file, '.md.pending');
    const receipt = path.join(directory, `${operation}.published.json`);
    const journal = path.join(directory, `${operation}.intent.json`);
    edit = { stage: file, before, edited, receipt, journal, receiptBytes: local.readFileSync(receipt), journalBytes: local.readFileSync(journal) };
  };
  let outcome;
  try {
    outcome = await store.confirm(preview.token).then(result => ({ result }), error => ({ error: error.message }));
  } finally {
    fs.open = open;
    local.unlinkSync = unlink;
  }
  expect(edit, 'the real output was edited after exact stage cleanup').toBeDefined();
  expect.soft(outcome).toMatchObject({ error: expect.stringMatching(/identity|changed|preserve|edited/i) });
  expect(await absent(edit.stage)).toBe('ENOENT');
  expect(await fs.readFile(destination)).toEqual(edit.edited);
  expect(checkedMetadata(await fs.lstat(destination, { bigint: true }))).toEqual(checkedMetadata(edit.before));
  expect(await fs.readFile(edit.receipt)).toEqual(edit.receiptBytes);
  expect(await fs.readFile(edit.journal)).toEqual(edit.journalBytes);
});

for (const state of ['independent replacement', 'unchanged pair']) {
  test(`transcript legacy resume binds the reviewed receipt-backed pair: ${state}`, async ({}, testInfo) => {
    const fixture = await interruptedTranscript(testInfo, 'transcript-after-receipt');
    const { vault, destination, intent, stage, receipt, attempt, original, journal, preview } = fixture;
    delete intent.stageProof;
    const legacy = JSON.stringify(intent, null, 2), originalReceiptBytes = await read(receipt);
    await fs.writeFile(journal, legacy);
    await fs.unlink(attempt);
    const restarted = fixture.createStore();
    const resumed = await restarted.resume(intent.operation);
    expect(resumed.text).toBe(preview.text);
    const confirmation = () => restarted.confirm(resumed.token);
    if (state === 'unchanged pair') {
      await expect(confirmation()).resolves.toEqual({ destination, completed: true });
      expect(await absent(stage)).toBe('ENOENT');
      const output = await fs.lstat(destination, { bigint: true });
      expect(identity(output)).toEqual(identity(original));
      expect(output.nlink).toBe(1n);
      expect(await read(destination)).toBe(preview.text);
      expect(await read(journal)).toBe(legacy);
      expect(await read(receipt)).toBe(originalReceiptBytes);
      return;
    }

    const retainedStage = path.join(vault.vault, 'Retained exact stage.md');
    const retainedOutput = path.join(vault.vault, 'Retained exact output.md');
    const retainedReceipt = path.join(vault.vault, 'Retained exact receipt.json');
    const receiptIdentity = await fs.lstat(receipt, { bigint: true });
    await fs.rename(stage, retainedStage);
    await fs.rename(destination, retainedOutput);
    await fs.rename(receipt, retainedReceipt);
    await fs.writeFile(stage, preview.text, { flag: 'wx' });
    await fs.link(stage, destination);
    const independent = await fs.lstat(stage, { bigint: true });
    expect(identity(independent)).not.toEqual(identity(original));
    const replacementReceipt = JSON.stringify({
      ...JSON.parse(originalReceiptBytes), dev: String(independent.dev), ino: String(independent.ino)
    }, null, 2);
    await fs.writeFile(receipt, replacementReceipt, { flag: 'wx' });
    const independentReceipt = await fs.lstat(receipt, { bigint: true });
    expect(identity(independentReceipt)).not.toEqual(identity(receiptIdentity));

    await expect.soft(confirmation()).rejects.toThrow(/identity|changed|preserve|receipt/i);
    expect.soft(await read(stage).catch(error => error.code)).toBe(preview.text);
    const staged = await fs.lstat(stage, { bigint: true }).catch(error => error.code);
    expect.soft(identity(staged)).toEqual(identity(independent));
    expect.soft(staged.nlink).toBe(2n);
    expect(await read(destination)).toBe(preview.text);
    expect(identity(await fs.lstat(destination, { bigint: true }))).toEqual(identity(independent));
    for (const file of [retainedStage, retainedOutput]) {
      expect(await read(file)).toBe(preview.text);
      expect(identity(await fs.lstat(file, { bigint: true }))).toEqual(identity(original));
    }
    expect(await read(receipt)).toBe(replacementReceipt);
    expect(await read(retainedReceipt)).toBe(originalReceiptBytes);
    expect(identity(await fs.lstat(receipt, { bigint: true }))).toEqual(identity(independentReceipt));
    expect(identity(await fs.lstat(retainedReceipt, { bigint: true }))).toEqual(identity(receiptIdentity));
    expect(await read(journal)).toBe(legacy);
  });
}

test('source deletion preserves legacy pending transcript writing proved by its exact receipt', async ({}, testInfo) => {
  const { vault, destination, intent, stage, receipt, attempt, original, journal, preview } = await interruptedTranscript(testInfo, 'transcript-after-receipt');
  delete intent.stageProof;
  const legacy = JSON.stringify(intent, null, 2), receiptBytes = await read(receipt);
  await fs.writeFile(journal, legacy);
  await fs.unlink(attempt);
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

for (const boundary of ['before authority', 'before first unlink', 'before completion']) {
  test(`transcript removal holds when a missing output returns during verification ${boundary}`, async ({}, testInfo) => {
    let armed = boundary === 'before authority', unlinks = 0;
    const { store, preview, directory, destination } = await transcriptFixture(testInfo, async checkpoint => {
      if (checkpoint === 'transcript-remove-after-tombstone' && boundary === 'before first unlink') armed = true;
      if (checkpoint === 'transcript-remove-after-unlink') unlinks++;
    });
    await store.confirm(preview.token);
    await fs.unlink(destination);
    const name = (await fs.readdir(directory)).find(name => name.endsWith('.intent.json'));
    const journal = path.join(directory, name), journalBytes = await read(journal);
    const { operation, id } = JSON.parse(journalBytes);
    const receipt = path.join(directory, `${operation}.published.json`), receiptBytes = await read(receipt);
    const marker = path.join(directory, `${id}.removed.json`);
    const review = await store.removal.preview(operation);
    expect(review.files).toEqual([journal, receipt]);

    const open = fs.open, lstat = fs.lstat;
    let reads = 0, inserted = false;
    const independent = '# Independent transcript destination writing\n';
    fs.lstat = async (file, ...args) => {
      if (file === destination && boundary === 'before completion' && unlinks === review.files.length) armed = true;
      return lstat(file, ...args);
    };
    fs.open = async (file, ...args) => {
      const handle = await open(file, ...args);
      const observed = boundary === 'before authority' ? receipt : boundary === 'before first unlink' ? journal : marker;
      const readNumber = boundary === 'before first unlink' ? 3 : 1;
      if (!armed || file !== observed || args[0] !== 'r' || ++reads !== readNumber) return handle;
      const close = handle.close.bind(handle);
      handle.close = async () => {
        await close();
        await fs.writeFile(destination, independent, { flag: 'wx' });
        inserted = true;
      };
      return handle;
    };
    let outcome;
    try {
      outcome = await store.removal.confirm(review.token).then(result => ({ result }), error => ({ error: error.message }));
    } finally {
      fs.open = open;
      fs.lstat = lstat;
    }

    expect(inserted, 'independent writing returned after the relevant guarded read').toBe(true);
    expect.soft(outcome).toMatchObject({ error: expect.stringMatching(/identity|changed|scope|preserve/i) });
    expect(await read(destination)).toBe(independent);
    if (boundary === 'before authority') {
      expect.soft(await absent(marker)).toBe('ENOENT');
      expect.soft(await absent(`${marker}.pending`)).toBe('ENOENT');
    } else {
      expect(JSON.parse(await read(marker))).toMatchObject({ id, exportOperation: operation });
    }
    if (boundary === 'before completion') {
      expect(unlinks).toBe(review.files.length);
      expect(await absent(journal)).toBe('ENOENT');
      expect(await absent(receipt)).toBe('ENOENT');
    } else {
      expect.soft(unlinks).toBe(0);
      expect.soft(await read(journal).catch(error => error.code)).toBe(journalBytes);
      expect.soft(await read(receipt).catch(error => error.code)).toBe(receiptBytes);
    }
  });
}
