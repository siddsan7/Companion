const { test, expect, _electron: electron } = require('@playwright/test');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
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
async function completedConversation({ imported = false } = {}) {
  await fs.writeFile(path.join(root, 'conversation-provider.json'), JSON.stringify({ reply: 'Authored synthetic observation: revisiting a chord may help practice. The transfer is unverified.' }), 'utf8');
  await launch();
  if (imported) {
    await fs.cp(path.join(__dirname, 'fixtures/reel-review/accept'), path.join(root, 'producer', 'accept'), { recursive: true });
    await page.getByLabel('Finalized review folder', { exact: true }).fill(path.join(root, 'producer'));
    await page.getByRole('button', { name: 'Connect finalized reviews', exact: true }).click();
    await expect(page.getByRole('status')).toContainText('Source connected');
    await page.getByRole('button', { name: 'Check now', exact: true }).click();
    await expect(page.locator('#captures article')).toContainText('Authored synthetic review');
  } else {
    await page.getByLabel('Thought or link', { exact: true }).fill('Spaced retrieval revisits a learned chord.');
    await page.getByRole('button', { name: 'Save capture', exact: true }).click();
    await expect(page.getByRole('status')).toContainText('Capture saved.');
  }
  const readme = path.join(root, 'README.md');
  await fs.writeFile(readme, '# MyTune\n\nA guitar practice tutor.\n', 'utf8');
  await fs.writeFile(path.join(root, 'brief-selection.json'), JSON.stringify([readme]), 'utf8');
  await page.getByRole('button', { name: 'Select MyTune README', exact: true }).click();
  await page.getByRole('button', { name: 'Propose brief', exact: true }).click();
  await page.getByRole('button', { name: 'Approve proposed brief', exact: true }).click();
  await expect(page.locator('#brief-view')).toContainText('Approved version 1');
  const question = imported ? 'What does the synthetic review support for MyTune?' : 'How could retrieval help MyTune?';
  await page.getByLabel('Context question', { exact: true }).fill(question);
  await page.getByRole('button', { name: 'Find context', exact: true }).click();
  await page.locator('#context-results article').filter({ hasText: imported ? 'Authored synthetic review' : 'Spaced retrieval' }).first().getByRole('button', { name: 'Add to context', exact: true }).click();
  await page.getByLabel('Conversation brief version', { exact: true }).fill('1');
  await page.getByRole('button', { name: 'Preview conversation', exact: true }).click();
  await expect(page.getByLabel('Reviewed conversation package', { exact: true })).toHaveValue(new RegExp(imported ? 'synthetic review support' : 'How could retrieval help MyTune\\?'));
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
async function dispatchedUri() {
  try { return await fs.readFile(path.join(root, 'opened-uri.txt'), 'utf8'); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
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
  await expect.poll(dispatchedUri).toBe(`obsidian://open?path=${encodeURIComponent(destination)}`);
  for (const [file, content] of Object.entries(originals)) expect(await fs.readFile(file, 'utf8')).toBe(content);
  expect(await fs.readFile(historyFile, 'utf8')).toBe(history);

  await app.close(); app = null; await launch(false);
  await expect(page.locator('#saved-ideas')).toContainText('A useful retrieval observation');
  await page.getByRole('button', { name: 'Open saved idea in Obsidian', exact: true }).click();
  await expect.poll(dispatchedUri).toBe(`obsidian://open?path=${encodeURIComponent(destination)}`);
  expect((await fs.readdir(ideas)).filter(name => name.endsWith('.md'))).toHaveLength(1);
  expect(await fs.readFile(path.join(root, 'conversation-submissions.jsonl'), 'utf8')).toBe(submissions);
});

test('an Experiment Proposal requires all five fields before preview and explicit save', async () => {
  test.setTimeout(90000);
  await completedConversation();
  const ideas = path.join(root, 'vault', 'Companion', 'Ideas');
  await page.getByRole('button', { name: 'Draft saved idea', exact: true }).click();
  await page.getByLabel('Idea title', { exact: true }).fill('Try a retrieval practice queue');
  await page.getByLabel('Idea explanation', { exact: true }).fill('Propose a small comparison of two practice queues.');
  await page.getByLabel('Idea limitations', { exact: true }).fill('Authored synthetic hypothesis; no experiment was run and transfer is unverified.');
  await page.getByLabel('Saved idea kind', { exact: true }).selectOption({ label: 'Experiment Proposal' });
  const fields = [
    ['Hypothesis', 'A delayed revisit may improve next-day clean chord changes.'],
    ['Borrowed mechanism', 'Retrieve a previously learned chord after a delay.'],
    ['Project application', 'Offer a delayed revisit in the MyTune practice queue.'],
    ['Smallest test', 'Compare two short sessions with and without a delayed revisit.'],
    ['Observable result', 'Record next-day clean chord changes out of ten attempts.']
  ];
  for (const [label, value] of fields) {
    await page.getByRole('button', { name: 'Preview saved idea', exact: true }).click();
    await expect(page.locator('#idea-status')).toContainText(new RegExp(`Enter.*${label}`, 'i'));
    await expect(page.getByRole('button', { name: 'Confirm saved idea', exact: true })).not.toBeVisible();
    expect((await fs.readdir(ideas)).filter(name => name.endsWith('.md'))).toEqual([]);
    await page.getByLabel(label, { exact: true }).fill(value);
  }
  await page.getByRole('button', { name: 'Preview saved idea', exact: true }).click();
  await expect(page.getByLabel('Proposed idea Markdown', { exact: true })).toHaveValue(/# Experiment Proposal/);
  const proposed = await page.getByLabel('Proposed idea Markdown', { exact: true }).inputValue();
  const destination = await page.getByLabel('Proposed idea destination', { exact: true }).inputValue();
  for (const [label, value] of fields) { expect(proposed).toContain(`## ${label}`); expect(proposed).toContain(value); }
  expect(proposed).toContain('no experiment was run');
  expect(await fs.readdir(ideas)).toEqual([]);
  await page.getByRole('button', { name: 'Confirm saved idea', exact: true }).click();
  await expect(page.locator('#idea-status')).toContainText('Saved idea');
  expect(await fs.readFile(destination, 'utf8')).toBe(proposed);
  expect((await fs.readdir(ideas)).filter(name => name.endsWith('.md'))).toHaveLength(1);
});

test('an explicitly selected imported evidence citation opens its original revision after a reviewed update', async () => {
  test.setTimeout(120000);
  await completedConversation({ imported: true });
  const vault = path.join(root, 'vault', 'Companion');
  const revisionNames = (await fs.readdir(path.join(vault, 'Revisions'))).filter(name => name.endsWith('.json'));
  expect(revisionNames).toHaveLength(1);
  const revisionBytes = await fs.readFile(path.join(vault, 'Revisions', revisionNames[0]));
  const original = JSON.parse(revisionBytes.toString('utf8'));
  const historyName = (await fs.readdir(path.join(root, 'conversations'))).find(name => name.endsWith('.json'));
  const history = JSON.parse(await fs.readFile(path.join(root, 'conversations', historyName), 'utf8'));
  const capturesBefore = await markdownSnapshot(path.join(vault, 'Captures'));
  await page.getByRole('button', { name: 'Draft saved idea', exact: true }).click();
  await page.getByLabel('Idea title', { exact: true }).fill('Inspect the original authored evidence');
  await page.getByLabel('Idea explanation', { exact: true }).fill('The authored fixture is useful for inspecting provenance, not proof of a learning outcome.');
  await page.getByLabel('Idea limitations', { exact: true }).fill('Authored synthetic fixture; acceptance does not verify every claim. OCR and vision unavailable.');
  await page.getByRole('checkbox', { name: 'Cite evidence a1 from Authored synthetic review', exact: true }).check();
  await page.getByRole('button', { name: 'Preview saved idea', exact: true }).click();
  await expect(page.getByLabel('Proposed idea Markdown', { exact: true })).toHaveValue(/evidence_id: a1/);
  const proposed = await page.getByLabel('Proposed idea Markdown', { exact: true }).inputValue();
  const destination = await page.getByLabel('Proposed idea destination', { exact: true }).inputValue();
  const fields = YAML.parse(proposed.match(/^---\n([\s\S]*?)\n---\n/)[1]);
  expect(fields.project_brief).toEqual(history.brief);
  expect(fields.citations).toHaveLength(1);
  expect(fields.citations[0]).toMatchObject({ kind: 'imported_evidence', capture_id: original.captureId, revision_id: original.id, snapshot_sha256: createHash('sha256').update(revisionBytes).digest('hex'), evidence_id: 'a1', excerpt: 'Authored synthetic review fixture only.' });
  expect(proposed).toContain('not independently verified');
  await page.getByRole('button', { name: 'Confirm saved idea', exact: true }).click();
  await expect(page.locator('#idea-status')).toContainText('Saved idea');
  expect(await fs.readFile(destination, 'utf8')).toBe(proposed);
  expect(await markdownSnapshot(path.join(vault, 'Captures'))).toEqual(capturesBefore);

  await fs.cp(path.join(__dirname, 'fixtures/reel-review/edit'), path.join(root, 'producer', 'edit'), { recursive: true });
  await fs.writeFile(path.join(root, 'clock.json'), JSON.stringify({ now: '2026-11-09T12:00:01Z', timezone: 'America/Phoenix' }), 'utf8');
  await page.getByRole('button', { name: 'Check now', exact: true }).click();
  await expect(page.locator('#intake-state')).toContainText('Last check: 2026-11-09T12:00:01Z · manual · complete');
  await page.getByRole('button', { name: 'Inspect source', exact: true }).click();
  await page.getByLabel('Source inspection').locator('article').filter({ hasText: 'Human review: edit' }).getByRole('button', { name: 'Make current', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('Current revision selected');
  await expect(page.locator('#captures article')).toContainText('Authored synthetic corrected review');
  await page.locator('#saved-ideas article').getByRole('button', { name: 'Inspect cited evidence', exact: true }).click();
  await expect(page.locator('#idea-evidence')).toContainText(original.id);
  await expect(page.locator('#idea-evidence')).toContainText('Authored synthetic review fixture only.');
  // Native textarea values normalize CRLF; the saved anchor binds the raw snapshot hash.
  await expect(page.getByLabel('Cited revision snapshot', { exact: true })).toHaveValue(original.text.replace(/\r\n?/g, '\n'));
  await expect(page.getByLabel('Cited revision snapshot', { exact: true })).not.toHaveValue(/Authored synthetic corrected review/);
  expect(await fs.readFile(destination, 'utf8')).toBe(proposed);
});
