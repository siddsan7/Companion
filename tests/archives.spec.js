const { test, expect, _electron: electron } = require('@playwright/test');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
let root, app, page;
test.beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'companion-archive-'));
  await fs.writeFile(path.join(root, 'clock.json'), JSON.stringify({ now: '2026-11-09T12:00:00Z', timezone: 'America/Phoenix' }), 'utf8');
});
test.afterEach(async () => { if (app) await app.close(); app = null; await fs.rm(root, { recursive: true, force: true }); });
async function launch() {
  app = await electron.launch({ args: ['.'], env: { ...process.env, COMPANION_TEST_ROOT: root } }); page = await app.firstWindow();
  await page.getByRole('button', { name: 'Choose vault', exact: true }).click();
  await page.getByRole('button', { name: 'Use this folder', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('Vault ready.');
}
async function tree(directory) {
  const records = {};
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) for (const [name, bytes] of Object.entries(await tree(file))) records[path.join(entry.name, name)] = bytes;
    else records[entry.name] = (await fs.readFile(file)).toString('base64');
  }
  return records;
}
test('explicit archive preview exports full controlled history and whitelisted settings without changing source bytes', async () => {
  test.setTimeout(90000);
  const reply = 'Authored synthetic archive reply: ' + 'retained passage 🎸 café 漢字\n'.repeat(900) + 'FINAL_LONG_REPLY_ARCHIVE_CANARY';
  await fs.writeFile(path.join(root, 'conversation-provider.json'), JSON.stringify({ reply }), 'utf8');
  await launch();
  await page.getByLabel('Thought or link', { exact: true }).fill('Spaced retrieval revisits a learned chord.');
  await page.getByRole('button', { name: 'Save capture', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('Capture saved.');
  const readme = path.join(root, 'README.md');
  await fs.writeFile(readme, '# MyTune\n\nA guitar practice tutor.\n', 'utf8');
  await fs.writeFile(path.join(root, 'brief-selection.json'), JSON.stringify([readme]), 'utf8');
  await page.getByRole('button', { name: 'Select MyTune README', exact: true }).click();
  await page.getByRole('button', { name: 'Propose brief', exact: true }).click();
  await page.getByRole('button', { name: 'Approve proposed brief', exact: true }).click();
  await expect(page.locator('#brief-view')).toContainText('Approved version 1');
  await page.getByLabel('Context question', { exact: true }).fill('How could retrieval help MyTune?');
  await page.getByRole('button', { name: 'Find context', exact: true }).click();
  await page.locator('#context-results article').filter({ hasText: 'Spaced retrieval' }).first().getByRole('button', { name: 'Add to context', exact: true }).click();
  await page.getByRole('button', { name: 'Preview conversation', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Send reviewed package', exact: true })).toBeEnabled();
  const reviewed = await page.getByLabel('Reviewed conversation package', { exact: true }).inputValue();
  await page.getByRole('button', { name: 'Send reviewed package', exact: true }).click();
  await expect(page.locator('#conversation-history')).toContainText('FINAL_LONG_REPLY_ARCHIVE_CANARY');
  await expect(page.locator('#conversation-history')).toContainText('completed');
  const historyDirectory = path.join(root, 'conversations');
  const names = (await fs.readdir(historyDirectory)).filter(name => name.endsWith('.json'));
  expect(names).toHaveLength(1);
  const record = JSON.parse(await fs.readFile(path.join(historyDirectory, names[0]), 'utf8'));
  const settingsFile = path.join(root, 'settings.json');
  const settings = JSON.parse(await fs.readFile(settingsFile, 'utf8'));
  // Unknown application settings must never become an implicit recursive archive whitelist.
  await fs.writeFile(settingsFile, JSON.stringify({ ...settings, unrecognizedPrivateState: 'DO_NOT_EXPORT_UNKNOWN_SETTING' }), 'utf8');
  const before = { history: await tree(historyDirectory), vault: await tree(path.join(root, 'vault')), settings: await fs.readFile(settingsFile, 'utf8'), calls: await fs.readFile(path.join(root, 'conversation-submissions.jsonl'), 'utf8') };
  const destination = path.join(root, 'explicit-history-archive.json');
  // OS save-dialog process fixture, the same boundary as existing folder-selection fixtures.
  await fs.writeFile(path.join(root, 'archive-dialog.json'), JSON.stringify({ save: destination }), 'utf8');
  await page.getByRole('button', { name: 'Preview history archive', exact: true }).click();
  const preview = page.getByRole('region', { name: 'Local history archive', exact: true });
  await expect(preview).toContainText(root);
  await expect(preview).toContainText('Vault backup alone omits conversation history');
  await expect(preview).toContainText('1 conversation');
  expect(await fs.access(destination).then(() => true, () => false)).toBe(false);
  await preview.getByRole('button', { name: 'Export reviewed archive', exact: true }).click();
  await expect(preview).toContainText('Archive exported');
  const text = new TextDecoder('utf-8', { fatal: true }).decode(await fs.readFile(destination));
  const archive = JSON.parse(text);
  expect(archive.format).toBe('companion-local-history'); expect(archive.version).toBe(1);
  expect(archive.integrity).toMatchObject({ algorithm: 'sha256', digest: expect.stringMatching(/^[a-f0-9]{64}$/) });
  expect(archive.payload.settings).toEqual(settings);
  expect(archive.payload.conversations).toEqual([record]);
  expect(archive.payload.conversations[0].requests[0].reply).toBe(reply);
  expect(archive.payload.conversations[0].requests[0].package.text).toBe(reviewed);
  expect(archive.payload.vaultBindings).toEqual(expect.arrayContaining([expect.objectContaining({ managedRoot: path.join(root, 'vault', 'Companion'), vault: settings.vault, parent: settings.parent })]));
  expect(text).not.toContain('DO_NOT_EXPORT_UNKNOWN_SETTING');
  expect(Object.keys(archive.payload).sort()).toEqual(['contextScopes', 'conversations', 'scheduleIntent', 'settings', 'vaultBindings']);
  expect({ history: await tree(historyDirectory), vault: await tree(path.join(root, 'vault')), settings: await fs.readFile(settingsFile, 'utf8'), calls: await fs.readFile(path.join(root, 'conversation-submissions.jsonl'), 'utf8') }).toEqual(before);
});
