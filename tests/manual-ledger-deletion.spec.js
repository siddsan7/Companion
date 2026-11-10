const { test, expect, _electron: electron } = require('@playwright/test');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const YAML = require('yaml');
let root, app;

test.beforeEach(async () => { root = await fs.mkdtemp(path.join(os.tmpdir(), 'companion-manual-ledger-')); });
test.afterEach(async () => { if (app) await app.close(); app = null; await fs.rm(root, { recursive: true, force: true }); });
async function observe(file) {
  try {
    const stat = await fs.lstat(file, { bigint: true });
    return { exists: true, bytes: (await fs.readFile(file)).toString('base64'), dev: String(stat.dev), ino: String(stat.ino), nlink: String(stat.nlink), ordinary: stat.isFile() && !stat.isSymbolicLink() };
  } catch (error) { if (error.code === 'ENOENT') return { exists: false }; throw error; }
}

test('plain manual deletion holds a changed ledger before the first unlink and explicit Refresh resumes the committed scope', async ({}, testInfo) => {
  test.setTimeout(90000);
  await fs.writeFile(path.join(root, 'clock.json'), JSON.stringify({ now: '2026-11-08T06:59:00Z', timezone: 'America/Phoenix' }));
  app = await electron.launch({ args: ['.'], env: { ...process.env, COMPANION_TEST_ROOT: root } });
  const page = await app.firstWindow();
  await expect(page.locator('#timezone')).toContainText('America/Phoenix');
  await page.getByRole('button', { name: 'Choose vault', exact: true }).click();
  await page.getByRole('button', { name: 'Use this folder', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('Vault ready.');
  const body = 'MANUALLEDGERGUARD a plain thought about practising a chord.\nKeep this source until its committed authority is validated.';
  await page.getByLabel('Thought or link', { exact: true }).fill(body);
  await page.getByRole('button', { name: 'Save capture', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('Capture saved.');
  const base = path.join(root, 'vault', 'Companion'), captures = path.join(base, 'Captures');
  const names = await fs.readdir(captures);
  expect(names).toHaveLength(1); expect(names[0]).toMatch(/\.md$/);
  const source = path.join(captures, names[0]), before = await observe(source);
  expect(before.ordinary).toBe(true); expect(before.nlink).toBe('1');
  const text = Buffer.from(before.bytes, 'base64').toString('utf8');
  const metadata = YAML.parse(text.match(/^---\r?\n([\s\S]*?)\r?\n---/)[1]), id = metadata.companion_id;
  expect(text).toContain(body);
  const relative = path.relative(path.join(root, 'vault'), source).split(path.sep).join('/');
  const preview = page.getByLabel('Capture deletion preview');
  await page.getByRole('button', { name: 'Delete capture', exact: true }).click();
  await expect(preview).toBeVisible();
  expect((await preview.locator('p').allTextContents()).filter(value => value.startsWith('Remove: '))).toEqual(['Remove: ' + relative]);
  const previewText = await preview.textContent();
  await fs.writeFile(path.join(root, 'faults.json'), JSON.stringify({ pause: 'capture-deletion-authorized' }));
  const confirm = preview.getByRole('button', { name: 'Confirm capture deletion', exact: true });
  await confirm.click();
  await expect.poll(() => fs.readFile(path.join(root, 'checkpoint.txt'), 'utf8').catch(error => { if (error.code === 'ENOENT') return ''; throw error; })).toBe('capture-deletion-authorized');
  await expect(confirm).toBeDisabled();
  const ledgerFile = path.join(base, '.intake', 'ledger.json'), committed = await observe(ledgerFile);
  const prior = JSON.parse(Buffer.from(committed.bytes, 'base64').toString('utf8')), authority = prior.sourceAuthority[id];
  expect(authority.phase).toBe('deleting'); expect(authority.manual.captureId).toBe(id);
  expect(authority.inventoryVersion).toBeUndefined(); expect(authority.titleProofs).toBeUndefined();
  expect(authority.targets).toHaveLength(1); expect(authority.targets[0].file).toBe(relative);
  expect(await observe(source)).toEqual(before);
  const suppression = 'c'.repeat(64);
  expect(prior.suppressed).not.toContain(suppression);
  const foreignBytes = JSON.stringify({ ...prior, suppressed: [...prior.suppressed, suppression] }, null, 2);
  const replacement = path.join(root, 'external-ledger-replacement.json');
  await fs.writeFile(replacement, foreignBytes); await fs.rename(replacement, ledgerFile);
  const foreign = await observe(ledgerFile);
  expect(foreign.ordinary).toBe(true); expect(foreign.nlink).toBe('1');
  expect(foreign.dev).toBe(committed.dev); expect(foreign.ino).not.toBe(committed.ino);
  await fs.writeFile(path.join(root, 'release.txt'), 'continue');
  await expect(confirm).toBeEnabled();
  // Save actual source, ledger and UI outcomes before the first guard assertion.
  const afterSource = await observe(source), afterLedger = await observe(ledgerFile);
  const held = JSON.parse(Buffer.from(afterLedger.bytes, 'base64').toString('utf8'));
  const ui = { status: await page.getByRole('status').textContent(), preview: await preview.textContent(), captures: await page.locator('#captures').textContent() };
  await fs.writeFile(testInfo.outputPath('manual-ledger-before-refresh.json'), JSON.stringify({ checkpoint: 'capture-deletion-authorized', previewText, before, committed, authority, foreign, afterSource, afterLedger, phase: held.sourceAuthority[id].phase, ui }, null, 2));
  expect(afterSource).toEqual(before);
  expect(afterLedger).toEqual(foreign);
  expect(held.sourceAuthority[id]).toEqual(authority);
  expect(ui.status).toContain('ledger changed');
  await fs.writeFile(path.join(root, 'faults.json'), '{}');
  await page.getByRole('button', { name: 'Refresh', exact: true }).click();
  await expect.poll(async () => JSON.parse(await fs.readFile(ledgerFile, 'utf8')).sourceAuthority[id].phase).toBe('deleted');
  const completedSource = await observe(source), completedLedger = await observe(ledgerFile);
  const completed = JSON.parse(Buffer.from(completedLedger.bytes, 'base64').toString('utf8'));
  await fs.writeFile(testInfo.outputPath('manual-ledger-after-refresh.json'), JSON.stringify({ completedSource, completedLedger, authority: completed.sourceAuthority[id], status: await page.getByRole('status').textContent() }, null, 2));
  expect(completedSource.exists).toBe(false);
  expect(completed.sourceAuthority[id]).toEqual({ ...authority, phase: 'deleted' });
  expect(completed.suppressed).toEqual([...prior.suppressed, suppression]);
  await expect(page.locator('#captures article')).toHaveCount(0);
});
