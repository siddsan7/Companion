const { test, expect, _electron: electron } = require('@playwright/test');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const fixture = require('./fixtures/reel-draft/example.json');
let root, app, page;

test.beforeEach(async () => { root = await fs.mkdtemp(path.join(os.tmpdir(), 'companion-deletion-')); });
test.afterEach(async () => { if (app) await app.close(); app = null; await fs.rm(root, { recursive: true, force: true }); });
async function artifact(name, attempt) {
  const folder = path.join(root, 'producer', name); await fs.mkdir(folder, { recursive: true });
  await fs.writeFile(path.join(folder, 'run.json'), JSON.stringify({ job_id: 'b'.repeat(64), attempt_id: attempt.repeat(32), started_utc: '2026-11-01T10:00:00Z', input_sha256: 'a'.repeat(64), input_kind: 'local_video', result_kind: 'local_video_unreviewed', state: 'partial', validation: 'passed' }));
  await fs.writeFile(path.join(folder, 'evidence.json'), JSON.stringify({ ...fixture.input, clip_id: 'b'.repeat(64) }));
  await fs.writeFile(path.join(folder, 'first-pass-target.json'), JSON.stringify(fixture.target));
  await fs.copyFile(path.join(__dirname, 'fixtures/reel-draft/notes.md'), path.join(folder, 'notes.md'));
}
async function launch() {
  await fs.writeFile(path.join(root, 'clock.json'), JSON.stringify({ now: '2026-11-08T06:59:00Z', timezone: 'America/Phoenix' }));
  app = await electron.launch({ args: ['.'], env: { ...process.env, COMPANION_TEST_ROOT: root } });
  page = await app.firstWindow();
  await expect(page.locator('#timezone')).toContainText('America/Phoenix');
}
async function files(folder, prefix = '') {
  const result = {};
  for (const entry of await fs.readdir(folder, { withFileTypes: true })) {
    const relative = prefix + entry.name, file = path.join(folder, entry.name);
    if (entry.isDirectory()) Object.assign(result, await files(file, relative + '/'));
    else result[relative] = (await fs.readFile(file)).toString('base64');
  }
  return result;
}

