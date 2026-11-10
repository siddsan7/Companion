const { test, expect, _electron: electron } = require('@playwright/test');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const fixture = require('./fixtures/reel-draft/example.json');
const YAML = require('yaml');
let root, app, page, readerEntry;

test.beforeEach(async () => { root = await fs.mkdtemp(path.join(os.tmpdir(), 'companion-annotation-removal-')); readerEntry = null; });
test.afterEach(async () => { if (app) await app.close(); app = null; await fs.rm(root, { recursive: true, force: true }); });
async function launch() {
  await fs.writeFile(path.join(root, 'clock.json'), JSON.stringify({ now: '2026-11-08T06:59:00Z', timezone: 'America/Phoenix' }));
  app = await electron.launch({ args: [readerEntry || '.'], env: { ...process.env, COMPANION_TEST_ROOT: root } });
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
async function importedCapture() {
  const folder = path.join(root, 'producer', 'first'); await fs.mkdir(folder, { recursive: true });
  await fs.writeFile(path.join(folder, 'run.json'), JSON.stringify({ job_id: 'b'.repeat(64), attempt_id: '1'.repeat(32), started_utc: '2026-11-01T10:00:00Z', input_sha256: 'a'.repeat(64), input_kind: 'local_video', result_kind: 'local_video_unreviewed', state: 'partial', validation: 'passed' }));
  await fs.writeFile(path.join(folder, 'evidence.json'), JSON.stringify({ ...fixture.input, clip_id: 'b'.repeat(64) }));
  await fs.writeFile(path.join(folder, 'first-pass-target.json'), JSON.stringify(fixture.target));
  await fs.copyFile(path.join(__dirname, 'fixtures/reel-draft/notes.md'), path.join(folder, 'notes.md'));
  await launch();
  await page.getByRole('button', { name: 'Choose vault', exact: true }).click();
  await page.getByRole('button', { name: 'Use this folder', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('Vault ready.');
  await page.getByLabel('Draft source folder').fill(path.join(root, 'producer'));
  await page.getByRole('checkbox', { name: 'Scan existing drafts now' }).check();
  await page.getByRole('button', { name: 'Connect draft source', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('Intake check complete');
  return path.join(root, 'vault', 'Companion');
}

test('separately selected annotation removal previews and cancels without mutation, then preserves other writing and source across restart', async () => {
  test.setTimeout(90000);
  const base = await importedCapture(), annotationFolder = path.join(base, 'Annotations');
  const selectedWriting = 'Selected independent observation. Quotation: keep source material separately.';
  const retainedWriting = 'Other independent observation stays byte exact.';
  await page.getByRole('button', { name: 'Inspect source', exact: true }).click();
  for (const text of [selectedWriting, retainedWriting]) {
    await page.getByLabel('New annotation', { exact: true }).fill(text);
    await page.getByRole('button', { name: 'Save annotation', exact: true }).click();
    await expect(page.getByRole('status')).toContainText('Annotation saved.');
    await expect(page.getByLabel('New annotation', { exact: true })).toHaveValue('');
  }
  const annotations = await Promise.all((await fs.readdir(annotationFolder)).filter(name => name.endsWith('.md')).map(async name => {
    const file = path.join(annotationFolder, name), bytes = await fs.readFile(file), content = bytes.toString('utf8');
    return { file, bytes, content, id: YAML.parse(content.match(/^---\r?\n([\s\S]*?)\r?\n---/)[1]).companion_id };
  }));
  expect(annotations).toHaveLength(2);
  const selected = annotations.find(note => note.content.includes(selectedWriting)), retained = annotations.find(note => note.content.includes(retainedWriting));
  const ledgerFile = path.join(base, '.intake', 'ledger.json'), original = JSON.parse(await fs.readFile(ledgerFile, 'utf8'));
  const sourceFiles = await files(path.join(base, 'Captures')), revisions = await files(path.join(base, 'Revisions'));
  const producer = await files(path.join(root, 'producer')), before = await files(base);
  await page.getByRole('button', { name: 'Review annotations', exact: true }).click();
  const review = page.getByLabel('Annotation removal review', { exact: true });
  const selectedRow = review.getByRole('article').filter({ hasText: selected.id });
  await expect(selectedRow).toContainText(selectedWriting);
  await selectedRow.getByRole('button', { name: 'Preview annotation removal', exact: true }).click();
  const preview = page.getByLabel('Annotation removal preview', { exact: true });
  await expect(preview).toContainText(selected.id);
  await expect(preview).toContainText(path.relative(path.join(root, 'vault'), selected.file).split(path.sep).join('/'));
  await expect(preview).not.toContainText(retained.id);
  expect(await files(base)).toEqual(before);
  await preview.getByRole('button', { name: 'Cancel annotation removal', exact: true }).click();
  await expect(preview).toBeHidden(); expect(await files(base)).toEqual(before);
  await selectedRow.getByRole('button', { name: 'Preview annotation removal', exact: true }).click();
  await preview.getByRole('button', { name: 'Confirm annotation removal', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('Annotation removed');
  expect(await fs.access(selected.file).then(() => true, error => { if (error.code === 'ENOENT') return false; throw error; })).toBe(false);
  expect(await fs.readFile(retained.file)).toEqual(retained.bytes);
  expect(await files(path.join(base, 'Captures'))).toEqual(sourceFiles);
  expect(await files(path.join(base, 'Revisions'))).toEqual(revisions);
  const removed = JSON.parse(await fs.readFile(ledgerFile, 'utf8'));
  for (const key of ['captures', 'attempts', 'admissions', 'sourceAuthority', 'suppressed']) expect(removed[key]).toEqual(original[key]);
  await app.close(); app = null; await launch();
  await page.getByRole('button', { name: 'Review annotations', exact: true }).click();
  const restartedReview = page.getByLabel('Annotation removal review', { exact: true });
  await expect(restartedReview).toContainText(retained.id); await expect(restartedReview).not.toContainText(selected.id);
  expect(await fs.access(selected.file).then(() => true, error => { if (error.code === 'ENOENT') return false; throw error; })).toBe(false);
  expect(await fs.readFile(retained.file)).toEqual(retained.bytes);
  expect(await files(path.join(base, 'Captures'))).toEqual(sourceFiles);
  expect(await files(path.join(base, 'Revisions'))).toEqual(revisions);
  expect(await files(path.join(root, 'producer'))).toEqual(producer);
});

for (const relationship of ['unchanged', 'externally edited']) test(`annotation relationship repair preserves a replaced intake ledger and holds ${relationship} writing`, async () => {
  test.setTimeout(90000);
  const base = await importedCapture(), intake = path.join(base, '.intake'), ledgerFile = path.join(intake, 'ledger.json');
  await page.getByRole('button', { name: 'Inspect source', exact: true }).click();
  await page.getByLabel('New annotation', { exact: true }).fill('Independent writing must survive an authority conflict.');
  await page.getByRole('button', { name: 'Save annotation', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('Annotation saved.');
  await expect(page.getByLabel('New annotation', { exact: true })).toHaveValue('');
  const annotationFolder = path.join(base, 'Annotations'), annotation = path.join(annotationFolder, (await fs.readdir(annotationFolder)).find(name => name.endsWith('.md')));
  const captureFolder = path.join(base, 'Captures'), capture = path.join(captureFolder, (await fs.readdir(captureFolder)).find(name => name.endsWith('.md')));
  const moved = path.join(root, 'vault', 'Projects', 'Moved source.md');
  await fs.mkdir(path.dirname(moved), { recursive: true }); await fs.rename(capture, moved);
  await fs.writeFile(path.join(root, 'faults.json'), JSON.stringify({ pause: 'link-intent-published' }));
  await page.getByRole('button', { name: 'Check now', exact: true }).click();
  await expect.poll(() => fs.readFile(path.join(root, 'checkpoint.txt'), 'utf8').catch(error => { if (error.code === 'ENOENT') return ''; throw error; })).toBe('link-intent-published');
  const intent = JSON.parse(await fs.readFile(path.join(intake, 'link-intent.json'), 'utf8'));
  expect(intent.before).toBe(await fs.readFile(annotation, 'utf8'));
  expect(intent.content).not.toBe(intent.before);
  const original = JSON.parse(await fs.readFile(ledgerFile, 'utf8')), external = structuredClone(original);
  const outcomeKey = Object.keys(external.outcomes).find(key => external.outcomes[key].status === 'imported');
  expect(outcomeKey).toBeTruthy();
  external.outcomes[outcomeKey].reason = 'External source inspection completed while relationship repair was paused.';
  const externalBytes = JSON.stringify(external, null, 2) + '\n', replacement = path.join(root, 'external-ledger-replacement.json');
  const priorIdentity = await fs.stat(ledgerFile, { bigint: true });
  await fs.writeFile(replacement, externalBytes); await fs.rename(replacement, ledgerFile);
  expect((await fs.stat(ledgerFile, { bigint: true })).ino).not.toBe(priorIdentity.ino);
  if (relationship === 'externally edited') await fs.appendFile(annotation, '\nAdditional independent writing during the paused relationship repair.\n');
  const reviewedFiles = await files(base), movedBytes = await fs.readFile(moved), annotationBytes = await fs.readFile(annotation);
  await fs.writeFile(path.join(root, 'release.txt'), 'continue');
  await expect(page.getByRole('status')).toContainText(/Intake check complete|ledger changed/);
  expect(await fs.readFile(ledgerFile, 'utf8')).toBe(externalBytes);
  const retained = JSON.parse(await fs.readFile(ledgerFile, 'utf8'));
  for (const key of ['attempts', 'admissions', 'sourceAuthority', 'annotationRemovals', 'suppressed']) expect(retained[key]).toEqual(original[key]);
  await expect(page.getByRole('status')).toContainText('ledger changed');
  expect(await fs.readFile(annotation)).toEqual(annotationBytes);
  expect(await fs.readFile(moved)).toEqual(movedBytes);
  expect(await files(base)).toEqual(reviewedFiles);
});

test('selected annotation removal accepts an actual native Windows relationship hold and preserves unselected writing', async () => {
  test.setTimeout(90000);
  const base = await importedCapture(), intake = path.join(base, '.intake'), annotationFolder = path.join(base, 'Annotations');
  await page.getByRole('button', { name: 'Inspect source', exact: true }).click();
  for (const text of ['First independent annotation.', 'Second independent annotation.']) {
    await page.getByLabel('New annotation', { exact: true }).fill(text);
    await page.getByRole('button', { name: 'Save annotation', exact: true }).click();
    await expect(page.getByRole('status')).toContainText('Annotation saved.');
    await expect(page.getByLabel('New annotation', { exact: true })).toHaveValue('');
  }
  const captureFolder = path.join(base, 'Captures'), capture = path.join(captureFolder, (await fs.readdir(captureFolder)).find(name => name.endsWith('.md')));
  const moved = path.join(root, 'vault', 'Projects', 'Moved annotated source.md');
  await fs.mkdir(path.dirname(moved), { recursive: true }); await fs.rename(capture, moved);
  await fs.writeFile(path.join(root, 'faults.json'), JSON.stringify({ pause: 'link-intent-published' }));
  await page.getByRole('button', { name: 'Check now', exact: true }).click();
  await expect.poll(() => fs.readFile(path.join(root, 'checkpoint.txt'), 'utf8').catch(error => { if (error.code === 'ENOENT') return ''; throw error; })).toBe('link-intent-published');
  const activeIntent = path.join(intake, 'link-intent.json'), intentBytes = await fs.readFile(activeIntent, 'utf8'), intent = JSON.parse(intentBytes);
  expect(intent.file).toContain('\\');
  const selected = path.join(root, 'vault', intent.file), metadata = YAML.parse(intent.before.match(/^---\r?\n([\s\S]*?)\r?\n---/)[1]);
  const selectedId = metadata.companion_id;
  expect(await fs.readFile(selected, 'utf8')).toBe(intent.before);
  await fs.appendFile(selected, '\nIndependent editor writing after the reviewed relationship intent.\n');
  const selectedBytes = await fs.readFile(selected);
  await fs.writeFile(path.join(root, 'release.txt'), 'continue');
  await expect(page.getByRole('status')).toContainText('Intake check complete');
  await expect(page.getByLabel('Vault repairs')).toContainText('Annotation relationship paused');
  const ledgerFile = path.join(intake, 'ledger.json'), original = JSON.parse(await fs.readFile(ledgerFile, 'utf8'));
  const hold = original.linkHolds[selectedId], journal = path.join(intake, hold.journal);
  expect(hold.captureId).toBe(metadata.capture_id);
  expect(hold.journal).toBe(`link-${intent.id}.json`);
  expect(await fs.readFile(journal, 'utf8')).toBe(intentBytes);
  expect(await fs.readFile(selected)).toEqual(selectedBytes);
  const retainedName = (await fs.readdir(annotationFolder)).find(name => name.endsWith('.md') && path.join(annotationFolder, name) !== selected);
  const retained = path.join(annotationFolder, retainedName), retainedBytes = await fs.readFile(retained);
  const movedBytes = await fs.readFile(moved), revisions = await files(path.join(base, 'Revisions')), producer = await files(path.join(root, 'producer'));
  const history = await files(path.join(root, 'conversations')).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
  const before = await files(base), removedFiles = [selected, journal].map(file => path.relative(path.join(root, 'vault'), file).split(path.sep).join('/'));
  await page.getByRole('button', { name: 'Review annotations', exact: true }).click();
  const row = page.getByLabel('Annotation removal review', { exact: true }).getByRole('article').filter({ hasText: selectedId });
  await row.getByRole('button', { name: 'Preview annotation removal', exact: true }).click();
  const preview = page.getByLabel('Annotation removal preview', { exact: true });
  await expect(preview).toBeVisible();
  for (const file of removedFiles) await expect(preview).toContainText(file);
  expect(await files(base)).toEqual(before);
  await preview.getByRole('button', { name: 'Cancel annotation removal', exact: true }).click();
  await expect(preview).toBeHidden(); expect(await files(base)).toEqual(before);
  await row.getByRole('button', { name: 'Preview annotation removal', exact: true }).click();
  await preview.getByRole('button', { name: 'Confirm annotation removal', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('Annotation removed');
  for (const file of [selected, journal]) expect(await fs.access(file).then(() => true, error => { if (error.code === 'ENOENT') return false; throw error; })).toBe(false);
  const after = await files(base), expected = { ...before }; delete expected['.intake/ledger.json'];
  for (const file of [selected, journal]) delete expected[path.relative(base, file).split(path.sep).join('/')];
  delete after['.intake/ledger.json']; expect(after).toEqual(expected);
  const removed = JSON.parse(await fs.readFile(ledgerFile, 'utf8'));
  for (const key of ['captures', 'attempts', 'admissions', 'sourceAuthority', 'suppressed']) expect(removed[key]).toEqual(original[key]);
  expect(await fs.readFile(retained)).toEqual(retainedBytes); expect(await fs.readFile(moved)).toEqual(movedBytes);
  expect(await files(path.join(base, 'Revisions'))).toEqual(revisions);
  expect(await files(path.join(root, 'producer'))).toEqual(producer);
  expect(await files(path.join(root, 'conversations')).catch(error => { if (error.code === 'ENOENT') return null; throw error; })).toEqual(history);
  await app.close(); app = null; await launch();
  for (const file of [selected, journal]) expect(await fs.access(file).then(() => true, error => { if (error.code === 'ENOENT') return false; throw error; })).toBe(false);
  expect(await fs.readFile(retained)).toEqual(retainedBytes); expect(await fs.readFile(moved)).toEqual(movedBytes);
});

test('an in-flight supporting annotation read never admits writing removed before its scan returns', async () => {
  test.setTimeout(90000);
  readerEntry = path.join(root, 'annotation-reader-main.cjs');
  const appDirectory = path.resolve(__dirname, '..', 'app');
  // This disposable wrapper pauses real IO results. It does not replace any
  // store/context output or generate authority. Async scope identifies the
  // final supporting scan after actual source inspection, without call counts.
  await fs.writeFile(readerEntry, `
const fs = require('node:fs');
const io = require('node:fs/promises');
const path = require('node:path');
const { AsyncLocalStorage } = require('node:async_hooks');
const { Context } = require(${JSON.stringify(path.join(appDirectory, 'context'))});
const { Intake } = require(${JSON.stringify(path.join(appDirectory, 'intake'))});
const { Vault } = require(${JSON.stringify(path.join(appDirectory, 'vault'))});
const scope = new AsyncLocalStorage(), root = process.env.COMPANION_TEST_ROOT;
const actualCorpus = Context.prototype.corpus, actualInspect = Intake.prototype.inspect, actualScan = Vault.prototype.scan;
Context.prototype.corpus = async function (...args) {
  const arm = path.join(root, 'reader-arm.txt');
  if (!fs.existsSync(arm)) return actualCorpus.apply(this, args);
  await io.unlink(arm);
  return scope.run({ armed: false }, () => actualCorpus.apply(this, args));
};
Intake.prototype.inspect = async function (...args) {
  const result = await actualInspect.apply(this, args), current = scope.getStore();
  if (current) current.armed = true;
  return result;
};
Vault.prototype.scan = async function (...args) {
  const result = await actualScan.apply(this, args), current = scope.getStore();
  if (current?.armed && args[0]?.annotations) {
    current.armed = false;
    await io.writeFile(path.join(root, 'reader-checkpoint.txt'), 'supporting-scan-held');
    while (!fs.existsSync(path.join(root, 'reader-release.txt'))) await new Promise(resolve => setTimeout(resolve, 20));
  }
  return result;
};
require(${JSON.stringify(path.join(appDirectory, 'main'))});
`, 'utf8');
  const base = await importedCapture(), annotationFolder = path.join(base, 'Annotations'), ledgerFile = path.join(base, '.intake', 'ledger.json');
  await page.getByRole('button', { name: 'Inspect source', exact: true }).click();
  for (const text of ['REMOVEREADERCANARY selected independent writing.', 'RETAINREADERCANARY unrelated independent writing.']) {
    await page.getByLabel('New annotation', { exact: true }).fill(text);
    await page.getByRole('button', { name: 'Save annotation', exact: true }).click();
    await expect(page.getByRole('status')).toContainText('Annotation saved.');
    await expect(page.getByLabel('New annotation', { exact: true })).toHaveValue('');
  }
  const notes = await Promise.all((await fs.readdir(annotationFolder)).filter(name => name.endsWith('.md')).map(async name => {
    const file = path.join(annotationFolder, name), bytes = await fs.readFile(file), text = bytes.toString('utf8');
    return { file, bytes, text, id: YAML.parse(text.match(/^---\r?\n([\s\S]*?)\r?\n---/)[1]).companion_id };
  }));
  const selected = notes.find(note => note.text.includes('REMOVEREADERCANARY')), retained = notes.find(note => note.text.includes('RETAINREADERCANARY'));
  await page.getByLabel('Context question', { exact: true }).fill('REMOVEREADERCANARY RETAINREADERCANARY');
  await page.getByRole('button', { name: 'Find context', exact: true }).click();
  for (const note of [selected, retained]) await expect(page.locator('#context-manual option').filter({ hasText: note.id })).toHaveCount(1);
  await page.getByRole('button', { name: 'New conversation', exact: true }).click();
  await expect(page.locator('#context-manual option')).toHaveCount(0);
  const source = await files(path.join(base, 'Captures')), revisions = await files(path.join(base, 'Revisions'));
  await fs.writeFile(path.join(root, 'reader-arm.txt'), 'arm one supporting read');
  await page.getByLabel('Context question', { exact: true }).fill('REMOVEREADERCANARY RETAINREADERCANARY');
  await page.getByRole('button', { name: 'Find context', exact: true }).click();
  await expect.poll(() => fs.readFile(path.join(root, 'reader-checkpoint.txt'), 'utf8').catch(error => { if (error.code === 'ENOENT') return ''; throw error; })).toBe('supporting-scan-held');
  // Context's preceding normal intake reconciliation can republish the ledger.
  // Bind removal consent only after that real reconciliation has completed.
  await page.getByRole('button', { name: 'Review annotations', exact: true }).click();
  await page.getByLabel('Annotation removal review', { exact: true }).getByRole('article').filter({ hasText: selected.id }).getByRole('button', { name: 'Preview annotation removal', exact: true }).click();
  const preview = page.getByLabel('Annotation removal preview', { exact: true }); await expect(preview).toBeVisible();
  await fs.writeFile(path.join(root, 'faults.json'), JSON.stringify({ pause: 'annotation-removal-authorized' }));
  await preview.getByRole('button', { name: 'Confirm annotation removal', exact: true }).click();
  await expect.poll(() => fs.readFile(path.join(root, 'checkpoint.txt'), 'utf8').catch(error => { if (error.code === 'ENOENT') return ''; throw error; })).toBe('annotation-removal-authorized');
  const committed = JSON.parse(await fs.readFile(ledgerFile, 'utf8'));
  expect(committed.annotationRemovals[selected.id].phase).toBe('removing');
  expect(await fs.readFile(selected.file)).toEqual(selected.bytes); expect(await fs.readFile(retained.file)).toEqual(retained.bytes);
  await fs.writeFile(path.join(root, 'reader-release.txt'), 'return actual scan result');
  await expect.poll(async () => {
    const stale = (await page.locator('#context-error').textContent()).includes('ledger changed');
    const completed = await page.locator('#context-manual option').filter({ hasText: retained.id }).count();
    return stale || completed > 0;
  }).toBe(true);
  await expect(page.locator('#context-manual option').filter({ hasText: selected.id })).toHaveCount(0);
  await expect(page.locator('#context-results')).not.toContainText('REMOVEREADERCANARY');
  expect(await fs.readFile(selected.file)).toEqual(selected.bytes);
  await fs.writeFile(path.join(root, 'release.txt'), 'finish reviewed removal');
  await expect(page.getByRole('status')).toContainText('Annotation removed');
  await page.getByRole('button', { name: 'Find context', exact: true }).click();
  await expect(page.locator('#context-manual option').filter({ hasText: retained.id })).toHaveCount(1);
  await expect(page.locator('#context-manual option').filter({ hasText: selected.id })).toHaveCount(0);
  await expect(page.locator('#context-results')).toContainText('RETAINREADERCANARY');
  await expect(page.locator('#context-results')).not.toContainText('REMOVEREADERCANARY');
  expect(await fs.readFile(retained.file)).toEqual(retained.bytes);
  expect(await files(path.join(base, 'Captures'))).toEqual(source); expect(await files(path.join(base, 'Revisions'))).toEqual(revisions);
});
