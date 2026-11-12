const { test, expect } = require('@playwright/test');
const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
const { installConversations } = require('../app/conversations');
const { installArchives } = require('../app/archives');

const hash = text => createHash('sha256').update(text).digest('hex');

async function fixture(testInfo, checkpoint = async () => {}) {
  const root = testInfo.outputPath('local-data');
  await fs.mkdir(root, { recursive: true });
  const id = randomUUID(), vault = { root }, brief = { id: randomUUID(), version: 1, digest: 'a'.repeat(64) };
  const scope = { version: randomUUID(), excludedSources: [], excludedHistory: [] };
  const startedAt = '2026-11-11T00:00:00Z';
  const turn = (question, reply) => {
    const text = `Stored package for ${question}`;
    return { id: randomUUID(), question, reply, speculation: false, status: 'completed', startedAt, completedAt: startedAt, usage: null,
      package: { schema: 1, text, digest: hash(text), count: text.length, limit: 32000, blocked: false, question, speculation: false, scope, brief, vault,
        capacityBinding: null, boundEvidence: null, historyDigest: null, warnings: [], historyExclusions: [], excludedHistory: [], dependencies: [], historyIds: [] } };
  };
  const requests = [turn('Remove this question', 'Remove this reply'), turn('Keep this question', 'Keep this reply')];
  const record = { schema: 1, id, vault, brief, scope, createdAt: startedAt, requests };
  const directory = path.join(root, 'conversations'), file = path.join(directory, `${id}.json`);
  await fs.mkdir(directory);
  await fs.writeFile(file, JSON.stringify(record));
  const install = (onCheckpoint = async () => {}) => {
    const handlers = new Map();
    const ipcMain = { handle: (name, handler) => handlers.set(name, handler) };
    const history = installConversations({ ipcMain, dataRoot: root, getVault: () => vault, checkpoint: onCheckpoint });
    installArchives({ ipcMain, history });
    return (name, input) => handlers.get(name)?.(null, input);
  };
  return { id, requests, record, directory, file, install, call: install(checkpoint) };
}

test('review and remove one stored request while preserving the other across restart', async ({}, testInfo) => {
  const { id, requests: [removed, kept], call, install, file } = await fixture(testInfo);
  const preview = await call('conversation-request-remove-preview', { id, requestId: removed.id });
  expect(preview).toMatchObject({ id, request: { id: removed.id, question: removed.question, reply: removed.reply, package: { text: removed.package.text } } });
  expect((await call('conversation-list')).conversations[0].requests).toHaveLength(2);
  await call('conversation-request-remove-confirm', { token: preview.token });
  const afterRestart = await install()('conversation-list');
  expect(afterRestart.conversations[0].requests).toEqual([kept]);
  const bytes = await fs.readFile(file, 'utf8');
  expect(bytes).not.toContain(removed.question);
  expect(bytes).not.toContain(removed.reply);
  expect(bytes).not.toContain(removed.package.text);
  expect(afterRestart.conversations[0].removedRequests).toEqual([removed.id]);
});

test('a committed request removal floor holds old history until its exact reviewed replacement resumes', async ({}, testInfo) => {
  const interrupt = async name => { if (name === 'conversation-request-removal-authorized') throw Error('Simulated exit before canonical replacement.'); };
  const { id, requests: [removed, kept], call, install, file, directory } = await fixture(testInfo, interrupt);
  const original = await fs.readFile(file), preview = await call('conversation-request-remove-preview', { id, requestId: removed.id });
  await expect(call('conversation-request-remove-confirm', { token: preview.token })).rejects.toThrow('Simulated exit');
  expect(await fs.readFile(file)).toEqual(original);
  const controlBytes = await fs.readFile(path.join(directory, '.control', `${id}.json`), 'utf8');
  expect(controlBytes).toContain(removed.id);
  expect(controlBytes).not.toContain(removed.question);
  expect(controlBytes).not.toContain(removed.reply);
  const restarted = install();
  expect((await restarted('conversation-list')).conversations).toEqual([]);
  expect(await restarted('conversation-request-remove-pending')).toEqual([{ id, requestId: removed.id, canResume: true }]);
  const { requestRemoval } = JSON.parse(controlBytes), stage = path.join(directory, requestRemoval.stage.name), owned = stage + '.held';
  await fs.rename(stage, owned);
  await fs.copyFile(owned, stage);
  await expect(restarted('conversation-request-remove-preview', { id, requestId: removed.id, resume: true })).rejects.toThrow(/staging file.*changed/i);
  expect(await fs.readFile(file)).toEqual(original);
  expect(await fs.readFile(stage)).toEqual(await fs.readFile(owned));
  await fs.unlink(stage);
  await fs.rename(owned, stage);
  const reviewed = await restarted('conversation-request-remove-preview', { id, requestId: removed.id, resume: true });
  expect(reviewed).toMatchObject({ id, request: removed, resume: true });
  await restarted('conversation-request-remove-confirm', { token: reviewed.token });
  expect((await restarted('conversation-list')).conversations[0].requests).toEqual([kept]);
  expect(await restarted('conversation-request-remove-pending')).toEqual([]);
});

