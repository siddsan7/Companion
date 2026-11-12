const { test, expect, _electron: electron } = require('@playwright/test');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { spawn } = require('node:child_process');
const { createHash } = require('node:crypto');
let root, app, page, handle;
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const exists = file => fs.access(file).then(() => true, error => { if (error.code === 'ENOENT') return false; throw error; });
async function files(folder, prefix = '') {
  const result = {};
  for (const entry of await fs.readdir(folder, { withFileTypes: true })) {
    const file = path.join(folder, entry.name), relative = prefix + entry.name;
    if (entry.isDirectory()) Object.assign(result, await files(file, relative + '/'));
    else result[relative] = (await fs.readFile(file)).toString('base64');
  }
  return result;
}
async function launch() {
  app = await electron.launch({ args: ['.'], env: { ...process.env, COMPANION_TEST_ROOT: root } });
  page = await app.firstWindow();
  await expect(page.locator('#timezone')).toContainText('America/Phoenix');
}
async function observeNativeRename(current, observerFile) {
  await app.evaluate((_electron, options) => {
    const io = process.getBuiltinModule('fs'), paths = process.getBuiltinModule('path'), originalRename = io.renameSync;
    io.renameSync = function (from, to, ...args) {
      try { return originalRename.call(this, from, to, ...args); }
      catch (error) {
        if (typeof from === 'string' && paths.resolve(from).toLowerCase() === paths.resolve(options.current).toLowerCase()) {
          io.renameSync = originalRename;
          io.writeFileSync(options.observerFile, JSON.stringify({ mainPid: process.pid, from, to, code: error.code, syscall: error.syscall, message: error.message, delegatedOriginal: true }));
        }
        throw error;
      }
    };
  }, { current, observerFile });
}
async function holdCurrent(file) {
  const release = path.join(root, 'native-handle-release');
  const script = '$ErrorActionPreference="Stop"; $stream=$null; try { $stream=[System.IO.File]::Open($env:COMPANION_LOCK_TARGET,[System.IO.FileMode]::Open,[System.IO.FileAccess]::Read,[System.IO.FileShare]::Read); [Console]::WriteLine("READY:"+$PID); while (-not [System.IO.File]::Exists($env:COMPANION_LOCK_RELEASE)) { Start-Sleep -Milliseconds 25 } } finally { if ($null -ne $stream) { $stream.Dispose(); [Console]::WriteLine("RELEASED:"+$PID) } }';
  const child = spawn('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, env: { ...process.env, COMPANION_LOCK_TARGET: file, COMPANION_LOCK_RELEASE: release }, stdio: ['ignore', 'pipe', 'pipe'] });
  const proof = { pid: child.pid, file, share: 'FileShare.Read', access: 'FileAccess.Read', windowsHide: true, noProfile: true, stdout: '', stderr: '' };
  child.stdout.on('data', data => { proof.stdout += data.toString(); });
  child.stderr.on('data', data => { proof.stderr += data.toString(); });
  let spawnError;
  child.on('error', error => { spawnError = error; });
  const exited = new Promise(resolve => child.once('close', (code, signal) => { proof.exit = { code, signal }; resolve(); }));
  const owned = { proof, async release() {
    await fs.writeFile(release, 'release');
    let timer;
    try { await Promise.race([exited, new Promise((_, reject) => { timer = setTimeout(() => reject(Error('Owned native handle did not exit after release')), 15000); })]); }
    finally { clearTimeout(timer); }
  } };
  handle = owned; // Register cleanup before readiness can fail.
  await expect.poll(() => { if (spawnError) throw spawnError; if (proof.exit) throw Error(JSON.stringify(proof)); return proof.stdout; }).toContain(`READY:${child.pid}`);
  return owned;
}
test.beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'companion-pending-selection-'));
  await fs.writeFile(path.join(root, 'clock.json'), JSON.stringify({ now: '2026-11-08T06:59:00Z', timezone: 'America/Phoenix' }));
});
test.afterEach(async () => {
  try { if (handle) await handle.release(); }
  finally { handle = null; try { if (app) await app.close(); } finally { app = null; await fs.rm(root, { recursive: true, force: true }); } }
});