test('capture deletion previews all snapshots, cancels unchanged and preserves independent annotations on confirmation', async () => {
  await artifact('first', '1'); await launch();
  await page.getByRole('button', { name: 'Choose vault', exact: true }).click();
  await page.getByRole('button', { name: 'Use this folder', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('Vault ready.');
  await page.getByLabel('Draft source folder').fill(path.join(root, 'producer'));
  await page.getByRole('checkbox', { name: 'Scan existing drafts now' }).check();
  await page.getByRole('button', { name: 'Connect draft source', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('Intake check complete');
  await page.getByRole('button', { name: 'Inspect source', exact: true }).click();
  await page.getByLabel('New annotation').fill('My independent interpretation retains a source quotation.');
  await page.getByRole('button', { name: 'Save annotation', exact: true }).click();
  await expect(page.getByLabel('Source inspection')).toContainText('My independent interpretation');
  await artifact('second', '2');
  await page.getByRole('button', { name: 'Check now', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('Intake check complete');
  const base = path.join(root, 'vault', 'Companion'), ledgerFile = path.join(base, '.intake', 'ledger.json');
  const beforeLedger = JSON.parse(await fs.readFile(ledgerFile, 'utf8'));
  expect(Object.keys(beforeLedger.attempts)).toHaveLength(2);
  const before = await files(base), preview = page.getByLabel('Capture deletion preview');
  await page.getByRole('button', { name: 'Delete capture', exact: true }).click();
  await expect(preview.getByRole('checkbox', { name: 'Current capture and all snapshots', exact: true })).toBeChecked();
  await expect(preview).toContainText('2 revision snapshots');
  await expect(preview).toContainText('My independent interpretation');
  await expect(preview).toContainText('Automatic re-import stays suppressed until explicit restoration');
  expect(await files(base)).toEqual(before);
  await preview.getByRole('button', { name: 'Cancel capture deletion', exact: true }).click();
  await expect(preview).toBeHidden();
  expect(await files(base)).toEqual(before);
  await page.getByRole('button', { name: 'Delete capture', exact: true }).click();
  await preview.getByRole('button', { name: 'Confirm capture deletion', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('Capture deleted');
  await expect(page.locator('#captures article')).toHaveCount(0);
  const after = await files(base), ledger = JSON.parse(await fs.readFile(ledgerFile, 'utf8'));
  expect(Object.keys(after).filter(file => file.startsWith('Captures/') || file.startsWith('Revisions/'))).toEqual([]);
  for (const [file, bytes] of Object.entries(before).filter(([file]) => file.startsWith('Annotations/'))) expect(after[file]).toBe(bytes);
  expect(ledger.attempts).toEqual(beforeLedger.attempts);
  expect(ledger.suppressed).toContain('a'.repeat(64));
  expect(await fs.readFile(path.join(root, 'producer', 'first', 'run.json'), 'utf8')).toContain('11111111111111111111111111111111');
});

test('a confirmed purge survives process exit, holds changed files and resumes only its exact scope with suppression intact', async ({}, testInfo) => {
  await artifact('first', '1'); await launch();
  await page.getByRole('button', { name: 'Choose vault', exact: true }).click();
  await page.getByRole('button', { name: 'Use this folder', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('Vault ready.');
  await page.getByLabel('Draft source folder').fill(path.join(root, 'producer'));
  await page.getByRole('checkbox', { name: 'Scan existing drafts now' }).check();
  await page.getByRole('button', { name: 'Connect draft source', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('Intake check complete');
  const base = path.join(root, 'vault', 'Companion'), ledgerFile = path.join(base, '.intake', 'ledger.json');
  const before = JSON.parse(await fs.readFile(ledgerFile, 'utf8')), capture = Object.values(before.captures)[0];
  const snapshotFile = path.join(base, 'Revisions', capture.currentRevision + '.json'), snapshot = await fs.readFile(snapshotFile);
  const captureFile = path.join(base, 'Captures', capture.file), content = await fs.readFile(captureFile);
  await page.getByRole('button', { name: 'Delete capture', exact: true }).click();
  await fs.writeFile(path.join(root, 'faults.json'), JSON.stringify({ pause: 'capture-deletion-authorized' }));
  await page.getByRole('button', { name: 'Confirm capture deletion', exact: true }).click();
  await expect.poll(() => fs.readFile(path.join(root, 'checkpoint.txt'), 'utf8').catch(error => { if (error.code === 'ENOENT') return ''; throw error; })).toBe('capture-deletion-authorized');
  const committed = JSON.parse(await fs.readFile(ledgerFile, 'utf8'));
  expect(committed.suppressed).toContain('a'.repeat(64));
  expect(committed.sourceAuthority[capture.id].phase).toBe('deleting');
  expect(await fs.readFile(captureFile)).toEqual(content);
  const child = app.process(), mainPid = await app.evaluate(() => process.pid);
  const evidence = { boundary: 'capture-deletion-authorized', wrapperPid: child.pid, mainPid, exitBoundary: 'Electron app.exit(77)' };
  const exited = new Promise(resolve => child.once('exit', (code, signal) => resolve({ code, signal })));
  const abrupt = app.evaluate(({ app: electronApp }) => electronApp.exit(77)).catch(error => { if (!/closed|disposed/i.test(error.message)) throw error; });
  evidence.wrapperExit = await exited; await abrupt;
  await expect.poll(() => { try { process.kill(mainPid, 0); return 'alive'; } catch (error) { if (error.code === 'ESRCH') return 'exited'; throw error; } }).toBe('exited');
  await testInfo.attach('capture-deletion-crash-processes.json', { body: JSON.stringify(evidence, null, 2), contentType: 'application/json' });
  app = null; await fs.writeFile(path.join(root, 'faults.json'), '{}');
  const changedSnapshot = Buffer.concat([snapshot, Buffer.from('\nChanged after confirmed scope.\n')]);
  await fs.writeFile(snapshotFile, changedSnapshot);
  await launch();
  await expect(page.locator('#captures article')).toHaveCount(0);
  await page.getByRole('button', { name: 'Review capture deletion recovery', exact: true }).click();
  const recovery = page.getByLabel('Capture deletion recovery');
  await expect(recovery).toContainText(capture.id);
  await expect(recovery).toContainText('changed');
  await recovery.getByRole('button', { name: 'Resume confirmed capture deletion', exact: true }).click();
  await expect(recovery.getByRole('button', { name: 'Resume confirmed capture deletion', exact: true })).toBeEnabled();
  await expect(page.getByRole('status')).toContainText('changed');
  expect(await fs.readFile(captureFile)).toEqual(content);
  expect(await fs.readFile(snapshotFile)).toEqual(changedSnapshot);
  await fs.writeFile(snapshotFile, snapshot);
  await recovery.getByRole('button', { name: 'Resume confirmed capture deletion', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('Capture deletion complete');
  expect(await fs.access(captureFile).then(() => true, error => { if (error.code === 'ENOENT') return false; throw error; })).toBe(false);
  expect(await fs.access(snapshotFile).then(() => true, error => { if (error.code === 'ENOENT') return false; throw error; })).toBe(false);
  await page.getByRole('button', { name: 'Check now', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('Intake check complete');
  await expect(page.locator('#captures article')).toHaveCount(0);
  const completed = JSON.parse(await fs.readFile(ledgerFile, 'utf8'));
  expect(completed.sourceAuthority[capture.id].phase).toBe('deleted');
  expect(completed.attempts).toEqual(before.attempts);
  expect(completed.suppressed).toContain('a'.repeat(64));
  await app.close(); app = null; await launch();
  await expect(page.locator('#captures article')).toHaveCount(0);
  expect(JSON.parse(await fs.readFile(ledgerFile, 'utf8')).suppressed).toContain('a'.repeat(64));
});
