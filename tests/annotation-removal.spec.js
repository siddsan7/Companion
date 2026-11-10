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
  const retryControl = page.getByLabel('Vault repairs').getByRole('button', { name: 'Retry annotation relationship', exact: true });
  await expect(retryControl).toHaveCount(1);
  const staleRetry = await retryControl.elementHandle();
  expect(await staleRetry.evaluate(button => button.isConnected)).toBe(true);
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
  // Removal refreshes only its own review, so the original real repair control
  // and its captured UUID/token remain available as a stale UI operation.
  expect(await staleRetry.evaluate(button => button.isConnected)).toBe(true);
  const postRemovalLedger = await fs.readFile(ledgerFile), postRemovalFiles = await files(path.join(root, 'vault'));
  expect(removed.annotationRemovals[selectedId].phase).toBe('removed');
  await staleRetry.click();
  await expect(page.getByRole('status')).toContainText('annotation identity was removed');
  expect(await fs.readFile(ledgerFile)).toEqual(postRemovalLedger);
  expect(await files(path.join(root, 'vault'))).toEqual(postRemovalFiles);
  for (const file of [selected, journal, activeIntent, path.join(intake, 'annotation-' + selectedId + '.stage')]) expect(await fs.access(file).then(() => true, error => { if (error.code === 'ENOENT') return false; throw error; })).toBe(false);
  expect(JSON.parse(await fs.readFile(ledgerFile, 'utf8')).annotationRemovals[selectedId]).toEqual(removed.annotationRemovals[selectedId]);
  expect(await fs.readFile(retained)).toEqual(retainedBytes); expect(await fs.readFile(moved)).toEqual(movedBytes);
  expect(await files(path.join(root, 'producer'))).toEqual(producer);
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

