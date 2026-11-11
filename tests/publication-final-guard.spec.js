const { test: base, expect } = require('@playwright/test');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { installArchives } = require('../app/archives');
const { Conversations } = require('../app/conversations');
const { changeNoteScope } = require('../app/note-scope');
const { Vault } = require('../app/vault');

const now = '2026-11-08T12:00:00Z';
const foreign = Buffer.from('Independent writing from the disposable editor fixture.\n');
const test = base.extend({
  localVault: async ({}, use) => {
    const temp = await fs.realpath(os.tmpdir());
    const root = await fs.mkdtemp(path.join(temp, 'companion-final-publication-'));
    const identity = await fs.lstat(root, { bigint: true });
    let atCheckpoint = () => {};
    const vault = new Vault(path.join(root, 'vault'), 'Companion', { checkpoint: name => atCheckpoint(name) });
    try {
      await vault.setup();
      await use({ root, vault, checkpoint: action => { atCheckpoint = action; } });
    } finally {
      const current = await fs.lstat(root, { bigint: true });
      if (path.dirname(root) !== temp || await fs.realpath(root) !== root || !current.isDirectory() ||
          current.isSymbolicLink() || current.dev !== identity.dev || current.ino !== identity.ino) {
        throw Error('Disposable publication fixture changed before cleanup.');
      }
      await fs.rm(root, { recursive: true });
    }
  }
});

async function afterProofClose(select, change, operation) {
  const open = fs.open;
  let reached = false;
  fs.open = async (file, flags, ...args) => {
    const handle = await open(file, flags, ...args);
    if (typeof file !== 'string' || typeof flags !== 'number') return handle;
    const close = handle.close.bind(handle);
    handle.close = async () => {
      await close();
      if (reached || !await select(file)) return;
      reached = true;
      await change(file);
    };
    return handle;
  };
  try {
    const result = await operation().then(() => null, error => error);
    expect(reached, 'the actual read proof handle closed before the fixture replacement').toBe(true);
    return result;
  } finally { fs.open = open; }
}

async function displace(file, replacement = foreign) {
  const original = await fs.readFile(file), parked = `${file}.displaced`;
  await fs.rename(file, parked);
  await fs.writeFile(file, replacement, { flag: 'wx' });
  return { file, parked, original };
}

async function absent(file) {
  return fs.lstat(file).then(() => false, error => {
    if (error.code !== 'ENOENT') throw error;
    return true;
  });
}

test('capture keeps a replacement stage out of the final note when its proof handle closes', async ({ localVault }) => {
  const { vault } = localVault, directory = path.join(vault.root, 'Captures');
  let replacement;
  const result = await afterProofClose(file => path.dirname(file) === directory && file.endsWith('.md.pending'),
    async file => { replacement = await displace(file); },
    () => vault.capture({ text: 'The exact reviewed capture.' }, now));

  expect.soft(result?.code).toBe('STAGING_CHANGED');
  expect.soft(await absent(replacement.file.slice(0, -'.pending'.length))).toBe(true);
  expect(await fs.readFile(replacement.file)).toEqual(foreign);
  expect(await fs.readFile(replacement.parked)).toEqual(replacement.original);
});

test('capture cleanup preserves a replacement when the owned stage proof handle closes', async ({ localVault }) => {
  const { vault } = localVault, directory = path.join(vault.root, 'Captures');
  let linkedReads = 0, replacement;
  const result = await afterProofClose(async file => path.dirname(file) === directory && file.endsWith('.md.pending') &&
      (await fs.lstat(file)).nlink === 2 && ++linkedReads === 2,
    async file => { replacement = await displace(file); },
    () => vault.capture({ text: 'The published capture stays intact.' }, now));

  const destination = replacement.file.slice(0, -'.pending'.length);
  expect.soft(result?.code).toBe('STAGING_CHANGED');
  expect.soft(await fs.readFile(replacement.file).catch(error => error.code)).toEqual(foreign);
  expect(await fs.readFile(replacement.parked)).toEqual(replacement.original);
  expect(await fs.readFile(destination)).toEqual(replacement.original);
});

test('title edit preserves a changed current note after the final prior-note proof closes', async ({ localVault }) => {
  const { vault, checkpoint } = localVault;
  const id = await vault.capture({ text: 'The original title and body.' }, now);
  const { file } = await vault.find(id);
  let titleStaged = false, currentReads = 0, replacement;
  checkpoint(name => { if (name === 'title-staged') titleStaged = true; });
  const result = await afterProofClose(candidate => titleStaged && candidate === file && ++currentReads === 2,
    async candidate => {
      const changed = Buffer.concat([await fs.readFile(candidate), foreign]);
      replacement = { ...await displace(candidate, changed), changed };
    },
    () => vault.title(id, 'Reviewed title'));

  const journal = JSON.parse(await fs.readFile(`${file}.title-transaction.json`, 'utf8'));
  expect.soft(result?.message).toMatch(/chang|conflict/i);
  expect.soft(await fs.readFile(file).catch(error => error.code)).toEqual(replacement.changed);
  expect.soft(await absent(path.join(path.dirname(file), journal.backup))).toBe(true);
  expect(await fs.readFile(replacement.parked)).toEqual(replacement.original);
});