test('selected request removal preserves a later same-conversation stage and asks for a new review', async ({}, testInfo) => {
  const { id, requests: [removed], record, call, directory, file } = await fixture(testInfo);
  const preview = await call('conversation-request-remove-preview', { id, requestId: removed.id });
  expect(preview?.token).toBeTruthy();
  const stage = path.join(directory, `${randomUUID()}.pending`), original = await fs.readFile(file);
  await fs.writeFile(stage, original);
  await expect(call('conversation-request-remove-confirm', { token: preview.token })).rejects.toThrow(/pending/i);
  expect(await fs.readFile(stage)).toEqual(original);
  expect(await fs.readFile(file)).toEqual(original);
  expect((await call('conversation-list')).conversations).toEqual([record]);
});

test('request removal explicitly retires the exact replacement copy left before writing control', async ({}, testInfo) => {
  const checkpoint = async name => { if (name === 'conversation-request-removal-payload-staged') throw Error('Simulated exit before writing control.'); };
  const { id, requests: [removed, kept], call, install, file, directory } = await fixture(testInfo, checkpoint);
  const original = await fs.readFile(file), preview = await call('conversation-request-remove-preview', { id, requestId: removed.id });
  await expect(call('conversation-request-remove-confirm', { token: preview.token })).rejects.toThrow('Simulated exit');
  const [name] = (await fs.readdir(directory)).filter(name => name.startsWith('.request-removal-'));
  expect(name).toMatch(/^\.request-removal-.*\.tmp$/);
  const stage = path.join(directory, name), staged = await fs.readFile(stage);
  await expect(fs.lstat(path.join(directory, '.control'))).rejects.toThrow(/ENOENT/);

  const restarted = install();
  expect(await restarted('conversation-request-remove-pending')).toEqual([]);
  await expect(restarted('archive-preview')).rejects.toThrow(/unresolved local history pending files/i);
  const archiveReview = await restarted('archive-review-pending');
  expect(archiveReview.records).toMatchObject([{ name, kind: 'validated-conversation' }]);
  expect(await restarted('archive-preview', { savedOnly: true, recoveryId: archiveReview.id })).toMatchObject({ count: 1, omitted: 1 });
  const whole = await restarted('conversation-delete-preview', { id });
  expect(whole.targets).toContain(name);
  expect(whole.pending).toEqual([{ name, text: staged.toString('utf8') }]);
  await restarted('conversation-delete-cancel', { token: whole.token });
  expect(await fs.readFile(file)).toEqual(original);

  const fresh = await restarted('conversation-request-remove-preview', { id, requestId: removed.id });
  expect(fresh.copies).toEqual([{ name, text: staged.toString('utf8') }]);
  await restarted('conversation-request-remove-confirm', { token: fresh.token });
  expect((await restarted('conversation-list')).conversations[0].requests).toEqual([kept]);
  await expect(fs.readFile(stage)).rejects.toThrow(/ENOENT/);
  expect(await restarted('archive-preview')).toMatchObject({ count: 1, omitted: 0 });
});

test('whole conversation deletion reviews and removes its exact reserved request staging copy', async ({}, testInfo) => {
  const checkpoint = async name => { if (name === 'conversation-request-removal-payload-staged') throw Error('Simulated exit before writing control.'); };
  const { id, requests: [selected], call, install, file, directory } = await fixture(testInfo, checkpoint);
  const first = await call('conversation-request-remove-preview', { id, requestId: selected.id });
  await expect(call('conversation-request-remove-confirm', { token: first.token })).rejects.toThrow('Simulated exit');
  const [name] = (await fs.readdir(directory)).filter(name => name.startsWith('.request-removal-'));
  const restarted = install(), whole = await restarted('conversation-delete-preview', { id });
  expect(whole.targets).toEqual([name, path.basename(file)].sort());
  expect(whole.pending.map(item => item.name)).toEqual([name]);
  await restarted('conversation-delete-confirm', { token: whole.token });
  await expect(fs.readFile(file)).rejects.toThrow(/ENOENT/);
  await expect(fs.readFile(path.join(directory, name))).rejects.toThrow(/ENOENT/);
  expect((await restarted('conversation-list')).conversations).toEqual([]);
});

