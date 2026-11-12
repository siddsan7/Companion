const { test, expect, _electron: electron } = require('@playwright/test');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const fixture = require('./fixtures/reel-draft/example.json');

let root, app, page;
const sourceHash = 'a'.repeat(64);
test.beforeEach(async () => { root = await fs.mkdtemp(path.join(os.tmpdir(), 'companion-detach-deletion-')); });
test.afterEach(async () => { if (app) await app.close(); app = null; await fs.rm(root, { recursive: true, force: true }); });

async function artifact(name, attempt) {
  const folder = path.join(root, 'producer', name); await fs.mkdir(folder, { recursive: true });
  await fs.writeFile(path.join(folder, 'run.json'), JSON.stringify({ job_id: 'b'.repeat(64), attempt_id: attempt.repeat(32), started_utc: '2026-11-01T10:00:00Z', input_sha256: sourceHash, input_kind: 'local_video', result_kind: 'local_video_unreviewed', state: 'partial', validation: 'passed' }));
  await fs.writeFile(path.join(folder, 'evidence.json'), JSON.stringify({ ...fixture.input, clip_id: 'b'.repeat(64) }));
  await fs.writeFile(path.join(folder, 'first-pass-target.json'), JSON.stringify(fixture.target));
  await fs.copyFile(path.join(__dirname, 'fixtures/reel-draft/notes.md'), path.join(folder, 'notes.md'));
}
async function launch() {
  await fs.writeFile(path.join(root, 'clock.json'), JSON.stringify({ now: '2026-11-08T06:59:00Z', timezone: 'America/Phoenix' }));
  app = await electron.launch({ args: ['.'], env: { ...process.env, COMPANION_TEST_ROOT: root } });
  page = await app.firstWindow();
}
async function files(folder, prefix = '') {
  const result = {};
  for (const entry of (await fs.readdir(folder, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    const name = prefix + entry.name, file = path.join(folder, entry.name);
    if (entry.isDirectory()) Object.assign(result, await files(file, name + '/'));
    else {
      const bytes = await fs.readFile(file), info = await fs.lstat(file, { bigint: true });
      result[name] = { bytes: bytes.toString('base64'), sha256: createHash('sha256').update(bytes).digest('hex'), dev: String(info.dev), ino: String(info.ino), size: String(info.size), nlink: String(info.nlink) };
    }
  }
  return result;
}
async function exists(file) { return fs.access(file).then(() => true, error => { if (error.code === 'ENOENT') return false; throw error; }); }
async function checkpoint(name) {
  await expect.poll(() => fs.readFile(path.join(root, 'checkpoint.txt'), 'utf8').catch(error => { if (error.code === 'ENOENT') return ''; throw error; })).toBe(name);
}
async function observe(testInfo, name, base, extra = {}) {
  const observed = { ...extra, files: await files(base) };
  await fs.writeFile(testInfo.outputPath(name + '.json'), JSON.stringify(observed, null, 2));
  return observed.files;
}
async function exitMain(testInfo, boundary) {
  const child = app.process(), mainPid = await app.evaluate(() => process.pid);
  const proof = { boundary, wrapperPid: child.pid, mainPid, exitBoundary: 'Electron app.exit(77)' };
  const exited = new Promise(resolve => child.once('exit', (code, signal) => resolve({ code, signal })));
  const abrupt = app.evaluate(({ app: electronApp }) => electronApp.exit(77)).catch(error => { if (!/closed|disposed/i.test(error.message)) throw error; });
  proof.wrapperExit = await exited; await abrupt;
  await expect.poll(() => { try { process.kill(mainPid, 0); return 'alive'; } catch (error) { if (error.code === 'ESRCH') return 'exited'; throw error; } }).toBe('exited');
  proof.mainExited = true;
  await fs.writeFile(testInfo.outputPath('cleaned-process-exit.json'), JSON.stringify(proof, null, 2)); app = null;
}

test('ordinary restart finishes actual restored-backup detach before complete source-only deletion', async ({}, testInfo) => {
  test.setTimeout(150000);
  await artifact('first', '1'); await launch();
  await page.getByRole('button', { name: 'Choose vault', exact: true }).click();
  await page.getByRole('button', { name: 'Use this folder', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('Vault ready.');
  await page.getByLabel('Draft source folder').fill(path.join(root, 'producer'));
  await page.getByRole('checkbox', { name: 'Scan existing drafts now' }).check();
  await page.getByRole('button', { name: 'Connect draft source', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('Intake check complete');

  // Create writing through the normal UI before the interrupted source update.
  await page.getByRole('button', { name: 'Inspect source', exact: true }).click();
  await page.getByLabel('New annotation').fill('DETACH_INDEPENDENT_ANNOTATION retains my interpretation and its quotation.');
  await page.getByRole('button', { name: 'Save annotation', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('Annotation saved.');
  const base = path.join(root, 'vault', 'Companion'), intake = path.join(base, '.intake'), ledgerFile = path.join(intake, 'ledger.json');
  const original = JSON.parse(await fs.readFile(ledgerFile, 'utf8')), capture = original.captures[sourceHash];
  const current = path.join(base, 'Captures', capture.file), currentBytes = await fs.readFile(current);
  const writing = Object.fromEntries(Object.entries(await files(base)).filter(([name]) => name.startsWith('Annotations/')));
  expect(Object.keys(writing)).toHaveLength(1);
  await artifact('second', '2');
  const producers = await files(path.join(root, 'producer'));

  await fs.writeFile(path.join(root, 'faults.json'), JSON.stringify({ pause: 'intake-capture-staged' }));
  // The public intake bridge avoids renderer refresh automatically detaching the
  // just-restored pair before it can be observed. Deletion below uses rendered UI.
  const checking = page.evaluate(() => window.companion['check-intake']());
  await checkpoint('intake-capture-staged');
  const tx = JSON.parse(await fs.readFile(path.join(intake, 'transaction.json'), 'utf8'));
  const incoming = path.join(intake, tx.revision.id + '.stage'), outside = path.join(root, 'outside-incoming');
  const backup = path.join(intake, tx.backup), intentFile = backup + '.detach.json';
  const snapshotA = path.join(base, 'Revisions', capture.currentRevision + '.json');
  const snapshotB = path.join(base, 'Revisions', tx.revision.id + '.json'), snapshotStage = path.join(intake, tx.revision.id + '.snapshot.stage');
  await observe(testInfo, 'incoming-staged', base, { tx });
  expect(tx.sourceHash).toBe(sourceHash); expect(tx.capture.id).toBe(capture.id);
  expect(tx.revision.id).not.toBe(capture.currentRevision);
  expect(await exists(current)).toBe(false);
  const incomingIdentity = await fs.lstat(incoming, { bigint: true });
  await fs.link(incoming, outside);
  expect(await fs.lstat(outside, { bigint: true })).toMatchObject({ dev: incomingIdentity.dev, ino: incomingIdentity.ino, nlink: 2n });
  await fs.writeFile(path.join(root, 'release.txt'), 'continue'); const bridgeResult = await checking;

  const conflicted = JSON.parse(await fs.readFile(ledgerFile, 'utf8')), archive = path.join(intake, conflicted.blocks[sourceHash].journal);
  const restored = await observe(testInfo, 'writer-restored-pair', base, { bridgeResult, ledger: conflicted });
  const relative = file => path.relative(base, file).split(path.sep).join('/');
  const pair = [restored[relative(current)], restored[relative(backup)]];
  expect(pair.map(item => item.nlink)).toEqual(['2', '2']);
  expect([pair[0].dev, pair[0].ino]).toEqual([pair[1].dev, pair[1].ino]);
  expect(await fs.readFile(current)).toEqual(currentBytes); expect(await fs.readFile(backup)).toEqual(currentBytes);
  expect(JSON.parse(await fs.readFile(archive, 'utf8'))).toEqual(tx);
  expect(conflicted.attempts).toEqual(original.attempts); expect(conflicted.admissions).toEqual(original.admissions);
  expect(conflicted.attempts[tx.revision.identity]).toBeUndefined();
  expect(conflicted.captures[sourceHash].revisions).toEqual(capture.revisions);
  await app.close(); app = null;
  // Remove only the controlled outside alias. The actual writer pair stays intact.
  await fs.unlink(outside);
  expect(await fs.lstat(incoming, { bigint: true })).toMatchObject({ dev: incomingIdentity.dev, ino: incomingIdentity.ino, nlink: 1n });
  await fs.unlink(path.join(root, 'release.txt'));
  await fs.writeFile(path.join(root, 'faults.json'), JSON.stringify({ pause: 'intake-restored-backup-cleaned' }));
  await launch(); await checkpoint('intake-restored-backup-cleaned');
  const intent = JSON.parse(await fs.readFile(intentFile, 'utf8'));
  const retained = backup + '.detached-' + intent.id, independent = backup + '.independent';
  const initialTargets = [current, snapshotA, snapshotB, snapshotStage, incoming, archive, backup, intentFile];
  const cleaned = await observe(testInfo, 'cleaned-before-exit', base, { intent, targets: initialTargets.map(relative), ledger: JSON.parse(await fs.readFile(ledgerFile, 'utf8')) });
  const sourceLeaves = tree => Object.keys(tree).filter(name => /^(Captures\/|Revisions\/)/.test(name) || name.startsWith('.intake/') && name !== '.intake/ledger.json').sort();
  expect(sourceLeaves(cleaned)).toEqual(initialTargets.map(relative).sort());
  expect(sourceLeaves(cleaned)).toHaveLength(8);
  expect(intent.sourceHash).toBe(sourceHash); expect(intent.captureId).toBe(capture.id);
  expect(await exists(independent)).toBe(false); expect(await exists(retained)).toBe(false);
  for (const file of [current, backup]) { expect(cleaned[relative(file)].nlink).toBe('1'); expect(await fs.readFile(file)).toEqual(currentBytes); }
  expect(cleaned[relative(current)].ino).not.toBe(cleaned[relative(backup)].ino);
  expect(cleaned[relative(snapshotB)].nlink).toBe('2'); expect(cleaned[relative(snapshotStage)].nlink).toBe('2');
  expect(cleaned[relative(snapshotB)].ino).toBe(cleaned[relative(snapshotStage)].ino);
  expect(await fs.readFile(incoming, 'utf8')).toBe(tx.content);
  expect(await files(path.join(root, 'producer'))).toEqual(producers);
  await exitMain(testInfo, 'intake-restored-backup-cleaned');

  // Normal startup, with no access failure, must finish the exact cleanup.
  await fs.writeFile(path.join(root, 'faults.json'), '{}'); await launch();
  await expect(page.getByRole('button', { name: 'Delete capture', exact: true })).toBeVisible();
  const targets = initialTargets.filter(file => file !== intentFile);
  const recovered = await observe(testInfo, 'ordinary-restart-recovered', base, { targets: targets.map(relative), ledger: JSON.parse(await fs.readFile(ledgerFile, 'utf8')) });
  expect(sourceLeaves(recovered)).toEqual(targets.map(relative).sort());
  expect(await exists(intentFile)).toBe(false); expect(await exists(independent)).toBe(false); expect(await exists(retained)).toBe(false);
  for (const file of targets) expect(recovered[relative(file)]).toEqual(cleaned[relative(file)]);
  const recoveredLedger = JSON.parse(await fs.readFile(ledgerFile, 'utf8'));
  expect(recoveredLedger.attempts).toEqual(original.attempts); expect(recoveredLedger.admissions).toEqual(original.admissions);
  expect(recoveredLedger.captures[sourceHash].currentRevision).toBe(capture.currentRevision);
  expect(recoveredLedger.captures[sourceHash].revisions).toEqual(capture.revisions);

  const before = await files(base);
  await page.getByRole('button', { name: 'Delete capture', exact: true }).click();
  let preview = page.getByLabel('Capture deletion preview'); await expect(preview).toBeVisible();
  const reviewPaths = async () => preview.locator('p').allTextContents().then(lines => lines.filter(line => line.startsWith('Remove: ')).map(line => line.slice(8)).sort());
  const expectedPaths = targets.map(file => path.relative(path.join(root, 'vault'), file).split(path.sep).join('/')).sort();
  await fs.writeFile(testInfo.outputPath('rendered-deletion-review.json'), JSON.stringify({ paths: await reviewPaths(), text: await preview.innerText() }, null, 2));
  expect(await reviewPaths()).toEqual(expectedPaths);
  await expect(preview.getByRole('checkbox', { name: 'Current capture and all snapshots', exact: true })).toBeChecked();
  await expect(preview).toContainText('DETACH_INDEPENDENT_ANNOTATION');
  await expect(preview).toContainText('unavailable'); expect(await files(base)).toEqual(before);
  await preview.getByRole('button', { name: 'Cancel capture deletion', exact: true }).click();
  await expect(preview).toBeHidden(); expect(await files(base)).toEqual(before);
  await page.getByRole('button', { name: 'Delete capture', exact: true }).click();
  preview = page.getByLabel('Capture deletion preview'); await expect(preview).toBeVisible();
  expect(await reviewPaths()).toEqual(expectedPaths);
  await preview.getByRole('button', { name: 'Confirm capture deletion', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('Capture deleted');
  await expect(page.getByRole('status')).toContainText('supporting evidence is unavailable');

  async function verifyDeleted(name) {
    const ledger = JSON.parse(await fs.readFile(ledgerFile, 'utf8'));
    const observed = await observe(testInfo, name, base, { ledger });
    expect(sourceLeaves(observed)).toEqual([]);
    for (const file of [...initialTargets, independent, retained]) expect(await exists(file)).toBe(false);
    expect(ledger.sourceAuthority[capture.id].phase).toBe('deleted'); expect(ledger.suppressed).toContain(sourceHash);
    expect(ledger.attempts).toEqual(original.attempts); expect(ledger.admissions).toEqual(original.admissions);
    expect(ledger.blocks[sourceHash]).toBeUndefined(); expect(ledger.pending[sourceHash]).toBeUndefined();
    for (const [name, expected] of Object.entries(writing)) expect(observed[name]).toEqual(expected);
    expect(await files(path.join(root, 'producer'))).toEqual(producers);
    await expect(page.locator('#captures article')).toHaveCount(0);
    return ledger;
  }
  const deleted = await verifyDeleted('confirmed-purge');
  expect(deleted.sourceAuthority[capture.id].targets.map(target => target.file).sort()).toEqual(expectedPaths);
  const observedB = deleted.sourceAuthority[capture.id].purgedProducerAttempts.find(item => item.identity === tx.revision.identity);
  expect(observedB).toEqual({ identity: tx.revision.identity, fingerprint: tx.revision.fingerprint, sourceHash, captureId: capture.id, revisionId: tx.revision.id, sourceGeneration: tx.sourceGeneration || null, operationId: deleted.sourceAuthority[capture.id].operationId });
  await page.getByRole('button', { name: 'Check now', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('Intake check complete');
  const checked = await verifyDeleted('suppressed-check');
  expect(checked.lastCheck.status).toBe('held');
  expect(checked.outcomes[tx.key].reason).toContain('suppressed');
  await app.close(); app = null; await launch();
  await expect(page.locator('#timezone')).toContainText('America/Phoenix');
  await verifyDeleted('suppressed-restart');
});
