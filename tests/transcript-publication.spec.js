const { test, expect } = require('@playwright/test');
const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { Transcripts } = require('../app/transcripts');

const identity = stat => [stat.dev, stat.ino];

test('transcript cleanup preserves independent stage writing introduced during the removal fence', async ({}, testInfo) => {
  const vaultPath = testInfo.outputPath('vault');
  await fs.mkdir(vaultPath, { recursive: true });
  const vault = { vault: await fs.realpath(vaultPath) };
  vault.root = path.join(vault.vault, 'Companion');
  await fs.mkdir(vault.root);
  const destination = path.join(vault.vault, 'Published transcript.md');
  const directory = path.join(vault.root, '.transcripts');
  const record = {
    id: randomUUID(), vault: { root: vault.root }, brief: { id: randomUUID(), version: 1, digest: 'a'.repeat(64) },
    requests: [{ id: randomUUID(), status: 'completed', question: 'Retained question', reply: 'Retained reply' }]
  };
  const text = JSON.stringify(record);
  let afterReceipt = false;
  const store = new Transcripts({
    conversations: {
      unsaved: new Set(), readStored: async () => ({ record, text }),
      historyResolver: () => async () => {}, lock: work => work()
    },
    getVault: () => vault,
    getContext: async () => ({ corpus: async () => ({ all: [] }) }),
    clock: () => ({ now: '2026-11-08T12:00:00Z' }),
    checkpoint: async boundary => { if (boundary === 'transcript-after-receipt') afterReceipt = true; },
    choose: async () => destination
  });
  const preview = await store.preview({ conversationId: record.id });
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
