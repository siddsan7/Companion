const { test, expect, _electron: electron } = require('@playwright/test');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const fixture = require('./fixtures/reel-draft/example.json');
const YAML = require('yaml');
let root, app, page;

test.beforeEach(async () => { root = await fs.mkdtemp(path.join(os.tmpdir(), 'companion-annotation-removal-')); });
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
