const { test, expect, _electron: electron } = require('@playwright/test');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const YAML = require('yaml');
const fixture = require('./fixtures/reel-draft/example.json');
let root, app, page;
const sourceHash = 'a'.repeat(64);
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const fields = bytes => YAML.parse(bytes.toString('utf8').match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/)[1]);

test.beforeEach(async () => { root = await fs.mkdtemp(path.join(os.tmpdir(), 'companion-older-title-')); });
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

test('older imported title deletion reviews five actual source files from two normal admissions without replay', async ({}, testInfo) => {
  test.setTimeout(150000);
  await artifact('first', '1');
  const firstProducer = await files(path.join(root, 'producer', 'first'));
  await launch();
  await page.getByRole('button', { name: 'Choose vault', exact: true }).click();
  await page.getByRole('button', { name: 'Use this folder', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('Vault ready.');
  await expect(page.locator('#idea-support-status')).toContainText('Current support inspected.');
  await page.getByLabel('Draft source folder', { exact: true }).fill(path.join(root, 'producer'));
  await page.getByRole('checkbox', { name: 'Scan existing drafts now', exact: true }).check();
  await page.getByRole('button', { name: 'Connect draft source', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('Intake check complete');
  const base = path.join(root, 'vault', 'Companion'), intake = path.join(base, '.intake'), captures = path.join(base, 'Captures');
  const ledgerFile = path.join(intake, 'ledger.json'), readLedger = async () => JSON.parse(await fs.readFile(ledgerFile, 'utf8'));
  const original = await readLedger(), captureA = original.captures[sourceHash], revisionA = captureA.currentRevision;
  const current = path.join(captures, captureA.file), snapshotA = path.join(base, 'Revisions', revisionA + '.json');
  const originalA = await fs.readFile(current), snapshotABytes = await fs.readFile(snapshotA), originalFields = fields(originalA);
  const admittedA = Object.values(original.attempts).filter(item => item.revision === revisionA);
  expect(admittedA).toHaveLength(1);
  expect(admittedA[0]).toMatchObject({ captureId: captureA.id, sourceHash, snapshotHash: sha256(snapshotABytes) });
  expect(originalFields).toMatchObject({ companion_id: captureA.id, capture_type: 'reel_import', captured_at: captureA.capturedAt, source_hash: sourceHash, source_revision: revisionA });
  const title = 'Older A title: [literal] "quote" & complete?';
  await page.getByLabel('Display title', { exact: true }).fill(title);
  await page.getByRole('button', { name: 'Save title', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('Title saved.');
  await expect(page.getByRole('heading', { name: title, exact: true })).toBeVisible();
  const titledA = await fs.readFile(current), named = await readLedger();
  expect(fields(titledA)).toEqual({ ...originalFields, title });
  const sourceBody = bytes => bytes.toString('utf8').replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n\r?\n#[^\r\n]*\r?\n/, '');
  expect(sourceBody(titledA)).toBe(sourceBody(originalA));
  expect(named.attempts).toEqual(original.attempts); expect(named.admissions).toEqual(original.admissions);
  expect(await fs.readFile(snapshotA)).toEqual(snapshotABytes);
  const adjacentNames = (await fs.readdir(captures)).filter(name => name.startsWith(captureA.file + '.before-title-'));
  expect(adjacentNames).toHaveLength(1);
  expect(adjacentNames[0]).toMatch(/\.md\.before-title-[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}\.bak$/);
  const adjacentA = path.join(captures, adjacentNames[0]);
  expect(await fs.readFile(adjacentA)).toEqual(originalA);
  const residue = [current + '.pending', current + '.title-transaction.json', path.join(intake, 'title-intent.json'), path.join(intake, 'transaction.json')];
  await absent(residue);
  await artifact('second', '2');
  const producerBytes = await files(path.join(root, 'producer'));
  expect(await files(path.join(root, 'producer', 'first'))).toEqual(firstProducer);
  await page.getByRole('button', { name: 'Check now', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('Intake check complete');
  await expect(page.getByRole('heading', { name: title, exact: true })).toBeVisible();
  const completed = await readLedger(), captureB = completed.captures[sourceHash], revisionB = captureB.currentRevision;
  const snapshotB = path.join(base, 'Revisions', revisionB + '.json'), currentB = await fs.readFile(current);
  const intakeNames = await fs.readdir(intake), captureNames = await fs.readdir(captures), snapshotNames = await fs.readdir(path.join(base, 'Revisions'));
  const beforeNames = intakeNames.filter(name => name.endsWith('.before.md'));
  const observedFiles = [current, ...captureNames.filter(name => name.startsWith(captureA.file + '.before-title-')).map(name => path.join(captures, name)), ...snapshotNames.map(name => path.join(base, 'Revisions', name)), ...beforeNames.map(name => path.join(intake, name))];
  const observations = [];
  for (const file of observedFiles) {
    const bytes = await fs.readFile(file), stat = await fs.lstat(file, { bigint: true });
    observations.push({ file, sha256: sha256(bytes), length: bytes.length, dev: String(stat.dev), ino: String(stat.ino), nlink: String(stat.nlink), isFile: stat.isFile(), isSymbolicLink: stat.isSymbolicLink() });
  }
  // Save literal writer evidence before count assumptions or any deletion preview.
  await fs.writeFile(testInfo.outputPath('actual-older-title-writer.json'), JSON.stringify({ revisionA, revisionB, admittedA: admittedA[0], attempts: completed.attempts, admissions: completed.admissions || {}, intakeNames, captureNames, snapshotNames, originalAHash: sha256(originalA), titledAHash: sha256(titledA), currentBHash: sha256(currentB), observations }, null, 2));
  expect(revisionB).not.toBe(revisionA);
  expect(captureB).toMatchObject({ id: captureA.id, file: captureA.file, capturedAt: captureA.capturedAt, title, currentHash: sha256(currentB) });
  expect(captureB.revisions.slice().sort()).toEqual([revisionA, revisionB].sort());
  expect(fields(currentB)).toEqual({ ...originalFields, title, source_revision: revisionB, imported_at: JSON.parse(await fs.readFile(snapshotB, 'utf8')).importedAt });
  expect(currentB).not.toEqual(titledA);
  expect(Object.keys(completed.attempts)).toHaveLength(2);
  expect(completed.attempts[admittedA[0].identity]).toEqual(admittedA[0]);
  expect(completed.admissions).toEqual(original.admissions);
  const admittedB = Object.values(completed.attempts).filter(item => item.revision === revisionB);
  expect(admittedB).toHaveLength(1);
  expect(admittedB[0].identity).not.toBe(admittedA[0].identity);
  expect(admittedB[0]).toMatchObject({ captureId: captureA.id, sourceHash, snapshotHash: sha256(await fs.readFile(snapshotB)) });
  expect(await fs.readFile(snapshotA)).toEqual(snapshotABytes);
  expect(beforeNames).toEqual([captureA.id + '-' + revisionB + '.before.md']);
  const terminalA = path.join(intake, beforeNames[0]);
  expect(await fs.readFile(terminalA)).toEqual(titledA);
  expect(fields(await fs.readFile(terminalA)).source_revision).toBe(revisionA);
  expect(await fs.readFile(adjacentA)).toEqual(originalA);
  expect(observations).toHaveLength(5);
  expect(new Set(observations.map(item => item.dev + ':' + item.ino)).size).toBe(5);
  for (const item of observations) expect({ isFile: item.isFile, isSymbolicLink: item.isSymbolicLink, nlink: item.nlink }).toEqual({ isFile: true, isSymbolicLink: false, nlink: '1' });
  expect(intakeNames.slice().sort()).toEqual(['ledger.json', beforeNames[0]].sort());
  await absent(residue);
  expect(await files(path.join(root, 'producer'))).toEqual(producerBytes);
  const targets = [current, snapshotA, snapshotB, adjacentA, terminalA];
  const relative = file => path.relative(path.join(root, 'vault'), file).split(path.sep).join('/');
  const before = await files(base);
  const raw = await page.evaluate(async id => { try { return { preview: await window.captureDeletion.preview({ id }) }; } catch (error) { return { error: error.message }; } }, captureA.id);
  await fs.writeFile(testInfo.outputPath('actual-older-title-raw-preview.json'), JSON.stringify(raw, null, 2));
  expect(await files(base)).toEqual(before);
  expect(raw.error, 'Actual completed older-title writer must receive a source-only preview').toBeUndefined();
  expect(raw.preview.targets.slice().sort()).toEqual(targets.map(relative).sort());
  expect(raw.preview.revisions).toBe(2);
  await page.evaluate(token => window.captureDeletion.cancel({ token }), raw.preview.token);
  expect(await files(base)).toEqual(before);
  const preview = page.getByLabel('Capture deletion preview');
  await page.getByRole('button', { name: 'Delete capture', exact: true }).click();
  await expect(preview).toBeVisible(); await expect(preview).toContainText('2 revision snapshots');
  expect((await preview.locator('p').allTextContents()).filter(text => text.startsWith('Remove: ')).sort()).toEqual(targets.map(file => 'Remove: ' + relative(file)).sort());
  expect(await files(base)).toEqual(before);
  await preview.getByRole('button', { name: 'Cancel capture deletion', exact: true }).click();
  await expect(preview).toBeHidden(); expect(await files(base)).toEqual(before);
  await page.getByRole('button', { name: 'Delete capture', exact: true }).click();
  await preview.getByRole('button', { name: 'Confirm capture deletion', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('Capture deleted');
  const deleted = await readLedger(), authority = deleted.sourceAuthority[captureA.id];
  expect(authority.phase).toBe('deleted'); expect(authority.inventoryVersion).toBe(2);
  expect(authority.targets.map(item => item.file).sort()).toEqual(targets.map(relative).sort());
  expect(authority.targets.find(item => item.file === relative(terminalA)).kind).toBe('source-backup');
  expect(authority.titleProofs).toEqual([{ before: relative(adjacentA), after: relative(terminalA), snapshot: relative(snapshotA), revisionId: revisionA, sourceGeneration: admittedA[0].sourceGeneration || null }]);
  expect(authority.titleProofs[0].sourceGeneration).not.toBe(authority.generation);
  expect(JSON.stringify(authority)).not.toContain(title);
  expect(deleted.attempts).toEqual(completed.attempts); expect(deleted.admissions).toEqual(completed.admissions);
  expect(deleted.suppressed).toContain(sourceHash);
  await absent([...targets, ...residue]);
  expect(await files(path.join(root, 'producer'))).toEqual(producerBytes);
  await page.getByRole('button', { name: 'Check now', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('Intake check complete');
  await app.close(); app = null; await launch();
  await expect(page.locator('#idea-support-status')).toContainText('Current support inspected.');
  await expect(page.locator('#captures article')).toHaveCount(0);
  const restarted = await readLedger();
  expect(restarted.sourceAuthority[captureA.id]).toEqual(authority);
  expect(restarted.attempts).toEqual(completed.attempts); expect(restarted.admissions).toEqual(completed.admissions);
  await absent([...targets, ...residue]);
  expect(await fs.readdir(captures)).toEqual([]); expect(await fs.readdir(path.join(base, 'Revisions'))).toEqual([]);
  expect(await files(path.join(root, 'producer'))).toEqual(producerBytes);
});
