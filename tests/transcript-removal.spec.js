const { test, expect, _electron: electron } = require('@playwright/test');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
let root, app, page;

test.beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'companion-transcript-removal-'));
  await fs.writeFile(path.join(root, 'clock.json'), JSON.stringify({ now: '2026-11-08T12:00:00Z', timezone: 'America/Phoenix' }));
});
test.afterEach(async () => {
  if (app) await app.close(); app = null;
  await fs.rm(root, { recursive: true, force: true });
});
async function launch(configure = true) {
  app = await electron.launch({ args: ['.'], env: { ...process.env, COMPANION_TEST_ROOT: root } });
  page = await app.firstWindow();
  if (configure) {
    await page.getByRole('button', { name: 'Choose vault', exact: true }).click();
    await page.getByRole('button', { name: 'Use this folder', exact: true }).click();
    await expect(page.getByRole('status')).toContainText('Vault ready.');
  } else await expect(page.locator('#timezone')).toContainText('America/Phoenix');
}
async function files(directory) {
  const entries = {};
  for (const item of await fs.readdir(directory, { withFileTypes: true })) {
    const file = path.join(directory, item.name);
    if (item.isDirectory()) Object.assign(entries, await files(file));
    else entries[file] = (await fs.readFile(file)).toString('base64');
  }
  return entries;
}