test('request removal reviews an earlier copy containing the selected request and holds edits and noncanonical names', async ({}, testInfo) => {
  const checkpoint = async name => { if (name === 'conversation-request-removal-payload-staged') throw Error('Simulated exit before writing control.'); };
  const { id, requests: [earlier, selected], call, install, file, directory } = await fixture(testInfo, checkpoint);
  const first = await call('conversation-request-remove-preview', { id, requestId: earlier.id });
  await expect(call('conversation-request-remove-confirm', { token: first.token })).rejects.toThrow('Simulated exit');
  const [name] = (await fs.readdir(directory)).filter(name => name.startsWith('.request-removal-'));
  const stage = path.join(directory, name), staged = await fs.readFile(stage), original = await fs.readFile(file);
  expect(JSON.parse(staged).requests).toEqual([selected]);

  const alternate = stage + '.held', upper = path.join(directory, name.toUpperCase());
  await fs.rename(stage, alternate);
  await fs.rename(alternate, upper);
  const restarted = install();
  expect((await restarted('archive-review-pending')).records).toMatchObject([{ name: name.toUpperCase() }]);
  await expect(restarted('conversation-request-remove-preview', { id, requestId: selected.id })).rejects.toThrow(/staging file.*contains selected writing/i);
  expect(await fs.readFile(upper)).toEqual(staged);
  await fs.rename(upper, alternate);
  await fs.rename(alternate, stage);

  const reviewed = await restarted('conversation-request-remove-preview', { id, requestId: selected.id });
  expect(reviewed.copies).toEqual([{ name, text: staged.toString('utf8') }]);
  const altered = JSON.parse(staged);
  altered.requests[0].reply = 'Independent writing in the staging file must remain.';
  const changed = JSON.stringify(altered, null, 2);
  await fs.writeFile(stage, changed);
  await expect(restarted('conversation-request-remove-confirm', { token: reviewed.token })).rejects.toThrow(/staging file.*contains selected writing|pending.*changed/i);
  expect(await fs.readFile(stage, 'utf8')).toBe(changed);
  expect(await fs.readFile(file)).toEqual(original);
  await fs.writeFile(stage, staged);

  const interrupted = install(async name => { if (name === 'conversation-request-removal-copies-retired') throw Error('Simulated exit after retiring copies.'); });
  const selectedReview = await interrupted('conversation-request-remove-preview', { id, requestId: selected.id });
  await expect(interrupted('conversation-request-remove-confirm', { token: selectedReview.token })).rejects.toThrow('Simulated exit after retiring copies');
  await expect(fs.readFile(stage)).rejects.toThrow(/ENOENT/);
  expect(await fs.readFile(file)).toEqual(original);

  const resume = install();
  await fs.writeFile(stage, staged, { flag: 'wx' });
  await expect(resume('conversation-request-remove-preview', { id, requestId: selected.id, resume: true })).rejects.toThrow(/request removal changed/i);
  expect(await fs.readFile(stage)).toEqual(staged);
  await fs.rename(stage, alternate);
  const remaining = await resume('conversation-request-remove-preview', { id, requestId: selected.id, resume: true });
  expect(remaining.copies).toEqual([]);
  await resume('conversation-request-remove-confirm', { token: remaining.token });
  expect((await resume('conversation-list')).conversations[0].requests).toEqual([earlier]);
  expect(await fs.readFile(alternate)).toEqual(staged);
});

test('request removal rejects a foreign conversation named by an edited unpublished control with an exact proof', async ({}, testInfo) => {
  const checkpoint = async name => { if (name === 'conversation-request-removal-before-control-publication') throw Error('Simulated exit before control publication.'); };
  const { id, requests: [selected], record, call, install, file, directory } = await fixture(testInfo, checkpoint);
  const original = await fs.readFile(file), preview = await call('conversation-request-remove-preview', { id, requestId: selected.id });
  await expect(call('conversation-request-remove-confirm', { token: preview.token })).rejects.toThrow('Simulated exit');
  const controls = path.join(directory, '.control'), [controlName] = await fs.readdir(controls), control = path.join(controls, controlName);
  const marker = JSON.parse(await fs.readFile(control, 'utf8'));
  const name = `.request-removal-${randomUUID()}.tmp`, foreign = path.join(directory, name);
  const foreignBytes = Buffer.from(JSON.stringify({ ...record, id: randomUUID() }, null, 2));
  await fs.writeFile(foreign, foreignBytes, { flag: 'wx' });
  const stat = await fs.lstat(foreign, { bigint: true });
  marker.requestRemoval.copies = [{ name, proof: { dev: String(stat.dev), ino: String(stat.ino), digest: hash(foreignBytes) } }];
  await fs.writeFile(control, JSON.stringify(marker, null, 2));

  const restarted = install();
  expect(await restarted('conversation-request-remove-pending')).toMatchObject([{ id, requestId: selected.id, publication: marker.publication, canResume: false }]);
  await expect(restarted('conversation-request-remove-preview', { id, requestId: selected.id, publication: marker.publication, resume: true })).rejects.toThrow(/unverified ownership/i);
  expect(await fs.readFile(foreign)).toEqual(foreignBytes);
  expect(await fs.readFile(file)).toEqual(original);
  await expect(fs.readFile(path.join(controls, `${id}.json`))).rejects.toThrow(/ENOENT/);
});

