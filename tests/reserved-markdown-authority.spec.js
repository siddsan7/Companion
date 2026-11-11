const { test, expect } = require('@playwright/test');
const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { AnnotationRemoval } = require('../app/annotation-removal');
const { Briefs } = require('../app/briefs');
const { CaptureDeletion } = require('../app/capture-deletion');
const { Context } = require('../app/context');
const { Conversations } = require('../app/conversations');
const { scanIdeas } = require('../app/idea-inventory');
const { Intake } = require('../app/intake');
const { Vault } = require('../app/vault');
const draft = require('./fixtures/reel-draft/example.json');

const now = '2026-11-08T06:59:00.000Z';
const later = '2026-11-09T06:59:00.000Z';
const sourceHash = 'a'.repeat(64);
const identity = async file => {
  const { dev, ino } = await fs.lstat(file, { bigint: true });
  return [dev, ino];
};
const absent = file => fs.stat(file).then(() => false, error => {
  if (error.code === 'ENOENT') return true;
  throw error;
});

async function publishedRestoration(testInfo, folderName) {
  const directory = testInfo.outputPath('vault'), producer = testInfo.outputPath('producer');
  const artifact = path.join(producer, 'draft'), clip = 'b'.repeat(64);
  await fs.mkdir(directory, { recursive: true });
  await fs.mkdir(artifact, { recursive: true });
  await fs.writeFile(path.join(artifact, 'run.json'), JSON.stringify({
    job_id: clip, attempt_id: '1'.repeat(32), started_utc: now, input_sha256: sourceHash,
    input_kind: 'local_video', result_kind: 'local_video_unreviewed', state: 'partial', validation: 'passed'
  }));
  await fs.writeFile(path.join(artifact, 'evidence.json'), JSON.stringify({ ...draft.input, clip_id: clip }));
  await fs.writeFile(path.join(artifact, 'first-pass-target.json'), JSON.stringify(draft.target));
  await fs.copyFile(path.join(__dirname, 'fixtures/reel-draft/notes.md'), path.join(artifact, 'notes.md'));

  const interruption = Error('Stopped after restoration publication.');
  const vault = new Vault(await fs.realpath(directory), 'Companion', { checkpoint: async boundary => {
    if (boundary === 'capture-restoration-published') throw interruption;
  } });
  await vault.setup();
  const intake = new Intake(vault), accepted = await intake.connect(producer, true, now);
  const capture = accepted.captures[sourceHash], original = intake.destination(capture);
  const targetFolder = path.join(vault.root, folderName);
  await fs.mkdir(targetFolder, { recursive: true });
  const reserved = path.join(targetFolder, path.basename(original));
  if (original !== reserved) {
    await fs.rename(original, reserved);
    expect(intake.destination((await intake.info()).captures[sourceHash])).toBe(reserved);
  }
  const getVault = () => vault, clock = () => ({ now: later });
  const conversations = new Conversations({ dataRoot: testInfo.outputPath('history'), getVault, clock });
  await conversations.lock(async () => {});
  const deletion = new CaptureDeletion({ getVault, conversations, clock, clearApprovals() {} });
  await deletion.confirm((await deletion.preview(capture.id)).token);
  const restoration = await deletion.previewRestoration({ id: capture.id, kind: 'draft', folder: artifact });
  await expect(deletion.confirmRestoration(restoration.token)).rejects.toThrow(interruption.message);

  const ledger = await intake.load(), authority = ledger.sourceAuthority[capture.id];
  expect(authority).toMatchObject({ phase: 'restoring', restoration: { published: true } });
  expect(ledger.suppressed).toContain(sourceHash);
  expect(intake.destination(ledger.captures[sourceHash])).toBe(reserved);
  const journal = path.join(intake.dir, authority.restoration.journal);
  return { vault, intake, reserved, captureId: capture.id, authority, journal, journalBytes: await fs.readFile(journal) };
}