test('separately selected transcript removal previews every managed copy, cancels exactly, and removes only that export across restart', async () => {
  test.setTimeout(150000);
  await fs.writeFile(path.join(root, 'conversation-provider.json'), JSON.stringify({ reply: 'TRANSCRIPT_REMOVE_13: authored synthetic independent historical writing.' }));
  await launch();
  await page.getByLabel('Thought or link', { exact: true }).fill('Transcript removal retains this source capture.');
  await page.getByRole('button', { name: 'Save capture', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('Capture saved.');
  const readme = path.join(root, 'README.md');
  await fs.writeFile(readme, '# MyTune\n\nA guitar practice tutor.\n');
  await fs.writeFile(path.join(root, 'brief-selection.json'), JSON.stringify([readme]));
  await page.getByRole('button', { name: 'Select MyTune README', exact: true }).click();
  await page.getByRole('button', { name: 'Propose brief', exact: true }).click();
  await page.getByRole('button', { name: 'Approve proposed brief', exact: true }).click();
  await expect(page.locator('#brief-view')).toContainText('Approved version 1');
  await page.getByLabel('Context question', { exact: true }).fill('Retain this discussion separately from any chosen transcript export.');
  await page.getByRole('button', { name: 'Find context', exact: true }).click();
  await page.locator('#context-results article').filter({ hasText: 'Transcript removal retains' }).first().getByRole('button', { name: 'Add to context', exact: true }).click();
  await page.getByRole('button', { name: 'Preview conversation', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Send reviewed package', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: 'Send reviewed package', exact: true }).click();
  await expect(page.locator('#conversation-history')).toContainText('TRANSCRIPT_REMOVE_13');
  await expect(page.locator('#conversation-history')).toContainText('completed');
  const vault = path.join(root, 'vault'), managed = path.join(vault, 'Companion'), directory = path.join(managed, '.transcripts');
  const selected = path.join(vault, 'Selected transcript.md'), other = path.join(vault, 'Other transcript.md');
  // Keep an app-created stage/output hardlink pair and receipt for the selected export.
  // The controlled filesystem failure is at the approved OS boundary, after publication.
  await fs.writeFile(path.join(root, 'faults.json'), JSON.stringify({ fail: 'transcript-after-receipt' }));
  await fs.writeFile(path.join(root, 'transcript-selection.json'), JSON.stringify({ canceled: false, filePath: selected }));
  await page.getByRole('button', { name: 'Preview transcript export', exact: true }).click();
  await expect(page.getByLabel('Proposed transcript Markdown', { exact: true })).toBeVisible();
  const selectedBytes = await page.getByLabel('Proposed transcript Markdown', { exact: true }).inputValue();
  await page.getByRole('button', { name: 'Export reviewed transcript', exact: true }).click();
  await expect(page.locator('#transcript-status')).toContainText('Controlled filesystem boundary failure');
  expect(await fs.readFile(selected, 'utf8')).toBe(selectedBytes);
  const intentName = (await fs.readdir(directory)).find(name => name.endsWith('.intent.json'));
  const intent = JSON.parse(await fs.readFile(path.join(directory, intentName), 'utf8'));
  const selectedCopies = [selected, path.join(directory, intentName), path.join(directory, `${intent.operation}.md.pending`), path.join(directory, `${intent.operation}.published.json`)];
  expect((await fs.stat(selected)).nlink).toBe(2);
  await fs.writeFile(path.join(root, 'faults.json'), '{}');
  await fs.writeFile(path.join(root, 'transcript-selection.json'), JSON.stringify({ canceled: false, filePath: other }));
  await page.getByRole('button', { name: 'Preview transcript export', exact: true }).click();
  await expect(page.getByLabel('Proposed transcript Markdown', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Export reviewed transcript', exact: true }).click();
  await expect(page.locator('#transcript-status')).toContainText('Transcript exported');
  const backup = path.join(root, 'independent-backup.md'); await fs.copyFile(selected, backup);
  const before = await files(vault), history = await files(path.join(root, 'conversations'));
  const calls = await fs.readFile(path.join(root, 'conversation-submissions.jsonl'), 'utf8');

  await page.getByRole('combobox', { name: 'Retained transcript export', exact: true }).selectOption(intent.operation);
  await page.getByRole('button', { name: 'Preview transcript removal', exact: true }).click();
  const review = page.getByRole('region', { name: 'Transcript removal review', exact: true });
  await expect(review).toBeVisible();
  for (const file of selectedCopies) await expect(review).toContainText(file);
  await expect(review).toContainText(/originating conversation|origin conversation/i);
  await expect(review).toContainText(/external.*cop|independent.*cop|backup/i);
  await expect(review).not.toContainText(other);
  expect(await files(vault)).toEqual(before);
  await review.getByRole('button', { name: 'Cancel transcript removal', exact: true }).click();
  await expect(review).toBeHidden();
  expect(await files(vault)).toEqual(before);
  expect(await files(path.join(root, 'conversations'))).toEqual(history);

  await page.getByRole('button', { name: 'Preview transcript removal', exact: true }).click();
  await expect(review).toBeVisible();
  await review.getByRole('button', { name: 'Confirm transcript removal', exact: true }).click();
  await expect(page.locator('#transcript-remove-status')).toContainText('Transcript removed locally');
  for (const file of selectedCopies) expect(await fs.stat(file).catch(error => error.code)).toBe('ENOENT');
  const after = await files(vault);
  for (const [file, bytes] of Object.entries(before)) if (!selectedCopies.includes(file)) expect(after[file]).toBe(bytes);
  const added = Object.keys(after).filter(file => !Object.hasOwn(before, file));
  expect(added).toHaveLength(1); expect(path.basename(added[0])).toMatch(/\.removed\.json$/);
  const markerBytes = await fs.readFile(added[0], 'utf8'), marker = JSON.parse(markerBytes);
  expect(marker.id).toBe(intent.id); expect(marker.exportOperation).toBe(intent.operation);
  expect(marker.operation).not.toBe(intent.operation);
  expect(markerBytes).not.toContain('TRANSCRIPT_REMOVE_13');
  expect(markerBytes).not.toContain('Retain this discussion');
  expect(await files(path.join(root, 'conversations'))).toEqual(history);
  expect(await fs.readFile(backup, 'utf8')).toBe(selectedBytes);
  expect(await fs.readFile(path.join(root, 'conversation-submissions.jsonl'), 'utf8')).toBe(calls);
  await app.close(); app = null; await launch(false);
  await expect(page.locator('#conversation-history')).toContainText('TRANSCRIPT_REMOVE_13');
  for (const file of selectedCopies) expect(await fs.stat(file).catch(error => error.code)).toBe('ENOENT');
  expect(await files(vault)).toEqual(after);
  expect(await files(path.join(root, 'conversations'))).toEqual(history);
  expect(await fs.readFile(backup, 'utf8')).toBe(selectedBytes);
  expect(await fs.readFile(path.join(root, 'conversation-submissions.jsonl'), 'utf8')).toBe(calls);
});

test('retained transcript intent is separately removable when its completed output is missing without recreating the writing', async () => {
  test.setTimeout(120000);
  await fs.writeFile(path.join(root, 'conversation-provider.json'), JSON.stringify({ reply: 'TRANSCRIPT_INTENT_ONLY_13: preserve origin discussion independently.' }));
  await launch();
  await page.getByLabel('Thought or link', { exact: true }).fill('Intent-only transcript removal keeps this source capture.');
  await page.getByRole('button', { name: 'Save capture', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('Capture saved.');
  const readme = path.join(root, 'README.md'); await fs.writeFile(readme, '# MyTune\n\nA guitar practice tutor.\n');
  await fs.writeFile(path.join(root, 'brief-selection.json'), JSON.stringify([readme]));
  await page.getByRole('button', { name: 'Select MyTune README', exact: true }).click();
  await page.getByRole('button', { name: 'Propose brief', exact: true }).click();
  await page.getByRole('button', { name: 'Approve proposed brief', exact: true }).click();
  await expect(page.locator('#brief-view')).toContainText('Approved version 1');
  await page.getByLabel('Context question', { exact: true }).fill('Keep the conversation after removing its separately chosen retained export.');
  await page.getByRole('button', { name: 'Preview conversation', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Send reviewed package', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: 'Send reviewed package', exact: true }).click();
  await expect(page.locator('#conversation-history')).toContainText('TRANSCRIPT_INTENT_ONLY_13');
  await expect(page.locator('#conversation-history')).toContainText('completed');
  const vault = path.join(root, 'vault'), directory = path.join(vault, 'Companion', '.transcripts');
  const destination = path.join(vault, 'Externally missing transcript.md');
  await fs.writeFile(path.join(root, 'transcript-selection.json'), JSON.stringify({ canceled: false, filePath: destination }));
  await page.getByRole('button', { name: 'Preview transcript export', exact: true }).click();
  await expect(page.getByLabel('Proposed transcript Markdown', { exact: true })).toBeVisible();
  const writing = await page.getByLabel('Proposed transcript Markdown', { exact: true }).inputValue();
  await page.getByRole('button', { name: 'Export reviewed transcript', exact: true }).click();
  await expect(page.locator('#transcript-status')).toContainText('Transcript exported');
  const intentName = (await fs.readdir(directory)).find(name => name.endsWith('.intent.json'));
  const intentFile = path.join(directory, intentName), intent = JSON.parse(await fs.readFile(intentFile, 'utf8'));
  const receiptFile = path.join(directory, `${intent.operation}.published.json`), receiptBytes = await fs.readFile(receiptFile, 'utf8');
  const backup = path.join(root, 'outside-selected-scope.md'); await fs.copyFile(destination, backup);
  // Actual external file removal leaves the app-owned intent as the only retained export writing.
  // Its success receipt remains an immutable historical fact, never a reconstruction instruction.
  await fs.unlink(destination);
  await page.reload(); await expect(page.locator('#timezone')).toContainText('America/Phoenix');
  const before = await files(vault), history = await files(path.join(root, 'conversations'));
  const calls = await fs.readFile(path.join(root, 'conversation-submissions.jsonl'), 'utf8');
  await page.getByRole('combobox', { name: 'Retained transcript export', exact: true }).selectOption(intent.operation);
  await page.getByRole('button', { name: 'Preview transcript removal', exact: true }).click();
  const review = page.getByRole('region', { name: 'Transcript removal review', exact: true });
  await expect(review).toBeVisible();
  await expect(review).toContainText(intentFile); await expect(review).toContainText(receiptFile);
  await expect(review).not.toContainText(destination);
  expect(await fs.readFile(receiptFile, 'utf8')).toBe(receiptBytes);
  expect(await files(vault)).toEqual(before);
  await review.getByRole('button', { name: 'Cancel transcript removal', exact: true }).click();
  expect(await files(vault)).toEqual(before);
  await page.getByRole('button', { name: 'Preview transcript removal', exact: true }).click();
  await expect(review).toBeVisible();
  await review.getByRole('button', { name: 'Confirm transcript removal', exact: true }).click();
  await expect(page.locator('#transcript-remove-status')).toContainText('Transcript removed locally');
  for (const file of [destination, intentFile, receiptFile]) expect(await fs.stat(file).catch(error => error.code)).toBe('ENOENT');
  const after = await files(vault);
  for (const [file, bytes] of Object.entries(before)) if (![intentFile, receiptFile].includes(file)) expect(after[file]).toBe(bytes);
  const added = Object.keys(after).filter(file => !Object.hasOwn(before, file));
  expect(added).toHaveLength(1);
  const marker = JSON.parse(await fs.readFile(added[0], 'utf8'));
  expect(marker.targets.map(target => target.kind).sort()).toEqual(['intent', 'receipt']);
  expect(marker.exportOperation).toBe(intent.operation); expect(marker.id).toBe(intent.id);
  expect(await files(path.join(root, 'conversations'))).toEqual(history);
  expect(await fs.readFile(backup, 'utf8')).toBe(writing);
  expect(await fs.readFile(path.join(root, 'conversation-submissions.jsonl'), 'utf8')).toBe(calls);
  await app.close(); app = null; await launch(false);
  expect(await files(vault)).toEqual(after);
  expect(await files(path.join(root, 'conversations'))).toEqual(history);
  expect(await fs.readFile(backup, 'utf8')).toBe(writing);
  expect(await fs.readFile(path.join(root, 'conversation-submissions.jsonl'), 'utf8')).toBe(calls);
});
