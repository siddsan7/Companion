const { test, expect } = require('@playwright/test');
const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { AnnotationRemoval } = require('../app/annotation-removal');
const { Briefs } = require('../app/briefs');
const { CaptureDeletion } = require('../app/capture-deletion');
const { Context } = require('../app/context');
const { Conversations } = require('../app/conversations');
const { scanIdeas } = require('../app/idea-inventory');
const { installIdeas } = require('../app/ideas');
const { Intake } = require('../app/intake');
const { Vault } = require('../app/vault');
const draft = require('./fixtures/reel-draft/example.json');

const now = '2026-11-08T06:59:00.000Z';
const later = '2026-11-09T06:59:00.000Z';
const sourceHash = 'a'.repeat(64);
const execute = promisify(execFile);
const identity = async file => {
  const { dev, ino } = await fs.lstat(file, { bigint: true });
  return [dev, ino];
};
const absent = file => fs.stat(file).then(() => false, error => {
  if (error.code === 'ENOENT') return true;
  throw error;
});

async function writeDraftFixture(producer, name, input, attempt) {
  const artifact = path.join(producer, name), clip = 'b'.repeat(64);
  await fs.mkdir(artifact, { recursive: true });
  await fs.writeFile(path.join(artifact, 'run.json'), JSON.stringify({
    job_id: clip, attempt_id: attempt.repeat(32), started_utc: now, input_sha256: input,
    input_kind: 'local_video', result_kind: 'local_video_unreviewed', state: 'partial', validation: 'passed'
  }));
  await fs.writeFile(path.join(artifact, 'evidence.json'), JSON.stringify({ ...draft.input, clip_id: clip }));
  await fs.writeFile(path.join(artifact, 'first-pass-target.json'), JSON.stringify(draft.target));
  await fs.copyFile(path.join(__dirname, 'fixtures/reel-draft/notes.md'), path.join(artifact, 'notes.md'));
  return artifact;
}

