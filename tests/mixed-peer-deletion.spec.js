const { test, expect, _electron: electron } = require('@playwright/test');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { createHash } = require('node:crypto');
let root, app, page, checks;
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const exists = file => fs.access(file).then(() => true, error => { if (error.code === 'ENOENT') return false; throw error; });
const portable = file => file.split(path.sep).join('/');

test.beforeEach(async () => { root = await fs.mkdtemp(path.join(os.tmpdir(), 'companion-mixed-peer-')); checks = 0; });
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

test('mixed deletion holds when an adjacent whole local recovery copy arrives after consent', async ({}, testInfo) => {
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
  const beforeConsent = await observe(base);
  await page.getByRole('button', { name: 'Delete capture', exact: true }).click();
  const preview = page.getByLabel('Capture deletion preview');
  await expect(preview).toBeVisible();
  const reviewed = await preview.textContent();
  expect(reviewed).toContain(repair.annotation); expect(reviewed).toContain(wholeY.toString('utf8'));
  for (const file of origins) expect(reviewed).toContain(portable(path.relative(path.join(root, 'vault'), file)));
  const outputPaths = [...new Set(reviewed.match(/Companion\/Annotations\/[a-f0-9-]{36}\.md/g) || [])];
  expect(outputPaths).toHaveLength(2);
  expect(contents(await observe(base))).toEqual(contents(beforeConsent));
  await fs.writeFile(path.join(root, 'faults.json'), JSON.stringify({ pause: 'capture-deletion-authorized' }));
  const confirm = preview.getByRole('button', { name: 'Confirm capture deletion', exact: true });
  await confirm.click();
  await expect.poll(() => fs.readFile(path.join(root, 'checkpoint.txt'), 'utf8')).toBe('capture-deletion-authorized');
  const authorizedFiles = await observe(base), committed = JSON.parse(text(authorizedFiles['.intake/ledger.json']));
  const authority = committed.sourceAuthority[capture.id];
  // The only outside mutation is a new ordinary copy of the actual current whole-Y buffer.
  const arriving = current + '.pending', arrivingRelative = portable(path.relative(base, arriving));
  expect(await exists(arriving)).toBe(false);
  const actualCurrent = await fs.readFile(current);
  await fs.writeFile(arriving, actualCurrent, { flag: 'wx' });
  const arrivedFiles = await observe(base), arrived = arrivedFiles[arrivingRelative];
  const producerAtArrival = await observe(path.join(root, 'producer'));
  const mainPid = await app.evaluate(() => process.pid);
  const ownedLock = current + '.lock', ownedLockRelative = portable(path.relative(base, ownedLock));
  const lockAtArrival = arrivedFiles[ownedLockRelative];
  const expectedAfterRelease = { ...arrivedFiles };
  // Confirm releases this exact acquired lock in its finally block, even on HOLD.
  delete expectedAfterRelease[ownedLockRelative];
  await save(testInfo, 'mixed-peer-authorized-arrival.json', {
    checkpoint: await fs.readFile(path.join(root, 'checkpoint.txt'), 'utf8'),
    mainPid, processProof, origins, reviewed, outputPaths,
    authorizedFiles, committed, arrivedFiles, producerAtArrival,
    ownedLock: { file: ownedLockRelative, observed: lockAtArrival }, expectedAfterRelease,
    controlledArrival: { file: arrivingRelative, copiedFrom: portable(path.relative(base, current)), ...arrived }
  });
  expect(lockAtArrival).toBeDefined();
  expect(lockAtArrival.ordinary).toBe(true); expect(lockAtArrival.nlink).toBe('1');
  expect(JSON.parse(text(lockAtArrival))).toEqual({ pid: mainPid });
  expect(authority.phase).toBe('deleting'); expect(authority.targets).toHaveLength(5);
  expect(authority.targets.map(value => value.file).sort()).toEqual(origins.map(file => portable(path.relative(path.join(root, 'vault'), file))).sort());
  for (const file of origins) {
    const relative = portable(path.relative(base, file));
    expect(authorizedFiles[relative]).toEqual(observed[relative]);
    expect(arrivedFiles[relative]).toEqual(observed[relative]);
  }
  expect(actualCurrent).toEqual(wholeY); expect(arrived.base64).toBe(wholeY.toString('base64'));
  expect(arrived.ordinary).toBe(true); expect(arrived.nlink).toBe('1');
  expect(new Set([...selected, arrived].map(file => `${file.dev}:${file.ino}`)).size).toBe(6);
  expect(contents(arrivedFiles)).toEqual({ ...contents(authorizedFiles), [arrivingRelative]: wholeY.toString('base64') });
  expect(await fs.readFile(ledgerFile, 'utf8')).toBe(text(authorizedFiles['.intake/ledger.json']));
  expect(await fs.readdir(path.join(base, 'Annotations'))).toEqual([]);
  expect(Object.keys(authorizedFiles).filter(file => file.startsWith('.intake/deletion-writing-'))).toEqual([]);
  expect(authority.preservedWriting.every(plan => !plan.stageIdentity && !plan.publication)).toBe(true);
  expect(committed.attempts).toEqual(acceptedLedger.attempts); expect(committed.admissions).toEqual(acceptedLedger.admissions);
  expect(contents(producerAtArrival)).toEqual(producer);
  await fs.writeFile(path.join(root, 'release.txt'), 'continue');
  // Accept either actual terminal result here, then save it before the expected HOLD assertion.
  await expect(page.getByRole('status')).toContainText(/Capture deleted\.|Capture deletion files changed or contain unreviewed writing\./);
  const terminal = {
    status: await page.getByRole('status').textContent(), observed: await observe(base),
    producer: await observe(path.join(root, 'producer')),
    checkpoint: await fs.readFile(path.join(root, 'checkpoint.txt'), 'utf8')
  };
  terminal.ledger = JSON.parse(text(terminal.observed['.intake/ledger.json']));
  await save(testInfo, 'mixed-peer-terminal-result.json', terminal);
  expect(terminal.status).toContain('Capture deletion files changed or contain unreviewed writing.');
  expect(terminal.status).toContain('preview the scope again');
  expect(terminal.ledger).toEqual(committed);
  expect(terminal.ledger.sourceAuthority[capture.id].phase).toBe('deleting');
  expect(await exists(ownedLock)).toBe(false);
  expect(terminal.observed).toEqual(expectedAfterRelease);
  expect(terminal.producer).toEqual(producerAtArrival);
  // A fresh public recovery inspection must still report the same unfinished scope.
  await page.getByRole('button', { name: 'Review capture deletion recovery', exact: true }).click();
  const recovery = page.getByLabel('Capture deletion recovery');
  await expect(recovery).toContainText(capture.id);
  await expect(recovery).toContainText('Capture deletion files changed or contain unreviewed writing.');
  await expect(recovery.getByRole('button', { name: 'Resume confirmed capture deletion', exact: true })).toBeEnabled();
  expect(await exists(ownedLock)).toBe(false);
  expect(await observe(base)).toEqual(expectedAfterRelease);
});
