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
  await app.evaluate((_electron, options) => {
    const io = process.getBuiltinModule('fs').promises, paths = process.getBuiltinModule('path'), originalRename = io.rename;
    io.rename = async function (from, to, ...args) {
      try { return await originalRename.call(this, from, to, ...args); }
      catch (error) {
        if (typeof from === 'string' && paths.resolve(from).toLowerCase() === paths.resolve(options.current).toLowerCase()) {
          io.rename = originalRename;
          await io.writeFile(options.observerFile, JSON.stringify({ mainPid: process.pid, from, to, code: error.code, syscall: error.syscall, message: error.message, delegatedOriginal: true }));
        }
        throw error;
      }
    };
  }, { current, observerFile });
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
