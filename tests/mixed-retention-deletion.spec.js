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
