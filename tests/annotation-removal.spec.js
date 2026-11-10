const { test, expect, _electron: electron } = require('@playwright/test');
const fs = require('node:fs/promises');
const local = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const fixture = require('./fixtures/reel-draft/example.json');
const YAML = require('yaml');
const { randomUUID } = require('node:crypto');
let root, app, page, readerEntry, diagnosticFile;
function diagnostic(event, details = {}) { local.appendFileSync(diagnosticFile, JSON.stringify({ timestamp: Date.now(), source: 'test', event, ...details }) + '\n'); }

test.beforeEach(async ({}, testInfo) => {
  diagnosticFile = testInfo.outputPath('annotation-lifecycle.jsonl'); local.mkdirSync(path.dirname(diagnosticFile), { recursive: true });
  diagnostic('test-start', { title: testInfo.title });
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'companion-annotation-removal-')); readerEntry = null;
});
test.afterEach(async ({}, testInfo) => {
  diagnostic('afterEach-start', { status: testInfo.status, expectedStatus: testInfo.expectedStatus });
  if (app) await closeApp('afterEach'); app = null; await fs.rm(root, { recursive: true, force: true });
  diagnostic('afterEach-complete', { status: testInfo.status });
});
async function closeApp(reason) {
  diagnostic('intentional-app-close-start', { reason });
  try { await app.close(); diagnostic('intentional-app-close-complete', { reason }); }
  catch (error) { diagnostic('intentional-app-close-error', { reason, name: error.name }); throw error; }
}
async function observeLifecycle() {
  const child = app.process(), pid = child.pid;
  diagnostic('electron-launched', { pid });
  for (const event of ['exit', 'close']) child.on(event, (code, signal) => diagnostic('child-' + event, { pid, code, signal }));
  child.on('error', error => diagnostic('child-error', { pid, code: error.code, name: error.name }));
  for (const stream of ['stdout', 'stderr']) for (const event of ['end', 'close']) child[stream]?.on(event, () => diagnostic(stream + '-' + event, { pid }));
  app.on('close', () => diagnostic('electron-application-close', { pid }));
  const context = app.context(); context.on('close', () => diagnostic('browser-context-close', { pid }));
  context.browser()?.on('disconnected', () => diagnostic('browser-disconnected', { pid }));
  await app.evaluate(({ app: electronApp, BrowserWindow }, file) => {
    const io = process.getBuiltinModule('fs');
    const write = (event, details = {}) => io.appendFileSync(file, JSON.stringify({ timestamp: Date.now(), source: 'main', pid: process.pid, event, ...details }) + '\n');
    const scalarListener = (event, details) => () => write(event, details);
    const goneListener = (event, ids = {}) => (_event, details) => write(event, { ...ids, reason: details.reason, exitCode: details.exitCode, type: details.type, serviceName: details.serviceName });
    function attach(window) {
      const windowId = window.id, contentsId = window.webContents.id;
      write('observed-window', { windowId, contentsId });
      for (const event of ['close', 'closed', 'unresponsive', 'responsive']) window.on(event, scalarListener('window-' + event, { windowId }));
      for (const event of ['destroyed', 'unresponsive', 'responsive']) window.webContents.on(event, scalarListener('webcontents-' + event, { windowId, contentsId }));
      window.webContents.on('render-process-gone', goneListener('webcontents-render-process-gone', { windowId, contentsId }));
    }
    for (const event of ['before-quit', 'will-quit', 'window-all-closed']) electronApp.on(event, scalarListener('app-' + event, {}));
    electronApp.on('quit', (_event, code) => write('app-quit', { code }));
    electronApp.on('render-process-gone', (_event, contents, details) => write('app-render-process-gone', { contentsId: contents.id, reason: details.reason, exitCode: details.exitCode }));
    electronApp.on('child-process-gone', goneListener('app-child-process-gone'));
    electronApp.on('browser-window-created', (_event, window) => attach(window));
    BrowserWindow.getAllWindows().forEach(attach);
    process.on('exit', code => write('process-exit', { code }));
    process.on('uncaughtExceptionMonitor', error => write('uncaught-exception-monitor', { name: error.name, code: error.code }));
    write('main-observers-ready');
  }, diagnosticFile);
}
async function boundary(name) {
  const child = app.process(); diagnostic('workflow-boundary', { name, exitCode: child.exitCode, signalCode: child.signalCode, pageClosed: page.isClosed() });
  if (page.isClosed()) return;
  try {
    const state = await page.evaluate(() => {
      const review = document.querySelector('[aria-label="Annotation removal review"]'), preview = document.querySelector('[aria-label="Annotation removal preview"]');
      return { reviewHidden: review?.hidden, previewHidden: preview?.hidden, rowCount: review?.querySelectorAll('article').length, buttons: [...(review?.querySelectorAll('button') || [])].map(button => ({ connected: button.isConnected, disabled: button.disabled, hidden: button.hidden })), status: document.querySelector('[role="status"]')?.textContent };
    }); diagnostic('workflow-dom', { name, ...state });
  } catch (error) { diagnostic('workflow-dom-unavailable', { name, error: error.name }); }
}
async function launch() {
  await fs.writeFile(path.join(root, 'clock.json'), JSON.stringify({ now: '2026-11-08T06:59:00Z', timezone: 'America/Phoenix' }));
  app = await electron.launch({ args: [readerEntry || '.'], env: { ...process.env, COMPANION_TEST_ROOT: root } });
  await observeLifecycle();
  page = await app.firstWindow();
  for (const event of ['close', 'crash']) page.on(event, () => diagnostic('page-' + event));
  page.on('pageerror', error => diagnostic('page-error', { name: error.name }));
  page.on('console', message => { if (message.text().startsWith('[DEBUG-annotation13]')) diagnostic('renderer-observation', { details: message.text().slice(20) }); });
  await expect(page.locator('#timezone')).toContainText('America/Phoenix');
  await page.evaluate(() => {
    const write = details => console.debug('[DEBUG-annotation13]' + JSON.stringify({ timestamp: Date.now(), ...details }));
    document.addEventListener('click', event => {
      const button = event.target.closest?.('button');
      if (button && ['Preview annotation removal', 'Cancel annotation removal', 'Confirm annotation removal'].includes(button.textContent)) write({ event: 'click-dispatch', action: button.textContent });
    }, { capture: true, passive: true });
    for (const label of ['Annotation removal review', 'Annotation removal preview']) {
      const node = document.querySelector(`[aria-label="${label}"]`); if (!node) continue;
      new MutationObserver(changes => write({ event: 'section-mutation', label, hidden: node.hidden, connected: node.isConnected, changeCount: changes.length })).observe(node, { childList: true, subtree: true, attributes: true, attributeFilter: ['hidden', 'disabled', 'class', 'style'] });
    }
  });
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
  await boundary('before-cancel');
  await preview.getByRole('button', { name: 'Cancel annotation removal', exact: true }).click();
  await expect(preview).toBeHidden(); expect(await files(base)).toEqual(before);
  await boundary('before-second-preview');
  await selectedRow.getByRole('button', { name: 'Preview annotation removal', exact: true }).click();
  await boundary('after-second-preview');
  await preview.getByRole('button', { name: 'Confirm annotation removal', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('Annotation removed');
  expect(await fs.access(selected.file).then(() => true, error => { if (error.code === 'ENOENT') return false; throw error; })).toBe(false);
  expect(await fs.readFile(retained.file)).toEqual(retained.bytes);
  expect(await files(path.join(base, 'Captures'))).toEqual(sourceFiles);
  expect(await files(path.join(base, 'Revisions'))).toEqual(revisions);
  const removed = JSON.parse(await fs.readFile(ledgerFile, 'utf8'));
  for (const key of ['captures', 'attempts', 'admissions', 'sourceAuthority', 'suppressed']) expect(removed[key]).toEqual(original[key]);
  await closeApp('normal-restart'); app = null; await launch();
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
  await closeApp('native-hold-restart'); app = null; await launch();
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

for (const ambiguous of [false, true]) test(ambiguous ? 'duplicate annotation journal members hold removal and preserve undisplayed independent writing' : 'pending-only annotation writing can be reviewed and removed without ever publishing its note', async () => {
  test.setTimeout(90000);
  readerEntry = path.join(root, 'annotation-pending-main.cjs');
  await fs.writeFile(readerEntry, `
const io = require('node:fs/promises');
const local = require('node:fs');
const path = require('node:path');
const root = process.env.COMPANION_TEST_ROOT, originalLink = io.link;
let selectedId;
io.link = async function (from, to) {
  const match = typeof from === 'string' && path.basename(from).match(/^annotation-([a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12})\\.stage$/);
  if (match && typeof to === 'string') {
    const id = match[1], stage = path.join(root, 'vault', 'Companion', '.intake', 'annotation-' + id + '.stage'), output = path.join(root, 'vault', 'Companion', 'Annotations', id + '.md');
    if (path.resolve(from) === stage && path.resolve(to) === output && (selectedId === id || !selectedId && local.existsSync(path.join(root, 'pending-link-arm.txt')))) {
      const stat = await io.lstat(stage);
      if (stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1) {
        selectedId ||= id;
        const outputAbsent = await io.lstat(output).then(() => false, error => { if (error.code === 'ENOENT') return true; throw error; });
        await io.writeFile(path.join(root, 'pending-link-checkpoint.json'), JSON.stringify({ id, from, to, outputAbsent }));
        throw Object.assign(Error('Controlled unpublished annotation link failure.'), { code: 'EACCES' });
      }
    }
  }
  return originalLink.call(this, from, to);
};
require(${JSON.stringify(path.resolve(__dirname, '..', 'app', 'main'))});
`, 'utf8');
  const base = await importedCapture(), intake = path.join(base, '.intake'), annotationFolder = path.join(base, 'Annotations'), ledgerFile = path.join(intake, 'ledger.json');
  await page.getByRole('button', { name: 'Inspect source', exact: true }).click();
  await page.getByLabel('New annotation', { exact: true }).fill('Retained published independent writing.');
  await page.getByRole('button', { name: 'Save annotation', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('Annotation saved.');
  await expect(page.getByLabel('New annotation', { exact: true })).toHaveValue('');
  const retained = path.join(annotationFolder, (await fs.readdir(annotationFolder)).find(name => name.endsWith('.md'))), retainedBytes = await fs.readFile(retained);
  const pendingText = 'PENDINGONLYCANARY independent writing has never been published.';
  await fs.writeFile(path.join(root, 'pending-link-arm.txt'), 'fail this actual annotation publication');
  await page.getByLabel('New annotation', { exact: true }).fill(pendingText);
  await page.getByRole('button', { name: 'Save annotation', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('Controlled unpublished annotation link failure.');
  const fault = JSON.parse(await fs.readFile(path.join(root, 'pending-link-checkpoint.json'), 'utf8'));
  expect(fault.outputAbsent).toBe(true);
  const intentFile = path.join(intake, 'annotation-intent.json'), stage = path.join(intake, `annotation-${fault.id}.stage`), output = path.join(annotationFolder, fault.id + '.md');
  expect(fault.from).toBe(stage); expect(fault.to).toBe(output);
  const intentBytes = await fs.readFile(intentFile), intent = JSON.parse(intentBytes.toString('utf8')), stageBytes = await fs.readFile(stage);
  expect(Object.keys(intent).sort()).toEqual(['annotation', 'captureId', 'id', 'schema']);
  expect(intent.schema).toBe(1); expect(intent.id).toBe(fault.id); expect(intent.annotation).toContain(pendingText);
  const metadata = YAML.parse(intent.annotation.match(/^---\r?\n([\s\S]*?)\r?\n---/)[1]);
  expect(metadata.companion_id).toBe(intent.id); expect(metadata.capture_id).toBe(intent.captureId);
  expect(stageBytes.toString('utf8')).toBe(intent.annotation);
  for (const file of [intentFile, stage]) { const stat = await fs.lstat(file); expect(stat.isFile()).toBe(true); expect(stat.isSymbolicLink()).toBe(false); expect(stat.nlink).toBe(1); }
  expect(await fs.access(output).then(() => true, error => { if (error.code === 'ENOENT') return false; throw error; })).toBe(false);
  let changedIntent;
  if (ambiguous) {
    // One external edit adds hidden, unrelated writing before the real writer's
    // original members. JSON.parse still yields the original last member.
    changedIntent = Buffer.from('{"annotation":' + JSON.stringify('UNSELECTEDJOURNALCANARY unrelated independent writing must remain.') + ',' + intentBytes.toString('utf8').slice(1), 'utf8');
    expect(JSON.parse(changedIntent.toString('utf8'))).toEqual(intent);
    await fs.writeFile(intentFile, changedIntent);
    expect(await fs.readFile(stage)).toEqual(stageBytes);
  }
  const original = JSON.parse(await fs.readFile(ledgerFile, 'utf8')), before = await files(base), source = await files(path.join(base, 'Captures')), revisions = await files(path.join(base, 'Revisions')), producer = await files(path.join(root, 'producer'));
  await page.getByRole('button', { name: 'Review annotations', exact: true }).click();
  const review = page.getByLabel('Annotation removal review', { exact: true }), row = review.getByRole('article').filter({ hasText: intent.id });
  if (ambiguous) {
    const status = page.getByRole('status'), preview = page.getByLabel('Annotation removal preview', { exact: true }), button = row.getByRole('button', { name: 'Preview annotation removal', exact: true });
    await expect.poll(async () => (await status.textContent()).includes('scope changed') || await button.isVisible()).toBe(true);
    if (await button.isVisible()) {
      await button.click();
      const confirm = preview.getByRole('button', { name: 'Confirm annotation removal', exact: true });
      await expect.poll(async () => (await status.textContent()).includes('scope changed') || await confirm.isVisible()).toBe(true);
      if (await confirm.isVisible()) { await confirm.click(); await expect(status).toContainText(/Annotation removed|scope changed/); }
    }
    const held = JSON.parse(await fs.readFile(ledgerFile, 'utf8'));
    expect(held.annotationRemovals?.[intent.id]).toBeUndefined();
    await expect(status).toContainText('scope changed');
    expect(await fs.readFile(intentFile)).toEqual(changedIntent); expect(await fs.readFile(stage)).toEqual(stageBytes);
    expect(await files(base)).toEqual(before);
    expect(await fs.access(output).then(() => true, error => { if (error.code === 'ENOENT') return false; throw error; })).toBe(false);
    expect(await fs.readFile(retained)).toEqual(retainedBytes); expect(await files(path.join(base, 'Captures'))).toEqual(source); expect(await files(path.join(base, 'Revisions'))).toEqual(revisions);
    expect(await files(path.join(root, 'producer'))).toEqual(producer);
    for (const key of ['captures', 'attempts', 'admissions', 'sourceAuthority', 'suppressed']) expect(held[key]).toEqual(original[key]);
    return;
  }
  await expect(row).toContainText(pendingText);
  await expect(row).toContainText('Pending');
  await row.getByRole('button', { name: 'Preview annotation removal', exact: true }).click();
  const preview = page.getByLabel('Annotation removal preview', { exact: true }); await expect(preview).toBeVisible();
  for (const file of [intentFile, stage]) await expect(preview).toContainText(path.relative(path.join(root, 'vault'), file).split(path.sep).join('/'));
  await expect(preview).not.toContainText(path.relative(path.join(root, 'vault'), retained).split(path.sep).join('/'));
  expect(await files(base)).toEqual(before);
  await preview.getByRole('button', { name: 'Cancel annotation removal', exact: true }).click();
  await expect(preview).toBeHidden(); expect(await files(base)).toEqual(before);
  expect(await fs.access(output).then(() => true, error => { if (error.code === 'ENOENT') return false; throw error; })).toBe(false);
  await row.getByRole('button', { name: 'Preview annotation removal', exact: true }).click();
  await preview.getByRole('button', { name: 'Confirm annotation removal', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('Annotation removed');
  for (const file of [intentFile, stage, output]) expect(await fs.access(file).then(() => true, error => { if (error.code === 'ENOENT') return false; throw error; })).toBe(false);
  const removed = JSON.parse(await fs.readFile(ledgerFile, 'utf8'));
  expect(removed.annotationRemovals[intent.id].phase).toBe('removed');
  for (const key of ['captures', 'attempts', 'admissions', 'sourceAuthority', 'suppressed']) expect(removed[key]).toEqual(original[key]);
  expect(await fs.readFile(retained)).toEqual(retainedBytes); expect(await files(path.join(base, 'Captures'))).toEqual(source); expect(await files(path.join(base, 'Revisions'))).toEqual(revisions);
  expect(await files(path.join(root, 'producer'))).toEqual(producer);
  await fs.unlink(path.join(root, 'pending-link-arm.txt'));
  await closeApp('pending-only-restart'); app = null; await launch();
  expect(await fs.access(output).then(() => true, error => { if (error.code === 'ENOENT') return false; throw error; })).toBe(false);
  await page.getByRole('button', { name: 'Inspect source', exact: true }).click();
  await page.getByLabel('New annotation', { exact: true }).fill('Fresh independent writing with a new identity.');
  await page.getByRole('button', { name: 'Save annotation', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('Annotation saved.');
  const published = (await fs.readdir(annotationFolder)).filter(name => name.endsWith('.md'));
  expect(published).toHaveLength(2); expect(published).not.toContain(intent.id + '.md');
  expect(await fs.readFile(retained)).toEqual(retainedBytes);
});

test('standalone annotation removal after source deletion excludes private fixtures and preserves suppression and other writing', async () => {
  test.setTimeout(90000);
  const base = await importedCapture(), annotationFolder = path.join(base, 'Annotations'), ledgerFile = path.join(base, '.intake', 'ledger.json');
  await page.getByRole('button', { name: 'Inspect source', exact: true }).click();
  for (const text of ['SELECTSOURCEGONE independent writing.', 'RETAINSOURCEGONE other independent writing.']) {
    await page.getByLabel('New annotation', { exact: true }).fill(text);
    await page.getByRole('button', { name: 'Save annotation', exact: true }).click();
    await expect(page.getByRole('status')).toContainText('Annotation saved.');
    await expect(page.getByLabel('New annotation', { exact: true })).toHaveValue('');
  }
  const notes = await Promise.all((await fs.readdir(annotationFolder)).filter(name => name.endsWith('.md')).map(async name => {
    const file = path.join(annotationFolder, name), bytes = await fs.readFile(file), text = bytes.toString('utf8');
    return { file, bytes, text, metadata: YAML.parse(text.match(/^---\r?\n([\s\S]*?)\r?\n---/)[1]) };
  }));
  const selected = notes.find(note => note.text.includes('SELECTSOURCEGONE')), retained = notes.find(note => note.text.includes('RETAINSOURCEGONE'));
  // These paths belong only to this disposable test vault. They are synthetic
  // annotation-looking fixtures, never a real account or managed home.
  const privateNotes = [];
  for (const [folder, sentinel] of [['.codex', 'PRIVATECODEXANNOTATIONCANARY'], ['managed-home', 'PRIVATEMANAGEDANNOTATIONCANARY']]) {
    const file = path.join(root, 'vault', folder, 'synthetic', 'private-annotation.md'), id = randomUUID();
    const bytes = Buffer.from(`---\ncompanion_id: ${JSON.stringify(id)}\nartifact_type: "annotation"\nschema_version: 1\ncapture_id: ${JSON.stringify(selected.metadata.capture_id)}\n---\n\n# Synthetic private fixture\n\n${sentinel} retained private writing.\n`, 'utf8');
    await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, bytes); privateNotes.push({ file, bytes, id, sentinel });
  }
  const producer = await files(path.join(root, 'producer'));
  await page.getByRole('button', { name: 'Delete capture', exact: true }).click();
  await page.getByRole('button', { name: 'Confirm capture deletion', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('Capture deleted');
  await expect(page.locator('#captures article')).toHaveCount(0);
  const deleted = JSON.parse(await fs.readFile(ledgerFile, 'utf8'));
  expect(deleted.sourceAuthority[selected.metadata.capture_id].phase).toBe('deleted');
  expect(deleted.suppressed).toContain('a'.repeat(64));
  expect((await fs.readdir(path.join(base, 'Captures'))).filter(name => name.endsWith('.md'))).toHaveLength(0);
  expect((await fs.readdir(path.join(base, 'Revisions'))).filter(name => name.endsWith('.json'))).toHaveLength(0);
  for (const note of [selected, retained, ...privateNotes]) expect(await fs.readFile(note.file)).toEqual(note.bytes);
  const before = await files(base);
  await page.getByRole('button', { name: 'Review annotations', exact: true }).click();
  const review = page.getByLabel('Annotation removal review', { exact: true });
  await expect(review).toContainText(selected.metadata.companion_id); await expect(review).toContainText(retained.metadata.companion_id);
  for (const note of privateNotes) {
    await expect(review).not.toContainText(note.sentinel);
    await expect(review).not.toContainText(note.id);
    await expect(review).not.toContainText(note.file);
  }
  const row = review.getByRole('article').filter({ hasText: selected.metadata.companion_id });
  await row.getByRole('button', { name: 'Preview annotation removal', exact: true }).click();
  const preview = page.getByLabel('Annotation removal preview', { exact: true });
  await expect(preview).toContainText(path.relative(path.join(root, 'vault'), selected.file).split(path.sep).join('/'));
  await expect(preview).not.toContainText(retained.metadata.companion_id);
  for (const note of privateNotes) { await expect(preview).not.toContainText(note.id); await expect(preview).not.toContainText(note.sentinel); }
  expect(await files(base)).toEqual(before);
  await preview.getByRole('button', { name: 'Cancel annotation removal', exact: true }).click();
  await expect(preview).toBeHidden(); expect(await files(base)).toEqual(before);
  for (const note of privateNotes) expect(await fs.readFile(note.file)).toEqual(note.bytes);
  await row.getByRole('button', { name: 'Preview annotation removal', exact: true }).click();
  await preview.getByRole('button', { name: 'Confirm annotation removal', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('Annotation removed');
  expect(await fs.access(selected.file).then(() => true, error => { if (error.code === 'ENOENT') return false; throw error; })).toBe(false);
  const after = await files(base), expected = { ...before }; delete expected['.intake/ledger.json']; delete after['.intake/ledger.json'];
  delete expected[path.relative(base, selected.file).split(path.sep).join('/')]; expect(after).toEqual(expected);
  const removed = JSON.parse(await fs.readFile(ledgerFile, 'utf8'));
  for (const key of ['captures', 'attempts', 'admissions', 'sourceAuthority', 'suppressed']) expect(removed[key]).toEqual(deleted[key]);
  for (const note of [retained, ...privateNotes]) expect(await fs.readFile(note.file)).toEqual(note.bytes);
  expect(await files(path.join(root, 'producer'))).toEqual(producer);
  await closeApp('source-gone-restart'); app = null; await launch();
  await expect(page.locator('#captures article')).toHaveCount(0);
  expect(await fs.access(selected.file).then(() => true, error => { if (error.code === 'ENOENT') return false; throw error; })).toBe(false);
  for (const note of [retained, ...privateNotes]) expect(await fs.readFile(note.file)).toEqual(note.bytes);
  const restarted = JSON.parse(await fs.readFile(ledgerFile, 'utf8'));
  expect(restarted.sourceAuthority).toEqual(deleted.sourceAuthority); expect(restarted.suppressed).toEqual(deleted.suppressed);
});
