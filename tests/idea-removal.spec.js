const { test, expect, _electron: electron } = require('@playwright/test');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
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
  const currentWriting = 'CURRENT_SAVED_IDEA_13: independently edited note writing must be reviewed before removal.';
  await fs.writeFile(selected, (await fs.readFile(selected, 'utf8')).replace('Independent authored writing for Selected independent idea.', currentWriting), 'utf8');
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
  await expect(preview).toContainText(currentWriting);
  await expect(preview).toContainText('Independent authored writing for Selected independent idea.');
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

test('a confirmed removal survives actual exit and excludes its still-present saved idea from context before explicit recovery', async ({}, testInfo) => {
  test.setTimeout(120000);
  await completedConversation();
  const title = 'Selected removal context before recovery', retainedTitle = 'Retained eligible idea after removal exit';
  const selected = await saveIdea(title), retained = await saveIdea(retainedTitle);
  const vault = path.join(root, 'vault', 'Companion'), directory = path.join(vault, '.ideas');
  const selectedBytes = await fs.readFile(selected, 'utf8'), retainedBytes = await fs.readFile(retained, 'utf8');
  const metadata = YAML.parse(selectedBytes.match(/^---\n([\s\S]*?)\n---\n/)[1]);
  const sources = await bytesIn(path.join(vault, 'Captures')), history = await bytesIn(path.join(root, 'conversations'));
  const selectedCopies = [selected];
  for (const name of await fs.readdir(directory)) {
    if (!name.endsWith('.json')) continue;
    const file = path.join(directory, name), value = JSON.parse(await fs.readFile(file, 'utf8'));
    if (value.id === metadata.companion_id) selectedCopies.push(file);
  }
  expect(selectedCopies).toHaveLength(3);
  await page.getByLabel('Context question', { exact: true }).fill(title);
  await page.getByRole('button', { name: 'Find context', exact: true }).click();
  await expect(page.getByLabel('Manual context source', { exact: true }).locator('option').filter({ hasText: title })).toHaveCount(1);
  await page.locator('#saved-ideas article').filter({ hasText: title }).getByRole('button', { name: 'Preview saved idea removal', exact: true }).click();
  await fs.writeFile(path.join(root, 'faults.json'), JSON.stringify({ pause: 'idea-removal-after-marker' }), 'utf8');
  await page.getByRole('button', { name: 'Confirm saved idea removal', exact: true }).click();
  await expect.poll(async () => {
    try { return await fs.readFile(path.join(root, 'checkpoint.txt'), 'utf8'); }
    catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  }).toBe('idea-removal-after-marker');
  for (const file of selectedCopies) expect(await fs.lstat(file)).toBeTruthy();
  expect(await fs.readFile(selected, 'utf8')).toBe(selectedBytes);
  const marker = path.join(directory, `${metadata.companion_id}.removed.json`), markerBytes = await fs.readFile(marker, 'utf8');
  expect(JSON.parse(markerBytes).ideaId).toBe(metadata.companion_id);
  expect(markerBytes).not.toContain('Independent authored writing for');
  const markerStat = await fs.stat(marker), stageStat = await fs.stat(`${marker}.pending`);
  expect(markerStat.nlink).toBe(2); expect(stageStat.ino).toBe(markerStat.ino);
  const child = app.process(), mainPid = await app.evaluate(() => process.pid);
  const exited = new Promise(resolve => child.once('exit', (code, signal) => resolve({ code, signal })));
  const abrupt = app.evaluate(({ app: electronApp }) => electronApp.exit(77)).catch(error => { if (!/closed|disposed/i.test(error.message)) throw error; });
  const wrapperExit = await exited; await abrupt;
  await expect.poll(() => { try { process.kill(mainPid, 0); return 'alive'; } catch (error) { if (error.code === 'ESRCH') return 'exited'; throw error; } }).toBe('exited');
  const exitEvidence = testInfo.outputPath('idea-removal-exit.json');
  await fs.writeFile(exitEvidence, JSON.stringify({ wrapperPid: child.pid, mainPid, wrapperExit, boundary: 'idea-removal-after-marker', exitBoundary: 'Electron app.exit(77)' }, null, 2), 'utf8');
  await testInfo.attach('idea-removal-exit.json', { path: exitEvidence, contentType: 'application/json' });
  app = null;
  await fs.writeFile(path.join(root, 'faults.json'), '{}', 'utf8'); await launch(false);
  await expect(page.locator('#idea-removal-recovery')).toContainText(metadata.companion_id);
  for (const file of selectedCopies) expect(await fs.lstat(file)).toBeTruthy();
  expect(await fs.readFile(selected, 'utf8')).toBe(selectedBytes);
  await page.getByLabel('Context question', { exact: true }).fill(title);
  await page.getByRole('button', { name: 'Find context', exact: true }).click();
  const options = page.getByLabel('Manual context source', { exact: true }).locator('option');
  await expect(options.filter({ hasText: retainedTitle })).toHaveCount(1);
  await expect(options.filter({ hasText: title })).toHaveCount(0);
  await expect(page.locator('#context-results article').filter({ hasText: title })).toHaveCount(0);
  await page.getByRole('button', { name: 'Recover confirmed saved idea removal', exact: true }).click();
  await expect(page.locator('#idea-status')).toContainText('Saved idea removal complete.');
  for (const file of selectedCopies) expect(await fs.lstat(file).catch(error => { if (error.code === 'ENOENT') return null; throw error; })).toBeNull();
  expect(await fs.readFile(marker, 'utf8')).toBe(markerBytes);
  expect((await fs.stat(marker)).nlink).toBe(1);
  expect(await fs.lstat(`${marker}.pending`).catch(error => { if (error.code === 'ENOENT') return null; throw error; })).toBeNull();
  expect(await fs.readFile(retained, 'utf8')).toBe(retainedBytes);
  expect(await bytesIn(path.join(vault, 'Captures'))).toEqual(sources);
  expect(await bytesIn(path.join(root, 'conversations'))).toEqual(history);
});

