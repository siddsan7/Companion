const { test, expect, _electron: electron } = require('@playwright/test');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const YAML = require('yaml');
const fixture = require('./fixtures/reel-draft/example.json');

let root, app, page;
const sourceHash = 'a'.repeat(64);
test.beforeEach(async () => { root = await fs.mkdtemp(path.join(os.tmpdir(), 'companion-detach-deletion-')); });
test.afterEach(async () => { if (app) await app.close(); app = null; await fs.rm(root, { recursive: true, force: true }); });

async function artifact(name, attempt) {
  const folder = path.join(root, 'producer', name); await fs.mkdir(folder, { recursive: true });
  await fs.writeFile(path.join(folder, 'run.json'), JSON.stringify({ job_id: 'b'.repeat(64), attempt_id: attempt.repeat(32), started_utc: '2026-11-01T10:00:00Z', input_sha256: sourceHash, input_kind: 'local_video', result_kind: 'local_video_unreviewed', state: 'partial', validation: 'passed' }));
  await fs.writeFile(path.join(folder, 'evidence.json'), JSON.stringify({ ...fixture.input, clip_id: 'b'.repeat(64) }));
  await fs.writeFile(path.join(folder, 'first-pass-target.json'), JSON.stringify(fixture.target));
  await fs.copyFile(path.join(__dirname, 'fixtures/reel-draft/notes.md'), path.join(folder, 'notes.md'));
}
async function launch() {
  await fs.writeFile(path.join(root, 'clock.json'), JSON.stringify({ now: '2026-11-08T06:59:00Z', timezone: 'America/Phoenix' }));
  app = await electron.launch({ args: ['.'], env: { ...process.env, COMPANION_TEST_ROOT: root } });
  page = await app.firstWindow();
}
async function files(folder, prefix = '') {
  const result = {};
  for (const entry of (await fs.readdir(folder, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    const name = prefix + entry.name, file = path.join(folder, entry.name);
    if (entry.isDirectory()) Object.assign(result, await files(file, name + '/'));
    else {
      const bytes = await fs.readFile(file), info = await fs.lstat(file, { bigint: true });
      result[name] = { bytes: bytes.toString('base64'), sha256: createHash('sha256').update(bytes).digest('hex'), dev: String(info.dev), ino: String(info.ino), size: String(info.size), nlink: String(info.nlink), ordinary: info.isFile() && !info.isSymbolicLink() };
    }
  }
  return result;
}
async function exists(file) { return fs.access(file).then(() => true, error => { if (error.code === 'ENOENT') return false; throw error; }); }
async function checkpoint(name) {
  await expect.poll(() => fs.readFile(path.join(root, 'checkpoint.txt'), 'utf8').catch(error => { if (error.code === 'ENOENT') return ''; throw error; })).toBe(name);
}
async function observe(testInfo, name, base, extra = {}) {
  const observed = { ...extra, files: await files(base) };
  await fs.writeFile(testInfo.outputPath(name + '.json'), JSON.stringify(observed, null, 2));
  return observed.files;
}
test('deleting persistent detached editor writing retains one whole local annotation before source purge', async ({}, testInfo) => {
  test.setTimeout(150000);
  await artifact('first', '1'); await launch();
  await page.getByRole('button', { name: 'Choose vault', exact: true }).click();
  await page.getByRole('button', { name: 'Use this folder', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('Vault ready.');
  await page.getByLabel('Draft source folder').fill(path.join(root, 'producer'));
  await page.getByRole('checkbox', { name: 'Scan existing drafts now' }).check();
  await page.getByRole('button', { name: 'Connect draft source', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('Intake check complete');

  const base = path.join(root, 'vault', 'Companion'), intake = path.join(base, '.intake'), ledgerFile = path.join(intake, 'ledger.json');
  const original = JSON.parse(await fs.readFile(ledgerFile, 'utf8')), capture = original.captures[sourceHash];
  const current = path.join(base, 'Captures', capture.file), currentBytes = await fs.readFile(current);
  const writing = Object.fromEntries(Object.entries(await files(base)).filter(([name]) => name.startsWith('Annotations/')));
  expect(Object.keys(writing)).toHaveLength(0);
  await artifact('second', '2');
  const producers = await files(path.join(root, 'producer'));

  await fs.writeFile(path.join(root, 'faults.json'), JSON.stringify({ pause: 'intake-capture-staged' }));
  // The public intake bridge avoids renderer refresh automatically detaching the
  // just-restored pair before it can be observed. Deletion below uses rendered UI.
  const checking = page.evaluate(() => window.companion['check-intake']());
  await checkpoint('intake-capture-staged');
  const tx = JSON.parse(await fs.readFile(path.join(intake, 'transaction.json'), 'utf8'));
  const incoming = path.join(intake, tx.revision.id + '.stage'), outside = path.join(root, 'outside-incoming');
  const backup = path.join(intake, tx.backup), intentFile = backup + '.detach.json';
  const snapshotA = path.join(base, 'Revisions', capture.currentRevision + '.json');
  const snapshotABytes = await fs.readFile(snapshotA);
  const snapshotB = path.join(base, 'Revisions', tx.revision.id + '.json'), snapshotStage = path.join(intake, tx.revision.id + '.snapshot.stage');
  await observe(testInfo, 'incoming-staged', base, { tx });
  expect(tx.sourceHash).toBe(sourceHash); expect(tx.capture.id).toBe(capture.id);
  expect(tx.revision.id).not.toBe(capture.currentRevision);
  expect(await exists(current)).toBe(false);
  await fs.copyFile(incoming, outside); await fs.unlink(incoming); await fs.link(outside, incoming);
  await fs.writeFile(path.join(root, 'release.txt'), 'continue'); const bridgeResult = await checking;

  const conflicted = JSON.parse(await fs.readFile(ledgerFile, 'utf8')), archive = path.join(intake, conflicted.blocks[sourceHash].journal);
  const restored = await observe(testInfo, 'writer-restored-pair', base, { bridgeResult, ledger: conflicted });
  const relative = file => path.relative(base, file).split(path.sep).join('/');
  const pair = [restored[relative(current)], restored[relative(backup)]];
  expect(pair.map(item => item.nlink)).toEqual(['2', '2']);
  expect([pair[0].dev, pair[0].ino]).toEqual([pair[1].dev, pair[1].ino]);
  expect(await fs.readFile(current)).toEqual(currentBytes); expect(await fs.readFile(backup)).toEqual(currentBytes);
  expect(JSON.parse(await fs.readFile(archive, 'utf8'))).toEqual(tx);
  expect(conflicted.attempts).toEqual(original.attempts); expect(conflicted.admissions).toEqual(original.admissions);
  expect(conflicted.attempts[tx.revision.identity]).toBeUndefined();
  expect(conflicted.captures[sourceHash].revisions).toEqual(capture.revisions);
  await app.close(); app = null;
  // Remove only the controlled outside alias. The actual writer pair stays intact.
  await fs.unlink(outside); expect((await fs.stat(incoming)).nlink).toBe(1);
  await fs.unlink(path.join(root, 'release.txt'));
  await fs.writeFile(path.join(root, 'faults.json'), JSON.stringify({ pause: 'intake-restored-backup-publish' }));
  await launch(); await checkpoint('intake-restored-backup-publish');
  const intentBytes = await fs.readFile(intentFile, 'utf8'), intent = JSON.parse(intentBytes);
  const retained = backup + '.detached-' + intent.id, independent = backup + '.independent';
  const holdArchive = intentFile + '.held-' + intent.id;
  await observe(testInfo, 'detach-publish-before-editor', base, { intentBytes, intent, ledger: JSON.parse(await fs.readFile(ledgerFile, 'utf8')) });
  expect(await fs.readFile(independent)).toEqual(currentBytes);
  const publishing = await files(base);
  expect(publishing[relative(current)].nlink).toBe('2');
  expect(publishing[relative(backup)].ino).toBe(publishing[relative(current)].ino);
  // Model an external editor's atomic replacement; the real writer performs the later rename.
  const wholeE = Buffer.concat([currentBytes, Buffer.from('\nWHOLEDETACHEDE: Preserve this entire local version. Source quotation: "Authored synthetic source material."\nLiteral fence stress: ````````\nUnicode: café — local observation.\n', 'utf8')]);
  await fs.unlink(backup); await fs.writeFile(backup, wholeE, { flag: 'wx', flush: true });
  const edited = await observe(testInfo, 'external-editor-replaced-backup', base, { wholeE: wholeE.toString('base64'), action: 'unlink P; exclusive write complete E at P' });
  await fs.writeFile(path.join(root, 'release.txt'), 'continue');
  await expect.poll(async () => await exists(holdArchive) && !await exists(intentFile)).toBe(true);
  await observe(testInfo, 'actual-writer-detach-hold', base, { ledger: JSON.parse(await fs.readFile(ledgerFile, 'utf8')) });
  await app.close(); app = null;
  await fs.unlink(path.join(root, 'release.txt'));
  await fs.writeFile(path.join(root, 'faults.json'), '{}'); await launch();
  await expect(page.getByRole('button', { name: 'Delete capture', exact: true })).toBeVisible();
  const targets = [current, snapshotA, snapshotB, snapshotStage, incoming, archive, independent, retained, holdArchive];
  const held = JSON.parse(await fs.readFile(ledgerFile, 'utf8'));
  const recovered = await observe(testInfo, 'persistent-family-before-count', base, {
    root, targets: targets.map(relative), held, original, conflicted, tx, intentBytes, intent,
    producers, wholeE: wholeE.toString('base64'), ui: await page.locator('body').innerText()
  });
  const sourceLeaves = tree => Object.keys(tree).filter(name => /^(Captures\/|Revisions\/)/.test(name) || name.startsWith('.intake/') && name !== '.intake/ledger.json').sort();
  expect(sourceLeaves(recovered)).toEqual(targets.map(relative).sort());
  expect(sourceLeaves(recovered)).toHaveLength(9);
  expect(await exists(backup)).toBe(false); expect(await exists(intentFile)).toBe(false);
  for (const file of [current, independent]) expect(await fs.readFile(file)).toEqual(currentBytes);
  expect(await fs.readFile(retained)).toEqual(wholeE);
  expect(recovered[relative(retained)]).toEqual(edited[relative(backup)]);
  expect(await fs.readFile(snapshotA)).toEqual(snapshotABytes);
  expect(await fs.readFile(snapshotB)).toEqual(await fs.readFile(snapshotStage));
  expect(intent.sourceHash).toBe(sourceHash); expect(intent.captureId).toBe(capture.id);
  expect(intent.backup).toBe(tx.backup); expect(intent.journal).toBe(path.basename(archive));
  expect(await fs.readFile(incoming, 'utf8')).toBe(tx.content);
  expect(await fs.readFile(archive, 'utf8')).toBe(JSON.stringify(tx));
  const holdBytes = await fs.readFile(holdArchive, 'utf8'), hold = JSON.parse(holdBytes);
  expect(holdBytes).toBe(JSON.stringify(hold)); expect(hold.intentBytes).toBe(intentBytes);
  expect(hold.evidence).toEqual([
    { role: 'independent-editor-writing', file: path.basename(retained), hash: createHash('sha256').update(wholeE).digest('hex') },
    { role: 'original-source-copy', file: path.basename(independent), hash: tx.previousHash }
  ]);
  expect(held.blocks[sourceHash].detachHold).toEqual({ journal: path.basename(holdArchive), reason: held.blocks[sourceHash].reason, evidence: hold.evidence });
  expect(held.captures[sourceHash].conflict).toBe(held.blocks[sourceHash].reason);
  expect(held.outcomes[tx.key].reason).toBe(held.blocks[sourceHash].reason);
  expect(held.attempts).toEqual(original.attempts); expect(held.admissions).toEqual(original.admissions);
  expect(held.attempts[tx.revision.identity]).toBeUndefined(); expect(held.admissions?.[tx.revision.id]).toBeUndefined();
  expect(held.captures[sourceHash].currentRevision).toBe(capture.currentRevision);
  expect(held.captures[sourceHash].revisions).toEqual(capture.revisions);
  const pairB = [snapshotB, snapshotStage].map(file => recovered[relative(file)]);
  expect(pairB.map(item => item.nlink)).toEqual(['2', '2']); expect(pairB[0].ino).toBe(pairB[1].ino); expect(pairB[0].dev).toBe(pairB[1].dev);
  for (const file of targets.filter(file => ![snapshotB, snapshotStage].includes(file))) expect(recovered[relative(file)].nlink).toBe('1');
  expect(new Set(targets.map(file => recovered[relative(file)].dev + ':' + recovered[relative(file)].ino)).size).toBe(8);
  expect(await files(path.join(root, 'producer'))).toEqual(producers);
  expect(await fs.readdir(path.join(base, 'Annotations'))).toEqual([]);
  for (const file of targets) expect(recovered[relative(file)].ordinary).toBe(true);
  const before = await files(base), statusBeforePreview = await page.getByRole('status').innerText();
  await page.getByRole('button', { name: 'Delete capture', exact: true }).click();
  const preview = page.getByLabel('Capture deletion preview');
  // Wait for either settled preview or reported HOLD, then save evidence before the feature assertion.
  await expect.poll(async () => await preview.isVisible() || (await page.getByRole('status').innerText()) !== statusBeforePreview).toBe(true);
  await observe(testInfo, 'first-feature-preview', base, { status: await page.getByRole('status').innerText(), preview: await preview.textContent(), ui: await page.locator('body').innerText() });
  await expect(preview).toBeVisible();
  const reviewPaths = async () => preview.locator('p').allTextContents().then(lines => lines.filter(line => line.startsWith('Remove: ')).map(line => line.slice(8)).sort());
  const expectedPaths = targets.map(file => path.relative(path.join(root, 'vault'), file).split(path.sep).join('/')).sort();
  const outputPaths = reviewed => [...new Set(reviewed.match(/Companion\/Annotations\/[a-f0-9-]{36}\.md/g) || [])];
  async function review() {
    expect(await reviewPaths()).toEqual(expectedPaths);
    const reviewed = await preview.innerText();
    expect(reviewed).toContain(wholeE.toString('utf8')); expect(reviewed).toContain('Retained whole local version');
    expect(reviewed).toMatch(/retain[\s\S]*source quotations/i);
    const paths = outputPaths(reviewed); expect(paths).toHaveLength(1);
    expect(reviewed).toContain(path.basename(paths[0], '.md'));
    return paths[0];
  }
  await review(); expect(await files(base)).toEqual(before);
  await preview.getByRole('button', { name: 'Cancel capture deletion', exact: true }).click();
  await expect(preview).toBeHidden(); expect(await files(base)).toEqual(before);
  await page.getByRole('button', { name: 'Delete capture', exact: true }).click();
  await expect(preview).toBeVisible();
  const outputPath = await review(), output = path.join(root, 'vault', outputPath);
  // Observe the native filesystem boundary before the FIRST source-origin unlink.
  // This test instrumentation does not fabricate a receipt or change product authority.
  await app.evaluate(({ }, { targets, marker, release }) => {
    const nativeFs = process.getBuiltinModule('fs').promises, nativeUnlink = nativeFs.unlink;
    let observed = false;
    nativeFs.unlink = async function(file, ...args) {
      if (!observed && targets.includes(String(file))) {
        observed = true;
        await nativeFs.writeFile(marker, JSON.stringify({ file: String(file), boundary: 'before native source unlink' }));
        while (true) {
          try { await nativeFs.access(release); break; } catch (error) { if (error.code !== 'ENOENT') throw error; }
          await new Promise(resolve => setTimeout(resolve, 15));
        }
      }
      return nativeUnlink.call(this, file, ...args);
    };
  }, { targets, marker: path.join(root, 'before-source-unlink.json'), release: path.join(root, 'release-source-unlink.txt') });
  await preview.getByRole('button', { name: 'Confirm capture deletion', exact: true }).click();
  await expect.poll(() => exists(path.join(root, 'before-source-unlink.json'))).toBe(true);
  const pausedLedger = JSON.parse(await fs.readFile(ledgerFile, 'utf8'));
  await observe(testInfo, 'before-first-source-unlink', base, { pausedLedger, boundary: JSON.parse(await fs.readFile(path.join(root, 'before-source-unlink.json'), 'utf8')) });
  expect((await Promise.all(targets.map(exists))).every(Boolean)).toBe(true);
  const plans = pausedLedger.sourceAuthority[capture.id].preservedWriting;
  expect(plans).toHaveLength(1); expect(plans[0].publication).toBeTruthy(); expect(plans[0].stageIdentity).toBeTruthy(); expect(plans[0].file).toBe(outputPath);
  const outputBytes = await fs.readFile(output), quoted = outputBytes.toString('utf8');
  expect(outputBytes.includes(wholeE)).toBe(true);
  const wrapper = YAML.parse(quoted.match(/^---\r?\n([\s\S]*?)\r?\n---/)[1]);
  expect(wrapper.capture_id).toBe(capture.id); expect(wrapper.artifact_type).toBe('annotation');
  if (tx.sourceGeneration) expect(wrapper.source_generation).toBe(tx.sourceGeneration);
  else expect(Object.hasOwn(wrapper, 'source_generation')).toBe(false);
  const fence = quoted.match(/^(`{3,})text\r?$/m)?.[1];
  expect(fence?.length).toBeGreaterThan(8); expect(quoted).toContain(fence + 'text\n' + wholeE.toString('utf8'));
  expect(plans[0].publication.sha256).toBe(createHash('sha256').update(outputBytes).digest('hex'));
  await fs.writeFile(path.join(root, 'release-source-unlink.txt'), 'continue');
  await expect(page.getByRole('status')).toContainText('Capture deleted');
  await expect(page.getByRole('status')).toContainText('supporting evidence is unavailable');
  async function verifyDeleted(name) {
    const ledger = JSON.parse(await fs.readFile(ledgerFile, 'utf8'));
    const observed = await observe(testInfo, name, base, { ledger });
    expect(sourceLeaves(observed)).toEqual([]);
    for (const file of [...targets, backup, intentFile]) expect(await exists(file)).toBe(false);
    expect(await fs.readFile(output)).toEqual(outputBytes);
    expect(await fs.readdir(path.join(base, 'Annotations'))).toEqual([path.basename(output)]);
    expect(ledger.sourceAuthority[capture.id].phase).toBe('deleted'); expect(ledger.suppressed).toContain(sourceHash);
    expect(ledger.attempts).toEqual(original.attempts); expect(ledger.admissions).toEqual(original.admissions);
    expect(ledger.blocks[sourceHash]).toBeUndefined(); expect(ledger.pending[sourceHash]).toBeUndefined();
    expect(await files(path.join(root, 'producer'))).toEqual(producers);
    await expect(page.locator('#captures article')).toHaveCount(0);
    return ledger;
  }
  const deleted = await verifyDeleted('confirmed-purge');
  expect(deleted.sourceAuthority[capture.id].targets.map(target => target.file).sort()).toEqual(expectedPaths);
  expect(deleted.sourceAuthority[capture.id].purgedProducerAttempts.find(item => item.identity === tx.revision.identity)).toEqual({ identity: tx.revision.identity, fingerprint: tx.revision.fingerprint, sourceHash, captureId: capture.id, revisionId: tx.revision.id, sourceGeneration: tx.sourceGeneration || null, operationId: deleted.sourceAuthority[capture.id].operationId });
  const checkedAt = '2026-11-08T06:59:01.000Z';
  await fs.writeFile(path.join(root, 'clock.json'), JSON.stringify({ now: checkedAt, timezone: 'America/Phoenix' }));
  await page.getByRole('button', { name: 'Check now', exact: true }).click();
  await expect(page.locator('#intake-state')).toContainText(`Last check: ${checkedAt} · manual · held`);
  const checked = await verifyDeleted('suppressed-check');
  const outcomes = Object.values(checked.outcomes); expect(outcomes).toHaveLength(2);
  expect(outcomes.map(value => value.locator).sort()).toEqual(Object.values(held.outcomes).map(value => value.locator).sort());
  for (const outcome of outcomes) {
    expect(outcome.status).toBe('held'); expect(outcome.checkedAt).toBe(checkedAt);
    expect(outcome.reason).toBe('Automatic re-import is suppressed. Restore this source explicitly before intake.');
  }
  await app.close(); app = null; await launch();
  await expect(page.locator('#timezone')).toContainText('America/Phoenix'); await verifyDeleted('suppressed-restart');
});