test('title edit keeps the prior note when the final title stage proof closes over a replacement', async ({ localVault }) => {
  const { vault, checkpoint } = localVault;
  const id = await vault.capture({ text: 'Keep the previous title.' }, now);
  const { file } = await vault.find(id);
  const original = await fs.readFile(file), stage = `${file}.pending`;
  let titleMoved = false, replacement;
  checkpoint(name => { if (name === 'title-moved') titleMoved = true; });
  const result = await afterProofClose(candidate => titleMoved && candidate === stage,
    async candidate => { replacement = await displace(candidate); },
    () => vault.title(id, 'Unpublished title'));

  const journal = JSON.parse(await fs.readFile(`${file}.title-transaction.json`, 'utf8'));
  expect.soft(result?.code).toBe('STAGING_CHANGED');
  expect.soft(await fs.readFile(file)).toEqual(original);
  expect(await fs.readFile(path.join(path.dirname(file), journal.backup))).toEqual(original);
  expect(await fs.readFile(stage)).toEqual(foreign);
  expect(await fs.readFile(replacement.parked)).toEqual(replacement.original);
});

async function archiveExport(root, vault) {
  const dataRoot = path.join(root, 'app-data'), destination = path.join(root, 'history.json');
  const settingsPath = path.join(dataRoot, 'settings.json');
  await fs.mkdir(dataRoot);
  await fs.writeFile(settingsPath, JSON.stringify({ vault: vault.vault, parent: 'Companion' }));
  await fs.writeFile(path.join(dataRoot, 'archive-dialog.json'), JSON.stringify({ save: destination }));
  const clock = () => ({ now });
  const history = new Conversations({ dataRoot, getVault: () => vault, clock });
  const handlers = new Map();
  installArchives({
    ipcMain: { handle: (channel, handler) => handlers.set(channel, handler) },
    history, settingsPath, testRoot: dataRoot, clock, checkpoint: async () => {}, appVersion: '0.1.0'
  });
  const preview = await handlers.get('archive-preview')(null);
  return { destination, exportArchive: () => handlers.get('archive-export')(null, { id: preview.id }) };
}

test('archive export keeps a replacement stage out of the destination when its proof handle closes', async ({ localVault }) => {
  const { root, vault } = localVault;
  const { destination, exportArchive } = await archiveExport(root, vault);
  let replacement;
  const result = await afterProofClose(file => path.dirname(file) === root && /^\.companion-archive-.*\.pending$/.test(path.basename(file)),
    async file => { replacement = await displace(file); }, exportArchive);

  expect.soft(result?.code).toBe('STAGING_CHANGED');
  expect.soft(await absent(destination)).toBe(true);
  expect(await fs.readFile(replacement.file)).toEqual(foreign);
  expect(await fs.readFile(replacement.parked)).toEqual(replacement.original);
});

test('archive export reports a changed final destination when its last proof handle closes', async ({ localVault }) => {
  const { root, vault } = localVault;
  const { destination, exportArchive } = await archiveExport(root, vault);
  let replacement;
  const result = await afterProofClose(async file => file === destination && (await fs.lstat(file)).nlink === 1,
    async file => { replacement = await displace(file); }, exportArchive);

  expect.soft(result?.code).toBe('STAGING_CHANGED');
  expect(await fs.readFile(destination)).toEqual(foreign);
  expect(await fs.readFile(replacement.parked)).toEqual(replacement.original);
  expect(JSON.parse(replacement.original)).toMatchObject({ format: 'companion-local-history' });
});

test('note scope retains its receipt if the destination changes during receipt cleanup', async ({ localVault }) => {
  const { root } = localVault;
  const directory = path.join(root, 'scope'), file = path.join(directory, 'notes.json');
  const receipt = path.join(directory, '.archive-note-scope-publication.json');
  const selected = path.join(root, 'selected.md'), edited = path.join(root, 'edited.md');
  const external = Buffer.from(JSON.stringify({ schema: 1, files: [edited] }, null, 2));
  let replacement, receiptBytes;
  const result = await afterProofClose(async candidate => candidate === receipt && !await absent(file) &&
      (await fs.lstat(file)).nlink === 1,
    async candidate => {
      receiptBytes = await fs.readFile(candidate);
      replacement = await displace(file, external);
    },
    () => changeNoteScope(file, { update: () => [selected] }));

  expect.soft(result?.message).toMatch(/chang|publication|scope/i);
  expect.soft(await fs.readFile(receipt).catch(error => error.code)).toEqual(receiptBytes);
  expect(await fs.readFile(file)).toEqual(external);
  expect(await fs.readFile(replacement.parked)).toEqual(Buffer.from(JSON.stringify({ schema: 1, files: [selected] }, null, 2)));
});
