const { test, expect, _electron: electron } = require('@playwright/test');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { createHash } = require('node:crypto');
const YAML = require('yaml');
let root, app, page, checks;
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const exists = file => fs.access(file).then(() => true, error => { if (error.code === 'ENOENT') return false; throw error; });
const portable = file => file.split(path.sep).join('/');

test.beforeEach(async () => { root = await fs.mkdtemp(path.join(os.tmpdir(), 'companion-mixed-retention-')); checks = 0; });
test.afterEach(async () => { if (app) await app.close(); app = null; await fs.rm(root, { recursive: true, force: true }); });
async function bundle(name) {
  await fs.cp(path.join(__dirname, 'fixtures/reel-review', name), path.join(root, 'producer', name), { recursive: true });
}
async function launch() {
  await fs.writeFile(path.join(root, 'clock.json'), JSON.stringify({ now: '2026-11-08T06:59:00Z', timezone: 'America/Phoenix' }));
  app = await electron.launch({ args: ['.'], env: { ...process.env, COMPANION_TEST_ROOT: root } });
  page = await app.firstWindow();
  await expect(page.locator('#timezone')).toContainText('America/Phoenix');
}
async function check(status = 'complete') {
  const instant = new Date(Date.parse('2026-11-08T06:59:00Z') + ++checks * 1000).toISOString();
  await fs.writeFile(path.join(root, 'clock.json'), JSON.stringify({ now: instant, timezone: 'America/Phoenix' }));
  await page.getByRole('button', { name: 'Check now', exact: true }).click();
  await expect(page.locator('#intake-state')).toContainText(`Last check: ${instant} · manual · ${status}`);
}
async function observe(folder, prefix = '') {
  const result = {};
  for (const entry of await fs.readdir(folder, { withFileTypes: true })) {
    const relative = prefix + entry.name, file = path.join(folder, entry.name);
    if (entry.isDirectory()) Object.assign(result, await observe(file, relative + '/'));
    else {
      const bytes = await fs.readFile(file), stat = await fs.lstat(file, { bigint: true });
      result[relative] = { path: file, base64: bytes.toString('base64'), sha256: sha(bytes), bytes: String(stat.size), dev: String(stat.dev), ino: String(stat.ino), nlink: String(stat.nlink), ordinary: stat.isFile() && !stat.isSymbolicLink() };
    }
  }
  return result;
}
const contents = observed => Object.fromEntries(Object.entries(observed).map(([file, value]) => [file, value.base64]));
const text = observed => Buffer.from(observed.base64, 'base64').toString('utf8');
async function save(testInfo, name, value) { await fs.writeFile(testInfo.outputPath(name), JSON.stringify(value, null, 2)); }
async function exitMain(testInfo) {
  const child = app.process(), mainPid = await app.evaluate(() => process.pid);
  const proof = { checkpoint: await fs.readFile(path.join(root, 'checkpoint.txt'), 'utf8'), wrapperPid: child.pid, mainPid, action: 'Electron app.exit(77)' };
  const exited = new Promise(resolve => child.once('exit', (code, signal) => resolve({ code, signal })));
  const abrupt = app.evaluate(({ app: electronApp }) => electronApp.exit(77)).catch(error => { if (!/closed|disposed/i.test(error.message)) throw error; });
  proof.wrapperExit = await exited; await abrupt;
  await save(testInfo, 'mixed-main-exit.json', proof);
  await expect.poll(() => { try { process.kill(mainPid, 0); return 'alive'; } catch (error) { if (error.code === 'ESRCH') return 'exited'; throw error; } }).toBe('exited');
  proof.mainObservedExited = true;
  await save(testInfo, 'mixed-main-exit.json', proof); app = null;
  return proof;
}

