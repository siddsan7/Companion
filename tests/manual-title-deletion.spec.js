const { test, expect, _electron: electron } = require('@playwright/test');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const YAML = require('yaml');
const { parse, withTitle } = require('../app/vault');
let root, app, page;

test.beforeEach(async () => { root = await fs.mkdtemp(path.join(os.tmpdir(), 'companion-manual-title-')); });
test.afterEach(async () => { if (app) await app.close(); app = null; await fs.rm(root, { recursive: true, force: true }); });
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
async function absent(paths) {
  for (const file of paths) expect(await fs.access(file).then(() => true, error => { if (error.code === 'ENOENT') return false; throw error; })).toBe(false);
}
async function ledger(file) {
  return fs.readFile(file, 'utf8').then(JSON.parse, error => { if (error.code === 'ENOENT') return null; throw error; });
}

test('completed manual title deletion reviews its two actual source files, cancels unchanged and purges without replay', async ({}, testInfo) => {
  test.setTimeout(120000);
  await launch();
  await page.getByRole('button', { name: 'Choose vault', exact: true }).click();
  await page.getByRole('button', { name: 'Use this folder', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('Vault ready.');
  const body = 'MANUALTITLEPROOF a personal thought about repeated guitar practice.\nThe second line is independent source body text.';
  await page.getByLabel('Thought or link', { exact: true }).fill(body);
  await page.getByRole('button', { name: 'Save capture', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('Capture saved.');
  const base = path.join(root, 'vault', 'Companion'), captures = path.join(base, 'Captures');
  const names = (await fs.readdir(captures)).filter(name => name.endsWith('.md'));
  expect(names).toHaveLength(1);
  const current = path.join(captures, names[0]), originalBytes = await fs.readFile(current), note = parse(originalBytes.toString('utf8'));
  expect(note.type).toBe('thought'); expect(note.content).toContain(body);
  const ledgerFile = path.join(base, '.intake', 'ledger.json'), originalLedger = await ledger(ledgerFile);
  const title = 'Manual title: punctuation, preserved!';
  await page.getByLabel('Display title', { exact: true }).fill(title);
  await page.getByRole('button', { name: 'Save title', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('Title saved.');
  await expect(page.getByRole('heading', { name: title, exact: true })).toBeVisible();
  const backupNames = (await fs.readdir(captures)).filter(name => name.startsWith(names[0] + '.before-title-'));
  expect(backupNames).toHaveLength(1);
  expect(backupNames[0]).toMatch(/\.md\.before-title-[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}\.bak$/);
  const backup = path.join(captures, backupNames[0]), currentBytes = await fs.readFile(current);
  expect(await fs.readFile(backup)).toEqual(originalBytes);
  // Actual writer evidence, supplemented by independent metadata/body assertions.
  expect(currentBytes).toEqual(Buffer.from(withTitle(originalBytes.toString('utf8'), title), 'utf8'));
  const parts = bytes => bytes.toString('utf8').match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)([\s\S]*)$/);
  const oldParts = parts(originalBytes), newParts = parts(currentBytes);
  expect(YAML.parse(newParts[1])).toEqual({ ...YAML.parse(oldParts[1]), title });
  expect(newParts[2]).toBe('\n# ' + title + '\n\n' + body + '\n');
  const identities = [];
  for (const file of [current, backup]) {
    const stat = await fs.lstat(file, { bigint: true });
    expect(stat.isFile()).toBe(true); expect(stat.isSymbolicLink()).toBe(false); expect(stat.nlink).toBe(1n);
    identities.push({ file: path.basename(file), dev: String(stat.dev), ino: String(stat.ino), nlink: String(stat.nlink) });
  }
  expect([identities[0].dev, identities[0].ino]).not.toEqual([identities[1].dev, identities[1].ino]);
  const residue = [current + '.pending', current + '.title-transaction.json', path.join(base, '.intake', 'title-intent.json')];
  await absent(residue); expect(await ledger(ledgerFile)).toEqual(originalLedger);
  for (const key of ['captures', 'attempts', 'admissions']) expect(Object.keys(originalLedger?.[key] || {})).toHaveLength(0);
  expect(await fs.readdir(path.join(base, 'Revisions'))).toEqual([]);
  await fs.writeFile(testInfo.outputPath('actual-manual-title-writer.json'), JSON.stringify({ identities, originalHash: createHash('sha256').update(originalBytes).digest('hex'), currentHash: createHash('sha256').update(currentBytes).digest('hex'), literalTitleTransformation: true, snapshots: 0, producerConnected: false }, null, 2));
  const relative = file => path.relative(path.join(root, 'vault'), file).split(path.sep).join('/');
  const before = await files(base), preview = page.getByLabel('Capture deletion preview');
  await page.getByRole('button', { name: 'Delete capture', exact: true }).click();
  await expect(preview).toBeVisible();
  await expect(preview).toContainText('0 revision snapshots');
  expect((await preview.locator('p').allTextContents()).filter(text => text.startsWith('Remove: ')).sort()).toEqual([current, backup].map(file => 'Remove: ' + relative(file)).sort());
  expect(await files(base)).toEqual(before);
  await preview.getByRole('button', { name: 'Cancel capture deletion', exact: true }).click();
  await expect(preview).toBeHidden(); expect(await files(base)).toEqual(before);
  await page.getByRole('button', { name: 'Delete capture', exact: true }).click();
  await preview.getByRole('button', { name: 'Confirm capture deletion', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('Capture deleted');
  const deleted = await ledger(ledgerFile), authority = deleted.sourceAuthority[note.id];
  expect(authority.phase).toBe('deleted'); expect(authority.inventoryVersion).toBe(1); expect(authority.sourceHash).toBeNull();
  expect(authority.originGenerations).toEqual([]);
  expect(authority.manual).toEqual({ captureId: note.id, type: note.type, capturedAt: note.capturedAt, currentHash: createHash('sha256').update(currentBytes).digest('hex'), file: names[0], relative: relative(current) });
  expect(authority.targets.map(target => target.file).sort()).toEqual([current, backup].map(relative).sort());
  expect(authority.targets.find(target => target.file === relative(backup)).kind).toBe('source-title-backup');
  expect(authority.titleProofs).toEqual([{ before: relative(backup), after: relative(current), sourceGeneration: null }]);
  for (const key of ['recovery', 'recoveryPointers', 'purgedProducerAttempts']) expect(authority[key]).toBeUndefined();
  for (const key of ['captures', 'attempts', 'admissions']) expect(deleted[key] || {}).toEqual(originalLedger?.[key] || {});
  expect(deleted.suppressed).toEqual(originalLedger?.suppressed || []);
  expect(JSON.stringify(authority)).not.toContain(body); expect(JSON.stringify(authority)).not.toContain(title);
  await absent([current, backup, ...residue]);
  await app.close(); app = null; await launch();
  await expect(page.locator('#idea-support-status')).toContainText('Current support inspected.');
  await expect(page.locator('#captures article')).toHaveCount(0);
  expect((await ledger(ledgerFile)).sourceAuthority[note.id]).toEqual(authority);
  await absent([current, backup, ...residue]); expect(await fs.readdir(path.join(base, 'Revisions'))).toEqual([]);
});