test('an unowned selected-idea stage added after removal preview holds before any marker or unlink', async ({}, testInfo) => {
  test.setTimeout(120000);
  await completedConversation();
  const title = 'Selected idea with an unknown pending copy';
  const selected = await saveIdea(title), retained = await saveIdea('Other idea survives unknown copy hold');
  const vault = path.join(root, 'vault', 'Companion'), directory = path.join(vault, '.ideas');
  const selectedBytes = await fs.readFile(selected, 'utf8'), retainedBytes = await fs.readFile(retained, 'utf8');
  const id = YAML.parse(selectedBytes.match(/^---\n([\s\S]*?)\n---\n/)[1]).companion_id;
  const history = await bytesIn(path.join(root, 'conversations'));
  await page.locator('#saved-ideas article').filter({ hasText: title }).getByRole('button', { name: 'Preview saved idea removal', exact: true }).click();
  await expect(page.getByLabel('Saved idea removal preview', { exact: true })).toContainText(id);
  const orphan = path.join(directory, `${randomUUID()}.md.pending`);
  await fs.writeFile(orphan, selectedBytes, { flag: 'wx', encoding: 'utf8' });
  const before = await bytesIn(vault);
  await page.getByRole('button', { name: 'Confirm saved idea removal', exact: true }).click();
  await expect(page.locator('#idea-status')).toContainText(/Saved idea removal (held|complete)/);
  const marker = path.join(directory, `${id}.removed.json`);
  const exists = async file => !!await fs.lstat(file).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
  const evidence = testInfo.outputPath('idea-removal-orphan-scope.json');
  await fs.writeFile(evidence, JSON.stringify({ markerExists: await exists(marker), selectedExists: await exists(selected), orphanExists: await exists(orphan), status: await page.locator('#idea-status').innerText() }, null, 2), 'utf8');
  expect(await exists(marker)).toBe(false);
  expect(await exists(`${marker}.pending`)).toBe(false);
  await expect(page.locator('#idea-status')).toContainText('Saved idea removal held.');
  expect(await bytesIn(vault)).toEqual(before);
  expect(await fs.readFile(orphan, 'utf8')).toBe(selectedBytes);
  expect(await fs.readFile(retained, 'utf8')).toBe(retainedBytes);
  expect(await bytesIn(path.join(root, 'conversations'))).toEqual(history);
});