test('deleting a held kept-current repair retains distinct annotation and whole local writing with source quotations', async ({}, testInfo) => {
  test.setTimeout(150000);
  await bundle('accept'); await launch();
  await page.getByRole('button', { name: 'Choose vault', exact: true }).click();
  await page.getByRole('button', { name: 'Use this folder', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('Vault ready.');
  await page.getByLabel('Finalized review folder').fill(path.join(root, 'producer'));
  await page.getByRole('button', { name: 'Connect finalized reviews', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('Source connected'); await check();
  const base = path.join(root, 'vault', 'Companion'), intake = path.join(base, '.intake'), ledgerFile = path.join(intake, 'ledger.json');
  const acceptedLedger = JSON.parse(await fs.readFile(ledgerFile, 'utf8'));
  const [sourceHash, capture] = Object.entries(acceptedLedger.captures)[0];
  const current = path.join(base, 'Captures', capture.file), snapshot = path.join(base, 'Revisions', capture.currentRevision + '.json');
  const managedA = await fs.readFile(current), snapshotA = await fs.readFile(snapshot);
  const localWriting = '\nWHOLELOCALY: Keep this full local version. Source quotation: "Authored synthetic review fixture only."\nLiteral fence stress: ``````\n';
  const annotationWriting = 'ANNOTATIONX: A separate chosen observation. Source quotation: "Authored synthetic review".';
  await fs.appendFile(current, localWriting); const wholeY = await fs.readFile(current);
  await bundle('edit'); await check('held');
  await expect(page.getByLabel('Vault repairs')).toContainText('WHOLELOCALY');
  const originalLedger = JSON.parse(await fs.readFile(ledgerFile, 'utf8'));
  const originalArchive = path.join(intake, originalLedger.blocks[sourceHash].journal);
  const originalTransaction = JSON.parse(await fs.readFile(originalArchive, 'utf8'));
  const producer = contents(await observe(path.join(root, 'producer')));
  await fs.writeFile(path.join(root, 'faults.json'), JSON.stringify({ pause: 'repair-intent-published' }));
  await page.getByLabel('Transfer local writing').fill(annotationWriting);
  await page.getByRole('button', { name: 'Save annotation and apply incoming', exact: true }).click();
  await expect.poll(() => fs.readFile(path.join(root, 'checkpoint.txt'), 'utf8').catch(() => '')).toBe('repair-intent-published');
  const intentBytes = await fs.readFile(path.join(intake, 'repair-intent.json')), intent = JSON.parse(intentBytes);
  await save(testInfo, 'mixed-intent-observations.json', { files: await observe(base), producer, acceptedLedger, originalLedger });
  const processProof = await exitMain(testInfo);
  await fs.writeFile(path.join(root, 'faults.json'), JSON.stringify({ fail: 'kept-current-read', code: 'EACCES' }));
  await launch();
  // Wait only for the actual held writer to finish retiring its active intent.
  await expect.poll(async () => !await exists(path.join(intake, 'repair-intent.json')) && await exists(path.join(intake, `repair-${intent.annotationId}.json`))).toBe(true);
  const observed = await observe(base), held = JSON.parse(text(observed['.intake/ledger.json']));
  const resolutionArchive = path.join(intake, held.blocks[sourceHash].journal), repairArchive = path.join(intake, `repair-${intent.annotationId}.json`);
  const origins = [current, snapshot, originalArchive, resolutionArchive, repairArchive];
  // Save every actual buffer and physical identity before family-count or preview assertions.
  await save(testInfo, 'mixed-held-observations.json', { root, processProof, observed, origins, producer, acceptedLedger, originalLedger, held });
  await fs.unlink(path.join(root, 'faults.json'));
  await expect(page.locator('#captures article')).toHaveCount(1);
  const selected = origins.map(file => observed[portable(path.relative(base, file))]);
  expect(selected.every(Boolean)).toBe(true);
  expect(new Set(origins).size).toBe(5);
  expect(selected.every(file => file.ordinary && file.nlink === '1')).toBe(true);
  expect(new Set(selected.map(file => `${file.dev}:${file.ino}`)).size).toBe(5);
  expect(Object.keys(observed).filter(file => /^(Captures|Revisions)\//.test(file) || /^\.intake\/(?:repair-|conflict-)/.test(file)).sort()).toEqual(origins.map(file => portable(path.relative(base, file))).sort());
  expect(await fs.readFile(current)).toEqual(wholeY); expect(await fs.readFile(snapshot)).toEqual(snapshotA);
  expect(originalTransaction.retainOnly).toBe(true); expect(originalTransaction.externalConflict).toBe(true);
  expect(originalTransaction.content).toBe(wholeY.toString('utf8')); expect(originalTransaction.previous).toBe(wholeY.toString('utf8'));
  const resolution = JSON.parse(await fs.readFile(resolutionArchive, 'utf8')), repair = JSON.parse(await fs.readFile(repairArchive, 'utf8'));
  expect(resolution.retainOnly).toBe(false); expect(resolution.externalConflict).toBe(false);
  expect(resolution.keptCurrent).toEqual(JSON.parse(snapshotA)); expect(resolution.content).toBe(managedA.toString('utf8')); expect(resolution.previous).toBe(wholeY.toString('utf8'));
  expect(repair).toEqual(intent); expect(repair.tx).toEqual(resolution); expect(repair.annotation).toContain(annotationWriting);
  expect(repair.annotation).not.toContain('WHOLELOCALY'); expect(repair.annotation).not.toContain('source_generation:');
  expect(repair.localHash).toBe(sha(wholeY)); expect(resolution.previousHash).toBe(sha(wholeY));
  expect(await fs.readdir(path.join(base, 'Annotations'))).toEqual([]);
  expect(held.attempts).toEqual(acceptedLedger.attempts); expect(held.admissions).toEqual(acceptedLedger.admissions);
  expect(held.attempts[originalTransaction.revision.identity]).toBeUndefined();
  expect(held.admissions?.[originalTransaction.revision.id]).toBeUndefined();
  expect(await exists(path.join(base, 'Revisions', originalTransaction.revision.id + '.json'))).toBe(false);
  expect(held.captures[sourceHash].currentRevision).toBe(capture.currentRevision);
  for (const name of ['transaction.json', 'repair-intent.json', `annotation-${intent.annotationId}.stage`]) expect(await exists(path.join(intake, name))).toBe(false);
  const before = contents(await observe(base));
  await page.getByRole('button', { name: 'Delete capture', exact: true }).click();
  await save(testInfo, 'mixed-delete-preview-observations.json', { status: await page.getByRole('status').textContent(), preview: await page.getByLabel('Capture deletion preview').textContent(), files: await observe(base) });
  // Expected first feature RED: ordinary changed-current guard currently holds before this complete review.
  const preview = page.getByLabel('Capture deletion preview'); await expect(preview).toBeVisible();
  const reviewed = await preview.textContent();
  expect(reviewed).toContain(repair.annotation); expect(reviewed).toContain(wholeY.toString('utf8'));
  expect(reviewed).toContain('Retained whole local version'); expect(reviewed).toMatch(/retain[\s\S]*source quotations/i);
  for (const file of origins) expect(reviewed).toContain(portable(path.relative(path.join(root, 'vault'), file)));
  const outputPaths = [...new Set(reviewed.match(/Companion\/Annotations\/[a-f0-9-]{36}\.md/g) || [])];
  expect(outputPaths).toHaveLength(2); expect(outputPaths).toContain(`Companion/Annotations/${intent.annotationId}.md`);
  for (const file of outputPaths) expect(reviewed).toContain(path.basename(file, '.md'));
  expect(contents(await observe(base))).toEqual(before);
  await preview.getByRole('button', { name: 'Cancel capture deletion', exact: true }).click();
  await expect(preview).toBeHidden(); expect(contents(await observe(base))).toEqual(before);
  await page.getByRole('button', { name: 'Delete capture', exact: true }).click();
  await expect(page.getByLabel('Capture deletion preview')).toBeVisible();
  const confirmedText = await page.getByLabel('Capture deletion preview').textContent();
  expect(confirmedText).toContain(repair.annotation); expect(confirmedText).toContain(wholeY.toString('utf8'));
  // Cancel may discard its memory-only destination. Read the freshly reviewed destinations again.
  const confirmedPaths = [...new Set(confirmedText.match(/Companion\/Annotations\/[a-f0-9-]{36}\.md/g) || [])]; expect(confirmedPaths).toHaveLength(2);
  await fs.writeFile(path.join(root, 'faults.json'), JSON.stringify({ pause: 'capture-deletion-unlinked' }));
  await page.getByLabel('Capture deletion preview').getByRole('button', { name: 'Confirm capture deletion', exact: true }).click();
  await expect.poll(() => fs.readFile(path.join(root, 'checkpoint.txt'), 'utf8')).toBe('capture-deletion-unlinked');
  const firstUnlink = await observe(base);
  await save(testInfo, 'mixed-first-unlink-observations.json', { observed: firstUnlink, ledger: JSON.parse(text(firstUnlink['.intake/ledger.json'])) });
  expect((await Promise.all(origins.map(exists))).filter(Boolean)).toHaveLength(4);
  const outputFiles = confirmedPaths.map(file => path.join(root, 'vault', file));
  const originalOutput = path.join(base, 'Annotations', intent.annotationId + '.md');
  expect(await fs.readFile(originalOutput)).toEqual(Buffer.from(repair.annotation, 'utf8'));
  const wholeOutput = outputFiles.find(file => file !== originalOutput), wholeBytes = await fs.readFile(wholeOutput);
  expect(wholeBytes.includes(wholeY)).toBe(true);
  const wrapper = YAML.parse(wholeBytes.toString('utf8').match(/^---\r?\n([\s\S]*?)\r?\n---/)[1]);
  expect(wrapper.capture_id).toBe(capture.id); expect(wrapper.artifact_type).toBe('annotation');
  expect(wrapper.source_generation).toBe(resolution.sourceGeneration);
  expect(wholeBytes.toString('utf8')).toContain('Retained whole local version');
  const quoted = wholeBytes.toString('utf8'), fence = quoted.match(/^(`{3,})text\r?$/m)?.[1];
  expect(fence?.length).toBeGreaterThan(6); expect(quoted).toContain(fence + 'text\n' + wholeY.toString('utf8'));
  const outputBefore = await Promise.all(outputFiles.map(file => fs.readFile(file)));
  await fs.writeFile(path.join(root, 'release.txt'), 'continue');
  await expect(page.getByRole('status')).toContainText('Capture deleted');
  await fs.unlink(path.join(root, 'faults.json')); await fs.unlink(path.join(root, 'release.txt'));
  for (const file of origins) expect(await exists(file)).toBe(false);
  const deleted = JSON.parse(await fs.readFile(ledgerFile, 'utf8'));
  expect(deleted.sourceAuthority[capture.id].phase).toBe('deleted'); expect(deleted.suppressed).toContain(sourceHash);
  expect(deleted.attempts).toEqual(acceptedLedger.attempts); expect(deleted.admissions).toEqual(acceptedLedger.admissions);
  expect(deleted.blocks[sourceHash]).toBeUndefined(); expect(deleted.pending[sourceHash]).toBeUndefined();
  expect(Object.keys(await observe(base)).filter(file => /^(Captures|Revisions)\//.test(file) || /^\.intake\/(?:repair-|conflict-|deletion-writing-)/.test(file))).toEqual([]);
  expect(contents(await observe(path.join(root, 'producer')))).toEqual(producer);
  await check('held');
  const checked = JSON.parse(await fs.readFile(ledgerFile, 'utf8')), checkedAt = JSON.parse(await fs.readFile(path.join(root, 'clock.json'), 'utf8')).now;
  await save(testInfo, 'mixed-post-suppression-observations.json', { observed: await observe(base), checked });
  const outcomes = Object.values(checked.outcomes);
  expect(outcomes).toHaveLength(2);
  expect(outcomes.map(value => value.locator).sort()).toEqual(Object.values(originalLedger.outcomes).map(value => value.locator).sort());
  for (const outcome of outcomes) {
    expect(outcome.status).toBe('held'); expect(outcome.checkedAt).toBe(checkedAt);
    expect(outcome.reason).toBe('Automatic re-import is suppressed. Restore this source explicitly before intake.');
  }
  await app.close(); app = null; await launch();
  await expect(page.locator('#captures article')).toHaveCount(0);
  for (const file of origins) expect(await exists(file)).toBe(false);
  expect(await Promise.all(outputFiles.map(file => fs.readFile(file)))).toEqual(outputBefore);
  const restarted = JSON.parse(await fs.readFile(ledgerFile, 'utf8'));
  expect(restarted.attempts).toEqual(acceptedLedger.attempts); expect(restarted.admissions).toEqual(acceptedLedger.admissions); expect(restarted.suppressed).toContain(sourceHash);
  expect(contents(await observe(path.join(root, 'producer')))).toEqual(producer);
  await save(testInfo, 'mixed-completed-observations.json', { observed: await observe(base), restarted });
});

// New guards share only the real writer setup. The first journey remains unchanged.
async function heldMixedRepair(testInfo, { restoredG = false } = {}) {
  await bundle('accept'); await launch();
  await page.getByRole('button', { name: 'Choose vault', exact: true }).click();
  await page.getByRole('button', { name: 'Use this folder', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('Vault ready.');
  await page.getByLabel('Finalized review folder').fill(path.join(root, 'producer'));
  await page.getByRole('button', { name: 'Connect finalized reviews', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('Source connected'); await check();
  const base = path.join(root, 'vault', 'Companion'), intake = path.join(base, '.intake'), ledgerFile = path.join(intake, 'ledger.json');
  const originalAcceptedLedger = JSON.parse(await fs.readFile(ledgerFile, 'utf8')), [sourceHash, originalCapture] = Object.entries(originalAcceptedLedger.captures)[0];
  let acceptedLedger = originalAcceptedLedger, capture = originalCapture, generation;
  if (restoredG) {
    await page.getByRole('button', { name: 'Delete capture', exact: true }).click();
    await expect(page.getByLabel('Capture deletion preview')).toBeVisible();
    await page.getByLabel('Capture deletion preview').getByRole('button', { name: 'Confirm capture deletion', exact: true }).click();
    await expect(page.getByRole('status')).toContainText('Capture deleted');
    await page.getByRole('button', { name: 'Review suppressed captures', exact: true }).click();
    const restoration = page.getByLabel('Source restoration');
    await expect(restoration).toBeVisible();
    await restoration.getByLabel('Selected producer artifact folder', { exact: true }).fill(path.join(root, 'producer', 'accept'));
    await restoration.getByRole('combobox', { name: /^Selected producer artifact kind/ }).selectOption('review');
    await restoration.getByRole('button', { name: 'Preview source restoration', exact: true }).click();
    await expect(restoration.getByRole('button', { name: 'Confirm source restoration', exact: true })).toBeVisible();
    await restoration.getByRole('button', { name: 'Confirm source restoration', exact: true }).click();
    await expect(page.getByRole('status')).toContainText('Source restored');
    await expect(page.locator('#captures article')).toHaveCount(1);
    acceptedLedger = JSON.parse(await fs.readFile(ledgerFile, 'utf8')); capture = acceptedLedger.captures[sourceHash];
    generation = acceptedLedger.sourceAuthority[capture.id].generation;
    await save(testInfo, 'mixed-restored-G-observations.json', { observed: await observe(base), originalAcceptedLedger, acceptedLedger });
    expect(acceptedLedger.sourceAuthority[capture.id].phase).toBe('active');
    expect(acceptedLedger.admissions[capture.currentRevision].sourceGeneration).toBe(generation);
    expect(capture.currentRevision).not.toBe(originalCapture.currentRevision);
    expect(acceptedLedger.attempts).toEqual(originalAcceptedLedger.attempts);
  }
  const current = path.join(base, 'Captures', capture.file), snapshot = path.join(base, 'Revisions', capture.currentRevision + '.json');
  const managedA = await fs.readFile(current), snapshotA = await fs.readFile(snapshot);
  await fs.appendFile(current, '\nGUARDWHOLEY: Keep this complete local version with source quotation "Authored synthetic review fixture only."\n');
  const wholeY = await fs.readFile(current), annotationWriting = 'GUARDANNOTATIONX: Distinct chosen writing with source quotation "Authored synthetic review".';
  await bundle('edit'); await check('held');
  await expect(page.getByLabel('Vault repairs')).toContainText('GUARDWHOLEY');
  const originalLedger = JSON.parse(await fs.readFile(ledgerFile, 'utf8')), originalArchive = path.join(intake, originalLedger.blocks[sourceHash].journal);
  const producer = contents(await observe(path.join(root, 'producer')));
  await fs.writeFile(path.join(root, 'faults.json'), JSON.stringify({ pause: 'repair-intent-published' }));
  await page.getByLabel('Transfer local writing').fill(annotationWriting);
  await page.getByRole('button', { name: 'Save annotation and apply incoming', exact: true }).click();
  await expect.poll(() => fs.readFile(path.join(root, 'checkpoint.txt'), 'utf8').catch(() => '')).toBe('repair-intent-published');
  const intent = JSON.parse(await fs.readFile(path.join(intake, 'repair-intent.json'), 'utf8'));
  await save(testInfo, 'mixed-guard-intent-observations.json', { observed: await observe(base), acceptedLedger, originalLedger, producer });
  const processProof = await exitMain(testInfo);
  await fs.writeFile(path.join(root, 'faults.json'), JSON.stringify({ fail: 'kept-current-read', code: 'EACCES' }));
  await launch();
  await expect.poll(async () => !await exists(path.join(intake, 'repair-intent.json')) && await exists(path.join(intake, `repair-${intent.annotationId}.json`))).toBe(true);
  const observed = await observe(base), held = JSON.parse(text(observed['.intake/ledger.json']));
  const resolutionArchive = path.join(intake, held.blocks[sourceHash].journal), repairArchive = path.join(intake, `repair-${intent.annotationId}.json`);
  const origins = [current, snapshot, originalArchive, resolutionArchive, repairArchive];
  await save(testInfo, 'mixed-guard-held-observations.json', { observed, origins, acceptedLedger, originalLedger, held, producer, processProof });
  await fs.unlink(path.join(root, 'faults.json'));
  await expect(page.locator('#captures article')).toHaveCount(1);
  expect(Object.keys(observed).filter(file => /^(Captures|Revisions)\//.test(file) || /^\.intake\/(?:repair-|conflict-)/.test(file)).sort()).toEqual(origins.map(file => portable(path.relative(base, file))).sort());
  const selected = origins.map(file => observed[portable(path.relative(base, file))]);
  expect(selected.every(value => value?.ordinary && value.nlink === '1')).toBe(true);
  expect(new Set(selected.map(value => `${value.dev}:${value.ino}`)).size).toBe(5);
  expect(await fs.readFile(current)).toEqual(wholeY); expect(await fs.readFile(snapshot)).toEqual(snapshotA);
  const original = JSON.parse(await fs.readFile(originalArchive, 'utf8')), resolution = JSON.parse(await fs.readFile(resolutionArchive, 'utf8'));
  expect(original.retainOnly).toBe(true); expect(original.externalConflict).toBe(true);
  expect(original.content).toBe(wholeY.toString('utf8')); expect(original.previous).toBe(wholeY.toString('utf8'));
  expect(resolution.keptCurrent).toEqual(JSON.parse(snapshotA)); expect(resolution.previous).toBe(wholeY.toString('utf8')); expect(resolution.content).toBe(managedA.toString('utf8'));
  expect(JSON.parse(await fs.readFile(repairArchive, 'utf8'))).toEqual(intent); expect(intent.tx).toEqual(resolution);
  expect(intent.annotation).toContain(annotationWriting); expect(intent.annotation).not.toContain('GUARDWHOLEY');
  expect(held.attempts).toEqual(acceptedLedger.attempts); expect(held.admissions).toEqual(acceptedLedger.admissions);
  expect(held.attempts[original.revision.identity]).toBeUndefined(); expect(held.admissions?.[original.revision.id]).toBeUndefined();
  expect(await exists(path.join(base, 'Revisions', original.revision.id + '.json'))).toBe(false);
  expect(await fs.readdir(path.join(base, 'Annotations'))).toEqual([]);
  for (const name of ['transaction.json', 'repair-intent.json', `annotation-${intent.annotationId}.stage`]) expect(await exists(path.join(intake, name))).toBe(false);
  return { base, intake, ledgerFile, capture, sourceHash, intent, origins, held, producer, wholeY, acceptedLedger, originalAcceptedLedger, generation };
}

test('mixed retention destination collision holds unique third writing without authority or purge', async ({}, testInfo) => {
  test.setTimeout(150000);
  const fixture = await heldMixedRepair(testInfo), { base, ledgerFile, capture, intent, origins, producer } = fixture;
  const destination = path.join(base, 'Annotations', intent.annotationId + '.md');
  const thirdWriting = Buffer.from(intent.annotation + '\nCOLLISIONTHIRDWRITING: Existing independently edited destination must stay exact.\n', 'utf8');
  // This is an external file collision at the actual writer's destination, not new authority.
  await fs.writeFile(destination, thirdWriting, { flag: 'wx', flush: true });
  const before = await observe(base), originalLedgerBytes = await fs.readFile(ledgerFile);
  await save(testInfo, 'mixed-collision-before.json', { observed: before, destination, origins, producer });
  expect(thirdWriting.equals(Buffer.from(intent.annotation))).toBe(false); expect(thirdWriting.equals(fixture.wholeY)).toBe(false);
  await page.getByRole('button', { name: 'Delete capture', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('collides with an unreviewed destination');
  const after = await observe(base), ledger = JSON.parse(await fs.readFile(ledgerFile, 'utf8'));
  await save(testInfo, 'mixed-collision-held.json', { status: await page.getByRole('status').textContent(), preview: await page.getByLabel('Capture deletion preview').textContent(), observed: after, ledger, destination, origins });
  await expect(page.getByLabel('Capture deletion preview')).toBeHidden();
  await expect(page.getByRole('status')).toContainText(portable(path.relative(path.join(root, 'vault'), destination)));
  expect(ledger.sourceAuthority?.[capture.id]).toBeUndefined(); expect(ledger.suppressed).not.toContain(fixture.sourceHash);
  expect(await fs.readFile(ledgerFile)).toEqual(originalLedgerBytes);
  expect(after).toEqual(before);
  expect(await fs.readFile(destination)).toEqual(thirdWriting);
  for (const file of origins) expect(await exists(file)).toBe(true);
  expect(contents(await observe(path.join(root, 'producer')))).toEqual(producer);
});

test('completed mixed retention permits explicit annotation removal and fresh source restoration with immutable historical owner', async ({}, testInfo) => {
  test.setTimeout(150000);
  const fixture = await heldMixedRepair(testInfo, { restoredG: true });
  const { base, ledgerFile, capture, sourceHash, intent, origins, producer, generation } = fixture;
  await page.getByRole('button', { name: 'Delete capture', exact: true }).click();
  const deletionPreview = page.getByLabel('Capture deletion preview'); await expect(deletionPreview).toBeVisible();
  const reviewed = await deletionPreview.textContent();
  expect(reviewed).toContain(intent.annotation); expect(reviewed).toContain(fixture.wholeY.toString('utf8'));
  const reviewedPaths = [...new Set(reviewed.match(/Companion\/Annotations\/[a-f0-9-]{36}\.md/g) || [])]; expect(reviewedPaths).toHaveLength(2);
  await deletionPreview.getByRole('button', { name: 'Confirm capture deletion', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('Capture deleted');
  const deleted = JSON.parse(await fs.readFile(ledgerFile, 'utf8')), authority = deleted.sourceAuthority[capture.id], deletedFiles = await observe(base);
  await save(testInfo, 'mixed-lifecycle-deleted.json', { observed: deletedFiles, deleted, reviewed, origins, originalGeneration: generation });
  expect(authority.phase).toBe('deleted'); expect(authority.generation).not.toBe(generation);
  expect(authority.originGenerations).toEqual([{ captureId: capture.id, generation }]); expect(authority.mixedRecovery.sourceGeneration).toBe(generation);
  expect(authority.preservedWriting.every(plan => plan.publication && plan.publicationOperationId === authority.operationId && plan.sourceGeneration === generation)).toBe(true);
  expect(authority.preservedWriting.map(plan => plan.file).sort()).toEqual([...reviewedPaths].sort());
  const originalOutput = path.join(base, 'Annotations', intent.annotationId + '.md'), originalRelative = portable(path.relative(base, originalOutput));
  const wholePlan = authority.preservedWriting.find(plan => plan.payloadKind === 'previous-whole-variant'), wholeOutput = path.join(root, 'vault', wholePlan.file), wholeRelative = portable(path.relative(base, wholeOutput));
  expect(await fs.readFile(originalOutput)).toEqual(Buffer.from(intent.annotation)); expect((await fs.readFile(wholeOutput)).includes(fixture.wholeY)).toBe(true);
  for (const file of origins) expect(await exists(file)).toBe(false);
  expect(deleted.attempts).toEqual(fixture.originalAcceptedLedger.attempts); expect(deleted.admissions).toEqual(fixture.acceptedLedger.admissions);
  await page.getByRole('button', { name: 'Review annotations', exact: true }).click();
  const annotationReview = page.getByLabel('Annotation removal review', { exact: true });
  const selectedRow = annotationReview.getByRole('article').filter({ hasText: intent.annotationId });
  await expect(selectedRow).toContainText('GUARDANNOTATIONX');
  await selectedRow.getByRole('button', { name: 'Preview annotation removal', exact: true }).click();
  const removalPreview = page.getByLabel('Annotation removal preview', { exact: true }); await expect(removalPreview).toBeVisible();
  await expect(removalPreview).toContainText(intent.annotationId); await expect(removalPreview).toContainText(portable(path.relative(path.join(root, 'vault'), originalOutput)));
  await expect(removalPreview).not.toContainText(wholePlan.annotationId);
  await removalPreview.getByRole('button', { name: 'Confirm annotation removal', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('Annotation removed');
  const removed = JSON.parse(await fs.readFile(ledgerFile, 'utf8')), removedFiles = await observe(base);
  await save(testInfo, 'mixed-lifecycle-annotation-removed.json', { observed: removedFiles, removed, originalOutput, wholeOutput });
  expect(await exists(originalOutput)).toBe(false); expect(removedFiles[wholeRelative]).toEqual(deletedFiles[wholeRelative]);
  expect(removed.sourceAuthority[capture.id]).toEqual(authority);
  expect(removed.annotationRemovals[intent.annotationId].phase).toBe('removed');
  for (const key of ['captures', 'attempts', 'admissions', 'suppressed']) expect(removed[key]).toEqual(deleted[key]);
  await app.close(); app = null; await launch();
  await save(testInfo, 'mixed-lifecycle-restart-after-removal.json', { observed: await observe(base), status: await page.getByRole('status').textContent() });
  await expect(page.locator('#captures article')).toHaveCount(0);
  expect(await exists(originalOutput)).toBe(false); expect((await observe(base))[wholeRelative]).toEqual(deletedFiles[wholeRelative]);
  await page.getByRole('button', { name: 'Review suppressed captures', exact: true }).click();
  const restoration = page.getByLabel('Source restoration'); await expect(restoration).toBeVisible(); await expect(restoration).toContainText(capture.id);
  await restoration.getByLabel('Selected producer artifact folder', { exact: true }).fill(path.join(root, 'producer', 'accept'));
  await restoration.getByRole('combobox', { name: /^Selected producer artifact kind/ }).selectOption('review');
  await restoration.getByRole('button', { name: 'Preview source restoration', exact: true }).click();
  await expect(restoration.getByRole('button', { name: 'Confirm source restoration', exact: true })).toBeVisible();
  await restoration.getByRole('button', { name: 'Confirm source restoration', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('Source restored'); await expect(page.locator('#captures article')).toHaveCount(1);
  const restored = JSON.parse(await fs.readFile(ledgerFile, 'utf8')), active = restored.sourceAuthority[capture.id], current = restored.captures[sourceHash], restoredFiles = await observe(base);
  await save(testInfo, 'mixed-lifecycle-source-restored.json', { observed: restoredFiles, restored, historicalAuthority: authority, originalGeneration: generation });
  expect(active.phase).toBe('active'); expect(active.operationId).not.toBe(authority.operationId);
  expect(active.generation).not.toBe(generation); expect(active.generation).not.toBe(authority.generation);
  for (const key of ['mixedRecovery', 'preservedWriting', 'originGenerations']) expect(active[key]).toEqual(authority[key]);
  const { history: priorHistory, ...deletedHistory } = authority;
  expect(active.history).toEqual([...(priorHistory || []), deletedHistory]);
  expect(active.history.filter(item => item.operationId === authority.operationId)).toHaveLength(1);
  expect(active.preservedWriting.every(plan => plan.publicationOperationId === authority.operationId && plan.publicationOperationId !== active.operationId && plan.sourceGeneration === generation)).toBe(true);
  expect(restored.attempts).toEqual(fixture.originalAcceptedLedger.attempts);
  for (const [id, admission] of Object.entries(deleted.admissions)) expect(restored.admissions[id]).toEqual(admission);
  expect(Object.keys(restored.admissions).filter(id => !Object.hasOwn(deleted.admissions, id))).toEqual([current.currentRevision]);
  expect(restored.admissions[current.currentRevision].sourceGeneration).toBe(active.generation);
  expect(restored.admissions[current.currentRevision].identity).toBe(fixture.acceptedLedger.admissions[capture.currentRevision].identity);
  expect(current.currentRevision).not.toBe(capture.currentRevision); expect(current.currentRevision).not.toBe(intent.tx.revision.id);
  expect(restored.admissions[intent.tx.revision.id]).toBeUndefined(); expect(restored.attempts[intent.tx.revision.identity]).toBeUndefined();
  expect(restored.suppressed).not.toContain(sourceHash); expect(restored.annotationRemovals[intent.annotationId]).toEqual(removed.annotationRemovals[intent.annotationId]);
  expect(await exists(originalOutput)).toBe(false); expect(restoredFiles[originalRelative]).toBeUndefined(); expect(restoredFiles[wholeRelative]).toEqual(deletedFiles[wholeRelative]);
  expect((await fs.readdir(path.join(base, 'Annotations'))).sort()).toEqual([path.basename(wholeOutput)]);
  for (const plan of active.preservedWriting) expect(await exists(path.join(root, 'vault', plan.stage))).toBe(false);
  for (const file of origins.filter(file => file !== path.join(base, 'Captures', capture.file))) expect(await exists(file)).toBe(false);
  expect(contents(await observe(path.join(root, 'producer')))).toEqual(producer);
  // A pure public ledger-load rejection must reach the inherited-history binding.
  const { randomUUID } = require('node:crypto'), forgedOwner = randomUUID(), corrupted = JSON.parse(JSON.stringify(restored));
  const corruptAuthority = corrupted.sourceAuthority[capture.id];
  expect([active.operationId, authority.operationId]).not.toContain(forgedOwner);
  for (const plan of corruptAuthority.preservedWriting) {
    plan.publicationOperationId = forgedOwner;
    plan.stage = path.posix.join(path.posix.dirname(plan.stage), `deletion-writing-${forgedOwner}-${plan.annotationId}.stage`);
  }
  // Keep the current owner-reference graph well shaped so an earlier purge-owner check cannot mask history validation.
  const purge = corruptAuthority.purgedProducerAttempts.find(item => item.identity === corruptAuthority.mixedRecovery.incomingIdentity);
  expect(purge.operationId).toBe(authority.operationId); purge.operationId = forgedOwner;
  expect(corruptAuthority.history).toEqual(active.history); expect(corruptAuthority.operationId).toBe(active.operationId);
  const reversed = JSON.parse(JSON.stringify(corrupted)), reversedAuthority = reversed.sourceAuthority[capture.id];
  for (const [index, plan] of reversedAuthority.preservedWriting.entries()) {
    plan.publicationOperationId = active.preservedWriting[index].publicationOperationId; plan.stage = active.preservedWriting[index].stage;
  }
  reversedAuthority.purgedProducerAttempts.find(item => item.identity === corruptAuthority.mixedRecovery.incomingIdentity).operationId = authority.operationId;
  expect(reversed).toEqual(restored);
  await fs.writeFile(ledgerFile, JSON.stringify(corrupted, null, 2), { flush: true });
  const beforePureLoad = await observe(base);
  await save(testInfo, 'mixed-lifecycle-corrupt-inherited-owner.json', { observed: beforePureLoad, corrupted, forgedOwner, unchangedHistory: active.history,
    controlledFields: ['preservedWriting[*].publicationOperationId', 'preservedWriting[*].stage', 'matching incoming purgedProducerAttempts.operationId'] });
  const rejection = await page.evaluate(async () => {
    try { await window.captureDeletion.suppressed(); return null; }
    catch (error) { return error.message; }
  });
  const afterPureLoad = await observe(base);
  await save(testInfo, 'mixed-lifecycle-inherited-owner-rejected.json', { rejection, observed: afterPureLoad, corrupted });
  expect(rejection).toContain('inherited retention owner'); expect(rejection).not.toContain('incoming purge observation');
  expect(afterPureLoad).toEqual(beforePureLoad);
  expect(JSON.parse(await fs.readFile(ledgerFile, 'utf8'))).toEqual(corrupted);
  expect(await exists(originalOutput)).toBe(false); expect(afterPureLoad[wholeRelative]).toEqual(deletedFiles[wholeRelative]);
  expect(contents(await observe(path.join(root, 'producer')))).toEqual(producer);
});

test('mixed retention resumes an actual annotation link before receipt with original restored generation', async ({}, testInfo) => {
  test.setTimeout(150000);
  const fixture = await heldMixedRepair(testInfo, { restoredG: true });
  const { base, intake, ledgerFile, capture, sourceHash, intent, origins, producer, generation, acceptedLedger } = fixture;
  const originBefore = await observe(base), beforeReview = contents(originBefore);
  await page.getByRole('button', { name: 'Delete capture', exact: true }).click();
  const preview = page.getByLabel('Capture deletion preview'); await expect(preview).toBeVisible();
  expect(await preview.textContent()).toContain(intent.annotation); expect(await preview.textContent()).toContain(fixture.wholeY.toString('utf8'));
  await preview.getByRole('button', { name: 'Cancel capture deletion', exact: true }).click();
  await expect(preview).toBeHidden(); expect(contents(await observe(base))).toEqual(beforeReview);
  await page.getByRole('button', { name: 'Delete capture', exact: true }).click();
  await expect(page.getByLabel('Capture deletion preview')).toBeVisible();
  const reviewedText = await page.getByLabel('Capture deletion preview').textContent();
  const reviewedPaths = [...new Set(reviewedText.match(/Companion\/Annotations\/[a-f0-9-]{36}\.md/g) || [])]; expect(reviewedPaths).toHaveLength(2);
  const outputs = reviewedPaths.map(file => path.join(root, 'vault', file));
  const observerFile = testInfo.outputPath('mixed-native-link-observer.json'), beforeFile = testInfo.outputPath('mixed-native-link-before.json');
  await app.evaluate((_electron, options) => {
    const io = process.getBuiltinModule('fs').promises, paths = process.getBuiltinModule('path'), crypto = process.getBuiltinModule('crypto');
    const nativeLink = io.link, selected = new Set(options.outputs.map(file => paths.resolve(file).toLowerCase()));
    const snapshot = async file => {
      try {
        const bytes = await io.readFile(file), stat = await io.lstat(file, { bigint: true });
        return { path: file, sha256: crypto.createHash('sha256').update(bytes).digest('hex'), dev: String(stat.dev), ino: String(stat.ino), bytes: String(stat.size), nlink: String(stat.nlink), ordinary: stat.isFile() && !stat.isSymbolicLink() };
      } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
    };
    io.link = async function (source, destination, ...args) {
      if (typeof destination !== 'string' || !selected.has(paths.resolve(destination).toLowerCase())) return nativeLink.call(this, source, destination, ...args);
      io.link = nativeLink;
      const before = { ledger: JSON.parse(await io.readFile(options.ledgerFile, 'utf8')), stage: await snapshot(source), output: await snapshot(destination), origins: await Promise.all(options.origins.map(snapshot)) };
      await io.writeFile(options.beforeFile, JSON.stringify({ boundary: 'before actual native annotation link', mainPid: process.pid, source, destination, nativeLinkReturned: false, before }, null, 2), { flush: true });
      await nativeLink.call(this, source, destination, ...args);
      const after = { ledger: JSON.parse(await io.readFile(options.ledgerFile, 'utf8')), stage: await snapshot(source), output: await snapshot(destination), origins: await Promise.all(options.origins.map(snapshot)) };
      await io.writeFile(options.observerFile, JSON.stringify({ boundary: 'actual native annotation link returned; before publication receipt', mainPid: process.pid, source, destination, nativeLinkReturned: true, before, after }, null, 2), { flush: true });
      // Hold return to the product after the real link, before it can commit its receipt.
      await new Promise(() => {});
    };
  }, { outputs, ledgerFile, origins, observerFile, beforeFile });
  await page.getByLabel('Capture deletion preview').getByRole('button', { name: 'Confirm capture deletion', exact: true }).click();
  await expect.poll(async () => {
    try { return JSON.parse(await fs.readFile(observerFile, 'utf8')).nativeLinkReturned; }
    catch (error) { if (error.code === 'ENOENT' || error instanceof SyntaxError) return false; throw error; }
  }).toBe(true);
  const observation = JSON.parse(await fs.readFile(observerFile, 'utf8')), actualBefore = JSON.parse(await fs.readFile(beforeFile, 'utf8'));
  const authority = observation.before.ledger.sourceAuthority[capture.id], afterAuthority = observation.after.ledger.sourceAuthority[capture.id];
  const linkedPlan = authority.preservedWriting.find(plan => path.join(root, 'vault', plan.file) === observation.destination);
  await save(testInfo, 'mixed-native-link-paused-vault.json', { observation, actualBefore, observed: await observe(base), fixtureGeneration: generation });
  expect(actualBefore.nativeLinkReturned).toBe(false); expect(actualBefore.before).toEqual(observation.before);
  expect(observation.mainPid).toBe(await app.evaluate(() => process.pid)); expect(outputs).toContain(observation.destination);
  expect(authority.phase).toBe('deleting'); expect(authority.generation).not.toBe(generation);
  expect(authority.originGenerations).toEqual([{ captureId: capture.id, generation }]); expect(authority.mixedRecovery.sourceGeneration).toBe(generation);
  expect(authority.history).toEqual(acceptedLedger.sourceAuthority[capture.id].history);
  expect(authority.preservedWriting.every(plan => plan.sourceGeneration === generation && !plan.publication)).toBe(true);
  expect(authority.preservedWriting.filter(plan => plan.stageIdentity)).toHaveLength(1);
  expect(linkedPlan.stageIdentity).toEqual({ sha256: observation.before.stage.sha256, dev: observation.before.stage.dev, ino: observation.before.stage.ino, bytes: observation.before.stage.bytes });
  expect(path.join(root, 'vault', linkedPlan.stage)).toBe(observation.source);
  expect(observation.before.stage.ordinary).toBe(true); expect(observation.before.stage.nlink).toBe('1'); expect(observation.before.output).toBeNull();
  expect(afterAuthority).toEqual(authority);
  for (const value of [observation.after.stage, observation.after.output]) {
    expect(value.ordinary).toBe(true); expect(value.nlink).toBe('2');
    for (const field of ['sha256', 'dev', 'ino', 'bytes']) expect(value[field]).toBe(linkedPlan.stageIdentity[field]);
  }
  for (const snapshots of [observation.before.origins, observation.after.origins]) {
    expect(snapshots).toHaveLength(5);
    for (const [index, value] of snapshots.entries()) {
      const original = originBefore[portable(path.relative(base, origins[index]))];
      expect(value.ordinary).toBe(true); expect(value.nlink).toBe('1');
      for (const field of ['sha256', 'dev', 'ino', 'bytes']) expect(value[field]).toBe(original[field]);
    }
  }
  const child = app.process(), mainPid = observation.mainPid;
  const proof = { boundary: observation.boundary, mainPid, wrapperPid: child.pid, action: 'Electron app.exit(77)', nativeLinkReturned: true, allFiveOriginsPresentAtLink: true };
  const exited = new Promise(resolve => child.once('exit', (code, signal) => resolve({ code, signal })));
  const abrupt = app.evaluate(({ app: electronApp }) => electronApp.exit(77)).catch(error => { if (!/closed|disposed/i.test(error.message)) throw error; });
  proof.wrapperExit = await exited; await abrupt;
  await save(testInfo, 'mixed-native-link-main-exit.json', proof);
  await expect.poll(() => { try { process.kill(mainPid, 0); return 'alive'; } catch (error) { if (error.code === 'ESRCH') return 'exited'; throw error; } }).toBe('exited');
  proof.mainObservedExited = true; await save(testInfo, 'mixed-native-link-main-exit.json', proof); app = null;
  await launch();
  await expect.poll(async () => JSON.parse(await fs.readFile(ledgerFile, 'utf8')).sourceAuthority[capture.id].phase).toBe('deleted');
  const recovered = JSON.parse(await fs.readFile(ledgerFile, 'utf8')), completed = recovered.sourceAuthority[capture.id], observed = await observe(base);
  await save(testInfo, 'mixed-native-link-recovered.json', { observed, recovered, originalGeneration: generation, actualLinkedInode: observation.after.output });
  expect(completed.operationId).toBe(authority.operationId); expect(completed.generation).toBe(authority.generation);
  expect(completed.mixedRecovery).toEqual(authority.mixedRecovery); expect(completed.originGenerations).toEqual(authority.originGenerations); expect(completed.history).toEqual(authority.history);
  expect(completed.preservedWriting.map(plan => ({ ...plan, stageIdentity: undefined, publication: undefined }))).toEqual(authority.preservedWriting.map(plan => ({ ...plan, stageIdentity: undefined, publication: undefined })));
  expect(completed.preservedWriting.every(plan => plan.publication && plan.sourceGeneration === generation && plan.publicationOperationId === authority.operationId)).toBe(true);
  const recoveredLink = completed.preservedWriting.find(plan => plan.file === linkedPlan.file);
  expect(recoveredLink.stageIdentity).toEqual(linkedPlan.stageIdentity); expect(recoveredLink.publication).toEqual(linkedPlan.stageIdentity);
  for (const plan of completed.preservedWriting) {
    const value = observed[portable(path.relative(base, path.join(root, 'vault', plan.file)))];
    expect(value.ordinary).toBe(true); expect(value.nlink).toBe('1');
    for (const field of ['sha256', 'dev', 'ino', 'bytes']) expect(value[field]).toBe(plan.publication[field]);
    expect(await exists(path.join(root, 'vault', plan.stage))).toBe(false);
  }
  expect(await fs.readFile(path.join(base, 'Annotations', intent.annotationId + '.md'))).toEqual(Buffer.from(intent.annotation));
  const wholePlan = completed.preservedWriting.find(plan => plan.payloadKind === 'previous-whole-variant'), wholeBytes = await fs.readFile(path.join(root, 'vault', wholePlan.file));
  expect(wholeBytes.includes(fixture.wholeY)).toBe(true);
  const wholeHeader = YAML.parse(wholeBytes.toString('utf8').match(/^---\r?\n([\s\S]*?)\r?\n---/)[1]); expect(wholeHeader.source_generation).toBe(generation);
  expect(intent.annotation).not.toContain('source_generation:');
  for (const file of origins) expect(await exists(file)).toBe(false);
  expect(Object.keys(observed).filter(file => /^(Captures|Revisions)\//.test(file) || /^\.intake\/(?:repair-|conflict-|deletion-writing-)/.test(file))).toEqual([]);
  expect(Object.keys(observed).filter(file => file.startsWith('.intake/') && file.endsWith('.stage'))).toEqual([]);
  expect((await fs.readdir(path.join(base, 'Annotations'))).sort()).toEqual(completed.preservedWriting.map(plan => path.basename(plan.file)).sort());
  expect(recovered.attempts).toEqual(fixture.originalAcceptedLedger.attempts); expect(recovered.admissions).toEqual(acceptedLedger.admissions);
  expect(recovered.attempts[intent.tx.revision.identity]).toBeUndefined(); expect(recovered.admissions[intent.tx.revision.id]).toBeUndefined();
  expect(recovered.suppressed).toContain(sourceHash); expect(recovered.blocks[sourceHash]).toBeUndefined(); expect(recovered.pending[sourceHash]).toBeUndefined();
  expect(contents(await observe(path.join(root, 'producer')))).toEqual(producer);
  await expect(page.locator('#captures article')).toHaveCount(0);
});

test('mixed retention holds a missing receipted output before first native source unlink without republication', async ({}, testInfo) => {
  test.setTimeout(150000);
  const fixture = await heldMixedRepair(testInfo);
  const { base, ledgerFile, capture, sourceHash, intent, origins, producer } = fixture;
  const originalOrigins = await observe(base), beforeReview = contents(originalOrigins);
  await page.getByRole('button', { name: 'Delete capture', exact: true }).click();
  const preview = page.getByLabel('Capture deletion preview'); await expect(preview).toBeVisible();
  await preview.getByRole('button', { name: 'Cancel capture deletion', exact: true }).click();
  await expect(preview).toBeHidden(); expect(contents(await observe(base))).toEqual(beforeReview);
  await page.getByRole('button', { name: 'Delete capture', exact: true }).click();
  await expect(page.getByLabel('Capture deletion preview')).toBeVisible();
  const reviewed = await page.getByLabel('Capture deletion preview').textContent();
  expect(reviewed).toContain(intent.annotation); expect(reviewed).toContain(fixture.wholeY.toString('utf8'));
  for (const file of origins) expect(reviewed).toContain(portable(path.relative(path.join(root, 'vault'), file)));
  const reviewedPaths = [...new Set(reviewed.match(/Companion\/Annotations\/[a-f0-9-]{36}\.md/g) || [])]; expect(reviewedPaths).toHaveLength(2);
  const outputs = reviewedPaths.map(file => path.join(root, 'vault', file)), observerFile = testInfo.outputPath('mixed-before-native-source-unlink.json');
  await app.evaluate((_electron, options) => {
    const io = process.getBuiltinModule('fs').promises, paths = process.getBuiltinModule('path'), crypto = process.getBuiltinModule('crypto');
    const nativeUnlink = io.unlink, selected = new Set(options.origins.map(file => paths.resolve(file).toLowerCase()));
    const snapshot = async file => {
      try {
        const bytes = await io.readFile(file), stat = await io.lstat(file, { bigint: true });
        return { path: file, sha256: crypto.createHash('sha256').update(bytes).digest('hex'), dev: String(stat.dev), ino: String(stat.ino), bytes: String(stat.size), nlink: String(stat.nlink), ordinary: stat.isFile() && !stat.isSymbolicLink() };
      } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
    };
    io.unlink = async function (file, ...args) {
      if (typeof file !== 'string' || !selected.has(paths.resolve(file).toLowerCase())) return nativeUnlink.call(this, file, ...args);
      io.unlink = nativeUnlink;
      const ledger = JSON.parse(await io.readFile(options.ledgerFile, 'utf8')), authority = ledger.sourceAuthority[options.captureId];
      const observation = { boundary: 'before-native-unlink', requestedSource: file, mainPid: process.pid, nativeUnlinkDelegated: false, nativeUnlinkReturned: false, ledger,
        origins: await Promise.all(options.origins.map(snapshot)), outputs: await Promise.all(options.outputs.map(snapshot)),
        stages: await Promise.all(authority.preservedWriting.map(plan => snapshot(paths.join(options.vault, plan.stage)))) };
      await io.writeFile(options.observerFile, JSON.stringify(observation, null, 2), { flush: true });
      // No source unlink is delegated. Actual main exit ends this observation boundary.
      await new Promise(() => {});
    };
  }, { origins, outputs, ledgerFile, captureId: capture.id, vault: path.join(root, 'vault'), observerFile });
  await page.getByLabel('Capture deletion preview').getByRole('button', { name: 'Confirm capture deletion', exact: true }).click();
  await expect.poll(async () => {
    try { return JSON.parse(await fs.readFile(observerFile, 'utf8')).boundary; }
    catch (error) { if (error.code === 'ENOENT' || error instanceof SyntaxError) return ''; throw error; }
  }).toBe('before-native-unlink');
  const observation = JSON.parse(await fs.readFile(observerFile, 'utf8')), authority = observation.ledger.sourceAuthority[capture.id], paused = await observe(base);
  await save(testInfo, 'mixed-before-native-unlink-vault.json', { observation, observed: paused, originalOrigins });
  expect(observation.mainPid).toBe(await app.evaluate(() => process.pid)); expect(origins).toContain(observation.requestedSource);
  expect(observation.nativeUnlinkDelegated).toBe(false); expect(observation.nativeUnlinkReturned).toBe(false);
  expect(authority.phase).toBe('deleting'); expect(authority.preservedWriting).toHaveLength(2);
  expect(observation.stages).toEqual([null, null]);
  expect(authority.preservedWriting.map(plan => plan.file).sort()).toEqual([...reviewedPaths].sort());
  for (const plan of authority.preservedWriting) {
    const output = observation.outputs.find(value => value.path === path.join(root, 'vault', plan.file));
    expect(plan.publication).toEqual(plan.stageIdentity); expect(plan.publication).toBeDefined();
    expect(plan.publicationOperationId).toBe(authority.operationId);
    expect(output.ordinary).toBe(true); expect(output.nlink).toBe('1');
    for (const field of ['sha256', 'dev', 'ino', 'bytes']) expect(output[field]).toBe(plan.publication[field]);
  }
  expect(observation.origins).toHaveLength(5);
  for (const [index, value] of observation.origins.entries()) {
    const before = originalOrigins[portable(path.relative(base, origins[index]))];
    expect(value.ordinary).toBe(true); expect(value.nlink).toBe('1');
    for (const field of ['sha256', 'dev', 'ino', 'bytes']) expect(value[field]).toBe(before[field]);
  }
  const removedOutput = path.join(base, 'Annotations', intent.annotationId + '.md'), removedRelative = portable(path.relative(base, removedOutput));
  const otherOutput = outputs.find(file => file !== removedOutput), otherRelative = portable(path.relative(base, otherOutput));
  expect(outputs).toContain(removedOutput); expect(await fs.readFile(removedOutput)).toEqual(Buffer.from(intent.annotation));
  const lockPath = origins.find(file => portable(path.relative(base, file)).startsWith('Captures/')) + '.lock', lockRelative = portable(path.relative(base, lockPath));
  const ownedLock = paused[lockRelative]; expect(ownedLock.ordinary).toBe(true); expect(ownedLock.nlink).toBe('1');
  expect(JSON.parse(text(ownedLock))).toEqual({ pid: observation.mainPid });
  const child = app.process(), mainPid = observation.mainPid;
  const proof = { boundary: 'before-native-unlink', requestedSource: observation.requestedSource, mainPid, wrapperPid: child.pid, nativeUnlinkDelegated: false, nativeUnlinkReturned: false, action: 'Electron app.exit(77)', ownedLock: { file: lockPath, observation: ownedLock } };
  const exited = new Promise(resolve => child.once('exit', (code, signal) => resolve({ code, signal })));
  const abrupt = app.evaluate(({ app: electronApp }) => electronApp.exit(77)).catch(error => { if (!/closed|disposed/i.test(error.message)) throw error; });
  proof.wrapperExit = await exited; await abrupt; await save(testInfo, 'mixed-before-native-unlink-main-exit.json', proof);
  await expect.poll(() => { try { process.kill(mainPid, 0); return 'alive'; } catch (error) { if (error.code === 'ESRCH') return 'exited'; throw error; } }).toBe('exited');
  proof.mainObservedExited = true; await save(testInfo, 'mixed-before-native-unlink-main-exit.json', proof); app = null;
  const exitedVault = await observe(base);
  await save(testInfo, 'mixed-before-output-removal.json', { observed: exitedVault, authority, controlledRemoval: removedOutput });
  expect(exitedVault).toEqual(paused);
  // The only controlled offline change is removal of the already receipted X output.
  await fs.unlink(removedOutput);
  const offline = await observe(base), expectedOffline = { ...exitedVault }; delete expectedOffline[removedRelative];
  await save(testInfo, 'mixed-offline-output-removal.json', { observed: offline, removedOutput, removedIdentity: exitedVault[removedRelative], survivingOutput: otherOutput, controlledSourceOmissions: [] });
  expect(offline).toEqual(expectedOffline);
  await launch();
  await save(testInfo, 'mixed-missing-output-startup-observations.json', { observed: await observe(base), status: await page.getByRole('status').textContent(), authority });
  await expect(page.getByRole('status')).toContainText('publication is verify only');
  const restarted = await observe(base), restartedLedger = JSON.parse(text(restarted['.intake/ledger.json']));
  await save(testInfo, 'mixed-missing-output-held.json', { observed: restarted, restartedLedger, status: await page.getByRole('status').textContent() });
  // Only this exact lock may be cleaned after its recorded owner exited; all other paths stay exact.
  const compareHeld = value => {
    const expected = { ...offline }, actual = { ...value };
    if (actual[lockRelative]) expect(actual[lockRelative]).toEqual(ownedLock);
    else delete expected[lockRelative];
    expect(actual).toEqual(expected);
  };
  compareHeld(restarted);
  expect(restartedLedger.sourceAuthority[capture.id]).toEqual(authority);
  expect(await exists(removedOutput)).toBe(false); expect(restarted[otherRelative]).toEqual(paused[otherRelative]);
  for (const file of origins) expect(restarted[portable(path.relative(base, file))]).toEqual(originalOrigins[portable(path.relative(base, file))]);
  expect(restartedLedger.attempts).toEqual(fixture.acceptedLedger.attempts); expect(restartedLedger.admissions).toEqual(fixture.acceptedLedger.admissions);
  expect(restartedLedger.suppressed).toContain(sourceHash); expect(contents(await observe(path.join(root, 'producer')))).toEqual(producer);
  await page.getByRole('button', { name: 'Review capture deletion recovery', exact: true }).click();
  const recovery = page.getByLabel('Capture deletion recovery'); await expect(recovery).toBeVisible();
  await expect(recovery).toContainText(intent.annotationId); await expect(recovery).toContainText(portable(path.relative(path.join(root, 'vault'), removedOutput)));
  await expect(recovery).toContainText('publication is verify only');
  const resume = recovery.getByRole('button', { name: 'Resume confirmed capture deletion', exact: true }); await expect(resume).toBeEnabled();
  await resume.click(); await expect(page.getByRole('status')).toContainText('publication is verify only');
  const retried = await observe(base), retriedLedger = JSON.parse(text(retried['.intake/ledger.json']));
  await save(testInfo, 'mixed-missing-output-resume-held.json', { observed: retried, retriedLedger, status: await page.getByRole('status').textContent(), recovery: await recovery.textContent() });
  compareHeld(retried); expect(retriedLedger.sourceAuthority[capture.id]).toEqual(authority); expect(await exists(removedOutput)).toBe(false);
  expect(contents(await observe(path.join(root, 'producer')))).toEqual(producer);
});

test('mixed retention rejects a malformed title proof object before publication or source purge', async ({}, testInfo) => {
  test.setTimeout(150000);
  const fixture = await heldMixedRepair(testInfo), { base, ledgerFile, capture, origins, producer } = fixture;
  const originalOrigins = await observe(base);
  await page.getByRole('button', { name: 'Delete capture', exact: true }).click();
  await expect(page.getByLabel('Capture deletion preview')).toBeVisible();
  const reviewed = await page.getByLabel('Capture deletion preview').textContent();
  for (const file of origins) expect(reviewed).toContain(portable(path.relative(path.join(root, 'vault'), file)));
  const outputPaths = [...new Set(reviewed.match(/Companion\/Annotations\/[a-f0-9-]{36}\.md/g) || [])]; expect(outputPaths).toHaveLength(2);
  await fs.writeFile(path.join(root, 'faults.json'), JSON.stringify({ pause: 'capture-deletion-authorized' }));
  await page.getByLabel('Capture deletion preview').getByRole('button', { name: 'Confirm capture deletion', exact: true }).click();
  await expect.poll(() => fs.readFile(path.join(root, 'checkpoint.txt'), 'utf8')).toBe('capture-deletion-authorized');
  const authorizedBytes = await fs.readFile(ledgerFile), authorized = JSON.parse(authorizedBytes), authority = authorized.sourceAuthority[capture.id], paused = await observe(base);
  await save(testInfo, 'mixed-proof-schema-authorized.json', { observed: paused, authorized, reviewed, outputPaths, origins });
  expect(authority.phase).toBe('deleting'); expect(authority.titleProofs).toBeUndefined(); expect(authority.titleRecovery).toBeUndefined();
  expect(authority.preservedWriting.every(plan => !plan.stageIdentity && !plan.publication)).toBe(true);
  expect(await fs.readdir(path.join(base, 'Annotations'))).toEqual([]);
  for (const file of origins) expect(paused[portable(path.relative(base, file))]).toEqual(originalOrigins[portable(path.relative(base, file))]);
  const current = origins.find(file => portable(path.relative(base, file)).startsWith('Captures/'));
  const lockPath = current + '.lock', lockRelative = portable(path.relative(base, lockPath)), ownedLock = paused[lockRelative];
  const mainPid = await app.evaluate(() => process.pid);
  expect(ownedLock.ordinary).toBe(true); expect(ownedLock.nlink).toBe('1'); expect(JSON.parse(text(ownedLock))).toEqual({ pid: mainPid });
  const processProof = await exitMain(testInfo); await save(testInfo, 'mixed-proof-schema-main-exit.json', { ...processProof, ownedLock: { file: lockPath, observation: ownedLock } });
  const exited = await observe(base); expect(exited).toEqual(paused);
  const altered = JSON.parse(authorizedBytes);
  // One controlled authority-field corruption. The payload is the actual complete observed Y.
  altered.sourceAuthority[capture.id].titleProofs = { unreviewedSourceCopy: fixture.wholeY.toString('utf8') };
  const alteredBytes = Buffer.from(JSON.stringify(altered, null, 2)); await fs.writeFile(ledgerFile, alteredBytes, { flush: true });
  const corrupted = await observe(base), withoutAddedField = JSON.parse(alteredBytes); delete withoutAddedField.sourceAuthority[capture.id].titleProofs;
  await save(testInfo, 'mixed-proof-schema-corrupted.json', { observed: corrupted, altered, onlyControlledField: 'sourceAuthority.' + capture.id + '.titleProofs', origins, producer });
  expect(withoutAddedField).toEqual(authorized);
  const expectedCorrupted = { ...exited, '.intake/ledger.json': corrupted['.intake/ledger.json'] }; expect(corrupted).toEqual(expectedCorrupted);
  await fs.unlink(path.join(root, 'faults.json'));
  await launch();
  // Observe actual writer termination first: old code may fully delete rather than reject this field.
  let terminal;
  await expect.poll(async () => {
    const ledger = JSON.parse(await fs.readFile(ledgerFile, 'utf8')), status = await page.getByRole('status').textContent();
    const phase = ledger.sourceAuthority[capture.id].phase;
    terminal = { phase, status, reason: phase === 'deleted' ? 'actual deletion completed' : /unsupported mixed scope|Source authority needs repair|Source recovery inventory contains changed or unsupported writing/.test(status) ? 'startup schema rejection' : 'waiting' };
    return terminal.reason !== 'waiting';
  }).toBe(true);
  const actual = await observe(base), actualLedgerBytes = await fs.readFile(ledgerFile), actualLedger = JSON.parse(actualLedgerBytes);
  await save(testInfo, 'mixed-proof-schema-terminal.json', { terminal, observed: actual, actualLedger, altered, origins, outputPaths, processProof });
  // First feature assertion follows the saved actual terminal, not an assumed pre-writer state.
  expect(actualLedger.sourceAuthority[capture.id].phase).toBe('deleting');
  await expect(page.getByRole('status')).toContainText('unsupported mixed scope');
  expect(actualLedgerBytes).toEqual(alteredBytes); expect(actualLedger.sourceAuthority[capture.id]).toEqual(altered.sourceAuthority[capture.id]);
  const expectedHeld = { ...corrupted };
  if (actual[lockRelative]) expect(actual[lockRelative]).toEqual(ownedLock); else delete expectedHeld[lockRelative];
  expect(actual).toEqual(expectedHeld);
  for (const file of origins) expect(actual[portable(path.relative(base, file))]).toEqual(originalOrigins[portable(path.relative(base, file))]);
  expect(await fs.readdir(path.join(base, 'Annotations'))).toEqual([]);
  expect(Object.keys(actual).filter(file => file.startsWith('.intake/') && file.endsWith('.stage'))).toEqual([]);
  expect(actualLedger.attempts).toEqual(fixture.acceptedLedger.attempts); expect(actualLedger.admissions).toEqual(fixture.acceptedLedger.admissions);
  expect(contents(await observe(path.join(root, 'producer')))).toEqual(producer);
});
