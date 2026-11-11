const { test, expect } = require('@playwright/test');
const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { Vault } = require('../app/vault');
const { Context } = require('../app/context');
const { Intake } = require('../app/intake');
const { CaptureDeletion } = require('../app/capture-deletion');
const { requiredDirectories } = require('../app/source-recovery');
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

async function legacyAuthority(vault, legacy) {
  // Model the exact active record left by an older installation after a
  // deliberate manual restoration, before ownership receipts existed.
  const intake = new Intake(vault), inspector = new CaptureDeletion({ getVault: () => vault });
  await intake.setup();
  const ledger = await intake.load(), target = await inspector.target(vault, legacy.file, 'capture');
  const directories = await Promise.all([...requiredDirectories(intake, [target])].sort().map(name => inspector.directory(vault, path.join(vault.vault, name))));
  ledger.sourceAuthority = { [legacy.id]: {
    generation: randomUUID(), phase: 'active', operationId: randomUUID(), sourceHash: null,
    targets: [target], root: vault.vault, directories,
    manual: { captureId: legacy.id, type: 'thought', capturedAt: now, currentHash: target.sha256, file: path.basename(legacy.file), relative: target.file }
  } };
  await intake.save(ledger);
  return { intake, ledger, target };
}

const receiptPath = (vault, id) => path.join(vault.vault, '.companion-capture-owners', `${id}.json`);

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

test('legacy capture with exact active authority stays readable without rewriting the file', async ({}, testInfo) => {
  const { a, b, context, restart } = await managedParents(testInfo, { onlyFirst: true });
  const legacy = await addLegacy(a), { id, file, content } = legacy;
  await legacyAuthority(a, legacy);

  await expect(restart(a).find(id)).resolves.toMatchObject({ id, file });
  await b.setup();
  expect((await context(restart(a)).corpus()).all.map(source => source.captureId)).toContain(id);
  expect((await context(restart(b)).corpus()).all.map(source => source.captureId)).not.toContain(id);
  expect(await fs.readFile(file, 'utf8')).toBe(content);
});

test('a verified legacy capture retains its parent when moved into another Captures area', async ({}, testInfo) => {
  const { a, b, context, restart } = await managedParents(testInfo, { onlyFirst: true });
  const legacy = await addLegacy(a), { id, file, content } = legacy;
  await legacyAuthority(a, legacy);
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
  const legacy = await addLegacy(a), { id, file, content } = legacy;
  await legacyAuthority(a, legacy);
  const backup = testInfo.outputPath('legacy-backup.md');
  await fs.writeFile(backup, content);
  expect((await new Intake(a).load()).sourceAuthority[id]).toMatchObject({ phase: 'active' });
  expect(await fs.readFile(file, 'utf8')).toBe(content);
  await expect(fs.access(receiptPath(a, id))).rejects.toMatchObject({ code: 'ENOENT' });
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

test('a legacy capture moved from a vanished layout gains no authority in the sole remaining parent', async ({}, testInfo) => {
  const { a, b, context, restart } = await managedParents(testInfo);
  const { id, file, content } = await addLegacy(a);
  const moved = path.join(b.root, 'Captures', 'Moved legacy thought.md');
  await fs.rename(file, moved);
  for (const area of ['Captures', 'Annotations', 'Ideas', 'Briefs', 'Revisions']) await fs.rmdir(path.join(a.root, area));
  await fs.rmdir(a.root);
  const reopened = restart(b), before = await new Intake(reopened).info();

  expect.soft((await context(reopened).corpus()).all.map(source => source.captureId)).not.toContain(id);
  await expect.soft(new CaptureDeletion({ getVault: () => reopened }).preview(id)).rejects.toThrow();
  expect.soft(reopened.warnings.join('\n')).toMatch(/legacy.*(?:owner|managed parent)/i);
  await expect.soft(fs.access(receiptPath(reopened, id))).rejects.toMatchObject({ code: 'ENOENT' });
  await expect.soft(reopened.title(id, 'Unapproved title')).rejects.toThrow();
  expect(await new Intake(reopened).load()).toEqual(before);
  expect(await fs.readFile(moved, 'utf8')).toBe(content);
});

test('changed bytes cannot establish the first receipt for active legacy authority', async ({}, testInfo) => {
  const { a, context, restart } = await managedParents(testInfo);
  const legacy = await addLegacy(a), { id, file, content } = legacy;
  const { ledger } = await legacyAuthority(a, legacy);
  const moved = path.join(a.vault, 'Changed legacy thought.md');
  await fs.rename(file, moved);
  const changed = content + '\nDifferent text with the same metadata.\n';
  await fs.writeFile(moved, changed);
  const reopened = restart(a);

  await expect.soft(reopened.find(id)).rejects.toThrow();
  expect.soft((await context(reopened).corpus()).all.map(source => source.captureId)).not.toContain(id);
  await expect.soft(new CaptureDeletion({ getVault: () => reopened }).preview(id)).rejects.toThrow();
  expect.soft(reopened.warnings.join('\n')).toMatch(/legacy.*(?:owner|managed parent)/i);
  await expect.soft(fs.access(receiptPath(reopened, id))).rejects.toMatchObject({ code: 'ENOENT' });
  expect((await new Intake(reopened).load()).sourceAuthority).toEqual(ledger.sourceAuthority);
  expect(await fs.readFile(moved, 'utf8')).toBe(changed);
});

for (const recorded of [false, true]) test(`a recorded excluded legacy singleton stays unavailable ${recorded ? 'with' : 'without'} a prior receipt`, async ({}, testInfo) => {
  const { a, context, restart } = await managedParents(testInfo);
  const legacy = await addLegacy(a), { id, file, content } = legacy;
  const { intake, ledger, target } = await legacyAuthority(a, legacy);
  const receipt = receiptPath(a, id);
  let prior;
  if (recorded) {
    await expect(a.find(id)).resolves.toMatchObject({ id, file });
    prior = await fs.readFile(receipt);
  }
  const excluded = path.join(a.vault, 'Excluded legacy copy.md');
  ledger.identityChoices = { [id]: { file: path.relative(a.vault, file), copies: [{ file: path.relative(a.vault, excluded), hash: target.sha256 }] } };
  await intake.save(ledger);
  await fs.rename(file, excluded);
  const reopened = restart(a);

  await expect.soft(reopened.find(id)).rejects.toThrow();
  expect.soft((await context(reopened).corpus()).all.map(source => source.captureId)).not.toContain(id);
  await expect.soft(new CaptureDeletion({ getVault: () => reopened }).preview(id)).rejects.toThrow();
  if (recorded) expect(await fs.readFile(receipt)).toEqual(prior);
  else await expect.soft(fs.access(receipt)).rejects.toMatchObject({ code: 'ENOENT' });
  expect((await new Intake(reopened).load()).identityChoices).toEqual(ledger.identityChoices);
  expect(await fs.readFile(excluded, 'utf8')).toBe(content);
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
