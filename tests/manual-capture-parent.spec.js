const { test, expect } = require('@playwright/test');
const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { Vault } = require('../app/vault');
const { Context } = require('../app/context');
const { Intake } = require('../app/intake');
const { CaptureDeletion } = require('../app/capture-deletion');
const { Conversations } = require('../app/conversations');
const draft = require('./fixtures/reel-draft/example.json');

const now = '2026-11-08T06:59:00.000Z';

async function managedParents(testInfo, { onlyFirst = false } = {}) {
  const folder = testInfo.outputPath('vault');
  await fs.mkdir(folder, { recursive: true });
  const root = await fs.realpath(folder);
  const a = new Vault(root, 'First Companion');
  const b = new Vault(root, 'Second Companion');
  await a.setup();
  if (!onlyFirst) await b.setup();
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

async function addLegacy(vault) {
  const id = randomUUID(), file = path.join(vault.root, 'Captures', 'Legacy thought.md');
  const content = `---\ncompanion_id: "${id}"\nartifact_type: "capture"\nschema_version: 1\ncapture_type: "thought"\ncaptured_at: "${now}"\ntitle: "Legacy thought"\nsource_url: ""\nprovenance: "user capture"\n---\n\n# Legacy thought\n\nKeep the original legacy bytes.\n`;
  await fs.writeFile(file, content);
  return { id, file, content };
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
  const { a, b, context, restart } = await managedParents(testInfo, { onlyFirst: true });
  const { id, file, content } = await addLegacy(a);

  await expect(restart(a).find(id)).resolves.toMatchObject({ id, file });
  await b.setup();
  expect((await context(restart(a)).corpus()).all.map(source => source.captureId)).toContain(id);
  expect((await context(restart(b)).corpus()).all.map(source => source.captureId)).not.toContain(id);
  expect(await fs.readFile(file, 'utf8')).toBe(content);
});

test('an observed legacy capture retains its parent when moved into another Captures area', async ({}, testInfo) => {
  const { a, b, context, restart } = await managedParents(testInfo, { onlyFirst: true });
  const { id, file, content } = await addLegacy(a);
  await expect(a.find(id)).resolves.toMatchObject({ id, file });
  await b.setup();
  const before = await new Intake(b).info();
  const moved = path.join(b.root, 'Captures', 'Moved legacy thought.md');
  await fs.rename(file, moved);

  const reopenedB = restart(b), reopenedA = restart(a);
  expect.soft((await reopenedB.list()).map(note => note.id)).not.toContain(id);
  expect.soft((await context(reopenedB).corpus()).all.map(source => source.captureId)).not.toContain(id);
  await expect.soft(new CaptureDeletion({ getVault: () => reopenedB }).preview(id)).rejects.toThrow();
  await expect.soft(reopenedA.find(id)).resolves.toMatchObject({ id, file: moved });
  expect.soft((await context(reopenedA).corpus()).all.map(source => source.captureId)).toContain(id);
  expect(await new Intake(b).load()).toEqual(before);
  expect(await fs.readFile(moved, 'utf8')).toBe(content);
});

test('an unobserved legacy capture with several possible parents gains no automatic authority', async ({}, testInfo) => {
  const { b, context, restart } = await managedParents(testInfo);
  const { id, file, content } = await addLegacy(b);
  const reopened = restart(b), before = await new Intake(reopened).info();

  expect.soft((await context(reopened).corpus()).all.map(source => source.captureId)).not.toContain(id);
  await expect.soft(new CaptureDeletion({ getVault: () => reopened }).preview(id)).rejects.toThrow();
  expect.soft(reopened.warnings.join('\n')).toMatch(/legacy.*(?:owner|managed parent)/i);
  expect(await new Intake(reopened).load()).toEqual(before);
  expect(await fs.readFile(file, 'utf8')).toBe(content);
});