async function replaceRestoration(testInfo, reserved, replacement) {
  const displaced = testInfo.outputPath('original-restoration.md');
  const before = await fs.readFile(reserved), originalIdentity = await identity(reserved);
  await fs.rename(reserved, displaced);
  await fs.writeFile(reserved, replacement, { flag: 'wx' });
  expect(await identity(reserved)).not.toEqual(originalIdentity);
  return { displaced, before, replacementIdentity: await identity(reserved) };
}

test('reserved restoration Markdown cannot be selected or unlinked as an annotation', async ({}, testInfo) => {
  const { vault, intake, reserved, captureId, authority, journal, journalBytes } = await publishedRestoration(testInfo, 'Captures');
  const folder = path.join(vault.root, 'Annotations');
  await fs.mkdir(folder, { recursive: true });
  const id = randomUUID(), unaffectedId = randomUUID();
  const annotation = (noteId, content) => `---\nartifact_type: annotation\nschema_version: 1\ncompanion_id: ${noteId}\ncapture_id: ${captureId}\n---\n\n${content}\n`;
  const ordinary = path.join(folder, id + '.md'), unaffected = path.join(folder, unaffectedId + '.md');
  const ordinaryText = annotation(id, 'Original independent commentary.');
  const foreignText = annotation(id, 'Foreign commentary in the reserved restoration path.');
  await fs.writeFile(ordinary, ordinaryText, { flag: 'wx' });
  await fs.writeFile(unaffected, annotation(unaffectedId, 'Unrelated ordinary commentary.'), { flag: 'wx' });
  const ordinaryIdentity = await identity(ordinary);
  const removal = new AnnotationRemoval({ getVault: () => vault, clearApprovals() {} });
  const oldPreview = await removal.preview(id);
  expect(oldPreview.targets).toHaveLength(1);
  const { displaced, before, replacementIdentity } = await replaceRestoration(testInfo, reserved, foreignText);

  await expect(removal.confirm(oldPreview.token)).rejects.toThrow();
  const listed = await removal.list();
  expect.soft(listed.map(note => note.id)).not.toContain(id);
  expect(listed.map(note => note.id)).toContain(unaffectedId);
  const fresh = await removal.preview(id).catch(() => null);
  expect.soft(fresh).toBeNull();
  if (fresh) {
    const result = await removal.confirm(fresh.token).catch(() => null);
    expect.soft(result).toBeNull();
  }
  expect.soft(await absent(reserved)).toBe(false);
  expect.soft(await absent(ordinary)).toBe(false);
  if (!await absent(reserved)) {
    expect(await fs.readFile(reserved, 'utf8')).toBe(foreignText);
    expect(await identity(reserved)).toEqual(replacementIdentity);
  }
  if (!await absent(ordinary)) {
    expect(await fs.readFile(ordinary, 'utf8')).toBe(ordinaryText);
    expect(await identity(ordinary)).toEqual(ordinaryIdentity);
  }
  expect(await fs.readFile(displaced)).toEqual(before);
  expect(await fs.readFile(journal)).toEqual(journalBytes);
  expect((await intake.load()).sourceAuthority[captureId]).toEqual(authority);
  expect(await removal.confirm((await removal.preview(unaffectedId)).token)).toBe(true);
  expect(await absent(unaffected)).toBe(true);
});

