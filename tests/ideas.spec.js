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
async function completedConversation({ imported = false, twoCaptures = false, scenario, expectedStatus = 'completed', expectedReply = 'Authored synthetic observation' } = {}) {
  await fs.writeFile(path.join(root, 'conversation-provider.json'), JSON.stringify(scenario || { reply: 'Authored synthetic observation: revisiting a chord may help practice. The transfer is unverified.' }), 'utf8');
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
    if (twoCaptures) {
      await page.getByLabel('Thought or link', { exact: true }).fill('A practice queue makes a delayed revisit visible.');
      await page.getByRole('button', { name: 'Save capture', exact: true }).click();
      await expect(page.locator('#captures').getByRole('heading', { name: 'A practice queue makes a delayed revisit visible.', exact: true })).toBeVisible();
    }
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
  if (twoCaptures) {
    await page.getByLabel('Manual context source', { exact: true }).selectOption({ label: 'A practice queue makes a delayed revisit visible.' });
    await page.getByRole('button', { name: 'Add manual source', exact: true }).click();
  }
  await page.getByLabel('Conversation brief version', { exact: true }).fill('1');
  await page.getByRole('button', { name: 'Preview conversation', exact: true }).click();
  await expect(page.getByLabel('Reviewed conversation package', { exact: true })).toHaveValue(new RegExp(imported ? 'synthetic review support' : 'How could retrieval help MyTune\\?'));
  await page.getByRole('button', { name: 'Send reviewed package', exact: true }).click();
  await expect(page.locator('#conversation-history')).toContainText(expectedStatus);
  await expect(page.locator('#conversation-history')).toContainText(expectedReply);
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

test('citation inspection ignores damaged uncited revisions and reports a damaged cited revision without substitution', async () => {
  test.setTimeout(120000);
  await completedConversation({ imported: true });
  const vault = path.join(root, 'vault', 'Companion'), revisions = path.join(vault, 'Revisions');
  const originalName = (await fs.readdir(revisions)).find(name => name.endsWith('.json'));
  const original = JSON.parse(await fs.readFile(path.join(revisions, originalName), 'utf8'));
  await page.getByRole('button', { name: 'Draft saved idea', exact: true }).click();
  await page.getByLabel('Idea title', { exact: true }).fill('Keep independent interpretation when evidence is damaged');
  await page.getByLabel('Idea explanation', { exact: true }).fill('This interpretation stays available for review even if its cited source becomes unavailable.');
  await page.getByLabel('Idea limitations', { exact: true }).fill('Authored synthetic fixture; a reference is not independent verification.');
  await page.getByRole('checkbox', { name: 'Cite evidence a1 from Authored synthetic review', exact: true }).check();
  await page.getByRole('button', { name: 'Preview saved idea', exact: true }).click();
  await expect(page.getByLabel('Proposed idea Markdown', { exact: true })).toHaveValue(/evidence_id: a1/);
  const proposed = await page.getByLabel('Proposed idea Markdown', { exact: true }).inputValue();
  const destination = await page.getByLabel('Proposed idea destination', { exact: true }).inputValue();
  await page.getByRole('button', { name: 'Confirm saved idea', exact: true }).click();
  await expect(page.locator('#idea-status')).toContainText('Saved idea');

  await fs.cp(path.join(__dirname, 'fixtures/reel-review/edit'), path.join(root, 'producer', 'edit'), { recursive: true });
  await fs.writeFile(path.join(root, 'clock.json'), JSON.stringify({ now: '2026-11-09T12:00:01Z', timezone: 'America/Phoenix' }), 'utf8');
  await page.getByRole('button', { name: 'Check now', exact: true }).click();
  await expect(page.locator('#intake-state')).toContainText('Last check: 2026-11-09T12:00:01Z · manual · complete');
  await page.getByRole('button', { name: 'Inspect source', exact: true }).click();
  await page.getByLabel('Source inspection').locator('article').filter({ hasText: 'Human review: edit' }).getByRole('button', { name: 'Make current', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('Current revision selected');
  const newerName = (await fs.readdir(revisions)).find(name => name.endsWith('.json') && name !== originalName);
  expect(newerName).toBeTruthy();
  await fs.appendFile(path.join(revisions, newerName), '\nDAMAGED_UNCITED_B\n', 'utf8');
  const inspect = page.locator('#saved-ideas article').getByRole('button', { name: 'Inspect cited evidence', exact: true });
  await inspect.click();
  await expect(page.getByLabel('Cited revision snapshot', { exact: true })).toHaveValue(original.text.replace(/\r\n?/g, '\n'));
  await expect(page.locator('#idea-evidence')).toContainText(original.id);
  await expect(page.locator('#idea-evidence')).not.toContainText('DAMAGED_UNCITED_B');
  expect(await fs.readFile(destination, 'utf8')).toBe(proposed);

  await fs.appendFile(path.join(revisions, originalName), '\nDAMAGED_CITED_A\n', 'utf8');
  await inspect.click();
  await expect(page.locator('#idea-evidence')).toContainText('Cited evidence unavailable:');
  await expect(page.locator('#idea-evidence')).toContainText('No newer revision was substituted.');
  await expect(page.getByLabel('Cited revision snapshot', { exact: true })).toHaveCount(0);
  await expect(page.locator('#idea-evidence')).not.toContainText('Authored synthetic corrected review');
  expect(await fs.readFile(destination, 'utf8')).toBe(proposed);
});

test('two captures can support multiple independent saved interpretations that remain eligible for explicit context selection', async () => {
  test.setTimeout(120000);
  await completedConversation({ twoCaptures: true });
  const vault = path.join(root, 'vault', 'Companion'), ideas = path.join(vault, 'Ideas');
  const originals = await markdownSnapshot(path.join(vault, 'Captures'));
  const captureIds = Object.values(originals).map(text => YAML.parse(text.match(/^---\n([\s\S]*?)\n---\n/)[1]).companion_id).sort();
  expect(captureIds).toHaveLength(2);
  const historyName = (await fs.readdir(path.join(root, 'conversations'))).find(name => name.endsWith('.json'));
  const historyFile = path.join(root, 'conversations', historyName), historyBytes = await fs.readFile(historyFile, 'utf8');
  const history = JSON.parse(historyBytes);
  expect(history.requests[0].package.dependencies.filter(dep => dep.key.startsWith('capture:'))).toHaveLength(2);
  const titles = ['A joint observation from two captures', 'A failed analogy from the same captures'];
  const destinations = [], saved = [];
  for (const [index, title] of titles.entries()) {
    await page.getByRole('button', { name: 'Draft saved idea', exact: true }).click();
    await page.getByLabel('Idea title', { exact: true }).fill(title);
    await page.getByLabel('Idea explanation', { exact: true }).fill(index === 0 ? 'eligibilitysignal: the two captures suggest making a delayed revisit visible in the practice queue.' : 'eligibilitysignal: the same captures do not show that a queue guarantees retrieval or better learning. The analogy fails at that assumption.');
    await page.getByLabel('Idea limitations', { exact: true }).fill('User interpretation of two ordinary captures; no independent verification or observed result.');
    await page.getByLabel('Saved idea kind', { exact: true }).selectOption({ label: index === 0 ? 'Observation' : 'Failed analogy' });
    await page.getByRole('button', { name: 'Preview saved idea', exact: true }).click();
    await expect(page.getByLabel('Proposed idea Markdown', { exact: true })).toHaveValue(new RegExp(`# ${title}`));
    const proposed = await page.getByLabel('Proposed idea Markdown', { exact: true }).inputValue();
    const destination = await page.getByLabel('Proposed idea destination', { exact: true }).inputValue();
    const fields = YAML.parse(proposed.match(/^---\n([\s\S]*?)\n---\n/)[1]);
    expect(fields.source_dependencies.map(dep => dep.capture_id).sort()).toEqual(captureIds);
    expect(fields.source_dependencies.every(dep => /^[a-f0-9]{64}$/.test(dep.content_sha256))).toBe(true);
    expect(fields.project_brief).toEqual(history.brief);
    expect(fields.idea_kind).toBe(index === 0 ? 'observation' : 'failed_analogy');
    expect(fields.experiment).toBeUndefined();
    expect(fields.support_attribution_unavailable).toBe(false);
    await page.getByRole('button', { name: 'Confirm saved idea', exact: true }).click();
    await expect(page.locator('#saved-ideas').getByRole('heading', { name: title, exact: true })).toBeVisible();
    expect(await fs.readFile(destination, 'utf8')).toBe(proposed);
    destinations.push(destination); saved.push(proposed);
  }
  expect(new Set(destinations).size).toBe(2);
  expect((await fs.readdir(ideas)).filter(name => name.endsWith('.md'))).toHaveLength(2);
  expect(await markdownSnapshot(path.join(vault, 'Captures'))).toEqual(originals);
  expect(await fs.readFile(historyFile, 'utf8')).toBe(historyBytes);
  await page.getByLabel('Context question', { exact: true }).fill('eligibilitysignal');
  await page.getByRole('button', { name: 'Find context', exact: true }).click();
  for (const title of titles) await expect(page.locator('#context-results').getByRole('heading', { name: title, exact: true })).toBeVisible();
  await page.locator('#context-results article').filter({ hasText: titles[0] }).getByRole('button', { name: 'Add to context', exact: true }).click();
  await page.getByRole('button', { name: 'Preview context', exact: true }).click();
  await expect(page.getByLabel('Actual context package', { exact: true })).toHaveValue(/eligibilitysignal: the two captures suggest/);
  for (const [index, destination] of destinations.entries()) expect(await fs.readFile(destination, 'utf8')).toBe(saved[index]);
  expect(await fs.readFile(historyFile, 'utf8')).toBe(historyBytes);
});

test('an interrupted reply with late unselected memory can retain independent writing without entering supporting context', async () => {
  test.setTimeout(120000);
  await completedConversation({
    scenario: { messages: [
      { text: 'Authored synthetic SAFE_LOCAL_FRAGMENT for independent review.', phase: 'partial_answer' },
      { text: 'UNSELECTED_IDEA_MEMORY_CANARY', phase: 'final_answer', citationAtCompletion: true, memoryCitation: { entries: [{ path: 'UNSELECTED_IDEA_MEMORY_PATH.md', lineStart: 1, lineEnd: 1, note: 'Authored unselected fixture memory' }], threadIds: ['unselected-idea-thread'] } }
    ] },
    expectedStatus: 'interrupted', expectedReply: 'SAFE_LOCAL_FRAGMENT'
  });
  await expect(page.locator('#conversation-history')).toContainText(/unselected memory/i);
  await expect(page.locator('#conversation-history')).not.toContainText('UNSELECTED_IDEA_MEMORY_CANARY');
  const vault = path.join(root, 'vault', 'Companion'), originals = await markdownSnapshot(path.join(vault, 'Captures'));
  const historyName = (await fs.readdir(path.join(root, 'conversations'))).find(name => name.endsWith('.json'));
  const historyFile = path.join(root, 'conversations', historyName), history = await fs.readFile(historyFile, 'utf8');
  const submissions = await fs.readFile(path.join(root, 'conversation-submissions.jsonl'), 'utf8');
  expect(await fs.readdir(path.join(vault, 'Ideas'))).toEqual([]);
  await page.getByRole('button', { name: 'Draft saved idea', exact: true }).click();
  await expect(page.getByLabel('Idea explanation', { exact: true })).toHaveValue(/SAFE_LOCAL_FRAGMENT/);
  await expect(page.locator('#idea-references input[type="checkbox"]')).toHaveCount(0);
  const title = 'An independently retained incomplete interpretation';
  await page.getByLabel('Idea title', { exact: true }).fill(title);
  await page.getByLabel('Idea explanation', { exact: true }).fill('incompletesignal: retain this independent question for review; the interrupted response establishes no supported conclusion.');
  await page.getByLabel('Idea limitations', { exact: true }).fill('Interrupted response after an unselected-memory boundary failure. Attribution is unavailable and this writing must not become supporting context.');
  await page.getByRole('button', { name: 'Preview saved idea', exact: true }).click();
  await expect(page.getByLabel('Proposed idea Markdown', { exact: true })).toHaveValue(/Conversation output status: interrupted/);
  const proposed = await page.getByLabel('Proposed idea Markdown', { exact: true }).inputValue();
  const destination = await page.getByLabel('Proposed idea destination', { exact: true }).inputValue();
  const fields = YAML.parse(proposed.match(/^---\n([\s\S]*?)\n---\n/)[1]);
  expect(fields.origin.status).toBe('interrupted'); expect(fields.support_attribution_unavailable).toBe(true);
  expect(fields.citations).toEqual([]); expect(proposed).not.toContain('UNSELECTED_IDEA_MEMORY_CANARY');
  await page.getByRole('button', { name: 'Confirm saved idea', exact: true }).click();
  await expect(page.locator('#saved-ideas').getByRole('heading', { name: title, exact: true })).toBeVisible();
  expect(await fs.readFile(destination, 'utf8')).toBe(proposed);
  expect(await markdownSnapshot(path.join(vault, 'Captures'))).toEqual(originals);
  expect(await fs.readFile(historyFile, 'utf8')).toBe(history);
  await app.close(); app = null; await launch(false);
  await expect(page.locator('#saved-ideas').getByRole('heading', { name: title, exact: true })).toBeVisible();
  await page.getByLabel('Context question', { exact: true }).fill('incompletesignal');
  await page.getByRole('button', { name: 'Find context', exact: true }).click();
  await expect(page.locator('#context-results')).toContainText('No Relevant Context');
  await expect(page.locator('#context-results').getByRole('heading', { name: title, exact: true })).toHaveCount(0);
  await expect(page.getByLabel('Manual context source', { exact: true }).getByRole('option', { name: title, exact: true })).toHaveCount(0);
  await expect(page.locator('#context-error')).toContainText('Saved idea unavailable');
  expect(await fs.readFile(destination, 'utf8')).toBe(proposed);
  expect(await fs.readFile(path.join(root, 'conversation-submissions.jsonl'), 'utf8')).toBe(submissions);
});

test('a failed publication retains the exact proposal across restart and explicit retry saves one note', async () => {
  test.setTimeout(120000);
  await completedConversation();
  const vault = path.join(root, 'vault', 'Companion'), ideas = path.join(vault, 'Ideas'), journal = path.join(vault, '.ideas');
  const unrelatedFile = path.join(ideas, 'unrelated-editor-note.md'), unrelated = '# Existing editor note\n\nKeep this independent writing unchanged.\n';
  await fs.writeFile(unrelatedFile, unrelated, 'utf8');
  const sources = await markdownSnapshot(path.join(vault, 'Captures'));
  const historyName = (await fs.readdir(path.join(root, 'conversations'))).find(name => name.endsWith('.json'));
  const historyFile = path.join(root, 'conversations', historyName), history = await fs.readFile(historyFile, 'utf8');
  const submissions = await fs.readFile(path.join(root, 'conversation-submissions.jsonl'), 'utf8');
  await page.getByRole('button', { name: 'Draft saved idea', exact: true }).click();
  const title = 'A retained proposal after a failed write';
  const explanation = 'retrywriting: preserve this exact independent interpretation through a publication failure and restart.';
  await page.getByLabel('Idea title', { exact: true }).fill(title);
  await page.getByLabel('Idea explanation', { exact: true }).fill(explanation);
  await page.getByLabel('Idea limitations', { exact: true }).fill('No verified outcome; this retained proposal requires explicit confirmation.');
  await page.getByRole('button', { name: 'Preview saved idea', exact: true }).click();
  await expect(page.getByLabel('Proposed idea Markdown', { exact: true })).toHaveValue(/retrywriting/);
  const proposed = await page.getByLabel('Proposed idea Markdown', { exact: true }).inputValue();
  const destination = await page.getByLabel('Proposed idea destination', { exact: true }).inputValue();
  await fs.writeFile(path.join(root, 'faults.json'), JSON.stringify({ fail: 'idea-before-publication' }), 'utf8');
  await page.getByRole('button', { name: 'Confirm saved idea', exact: true }).click();
  await expect(page.locator('#idea-status')).toContainText('Save failed. Proposed content is retained.');
  await expect(page.getByLabel('Idea explanation', { exact: true })).toHaveValue(explanation);
  await expect(page.getByLabel('Proposed idea Markdown', { exact: true })).toHaveValue(proposed);
  expect(await fs.readFile(unrelatedFile, 'utf8')).toBe(unrelated);
  expect(await fs.readdir(ideas)).toEqual(['unrelated-editor-note.md']);
  const intentNames = (await fs.readdir(journal)).filter(name => name.endsWith('.intent.json'));
  expect(intentNames).toHaveLength(1);
  const intentFile = path.join(journal, intentNames[0]), intentBytes = await fs.readFile(intentFile, 'utf8'), intent = JSON.parse(intentBytes);
  expect(intent.text).toBe(proposed); expect(intent.destination).toBe(destination);
  expect(intentNames[0]).toBe(`${intent.operation}.intent.json`);
  await app.close(); app = null;
  await fs.writeFile(path.join(root, 'faults.json'), '{}', 'utf8');
  await launch(false);
  const pending = page.locator('#pending-ideas article').filter({ hasText: title });
  await expect(pending).toBeVisible();
  expect(await fs.readdir(ideas)).toEqual(['unrelated-editor-note.md']);
  expect(await fs.readFile(path.join(root, 'conversation-submissions.jsonl'), 'utf8')).toBe(submissions);
  await pending.getByRole('button', { name: 'Resume proposed idea', exact: true }).click();
  await expect(page.getByLabel('Idea explanation', { exact: true })).toHaveValue(explanation);
  await expect(page.getByLabel('Proposed idea Markdown', { exact: true })).toHaveValue(proposed);
  await expect(page.getByLabel('Proposed idea destination', { exact: true })).toHaveValue(destination);
  await page.getByRole('button', { name: 'Confirm saved idea', exact: true }).click();
  await expect(page.locator('#saved-ideas').getByRole('heading', { name: title, exact: true })).toBeVisible();
  expect(await fs.readFile(destination, 'utf8')).toBe(proposed);
  expect(await fs.readFile(unrelatedFile, 'utf8')).toBe(unrelated);
  expect(await fs.readdir(ideas)).toHaveLength(2);
  expect(await fs.readFile(intentFile, 'utf8')).toBe(intentBytes);
  expect(JSON.parse(await fs.readFile(path.join(journal, `${intent.operation}.published.json`), 'utf8')).id).toBe(intent.id);
  expect(await markdownSnapshot(path.join(vault, 'Captures'))).toEqual(sources);
  expect(await fs.readFile(historyFile, 'utf8')).toBe(history);
  await app.close(); app = null; await launch(false);
  await expect(page.locator('#saved-ideas').getByRole('heading', { name: title, exact: true })).toBeVisible();
  await expect(page.locator('#pending-ideas article')).toHaveCount(0);
  expect(await fs.readdir(ideas)).toHaveLength(2);
  expect(await fs.readFile(path.join(root, 'conversation-submissions.jsonl'), 'utf8')).toBe(submissions);
});

test('an unknown outside hardlink to a staged proposal blocks publication before any destination peer is created', async () => {
  test.setTimeout(120000);
  await completedConversation();
  await page.getByRole('button', { name: 'Draft saved idea', exact: true }).click();
  await page.getByLabel('Idea title', { exact: true }).fill('Keep a staged interpretation contained');
  const explanation = 'hardlinkwriting: retain this proposed interpretation without publishing through an unknown linked copy.';
  await page.getByLabel('Idea explanation', { exact: true }).fill(explanation);
  await page.getByLabel('Idea limitations', { exact: true }).fill('Unverified independent writing; publication needs exclusive ownership.');
  await page.getByRole('button', { name: 'Preview saved idea', exact: true }).click();
  await expect(page.getByLabel('Proposed idea Markdown', { exact: true })).toHaveValue(/hardlinkwriting/);
  const proposed = await page.getByLabel('Proposed idea Markdown', { exact: true }).inputValue();
  const destination = await page.getByLabel('Proposed idea destination', { exact: true }).inputValue();
  await fs.writeFile(path.join(root, 'faults.json'), JSON.stringify({ pause: 'idea-before-publication' }), 'utf8');
  await page.getByRole('button', { name: 'Confirm saved idea', exact: true }).click();
  await expect.poll(async () => {
    try { return await fs.readFile(path.join(root, 'checkpoint.txt'), 'utf8'); }
    catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  }).toBe('idea-before-publication');
  const directory = path.join(root, 'vault', 'Companion', '.ideas');
  const stageName = (await fs.readdir(directory)).find(name => name.endsWith('.md.pending'));
  expect(stageName).toBeTruthy();
  const stage = path.join(directory, stageName), outside = path.join(root, 'outside-stage-peer.md');
  await fs.link(stage, outside);
  expect((await fs.stat(stage)).nlink).toBe(2);
  expect(await fs.readFile(outside, 'utf8')).toBe(proposed);
  await fs.writeFile(path.join(root, 'release.txt'), 'continue', 'utf8');
  await expect(page.locator('#idea-status')).toContainText('Save failed. Proposed content is retained.');
  const published = await fs.lstat(destination).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
  expect.soft(published).toBeNull();
  expect.soft((await fs.stat(stage)).nlink).toBe(2);
  expect.soft((await fs.stat(outside)).nlink).toBe(2);
  expect.soft((await fs.readdir(directory)).filter(name => name.endsWith('.published.json'))).toEqual([]);
  expect(await fs.readFile(stage, 'utf8')).toBe(proposed);
  expect(await fs.readFile(outside, 'utf8')).toBe(proposed);
  await expect(page.getByLabel('Idea explanation', { exact: true })).toHaveValue(explanation);
  await expect(page.getByLabel('Proposed idea Markdown', { exact: true })).toHaveValue(proposed);
});

for (const [boundary, receiptExists] of [['idea-after-publication', false], ['idea-after-receipt', true]]) {
  test(`a process exit at ${boundary} retains one owned note and explicit recovery completes it without resurrection`, async ({}, testInfo) => {
    test.setTimeout(120000);
    await completedConversation();
    const vault = path.join(root, 'vault', 'Companion'), directory = path.join(vault, '.ideas'), ideas = path.join(vault, 'Ideas');
    const sources = await markdownSnapshot(path.join(vault, 'Captures'));
    const submissions = await fs.readFile(path.join(root, 'conversation-submissions.jsonl'), 'utf8');
    const title = `Retain publication at ${boundary}`;
    await page.getByRole('button', { name: 'Draft saved idea', exact: true }).click();
    await page.getByLabel('Idea title', { exact: true }).fill(title);
    await page.getByLabel('Idea explanation', { exact: true }).fill('crashwriting: this exact independent interpretation must survive without another publication or model request.');
    await page.getByLabel('Idea limitations', { exact: true }).fill('Unverified interpretation; the application can exit before publication acknowledgement.');
    await page.getByRole('button', { name: 'Preview saved idea', exact: true }).click();
    await expect(page.getByLabel('Proposed idea Markdown', { exact: true })).toHaveValue(/crashwriting/);
    const proposed = await page.getByLabel('Proposed idea Markdown', { exact: true }).inputValue();
    const destination = await page.getByLabel('Proposed idea destination', { exact: true }).inputValue();
    await fs.writeFile(path.join(root, 'faults.json'), JSON.stringify({ pause: boundary }), 'utf8');
    await page.getByRole('button', { name: 'Confirm saved idea', exact: true }).click();
    await expect.poll(async () => {
      try { return await fs.readFile(path.join(root, 'checkpoint.txt'), 'utf8'); }
      catch (error) { if (error.code === 'ENOENT') return null; throw error; }
    }).toBe(boundary);
    const intentName = (await fs.readdir(directory)).find(name => name.endsWith('.intent.json'));
    const intentFile = path.join(directory, intentName), intentBytes = await fs.readFile(intentFile, 'utf8'), intent = JSON.parse(intentBytes);
    const stage = path.join(directory, `${intent.operation}.md.pending`), receipt = path.join(directory, `${intent.operation}.published.json`);
    expect(await fs.readFile(destination, 'utf8')).toBe(proposed);
    expect((await fs.stat(destination)).nlink).toBe(2);
    expect((await fs.readdir(directory)).includes(path.basename(receipt))).toBe(receiptExists);
    const child = app.process(), mainPid = await app.evaluate(() => process.pid);
    const evidence = { boundary, wrapperPid: child.pid, mainPid, exitBoundary: 'Electron app.exit(77)' };
    const exited = new Promise(resolve => child.once('exit', (code, signal) => resolve({ code, signal })));
    const abrupt = app.evaluate(({ app: electronApp }) => electronApp.exit(77)).catch(error => { if (!/closed|disposed/i.test(error.message)) throw error; });
    evidence.wrapperExit = await exited; await abrupt;
    await expect.poll(() => { try { process.kill(mainPid, 0); return 'alive'; } catch (error) { if (error.code === 'ESRCH') return 'exited'; throw error; } }).toBe('exited');
    await testInfo.attach('crash-processes.json', { body: JSON.stringify(evidence, null, 2), contentType: 'application/json' });
    app = null;
    const expectedSources = { ...sources };
    if (!receiptExists) {
      // Acknowledge the already published note, without authorizing new source use.
      const sourceFile = Object.keys(sources)[0];
      await fs.appendFile(sourceFile, '\nEditor writing after publication and before acknowledgement.\n', 'utf8');
      expectedSources[sourceFile] = await fs.readFile(sourceFile, 'utf8');
    }
    await fs.writeFile(path.join(root, 'faults.json'), '{}', 'utf8'); await launch(false);
    const pending = page.locator('#pending-ideas article').filter({ hasText: title });
    await expect(pending).toBeVisible();
    expect(await fs.readFile(destination, 'utf8')).toBe(proposed);
    expect((await fs.readdir(ideas)).filter(name => name.endsWith('.md'))).toHaveLength(1);
    expect((await fs.stat(destination)).nlink).toBe(2);
    await pending.getByRole('button', { name: 'Resume proposed idea', exact: true }).click();
    await expect(page.getByLabel('Proposed idea Markdown', { exact: true })).toHaveValue(proposed);
    await expect(page.getByLabel('Proposed idea destination', { exact: true })).toHaveValue(destination);
    await page.getByRole('button', { name: 'Confirm saved idea', exact: true }).click();
    await expect(page.locator('#saved-ideas').getByRole('heading', { name: title, exact: true })).toBeVisible();
    expect(await fs.readFile(destination, 'utf8')).toBe(proposed);
    expect((await fs.stat(destination)).nlink).toBe(1);
    expect(await fs.lstat(stage).catch(error => { if (error.code === 'ENOENT') return null; throw error; })).toBeNull();
    expect(JSON.parse(await fs.readFile(receipt, 'utf8')).id).toBe(intent.id);
    expect((await fs.readdir(directory)).filter(name => name.endsWith('.published.json'))).toHaveLength(1);
    await expect(page.locator('#saved-ideas article')).toHaveCount(1);
    expect(await fs.readFile(intentFile, 'utf8')).toBe(intentBytes);
    expect(await markdownSnapshot(path.join(vault, 'Captures'))).toEqual(expectedSources);
    expect(await fs.readFile(path.join(root, 'conversation-submissions.jsonl'), 'utf8')).toBe(submissions);
    await app.close(); app = null;
    await fs.unlink(destination);
    await launch(false);
    await expect(page.locator('#timezone')).toContainText('America/Phoenix');
    await expect(page.locator('#pending-ideas article')).toHaveCount(0);
    await expect(page.locator('#saved-ideas article')).toHaveCount(0);
    expect(await fs.readdir(ideas)).toEqual([]);
    expect(await fs.readFile(intentFile, 'utf8')).toBe(intentBytes);
    expect(await fs.readFile(path.join(root, 'conversation-submissions.jsonl'), 'utf8')).toBe(submissions);
  });
}

test('a source edit during pending confirmation blocks publication and retains the exact proposed writing', async () => {
  test.setTimeout(120000);
  await completedConversation();
  await page.getByRole('button', { name: 'Draft saved idea', exact: true }).click();
  await page.getByLabel('Idea title', { exact: true }).fill('Recheck supporting context before publication');
  await page.getByLabel('Idea explanation', { exact: true }).fill('contextchangewriting: retain the interpretation while requiring review of changed supporting material.');
  await page.getByLabel('Idea limitations', { exact: true }).fill('Unverified interpretation based on the reviewed source bytes.');
  await page.getByRole('button', { name: 'Preview saved idea', exact: true }).click();
  await expect(page.getByLabel('Proposed idea Markdown', { exact: true })).toHaveValue(/contextchangewriting/);
  const proposed = await page.getByLabel('Proposed idea Markdown', { exact: true }).inputValue();
  const destination = await page.getByLabel('Proposed idea destination', { exact: true }).inputValue();
  await fs.writeFile(path.join(root, 'faults.json'), JSON.stringify({ pause: 'idea-before-publication' }), 'utf8');
  await page.getByRole('button', { name: 'Confirm saved idea', exact: true }).click();
  await expect.poll(async () => {
    try { return await fs.readFile(path.join(root, 'checkpoint.txt'), 'utf8'); }
    catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  }).toBe('idea-before-publication');
  const captureDirectory = path.join(root, 'vault', 'Companion', 'Captures');
  const captureFile = path.join(captureDirectory, (await fs.readdir(captureDirectory)).find(name => name.endsWith('.md')));
  await fs.appendFile(captureFile, '\nAn external editor changed the source after preview.\n', 'utf8');
  const edited = await fs.readFile(captureFile, 'utf8');
  await fs.writeFile(path.join(root, 'release.txt'), 'continue', 'utf8');
  await expect(page.locator('#idea-status')).toContainText('Save failed. Proposed content is retained.');
  await expect(page.locator('#idea-status')).toContainText(/context changed|source.*changed|support.*changed/i);
  await expect(page.getByLabel('Proposed idea Markdown', { exact: true })).toHaveValue(proposed);
  expect(await fs.lstat(destination).catch(error => { if (error.code === 'ENOENT') return null; throw error; })).toBeNull();
  expect(await fs.readFile(captureFile, 'utf8')).toBe(edited);
  const directory = path.join(root, 'vault', 'Companion', '.ideas');
  const intentName = (await fs.readdir(directory)).find(name => name.endsWith('.intent.json'));
  expect(JSON.parse(await fs.readFile(path.join(directory, intentName), 'utf8')).text).toBe(proposed);
  expect((await fs.readdir(directory)).filter(name => name.endsWith('.published.json'))).toEqual([]);
});

for (const area of ['Ideas', '.ideas']) {
  test(`a replaced ${area} parent junction rejects outside idea storage while capture stays usable`, async () => {
    test.setTimeout(120000);
    await completedConversation();
    await page.getByRole('button', { name: 'Draft saved idea', exact: true }).click();
    await page.getByLabel('Idea title', { exact: true }).fill('Preserve this pending interpretation inside the vault');
    await page.getByLabel('Idea explanation', { exact: true }).fill('aliaswriting: keep independent writing in its owned vault folder.');
    await page.getByLabel('Idea limitations', { exact: true }).fill('No verified result. A changed storage parent must block idea storage.');
    await page.getByRole('button', { name: 'Preview saved idea', exact: true }).click();
    await expect(page.getByLabel('Proposed idea Markdown', { exact: true })).toHaveValue(/aliaswriting/);
    const proposed = await page.getByLabel('Proposed idea Markdown', { exact: true }).inputValue();
    await fs.writeFile(path.join(root, 'faults.json'), JSON.stringify({ fail: 'idea-before-publication' }), 'utf8');
    await page.getByRole('button', { name: 'Confirm saved idea', exact: true }).click();
    await expect(page.locator('#idea-status')).toContainText('Save failed. Proposed content is retained.');
    await app.close(); app = null;
    const directory = path.join(root, 'vault', 'Companion', area), retained = path.join(root, `retained-${area}-folder`), outside = path.join(root, `outside-${area}-folder`);
    await fs.rename(directory, retained); await fs.mkdir(outside);
    const privateFile = path.join(outside, 'outside-private.md'), privateBytes = '# OUTSIDE_IDEA_PRIVATE_CANARY\n\nThis outside text must remain private and unchanged.\n';
    await fs.writeFile(privateFile, privateBytes, 'utf8');
    await fs.symlink(outside, directory, process.platform === 'win32' ? 'junction' : 'dir');
    try {
      await fs.writeFile(path.join(root, 'faults.json'), '{}', 'utf8'); await launch(false);
      await expect(page.locator('#idea-status')).toContainText(/ordinary|contained|folder/i);
      await expect(page.locator('#ideas-section')).not.toContainText('OUTSIDE_IDEA_PRIVATE_CANARY');
      await page.getByLabel('Thought or link', { exact: true }).fill(`Capture works after ${area} parent alias refusal.`);
      await page.getByRole('button', { name: 'Save capture', exact: true }).click();
      await expect(page.locator('#captures').getByRole('heading', { name: `Capture works after ${area} parent alias refusal.`, exact: true })).toBeVisible();
      expect(await fs.readdir(outside)).toEqual(['outside-private.md']);
      expect(await fs.readFile(privateFile, 'utf8')).toBe(privateBytes);
      const journalDirectory = area === '.ideas' ? retained : path.join(root, 'vault', 'Companion', '.ideas');
      const intentName = (await fs.readdir(journalDirectory)).find(name => name.endsWith('.intent.json'));
      expect(JSON.parse(await fs.readFile(path.join(journalDirectory, intentName), 'utf8')).text).toBe(proposed);
    } finally {
      if (app) { await app.close(); app = null; }
      await fs.unlink(directory);
    }
  });
}
