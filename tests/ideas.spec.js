const { test, expect, _electron: electron } = require('@playwright/test');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

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
  await expect(page.getByLabel('Reviewed conversation package', { exact: true })).toHaveValue(/How could retrieval help MyTune\?/);
  await page.getByRole('button', { name: 'Send reviewed package', exact: true }).click();
  await expect(page.locator('#conversation-history')).toContainText('completed');
  await expect(page.locator('#conversation-history')).toContainText('Authored synthetic observation');
}
async function markdownSnapshot(directory) {
  const result = {};
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) Object.assign(result, await markdownSnapshot(file));
    else if (entry.name.endsWith('.md')) result[file] = await fs.readFile(file, 'utf8');
  }
  return result;
}

test('a completed conversation result becomes a standalone saved idea only after visible preview and confirmation', async () => {
  test.setTimeout(90000);
  await completedConversation();
  const vault = path.join(root, 'vault', 'Companion'), ideas = path.join(vault, 'Ideas');
  const originals = await markdownSnapshot(vault);
  const historyNames = (await fs.readdir(path.join(root, 'conversations'))).filter(name => name.endsWith('.json'));
  const historyFile = path.join(root, 'conversations', historyNames[0]);
  const history = await fs.readFile(historyFile, 'utf8');
  const submissions = await fs.readFile(path.join(root, 'conversation-submissions.jsonl'), 'utf8');
  expect(await fs.readdir(ideas)).toEqual([]);

  await page.getByRole('button', { name: 'Draft saved idea', exact: true }).click();
  await page.getByLabel('Idea title', { exact: true }).fill('A useful retrieval observation');
  await page.getByLabel('Idea explanation', { exact: true }).fill('Revisiting a chord may inform the practice queue. This is an observation, not a completed experiment.');
  await page.getByLabel('Idea limitations', { exact: true }).fill('The transfer is unverified; no outcome has been measured.');
  await page.getByRole('button', { name: 'Preview saved idea', exact: true }).click();
  await expect(page.getByLabel('Proposed idea Markdown', { exact: true })).toHaveValue(/A useful retrieval observation/);
  await expect(page.getByLabel('Proposed idea destination', { exact: true })).toHaveValue(new RegExp(`${path.sep === '\\' ? 'Ideas\\\\' : 'Ideas/'}.*\\.md$`));
  await expect(page.locator('#idea-preview')).toContainText(/support|citation|reference/i);
  expect(await fs.readdir(ideas)).toEqual([]);
  await page.getByRole('button', { name: 'Cancel saved idea preview', exact: true }).click();
  expect(await fs.readdir(ideas)).toEqual([]);
  await expect(page.getByLabel('Idea explanation', { exact: true })).toHaveValue(/Revisiting a chord/);

  await page.getByRole('button', { name: 'Preview saved idea', exact: true }).click();
  const proposed = await page.getByLabel('Proposed idea Markdown', { exact: true }).inputValue();
  const destination = await page.getByLabel('Proposed idea destination', { exact: true }).inputValue();
  await page.getByRole('button', { name: 'Confirm saved idea', exact: true }).click();
  await expect(page.locator('#idea-status')).toContainText('Saved idea');
  expect(await fs.readFile(destination, 'utf8')).toBe(proposed);
  expect((await fs.readdir(ideas)).filter(name => name.endsWith('.md'))).toHaveLength(1);
  expect(proposed).toContain('artifact_type: saved_idea');
  expect(proposed).toContain('The transfer is unverified; no outcome has been measured.');
  expect(proposed).not.toContain('# Experiment Proposal');
  await page.getByRole('button', { name: 'Open saved idea in Obsidian', exact: true }).click();
  await expect.poll(() => fs.readFile(path.join(root, 'opened-uri.txt'), 'utf8')).toBe(`obsidian://open?path=${encodeURIComponent(destination)}`);
  for (const [file, content] of Object.entries(originals)) expect(await fs.readFile(file, 'utf8')).toBe(content);
  expect(await fs.readFile(historyFile, 'utf8')).toBe(history);

  await app.close(); app = null; await launch(false);
  await expect(page.locator('#saved-ideas')).toContainText('A useful retrieval observation');
  await page.getByRole('button', { name: 'Open saved idea in Obsidian', exact: true }).click();
  await expect.poll(() => fs.readFile(path.join(root, 'opened-uri.txt'), 'utf8')).toBe(`obsidian://open?path=${encodeURIComponent(destination)}`);
  expect((await fs.readdir(ideas)).filter(name => name.endsWith('.md'))).toHaveLength(1);
  expect(await fs.readFile(path.join(root, 'conversation-submissions.jsonl'), 'utf8')).toBe(submissions);
});