test('an already restored legacy capture remains managed across a move and title edit', async ({}, testInfo) => {
  const { a, b, context, restart } = await managedParents(testInfo, { onlyFirst: true });
  const { id, file, content } = await addLegacy(a);
  await new Intake(a).info();
  const backup = testInfo.outputPath('legacy-backup.md');
  await fs.writeFile(backup, content);
  const clock = () => ({ now }), dataRoot = testInfo.outputPath('local-data');
  const conversations = new Conversations({ dataRoot, getVault: () => a, clock });
  await conversations.lock(async () => {});
  const store = new CaptureDeletion({ getVault: () => a, conversations, clearApprovals: () => {}, clock });
  await store.confirm((await store.preview(id)).token);
  await store.confirmRestoration((await store.previewRestoration({ id, file: backup })).token);
  expect((await new Intake(a).load()).sourceAuthority[id]).toMatchObject({ phase: 'active' });
  expect(await fs.readFile(file, 'utf8')).toBe(content);
  // Model an installation that already had active manual authority before
  // legacy ownership receipts existed. Remove only this fixture's exact receipt.
  const receipt = path.join(a.vault, '.companion-capture-owners', `${id}.json`);
  const recorded = await fs.readFile(receipt, 'utf8').catch(error => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  if (recorded !== null) {
    const stat = await fs.lstat(receipt);
    expect(stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1).toBe(true);
    expect(JSON.parse(recorded)).toEqual({ schema: 1, id, owner: path.basename(a.root), type: 'thought', capturedAt: now });
    await fs.unlink(receipt);
  }
  await expect(fs.access(receipt)).rejects.toMatchObject({ code: 'ENOENT' });
  await b.setup();

  const moved = path.join(a.vault, 'Moved legacy thought.md');
  await fs.rename(file, moved);
  const reopened = restart(a);
  await expect(reopened.find(id)).resolves.toMatchObject({ id, file: moved });
  await reopened.title(id, 'Renamed restored thought');
  const latest = restart(a);
  await expect(latest.find(id)).resolves.toMatchObject({ id, file: moved, title: 'Renamed restored thought' });
  expect((await context(latest).corpus()).all.map(source => source.captureId)).toContain(id);
  expect((await context(restart(b)).corpus()).all.map(source => source.captureId)).not.toContain(id);
  expect(await fs.readFile(backup, 'utf8')).toBe(content);
});

test('an admitted import stays browsable after a move and mutable capture type edit', async ({}, testInfo) => {
  const { a, b, context, restart } = await managedParents(testInfo);
  const producer = testInfo.outputPath('producer'), artifact = path.join(producer, 'first');
  const clip = 'b'.repeat(64);
  await fs.mkdir(artifact, { recursive: true });
  await fs.writeFile(path.join(artifact, 'run.json'), JSON.stringify({ job_id: clip, attempt_id: '1'.repeat(32), started_utc: now, input_sha256: 'a'.repeat(64), input_kind: 'local_video', result_kind: 'local_video_unreviewed', state: 'partial', validation: 'passed' }));
  await fs.writeFile(path.join(artifact, 'evidence.json'), JSON.stringify({ ...draft.input, clip_id: clip }));
  await fs.writeFile(path.join(artifact, 'first-pass-target.json'), JSON.stringify(draft.target));
  await fs.copyFile(path.join(__dirname, 'fixtures/reel-draft/notes.md'), path.join(artifact, 'notes.md'));
  const intake = new Intake(a);
  const result = await intake.connect(producer, true, now);
  expect(result.lastCheck.status).toBe('complete');
  const [capture] = Object.values((await intake.info()).captures);
  const file = (await a.find(capture.id)).file;
  const original = await fs.readFile(file, 'utf8');
  expect(original).toContain('capture_type: "reel_import"');
  expect((await context(a).corpus()).all.map(source => source.captureId)).toContain(capture.id);
  const moved = path.join(a.vault, 'Moved Reel import.md');
  await fs.rename(file, moved);
  const edited = original.replace('capture_type: "reel_import"', 'capture_type: "thought"') + '\nMOVEDTYPEEDITCANARY\n';
  await fs.writeFile(moved, edited);

  const reopened = restart(a), readIntake = new Intake(reopened);
  expect((await readIntake.inspect(capture.id)).capture).toMatchObject({ id: capture.id, relative: path.basename(moved) });
  await expect.soft(reopened.find(capture.id)).resolves.toMatchObject({ id: capture.id, file: moved });
  const corpus = await context(reopened).corpus();
  expect(corpus.all.map(source => source.captureId)).not.toContain(capture.id);
  expect.soft(corpus.issues.join('\n')).toMatch(/local changes conflict with the retained imported revision/i);
  expect((await context(restart(b)).corpus()).all.map(source => source.captureId)).not.toContain(capture.id);
  expect(await fs.readFile(moved, 'utf8')).toBe(edited);
});
