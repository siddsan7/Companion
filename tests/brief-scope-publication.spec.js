const { test: base, expect } = require('@playwright/test');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { installArchives } = require('../app/archives');
const { Briefs } = require('../app/briefs');
const { Context } = require('../app/context');
const { Conversations } = require('../app/conversations');
const { Vault } = require('../app/vault');

const now = '2026-11-08T12:00:00Z';
const scopeBytes = files => Buffer.from(JSON.stringify({ schema: 1, files }, null, 2));
const test = base.extend({
  localVault: async ({}, use) => {
    const temp = await fs.realpath(os.tmpdir());
    const root = await fs.mkdtemp(path.join(temp, 'companion-brief-scope-'));
    const identity = await fs.lstat(root, { bigint: true });
    let atCheckpoint = async () => {};
    const vault = new Vault(path.join(root, 'vault'), 'Companion', { checkpoint: name => atCheckpoint(name) });
    const binding = createHash('sha256').update(vault.root).digest('hex');
    const scopeFile = path.join(root, `context-settings-${binding}`, 'notes.json');
    const context = new Context(vault, { scopeFile });
    const checkpoint = action => { atCheckpoint = action; };
    try {
      await vault.setup();
      await use({ root, vault, scopeFile, context, checkpoint });
    } finally {
      const current = await fs.lstat(root, { bigint: true });
      if (path.dirname(root) !== temp || await fs.realpath(root) !== root || !current.isDirectory() || current.isSymbolicLink() || current.dev !== identity.dev || current.ino !== identity.ino) {
        throw Error('Disposable brief and scope fixture changed before cleanup.');
      }
      await fs.rm(root, { recursive: true });
    }
  }
});

async function onlyStage(directory, pattern) {
  const stages = (await fs.readdir(directory)).filter(name => pattern.test(name));
  expect(stages).toHaveLength(1);
  return path.join(directory, stages[0]);
}

function approval(proposal) {
  return {
    id: proposal.id,
    digest: proposal.digest,
    sections: proposal.sections.map(section => section.text),
    references: proposal.sections.map(section => section.references.map(ref => `${ref.source + 1}:${ref.start}-${ref.end}`).join(', '))
  };
}

async function authoredNote(vault, name) {
  const file = path.join(vault.vault, `${name}.md`);
  await fs.writeFile(file, `# ${name}\n\nAuthored fixture note.\n`);
  return file;
}

test('brief approval preserves a substituted stage and keeps the existing approved version readable', async ({ localVault }) => {
  const { root, vault, checkpoint } = localVault;
  const briefs = new Briefs(vault);
  const readme = path.join(root, 'README.md');
  await fs.writeFile(readme, '# MyTune\n\nA guitar practice tutor.\n');
  const initial = await briefs.propose([readme], now);
  const { approved: [prior] } = await briefs.approve(approval(initial.proposed), now);
  const original = await fs.readFile(path.join(briefs.dir, prior.file));
  const refreshed = await briefs.propose([readme], now);
  const unrelated = Buffer.from('Independent writing in a substituted staging file.\n');
  let stage, displaced;
  checkpoint(async name => {
    if (name !== 'brief-before-approval-publish') return;
    stage = await onlyStage(briefs.dir, /^\.brief-stage-/);
    displaced = `${stage}.displaced`;
    await fs.rename(stage, displaced);
    await fs.writeFile(stage, unrelated, { flag: 'wx' });
  });

  const attempt = await briefs.approve(approval(refreshed.proposed), now).then(() => null, error => error);
  expect(stage).toBeDefined();
  expect.soft(attempt?.message).toMatch(/stag|publication/i);
  expect.soft(await fs.readFile(stage).catch(error => error.code)).toEqual(unrelated);
  expect.soft((await fs.readdir(briefs.dir)).filter(name => name.startsWith('approved-'))).toEqual([prior.file]);
  expect(await fs.readFile(path.join(briefs.dir, prior.file))).toEqual(original);
  expect(await fs.readFile(displaced, 'utf8')).toContain(refreshed.proposed.id);
  expect(await briefs.pinned(1)).toMatchObject({ id: prior.id, version: 1, digest: prior.digest });
});

for (const change of ['missing', 'changed']) test(`brief refresh requires a new review when a source is ${change} at publication`, async ({ localVault }) => {
  const { root, vault, checkpoint } = localVault;
  const briefs = new Briefs(vault);
  const readme = path.join(root, 'README.md');
  const source = '# MyTune\n\nA guitar practice tutor.\n';
  await fs.writeFile(readme, source);
  const first = await briefs.propose([readme], now);
  const { approved: [prior] } = await briefs.approve(approval(first.proposed), now);
  const refresh = await briefs.propose([readme], now);
  let reached = false;
  checkpoint(async name => {
    if (name !== 'brief-before-approval-publish') return;
    reached = true;
    if (change === 'missing') await fs.unlink(readme);
    else await fs.writeFile(readme, `${source}\nNew source text.\n`);
  });

  const attempt = await briefs.approve(approval(refresh.proposed), now).then(() => null, error => error);
  expect(reached).toBe(true);
  expect.soft(attempt?.message).toMatch(/approval blocked.*source/i);
  const blocked = await briefs.state();
  expect.soft(blocked.approved.map(item => item.id)).toEqual([prior.id]);
  expect(blocked.issues).toEqual([expect.stringContaining(readme)]);

  checkpoint(async () => {});
  await fs.writeFile(readme, source);
  const newReview = await briefs.propose([readme], now);
  const result = await briefs.approve(approval(newReview.proposed), now);
  expect(result.approved.map(item => [item.version, item.id])).toEqual([[2, newReview.proposed.id], [1, prior.id]]);
  expect(result.issues).toEqual([]);
});