test('a pending-only proposed idea can be explicitly previewed, cancelled and removed without publishing its writing', async () => {
  test.setTimeout(120000);
  await completedConversation();
  const retained = await saveIdea('Saved idea retained beside proposed writing'), retainedBytes = await fs.readFile(retained, 'utf8');
  const title = 'Remove only this unpublished proposed writing';
  await page.getByRole('button', { name: 'Draft saved idea', exact: true }).click();
  await page.getByLabel('Idea title', { exact: true }).fill(title);
  await page.getByLabel('Idea explanation', { exact: true }).fill('PENDING_ONLY_IDEA_13: independent proposed writing that was never published.');
  await page.getByLabel('Idea limitations', { exact: true }).fill('Unverified authored proposal; explicitly discard only these displayed managed copies.');
  await page.getByRole('button', { name: 'Preview saved idea', exact: true }).click();
  await expect(page.getByLabel('Proposed idea Markdown', { exact: true })).toHaveValue(/PENDING_ONLY_IDEA_13/);
  const proposed = await page.getByLabel('Proposed idea Markdown', { exact: true }).inputValue();
  const destination = await page.getByLabel('Proposed idea destination', { exact: true }).inputValue();
  await fs.writeFile(path.join(root, 'faults.json'), JSON.stringify({ fail: 'idea-before-publication' }), 'utf8');
  await page.getByRole('button', { name: 'Confirm saved idea', exact: true }).click();
  await expect(page.locator('#idea-status')).toContainText('Save failed. Proposed content is retained.');
  await fs.writeFile(path.join(root, 'faults.json'), '{}', 'utf8');
  const vault = path.join(root, 'vault', 'Companion'), directory = path.join(vault, '.ideas');
  const id = YAML.parse(proposed.match(/^---\n([\s\S]*?)\n---\n/)[1]).companion_id;
  const intents = (await fs.readdir(directory)).filter(name => name.endsWith('.intent.json'));
  let intentFile, operation;
  for (const name of intents) {
    const file = path.join(directory, name), value = JSON.parse(await fs.readFile(file, 'utf8'));
    if (value.id === id) { intentFile = file; operation = value.operation; }
  }
  expect(intentFile).toBeTruthy();
  const stage = path.join(directory, `${operation}.md.pending`);
  expect(await fs.readFile(stage, 'utf8')).toBe(proposed);
  expect(await fs.lstat(destination).catch(error => { if (error.code === 'ENOENT') return null; throw error; })).toBeNull();
  const before = await bytesIn(vault), history = await bytesIn(path.join(root, 'conversations')), sources = await bytesIn(path.join(vault, 'Captures'));
  await page.getByRole('button', { name: 'Refresh saved idea support', exact: true }).click();
  const pending = page.locator('#pending-ideas article').filter({ hasText: title });
  await expect(pending).toBeVisible();
  await pending.getByRole('button', { name: 'Preview proposed idea removal', exact: true }).click();
  const preview = page.getByLabel('Saved idea removal preview', { exact: true });
  await expect(preview).toContainText(id);
  await expect(preview).toContainText(intentFile); await expect(preview).toContainText(stage);
  await expect(preview).toContainText('PENDING_ONLY_IDEA_13: independent proposed writing that was never published.');
  expect(await bytesIn(vault)).toEqual(before);
  await page.getByRole('button', { name: 'Cancel saved idea removal', exact: true }).click();
  await expect(preview).toBeHidden(); expect(await bytesIn(vault)).toEqual(before);
  await pending.getByRole('button', { name: 'Preview proposed idea removal', exact: true }).click();
  await page.getByRole('button', { name: 'Confirm saved idea removal', exact: true }).click();
  await expect(page.locator('#idea-status')).toContainText('Saved idea removal complete.');
  for (const file of [intentFile, stage, destination]) expect(await fs.lstat(file).catch(error => { if (error.code === 'ENOENT') return null; throw error; })).toBeNull();
  expect(await fs.readFile(retained, 'utf8')).toBe(retainedBytes);
  expect(await bytesIn(path.join(vault, 'Captures'))).toEqual(sources);
  expect(await bytesIn(path.join(root, 'conversations'))).toEqual(history);
  await app.close(); app = null; await launch(false);
  await expect(page.locator('#pending-ideas article')).toHaveCount(0);
  await expect(page.locator('#saved-ideas article')).toHaveCount(1);
  expect(await fs.readFile(retained, 'utf8')).toBe(retainedBytes);
  for (const file of [intentFile, stage, destination]) expect(await fs.lstat(file).catch(error => { if (error.code === 'ENOENT') return null; throw error; })).toBeNull();
  expect(await bytesIn(path.join(root, 'conversations'))).toEqual(history);
});

