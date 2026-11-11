const { test, expect } = require('@playwright/test');
const fs = require('node:fs/promises');
const path = require('node:path');
const { Briefs } = require('../app/briefs');
const { Context } = require('../app/context');
const { Vault } = require('../app/vault');

const now = '2026-11-08T12:00:00Z';

async function fixture(testInfo) {
  const root = testInfo.outputPath('brief-fixture');
  const vault = new Vault(path.join(root, 'vault'), 'Companion');
  await vault.setup();
  const readme = path.join(root, 'README.md');
  await fs.writeFile(readme, '# MyTune\n\nA guitar practice tutor.\n');
  const restart = () => new Briefs(new Vault(vault.vault, 'Companion'));
  async function approve() {
    const briefs = restart();
    const { proposed } = await briefs.propose([readme], now);
    const { approved } = await briefs.approve({
      id: proposed.id,
      digest: proposed.digest,
      sections: proposed.sections.map(section => section.text),
      references: proposed.sections.map(section => section.references
        .map(ref => `${ref.source + 1}:${ref.start}-${ref.end}`).join(', '))
    }, now);
    const record = approved.find(brief => brief.id === proposed.id);
    expect(record).toBeDefined();
    return { record, file: path.join(briefs.dir, record.file) };
  }
  async function archiveFile(name) {
    const directory = path.join(vault.vault, 'Project writing', 'History');
    await fs.mkdir(directory, { recursive: true });
    return path.join(directory, name);
  }
  return { root, vault, restart, approve, archiveFile };
}

test('an approved brief keeps its exact pin and discovery entry after a vault move', async ({}, testInfo) => {
  const { root, vault, restart, approve, archiveFile } = await fixture(testInfo);
  const { record, file } = await approve();
  const bytes = await fs.readFile(file);
  const moved = await archiveFile('Early MyTune plan.md');
  await fs.rename(file, moved);

  const pin = { id: record.id, version: record.version, digest: record.digest };
  await expect.soft(restart().pinned(1)).resolves.toMatchObject({
    ...pin, sources: record.sources, sections: record.sections
  });
  const discovered = await new Context(vault, { scopeFile: path.join(root, 'app', 'notes.json') }).corpus();
  expect.soft(discovered.all).toEqual(expect.arrayContaining([
    expect.objectContaining({ key: 'brief:1', briefVersion: 1, digest: record.digest })
  ]));
  expect(await fs.readFile(moved)).toEqual(bytes);
  await expect(fs.lstat(file)).rejects.toMatchObject({ code: 'ENOENT' });
});

test('a missing approved brief keeps its version reserved for historical pins', async ({}, testInfo) => {
  const { root, restart, approve } = await fixture(testInfo);
  const { record, file } = await approve();
  const bytes = await fs.readFile(file);
  const backup = path.join(root, 'Retained original outside vault.md');
  await fs.rename(file, backup);

  const newer = await approve();
  expect.soft(newer.record).toMatchObject({ version: 2 });
  expect.soft(newer.record.id).not.toBe(record.id);
  await expect.soft(restart().pinned(1)).rejects.toThrow(/unavailable/i);
  await expect.soft(restart().pinned(2)).resolves.toMatchObject({ id: newer.record.id, digest: newer.record.digest });
  expect(await fs.readFile(backup)).toEqual(bytes);
});

test('a renamed duplicate holds its own approved version and preserves other pins', async ({}, testInfo) => {
  const { restart, approve, archiveFile } = await fixture(testInfo);
  const first = await approve();
  const second = await approve();
  const duplicate = await archiveFile('Copy of the early MyTune plan.md');
  const bytes = await fs.readFile(first.file);
  await fs.copyFile(first.file, duplicate, require('node:fs').constants.COPYFILE_EXCL);

  await expect.soft(restart().pinned(1)).rejects.toThrow(/duplicate|ambiguous/i);
  await expect.soft(restart().pinned(2)).resolves.toMatchObject({ id: second.record.id, digest: second.record.digest });
  expect(await fs.readFile(first.file)).toEqual(bytes);
  expect(await fs.readFile(duplicate)).toEqual(bytes);
});

test('editing a moved approval holds its own pin without affecting another version', async ({}, testInfo) => {
  const { restart, approve, archiveFile } = await fixture(testInfo);
  const first = await approve();
  const second = await approve();
  const moved = await archiveFile('Changed early MyTune plan.md');
  await fs.rename(first.file, moved);
  await fs.appendFile(moved, '\nUnreviewed changes after the move.\n');
  const edited = await fs.readFile(moved);

  await expect.soft(restart().pinned(1)).rejects.toThrow(/integrity|changed/i);
  await expect.soft(restart().pinned(2)).resolves.toMatchObject({ id: second.record.id, digest: second.record.digest });
  expect(await fs.readFile(moved)).toEqual(edited);
});