for (const privateFolders of [['.codex', 'managed-home'], ['.CoDeX', 'Managed-Home']]) test(`standalone annotation removal after source deletion excludes private fixtures ${privateFolders.join('/')} and preserves suppression and other writing`, async () => {
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
  for (const [index, folder] of privateFolders.entries()) {
    const sentinel = ['PRIVATECODEXANNOTATIONCANARY', 'PRIVATEMANAGEDANNOTATIONCANARY'][index];
    const file = path.join(root, 'vault', folder, 'synthetic', 'private-annotation.md'), id = randomUUID();
    const bytes = Buffer.from(`---\ncompanion_id: ${JSON.stringify(id)}\nartifact_type: "annotation"\nschema_version: 1\ncapture_id: ${JSON.stringify(selected.metadata.capture_id)}\n---\n\n# Synthetic private fixture\n\n${sentinel} retained private writing.\n`, 'utf8');
    await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, bytes); privateNotes.push({ file, bytes, id, sentinel });
  }
  await expect(page.locator('#context-manual option')).toHaveCount(0);
  await page.getByLabel('Context question', { exact: true }).fill('SELECTSOURCEGONE PRIVATECODEXANNOTATIONCANARY PRIVATEMANAGEDANNOTATIONCANARY');
  await page.getByRole('button', { name: 'Find context', exact: true }).click();
  await expect(page.locator('#context-manual option').filter({ hasText: selected.metadata.companion_id })).toHaveCount(1);
  await expect(page.locator('#context-results')).toContainText('SELECTSOURCEGONE');
  for (const note of privateNotes) {
    await expect(page.locator('#context-manual option').filter({ hasText: note.id })).toHaveCount(0);
    await expect(page.locator('#context-results')).not.toContainText(note.sentinel);
    await expect(page.locator('#context-results')).not.toContainText(note.id);
    expect(await fs.readFile(note.file)).toEqual(note.bytes);
  }
  await expect(page.getByLabel('Vault repairs')).not.toContainText('private-annotation.md');
  await expect(page.getByLabel('Vault repairs')).not.toContainText('Annotation relationship paused');
  expect(Object.keys(JSON.parse(await fs.readFile(ledgerFile, 'utf8')).linkHolds || {})).toHaveLength(0);
  const privateAliases = [];
  for (const [index, folder] of privateFolders.entries()) {
    const file = path.join(root, 'vault', folder, 'synthetic', 'selected-annotation-copy.md'), sentinel = `PRIVATESELECTEDALIAS${index}`;
    await fs.copyFile(selected.file, file);
    await fs.appendFile(file, '\n' + sentinel + ' private independent writing.\n');
    const bytes = await fs.readFile(file), metadata = YAML.parse(bytes.toString('utf8').match(/^---\r?\n([\s\S]*?)\r?\n---/)[1]);
    expect(metadata.companion_id).toBe(selected.metadata.companion_id); expect(metadata.artifact_type).toBe('annotation');
    privateAliases.push({ file, bytes, sentinel });
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
  for (const note of [selected, retained, ...privateNotes, ...privateAliases]) expect(await fs.readFile(note.file)).toEqual(note.bytes);
  const before = await files(base);
  await page.getByRole('button', { name: 'Review annotations', exact: true }).click();
  const review = page.getByLabel('Annotation removal review', { exact: true });
  await expect(review).toContainText(selected.metadata.companion_id); await expect(review).toContainText(retained.metadata.companion_id);
  for (const note of privateNotes) {
    await expect(review).not.toContainText(note.sentinel);
    await expect(review).not.toContainText(note.id);
    await expect(review).not.toContainText(note.file);
  }
  for (const note of privateAliases) {
    await expect(review).not.toContainText(note.sentinel);
    await expect(review).not.toContainText(note.file);
    await expect(review).not.toContainText(path.relative(path.join(root, 'vault'), note.file).split(path.sep).join('/'));
  }
  const row = review.getByRole('article').filter({ hasText: selected.metadata.companion_id });
  await expect(row).toHaveCount(1);
  await row.getByRole('button', { name: 'Preview annotation removal', exact: true }).click();
  const preview = page.getByLabel('Annotation removal preview', { exact: true });
  await expect(preview).toContainText(path.relative(path.join(root, 'vault'), selected.file).split(path.sep).join('/'));
  await expect(preview).not.toContainText(retained.metadata.companion_id);
  for (const note of privateNotes) { await expect(preview).not.toContainText(note.id); await expect(preview).not.toContainText(note.sentinel); }
  for (const note of privateAliases) {
    await expect(preview).not.toContainText(note.sentinel);
    await expect(preview).not.toContainText(path.relative(path.join(root, 'vault'), note.file).split(path.sep).join('/'));
  }
  expect(await files(base)).toEqual(before);
  await preview.getByRole('button', { name: 'Cancel annotation removal', exact: true }).click();
  await expect(preview).toBeHidden(); expect(await files(base)).toEqual(before);
  for (const note of [...privateNotes, ...privateAliases]) expect(await fs.readFile(note.file)).toEqual(note.bytes);
  await row.getByRole('button', { name: 'Preview annotation removal', exact: true }).click();
  await preview.getByRole('button', { name: 'Confirm annotation removal', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('Annotation removed');
  expect(await fs.access(selected.file).then(() => true, error => { if (error.code === 'ENOENT') return false; throw error; })).toBe(false);
  const after = await files(base), expected = { ...before }; delete expected['.intake/ledger.json']; delete after['.intake/ledger.json'];
  delete expected[path.relative(base, selected.file).split(path.sep).join('/')]; expect(after).toEqual(expected);
  const removed = JSON.parse(await fs.readFile(ledgerFile, 'utf8'));
  for (const key of ['captures', 'attempts', 'admissions', 'sourceAuthority', 'suppressed']) expect(removed[key]).toEqual(deleted[key]);
  for (const note of [retained, ...privateNotes, ...privateAliases]) expect(await fs.readFile(note.file)).toEqual(note.bytes);
  expect(await files(path.join(root, 'producer'))).toEqual(producer);
  await closeApp('source-gone-restart'); app = null; await launch();
  await expect(page.locator('#captures article')).toHaveCount(0);
  expect(await fs.access(selected.file).then(() => true, error => { if (error.code === 'ENOENT') return false; throw error; })).toBe(false);
  for (const note of [retained, ...privateNotes, ...privateAliases]) expect(await fs.readFile(note.file)).toEqual(note.bytes);
  const restarted = JSON.parse(await fs.readFile(ledgerFile, 'utf8'));
  expect(restarted.sourceAuthority).toEqual(deleted.sourceAuthority); expect(restarted.suppressed).toEqual(deleted.suppressed);
});

test('explicit annotation removal resumes its exact linked publication scope after actual main process exit', async ({}, testInfo) => {
  test.setTimeout(90000);
  const base = await importedCapture(), intake = path.join(base, '.intake'), annotationFolder = path.join(base, 'Annotations'), ledgerFile = path.join(intake, 'ledger.json');
  await page.getByRole('button', { name: 'Inspect source', exact: true }).click();
  await page.getByLabel('New annotation', { exact: true }).fill('RETAINCRASHANNOTATION independent writing.');
  await page.getByRole('button', { name: 'Save annotation', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('Annotation saved.');
  await expect(page.getByLabel('New annotation', { exact: true })).toHaveValue('');
  const retained = path.join(annotationFolder, (await fs.readdir(annotationFolder)).find(name => name.endsWith('.md'))), retainedBytes = await fs.readFile(retained);
  await fs.writeFile(path.join(root, 'faults.json'), JSON.stringify({ fail: 'annotation-published' }));
  await page.getByLabel('New annotation', { exact: true }).fill('REMOVECRASHANNOTATION selected writing.');
  await page.getByRole('button', { name: 'Save annotation', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('Controlled filesystem boundary failure.');
  const intentFile = path.join(intake, 'annotation-intent.json'), intentBytes = await fs.readFile(intentFile), intent = JSON.parse(intentBytes.toString('utf8'));
  const stage = path.join(intake, `annotation-${intent.id}.stage`), note = path.join(annotationFolder, intent.id + '.md');
  expect(intent.annotation).toContain('REMOVECRASHANNOTATION');
  for (const file of [stage, note]) expect(await fs.readFile(file, 'utf8')).toBe(intent.annotation);
  const stageIdentity = await fs.stat(stage, { bigint: true }), noteIdentity = await fs.stat(note, { bigint: true });
  expect(stageIdentity.nlink).toBe(2n); expect(noteIdentity.nlink).toBe(2n);
  expect([stageIdentity.dev, stageIdentity.ino]).toEqual([noteIdentity.dev, noteIdentity.ino]);
  const original = JSON.parse(await fs.readFile(ledgerFile, 'utf8')), before = await files(base), source = await files(path.join(base, 'Captures')), revisions = await files(path.join(base, 'Revisions')), producer = await files(path.join(root, 'producer'));
  await page.getByRole('button', { name: 'Review annotations', exact: true }).click();
  const row = page.getByLabel('Annotation removal review', { exact: true }).getByRole('article').filter({ hasText: intent.id });
  await row.getByRole('button', { name: 'Preview annotation removal', exact: true }).click();
  const preview = page.getByLabel('Annotation removal preview', { exact: true });
  for (const file of [intentFile, stage, note]) await expect(preview).toContainText(path.relative(path.join(root, 'vault'), file).split(path.sep).join('/'));
  expect(await files(base)).toEqual(before);
  await preview.getByRole('button', { name: 'Cancel annotation removal', exact: true }).click();
  await expect(preview).toBeHidden(); expect(await files(base)).toEqual(before);
  expect((await fs.stat(stage)).nlink).toBe(2); expect((await fs.stat(note)).nlink).toBe(2);
  await row.getByRole('button', { name: 'Preview annotation removal', exact: true }).click();
  await fs.writeFile(path.join(root, 'faults.json'), JSON.stringify({ pause: 'annotation-removal-unlinked' }));
  await preview.getByRole('button', { name: 'Confirm annotation removal', exact: true }).click();
  await expect.poll(() => fs.readFile(path.join(root, 'checkpoint.txt'), 'utf8').catch(error => { if (error.code === 'ENOENT') return ''; throw error; })).toBe('annotation-removal-unlinked');
  const committed = JSON.parse(await fs.readFile(ledgerFile, 'utf8')), operation = committed.annotationRemovals[intent.id];
  expect(operation.phase).toBe('removing');
  expect(operation.targets.find(target => target.file.endsWith(`annotation-${intent.id}.stage`)).kind).toBe('annotation-stage');
  expect(await fs.access(stage).then(() => true, error => { if (error.code === 'ENOENT') return false; throw error; })).toBe(false);
  expect(await fs.readFile(intentFile)).toEqual(intentBytes); expect(await fs.readFile(note, 'utf8')).toBe(intent.annotation);
  const survivingNote = await fs.stat(note, { bigint: true }); expect(survivingNote.nlink).toBe(1n);
  expect([survivingNote.dev, survivingNote.ino]).toEqual([noteIdentity.dev, noteIdentity.ino]);
  const child = app.process(), mainPid = await app.evaluate(() => process.pid), proof = { boundary: 'annotation-removal-unlinked', removedRole: 'annotation-stage', wrapperPid: child.pid, mainPid, exitBoundary: 'Electron app.exit(77)' };
  diagnostic('intentional-main-exit-start', { mainPid, boundary: proof.boundary });
  const exited = new Promise(resolve => child.once('exit', (code, signal) => resolve({ code, signal })));
  const abrupt = app.evaluate(({ app: electronApp }) => electronApp.exit(77)).catch(error => { if (!/closed|disposed/i.test(error.message)) throw error; });
  proof.wrapperExit = await exited; await abrupt;
  await expect.poll(() => { try { process.kill(mainPid, 0); return 'alive'; } catch (error) { if (error.code === 'ESRCH') return 'exited'; throw error; } }).toBe('exited');
  await fs.writeFile(testInfo.outputPath('annotation-removal-main-exit.json'), JSON.stringify(proof, null, 2), 'utf8');
  app = null; await fs.writeFile(path.join(root, 'faults.json'), '{}'); await launch();
  const restarted = JSON.parse(await fs.readFile(ledgerFile, 'utf8'));
  expect(restarted.annotationRemovals[intent.id]).toEqual(operation);
  expect(await fs.readFile(intentFile)).toEqual(intentBytes); expect(await fs.readFile(note, 'utf8')).toBe(intent.annotation);
  expect((await fs.stat(note)).nlink).toBe(1);
  expect(await fs.access(stage).then(() => true, error => { if (error.code === 'ENOENT') return false; throw error; })).toBe(false);
  await expect(page.locator('#captures article')).toHaveCount(1);
  await page.getByLabel('Context question', { exact: true }).fill('REMOVECRASHANNOTATION RETAINCRASHANNOTATION');
  await page.getByRole('button', { name: 'Find context', exact: true }).click();
  await expect(page.locator('#context-results')).toContainText('RETAINCRASHANNOTATION');
  await expect(page.locator('#context-results')).not.toContainText('REMOVECRASHANNOTATION');
  await expect(page.locator('#context-manual option').filter({ hasText: intent.id })).toHaveCount(0);
  expect(await fs.readFile(note, 'utf8')).toBe(intent.annotation); expect(await fs.readFile(intentFile)).toEqual(intentBytes);
  await page.getByRole('button', { name: 'Review unfinished annotation removals', exact: true }).click();
  const recovery = page.getByLabel('Unfinished annotation removals', { exact: true }).getByRole('article').filter({ hasText: intent.id });
  for (const target of operation.targets) await expect(recovery).toContainText(target.file);
  await recovery.getByRole('button', { name: 'Resume reviewed annotation removal', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('Annotation removed');
  for (const file of [stage, note, intentFile]) expect(await fs.access(file).then(() => true, error => { if (error.code === 'ENOENT') return false; throw error; })).toBe(false);
  const completed = JSON.parse(await fs.readFile(ledgerFile, 'utf8'));
  expect(completed.annotationRemovals[intent.id]).toEqual({ ...operation, phase: 'removed' });
  for (const key of ['captures', 'attempts', 'admissions', 'sourceAuthority', 'suppressed']) expect(completed[key]).toEqual(original[key]);
  expect(await fs.readFile(retained)).toEqual(retainedBytes); expect(await files(path.join(base, 'Captures'))).toEqual(source); expect(await files(path.join(base, 'Revisions'))).toEqual(revisions); expect(await files(path.join(root, 'producer'))).toEqual(producer);
  await page.getByRole('button', { name: 'Review unfinished annotation removals', exact: true }).click();
  await expect(page.getByLabel('Unfinished annotation removals', { exact: true })).toContainText('No unfinished annotation removals.');
  await page.getByRole('button', { name: 'Inspect source', exact: true }).click();
  await page.getByLabel('New annotation', { exact: true }).fill('Fresh writing after explicitly recovered removal.');
  await page.getByRole('button', { name: 'Save annotation', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('Annotation saved.');
  const published = (await fs.readdir(annotationFolder)).filter(name => name.endsWith('.md'));
  expect(published).toHaveLength(2); expect(published).not.toContain(intent.id + '.md');
  expect(JSON.parse(await fs.readFile(ledgerFile, 'utf8')).annotationRemovals[intent.id]).toEqual({ ...operation, phase: 'removed' });
});

for (const timing of ['before preview', 'after preview']) test(`annotation removal holds a malformed selected annotation alias added ${timing}`, async () => {
  test.setTimeout(90000);
  const base = await importedCapture(), annotationFolder = path.join(base, 'Annotations'), ledgerFile = path.join(base, '.intake', 'ledger.json');
  await page.getByRole('button', { name: 'Inspect source', exact: true }).click();
  for (const text of ['SELECTMALFORMEDALIAS selected independent writing.', 'RETAINMALFORMEDALIAS other independent writing.']) {
    await page.getByLabel('New annotation', { exact: true }).fill(text);
    await page.getByRole('button', { name: 'Save annotation', exact: true }).click();
    await expect(page.getByRole('status')).toContainText('Annotation saved.');
    await expect(page.getByLabel('New annotation', { exact: true })).toHaveValue('');
  }
  const notes = await Promise.all((await fs.readdir(annotationFolder)).filter(name => name.endsWith('.md')).map(async name => {
    const file = path.join(annotationFolder, name), bytes = await fs.readFile(file), text = bytes.toString('utf8');
    return { file, bytes, text, metadata: YAML.parse(text.match(/^---\r?\n([\s\S]*?)\r?\n---/)[1]) };
  }));
  expect(notes).toHaveLength(2);
  const selected = notes.find(note => note.text.includes('SELECTMALFORMEDALIAS')), retained = notes.find(note => note.text.includes('RETAINMALFORMEDALIAS'));
  await page.getByRole('button', { name: 'Review annotations', exact: true }).click();
  const review = page.getByLabel('Annotation removal review', { exact: true }), row = review.getByRole('article').filter({ hasText: selected.metadata.companion_id });
  await expect(row).toContainText('SELECTMALFORMEDALIAS');
  const preview = page.getByLabel('Annotation removal preview', { exact: true }), status = page.getByRole('status');
  if (timing === 'after preview') {
    await row.getByRole('button', { name: 'Preview annotation removal', exact: true }).click();
    await expect(preview).toBeVisible();
    await expect(preview).toContainText(path.relative(path.join(root, 'vault'), selected.file).split(path.sep).join('/'));
    await expect(preview).not.toContainText(retained.metadata.companion_id);
  }
  const alias = path.join(root, 'vault', 'Notes', 'selected-copy.md'), independentWriting = 'MALFORMEDALIASONLYCOPY independent writing in the damaged copy.';
  await fs.mkdir(path.dirname(alias), { recursive: true }); await fs.copyFile(selected.file, alias);
  expect(await fs.readFile(alias)).toEqual(selected.bytes);
  const damaged = selected.text.replace(/^capture_id: [^\r\n]+/m, 'capture_id: "damaged-capture-binding"') + '\n' + independentWriting + '\n';
  await fs.writeFile(alias, damaged, 'utf8');
  const aliasBytes = await fs.readFile(alias), metadata = YAML.parse(damaged.match(/^---\r?\n([\s\S]*?)\r?\n---/)[1]);
  expect(metadata).toEqual({ ...selected.metadata, capture_id: 'damaged-capture-binding' });
  expect(metadata.companion_id).toBe(selected.metadata.companion_id); expect(metadata.artifact_type).toBe('annotation');
  expect(damaged).toContain('SELECTMALFORMEDALIAS'); expect(damaged).toContain(independentWriting);
  const before = await files(path.join(root, 'vault')), ledgerBytes = await fs.readFile(ledgerFile), source = await files(path.join(base, 'Captures')), revisions = await files(path.join(base, 'Revisions')), producer = await files(path.join(root, 'producer'));
  expect(JSON.parse(ledgerBytes.toString('utf8')).annotationRemovals?.[selected.metadata.companion_id]).toBeUndefined();
  if (timing === 'before preview') {
    await row.getByRole('button', { name: 'Preview annotation removal', exact: true }).click();
    await expect.poll(async () => (await status.textContent()).includes('scope changed') || await preview.isVisible()).toBe(true);
    if (await preview.isVisible()) {
      // Exercise any incorrectly offered consent so the no-authority assertion
      // detects a completed partial purge rather than merely a misleading view.
      await preview.getByRole('button', { name: 'Confirm annotation removal', exact: true }).click();
      await expect(status).toContainText(/Annotation removed|scope changed/);
    }
  } else {
    await preview.getByRole('button', { name: 'Confirm annotation removal', exact: true }).click();
    await expect(status).toContainText(/Annotation removed|scope changed/);
  }
  expect(JSON.parse(await fs.readFile(ledgerFile, 'utf8')).annotationRemovals?.[selected.metadata.companion_id]).toBeUndefined();
  await expect(status).toContainText('scope changed');
  if (timing === 'before preview') await expect(preview).toBeHidden();
  expect(await fs.readFile(ledgerFile)).toEqual(ledgerBytes); expect(await files(path.join(root, 'vault'))).toEqual(before);
  expect(await fs.readFile(selected.file)).toEqual(selected.bytes); expect(await fs.readFile(retained.file)).toEqual(retained.bytes); expect(await fs.readFile(alias)).toEqual(aliasBytes);
  expect(await files(path.join(base, 'Captures'))).toEqual(source); expect(await files(path.join(base, 'Revisions'))).toEqual(revisions); expect(await files(path.join(root, 'producer'))).toEqual(producer);
});

for (const timing of ['before preview', 'after preview']) test(`annotation removal holds an uppercase Markdown selected annotation alias added ${timing}`, async () => {
  test.setTimeout(90000);
  const base = await importedCapture(), annotationFolder = path.join(base, 'Annotations'), ledgerFile = path.join(base, '.intake', 'ledger.json');
  await page.getByRole('button', { name: 'Inspect source', exact: true }).click();
  for (const text of ['SELECTUPPERCASEALIAS selected independent writing.', 'RETAINUPPERCASEALIAS other independent writing.']) {
    await page.getByLabel('New annotation', { exact: true }).fill(text);
    await page.getByRole('button', { name: 'Save annotation', exact: true }).click();
    await expect(page.getByRole('status')).toContainText('Annotation saved.');
    await expect(page.getByLabel('New annotation', { exact: true })).toHaveValue('');
  }
  const notes = await Promise.all((await fs.readdir(annotationFolder)).filter(name => name.endsWith('.md')).map(async name => {
    const file = path.join(annotationFolder, name), bytes = await fs.readFile(file), text = bytes.toString('utf8');
    return { file, bytes, text, metadata: YAML.parse(text.match(/^---\r?\n([\s\S]*?)\r?\n---/)[1]) };
  }));
  expect(notes).toHaveLength(2);
  const selected = notes.find(note => note.text.includes('SELECTUPPERCASEALIAS')), retained = notes.find(note => note.text.includes('RETAINUPPERCASEALIAS'));
  await page.getByRole('button', { name: 'Review annotations', exact: true }).click();
  const review = page.getByLabel('Annotation removal review', { exact: true }), row = review.getByRole('article').filter({ hasText: selected.metadata.companion_id });
  await expect(row).toContainText('SELECTUPPERCASEALIAS');
  const preview = page.getByLabel('Annotation removal preview', { exact: true }), status = page.getByRole('status');
  if (timing === 'after preview') {
    await row.getByRole('button', { name: 'Preview annotation removal', exact: true }).click();
    await expect(preview).toBeVisible();
    await expect(preview).toContainText(path.relative(path.join(root, 'vault'), selected.file).split(path.sep).join('/'));
    await expect(preview).not.toContainText(retained.metadata.companion_id);
  }
  const alias = path.join(root, 'vault', 'Notes', 'selected-copy.MD'), independentWriting = 'UPPERCASEALIASONLYCOPY independent writing in the uppercase Markdown copy.';
  await fs.mkdir(path.dirname(alias), { recursive: true }); await fs.copyFile(selected.file, alias);
  expect(await fs.readFile(alias)).toEqual(selected.bytes);
  await fs.appendFile(alias, '\n' + independentWriting + '\n');
  const aliasBytes = await fs.readFile(alias), aliasText = aliasBytes.toString('utf8'), metadata = YAML.parse(aliasText.match(/^---\r?\n([\s\S]*?)\r?\n---/)[1]);
  expect(metadata).toEqual(selected.metadata);
  expect(metadata.capture_id).toBe(selected.metadata.capture_id);
  expect(metadata.companion_id).toBe(selected.metadata.companion_id); expect(metadata.artifact_type).toBe('annotation');
  expect(aliasText).toContain('SELECTUPPERCASEALIAS'); expect(aliasText).toContain(independentWriting);
  const before = await files(path.join(root, 'vault')), ledgerBytes = await fs.readFile(ledgerFile), source = await files(path.join(base, 'Captures')), revisions = await files(path.join(base, 'Revisions')), producer = await files(path.join(root, 'producer'));
  expect(JSON.parse(ledgerBytes.toString('utf8')).annotationRemovals?.[selected.metadata.companion_id]).toBeUndefined();
  if (timing === 'before preview') {
    await row.getByRole('button', { name: 'Preview annotation removal', exact: true }).click();
    await expect.poll(async () => (await status.textContent()).includes('scope changed') || await preview.isVisible()).toBe(true);
    if (await preview.isVisible()) {
      // Exercise any incorrectly offered consent so the no-authority assertion
      // detects a completed partial purge rather than merely a misleading view.
      await preview.getByRole('button', { name: 'Confirm annotation removal', exact: true }).click();
      await expect(status).toContainText(/Annotation removed|scope changed/);
    }
  } else {
    await preview.getByRole('button', { name: 'Confirm annotation removal', exact: true }).click();
    await expect(status).toContainText(/Annotation removed|scope changed/);
  }
  expect(JSON.parse(await fs.readFile(ledgerFile, 'utf8')).annotationRemovals?.[selected.metadata.companion_id]).toBeUndefined();
  await expect(status).toContainText('scope changed');
  if (timing === 'before preview') await expect(preview).toBeHidden();
  expect(await fs.readFile(ledgerFile)).toEqual(ledgerBytes); expect(await files(path.join(root, 'vault'))).toEqual(before);
  expect(await fs.readFile(selected.file)).toEqual(selected.bytes); expect(await fs.readFile(retained.file)).toEqual(retained.bytes); expect(await fs.readFile(alias)).toEqual(aliasBytes);
  expect(await files(path.join(base, 'Captures'))).toEqual(source); expect(await files(path.join(base, 'Revisions'))).toEqual(revisions); expect(await files(path.join(root, 'producer'))).toEqual(producer);
});

for (const ownership of ['unknown hardlink', 'replaced annotation parent']) test(`annotation removal holds ${ownership} without authority or file mutation`, async () => {
  test.setTimeout(90000);
  const base = await importedCapture(), annotationFolder = path.join(base, 'Annotations'), ledgerFile = path.join(base, '.intake', 'ledger.json');
  await page.getByRole('button', { name: 'Inspect source', exact: true }).click();
  for (const text of ['SELECTOWNERSHIP selected independent writing.', 'RETAINOWNERSHIP other independent writing.']) {
    await page.getByLabel('New annotation', { exact: true }).fill(text);
    await page.getByRole('button', { name: 'Save annotation', exact: true }).click();
    await expect(page.getByRole('status')).toContainText('Annotation saved.');
    await expect(page.getByLabel('New annotation', { exact: true })).toHaveValue('');
  }
  const notes = await Promise.all((await fs.readdir(annotationFolder)).filter(name => name.endsWith('.md')).map(async name => {
    const file = path.join(annotationFolder, name), bytes = await fs.readFile(file), text = bytes.toString('utf8');
    return { file, name, bytes, id: YAML.parse(text.match(/^---\r?\n([\s\S]*?)\r?\n---/)[1]).companion_id, selected: text.includes('SELECTOWNERSHIP') };
  }));
  const selected = notes.find(note => note.selected), retained = notes.find(note => !note.selected), selectedIdentity = await fs.stat(selected.file, { bigint: true }), parentIdentity = await fs.stat(annotationFolder, { bigint: true });
  const producer = await files(path.join(root, 'producer'));
  await page.getByRole('button', { name: 'Review annotations', exact: true }).click();
  await page.getByLabel('Annotation removal review', { exact: true }).getByRole('article').filter({ hasText: selected.id }).getByRole('button', { name: 'Preview annotation removal', exact: true }).click();
  const preview = page.getByLabel('Annotation removal preview', { exact: true }); await expect(preview).toBeVisible();
  const fixtureRoot = await fs.realpath(root); let outside;
  if (ownership === 'unknown hardlink') {
    outside = path.join(fixtureRoot, 'unknown-selected-peer.md');
    expect(path.relative(fixtureRoot, outside)).toBe('unknown-selected-peer.md');
    await fs.link(selected.file, outside);
    const peer = await fs.stat(outside, { bigint: true }), current = await fs.stat(selected.file, { bigint: true });
    expect(current.nlink).toBe(2n); expect(peer.nlink).toBe(2n);
    expect([peer.dev, peer.ino]).toEqual([selectedIdentity.dev, selectedIdentity.ino]);
  } else {
    outside = path.join(fixtureRoot, 'reviewed-annotation-originals');
    expect(path.relative(fixtureRoot, outside)).toBe('reviewed-annotation-originals');
    expect(await fs.realpath(path.dirname(annotationFolder))).toBe(await fs.realpath(base));
    await fs.rename(annotationFolder, outside); await fs.mkdir(annotationFolder);
    for (const note of notes) await fs.copyFile(path.join(outside, note.name), path.join(annotationFolder, note.name));
    const movedParent = await fs.stat(outside, { bigint: true }), replacementParent = await fs.stat(annotationFolder, { bigint: true }), replacementNote = await fs.stat(selected.file, { bigint: true });
    expect([movedParent.dev, movedParent.ino]).toEqual([parentIdentity.dev, parentIdentity.ino]);
    expect(replacementParent.ino).not.toBe(parentIdentity.ino); expect(replacementNote.ino).not.toBe(selectedIdentity.ino);
    expect((await fs.stat(path.join(outside, selected.name), { bigint: true })).ino).toBe(selectedIdentity.ino);
  }
  const outsideBefore = ownership === 'unknown hardlink' ? await fs.readFile(outside) : await files(outside), before = await files(path.join(root, 'vault')), ledgerBytes = await fs.readFile(ledgerFile);
  await preview.getByRole('button', { name: 'Confirm annotation removal', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('Annotation removal scope changed');
  expect(JSON.parse(await fs.readFile(ledgerFile, 'utf8')).annotationRemovals?.[selected.id]).toBeUndefined();
  expect(await fs.readFile(ledgerFile)).toEqual(ledgerBytes);
  expect(await files(path.join(root, 'vault'))).toEqual(before);
  expect(await fs.readFile(selected.file)).toEqual(selected.bytes); expect(await fs.readFile(retained.file)).toEqual(retained.bytes);
  if (ownership === 'unknown hardlink') {
    expect(await fs.readFile(outside)).toEqual(outsideBefore); expect((await fs.stat(outside)).nlink).toBe(2); expect((await fs.stat(selected.file)).nlink).toBe(2);
  } else {
    expect(await files(outside)).toEqual(outsideBefore);
    for (const note of notes) expect(await fs.readFile(path.join(outside, note.name))).toEqual(note.bytes);
    expect((await fs.stat(outside, { bigint: true })).ino).toBe(parentIdentity.ino);
  }
  expect(await files(path.join(root, 'producer'))).toEqual(producer);
});

test('annotation removal holds an actual mixed source repair without erasing either independent writing variant', async () => {
  test.setTimeout(90000);
  const base = await importedCapture(), intake = path.join(base, '.intake'), annotationFolder = path.join(base, 'Annotations'), ledgerFile = path.join(intake, 'ledger.json');
  await page.getByRole('button', { name: 'Inspect source', exact: true }).click();
  await page.getByLabel('New annotation', { exact: true }).fill('RETAINMIXEDGUARD unrelated independent annotation.');
  await page.getByRole('button', { name: 'Save annotation', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('Annotation saved.');
  await expect(page.getByLabel('New annotation', { exact: true })).toHaveValue('');
  const retained = path.join(annotationFolder, (await fs.readdir(annotationFolder)).find(name => name.endsWith('.md'))), retainedBytes = await fs.readFile(retained);
  const captureFolder = path.join(base, 'Captures'), capture = path.join(captureFolder, (await fs.readdir(captureFolder)).find(name => name.endsWith('.md')));
  const localWriting = 'LOCALMIXEDONLYCOPY external writing in the current source variant.';
  await fs.appendFile(capture, '\n' + localWriting + '\n');
  const localBytes = await fs.readFile(capture);
  const next = path.join(root, 'producer', 'second');
  await fs.cp(path.join(root, 'producer', 'first'), next, { recursive: true });
  const runFile = path.join(next, 'run.json'), run = JSON.parse(await fs.readFile(runFile, 'utf8')); run.attempt_id = '2'.repeat(32);
  await fs.writeFile(runFile, JSON.stringify(run));
  await page.getByRole('button', { name: 'Check now', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('Intake check complete');
  await expect(page.getByLabel('Vault repairs')).toContainText(localWriting);
  const conflicted = JSON.parse(await fs.readFile(ledgerFile, 'utf8')), block = conflicted.blocks['a'.repeat(64)];
  expect(block).toBeTruthy();
  const sourceConflict = JSON.parse(await fs.readFile(path.join(intake, block.journal), 'utf8'));
  expect(sourceConflict.revision.run.attempt_id).toBe('2'.repeat(32));
  expect(await fs.readFile(capture)).toEqual(localBytes);
  const selectedWriting = 'ANNOTATIONMIXEDONLYCOPY independently selected repair interpretation.';
  await page.getByLabel('Transfer local writing', { exact: true }).fill(selectedWriting);
  await fs.writeFile(path.join(root, 'faults.json'), JSON.stringify({ fail: 'repair-annotation-published' }));
  await page.getByRole('button', { name: 'Save annotation and apply incoming', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('Controlled filesystem boundary failure.');
  const repairFile = path.join(intake, 'repair-intent.json'), repairBytes = await fs.readFile(repairFile), repair = JSON.parse(repairBytes.toString('utf8'));
  const note = path.join(annotationFolder, repair.annotationId + '.md'), stage = path.join(intake, 'annotation-' + repair.annotationId + '.stage');
  expect(repair.schema).toBe(1); expect(repair.annotationId).toBe(repair.tx.resolution);
  expect(repair.tx.previous).toBe(localBytes.toString('utf8')); expect(repair.tx.previous).toContain(localWriting);
  expect(repair.annotation).toContain(selectedWriting); expect(repair.annotation).not.toContain(localWriting);
  expect(repair.tx.content).not.toContain(localWriting); expect(repair.tx.revision.id).toBe(sourceConflict.revision.id);
  for (const file of [note, stage]) expect(await fs.readFile(file, 'utf8')).toBe(repair.annotation);
  const noteStat = await fs.stat(note, { bigint: true }), stageStat = await fs.stat(stage, { bigint: true });
  expect(noteStat.nlink).toBe(2n); expect(stageStat.nlink).toBe(2n); expect([noteStat.dev, noteStat.ino]).toEqual([stageStat.dev, stageStat.ino]);
  expect(await fs.readFile(capture)).toEqual(localBytes);
  const before = await files(path.join(root, 'vault')), ledgerBytes = await fs.readFile(ledgerFile), producer = await files(path.join(root, 'producer'));
  await page.getByRole('button', { name: 'Review annotations', exact: true }).click();
  const row = page.getByLabel('Annotation removal review', { exact: true }).getByRole('article').filter({ hasText: repair.annotationId });
  await expect(row).toContainText(selectedWriting);
  await row.getByRole('button', { name: 'Preview annotation removal', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('mixed source repair data');
  await expect(page.getByLabel('Annotation removal preview', { exact: true })).toBeHidden();
  const held = JSON.parse(await fs.readFile(ledgerFile, 'utf8'));
  expect(held.annotationRemovals?.[repair.annotationId]).toBeUndefined();
  expect(await fs.readFile(ledgerFile)).toEqual(ledgerBytes); expect(await files(path.join(root, 'vault'))).toEqual(before);
  expect(await fs.readFile(repairFile)).toEqual(repairBytes);
  for (const file of [note, stage]) expect(await fs.readFile(file, 'utf8')).toBe(repair.annotation);
  expect((await fs.stat(note)).nlink).toBe(2); expect((await fs.stat(stage)).nlink).toBe(2);
  expect(await fs.readFile(capture)).toEqual(localBytes); expect(await fs.readFile(retained)).toEqual(retainedBytes);
  expect(await files(path.join(root, 'producer'))).toEqual(producer);
});