test('unknown independent text in a selected idea intent or receipt holds removal without erasing writing', async ({}, testInfo) => {
  test.setTimeout(120000);
  await completedConversation();
  const title = 'Selected idea with unknown journal writing';
  const selected = await saveIdea(title), retained = await saveIdea('Other idea retained during journal shape hold');
  const selectedBytes = await fs.readFile(selected, 'utf8'), retainedBytes = await fs.readFile(retained, 'utf8');
  const id = YAML.parse(selectedBytes.match(/^---\n([\s\S]*?)\n---\n/)[1]).companion_id;
  const vault = path.join(root, 'vault', 'Companion'), directory = path.join(vault, '.ideas');
  const journals = [];
  for (const name of await fs.readdir(directory)) {
    if (!name.endsWith('.intent.json') && !name.endsWith('.published.json')) continue;
    const file = path.join(directory, name), bytes = await fs.readFile(file, 'utf8'), value = JSON.parse(bytes);
    if (value.id === id) journals.push({ file, bytes, value, kind: name.endsWith('.intent.json') ? 'intent' : 'receipt' });
  }
  expect(journals).toHaveLength(2);
  const sources = await bytesIn(path.join(vault, 'Captures')), history = await bytesIn(path.join(root, 'conversations'));
  for (const journal of journals) {
    const writing = `UNREVIEWED_${journal.kind.toUpperCase()}_WRITING_13: preserve this independent text outside the known schema.`;
    await fs.writeFile(journal.file, JSON.stringify({ ...journal.value, unreviewed_writing: writing }), 'utf8');
    await page.reload();
    const article = page.locator('#saved-ideas article').filter({ hasText: title });
    await expect(article).toBeVisible();
    const before = await bytesIn(vault);
    await article.getByRole('button', { name: 'Preview saved idea removal', exact: true }).click();
    const preview = page.getByLabel('Saved idea removal preview', { exact: true });
    await expect.poll(async () => await preview.isVisible() || /removal.*held/i.test(await page.locator('#idea-status').innerText())).toBe(true);
    const marker = path.join(directory, `${id}.removed.json`);
    const exists = async file => !!await fs.lstat(file).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
    await fs.writeFile(testInfo.outputPath(`idea-removal-unknown-${journal.kind}.json`), JSON.stringify({ kind: journal.kind, previewOffered: await preview.isVisible(), markerExists: await exists(marker), status: await page.locator('#idea-status').innerText() }, null, 2), 'utf8');
    await expect(preview).toBeHidden();
    await expect(page.locator('#idea-status')).toContainText(/removal.*held/i);
    expect(await exists(marker)).toBe(false); expect(await exists(`${marker}.pending`)).toBe(false);
    expect(await bytesIn(vault)).toEqual(before);
    expect(JSON.parse(await fs.readFile(journal.file, 'utf8')).unreviewed_writing).toBe(writing);
    expect(await fs.readFile(selected, 'utf8')).toBe(selectedBytes);
    expect(await fs.readFile(retained, 'utf8')).toBe(retainedBytes);
    expect(await bytesIn(path.join(vault, 'Captures'))).toEqual(sources);
    expect(await bytesIn(path.join(root, 'conversations'))).toEqual(history);
    await fs.writeFile(journal.file, journal.bytes, 'utf8');
  }
});