test('request removal preserves reviewed copies when the authorized replacement stage is substituted', async ({}, testInfo) => {
  const checkpoint = async name => { if (name === 'conversation-request-removal-payload-staged') throw Error('Simulated exit before writing control.'); };
  const { id, requests: [selected], call, install, file, directory } = await fixture(testInfo, checkpoint);
  const original = await fs.readFile(file), first = await call('conversation-request-remove-preview', { id, requestId: selected.id });
  await expect(call('conversation-request-remove-confirm', { token: first.token })).rejects.toThrow('Simulated exit');
  const [name] = (await fs.readdir(directory)).filter(name => name.startsWith('.request-removal-'));
  const orphan = path.join(directory, name), orphanBytes = await fs.readFile(orphan);
  let replacement, originalStage, replacementBytes;
  const restarted = install(async name => {
    if (name !== 'conversation-request-removal-authorized') return;
    const marker = JSON.parse(await fs.readFile(path.join(directory, '.control', `${id}.json`), 'utf8'));
    replacement = path.join(directory, marker.requestRemoval.stage.name);
    originalStage = replacement + '.held';
    replacementBytes = await fs.readFile(replacement);
    await fs.rename(replacement, originalStage);
    await fs.writeFile(replacement, replacementBytes, { flag: 'wx' });
  });
  const preview = await restarted('conversation-request-remove-preview', { id, requestId: selected.id });
  expect(preview.copies).toEqual([{ name, text: orphanBytes.toString('utf8') }]);
  await expect(restarted('conversation-request-remove-confirm', { token: preview.token })).rejects.toThrow(/staging file.*changed/i);
  expect(await fs.readFile(file)).toEqual(original);
  expect(await fs.readFile(orphan)).toEqual(orphanBytes);
  expect(await fs.readFile(replacement)).toEqual(replacementBytes);
  expect(await fs.readFile(originalStage)).toEqual(replacementBytes);
});

for (const prior of [false, true]) test(`request removal re-previews an exact unpublished control ${prior ? 'replacement' : 'first publication'}`, async ({}, testInfo) => {
  let interrupt = false;
  const checkpoint = async name => {
    if (interrupt && name === 'conversation-request-removal-before-control-publication') throw Error('Simulated exit before control publication.');
  };
  const { id, requests, call, install, file, directory } = await fixture(testInfo, checkpoint);
  if (prior) {
    const first = await call('conversation-request-remove-preview', { id, requestId: requests[0].id });
    await call('conversation-request-remove-confirm', { token: first.token });
  }
  const requestId = requests[Number(prior)].id, original = await fs.readFile(file);
  const preview = await call('conversation-request-remove-preview', { id, requestId });
  interrupt = true;
  await expect(call('conversation-request-remove-confirm', { token: preview.token })).rejects.toThrow('Simulated exit');
  expect(await fs.readFile(file)).toEqual(original);
  const controls = path.join(directory, '.control'), files = await fs.readdir(controls);
  expect(files.filter(name => name.endsWith('.json'))).toEqual(prior ? [`${id}.json`] : []);
  expect(files.filter(name => name.endsWith('.pending'))).toHaveLength(1);

  const restarted = install();
  if (!prior) {
    const stagedControl = path.join(controls, files.find(name => name.endsWith('.pending')));
    const exact = await fs.readFile(stagedControl), changed = JSON.parse(exact);
    changed.scope.excludedHistory = [randomUUID()];
    await fs.writeFile(stagedControl, JSON.stringify(changed, null, 2));
    expect(await restarted('conversation-request-remove-pending')).toMatchObject([{ id, requestId, canResume: false }]);
    await fs.writeFile(stagedControl, exact);
  }
  const [pending] = await restarted('conversation-request-remove-pending');
  expect(pending).toMatchObject({ id, requestId, canResume: true });
  const recovered = await restarted('conversation-request-remove-preview', { id, requestId, publication: pending.publication, resume: true });
  expect(recovered).toMatchObject({ id, request: { id: requestId }, unpublished: true });
  expect(await fs.readFile(file)).toEqual(original);
  await restarted('conversation-request-remove-confirm', { token: recovered.token });
  expect(await fs.readdir(controls)).toEqual([`${id}.json`]);
  expect(await restarted('conversation-request-remove-pending')).toEqual([]);
  const [record] = (await restarted('conversation-list')).conversations;
  expect(record.requests).toEqual(prior ? [] : [requests[1]]);
  expect(record.removedRequests).toEqual(prior ? requests.map(request => request.id) : [requestId]);
});
