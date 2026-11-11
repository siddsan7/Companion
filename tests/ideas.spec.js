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
async function launch(configure = true, parent = 'Companion') {
  app = await electron.launch({ args: ['.'], env: { ...process.env, COMPANION_TEST_ROOT: root } });
  page = await app.firstWindow();
  if (configure) {
    await page.getByRole('button', { name: 'Choose vault', exact: true }).click();
    await page.getByLabel('Parent folder', { exact: true }).fill(parent);
    await page.getByRole('button', { name: 'Use this folder', exact: true }).click();
    await expect(page.getByRole('status')).toContainText('Vault ready.');
  }
}
async function completedConversation({ imported = false, twoCaptures = false, scenario, expectedStatus = 'completed', expectedReply = 'Authored synthetic observation', parent } = {}) {
  await fs.writeFile(path.join(root, 'conversation-provider.json'), JSON.stringify(scenario || { reply: 'Authored synthetic observation: revisiting a chord may help practice. The transfer is unverified.' }), 'utf8');
  await launch(true, parent);
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

async function saveCitedExperimentProposal(title, signal, parent = 'Companion') {
  await completedConversation({ imported: true, parent });
  const vault = path.join(root, 'vault', parent);
  const revisions = path.join(vault, 'Revisions');
  const revisionNames = (await fs.readdir(revisions)).filter(name => name.endsWith('.json'));
  expect(revisionNames).toHaveLength(1);
  const snapshotBytes = await fs.readFile(path.join(revisions, revisionNames[0]));
  const snapshot = JSON.parse(snapshotBytes.toString('utf8'));

  await page.getByRole('button', { name: 'Draft saved idea', exact: true }).click();
  await page.getByLabel('Idea title', { exact: true }).fill(title);
  await page.getByLabel('Idea explanation', { exact: true }).fill(`${signal}: compare two practice queues.`);
  await page.getByLabel('Idea limitations', { exact: true }).fill('Authored synthetic source; no experiment was run.');
  await page.getByLabel('Saved idea kind', { exact: true }).selectOption({ label: 'Experiment Proposal' });
  for (const [label, value] of [
    ['Hypothesis', 'A delayed revisit may improve next-day chord changes.'],
    ['Borrowed mechanism', 'Retrieve a learned chord after a delay.'],
    ['Project application', 'Offer a delayed revisit in the MyTune practice queue.'],
    ['Smallest test', 'Compare two practice sessions with and without a delayed revisit.'],
    ['Observable result', 'Count next-day clean chord changes out of ten attempts.']
  ]) await page.getByLabel(label, { exact: true }).fill(value);
  await page.getByRole('checkbox', { name: 'Cite evidence a1 from Authored synthetic review', exact: true }).check();
  await page.getByRole('button', { name: 'Preview saved idea', exact: true }).click();
  const preview = page.getByLabel('Proposed idea Markdown', { exact: true });
  await expect(preview).toHaveValue(/evidence_id: a1/);
  const text = await preview.inputValue();
  const fields = YAML.parse(text.match(/^---\n([\s\S]*?)\n---\n/)[1]);
  expect(fields.idea_kind).toBe('experiment_proposal');
  expect(fields.citations).toHaveLength(1);
  expect(fields.citations[0]).toMatchObject({
    kind: 'imported_evidence', capture_id: snapshot.captureId, revision_id: snapshot.id,
    snapshot_sha256: createHash('sha256').update(snapshotBytes).digest('hex'),
    evidence_id: 'a1', excerpt: 'Authored synthetic review fixture only.'
  });
  const destination = await page.getByLabel('Proposed idea destination', { exact: true }).inputValue();
  await page.getByRole('button', { name: 'Confirm saved idea', exact: true }).click();
  await expect(page.locator('#idea-status')).toContainText('Saved idea.');
  const bytes = await fs.readFile(destination);
  expect(bytes.toString('utf8')).toBe(text);
  return { vault, destination, bytes, id: fields.companion_id, snapshot };
}

test('a moved and renamed Experiment Proposal keeps its saved idea identity and exact citation after restart', async () => {
  test.setTimeout(120000);
  const title = 'Try a delayed practice queue';
  const signal = 'movedproposalidentity';
  const proposal = await saveCitedExperimentProposal(title, signal);
  const directory = path.join(proposal.vault, 'Practice Notes', 'Proposed Tests');
  await fs.mkdir(directory, { recursive: true });
  const moved = path.join(directory, 'A delayed revisit.md');
  await fs.rename(proposal.destination, moved);

  await app.close(); app = null; await launch(false);
  const idea = page.locator('#saved-ideas article').filter({ has: page.getByRole('heading', { name: title, exact: true }) });
  await expect(idea).toHaveCount(1);
  await idea.getByRole('button', { name: 'Open saved idea in Obsidian', exact: true }).click();
  await expect.poll(dispatchedUri).toBe(`obsidian://open?path=${encodeURIComponent(moved)}`);
  await idea.getByRole('button', { name: 'Inspect cited evidence', exact: true }).click();
  await expect(page.locator('#idea-evidence')).toContainText(`Cited revision ${proposal.snapshot.id}; evidence a1`);
  await expect(page.locator('#idea-evidence')).toContainText('Authored synthetic review fixture only.');
  await expect(page.getByLabel('Cited revision snapshot', { exact: true })).toHaveValue(proposal.snapshot.text.replace(/\r\n?/g, '\n'));

  await page.getByLabel('Context question', { exact: true }).fill(signal);
  await page.getByRole('button', { name: 'Find context', exact: true }).click();
  await expect(page.locator('#context-results').getByRole('heading', { name: title, exact: true })).toBeVisible();
  const manual = page.getByLabel('Manual context source', { exact: true });
  await manual.selectOption({ label: title });
  await expect(manual).toHaveValue(`idea:${proposal.id}`);
  await page.getByRole('button', { name: 'Add manual source', exact: true }).click();
  await page.getByRole('button', { name: 'Preview context', exact: true }).click();
  const packageText = page.getByLabel('Actual context package', { exact: true });
  await expect(packageText).toHaveValue(new RegExp(`Saved idea ${proposal.id};`));
  await expect(packageText).toHaveValue(new RegExp(`${signal}: compare two practice queues`));
  expect(await fs.readFile(moved)).toEqual(proposal.bytes);
  await expect(fs.lstat(proposal.destination)).rejects.toMatchObject({ code: 'ENOENT' });
});

test('a duplicate saved idea in an ordinary nested folder blocks discovery and previously selected use', async () => {
  test.setTimeout(120000);
  const title = 'A proposal with an independent copy';
  const signal = 'duplicateproposalidentity';
  const proposal = await saveCitedExperimentProposal(title, signal);
  await page.getByLabel('Context question', { exact: true }).fill(signal);
  await page.getByRole('button', { name: 'Find context', exact: true }).click();
  const results = page.locator('#context-results');
  const result = results.getByRole('heading', { name: title, exact: true });
  await expect(result).toBeVisible();
  const manual = page.getByLabel('Manual context source', { exact: true });
  await manual.selectOption({ label: title });
  await expect(manual).toHaveValue(`idea:${proposal.id}`);
  await page.getByRole('button', { name: 'Add manual source', exact: true }).click();

  const directory = path.join(proposal.vault, 'Practice Notes', 'Independent Copies');
  await fs.mkdir(directory, { recursive: true });
  const duplicate = path.join(directory, 'A different file.md');
  // This copy claims the same identity but could not qualify as supporting context.
  const copyText = proposal.bytes.toString('utf8').replace('support_attribution_unavailable: false', 'support_attribution_unavailable: true');
  expect(copyText).toContain('support_attribution_unavailable: true');
  const duplicateBytes = Buffer.from(`${copyText}\nIndependent writing in the duplicate.\n`, 'utf8');
  await fs.writeFile(duplicate, duplicateBytes, { flag: 'wx' });

  const packageText = page.getByLabel('Actual context package', { exact: true });
  await page.getByRole('button', { name: 'Preview context', exact: true }).click();
  const contextError = page.locator('#context-error');
  await expect.poll(async () => !!(await contextError.textContent()) || !!(await packageText.inputValue())).toBe(true);
  await expect.soft(packageText).toHaveValue('', { timeout: 1000 });
  await expect.soft(contextError).toContainText(/unavailable|changed|duplicat|ambigu/i, { timeout: 1000 });

  const idea = page.locator('#saved-ideas article').filter({ has: page.getByRole('heading', { name: title, exact: true }) });
  const ideaStatus = page.locator('#idea-status');
  await idea.getByRole('button', { name: 'Open saved idea in Obsidian', exact: true }).click();
  await expect.poll(async () => !!await dispatchedUri() || /before opening/i.test(await ideaStatus.textContent())).toBe(true);
  expect.soft(await dispatchedUri()).toBeNull();
  await idea.getByRole('button', { name: 'Inspect cited evidence', exact: true }).click();
  const evidence = page.getByLabel('Cited revision snapshot', { exact: true });
  await expect.poll(async () => await evidence.isVisible() || /identity is missing or ambiguous/i.test(await ideaStatus.textContent())).toBe(true);
  await expect.soft(evidence).toBeHidden({ timeout: 1000 });

  await page.getByRole('button', { name: 'Find context', exact: true }).click();
  await expect(page.getByText('Context search complete.', { exact: true })).toBeVisible();
  await expect.soft(result).toHaveCount(0, { timeout: 1000 });
  await expect.soft(manual.getByRole('option', { name: title, exact: true })).toHaveCount(0, { timeout: 1000 });
  await expect.soft(contextError).toContainText(/duplicat|ambigu/i, { timeout: 1000 });
  expect(await fs.readFile(proposal.destination)).toEqual(proposal.bytes);
  expect(await fs.readFile(duplicate)).toEqual(duplicateBytes);
});

test('a selected dot-prefixed parent retains its saved idea while private vault stores stay excluded', async () => {
  test.setTimeout(120000);
  const title = 'A proposal in the selected dot-prefixed parent';
  const signal = 'dotparentproposalsignal';
  const proposal = await saveCitedExperimentProposal(title, signal, '.Companion');
  const privateFolder = path.join(root, 'vault', '.obsidian');
  await fs.mkdir(privateFolder);
  const privateNote = path.join(privateFolder, 'Private copy.md');
  const privateBytes = Buffer.from(`${proposal.bytes.toString('utf8')}\nPRIVATE_IDEA_STORE_17\n`);
  await fs.writeFile(privateNote, privateBytes, { flag: 'wx' });

  await app.close(); app = null; await launch(false);
  const idea = page.locator('#saved-ideas article').filter({ has: page.getByRole('heading', { name: title, exact: true }) });
  await expect(idea).toHaveCount(1);
  await idea.getByRole('button', { name: 'Open saved idea in Obsidian', exact: true }).click();
  await expect.poll(dispatchedUri).toBe(`obsidian://open?path=${encodeURIComponent(proposal.destination)}`);
  await page.getByLabel('Context question', { exact: true }).fill(signal);
  await page.getByRole('button', { name: 'Find context', exact: true }).click();
  await expect(page.locator('#context-results').getByRole('heading', { name: title, exact: true })).toHaveCount(1);
  await page.getByLabel('Manual context source', { exact: true }).selectOption(`idea:${proposal.id}`);
  await page.getByRole('button', { name: 'Add manual source', exact: true }).click();
  await page.getByRole('button', { name: 'Preview context', exact: true }).click();
  const packageText = page.getByLabel('Actual context package', { exact: true });
  await expect(packageText).toHaveValue(new RegExp(`Saved idea ${proposal.id};`));
  await expect(packageText).not.toHaveValue(/PRIVATE_IDEA_STORE_17/);
  expect(await fs.readFile(proposal.destination)).toEqual(proposal.bytes);
  expect(await fs.readFile(privateNote)).toEqual(privateBytes);
});

test('unrelated malformed Markdown permits browsing and confirming saved ideas', async () => {
  test.setTimeout(120000);
  const title = 'Browse a proposal beside ordinary Markdown';
  const signal = 'unrelatedmalformedsignal';
  const proposal = await saveCitedExperimentProposal(title, signal);
  const note = path.join(root, 'vault', 'Unrelated writing.md');
  const noteBytes = Buffer.from('---\ntags: [unclosed\n---\n\nKeep this independent draft exactly as written.\n');
  await fs.writeFile(note, noteBytes, { flag: 'wx' });

  await page.getByRole('button', { name: 'Refresh saved idea support', exact: true }).click();
  const supportStatus = page.locator('#idea-support-status');
  await expect(supportStatus).toContainText(/Current support inspected|Support inspection unavailable/);
  await expect.soft(supportStatus).toContainText('Current support inspected', { timeout: 1000 });
  await page.getByLabel('Context question', { exact: true }).fill(signal);
  await page.getByRole('button', { name: 'Find context', exact: true }).click();
  await expect(page.getByText('Context search complete.', { exact: true })).toBeVisible();
  await expect.soft(page.locator('#context-results').getByRole('heading', { name: title, exact: true })).toBeVisible({ timeout: 1000 });

  const nextTitle = 'Confirm another idea beside ordinary Markdown';
  await page.getByRole('button', { name: 'Draft saved idea', exact: true }).click();
  await page.getByLabel('Idea title', { exact: true }).fill(nextTitle);
  await page.getByLabel('Idea explanation', { exact: true }).fill('An independent synthetic interpretation of the retained reply.');
  await page.getByLabel('Idea limitations', { exact: true }).fill('Authored synthetic fixture; no observed outcome.');
  await page.getByLabel('Saved idea kind', { exact: true }).selectOption({ label: 'Observation' });
  await page.getByRole('button', { name: 'Preview saved idea', exact: true }).click();
  const preview = page.getByLabel('Proposed idea Markdown', { exact: true });
  await expect(preview).toHaveValue(new RegExp(nextTitle));
  const text = await preview.inputValue();
  const destination = await page.getByLabel('Proposed idea destination', { exact: true }).inputValue();
  await page.getByRole('button', { name: 'Confirm saved idea', exact: true }).click();
  await expect(page.locator('#idea-status')).toContainText(/^(Saved idea\.|Save failed\.)/);
  await expect.soft(page.locator('#idea-status')).toContainText('Saved idea.', { timeout: 1000 });
  const published = await fs.readFile(destination, 'utf8').catch(error => { if (error.code === 'ENOENT') return null; throw error; });
  expect.soft(published).toBe(text);
  expect(await fs.readFile(proposal.destination)).toEqual(proposal.bytes);
  expect(await fs.readFile(note)).toEqual(noteBytes);
});

test('two managed parents in the same vault keep their saved ideas and Context scope separate', async () => {
  test.setTimeout(120000);
  const oldTitle = 'A published proposal in the first parent';
  const signal = 'managedparentideascope';
  const proposal = await saveCitedExperimentProposal(oldTitle, signal);
  const other = path.join(root, 'vault', 'Other Companion');
  const firstLegacy = 'First parent independent idea';
  const secondLegacy = 'Second parent independent idea';
  const firstId = '77000000-0000-4000-8000-000000000001';
  const secondId = '77000000-0000-4000-8000-000000000002';
  const legacy = (id, title) => `---\nartifact_type: saved_idea\nschema_version: 1\ncompanion_id: ${id}\ntitle: ${title}\nsource_dependencies: []\n---\n\n${signal}: ${title}.\n`;
  const firstFile = path.join(proposal.vault, 'Ideas', 'First independent note.md');
  const secondFolder = path.join(other, 'Ideas', 'Independent Notes');
  await fs.mkdir(secondFolder, { recursive: true });
  const secondFile = path.join(secondFolder, 'Second independent note.md');
  await fs.writeFile(firstFile, legacy(firstId, firstLegacy), { flag: 'wx' });
  await fs.writeFile(secondFile, legacy(secondId, secondLegacy), { flag: 'wx' });

  await page.getByLabel('Parent folder', { exact: true }).fill(path.basename(other));
  await page.getByRole('button', { name: 'Use this folder', exact: true }).click();
  await expect(page.locator('#location')).toHaveText(other);
  const saved = page.locator('#saved-ideas');
  await expect(saved.getByRole('heading', { name: secondLegacy, exact: true })).toBeVisible();
  await expect.soft(saved.getByRole('heading', { name: oldTitle, exact: true })).toHaveCount(0, { timeout: 1000 });
  await expect.soft(saved.getByRole('heading', { name: firstLegacy, exact: true })).toHaveCount(0, { timeout: 1000 });

  await page.getByLabel('Context question', { exact: true }).fill(signal);
  await page.getByRole('button', { name: 'Find context', exact: true }).click();
  await expect(page.getByText('Context search complete.', { exact: true })).toBeVisible();
  const results = page.locator('#context-results');
  await expect(results.getByRole('heading', { name: secondLegacy, exact: true })).toBeVisible();
  await expect.soft(results.getByRole('heading', { name: firstLegacy, exact: true })).toHaveCount(0, { timeout: 1000 });
  const manual = page.getByLabel('Manual context source', { exact: true });
  await manual.selectOption(`idea:${secondId}`);
  await expect.soft(manual.getByRole('option', { name: firstLegacy, exact: true })).toHaveCount(0, { timeout: 1000 });
  await page.getByRole('button', { name: 'Add manual source', exact: true }).click();
  await page.getByRole('button', { name: 'Preview context', exact: true }).click();
  const packageText = page.getByLabel('Actual context package', { exact: true });
  await expect(packageText).toHaveValue(new RegExp(`Saved idea ${secondId};`));
  await expect(packageText).not.toHaveValue(new RegExp(firstId));
  expect(await fs.readFile(proposal.destination)).toEqual(proposal.bytes);
  expect(await fs.readFile(firstFile, 'utf8')).toBe(legacy(firstId, firstLegacy));
  expect(await fs.readFile(secondFile, 'utf8')).toBe(legacy(secondId, secondLegacy));
});

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

test('Saved idea completion waits for its source inspection before the next explicit Check now', async () => {
  await completedConversation({ imported: true });
  const vault = path.join(root, 'vault', 'Companion');
  const ideas = path.join(vault, 'Ideas');
  const submissionsFile = path.join(root, 'conversation-submissions.jsonl');
  const submissions = await fs.readFile(submissionsFile, 'utf8');
  expect(submissions.trim().split('\n')).toHaveLength(1);
  const title = 'Keep an observation from the authored evidence';
  await page.getByRole('button', { name: 'Draft saved idea', exact: true }).click();
  await page.getByLabel('Idea title', { exact: true }).fill(title);
  await page.getByLabel('Idea explanation', { exact: true }).fill('The reviewed evidence helps explain where this observation came from.');
  await page.getByLabel('Idea limitations', { exact: true }).fill('Authored synthetic fixture. No learning outcome was measured.');
  await page.getByRole('checkbox', { name: 'Cite evidence a1 from Authored synthetic review', exact: true }).check();
  await page.getByRole('button', { name: 'Preview saved idea', exact: true }).click();
  await expect(page.getByLabel('Proposed idea Markdown', { exact: true })).toHaveValue(new RegExp(title));
  const proposed = await page.getByLabel('Proposed idea Markdown', { exact: true }).inputValue();
  const destination = await page.getByLabel('Proposed idea destination', { exact: true }).inputValue();
  expect(await fs.readdir(ideas)).toEqual([]);

  await app.evaluate(({ app: mainApp, ipcMain }, { root, vault }) => {
    if (process.env.COMPANION_TEST_ROOT !== root) throw Error('Held idea inspection requires the disposable fixture.');
    const load = process.getBuiltinModule('module').createRequire(mainApp.getAppPath() + '/app/main.js');
    const { Intake } = load('./intake');
    const { AsyncLocalStorage } = process.getBuiltinModule('async_hooks');
    const scope = new AsyncLocalStorage(), originalInfo = Intake.prototype.info;
    const handlers = new Map(['idea-confirm', 'idea-list', 'check-intake'].map(channel => [channel, ipcMain._invokeHandlers.get(channel)]));
    const gate = globalThis.__ideaSaveCompletion = { held: false, claimed: false, confirms: 0, checks: [] };
    const delivery = new Promise(resolve => { gate.release = resolve; });
    ipcMain._invokeHandlers.set('idea-confirm', async function (...args) {
      gate.confirms++;
      const result = await Reflect.apply(handlers.get('idea-confirm'), this, args);
      gate.publication = result;
      return result;
    });
    ipcMain._invokeHandlers.set('idea-list', function (...args) {
      const original = handlers.get('idea-list');
      if (!gate.publication || gate.list) return Reflect.apply(original, this, args);
      gate.list = scope.run(gate, () => Reflect.apply(original, this, args));
      return gate.list;
    });
    ipcMain._invokeHandlers.set('check-intake', async function (...args) {
      const check = {};
      gate.checks.push(check);
      try {
        const result = await Reflect.apply(handlers.get('check-intake'), this, args);
        check.lastCheck = result.lastCheck;
        return result;
      } catch (error) { check.error = error.message; throw error; }
    });
    Intake.prototype.info = async function (...args) {
      if (scope.getStore() !== gate || this.vault.root !== vault || gate.claimed) return Reflect.apply(originalInfo, this, args);
      gate.claimed = true;
      const ownLocked = Object.getOwnPropertyDescriptor(this, 'locked'), nativeLocked = this.locked;
      this.locked = function (work, ...lockedArgs) {
        return Reflect.apply(nativeLocked, this, [async function (...workArgs) {
          // Context already holds the native source owner for this idea-list inspection.
          gate.held = true;
          await delivery;
          return Reflect.apply(work, this, workArgs);
        }, ...lockedArgs]);
      };
      try { return await Reflect.apply(originalInfo, this, args); }
      finally { if (ownLocked) Object.defineProperty(this, 'locked', ownLocked); else delete this.locked; }
    };
    gate.restore = () => {
      Intake.prototype.info = originalInfo;
      for (const [channel, original] of handlers) ipcMain._invokeHandlers.set(channel, original);
    };
  }, { root, vault });

  const status = page.locator('#idea-status'), now = '2026-11-09T12:00:01Z';
  const expectedCheck = { at: now, trigger: 'manual', status: 'complete' };
  try {
    await page.getByRole('button', { name: 'Confirm saved idea', exact: true }).click();
    await expect.poll(() => app.evaluate(() => globalThis.__ideaSaveCompletion.held)).toBe(true);
    expect(await fs.readFile(destination, 'utf8')).toBe(proposed);
    expect(await fs.readdir(ideas)).toEqual([path.basename(destination)]);
    expect.soft(await status.textContent(), 'The saved note is durable while its support inspection is pending').not.toContain('Saved idea.');

    await fs.writeFile(path.join(root, 'clock.json'), JSON.stringify({ now, timezone: 'America/Phoenix' }), 'utf8');
    const listed = await app.evaluate(async () => {
      const gate = globalThis.__ideaSaveCompletion;
      gate.release();
      return (await gate.list).map(({ title, file }) => ({ title, file }));
    });
    await expect(status).toContainText('Saved idea.');
    await page.getByRole('button', { name: 'Check now', exact: true }).click();
    await expect.poll(() => app.evaluate(() => globalThis.__ideaSaveCompletion.checks)).toEqual([{ lastCheck: expectedCheck }]);
    await expect(page.locator('#intake-state')).toContainText(`Last check: ${now} · manual · complete`);
    const ledger = JSON.parse(await fs.readFile(path.join(vault, '.intake', 'ledger.json'), 'utf8'));
    expect(ledger.lastCheck).toEqual(expectedCheck);
    await expect(page.locator('#saved-ideas').getByRole('heading', { name: title, exact: true })).toHaveCount(1);
    expect(listed).toEqual([{ title, file: destination }]);
    expect(await app.evaluate(() => globalThis.__ideaSaveCompletion.confirms)).toBe(1);
    expect(await fs.readdir(ideas)).toEqual([path.basename(destination)]);
    expect(await fs.readFile(destination, 'utf8')).toBe(proposed);
    expect(await fs.readFile(submissionsFile, 'utf8')).toBe(submissions);
  } finally {
    await app.evaluate(async () => {
      const gate = globalThis.__ideaSaveCompletion;
      gate.release();
      try { await gate.list?.catch(() => {}); }
      finally { gate.restore(); delete globalThis.__ideaSaveCompletion; }
    });
  }
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

test('rejected support flags independent saved ideas for review while excluding direct and transitive dialogue without rewriting retained writing', async () => {
  test.setTimeout(150000);
  await completedConversation({ imported: true, scenario: { reply: 'REJECTED_DIRECT_DIALOGUE_12: authored synthetic interpretation from accepted source evidence.' }, expectedReply: 'REJECTED_DIRECT_DIALOGUE_12' });
  await page.reload(); await expect(page.locator('#conversation-history')).toContainText('REJECTED_DIRECT_DIALOGUE_12');
  await page.getByLabel('Context question', { exact: true }).fill('What limitations follow from that historical interpretation?');
  await page.getByRole('button', { name: 'Preview conversation', exact: true }).click();
  await expect(page.getByLabel('Reviewed conversation package', { exact: true })).toHaveValue(/REJECTED_DIRECT_DIALOGUE_12/);
  await fs.writeFile(path.join(root, 'conversation-provider.json'), JSON.stringify({ reply: 'REJECTED_TRANSITIVE_DIALOGUE_12: authored synthetic application derived from the earlier interpretation.' }), 'utf8');
  await page.getByRole('button', { name: 'Send reviewed package', exact: true }).click();
  await expect(page.locator('#conversation-history')).toContainText('REJECTED_TRANSITIVE_DIALOGUE_12');
  await expect(page.locator('#conversation-history article').last()).toContainText('completed');
  await page.locator('#conversation-history article').last().getByRole('button', { name: 'Draft saved idea', exact: true }).click();
  const title = 'Retained independent interpretation needs support review';
  await page.getByLabel('Idea title', { exact: true }).fill(title);
  await page.getByLabel('Idea explanation', { exact: true }).fill('The user keeps this proposed application even when support later becomes unavailable.');
  await page.getByLabel('Idea limitations', { exact: true }).fill('Authored synthetic interpretation; no outcome or sentence-level support was verified.');
  await page.getByRole('button', { name: 'Preview saved idea', exact: true }).click();
  await expect(page.getByLabel('Proposed idea Markdown', { exact: true })).toHaveValue(/Retained independent interpretation/);
  const ideaFile = await page.getByLabel('Proposed idea destination', { exact: true }).inputValue();
  await page.getByRole('button', { name: 'Confirm saved idea', exact: true }).click();
  await expect(page.locator('#idea-status')).toContainText('Saved idea');
  const vault = path.join(root, 'vault', 'Companion'), ideaBytes = await fs.readFile(ideaFile, 'utf8'), metadata = YAML.parse(ideaBytes.match(/^---\n([\s\S]*?)\n---\n/)[1]);
  expect(metadata.support_attribution_unavailable).toBe(false);
  expect(metadata.source_dependencies).toHaveLength(1);
  const captureId = metadata.source_dependencies[0].capture_id;
  const historyDirectory = path.join(root, 'conversations'), historyName = (await fs.readdir(historyDirectory)).find(name => /^[a-f0-9-]{36}\.json$/.test(name)), historyFile = path.join(historyDirectory, historyName), historyBytes = await fs.readFile(historyFile, 'utf8');
  const retainedRevisions = {};
  for (const name of await fs.readdir(path.join(vault, 'Revisions'))) retainedRevisions[name] = await fs.readFile(path.join(vault, 'Revisions', name), 'utf8');
  const independent = path.join(root, 'vault', 'Independent review writing.md'), independentBytes = '# Independent writing\n\nPreserve this text and any quotations independently of source review.\n';
  await fs.writeFile(independent, independentBytes, 'utf8');
  const calls = await fs.readFile(path.join(root, 'conversation-submissions.jsonl'), 'utf8');
  await fs.cp(path.join(__dirname, 'fixtures/reel-review/reject'), path.join(root, 'producer', 'reject'), { recursive: true });
  await fs.writeFile(path.join(root, 'clock.json'), JSON.stringify({ now: '2026-11-09T12:00:01Z', timezone: 'America/Phoenix' }), 'utf8');
  await page.getByRole('button', { name: 'Check now', exact: true }).click();
  await expect(page.locator('#intake-state')).toContainText('Last check: 2026-11-09T12:00:01Z · manual · complete');
  await page.getByRole('button', { name: 'Inspect source', exact: true }).click();
  await page.getByLabel('Source inspection').locator('article').filter({ hasText: 'Human review: reject' }).getByRole('button', { name: 'Make current', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('Current revision selected');
  await expect(page.getByLabel('Source inspection')).toContainText('Supporting evidence: excluded by rejection');
  const postDecisionCaptures = await markdownSnapshot(path.join(vault, 'Captures'));
  await page.getByLabel('Context question', { exact: true }).fill('Use only eligible project context after explicit rejection.');
  await page.getByRole('button', { name: 'Find context', exact: true }).click();
  await expect(page.getByLabel('Manual context source', { exact: true }).locator('option').filter({ hasText: title })).toHaveCount(0);
  await page.getByRole('button', { name: 'Preview conversation', exact: true }).click();
  await expect(page.getByLabel('Reviewed conversation package', { exact: true })).toHaveValue(/eligible project context after explicit rejection/);
  await expect(page.getByLabel('Reviewed conversation package', { exact: true })).not.toHaveValue(/REJECTED_DIRECT_DIALOGUE_12|REJECTED_TRANSITIVE_DIALOGUE_12|Authored synthetic review fixture only/);
  await expect(page.locator('#conversation-history')).toContainText('REJECTED_DIRECT_DIALOGUE_12');
  await expect(page.locator('#conversation-history')).toContainText('REJECTED_TRANSITIVE_DIALOGUE_12');
  await expect(page.locator('#conversation-history .history-exclusion')).toHaveCount(2);
  await page.getByRole('button', { name: 'Refresh saved idea support', exact: true }).click();
  const idea = page.locator('#saved-ideas article').filter({ hasText: title });
  await expect(idea).toContainText(/Review support/i);
  await expect(idea).toContainText(/unavailable|rejected|removed/i);
  await expect(idea).toContainText(captureId);
  await expect(idea.getByRole('button', { name: 'Open saved idea in Obsidian', exact: true })).toBeEnabled();
  await idea.getByRole('button', { name: 'Open saved idea in Obsidian', exact: true }).click();
  await expect.poll(dispatchedUri).toBe(`obsidian://open?path=${encodeURIComponent(ideaFile)}`);
  expect(await fs.readFile(ideaFile, 'utf8')).toBe(ideaBytes); expect(await fs.readFile(historyFile, 'utf8')).toBe(historyBytes);
  expect(await markdownSnapshot(path.join(vault, 'Captures'))).toEqual(postDecisionCaptures);
  for (const [name, bytes] of Object.entries(retainedRevisions)) expect(await fs.readFile(path.join(vault, 'Revisions', name), 'utf8')).toBe(bytes);
  expect(await fs.readFile(independent, 'utf8')).toBe(independentBytes); expect(await fs.readFile(path.join(root, 'conversation-submissions.jsonl'), 'utf8')).toBe(calls);
  await app.close(); app = null; await launch(false);
  await expect(page.locator('#saved-ideas article').filter({ hasText: title })).toContainText(/Review support/i);
  await expect(page.locator('#saved-ideas article').filter({ hasText: title }).getByRole('button', { name: 'Open saved idea in Obsidian', exact: true })).toBeEnabled();
  expect(await fs.readFile(ideaFile, 'utf8')).toBe(ideaBytes); expect(await fs.readFile(historyFile, 'utf8')).toBe(historyBytes);
  expect(await fs.readFile(path.join(root, 'conversation-submissions.jsonl'), 'utf8')).toBe(calls);
});