test('unknown writing nested in selected idea envelopes holds removal while a known legacy support state remains unchanged', async ({}, testInfo) => {
  test.setTimeout(120000);
  await completedConversation();
  const title = 'Selected idea with unknown nested writing';
  const selected = await saveIdea(title), retained = await saveIdea('Other idea retained beside nested writing');
  const selectedBytes = await fs.readFile(selected, 'utf8'), retainedBytes = await fs.readFile(retained, 'utf8');
  const id = YAML.parse(selectedBytes.match(/^---\n([\s\S]*?)\n---\n/)[1]).companion_id;
  const vault = path.join(root, 'vault', 'Companion'), directory = path.join(vault, '.ideas');
  let intentFile, intentBytes;
  for (const name of await fs.readdir(directory)) {
    if (!name.endsWith('.intent.json')) continue;
    const file = path.join(directory, name), bytes = await fs.readFile(file, 'utf8');
    if (JSON.parse(bytes).id === id) { intentFile = file; intentBytes = bytes; }
  }
  expect(intentFile).toBeTruthy();
  const sources = await bytesIn(path.join(vault, 'Captures')), history = await bytesIn(path.join(root, 'conversations'));
  const marker = path.join(directory, `${id}.removed.json`);
  const exists = async file => !!await fs.lstat(file).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
  for (const envelope of ['input', 'authority']) {
    const value = JSON.parse(intentBytes), writing = `NESTED_${envelope.toUpperCase()}_WRITING_13: retain this independent unreviewed text.`;
    if (envelope === 'input') value.input.unreviewed_writing = writing;
    else {
      const state = value.supportState.find(item => item.key.startsWith('capture:'));
      expect(state).toBeTruthy(); state.authority.unreviewed_writing = writing;
    }
    await fs.writeFile(intentFile, JSON.stringify(value), 'utf8'); await page.reload();
    const article = page.locator('#saved-ideas article').filter({ hasText: title }); await expect(article).toBeVisible();
    const before = await bytesIn(vault);
    await article.getByRole('button', { name: 'Preview saved idea removal', exact: true }).click();
    const preview = page.getByLabel('Saved idea removal preview', { exact: true });
    await expect.poll(async () => await preview.isVisible() || /removal.*held/i.test(await page.locator('#idea-status').innerText())).toBe(true);
    await fs.writeFile(testInfo.outputPath(`idea-removal-nested-${envelope}.json`), JSON.stringify({ envelope, previewOffered: await preview.isVisible(), markerExists: await exists(marker), status: await page.locator('#idea-status').innerText() }, null, 2), 'utf8');
    await expect(preview).toBeHidden(); await expect(page.locator('#idea-status')).toContainText(/removal.*held/i);
    expect(await exists(marker)).toBe(false); expect(await exists(`${marker}.pending`)).toBe(false);
    expect(await bytesIn(vault)).toEqual(before);
    expect(await fs.readFile(intentFile, 'utf8')).toContain(writing);
    expect(await fs.readFile(selected, 'utf8')).toBe(selectedBytes); expect(await fs.readFile(retained, 'utf8')).toBe(retainedBytes);
    expect(await bytesIn(path.join(vault, 'Captures'))).toEqual(sources);
    expect(await bytesIn(path.join(root, 'conversations'))).toEqual(history);
    await fs.writeFile(intentFile, intentBytes, 'utf8');
  }
  const legacy = JSON.parse(intentBytes);
  for (const state of legacy.supportState) { delete state.originalSourceGenerations; delete state.currentSourceGenerations; }
  await fs.writeFile(intentFile, JSON.stringify(legacy), 'utf8'); await page.reload();
  const article = page.locator('#saved-ideas article').filter({ hasText: title }); await expect(article).toBeVisible();
  const before = await bytesIn(vault);
  await article.getByRole('button', { name: 'Preview saved idea removal', exact: true }).click();
  await expect(page.getByLabel('Saved idea removal preview', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Cancel saved idea removal', exact: true }).click();
  expect(await bytesIn(vault)).toEqual(before);
  expect(JSON.parse(await fs.readFile(intentFile, 'utf8')).supportState.every(state => !Object.hasOwn(state, 'originalSourceGenerations') && !Object.hasOwn(state, 'currentSourceGenerations'))).toBe(true);
  expect(await exists(marker)).toBe(false); expect(await exists(`${marker}.pending`)).toBe(false);
  expect(await bytesIn(path.join(root, 'conversations'))).toEqual(history);
  await fs.writeFile(intentFile, intentBytes, 'utf8');
});

for (const control of ['intact', 'externally missing']) {
  test(`stale normal idea confirmation cannot publish an identity whose observed removal marker is ${control}`, async ({}, testInfo) => {
    test.setTimeout(120000);
    await completedConversation();
    const retained = await saveIdea('Retained idea beside stale proposal'), retainedBytes = await fs.readFile(retained, 'utf8');
    const title = 'Do not revive this removed pending idea';
    await page.getByRole('button', { name: 'Draft saved idea', exact: true }).click();
    await page.getByLabel('Idea title', { exact: true }).fill(title);
    await page.getByLabel('Idea explanation', { exact: true }).fill('STALE_PENDING_IDEA_13: old consent to save cannot supersede later removal.');
    await page.getByLabel('Idea limitations', { exact: true }).fill('Authored synthetic writing; no verified outcome.');
    await page.getByRole('button', { name: 'Preview saved idea', exact: true }).click();
    const staleReview = page.getByLabel('Proposed idea Markdown', { exact: true });
    await expect(staleReview).toHaveValue(/STALE_PENDING_IDEA_13/);
    const writing = await staleReview.inputValue(), destination = await page.getByLabel('Proposed idea destination', { exact: true }).inputValue();
    const id = YAML.parse(writing.match(/^---\n([\s\S]*?)\n---\n/)[1]).companion_id;
    await fs.writeFile(path.join(root, 'faults.json'), JSON.stringify({ fail: 'idea-before-publication' }));
    await page.getByRole('button', { name: 'Confirm saved idea', exact: true }).click();
    await expect(page.locator('#idea-status')).toContainText('Save failed. Proposed content is retained.');
    await fs.writeFile(path.join(root, 'faults.json'), '{}');
    const vault = path.join(root, 'vault', 'Companion'), directory = path.join(vault, '.ideas');
    const exists = async file => !!await fs.lstat(file).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
    expect(await exists(destination)).toBe(false);
    const history = await bytesIn(path.join(root, 'conversations')), sources = await bytesIn(path.join(vault, 'Captures'));
    const submissions = await fs.readFile(path.join(root, 'conversation-submissions.jsonl'), 'utf8');
    await page.getByRole('button', { name: 'Refresh saved idea support', exact: true }).click();
    const pending = page.locator('#pending-ideas article').filter({ hasText: title }); await expect(pending).toBeVisible();
    await pending.getByRole('button', { name: 'Preview proposed idea removal', exact: true }).click();
    await expect(page.getByLabel('Saved idea removal preview', { exact: true })).toContainText(id);
    await fs.writeFile(path.join(root, 'faults.json'), JSON.stringify({ fail: 'idea-removal-after-marker' }));
    await page.getByRole('button', { name: 'Confirm saved idea removal', exact: true }).click();
    await expect(page.locator('#idea-status')).toContainText('Saved idea removal held.');
    const marker = path.join(directory, `${id}.removed.json`), stage = `${marker}.pending`;
    expect(await exists(marker)).toBe(true); expect(await exists(stage)).toBe(true);
    expect(await exists(destination)).toBe(false);
    await expect(staleReview).toBeVisible(); await expect(staleReview).toHaveValue(writing);
    const parentBefore = await fs.stat(directory, { bigint: true });
    if (control === 'externally missing') { await fs.unlink(stage); await fs.unlink(marker); }
    const before = await bytesIn(vault), parentAfter = await fs.stat(directory, { bigint: true });
    expect([parentAfter.dev, parentAfter.ino]).toEqual([parentBefore.dev, parentBefore.ino]);
    await fs.writeFile(path.join(root, 'faults.json'), '{}');
    await page.getByRole('button', { name: 'Confirm saved idea', exact: true }).click();
    await expect.poll(async () => /^(Save failed\.|Saved idea\.)/.test(await page.locator('#idea-status').innerText())).toBe(true);
    const after = await bytesIn(vault);
    await fs.writeFile(testInfo.outputPath('idea-stale-confirmation.json'), JSON.stringify({
      control, id, status: await page.locator('#idea-status').innerText(), destinationExists: await exists(destination),
      parentBefore: { dev: String(parentBefore.dev), ino: String(parentBefore.ino) }, parentAfter: { dev: String(parentAfter.dev), ino: String(parentAfter.ino) },
      changedFiles: [...new Set([...Object.keys(before), ...Object.keys(after)])].filter(file => before[file] !== after[file])
    }, null, 2), 'utf8');
    await expect(page.locator('#idea-status')).toContainText('Save failed. Proposed content is retained.');
    expect(await exists(destination)).toBe(false); expect(after).toEqual(before);
    expect(await fs.readFile(retained, 'utf8')).toBe(retainedBytes);
    expect(await bytesIn(path.join(vault, 'Captures'))).toEqual(sources);
    expect(await bytesIn(path.join(root, 'conversations'))).toEqual(history);
    expect(await fs.readFile(path.join(root, 'conversation-submissions.jsonl'), 'utf8')).toBe(submissions);
    const fresh = await saveIdea('Fresh explicit idea after observed removal');
    const freshId = YAML.parse((await fs.readFile(fresh, 'utf8')).match(/^---\n([\s\S]*?)\n---\n/)[1]).companion_id;
    expect(freshId).not.toBe(id); expect(await exists(destination)).toBe(false);
    expect(await fs.readFile(retained, 'utf8')).toBe(retainedBytes);
    expect(await bytesIn(path.join(root, 'conversations'))).toEqual(history);
    expect(await fs.readFile(path.join(root, 'conversation-submissions.jsonl'), 'utf8')).toBe(submissions);
  });
}

for (const changed of ['unknown external hardlink', 'replaced known store folder']) {
  test(`saved idea removal holds after preview for an ${changed}`, async ({}, testInfo) => {
    test.setTimeout(120000);
    await completedConversation();
    const title = 'Selected idea whose ownership changes';
    const selected = await saveIdea(title), retained = await saveIdea('Retained idea beside changed ownership');
    const selectedBytes = await fs.readFile(selected, 'utf8'), retainedBytes = await fs.readFile(retained, 'utf8');
    const id = YAML.parse(selectedBytes.match(/^---\n([\s\S]*?)\n---\n/)[1]).companion_id;
    const vault = path.join(root, 'vault', 'Companion'), directory = path.join(vault, '.ideas');
    const history = await bytesIn(path.join(root, 'conversations')), sources = await bytesIn(path.join(vault, 'Captures'));
    const submissions = await fs.readFile(path.join(root, 'conversation-submissions.jsonl'), 'utf8');
    await page.locator('#saved-ideas article').filter({ hasText: title }).getByRole('button', { name: 'Preview saved idea removal', exact: true }).click();
    await expect(page.getByLabel('Saved idea removal preview', { exact: true })).toContainText(id);
    const originalParent = await fs.stat(directory, { bigint: true });
    const alias = path.join(root, 'independent-idea-alias.md'), displaced = path.join(vault, '.ideas-original-held-13');
    const sentinel = path.join(directory, 'independent-replacement-writing.txt'), sentinelBytes = 'Independent replacement folder writing must stay exact.';
    let replacementParent;
    if (changed === 'unknown external hardlink') {
      await fs.link(selected, alias); expect((await fs.stat(selected)).nlink).toBe(2);
    } else {
      await fs.rename(directory, displaced); await fs.mkdir(directory);
      await fs.writeFile(sentinel, sentinelBytes, { flag: 'wx' }); replacementParent = await fs.stat(directory, { bigint: true });
      expect([replacementParent.dev, replacementParent.ino]).not.toEqual([originalParent.dev, originalParent.ino]);
    }
    try {
      const before = await bytesIn(vault);
      await page.getByRole('button', { name: 'Confirm saved idea removal', exact: true }).click();
      await expect(page.getByLabel('Saved idea removal preview', { exact: true })).toBeHidden();
      await expect(page.locator('#idea-status')).toContainText(/removal.*held|ordinary contained folders|linked copies/i);
      const exists = async file => !!await fs.lstat(file).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
      const controls = [directory, ...(replacementParent ? [displaced] : [])].flatMap(folder => [`${id}.removed.json`, `${id}.removed.json.pending`].map(name => path.join(folder, name)));
      const markerPresence = await Promise.all(controls.map(exists));
      await fs.writeFile(testInfo.outputPath('idea-removal-ownership.json'), JSON.stringify({
        changed, status: await page.locator('#idea-status').innerText(), markerPresence,
        originalParent: { dev: String(originalParent.dev), ino: String(originalParent.ino) },
        replacementParent: replacementParent ? { dev: String(replacementParent.dev), ino: String(replacementParent.ino) } : null
      }, null, 2), 'utf8');
      expect(markerPresence.every(present => !present)).toBe(true);
      expect(await bytesIn(vault)).toEqual(before);
      expect(await fs.readFile(selected, 'utf8')).toBe(selectedBytes); expect(await fs.readFile(retained, 'utf8')).toBe(retainedBytes);
      if (replacementParent) expect(await fs.readFile(sentinel, 'utf8')).toBe(sentinelBytes);
      else { expect(await fs.readFile(alias, 'utf8')).toBe(selectedBytes); expect((await fs.stat(selected)).nlink).toBe(2); }
      expect(await bytesIn(path.join(vault, 'Captures'))).toEqual(sources);
      expect(await bytesIn(path.join(root, 'conversations'))).toEqual(history);
      expect(await fs.readFile(path.join(root, 'conversation-submissions.jsonl'), 'utf8')).toBe(submissions);
    } finally {
      if (replacementParent) {
        if (app) { await app.close(); app = null; }
        // Restore only this fixture's exact replacement, after checking its
        // ordinary directory identity and sole independently written sentinel.
        const current = await fs.lstat(directory, { bigint: true });
        if (current.isDirectory() && !current.isSymbolicLink() && current.dev === replacementParent.dev && current.ino === replacementParent.ino && JSON.stringify(await fs.readdir(directory)) === JSON.stringify([path.basename(sentinel)]) && await fs.readFile(sentinel, 'utf8') === sentinelBytes) {
          await fs.unlink(sentinel); await fs.rmdir(directory); await fs.rename(displaced, directory);
        }
      }
    }
  });
}
