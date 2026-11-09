const { test, expect, _electron: electron } = require('@playwright/test');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const YAML = require('yaml');

let root, app, page;
test.beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'companion-ideas-'));
  await fs.writeFile(path.join(root, 'clock.json'), JSON.stringify({ now: '2026-11-09T12:00:00Z', timezone: 'America/Phoenix' }), 'utf8');
});
test.afterEach(async () => {
  if (app) await app.close();
  app = null;
  await fs.rm(root, { recursive: true, force: true });
});
async function launch(configure = true) {
  app = await electron.launch({ args: ['.'], env: { ...process.env, COMPANION_TEST_ROOT: root } });
  page = await app.firstWindow();
  if (configure) {
    await page.getByRole('button', { name: 'Choose vault', exact: true }).click();
    await page.getByRole('button', { name: 'Use this folder', exact: true }).click();
    await expect(page.getByRole('status')).toContainText('Vault ready.');
  }
}
async function completedConversation() {
  await fs.writeFile(path.join(root, 'conversation-provider.json'), JSON.stringify({ reply: 'Authored synthetic observation: revisiting a chord may help practice. The transfer is unverified.' }), 'utf8');
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
  await page.getByLabel('Conversation brief version', { exact: true }).fill('1');
  await page.getByRole('button', { name: 'Preview conversation', exact: true }).click();
  await expect(page.getByLabel('Reviewed conversation package', { exact: true })).toHaveValue(/How could retrieval help MyTune/);
  await page.getByRole('button', { name: 'Send reviewed package', exact: true }).click();
  await expect(page.locator('#conversation-history')).toContainText('completed');
  await expect(page.locator('#conversation-history')).toContainText('Authored synthetic observation');
}
async function bytesIn(directory) {
  const files = {};
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) Object.assign(files, await bytesIn(file));
    else files[file] = (await fs.readFile(file)).toString('base64');
  }
  return files;
}
async function saveIdea(title) {
  await page.getByRole('button', { name: 'Draft saved idea', exact: true }).click();
  await page.getByLabel('Idea title', { exact: true }).fill(title);
  await page.getByLabel('Idea explanation', { exact: true }).fill(`Independent authored writing for ${title}.`);
  await page.getByLabel('Idea limitations', { exact: true }).fill('Unverified interpretation; no measured result.');
  await page.getByRole('button', { name: 'Preview saved idea', exact: true }).click();
  await expect(page.getByLabel('Proposed idea Markdown', { exact: true })).toHaveValue(new RegExp(title));
  const file = await page.getByLabel('Proposed idea destination', { exact: true }).inputValue();
  await page.getByRole('button', { name: 'Confirm saved idea', exact: true }).click();
  await expect(page.locator('#saved-ideas').getByRole('heading', { name: title, exact: true })).toBeVisible();
  return file;
}

test('explicit removal previews one saved idea and its managed copies, cancels without changes, and never revives it after restart', async () => {
  test.setTimeout(120000);
  await completedConversation();
  const selected = await saveIdea('Selected independent idea');
  const retained = await saveIdea('Retained independent idea');
  const vault = path.join(root, 'vault', 'Companion'), directory = path.join(vault, '.ideas');
  const sourceBytes = await bytesIn(path.join(vault, 'Captures'));
  const historyBytes = await bytesIn(path.join(root, 'conversations'));
  const retainedBytes = await fs.readFile(retained, 'utf8');
  const metadata = YAML.parse((await fs.readFile(selected, 'utf8')).match(/^---\n([\s\S]*?)\n---\n/)[1]);
  const selectedCopies = [selected];
  for (const name of await fs.readdir(directory)) {
    if (!name.endsWith('.json')) continue;
    const file = path.join(directory, name), value = JSON.parse(await fs.readFile(file, 'utf8'));
    if (value.id === metadata.companion_id) selectedCopies.push(file);
  }
  expect(selectedCopies).toHaveLength(3);
  const before = { ...await bytesIn(vault), ...await bytesIn(path.join(root, 'conversations')) };
  const article = page.locator('#saved-ideas article').filter({ hasText: 'Selected independent idea' });
  await article.getByRole('button', { name: 'Preview saved idea removal', exact: true }).click();
  const preview = page.getByLabel('Saved idea removal preview', { exact: true });
  await expect(preview).toContainText(metadata.companion_id);
  for (const file of selectedCopies) await expect(preview).toContainText(file);
  await expect(preview).toContainText(/conversation.*retain|retain.*conversation/i);
  await expect(preview).toContainText(/external|backup/i);
  expect({ ...await bytesIn(vault), ...await bytesIn(path.join(root, 'conversations')) }).toEqual(before);
  await page.getByRole('button', { name: 'Cancel saved idea removal', exact: true }).click();
  await expect(preview).toBeHidden();
  expect({ ...await bytesIn(vault), ...await bytesIn(path.join(root, 'conversations')) }).toEqual(before);
  await article.getByRole('button', { name: 'Preview saved idea removal', exact: true }).click();
  await page.getByRole('button', { name: 'Confirm saved idea removal', exact: true }).click();
  await expect(page.locator('#saved-ideas article')).toHaveCount(1);
  await expect(page.locator('#saved-ideas')).toContainText('Retained independent idea');
  for (const file of selectedCopies) expect(await fs.lstat(file).catch(error => { if (error.code === 'ENOENT') return null; throw error; })).toBeNull();
  expect(await fs.readFile(retained, 'utf8')).toBe(retainedBytes);
  expect(await bytesIn(path.join(vault, 'Captures'))).toEqual(sourceBytes);
  expect(await bytesIn(path.join(root, 'conversations'))).toEqual(historyBytes);
  await app.close(); app = null; await launch(false);
  await expect(page.locator('#saved-ideas article')).toHaveCount(1);
  await expect(page.locator('#pending-ideas article')).toHaveCount(0);
  await expect(page.locator('#saved-ideas')).not.toContainText('Selected independent idea');
  for (const file of selectedCopies) expect(await fs.lstat(file).catch(error => { if (error.code === 'ENOENT') return null; throw error; })).toBeNull();
  expect(await fs.readFile(retained, 'utf8')).toBe(retainedBytes);
  expect(await bytesIn(path.join(vault, 'Captures'))).toEqual(sourceBytes);
  expect(await bytesIn(path.join(root, 'conversations'))).toEqual(historyBytes);
});