test('reserved restoration Markdown under Ideas cannot supply saved-idea context', async ({}, testInfo) => {
  const { vault, intake, reserved, captureId, authority, journal, journalBytes } = await publishedRestoration(testInfo, 'Ideas');
  const id = randomUUID(), ordinaryId = randomUUID();
  const idea = (ideaId, title) => `---\nartifact_type: saved_idea\nschema_version: 1\ncompanion_id: ${ideaId}\ntitle: ${title}\nsource_dependencies: []\n---\n\n${title} is independent writing.\n`;
  const foreign = idea(id, 'Foreign replacement'), ordinary = idea(ordinaryId, 'Ordinary saved idea');
  const ordinaryFile = path.join(vault.root, 'Ideas', 'Ordinary saved idea.md');
  await fs.writeFile(ordinaryFile, ordinary, { flag: 'wx' });
  const { displaced, before, replacementIdentity } = await replaceRestoration(testInfo, reserved, foreign);
  const { claims } = await scanIdeas(vault);
  expect.soft(claims.get(id)?.some(claim => claim.savedIdea) ?? false).toBe(false);
  expect(claims.get(ordinaryId)).toEqual([expect.objectContaining({ savedIdea: true, content: ordinary })]);
  const context = new Context(vault, { scopeFile: testInfo.outputPath('scope', 'notes.json') });
  const { all } = await context.corpus();
  expect.soft(all.map(source => source.key)).not.toContain(`idea:${id}`);
  expect(all.map(source => source.key)).toContain(`idea:${ordinaryId}`);
  expect(await fs.readFile(reserved, 'utf8')).toBe(foreign);
  expect(await identity(reserved)).toEqual(replacementIdentity);
  expect(await fs.readFile(displaced)).toEqual(before);
  expect(await fs.readFile(journal)).toEqual(journalBytes);
  expect((await intake.load()).sourceAuthority[captureId]).toEqual(authority);
});

test('reserved restoration Markdown cannot supply an exact moved approved brief', async ({}, testInfo) => {
  const { vault, intake, reserved, captureId, authority, journal, journalBytes } = await publishedRestoration(testInfo, 'Captures');
  const briefs = new Briefs(vault), readme = testInfo.outputPath('README.md');
  async function approve(projectText) {
    await fs.writeFile(readme, `# MyTune\n\n${projectText}\n`);
    const { proposed } = await briefs.propose([readme], now);
    const request = {
      id: proposed.id, digest: proposed.digest,
      sections: proposed.sections.map(section => section.text),
      references: proposed.sections.map(section => section.references
        .map(ref => `${ref.source + 1}:${ref.start}-${ref.end}`).join(', '))
    };
    const { approved } = await briefs.approve(request, now);
    const record = approved.find(item => item.id === proposed.id);
    expect(record).toBeDefined();
    return { record, file: path.join(briefs.dir, record.file) };
  }
  const first = await approve('A guitar practice tutor.');
  const unaffected = await approve('An independent second project brief.');
  expect(first.record.version).toBe(1);
  expect(unaffected.record.version).toBe(2);
  await expect(briefs.pinned(1)).resolves.toMatchObject({ id: first.record.id, digest: first.record.digest });

  const firstBytes = await fs.readFile(first.file);
  const receipt = path.join(briefs.dir, '.brief-approval-1.json'), receiptBytes = await fs.readFile(receipt);
  const originalBrief = testInfo.outputPath('original-approved-brief.md');
  await fs.rename(first.file, originalBrief);
  const { displaced, before, replacementIdentity } = await replaceRestoration(testInfo, reserved, firstBytes);
  expect(replacementIdentity).not.toEqual(await identity(originalBrief));

  const restarted = new Briefs(new Vault(vault.vault, 'Companion'));
  await expect.soft(restarted.pinned(1)).rejects.toThrow(/unavailable|preserv|reserved/i);
  await expect(restarted.pinned(2)).resolves.toMatchObject({ id: unaffected.record.id, digest: unaffected.record.digest });
  const context = new Context(vault, { scopeFile: testInfo.outputPath('scope', 'notes.json') });
  const { all } = await context.corpus();
  expect.soft(all.map(source => source.key)).not.toContain('brief:1');
  expect(all.map(source => source.key)).toContain('brief:2');
  expect(await absent(first.file)).toBe(true);
  expect(await fs.readFile(originalBrief)).toEqual(firstBytes);
  expect(await fs.readFile(reserved)).toEqual(firstBytes);
  expect(await identity(reserved)).toEqual(replacementIdentity);
  expect(await fs.readFile(receipt)).toEqual(receiptBytes);
  expect(await fs.readFile(displaced)).toEqual(before);
  expect(await fs.readFile(journal)).toEqual(journalBytes);
  expect((await intake.load()).sourceAuthority[captureId]).toEqual(authority);
});
