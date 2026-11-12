const { test, expect, _electron: electron } = require('@playwright/test');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const YAML = require('yaml');
const { parse, withTitle } = require('../app/vault');
let root, app, page;

test.beforeEach(async () => { root = await fs.mkdtemp(path.join(os.tmpdir(), 'companion-manual-title-')); });
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
async function absent(paths) {
  for (const file of paths) expect(await fs.access(file).then(() => true, error => { if (error.code === 'ENOENT') return false; throw error; })).toBe(false);
}
async function ledger(file) {
  return fs.readFile(file, 'utf8').then(JSON.parse, error => { if (error.code === 'ENOENT') return null; throw error; });
}

test('completed manual title deletion reviews its two actual source files, cancels unchanged and purges without replay', async ({}, testInfo) => {
  test.setTimeout(120000);
  await launch();
  await page.getByRole('button', { name: 'Choose vault', exact: true }).click();
  await page.getByRole('button', { name: 'Use this folder', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('Vault ready.');
  const body = 'MANUALTITLEPROOF a personal thought about repeated guitar practice.\nThe second line is independent source body text.';
  await page.getByLabel('Thought or link', { exact: true }).fill(body);
  await page.getByRole('button', { name: 'Save capture', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('Capture saved.');
  const base = path.join(root, 'vault', 'Companion'), captures = path.join(base, 'Captures');
  const names = (await fs.readdir(captures)).filter(name => name.endsWith('.md'));
  expect(names).toHaveLength(1);
  const current = path.join(captures, names[0]), originalBytes = await fs.readFile(current), note = parse(originalBytes.toString('utf8'));
  expect(note.type).toBe('thought'); expect(note.content).toContain(body);
  const ledgerFile = path.join(base, '.intake', 'ledger.json'), originalLedger = await ledger(ledgerFile);
  const title = 'Manual title: punctuation, preserved!';
  await page.getByLabel('Display title', { exact: true }).fill(title);
  await page.getByRole('button', { name: 'Save title', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('Title saved.');
  await expect(page.getByRole('heading', { name: title, exact: true })).toBeVisible();
  const backupNames = (await fs.readdir(captures)).filter(name => name.startsWith(names[0] + '.before-title-'));
  expect(backupNames).toHaveLength(1);
  expect(backupNames[0]).toMatch(/\.md\.before-title-[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}\.bak$/);
  const backup = path.join(captures, backupNames[0]), currentBytes = await fs.readFile(current);
  expect(await fs.readFile(backup)).toEqual(originalBytes);
  // Actual writer evidence, supplemented by independent metadata/body assertions.
  expect(currentBytes).toEqual(Buffer.from(withTitle(originalBytes.toString('utf8'), title), 'utf8'));
  const parts = bytes => bytes.toString('utf8').match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)([\s\S]*)$/);
  const oldParts = parts(originalBytes), newParts = parts(currentBytes);
  expect(YAML.parse(newParts[1])).toEqual({ ...YAML.parse(oldParts[1]), title });
  expect(newParts[2]).toBe('\n# ' + title + '\n\n' + body + '\n');
  const identities = [];
  for (const file of [current, backup]) {
    const stat = await fs.lstat(file, { bigint: true });
    expect(stat.isFile()).toBe(true); expect(stat.isSymbolicLink()).toBe(false); expect(stat.nlink).toBe(1n);
    identities.push({ file: path.basename(file), dev: String(stat.dev), ino: String(stat.ino), nlink: String(stat.nlink) });
  }
  expect([identities[0].dev, identities[0].ino]).not.toEqual([identities[1].dev, identities[1].ino]);
  const residue = [current + '.pending', current + '.title-transaction.json', path.join(base, '.intake', 'title-intent.json')];
  await absent(residue); expect(await ledger(ledgerFile)).toEqual(originalLedger);
  for (const key of ['captures', 'attempts', 'admissions']) expect(Object.keys(originalLedger?.[key] || {})).toHaveLength(0);
  expect(await fs.readdir(path.join(base, 'Revisions'))).toEqual([]);
  await fs.writeFile(testInfo.outputPath('actual-manual-title-writer.json'), JSON.stringify({ identities, originalHash: createHash('sha256').update(originalBytes).digest('hex'), currentHash: createHash('sha256').update(currentBytes).digest('hex'), literalTitleTransformation: true, snapshots: 0, producerConnected: false }, null, 2));
  const relative = file => path.relative(path.join(root, 'vault'), file).split(path.sep).join('/');
  const before = await files(base), preview = page.getByLabel('Capture deletion preview');
  await page.getByRole('button', { name: 'Delete capture', exact: true }).click();
  await expect(preview).toBeVisible();
  await expect(preview).toContainText('0 revision snapshots');
  expect((await preview.locator('p').allTextContents()).filter(text => text.startsWith('Remove: ')).sort()).toEqual([current, backup].map(file => 'Remove: ' + relative(file)).sort());
  expect(await files(base)).toEqual(before);
  await preview.getByRole('button', { name: 'Cancel capture deletion', exact: true }).click();
  await expect(preview).toBeHidden(); expect(await files(base)).toEqual(before);
  await page.getByRole('button', { name: 'Delete capture', exact: true }).click();
  await preview.getByRole('button', { name: 'Confirm capture deletion', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('Capture deleted');
  const deleted = await ledger(ledgerFile), authority = deleted.sourceAuthority[note.id];
  expect(authority.phase).toBe('deleted'); expect(authority.inventoryVersion).toBe(1); expect(authority.sourceHash).toBeNull();
  expect(authority.originGenerations).toEqual([]);
  expect(authority.manual).toEqual({ captureId: note.id, type: note.type, capturedAt: note.capturedAt, currentHash: createHash('sha256').update(currentBytes).digest('hex'), file: names[0], relative: relative(current) });
  expect(authority.targets.map(target => target.file).sort()).toEqual([current, backup].map(relative).sort());
  expect(authority.targets.find(target => target.file === relative(backup)).kind).toBe('source-title-backup');
  expect(authority.titleProofs).toEqual([{ before: relative(backup), after: relative(current), sourceGeneration: null }]);
  for (const key of ['recovery', 'recoveryPointers', 'purgedProducerAttempts']) expect(authority[key]).toBeUndefined();
  for (const key of ['captures', 'attempts', 'admissions']) expect(deleted[key] || {}).toEqual(originalLedger?.[key] || {});
  expect(deleted.suppressed).toEqual(originalLedger?.suppressed || []);
  expect(JSON.stringify(authority)).not.toContain(body); expect(JSON.stringify(authority)).not.toContain(title);
  await absent([current, backup, ...residue]);
  await app.close(); app = null; await launch();
  await expect(page.locator('#idea-support-status')).toContainText('Current support inspected.');
  await expect(page.locator('#captures article')).toHaveCount(0);
  expect((await ledger(ledgerFile)).sourceAuthority[note.id]).toEqual(authority);
  await absent([current, backup, ...residue]); expect(await fs.readdir(path.join(base, 'Revisions'))).toEqual([]);
});

test('completed manual title deletion holds independent body writing in its actual ordinary backup', async ({}, testInfo) => {
  test.setTimeout(90000);
  await launch();
  await page.getByRole('button', { name: 'Choose vault', exact: true }).click();
  await page.getByRole('button', { name: 'Use this folder', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('Vault ready.');
  const body = 'MANUALTITLEBODYGUARD a personal thought about practising a new chord.\nThis second line is the saved source body.';
  await page.getByLabel('Thought or link', { exact: true }).fill(body);
  await page.getByRole('button', { name: 'Save capture', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('Capture saved.');
  const base = path.join(root, 'vault', 'Companion'), captures = path.join(base, 'Captures');
  const names = (await fs.readdir(captures)).filter(name => name.endsWith('.md'));
  expect(names).toHaveLength(1);
  const current = path.join(captures, names[0]), originalBytes = await fs.readFile(current);
  const title = 'Manual body guard: completed title';
  await page.getByLabel('Display title', { exact: true }).fill(title);
  await page.getByRole('button', { name: 'Save title', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('Title saved.');
  await expect(page.getByRole('heading', { name: title, exact: true })).toBeVisible();
  const backupNames = (await fs.readdir(captures)).filter(name => name.startsWith(names[0] + '.before-title-'));
  expect(backupNames).toHaveLength(1);
  const backup = path.join(captures, backupNames[0]), initialStat = await fs.lstat(backup, { bigint: true });
  expect(initialStat.isFile()).toBe(true); expect(initialStat.isSymbolicLink()).toBe(false); expect(initialStat.nlink).toBe(1n);
  expect(await fs.readFile(backup)).toEqual(originalBytes);
  const currentBytes = await fs.readFile(current), currentStat = await fs.lstat(current, { bigint: true });
  expect(currentStat.isFile()).toBe(true); expect(currentStat.isSymbolicLink()).toBe(false); expect(currentStat.nlink).toBe(1n);
  expect([String(currentStat.dev), String(currentStat.ino)]).not.toEqual([String(initialStat.dev), String(initialStat.ino)]);
  expect(currentBytes).toEqual(Buffer.from(withTitle(originalBytes.toString('utf8'), title), 'utf8'));
  const ledgerFile = path.join(base, '.intake', 'ledger.json');
  const ledgerBytes = await fs.readFile(ledgerFile).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
  const originalLedger = await ledger(ledgerFile);
  const independentBody = '\nMANUALTITLEINDEPENDENTBODY My authored interpretation and source quotation exist only in this real old-title backup.\n';
  await fs.appendFile(backup, independentBody);
  const editedBytes = await fs.readFile(backup), editedStat = await fs.lstat(backup, { bigint: true });
  expect(editedBytes).toEqual(Buffer.concat([originalBytes, Buffer.from(independentBody, 'utf8')]));
  expect(editedStat.dev).toBe(initialStat.dev); expect(editedStat.ino).toBe(initialStat.ino); expect(editedStat.nlink).toBe(1n);
  const before = await files(base);
  await page.getByRole('button', { name: 'Delete capture', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('Manual title copies contain changed or unsupported writing');
  await expect(page.getByLabel('Capture deletion preview')).toBeHidden();
  expect(await files(base)).toEqual(before);
  expect(await fs.readFile(backup)).toEqual(editedBytes); expect(await fs.readFile(current)).toEqual(currentBytes);
  const heldStat = await fs.lstat(backup, { bigint: true }), heldCurrentStat = await fs.lstat(current, { bigint: true });
  expect(heldStat.dev).toBe(initialStat.dev); expect(heldStat.ino).toBe(initialStat.ino); expect(heldStat.nlink).toBe(1n);
  expect(heldCurrentStat.dev).toBe(currentStat.dev); expect(heldCurrentStat.ino).toBe(currentStat.ino); expect(heldCurrentStat.nlink).toBe(1n);
  expect(await fs.readFile(ledgerFile).catch(error => { if (error.code === 'ENOENT') return null; throw error; })).toEqual(ledgerBytes);
  expect(await ledger(ledgerFile)).toEqual(originalLedger);
  expect(originalLedger?.sourceAuthority).toBeUndefined();
  for (const key of ['captures', 'attempts', 'admissions']) expect(Object.keys(originalLedger?.[key] || {})).toHaveLength(0);
  expect(await fs.readdir(path.join(base, 'Revisions'))).toEqual([]);
  await absent([current + '.pending', current + '.title-transaction.json', path.join(base, '.intake', 'title-intent.json')]);
  await fs.writeFile(testInfo.outputPath('actual-manual-title-body-hold.json'), JSON.stringify({ actualWriterBackup: path.basename(backup), originalBackupHash: createHash('sha256').update(originalBytes).digest('hex'), editedBackupHash: createHash('sha256').update(editedBytes).digest('hex'), currentHash: createHash('sha256').update(currentBytes).digest('hex'), editedBackupRetainedSameInode: true, currentRetainedSameInode: true, vaultAndLedgerUnchangedAfterPreview: true, newAuthority: false }, null, 2));
});

test('repeated manual title saves inventory every actual backup with a deterministic full-coverage witness', async ({}, testInfo) => {
  test.setTimeout(120000);
  await launch();
  await page.getByRole('button', { name: 'Choose vault', exact: true }).click();
  await page.getByRole('button', { name: 'Use this folder', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('Vault ready.');
  const body = 'MANUALREPEATEDTITLE a personal thought about practising a chord progression.\nEvery saved display title must preserve this body.';
  await page.getByLabel('Thought or link', { exact: true }).fill(body);
  await page.getByRole('button', { name: 'Save capture', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('Capture saved.');
  const base = path.join(root, 'vault', 'Companion'), captures = path.join(base, 'Captures');
  const captureNames = (await fs.readdir(captures)).filter(name => name.endsWith('.md'));
  expect(captureNames).toHaveLength(1);
  const current = path.join(captures, captureNames[0]), originalBytes = await fs.readFile(current), originalNote = parse(originalBytes.toString('utf8'));
  const ledgerFile = path.join(base, '.intake', 'ledger.json'), originalLedger = await ledger(ledgerFile);
  const backupNames = async () => (await fs.readdir(captures)).filter(name => name.startsWith(captureNames[0] + '.before-title-')).sort();
  const buffers = new Map(), observations = [], sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
  const saveTitle = async title => {
    const before = await fs.readFile(current), oldNames = new Set(await backupNames());
    await page.getByLabel('Display title', { exact: true }).fill(title);
    const oldSave = await page.getByRole('button', { name: 'Save title', exact: true }).elementHandle();
    expect(oldSave).not.toBeNull();
    await page.getByRole('button', { name: 'Save title', exact: true }).click();
    // Same-title status and heading can be stale; await completed replacement.
    await oldSave.waitForElementState('hidden');
    await expect(page.getByRole('button', { name: 'Save title', exact: true })).toBeVisible();
    await expect(page.getByRole('status')).toContainText('Title saved.');
    await expect(page.getByLabel('Display title', { exact: true })).toHaveValue(title);
    const after = await fs.readFile(current), added = (await backupNames()).filter(name => !oldNames.has(name));
    expect(added).toHaveLength(1);
    const file = path.join(captures, added[0]), bytes = await fs.readFile(file);
    expect(bytes).toEqual(before); buffers.set(file, bytes);
    expect(after).toEqual(Buffer.from(withTitle(before.toString('utf8'), title), 'utf8'));
    expect(after.toString('utf8')).toContain('\n\n' + body + '\n');
    const note = parse(after.toString('utf8'));
    expect({ id: note.id, type: note.type, capturedAt: note.capturedAt }).toEqual({ id: originalNote.id, type: originalNote.type, capturedAt: originalNote.capturedAt });
    observations.push({ title, beforeSha256: sha256(before), afterSha256: sha256(after), addedBackupNames: added });
    return { before, after, added };
  };
  const first = await saveTitle('First manual "quoted" title: [alpha] & question?');
  const finalTitle = 'Second manual (title) — [beta] "quote": complete?';
  const second = await saveTitle(finalTitle), same = await saveTitle(finalTitle);
  expect(first.before).toEqual(originalBytes); expect(second.before).toEqual(first.after); expect(same.before).toEqual(second.after); expect(same.after).toEqual(same.before);
  let backups = (await backupNames()).map(name => path.join(captures, name));
  expect(backups).toHaveLength(3);
  const nonFixed = backups.filter(file => { const text = buffers.get(file).toString('utf8'); return !buffers.get(file).equals(Buffer.from(withTitle(text, parse(text).title), 'utf8')); });
  expect(nonFixed.length).toBeLessThanOrEqual(1);
  const controlledNames = [];
  // Only an actual non-fixed writer output warrants this bounded ordering guard.
  // Rename actual files, preserve their bytes/inodes, and still exercise the UI.
  if (nonFixed.length === 1) {
    const fixed = backups.filter(file => file !== nonFixed[0]), ordered = [fixed[0], nonFixed[0], fixed[1]];
    for (let index = 0; index < ordered.length; index++) {
      const from = ordered[index], to = current + `.before-title-${index + 1}0000000-0000-4000-8000-000000000000.bak`;
      await absent([to]);
      const beforeStat = await fs.lstat(from, { bigint: true });
      await fs.rename(from, to);
      const afterStat = await fs.lstat(to, { bigint: true });
      expect([String(afterStat.dev), String(afterStat.ino)]).toEqual([String(beforeStat.dev), String(beforeStat.ino)]);
      expect(await fs.readFile(to)).toEqual(buffers.get(from));
      buffers.set(to, buffers.get(from)); buffers.delete(from);
      controlledNames.push({ from: path.basename(from), to: path.basename(to), byteAndIdentityPreserved: true });
    }
    backups = (await backupNames()).map(name => path.join(captures, name));
    expect(path.basename(backups[1])).toBe(controlledNames[1].to);
  }
  const baseline = nonFixed.length ? backups[1] : backups[0], chain = [baseline, ...backups.filter(file => file !== baseline), current];
  buffers.set(current, same.after);
  const relative = file => path.relative(path.join(root, 'vault'), file).split(path.sep).join('/');
  const expectedProofs = [];
  for (let index = 0; index < chain.length - 1; index++) {
    const before = chain[index], after = chain[index + 1], title = parse(buffers.get(after).toString('utf8')).title;
    expect(buffers.get(after)).toEqual(Buffer.from(withTitle(buffers.get(before).toString('utf8'), title), 'utf8'));
    expectedProofs.push({ before: relative(before), after: relative(after), sourceGeneration: null });
  }
  expectedProofs.sort((a, b) => a.before < b.before ? -1 : a.before > b.before ? 1 : 0);
  const targets = [...backups, current], identities = new Set();
  for (const file of targets) {
    const stat = await fs.lstat(file, { bigint: true });
    expect(stat.isFile()).toBe(true); expect(stat.isSymbolicLink()).toBe(false); expect(stat.nlink).toBe(1n);
    identities.add(`${stat.dev}:${stat.ino}`); expect(await fs.readFile(file)).toEqual(buffers.get(file));
  }
  expect(identities.size).toBe(4);
  expect(await ledger(ledgerFile)).toEqual(originalLedger);
  for (const key of ['captures', 'attempts', 'admissions']) expect(Object.keys(originalLedger?.[key] || {})).toHaveLength(0);
  expect(await fs.readdir(path.join(base, 'Revisions'))).toEqual([]);
  const residue = [current + '.pending', current + '.title-transaction.json', path.join(base, '.intake', 'title-intent.json')];
  await absent(residue);
  await fs.writeFile(testInfo.outputPath('actual-repeated-manual-title-writer.json'), JSON.stringify({ saves: observations, manualBackupCounts: observations.map(item => item.addedBackupNames.length), physicalBackupCount: backups.length, physicalSourceFileCount: targets.length, distinctSingleLinkInodes: identities.size, actualNonFixedBackupCount: nonFixed.length, witness: nonFixed.length ? 'actual non-fixed baseline controlled to lexical middle' : 'all actual backups fixed; lexical-first baseline', controlledNames, expectedProofs }, null, 2));
  const beforePreview = await files(base), preview = page.getByLabel('Capture deletion preview');
  await page.getByRole('button', { name: 'Delete capture', exact: true }).click();
  await expect(preview).toBeVisible(); await expect(preview).toContainText('0 revision snapshots');
  expect((await preview.locator('p').allTextContents()).filter(text => text.startsWith('Remove: ')).sort()).toEqual(targets.map(file => 'Remove: ' + relative(file)).sort());
  expect(await files(base)).toEqual(beforePreview);
  await preview.getByRole('button', { name: 'Cancel capture deletion', exact: true }).click();
  await expect(preview).toBeHidden(); expect(await files(base)).toEqual(beforePreview);
  await page.getByRole('button', { name: 'Delete capture', exact: true }).click();
  await preview.getByRole('button', { name: 'Confirm capture deletion', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('Capture deleted');
  const deleted = await ledger(ledgerFile), authority = deleted.sourceAuthority[originalNote.id];
  expect(authority.phase).toBe('deleted'); expect(authority.inventoryVersion).toBe(1); expect(authority.sourceHash).toBeNull(); expect(authority.originGenerations).toEqual([]);
  expect(authority.titleProofs).toEqual(expectedProofs);
  expect(authority.manual).toEqual({ captureId: originalNote.id, type: originalNote.type, capturedAt: originalNote.capturedAt, currentHash: sha256(same.after), file: captureNames[0], relative: relative(current) });
  expect(authority.targets.map(target => target.file).sort()).toEqual(targets.map(relative).sort());
  for (const file of targets) {
    const target = authority.targets.find(item => item.file === relative(file));
    expect(target.sha256).toBe(sha256(buffers.get(file))); expect(target.kind).toBe(file === current ? 'capture' : 'source-title-backup'); expect(target.peers).toBeUndefined();
  }
  for (const key of ['recovery', 'recoveryPointers', 'purgedProducerAttempts']) expect(authority[key]).toBeUndefined();
  for (const key of ['captures', 'attempts', 'admissions']) expect(deleted[key] || {}).toEqual(originalLedger?.[key] || {});
  expect(deleted.suppressed).toEqual(originalLedger?.suppressed || []);
  expect(JSON.stringify(authority)).not.toContain(body); expect(JSON.stringify(authority)).not.toContain(finalTitle);
  await absent([...targets, ...residue]);
  await app.close(); app = null; await launch();
  await expect(page.locator('#idea-support-status')).toContainText('Current support inspected.');
  await expect(page.locator('#captures article')).toHaveCount(0);
  expect((await ledger(ledgerFile)).sourceAuthority[originalNote.id]).toEqual(authority);
  await absent([...targets, ...residue]);
});

test('restored manual title deletion recovers its actual first-unlink survivor with the original generation', async ({}, testInfo) => {
  test.setTimeout(150000);
  await launch();
  await page.getByRole('button', { name: 'Choose vault', exact: true }).click();
  await page.getByRole('button', { name: 'Use this folder', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('Vault ready.');
  const body = 'MANUALTITLESURVIVOR a saved thought about practising a new chord.\nIts source generation changes only through explicit restoration.';
  await page.getByLabel('Thought or link', { exact: true }).fill(body);
  await page.getByRole('button', { name: 'Save capture', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('Capture saved.');
  const base = path.join(root, 'vault', 'Companion'), captures = path.join(base, 'Captures');
  const names = (await fs.readdir(captures)).filter(name => name.endsWith('.md'));
  expect(names).toHaveLength(1);
  const current = path.join(captures, names[0]), originalBytes = await fs.readFile(current), note = parse(originalBytes.toString('utf8'));
  const selectedBackup = path.join(root, 'explicit-selected-manual-backup.md');
  await fs.writeFile(selectedBackup, originalBytes);
  await page.getByRole('button', { name: 'Delete capture', exact: true }).click();
  await page.getByRole('button', { name: 'Confirm capture deletion', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('Capture deleted');
  const ledgerFile = path.join(base, '.intake', 'ledger.json'), deletedOriginal = await ledger(ledgerFile), originalAuthority = deletedOriginal.sourceAuthority[note.id];
  expect(originalAuthority.phase).toBe('deleted'); expect(originalAuthority.inventoryVersion).toBeUndefined(); expect(originalAuthority.sourceHash).toBeNull();
  await absent([current]); expect(await fs.readFile(selectedBackup)).toEqual(originalBytes);
  await page.getByRole('button', { name: 'Review suppressed captures', exact: true }).click();
  const restoration = page.getByLabel('Source restoration');
  await restoration.getByLabel('Selected manual capture file', { exact: true }).fill(selectedBackup);
  await restoration.getByRole('button', { name: 'Preview source restoration', exact: true }).click();
  await expect(restoration.getByRole('button', { name: 'Confirm source restoration', exact: true })).toBeVisible();
  expect(await ledger(ledgerFile)).toEqual(deletedOriginal);
  await restoration.getByRole('button', { name: 'Confirm source restoration', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('Source restored');
  expect(await fs.readFile(current)).toEqual(originalBytes);
  const restored = await ledger(ledgerFile), active = restored.sourceAuthority[note.id], generation = active.generation;
  expect(active.phase).toBe('active'); expect(generation).not.toBe(originalAuthority.generation);
  expect(active.history).toEqual([originalAuthority]); expect(active.sourceHash).toBeNull();
  const title = 'Manual survivor: original restored generation';
  await page.getByLabel('Display title', { exact: true }).fill(title);
  await page.getByRole('button', { name: 'Save title', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('Title saved.');
  await expect(page.getByRole('heading', { name: title, exact: true })).toBeVisible();
  const backupNames = (await fs.readdir(captures)).filter(name => name.startsWith(names[0] + '.before-title-'));
  expect(backupNames).toHaveLength(1);
  const backup = path.join(captures, backupNames[0]), currentBytes = await fs.readFile(current);
  expect(await fs.readFile(backup)).toEqual(originalBytes);
  expect(currentBytes).toEqual(Buffer.from(withTitle(originalBytes.toString('utf8'), title), 'utf8'));
  const titled = await ledger(ledgerFile); expect(titled).toEqual(restored);
  const targets = [current, backup], relative = file => path.relative(path.join(root, 'vault'), file).split(path.sep).join('/');
  const bytes = new Map([[current, currentBytes], [backup, originalBytes]]), identities = new Map();
  for (const file of targets) {
    const stat = await fs.lstat(file, { bigint: true });
    expect(stat.isFile()).toBe(true); expect(stat.isSymbolicLink()).toBe(false); expect(stat.nlink).toBe(1n);
    identities.set(file, { dev: String(stat.dev), ino: String(stat.ino), bytes: String(stat.size) });
  }
  expect(identities.get(current)).not.toEqual(identities.get(backup));
  const beforePreview = await files(base), preview = page.getByLabel('Capture deletion preview');
  await page.getByRole('button', { name: 'Delete capture', exact: true }).click();
  await expect(preview).toBeVisible(); await expect(preview).toContainText('0 revision snapshots');
  for (const file of targets) await expect(preview).toContainText(relative(file));
  expect(await files(base)).toEqual(beforePreview);
  await preview.getByRole('button', { name: 'Cancel capture deletion', exact: true }).click();
  await expect(preview).toBeHidden(); expect(await files(base)).toEqual(beforePreview);
  const observer = path.join(root, 'manual-title-first-native-unlink.json'), faults = path.join(root, 'faults.json');
  await app.evaluate((_electron, options) => {
    const io = process.getBuiltinModule('fs'), paths = process.getBuiltinModule('path'), nativeUnlink = io.unlinkSync;
    const selected = new Set(options.targets.map(file => paths.resolve(file).toLowerCase()));
    io.unlinkSync = function (file, ...args) {
      const result = nativeUnlink.call(this, file, ...args);
      if (typeof file === 'string' && selected.has(paths.resolve(file).toLowerCase())) {
        io.unlinkSync = nativeUnlink;
        io.writeFileSync(options.observer, JSON.stringify({ mainPid: process.pid, actualFirstRemovedFile: file, nativeUnlinkReturned: true, checkpointArmedAfterActualRemoval: 'capture-deletion-unlinked', controlledSourceOmissions: [] }, null, 2), 'utf8');
        io.writeFileSync(options.faults, JSON.stringify({ pause: 'capture-deletion-unlinked' }), 'utf8');
      }
      return result;
    };
  }, { targets, observer, faults });
  await page.getByRole('button', { name: 'Delete capture', exact: true }).click();
  await page.getByRole('button', { name: 'Confirm capture deletion', exact: true }).click();
  await expect.poll(() => fs.readFile(path.join(root, 'checkpoint.txt'), 'utf8').catch(error => { if (error.code === 'ENOENT') return ''; throw error; })).toBe('capture-deletion-unlinked');
  const nativeObservation = JSON.parse(await fs.readFile(observer, 'utf8'));
  expect(nativeObservation.mainPid).toBe(await app.evaluate(() => process.pid)); expect(nativeObservation.nativeUnlinkReturned).toBe(true); expect(nativeObservation.controlledSourceOmissions).toEqual([]);
  const removed = [], survivors = [];
  for (const file of targets) {
    const present = await fs.access(file).then(() => true, error => { if (error.code === 'ENOENT') return false; throw error; });
    (present ? survivors : removed).push(file);
  }
  expect(removed).toHaveLength(1); expect(survivors).toHaveLength(1); expect(removed[0]).toBe(nativeObservation.actualFirstRemovedFile);
  const survivor = survivors[0], survivorStat = await fs.lstat(survivor, { bigint: true });
  expect(await fs.readFile(survivor)).toEqual(bytes.get(survivor)); expect(survivorStat.nlink).toBe(1n);
  expect({ dev: String(survivorStat.dev), ino: String(survivorStat.ino), bytes: String(survivorStat.size) }).toEqual(identities.get(survivor));
  const authorized = await ledger(ledgerFile), authority = authorized.sourceAuthority[note.id];
  expect(authority.phase).toBe('deleting'); expect(authority.inventoryVersion).toBe(1); expect(authority.sourceHash).toBeNull(); expect(authority.generation).not.toBe(generation);
  expect(authority.originGenerations).toEqual([{ captureId: note.id, generation }]);
  expect(authority.titleProofs).toEqual([{ before: relative(backup), after: relative(current), sourceGeneration: generation }]);
  expect(authority.titleProofs[0].sourceGeneration).not.toBe(authority.generation);
  expect(authority.targets.map(item => item.file).sort()).toEqual(targets.map(relative).sort());
  expect(authority.manual.currentHash).toBe(createHash('sha256').update(currentBytes).digest('hex'));
  expect(authority.history).toEqual(active.history);
  for (const key of ['captures', 'attempts', 'admissions', 'suppressed']) expect(authorized[key]).toEqual(restored[key]);
  expect(JSON.stringify(authority)).not.toContain(body); expect(JSON.stringify(authority)).not.toContain(title);
  for (const key of ['recovery', 'recoveryPointers', 'purgedProducerAttempts']) expect(authority[key]).toBeUndefined();
  await fs.writeFile(testInfo.outputPath('manual-title-first-unlink-survivor.json'), JSON.stringify({ ...nativeObservation, removed: { file: relative(removed[0]), kind: authority.targets.find(item => item.file === relative(removed[0])).kind }, survivor: { file: relative(survivor), kind: authority.targets.find(item => item.file === relative(survivor)).kind, ...identities.get(survivor) }, originalGeneration: generation, deletingGeneration: authority.generation, proof: authority.titleProofs, priorHistory: authority.history, sourceBodyInAuthority: false }, null, 2));
  const child = app.process(), mainPid = nativeObservation.mainPid, exited = new Promise(resolve => child.once('exit', (code, signal) => resolve({ code, signal })));
  const abrupt = app.evaluate(({ app: electronApp }) => electronApp.exit(77)).catch(error => { if (!/closed|disposed/i.test(error.message)) throw error; });
  const wrapperExit = await exited; await abrupt;
  await expect.poll(() => { try { process.kill(mainPid, 0); return 'alive'; } catch (error) { if (error.code === 'ESRCH') return 'exited'; throw error; } }).toBe('exited');
  await fs.writeFile(testInfo.outputPath('manual-title-survivor-main-processes.json'), JSON.stringify({ boundary: 'capture-deletion-unlinked', wrapperPid: child.pid, mainPid, exitBoundary: 'Electron app.exit(77)', wrapperExit }, null, 2));
  app = null;
  await absent(removed); expect(await fs.readFile(survivor)).toEqual(bytes.get(survivor));
  expect(await ledger(ledgerFile)).toEqual(authorized);
  await fs.writeFile(faults, '{}'); await launch();
  await expect.poll(async () => (await ledger(ledgerFile)).sourceAuthority[note.id].phase).toBe('deleted');
  await expect(page.locator('#idea-support-status')).toContainText('Current support inspected.');
  await expect(page.locator('#captures article')).toHaveCount(0);
  const recovered = await ledger(ledgerFile);
  expect(recovered.sourceAuthority[note.id]).toEqual({ ...authority, phase: 'deleted' });
  for (const key of ['captures', 'attempts', 'admissions', 'suppressed']) expect(recovered[key]).toEqual(restored[key]);
  const residue = [current + '.pending', current + '.title-transaction.json', path.join(base, '.intake', 'title-intent.json')];
  await absent([...targets, ...residue]); expect(await fs.readdir(captures)).toEqual([]); expect(await fs.readdir(path.join(base, 'Revisions'))).toEqual([]);
  expect(await fs.readFile(selectedBackup)).toEqual(originalBytes);
  await app.close(); app = null; await launch();
  await expect(page.locator('#idea-support-status')).toContainText('Current support inspected.');
  await expect(page.locator('#captures article')).toHaveCount(0);
  expect((await ledger(ledgerFile)).sourceAuthority[note.id]).toEqual(recovered.sourceAuthority[note.id]);
  await absent([...targets, ...residue]); expect(await fs.readFile(selectedBackup)).toEqual(originalBytes);
});