async function publishedRestoration(testInfo, folderName, { independent = false, outsideManaged = false, beforeMove } = {}) {
  const directory = testInfo.outputPath('vault'), producer = testInfo.outputPath('producer');
  const artifact = await writeDraftFixture(producer, 'draft', sourceHash, '1');
  if (independent) {
    await writeDraftFixture(producer, 'citation', 'c'.repeat(64), '2');
    await writeDraftFixture(producer, 'unaffected', 'd'.repeat(64), '3');
  }
  await fs.mkdir(directory, { recursive: true });
  const interruption = Error('Stopped after restoration publication.');
  const vault = new Vault(await fs.realpath(directory), 'Companion', { checkpoint: async boundary => {
    if (boundary === 'capture-restoration-published') throw interruption;
  } });
  await vault.setup();
  const intake = new Intake(vault), accepted = await intake.connect(producer, true, now);
  const capture = accepted.captures[sourceHash], original = intake.destination(capture);
  const targetFolder = path.join(outsideManaged ? vault.vault : vault.root, folderName);
  await fs.mkdir(targetFolder, { recursive: true });
  const reserved = path.join(targetFolder, path.basename(original));
  if (original !== reserved) {
    await beforeMove?.(vault, reserved);
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

test('reserved restoration direct reads cannot offer an exact foreign capture citation', async ({}, testInfo) => {
  const { vault, intake, reserved, captureId, authority, journal, journalBytes } = await publishedRestoration(testInfo, 'Captures', { independent: true });
  const ledger = await intake.load(), cited = ledger.captures['c'.repeat(64)], unaffected = ledger.captures['d'.repeat(64)];
  const ideas = installIdeas({ ipcMain: { handle() {} }, getVault: () => vault });
  await expect(ideas.revision(vault, cited.id, cited.currentRevision, true)).resolves.toMatchObject({ capture: { id: cited.id } });
  const ordinary = intake.destination(cited), original = testInfo.outputPath('original-cited-capture.md');
  const citedBytes = await fs.readFile(ordinary), citedIdentity = await identity(ordinary);
  await fs.rename(ordinary, original);
  const { displaced, before, replacementIdentity } = await replaceRestoration(testInfo, reserved, citedBytes);
  expect(replacementIdentity).not.toEqual(citedIdentity);

  await expect.soft(ideas.revision(vault, cited.id, cited.currentRevision, true)).rejects.toThrow(/reserved|capture identity|unavailable/i);
  await expect(ideas.revision(vault, unaffected.id, unaffected.currentRevision, true)).resolves.toMatchObject({ capture: { id: unaffected.id } });
  await expect(ideas.revision(vault, cited.id, cited.currentRevision)).resolves.toMatchObject({
    revision: { id: cited.currentRevision, captureId: cited.id }
  });
  expect(await absent(ordinary)).toBe(true);
  expect(await fs.readFile(original)).toEqual(citedBytes);
  expect(await identity(original)).toEqual(citedIdentity);
  expect(await fs.readFile(reserved)).toEqual(citedBytes);
  expect(await identity(reserved)).toEqual(replacementIdentity);
  expect(await fs.readFile(displaced)).toEqual(before);
  expect(await fs.readFile(journal)).toEqual(journalBytes);
  expect((await intake.load()).sourceAuthority[captureId]).toEqual(authority);
});

for (const claim of ['reserved claim', 'new ordinary duplicate', 'new ordinary duplicate with a YAML document marker']) test(`idea confirmation holds a selected citation changed by a ${claim} after preview`, async ({}, testInfo) => {
  const { vault, intake, reserved, captureId, authority, journal, journalBytes } = await publishedRestoration(testInfo, 'Captures', { independent: true });
  const replacement = 'An ordinary restoration replacement before citation review.\n';
  const initial = await replaceRestoration(testInfo, reserved, replacement);
  const context = new Context(vault, { scopeFile: testInfo.outputPath('scope', 'notes.json') });
  const briefStore = new Briefs(vault), readme = testInfo.outputPath('README.md');
  await fs.writeFile(readme, '# MyTune\n\nA guitar practice tutor.\n');
  const { proposed } = await briefStore.propose([readme], now);
  const approved = await briefStore.approve({
    id: proposed.id, digest: proposed.digest,
    sections: proposed.sections.map(section => section.text),
    references: proposed.sections.map(section => section.references
      .map(ref => `${ref.source + 1}:${ref.start}-${ref.end}`).join(', '))
  }, now);
  const { version } = approved.approved[0];
  const ledger = await intake.load(), cited = ledger.captures['c'.repeat(64)], unaffected = ledger.captures['d'.repeat(64)];
  const citedFile = intake.destination(cited), citedBytes = await fs.readFile(citedFile);
  const citedIdentity = await identity(citedFile), duplicate = path.join(vault.vault, 'New capture claim.md');
  const duplicateBytes = claim.endsWith('YAML document marker')
    ? Buffer.concat([Buffer.from('---\n'), citedBytes])
    : citedBytes;
  const originalCited = testInfo.outputPath('original-cited-before-confirm.md'), displacedReplacement = testInfo.outputPath('prior-reserved-replacement.md');
  const source = (await context.corpus()).all.find(item => item.captureId === cited.id && item.revisionId === cited.currentRevision);
  expect(source).toBeDefined();
  const reply = 'A possible training exercise inspired by the source.';
  const getVault = () => vault, clock = () => ({ now }), checkpoint = async () => {};
  const conversations = new Conversations({
    dataRoot: testInfo.outputPath('history'), getVault, getContext: async () => context, clock, checkpoint,
    provider: { preflight: async () => {}, turn: async () => ({ reply }) }
  });
  const previewedPackage = await conversations.preview({
    question: 'What practice exercise does this source suggest?', briefVersion: version, speculation: false,
    selections: [{ key: source.key, digest: source.digest, ...(source.sourceGenerations ? { sourceGenerations: source.sourceGenerations } : {}) }]
  });
  const record = await conversations.send({ packageId: previewedPackage.packageId });
  const [request] = record.requests;
  expect(request).toMatchObject({ status: 'completed', reply });
  const conversationId = record.id, requestId = request.id;
  const ideas = installIdeas({ ipcMain: { handle() {} }, getVault, conversations, clock, checkpoint });
  const current = await ideas.revision(vault, cited.id, cited.currentRevision, true);
  const evidence = current.revision.evidence.evidence[0];
  expect(evidence.text).toBeTruthy();
  const offered = await ideas.draft({ conversationId, requestId });
  const chosen = offered.references.find(reference => reference.excerpt === evidence.text);
  expect(chosen).toBeDefined();
  const proposal = await ideas.preview({
    conversationId, requestId, title: 'Training exercise', explanation: reply, limitations: 'The exercise has not been tested.',
    referenceIds: [chosen.referenceId]
  });
  expect(proposal.text).toContain(`evidence_id: ${evidence.id}`);

  const preview = ideas.preview.bind(ideas);
  let changed = false, duplicateIdentity;
  ideas.preview = async (input, retained) => {
    const checked = await preview(input, retained);
    if (retained?.operation === proposal.operation && !changed) {
      // Let the real confirmation finish its last preview, then change the source files.
      if (claim === 'reserved claim') {
        await fs.rename(citedFile, originalCited);
        await fs.rename(reserved, displacedReplacement);
        await fs.writeFile(reserved, citedBytes, { flag: 'wx' });
      } else {
        await fs.writeFile(duplicate, duplicateBytes, { flag: 'wx' });
        duplicateIdentity = await identity(duplicate);
        expect(duplicateIdentity).not.toEqual(citedIdentity);
        const recognized = (await vault.scan()).filter(note => note.id === cited.id).map(note => note.file).sort();
        expect(recognized).toEqual([citedFile, duplicate].sort());
      }
      changed = true;
    }
    return checked;
  };
  await expect.soft(ideas.confirm({ operation: proposal.operation })).rejects.toThrow(/reserved|identity|evidence|changed|unavailable/i);
  expect(changed).toBe(true);
  const directory = path.join(vault.root, '.ideas'), stage = path.join(directory, `${proposal.operation}.md.pending`);
  expect.soft(await absent(proposal.destination)).toBe(true);
  expect.soft(await absent(path.join(directory, `${proposal.operation}.published.json`))).toBe(true);
  expect.soft(await absent(stage)).toBe(false);
  if (!await absent(stage)) expect(await fs.readFile(stage, 'utf8')).toBe(proposal.text);
  if (claim === 'reserved claim') {
    expect(await absent(citedFile)).toBe(true);
    expect(await fs.readFile(originalCited)).toEqual(citedBytes);
    expect(await fs.readFile(reserved)).toEqual(citedBytes);
    expect(await identity(displacedReplacement)).toEqual(initial.replacementIdentity);
  } else {
    expect(await fs.readFile(citedFile)).toEqual(citedBytes);
    expect(await identity(citedFile)).toEqual(citedIdentity);
    expect(await fs.readFile(duplicate)).toEqual(duplicateBytes);
    expect(await identity(duplicate)).toEqual(duplicateIdentity);
    expect(await fs.readFile(reserved, 'utf8')).toBe(replacement);
    expect(await identity(reserved)).toEqual(initial.replacementIdentity);
  }
  expect(await fs.readFile(initial.displaced)).toEqual(initial.before);
  expect(await fs.readFile(journal)).toEqual(journalBytes);
  expect((await intake.load()).sourceAuthority[captureId]).toEqual(authority);
  await expect(ideas.revision(vault, unaffected.id, unaffected.currentRevision, true)).resolves.toMatchObject({ capture: { id: unaffected.id } });
  await expect(ideas.revision(vault, cited.id, cited.currentRevision)).resolves.toMatchObject({ revision: { id: cited.currentRevision } });
});

test('current citation holds an excluded capture copy changed after an acknowledged identity scan', async ({}, testInfo) => {
  const { vault, intake, reserved } = await publishedRestoration(testInfo, 'Captures', { independent: true });
  await replaceRestoration(testInfo, reserved, 'An ordinary restoration replacement.\n');
  const cited = (await intake.load()).captures['c'.repeat(64)], canonical = intake.destination(cited);
  const originalBytes = await fs.readFile(canonical), copy = path.join(vault.vault, 'Excluded capture copy.md');
  const excluded = Buffer.concat([originalBytes, Buffer.from('\nIndependent writing in the excluded copy.\n')]);
  const edited = Buffer.concat([excluded, Buffer.from('\nA later edit changes the acknowledged identity choice.\n')]);
  await fs.writeFile(copy, excluded, { flag: 'wx' });
  const issue = (await intake.info()).identityIssues[cited.id];
  expect(issue.kind).toBe('duplicate');
  const file = path.relative(vault.vault, canonical);
  await intake.chooseIdentity({ id: cited.id, file, token: issue.token });
  expect((await intake.load()).identityChoices[cited.id].file).toBe(file);
  const ideas = installIdeas({ ipcMain: { handle() {} }, getVault: () => vault });
  await expect(ideas.revision(vault, cited.id, cited.currentRevision, true)).resolves.toMatchObject({ capture: { id: cited.id } });

  const scan = vault.scan.bind(vault);
  let changed = false;
  vault.scan = async options => {
    const matches = await scan(options);
    if (!changed && matches.some(note => note.file === copy && note.id === cited.id)) {
      await fs.writeFile(copy, edited);
      changed = true;
    }
    return matches;
  };
  await expect.soft(ideas.revision(vault, cited.id, cited.currentRevision, true)).rejects.toThrow(/identity|changed|unavailable/i);
  expect(changed).toBe(true);
  expect(await fs.readFile(canonical)).toEqual(originalBytes);
  expect(await fs.readFile(copy)).toEqual(edited);
  await expect(ideas.revision(vault, cited.id, cited.currentRevision)).resolves.toMatchObject({ revision: { id: cited.currentRevision } });
});

test('reserved restoration direct reads cannot supply an explicit note outside Companion', async ({}, testInfo) => {
  const scopeFile = testInfo.outputPath('scope', 'notes.json');
  const priorText = 'An ordinary note before the capture moved.\n';
  const replacement = 'Independent writing at a reserved restoration path.\n';
  let context, ordinary;
  const { intake, reserved, captureId, authority, journal, journalBytes } = await publishedRestoration(testInfo, 'Independent notes', {
    outsideManaged: true,
    beforeMove: async (vault, destination) => {
      context = new Context(vault, { scopeFile });
      ordinary = path.join(path.dirname(destination), 'Unaffected ordinary note.md');
      await fs.writeFile(destination, priorText, { flag: 'wx' });
      await fs.writeFile(ordinary, 'Ordinary project evidence.\n', { flag: 'wx' });
      await context.include([destination, ordinary]);
      expect(await context.scope()).toEqual([destination, ordinary]);
      await fs.rename(destination, testInfo.outputPath('prior-explicit-note.md'));
    }
  });
  const { displaced, before, replacementIdentity } = await replaceRestoration(testInfo, reserved, replacement);
  const scopeBytes = await fs.readFile(scopeFile);
  await expect.soft(context.note(reserved)).rejects.toThrow(/reserved|restor|unavailable/i);
  await expect.soft(context.include([reserved])).rejects.toThrow(/reserved|restor|unavailable/i);
  await expect(context.note(ordinary)).resolves.toMatchObject({ title: path.basename(ordinary), text: 'Ordinary project evidence.\n' });
  const { all } = await context.corpus();
  expect.soft(all.map(source => source.title)).not.toContain(path.basename(reserved));
  expect(all.map(source => source.title)).toContain(path.basename(ordinary));
  expect(await fs.readFile(scopeFile)).toEqual(scopeBytes);
  expect(await fs.readFile(testInfo.outputPath('prior-explicit-note.md'), 'utf8')).toBe(priorText);
  expect(await fs.readFile(reserved, 'utf8')).toBe(replacement);
  expect(await identity(reserved)).toEqual(replacementIdentity);
  expect(await fs.readFile(displaced)).toEqual(before);
  expect(await fs.readFile(journal)).toEqual(journalBytes);
  expect((await intake.load()).sourceAuthority[captureId]).toEqual(authority);
});

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

test('reserved restoration Markdown cannot settle an interrupted linked brief approval', async ({}, testInfo) => {
  const { vault, intake, reserved, captureId, authority, journal, journalBytes } = await publishedRestoration(testInfo, 'Captures');
  const briefs = new Briefs(vault), readme = testInfo.outputPath('README.md');
  async function propose(projectText) {
    await fs.writeFile(readme, `# MyTune\n\n${projectText}\n`);
    const { proposed } = await briefs.propose([readme], now);
    return {
      id: proposed.id, digest: proposed.digest,
      sections: proposed.sections.map(section => section.text),
      references: proposed.sections.map(section => section.references
        .map(ref => `${ref.source + 1}:${ref.start}-${ref.end}`).join(', '))
    };
  }
  const firstRequest = await propose('A guitar practice tutor.');
  const { approved } = await briefs.approve(firstRequest, now);
  const first = approved.find(item => item.id === firstRequest.id);
  expect(first.version).toBe(1);
  const request = await propose('A new draft awaiting approval.');
  const child = `
    const fs = require('node:fs');
    const path = require('node:path');
    const { Briefs } = require('./app/briefs');
    const { Vault } = require('./app/vault');
    const [vault, input, now] = process.argv.slice(1);
    const briefs = new Briefs(new Vault(vault, 'Companion'));
    const link = fs.linkSync;
    fs.linkSync = (from, to) => {
      link(from, to);
      if (path.dirname(from) === briefs.dir && path.dirname(to) === briefs.dir &&
          path.basename(from).startsWith('.brief-stage-') && path.basename(to).startsWith('approved-2-')) {
        process.exit(71);
      }
    };
    briefs.approve(JSON.parse(input), now).then(() => {
      console.error('Approval did not stop at the exact linked file.');
      process.exitCode = 72;
    }, error => {
      console.error(error);
      process.exitCode = 73;
    });
  `;
  await expect(execute(process.execPath, ['-e', child, vault.vault, JSON.stringify(request), now], {
    cwd: path.resolve(__dirname, '..'), windowsHide: true
  })).rejects.toMatchObject({ code: 71 });

  const pending = path.join(briefs.dir, '.brief-approval-2.pending.json');
  const receipt = path.join(briefs.dir, '.brief-approval-2.json');
  const pendingBytes = await fs.readFile(pending), pendingIdentity = await identity(pending);
  const marker = JSON.parse(pendingBytes.toString('utf8'));
  const stage = path.join(briefs.dir, marker.stage);
  const destination = path.join(briefs.dir, `approved-2-${marker.staged.digest}.md`);
  const bytes = await fs.readFile(stage), stageIdentity = await identity(stage);
  expect(await identity(destination)).toEqual(stageIdentity);
  expect((await fs.lstat(stage)).nlink).toBe(2);
  expect(await absent(receipt)).toBe(true);
  const displaced = testInfo.outputPath('original-restoration.md'), original = await fs.readFile(reserved);
  await fs.rename(reserved, displaced);
  await fs.rename(destination, reserved);
  expect(await identity(reserved)).toEqual(stageIdentity);

  const restarted = new Briefs(new Vault(vault.vault, 'Companion'));
  await expect.soft(restarted.pinned(2)).rejects.toThrow(/integrity|preserv|unavailable/i);
  await expect(restarted.pinned(1)).resolves.toMatchObject({ id: first.id, digest: first.digest });
  const independentHash = 'c'.repeat(64), clip = 'b'.repeat(64);
  const independent = testInfo.outputPath('producer', 'independent');
  await fs.mkdir(independent, { recursive: true });
  await fs.writeFile(path.join(independent, 'run.json'), JSON.stringify({
    job_id: clip, attempt_id: '2'.repeat(32), started_utc: later, input_sha256: independentHash,
    input_kind: 'local_video', result_kind: 'local_video_unreviewed', state: 'partial', validation: 'passed'
  }));
  await fs.writeFile(path.join(independent, 'evidence.json'), JSON.stringify({ ...draft.input, clip_id: clip }));
  await fs.writeFile(path.join(independent, 'first-pass-target.json'), JSON.stringify(draft.target));
  await fs.copyFile(path.join(__dirname, 'fixtures/reel-draft/notes.md'), path.join(independent, 'notes.md'));
  const independentIntake = new Intake(new Vault(vault.vault, 'Companion'));
  const result = await independentIntake.reconcile({ now: later }).catch(error => error);
  expect.soft(result instanceof Error ? result.message : null).toBeNull();
  if (!(result instanceof Error)) {
    expect(result.captures[independentHash]).toBeDefined();
    expect(await absent(independentIntake.destination(result.captures[independentHash]))).toBe(false);
    expect(result.sourceAuthority[captureId]).toEqual(authority);
    expect(result.suppressed).toContain(sourceHash);
  }
  expect.soft(await absent(receipt)).toBe(true);
  expect.soft(await absent(stage)).toBe(false);
  expect.soft(await absent(pending)).toBe(false);
  if (!await absent(stage)) {
    expect(await fs.readFile(stage)).toEqual(bytes);
    expect(await identity(stage)).toEqual(stageIdentity);
  }
  if (!await absent(pending)) {
    expect(await fs.readFile(pending)).toEqual(pendingBytes);
    expect(await identity(pending)).toEqual(pendingIdentity);
  }
  expect(await absent(destination)).toBe(true);
  expect(await fs.readFile(reserved)).toEqual(bytes);
  expect(await identity(reserved)).toEqual(stageIdentity);
  expect.soft((await fs.lstat(reserved)).nlink).toBe(2);
  expect(await fs.readFile(displaced)).toEqual(original);
  expect(await fs.readFile(journal)).toEqual(journalBytes);
  expect((await intake.load()).sourceAuthority[captureId]).toEqual(authority);
});