test('deferred reviewed Make current can be deleted before Check now without committing its selection', async ({}, testInfo) => {
  test.skip(process.platform !== 'win32', 'Requires a real Windows FileShare.Read handle that denies native rename/delete.');
  test.setTimeout(150000);
  const producer = path.join(root, 'producer');
  await fs.cp(path.join(__dirname, 'fixtures/reel-review/accept'), path.join(producer, 'accept'), { recursive: true });
  await launch();
  await page.getByRole('button', { name: 'Choose vault', exact: true }).click();
  await page.getByRole('button', { name: 'Use this folder', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('Vault ready.');
  await expect(page.locator('#idea-support-status')).toContainText('Current support inspected.');
  await page.getByLabel('Finalized review folder', { exact: true }).fill(producer);
  await page.getByRole('button', { name: 'Connect finalized reviews', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('Source connected');
  let checks = 0;
  const check = async (status = 'complete') => {
    const instant = new Date(Date.parse('2026-11-08T06:59:00Z') + ++checks * 1000).toISOString();
    await fs.writeFile(path.join(root, 'clock.json'), JSON.stringify({ now: instant, timezone: 'America/Phoenix' }));
    await page.getByRole('button', { name: 'Check now', exact: true }).click();
    await expect(page.locator('#intake-state')).toContainText(`Last check: ${instant} · manual · ${status}`);
    return instant;
  };
  await check();
  const sourceHash = 'a'.repeat(64), base = path.join(root, 'vault', 'Companion'), intake = path.join(base, '.intake'), ledgerFile = path.join(intake, 'ledger.json');
  const original = JSON.parse(await fs.readFile(ledgerFile)), capture = original.captures[sourceHash], current = path.join(base, 'Captures', capture.file);
  const currentA = await fs.readFile(current), snapshotA = path.join(base, 'Revisions', capture.currentRevision + '.json'), bytesA = await fs.readFile(snapshotA);
  await fs.cp(path.join(__dirname, 'fixtures/reel-review/edit'), path.join(producer, 'edit'), { recursive: true });
  const producerBytes = await files(producer); await check();
  const retained = JSON.parse(await fs.readFile(ledgerFile)), retainedCapture = retained.captures[sourceHash];
  expect(retainedCapture.currentRevision).toBe(capture.currentRevision); expect(retainedCapture.revisions).toHaveLength(2);
  const revisionB = retainedCapture.revisions.find(id => id !== capture.currentRevision), snapshotB = path.join(base, 'Revisions', revisionB + '.json'), bytesB = await fs.readFile(snapshotB), reviewedB = JSON.parse(bytesB);
  expect(JSON.parse(bytesA).review.decision).toBe('accept'); expect(reviewedB.review.decision).toBe('edit');
  expect(retained.attempts[reviewedB.identity].fingerprint).toBe(reviewedB.fingerprint);
  expect(retainedCapture.reviewChoices).toEqual([capture.currentRevision, revisionB]);
  const observerFile = path.join(root, 'native-rename.json');
  await observeNativeRename(current, observerFile);
  const native = await holdCurrent(current);
  let deferred, pendingBytes, tx, writerStatus, heldCurrent;
  try {
    await page.getByRole('button', { name: 'Inspect source', exact: true }).click();
    await page.getByLabel('Source inspection').locator('article').filter({ hasText: 'Human review: edit' }).getByRole('button', { name: 'Make current', exact: true }).click();
    await expect(page.getByRole('status')).toContainText('Capture destination is locked or inaccessible');
    writerStatus = await page.getByRole('status').textContent();
    deferred = JSON.parse(await fs.readFile(ledgerFile));
    pendingBytes = await fs.readFile(path.join(intake, deferred.pending[sourceHash].journal)); tx = JSON.parse(pendingBytes);
    heldCurrent = await fs.readFile(current);
  } finally { await native.release(); handle = null; }
  await app.close(); app = null; await launch();
  await expect(page.locator('#idea-support-status')).toContainText('Current support inspected.');
  await expect(page.locator('#captures article')).toHaveCount(1);
  const restartedBytes = await fs.readFile(ledgerFile), restarted = JSON.parse(restartedBytes), pending = restarted.pending[sourceHash];
  // Enumerate actual writer copies, including any older legitimate copy. Never synthesize a stage or backup.
  const all = await files(base), names = Object.keys(all).filter(name => /^(Captures\/|Revisions\/|\.intake\/)/.test(name) && name !== '.intake/ledger.json').sort();
  const observations = [];
  for (const name of names) {
    const file = path.join(base, name), bytes = await fs.readFile(file), stat = await fs.lstat(file, { bigint: true });
    observations.push({ file: name, bytesBase64: bytes.toString('base64'), sha256: sha(bytes), ordinary: stat.isFile() && !stat.isSymbolicLink(), dev: String(stat.dev), ino: String(stat.ino), nlink: String(stat.nlink) });
  }
  const nativeRename = JSON.parse(await fs.readFile(observerFile));
  await fs.writeFile(testInfo.outputPath('pending-selection-writer-observation.json'), JSON.stringify({ writerStatus, nativeHandle: native.proof, nativeRename, expectedSixLeavesIsHypothesis: true, actualLeafCount: observations.length, observations, originalCurrentBase64: currentA.toString('base64'), heldCurrentBase64: heldCurrent.toString('base64'), heldCurrentSha256: sha(heldCurrent), pendingJournalBase64: pendingBytes.toString('base64'), producerBytes, producerSha256: sha(JSON.stringify(producerBytes)), retainedLedger: retained, deferredLedger: deferred, restartedLedger: restarted, restartedLedgerSha256: sha(restartedBytes), branch: pending ? 'pending-after-normal-restart' : 'completed-during-normal-restart' }, null, 2));
  // Evidence above precedes family/count and deletion assertions, including an unexpected writer layout.
  expect(nativeRename.delegatedOriginal).toBe(true); expect(['EACCES', 'EPERM', 'EBUSY']).toContain(nativeRename.code);
  expect(nativeRename.from).toBe(current); expect(native.proof.exit).toEqual({ code: 0, signal: null });
  expect(native.proof.stdout).toContain(`RELEASED:${native.proof.pid}`);
  expect(heldCurrent).toEqual(currentA);
  expect(deferred.captures[sourceHash]).toEqual(retainedCapture); expect(deferred.attempts).toEqual(retained.attempts); expect(deferred.admissions).toEqual(retained.admissions);
  expect(tx.revision).toEqual(reviewedB); expect(tx.previous).toBe(currentA.toString()); expect(tx.capture.currentRevision).toBe(revisionB);
  expect(tx.capture.selectionHistory).toEqual([...(retainedCapture.selectionHistory || []), { revision: revisionB, selectedAt: '2026-11-08T06:59:02.000Z' }]);
  expect(deferred.pending[sourceHash].key).toBe(tx.key);
  expect(deferred.outcomes[tx.key]).toEqual({ status: 'held', reason: deferred.pending[sourceHash].reason, locator: reviewedB.locator, sourceHash, pendingRevision: revisionB });
  expect(await fs.readFile(snapshotA)).toEqual(bytesA); expect(await fs.readFile(snapshotB)).toEqual(bytesB); expect(await files(producer)).toEqual(producerBytes);
  for (const observation of observations) expect(observation.ordinary).toBe(true);
  if (pending) {
    expect(await fs.readFile(current)).toEqual(currentA); expect(restarted.captures[sourceHash]).toEqual(retainedCapture);
    expect(await fs.readFile(path.join(intake, pending.journal))).toEqual(pendingBytes);
    expect(pending).toEqual(deferred.pending[sourceHash]); expect(await exists(path.join(intake, 'transaction.json'))).toBe(false);
  } else {
    expect(restarted.captures[sourceHash].currentRevision).toBe(revisionB);
    expect(restarted.captures[sourceHash].selectionHistory).toEqual(tx.capture.selectionHistory);
  }
  const history = restarted.captures[sourceHash].selectionHistory, relative = name => 'Companion/' + name, targets = names.map(relative), before = await files(base);
  // Rendered entry point is the acceptance seam; raw bridge gives exact, independently inspectable scope.
  await page.getByRole('button', { name: 'Delete capture', exact: true }).click();
  const preview = page.getByLabel('Capture deletion preview');
  // Preserve the precise UI/bridge HOLD before the acceptance assertion can fail.
  const rawResult = await page.evaluate(async id => {
    try { const value = await window.captureDeletion.preview({ id }); await window.captureDeletion.cancel({ token: value.token }); return { value }; }
    catch (error) { return { error: error.message }; }
  }, capture.id);
  await fs.writeFile(testInfo.outputPath('pending-selection-deletion-preview.json'), JSON.stringify({ renderedVisible: await preview.isVisible(), renderedStatus: await page.getByRole('status').textContent(), renderedPreview: await preview.textContent(), rawResult, expectedTargets: targets }, null, 2));
  await expect(preview).toBeVisible();
  expect((await preview.locator('p').filter({ hasText: /^Remove: / }).allTextContents()).sort()).toEqual(targets.map(file => 'Remove: ' + file).sort());
  expect(rawResult.error).toBeUndefined(); expect(rawResult.value.targets.sort()).toEqual(targets.sort());
  expect(await files(base)).toEqual(before);
  await preview.getByRole('button', { name: 'Cancel capture deletion', exact: true }).click();
  await expect(preview).toBeHidden(); expect(await files(base)).toEqual(before);
  await expect(page.locator('#captures article')).toHaveCount(1);
  await page.getByRole('button', { name: 'Delete capture', exact: true }).click();
  const freshPreview = page.getByLabel('Capture deletion preview'); await expect(freshPreview).toBeVisible();
  await freshPreview.getByRole('button', { name: 'Confirm capture deletion', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('Capture deleted');
  const deleted = JSON.parse(await fs.readFile(ledgerFile)), authority = deleted.sourceAuthority[capture.id];
  expect(authority.phase).toBe('deleted'); expect(authority.targets.map(item => item.file).sort()).toEqual(targets.sort());
  expect(deleted.attempts).toEqual(retained.attempts); expect(deleted.admissions).toEqual(retained.admissions);
  expect(deleted.captures[sourceHash].selectionHistory).toEqual(history); expect(deleted.captures[sourceHash].currentRevision).toBe(restarted.captures[sourceHash].currentRevision);
  expect(deleted.pending[sourceHash]).toBeUndefined(); expect(deleted.blocks[sourceHash]).toBeUndefined(); expect(deleted.suppressed).toContain(sourceHash);
  for (const name of names) expect(await exists(path.join(base, name))).toBe(false);
  const checkedAt = await check('held'), checked = JSON.parse(await fs.readFile(ledgerFile));
  expect(checked.lastCheck).toEqual({ at: checkedAt, trigger: 'manual', status: 'held' });
  expect(Object.values(checked.outcomes)).toHaveLength(2);
  expect(Object.values(checked.outcomes).map(item => item.locator).sort()).toEqual([path.join(producer, 'accept'), path.join(producer, 'edit')].sort());
  for (const outcome of Object.values(checked.outcomes)) { expect(outcome.status).toBe('held'); expect(outcome.checkedAt).toBe(checkedAt); expect(outcome.reason).toBe('Automatic re-import is suppressed. Restore this source explicitly before intake.'); }
  await app.close(); app = null; await launch(); await expect(page.locator('#idea-support-status')).toContainText('Current support inspected.'); await expect(page.locator('#captures article')).toHaveCount(0);
  const final = JSON.parse(await fs.readFile(ledgerFile));
  expect(final.sourceAuthority[capture.id]).toEqual(authority); expect(final.attempts).toEqual(retained.attempts); expect(final.admissions).toEqual(retained.admissions);
  expect(final.captures[sourceHash].selectionHistory).toEqual(history); expect(final.suppressed).toContain(sourceHash);
  for (const name of names) expect(await exists(path.join(base, name))).toBe(false);
  expect(await files(producer)).toEqual(producerBytes);
});

test('pending reviewed selection deletion holds a contradictory prospective history without changing any retained file', async ({}, testInfo) => {
  test.skip(process.platform !== 'win32', 'Requires a real Windows FileShare.Read handle that denies native rename/delete.');
  test.setTimeout(150000);
  const producer = path.join(root, 'producer');
  await fs.cp(path.join(__dirname, 'fixtures/reel-review/accept'), path.join(producer, 'accept'), { recursive: true });
  await launch();
  await page.getByRole('button', { name: 'Choose vault', exact: true }).click();
  await page.getByRole('button', { name: 'Use this folder', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('Vault ready.');
  await expect(page.locator('#idea-support-status')).toContainText('Current support inspected.');
  await page.getByLabel('Finalized review folder', { exact: true }).fill(producer);
  await page.getByRole('button', { name: 'Connect finalized reviews', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('Source connected');
  for (let index = 1; index <= 2; index++) {
    if (index === 2) await fs.cp(path.join(__dirname, 'fixtures/reel-review/edit'), path.join(producer, 'edit'), { recursive: true });
    const instant = `2026-11-08T06:59:0${index}.000Z`;
    await fs.writeFile(path.join(root, 'clock.json'), JSON.stringify({ now: instant, timezone: 'America/Phoenix' }));
    await page.getByRole('button', { name: 'Check now', exact: true }).click();
    await expect(page.locator('#intake-state')).toContainText(`Last check: ${instant} · manual · complete`);
  }
  const sourceHash = 'a'.repeat(64), base = path.join(root, 'vault', 'Companion'), intake = path.join(base, '.intake'), ledgerFile = path.join(intake, 'ledger.json');
  const retained = JSON.parse(await fs.readFile(ledgerFile)), capture = retained.captures[sourceHash], current = path.join(base, 'Captures', capture.file), currentA = await fs.readFile(current);
  const producerBytes = await files(producer), revisionB = capture.revisions.find(id => id !== capture.currentRevision), observerFile = path.join(root, 'guard-native-rename.json');
  await observeNativeRename(current, observerFile);
  const native = await holdCurrent(current);
  try {
    await page.getByRole('button', { name: 'Inspect source', exact: true }).click();
    await page.getByLabel('Source inspection').locator('article').filter({ hasText: 'Human review: edit' }).getByRole('button', { name: 'Make current', exact: true }).click();
    await expect(page.getByRole('status')).toContainText('Capture destination is locked or inaccessible');
  } finally { await native.release(); handle = null; }
  await app.close(); app = null; await launch();
  await expect(page.locator('#idea-support-status')).toContainText('Current support inspected.');
  await expect(page.locator('#captures article')).toHaveCount(1);
  const ledgerBytes = await fs.readFile(ledgerFile), pendingLedger = JSON.parse(ledgerBytes), journal = path.join(intake, pendingLedger.pending[sourceHash].journal), originalJournal = await fs.readFile(journal), tx = JSON.parse(originalJournal);
  await app.close(); app = null;
  const before = await files(base), altered = JSON.parse(originalJournal);
  // The sole controlled edit changes B to already admitted A in the uncommitted history.
  altered.capture.selectionHistory.at(-1).revision = capture.currentRevision;
  const alteredBytes = Buffer.from(JSON.stringify(altered));
  await fs.writeFile(journal, alteredBytes);
  const names = Object.keys(before).filter(name => /^(Captures\/|Revisions\/|\.intake\/)/.test(name) && name !== '.intake/ledger.json').sort();
  const observe = async () => Promise.all(names.map(async name => {
    const file = path.join(base, name), bytes = await fs.readFile(file), stat = await fs.lstat(file, { bigint: true });
    return { file: name, bytesBase64: bytes.toString('base64'), sha256: sha(bytes), ordinary: stat.isFile() && !stat.isSymbolicLink(), dev: String(stat.dev), ino: String(stat.ino), nlink: String(stat.nlink) };
  }));
  const observations = await observe(), edited = await files(base), nativeRename = JSON.parse(await fs.readFile(observerFile));
  await fs.writeFile(testInfo.outputPath('pending-selection-history-guard-observation.json'), JSON.stringify({ description: 'Actual native deferred Make current and normal pending restart; then one controlled prospective history revision edit while main was closed.', nativeHandle: native.proof, nativeRename, sourceHash, currentRevisionA: capture.currentRevision, selectedRevisionB: revisionB, originalJournalBase64: originalJournal.toString('base64'), alteredJournalBase64: alteredBytes.toString('base64'), ledgerBase64: ledgerBytes.toString('base64'), pendingLedger, producerBytes, observations }, null, 2));
  // All actual file/native facts are recorded before the guard's feature assertions.
  expect(names).toHaveLength(5); expect(nativeRename.delegatedOriginal).toBe(true); expect(['EACCES', 'EPERM', 'EBUSY']).toContain(nativeRename.code);
  expect(native.proof.exit).toEqual({ code: 0, signal: null }); expect(native.proof.stdout).toContain(`RELEASED:${native.proof.pid}`);
  expect(pendingLedger.captures[sourceHash]).toEqual(capture); expect(pendingLedger.attempts).toEqual(retained.attempts); expect(pendingLedger.admissions).toEqual(retained.admissions);
  expect(tx.capture.currentRevision).toBe(revisionB); expect(tx.capture.selectionHistory.at(-1).revision).toBe(revisionB); expect(tx.previous).toBe(currentA.toString());
  const restored = JSON.parse(alteredBytes); restored.capture.selectionHistory.at(-1).revision = revisionB;
  expect(restored).toEqual(tx); expect(altered.capture.currentRevision).toBe(revisionB);
  for (const [name, bytes] of Object.entries(before)) if (name !== path.relative(base, journal).split(path.sep).join('/')) expect(edited[name]).toBe(bytes);
  expect(await fs.readFile(ledgerFile)).toEqual(ledgerBytes); expect(await fs.readFile(current)).toEqual(currentA);
  for (const item of observations) { expect(item.ordinary).toBe(true); expect(item.nlink).toBe('1'); }
  expect(new Set(observations.map(item => item.dev + ':' + item.ino)).size).toBe(5);
  const snapshotB = path.join(base, 'Revisions', revisionB + '.json'), stageB = path.join(intake, revisionB + '.snapshot.stage');
  expect(await fs.readFile(stageB)).toEqual(await fs.readFile(snapshotB));
  await launch(); await expect(page.locator('#idea-support-status')).toContainText('Current support inspected.');
  await expect(page.locator('#captures article')).toHaveCount(1);
  await page.getByRole('button', { name: 'Delete capture', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('Source recovery inventory');
  const raw = await page.evaluate(async id => { try { const value = await window.captureDeletion.preview({ id }); await window.captureDeletion.cancel({ token: value.token }); return { value }; } catch (error) { return { error: error.message }; } }, capture.id);
  await fs.writeFile(testInfo.outputPath('pending-selection-history-guard-preview.json'), JSON.stringify({ renderedStatus: await page.getByRole('status').textContent(), renderedVisible: await page.getByLabel('Capture deletion preview').isVisible(), raw, observationsAfter: await observe() }, null, 2));
  await expect(page.getByLabel('Capture deletion preview')).toBeHidden(); expect(raw.error).toContain('Source recovery inventory');
  expect(await files(base)).toEqual(edited); expect(await observe()).toEqual(observations);
  expect(await fs.readFile(journal)).toEqual(alteredBytes); expect(await fs.readFile(ledgerFile)).toEqual(ledgerBytes);
  const held = JSON.parse(await fs.readFile(ledgerFile));
  expect(held.sourceAuthority).toBeUndefined(); expect(held.suppressed).not.toContain(sourceHash);
  expect(held.pending).toEqual(pendingLedger.pending); expect(held.captures).toEqual(pendingLedger.captures);
  expect(held.attempts).toEqual(retained.attempts); expect(held.admissions).toEqual(retained.admissions); expect(await files(producer)).toEqual(producerBytes);
});

test('restored-generation pending selection deletion resumes after the first native unlink without committing selection', async ({}, testInfo) => {
  test.skip(process.platform !== 'win32', 'Requires a real Windows FileShare.Read handle that denies native rename/delete.');
  test.setTimeout(180000);
  const producer = path.join(root, 'producer');
  await fs.cp(path.join(__dirname, 'fixtures/reel-review/accept'), path.join(producer, 'accept'), { recursive: true });
  await launch();
  await page.getByRole('button', { name: 'Choose vault', exact: true }).click();
  await page.getByRole('button', { name: 'Use this folder', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('Vault ready.');
  await expect(page.locator('#idea-support-status')).toContainText('Current support inspected.');
  await page.getByLabel('Finalized review folder', { exact: true }).fill(producer);
  await page.getByRole('button', { name: 'Connect finalized reviews', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('Source connected');
  let checks = 0;
  const check = async (status = 'complete') => {
    const instant = new Date(Date.parse('2026-11-08T06:59:00Z') + ++checks * 1000).toISOString();
    await fs.writeFile(path.join(root, 'clock.json'), JSON.stringify({ now: instant, timezone: 'America/Phoenix' }));
    await page.getByRole('button', { name: 'Check now', exact: true }).click();
    await expect(page.locator('#intake-state')).toContainText(`Last check: ${instant} · manual · ${status}`);
    return instant;
  };
  await check();
  const sourceHash = 'a'.repeat(64), base = path.join(root, 'vault', 'Companion'), intake = path.join(base, '.intake'), ledgerFile = path.join(intake, 'ledger.json');
  const seed = JSON.parse(await fs.readFile(ledgerFile)), id = seed.captures[sourceHash].id;
  await page.getByRole('button', { name: 'Delete capture', exact: true }).click();
  await page.getByRole('button', { name: 'Confirm capture deletion', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('Capture deleted');
  const seedDeleted = JSON.parse(await fs.readFile(ledgerFile));
  for (const target of seedDeleted.sourceAuthority[id].targets) expect(await exists(path.join(root, 'vault', target.file))).toBe(false);
  await page.getByRole('button', { name: 'Review suppressed captures', exact: true }).click();
  const restoration = page.getByLabel('Source restoration');
  await restoration.getByLabel('Selected producer artifact folder', { exact: true }).fill(path.join(producer, 'accept'));
  await restoration.getByRole('combobox', { name: /^Selected producer artifact kind/ }).selectOption('review');
  await restoration.getByRole('button', { name: 'Preview source restoration', exact: true }).click();
  await restoration.getByRole('button', { name: 'Confirm source restoration', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('Source restored');
  await expect(page.locator('#captures article')).toHaveCount(1);
  const restored = JSON.parse(await fs.readFile(ledgerFile)), generation = restored.sourceAuthority[id].generation;
  await fs.cp(path.join(__dirname, 'fixtures/reel-review/edit'), path.join(producer, 'edit'), { recursive: true });
  const producerBytes = await files(producer); await check();
  const retained = JSON.parse(await fs.readFile(ledgerFile)), capture = retained.captures[sourceHash], current = path.join(base, 'Captures', capture.file), currentA = await fs.readFile(current);
  const revisionB = capture.revisions.find(revision => revision !== capture.currentRevision), snapshotB = path.join(base, 'Revisions', revisionB + '.json'), stageB = path.join(intake, revisionB + '.snapshot.stage');
  const renameFile = path.join(root, 'generation-native-rename.json');
  await observeNativeRename(current, renameFile);
  const native = await holdCurrent(current);
  try {
    await page.getByRole('button', { name: 'Inspect source', exact: true }).click();
    await page.getByLabel('Source inspection').locator('article').filter({ hasText: 'Human review: edit' }).getByRole('button', { name: 'Make current', exact: true }).click();
    await expect(page.getByRole('status')).toContainText('Capture destination is locked or inaccessible');
  } finally { await native.release(); handle = null; }
  await app.close(); app = null; await launch();
  await expect(page.locator('#idea-support-status')).toContainText('Current support inspected.');
  await expect(page.locator('#captures article')).toHaveCount(1);
  const pendingBytes = await fs.readFile(ledgerFile), pending = JSON.parse(pendingBytes), journalBytes = await fs.readFile(path.join(intake, pending.pending[sourceHash].journal)), tx = JSON.parse(journalBytes);
  const all = await files(base), names = Object.keys(all).filter(name => /^(Captures\/|Revisions\/|\.intake\/)/.test(name) && name !== '.intake/ledger.json').sort();
  const observe = async selected => Promise.all(selected.map(async name => {
    const file = path.join(base, name), bytes = await fs.readFile(file), stat = await fs.lstat(file, { bigint: true });
    return { file: name, bytesBase64: bytes.toString('base64'), sha256: sha(bytes), ordinary: stat.isFile() && !stat.isSymbolicLink(), dev: String(stat.dev), ino: String(stat.ino), nlink: String(stat.nlink) };
  }));
  const observations = await observe(names), nativeRename = JSON.parse(await fs.readFile(renameFile));
  await fs.writeFile(testInfo.outputPath('pending-selection-generation-writer.json'), JSON.stringify({ seed, seedDeleted, restored, generation, retained, pending, pendingLedgerBase64: pendingBytes.toString('base64'), journalBase64: journalBytes.toString('base64'), nativeHandle: native.proof, nativeRename, producerBytes, observations }, null, 2));
  expect(names).toHaveLength(5); expect(nativeRename.delegatedOriginal).toBe(true); expect(['EACCES', 'EPERM', 'EBUSY']).toContain(nativeRename.code); expect(native.proof.exit).toEqual({ code: 0, signal: null });
  expect(native.proof.stdout).toContain(`RELEASED:${native.proof.pid}`);
  expect(restored.sourceAuthority[id].phase).toBe('active'); expect(generation).not.toBe(seedDeleted.sourceAuthority[id].generation);
  expect(restored.attempts).toEqual(seed.attempts); expect(capture.currentRevision).not.toBe(seed.captures[sourceHash].currentRevision);
  expect(retained.sourceAuthority[id].history).toEqual(restored.sourceAuthority[id].history); expect(restored.sourceAuthority[id].history).toEqual([seedDeleted.sourceAuthority[id]]);
  expect(Object.values(retained.admissions)).toHaveLength(2);
  for (const admission of Object.values(retained.admissions)) expect(admission.sourceGeneration).toBe(generation);
  for (const [identity, accepted] of Object.entries(seed.attempts)) expect(retained.attempts[identity]).toEqual(accepted);
  expect(pending.attempts).toEqual(retained.attempts); expect(pending.admissions).toEqual(retained.admissions); expect(pending.captures[sourceHash]).toEqual(capture);
  expect(tx.sourceGeneration).toBe(generation); expect(tx.capture.currentRevision).toBe(revisionB); expect(tx.capture.selectionHistory.at(-1).revision).toBe(revisionB); expect(await fs.readFile(current)).toEqual(currentA);
  expect(await fs.readFile(stageB)).toEqual(await fs.readFile(snapshotB));
  const targets = names.map(name => 'Companion/' + name), before = await files(base);
  await page.getByRole('button', { name: 'Delete capture', exact: true }).click();
  const preview = page.getByLabel('Capture deletion preview'); await expect(preview).toBeVisible();
  expect((await preview.locator('p').filter({ hasText: /^Remove: / }).allTextContents()).sort()).toEqual(targets.map(file => 'Remove: ' + file).sort());
  const raw = await page.evaluate(async captureId => { const value = await window.captureDeletion.preview({ id: captureId }); await window.captureDeletion.cancel({ token: value.token }); return value; }, id);
  expect(raw.targets.sort()).toEqual(targets.sort());
  await preview.getByRole('button', { name: 'Cancel capture deletion', exact: true }).click(); await expect(preview).toBeHidden(); expect(await files(base)).toEqual(before);
  await page.getByRole('button', { name: 'Delete capture', exact: true }).click();
  const freshPreview = page.getByLabel('Capture deletion preview'); await expect(freshPreview).toBeVisible();
  const first = path.join(base, names[0]), unlinkFile = path.join(root, 'generation-native-first-unlink.json'), mainPid = await app.evaluate(() => process.pid);
  // Observe the original unlink. The existing checkpoint pauses immediately after it.
  await app.evaluate((_electron, options) => {
    const io = process.getBuiltinModule('fs'), paths = process.getBuiltinModule('path'), originalUnlink = io.unlinkSync;
    io.unlinkSync = function (file, ...args) {
      const result = originalUnlink.call(this, file, ...args);
      if (typeof file === 'string' && paths.resolve(file).toLowerCase() === paths.resolve(options.first).toLowerCase()) {
        io.unlinkSync = originalUnlink;
        io.writeFileSync(options.unlinkFile, JSON.stringify({ mainPid: process.pid, file, delegatedOriginal: true, nativeUnlinkReturned: true, controlledSourceOmissions: [] }));
      }
      return result;
    };
  }, { first, unlinkFile });
  await fs.writeFile(path.join(root, 'faults.json'), JSON.stringify({ pause: 'capture-deletion-unlinked' }));
  await freshPreview.getByRole('button', { name: 'Confirm capture deletion', exact: true }).click();
  await expect.poll(() => fs.readFile(path.join(root, 'checkpoint.txt'), 'utf8').catch(error => { if (error.code === 'ENOENT') return ''; throw error; })).toBe('capture-deletion-unlinked');
  const committedBytes = await fs.readFile(ledgerFile), committed = JSON.parse(committedBytes), authority = committed.sourceAuthority[id], unlink = JSON.parse(await fs.readFile(unlinkFile));
  const survivors = names.slice(1), survivorObservations = await observe(survivors), lockFile = current + '.lock', lockBytes = await fs.readFile(lockFile), lockOwner = JSON.parse(lockBytes);
  await fs.writeFile(testInfo.outputPath('pending-selection-generation-first-unlink.json'), JSON.stringify({ mainPid, unlink, originalGeneration: generation, deletingGeneration: authority.generation, committedLedgerBase64: committedBytes.toString('base64'), authority, removed: names[0], survivorObservations, ownedCaptureLock: { file: lockFile, bytesBase64: lockBytes.toString('base64'), owner: lockOwner } }, null, 2));
  expect(first).toBe(stageB); expect(unlink).toEqual({ mainPid, file: first, delegatedOriginal: true, nativeUnlinkReturned: true, controlledSourceOmissions: [] });
  expect(await exists(first)).toBe(false); expect(survivorObservations).toEqual(observations.slice(1)); expect(survivors).toHaveLength(4);
  expect(await fs.readFile(snapshotB)).toEqual(Buffer.from(observations.find(item => path.join(base, item.file) === snapshotB).bytesBase64, 'base64'));
  expect(authority.phase).toBe('deleting'); expect(authority.generation).not.toBe(generation); expect(authority.originGenerations).toEqual([{ captureId: id, generation }]);
  expect(authority.history).toEqual(restored.sourceAuthority[id].history); expect(authority.targets.map(item => item.file).sort()).toEqual(targets.sort());
  for (const descriptor of authority.recovery) expect(descriptor.sourceGeneration).toBe(generation);
  const stageDescriptor = authority.recovery.find(item => item.file === 'Companion/' + names[0]), snapshotDescriptor = authority.recovery.find(item => item.file === 'Companion/Revisions/' + revisionB + '.json');
  expect(stageDescriptor.format).toBe('snapshot-stage'); expect(snapshotDescriptor.format).toBe('incoming-snapshot'); expect(stageDescriptor.transaction).toBe(snapshotDescriptor.transaction);
  expect(committed.attempts).toEqual(retained.attempts); expect(committed.admissions).toEqual(retained.admissions); expect(committed.captures[sourceHash].selectionHistory).toEqual(capture.selectionHistory);
  expect(committed.captures[sourceHash].currentRevision).toBe(capture.currentRevision); expect(committed.pending).toEqual(pending.pending); expect(committed.suppressed).toContain(sourceHash);
  for (const source of [currentA.toString(), tx.content, journalBytes.toString()]) expect(JSON.stringify(authority)).not.toContain(JSON.stringify(source).slice(1, -1));
  expect(lockOwner).toEqual({ pid: mainPid });
  const child = app.process(), processEvidence = { boundary: 'capture-deletion-unlinked', wrapperPid: child.pid, mainPid, exitBoundary: 'Electron app.exit(77)' };
  const exited = new Promise(resolve => child.once('exit', (code, signal) => resolve({ code, signal })));
  const abrupt = app.evaluate(({ app: electronApp }) => electronApp.exit(77)).catch(error => { if (!/closed|disposed/i.test(error.message)) throw error; });
  processEvidence.wrapperExit = await exited; await abrupt;
  await expect.poll(() => { try { process.kill(mainPid, 0); return 'alive'; } catch (error) { if (error.code === 'ESRCH') return 'exited'; throw error; } }).toBe('exited');
  app = null;
  await fs.writeFile(testInfo.outputPath('pending-selection-generation-process-exit.json'), JSON.stringify(processEvidence, null, 2));
  expect(processEvidence.wrapperExit).toEqual({ code: 77, signal: null });
  expect(await observe(survivors)).toEqual(survivorObservations); expect(await exists(first)).toBe(false); expect(await fs.readFile(ledgerFile)).toEqual(committedBytes); expect(await fs.readFile(lockFile)).toEqual(lockBytes);
  await fs.writeFile(path.join(root, 'faults.json'), '{}'); await launch();
  await expect(page.locator('#idea-support-status')).toContainText('Current support inspected.'); await expect(page.locator('#captures article')).toHaveCount(0);
  const recovered = JSON.parse(await fs.readFile(ledgerFile)), expectedAuthority = { ...authority, phase: 'deleted' };
  expect(recovered.sourceAuthority[id]).toEqual(expectedAuthority); expect(recovered.attempts).toEqual(retained.attempts); expect(recovered.admissions).toEqual(retained.admissions);
  expect(recovered.captures[sourceHash].selectionHistory).toEqual(capture.selectionHistory); expect(recovered.captures[sourceHash].currentRevision).toBe(capture.currentRevision);
  expect(recovered.pending[sourceHash]).toBeUndefined(); expect(recovered.blocks[sourceHash]).toBeUndefined(); expect(recovered.suppressed).toContain(sourceHash);
  for (const name of names) expect(await exists(path.join(base, name))).toBe(false);
  // The dead main's exact ownership lock is removed by normal vault recovery.
  expect(await exists(lockFile)).toBe(false); expect(await files(producer)).toEqual(producerBytes);
  const checkedAt = await check('held'), checked = JSON.parse(await fs.readFile(ledgerFile));
  expect(checked.lastCheck).toEqual({ at: checkedAt, trigger: 'manual', status: 'held' });
  const scannedKeys = ['accept', 'edit'].map(name => retained.sources[0].id + ':' + name);
  expect(Object.keys(checked.outcomes).sort()).toEqual(Object.keys(recovered.outcomes).sort());
  for (const [index, key] of scannedKeys.entries()) expect(checked.outcomes[key]).toEqual({ status: 'held', reason: 'Automatic re-import is suppressed. Restore this source explicitly before intake.', locator: path.join(producer, ['accept', 'edit'][index]), checkedAt });
  // The explicit restoration has its own historical outcome; intake does not rescan it.
  for (const [key, outcome] of Object.entries(recovered.outcomes)) if (!scannedKeys.includes(key)) expect(checked.outcomes[key]).toEqual(outcome);
  await app.close(); app = null; await launch(); await expect(page.locator('#idea-support-status')).toContainText('Current support inspected.'); await expect(page.locator('#captures article')).toHaveCount(0);
  const final = JSON.parse(await fs.readFile(ledgerFile));
  expect(final.sourceAuthority[id]).toEqual(expectedAuthority); expect(final.attempts).toEqual(retained.attempts); expect(final.admissions).toEqual(retained.admissions); expect(final.captures[sourceHash].selectionHistory).toEqual(capture.selectionHistory); expect(final.captures[sourceHash].currentRevision).toBe(capture.currentRevision);
  for (const name of names) expect(await exists(path.join(base, name))).toBe(false);
  expect(await exists(lockFile)).toBe(false); expect(await files(producer)).toEqual(producerBytes);
});