test('direct note inclusion leaves a substituted stage outside the eligible corpus', async ({ localVault }) => {
  const { vault, scopeFile, context, checkpoint } = localVault;
  const chosen = await authoredNote(vault, 'reviewed');
  const unchosen = await authoredNote(vault, 'unreviewed');
  const unexpected = scopeBytes([unchosen]);
  let stage, displaced;
  checkpoint(async name => {
    if (name !== 'context-before-scope-publish') return;
    stage = await onlyStage(path.dirname(scopeFile), /^notes-.*\.tmp$/);
    displaced = `${stage}.displaced`;
    await fs.rename(stage, displaced);
    await fs.writeFile(stage, unexpected, { flag: 'wx' });
  });

  const attempt = await context.include([chosen]).then(() => null, error => error);
  expect(stage).toBeDefined();
  expect.soft(attempt?.message).toMatch(/stag|publication|scope/i);
  expect.soft(await context.scope()).toEqual([]);
  expect.soft(await fs.readFile(stage).catch(error => error.code)).toEqual(unexpected);
  expect(await fs.readFile(displaced)).toEqual(scopeBytes([chosen]));
  expect(await fs.lstat(scopeFile).catch(error => error.code)).toBe('ENOENT');

  checkpoint(async () => {});
  await context.include([chosen]);
  expect(await context.scope()).toEqual([chosen]);
  expect(await fs.readFile(stage)).toEqual(unexpected);
});

test('direct note exclusion preserves the scope file if its reviewed bytes change before publication', async ({ localVault }) => {
  const { vault, scopeFile, context, checkpoint } = localVault;
  const excluded = await authoredNote(vault, 'excluded');
  const retained = await authoredNote(vault, 'retained');
  const added = await authoredNote(vault, 'new selection');
  const key = (await context.note(excluded)).key;
  await context.include([excluded, retained]);
  const external = scopeBytes([excluded, retained, added]);
  let reached = false;
  checkpoint(async name => {
    if (name !== 'context-before-scope-publish') return;
    reached = true;
    await fs.writeFile(scopeFile, external);
  });

  const attempt = await context.exclude(key).then(() => null, error => error);
  expect(reached).toBe(true);
  expect.soft(attempt?.message).toMatch(/chang|publication|scope/i);
  expect.soft(await fs.readFile(scopeFile)).toEqual(external);
  checkpoint(async () => {});
  await context.exclude(key);
  expect(await context.scope()).toEqual([retained, added]);
});

test('direct note inclusion settles an exact published archive receipt before changing scope', async ({ localVault }) => {
  const { root, vault, scopeFile, context } = localVault;
  const archived = await authoredNote(vault, 'archived');
  const added = await authoredNote(vault, 'later');
  const receipt = path.join(path.dirname(scopeFile), '.archive-note-scope-publication.json');
  const file = path.join(root, 'reviewed-history.json');
  const settingsPath = path.join(root, 'settings.json');
  await fs.writeFile(settingsPath, JSON.stringify({ vault: vault.vault, parent: 'Companion' }));
  await fs.writeFile(path.join(root, 'archive-dialog.json'), JSON.stringify({ save: file, open: file }));
  await context.include([archived]);
  const clock = () => ({ now });
  const history = new Conversations({ dataRoot: root, getVault: () => vault, clock });
  const handlers = new Map();
  installArchives({
    ipcMain: { handle: (channel, handler) => handlers.set(channel, handler) }, history, settingsPath,
    testRoot: root, clock, checkpoint: async () => {}, appVersion: '0.1.0', invalidateContextApprovals: () => {}
  });
  const call = (channel, input) => handlers.get(channel)(null, input);
  const preview = await call('archive-preview');
  await call('archive-export', { id: preview.id });
  await fs.unlink(scopeFile);
  const inspected = await call('archive-inspect');
  const matched = await call('archive-match', { id: inspected.id, matched: true, settingsMode: 'review-note-inclusions' });
  expect(matched.noteCandidates).toEqual([expect.objectContaining({ file: archived })]);

  const unlink = fs.unlink;
  let retainedStage;
  fs.unlink = async target => {
    if (path.dirname(target) === path.dirname(scopeFile) && /^notes-.*\.tmp$/.test(path.basename(target))) {
      retainedStage = target;
      throw Object.assign(Error('Controlled cleanup refusal for the published archive stage.'), { code: 'EACCES' });
    }
    return unlink(target);
  };
  try {
    await expect(call('archive-restore', { token: matched.token, noteFiles: [archived] })).rejects.toThrow(/restored 1 reviewed note inclusion/i);
  } finally { fs.unlink = unlink; }
  expect(retainedStage).toBeDefined();
  expect((await fs.lstat(scopeFile)).nlink).toBe(2);
  expect(await fs.readFile(retainedStage)).toEqual(scopeBytes([archived]));
  expect(JSON.parse(await fs.readFile(receipt, 'utf8')).stage).toBe(path.basename(retainedStage));

  await context.include([added]);
  expect(await context.scope()).toEqual([archived, added]);
  expect.soft(await fs.lstat(retainedStage).catch(error => error.code)).toBe('ENOENT');
  expect.soft(await fs.lstat(receipt).catch(error => error.code)).toBe('ENOENT');
  expect((await fs.lstat(scopeFile)).nlink).toBe(1);
  expect(await call('archive-preview')).toMatchObject({ count: 0, vaults: 1 });
});
