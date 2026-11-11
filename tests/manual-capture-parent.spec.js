const { test, expect } = require('@playwright/test');
const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { Vault } = require('../app/vault');
const { Context } = require('../app/context');
const { Intake } = require('../app/intake');
const { CaptureDeletion } = require('../app/capture-deletion');

const now = '2026-11-08T06:59:00.000Z';

async function managedParents(testInfo) {
  const folder = testInfo.outputPath('vault');
  await fs.mkdir(folder, { recursive: true });
  const root = await fs.realpath(folder);
  const a = new Vault(root, 'First Companion');
  const b = new Vault(root, 'Second Companion');
  await a.setup();
  await b.setup();
  return {
    a, b,
    context: vault => new Context(vault, { scopeFile: testInfo.outputPath(path.basename(vault.root), 'notes.json') }),
    restart: vault => new Vault(root, path.relative(root, vault.root))
  };
}

async function addCapture(vault, text) {
  const id = await vault.capture({ text }, now);
  const { file } = await vault.find(id);
  return { id, file, bytes: await fs.readFile(file) };
}

test('manual capture browsing keeps two managed parents in one vault separate', async ({}, testInfo) => {
  const { a, b, restart } = await managedParents(testInfo);
  const first = await addCapture(a, 'A thought about tuning strings');
  const second = await addCapture(b, 'https://example.test/tuning');

  expect((await restart(b).list()).map(note => note.id)).toEqual([second.id]);
  expect((await restart(a).list()).map(note => note.id)).toEqual([first.id]);
  expect(await fs.readFile(first.file)).toEqual(first.bytes);
  expect(await fs.readFile(second.file)).toEqual(second.bytes);
});

test('a moved manual capture remains discoverable only in its original managed parent', async ({}, testInfo) => {
  const { a, b, context, restart } = await managedParents(testInfo);
  const first = await addCapture(a, 'Tuning the mandolin by ear');
  const moved = path.join(b.root, 'Captures', 'Moved mandolin thought.md');
  await fs.rename(first.file, moved);
  const reopenedA = restart(a), reopenedB = restart(b);

  await expect(reopenedA.find(first.id)).resolves.toMatchObject({ id: first.id, file: moved, capturedAt: now });
  expect((await context(reopenedA).corpus()).all.map(source => source.captureId)).toContain(first.id);
  expect((await context(reopenedB).corpus()).all.map(source => source.captureId)).not.toContain(first.id);
  await expect(context(reopenedB).include([moved])).rejects.toThrow(/managed material|managed artifact metadata/i);
  expect(await fs.readFile(moved)).toEqual(first.bytes);
});

test('deletion in a different managed parent cannot authorize a manual capture', async ({}, testInfo) => {
  const { a, b } = await managedParents(testInfo);
  const first = await addCapture(a, 'Keep this thought in the first parent');
  const owner = new CaptureDeletion({ getVault: () => a });
  const other = new CaptureDeletion({ getVault: () => b });
  const owned = await new Intake(a).info(), before = await new Intake(b).info();
  await expect(owner.preview(first.id)).resolves.toMatchObject({ targets: ['First Companion/Captures/' + path.basename(first.file)] });

  await expect(other.preview(first.id)).rejects.toThrow();
  expect(await fs.readFile(first.file)).toEqual(first.bytes);
  expect(await new Intake(a).load()).toEqual(owned);
  expect(await new Intake(b).load()).toEqual(before);
});

test('legacy capture metadata stays readable in its own Captures area without rewriting the file', async ({}, testInfo) => {
  const { a, b, context, restart } = await managedParents(testInfo);
  const id = randomUUID(), file = path.join(a.root, 'Captures', 'Legacy thought.md');
  const content = `---\ncompanion_id: "${id}"\nartifact_type: "capture"\nschema_version: 1\ncapture_type: "thought"\ncaptured_at: "${now}"\ntitle: "Legacy thought"\nsource_url: ""\nprovenance: "user capture"\n---\n\n# Legacy thought\n\nKeep the original legacy bytes.\n`;
  await fs.writeFile(file, content);

  await expect(restart(a).find(id)).resolves.toMatchObject({ id, file });
  expect((await context(restart(a)).corpus()).all.map(source => source.captureId)).toContain(id);
  expect((await context(restart(b)).corpus()).all.map(source => source.captureId)).not.toContain(id);
  expect(await fs.readFile(file, 'utf8')).toBe(content);
});
