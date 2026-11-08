const { test, expect, _electron: electron } = require('@playwright/test');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
let root, app, page;
const fixture = require('./fixtures/reel-draft/example.json');
const sha = 'a'.repeat(64);
test.beforeEach(async () => { root = await fs.mkdtemp(path.join(os.tmpdir(), 'companion-intake-')); });
test.afterEach(async () => { if (app) await app.close(); app = null; await fs.rm(root, { recursive: true, force: true }); });
async function artifact(name = 'first', attempt = '1'.repeat(32)) {
  const dir = path.join(root, 'producer', name); await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, 'run.json'), JSON.stringify({ job_id: 'b'.repeat(64), attempt_id: attempt, started_utc: '2026-11-01T10:00:00Z', input_sha256: sha, input_kind: 'local_video', result_kind: 'local_video_unreviewed', state: 'partial', validation: 'passed' }));
  await fs.writeFile(path.join(dir, 'evidence.json'), JSON.stringify({ ...fixture.input, clip_id: 'b'.repeat(64) }));
  await fs.writeFile(path.join(dir, 'first-pass-target.json'), JSON.stringify(fixture.target));
  await fs.copyFile(path.join(__dirname, 'fixtures/reel-draft/notes.md'), path.join(dir, 'notes.md'));
  return dir;
}
async function launch() {
  await fs.writeFile(path.join(root, 'clock.json'), JSON.stringify({ now: '2026-11-08T06:59:00Z', timezone: 'America/Phoenix' }));
  app = await electron.launch({ args: ['.'], env: { ...process.env, COMPANION_TEST_ROOT: root } }); page = await app.firstWindow();
}
async function setup() {
  await page.getByRole('button', { name: 'Choose vault', exact: true }).click();
  await page.getByRole('button', { name: 'Use this folder', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('Vault ready.');
}
async function connect(scan = false) {
  await page.getByLabel('Draft source folder').fill(path.join(root, 'producer'));
  await page.getByRole('checkbox', { name: 'Scan existing drafts now' }).setChecked(scan);
  await page.getByRole('button', { name: 'Connect draft source', exact: true }).click();
  await expect(page.getByRole('status')).toContainText(scan ? 'Intake check complete' : 'Source connected');
}

test('external writing survives restart and transfers to an annotation before incoming source applies', async () => {
  await artifact(); await launch(); await setup(); await connect(true);
  const base = path.join(root, 'vault', 'Companion'), captures = path.join(base, 'Captures');
  const file = path.join(captures, (await fs.readdir(captures)).find(x => x.endsWith('.md')));
  await fs.appendFile(file, '\nMy external observation.\n');
  await artifact('next', '2'.repeat(32));
  const independent = await artifact('independent', '3'.repeat(32));
  const run = JSON.parse(await fs.readFile(path.join(independent, 'run.json'), 'utf8')); run.input_sha256 = 'c'.repeat(64);
  await fs.writeFile(path.join(independent, 'run.json'), JSON.stringify(run));
  await page.getByRole('button', { name: 'Check now', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('Intake check complete');
  await expect(page.getByLabel('Vault repairs')).toContainText('My external observation.');
  await expect(page.locator('#captures article')).toHaveCount(2);
  await app.close(); app = null; await launch();
  await expect(page.getByLabel('Vault repairs')).toContainText('Incoming revision');
  expect(await fs.readFile(file, 'utf8')).toContain('My external observation.');
  await page.getByLabel('Transfer local writing').fill('My external observation.');
  await page.getByRole('button', { name: 'Save annotation and apply incoming', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('Conflict resolved');
  expect(await fs.readFile(file, 'utf8')).not.toContain('My external observation.');
  const annotations = (await fs.readdir(path.join(base, 'Annotations'))).filter(x => x.endsWith('.md'));
  expect(annotations).toHaveLength(1);
  expect(await fs.readFile(path.join(base, 'Annotations', annotations[0]), 'utf8')).toContain('My external observation.');
  await app.close(); app = null; await launch();
  await page.getByRole('button', { name: 'Check now', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('Intake check complete');
  expect((await fs.readdir(path.join(base, 'Annotations'))).filter(x => x.endsWith('.md'))).toHaveLength(1);
});

test('independent annotations stay linked and unchanged after a source revision', async () => {
  await artifact(); await launch(); await setup(); await connect(true);
  await page.getByRole('button', { name: 'Inspect source', exact: true }).click();
  await page.getByLabel('New annotation').fill('My independent interpretation.');
  await page.getByRole('button', { name: 'Save annotation', exact: true }).click();
  await expect(page.getByLabel('Source inspection')).toContainText('My independent interpretation.');
  const dir = path.join(root, 'vault', 'Companion', 'Annotations'), file = (await fs.readdir(dir)).find(x => x.endsWith('.md'));
  const original = await fs.readFile(path.join(dir, file), 'utf8');
  await artifact('next', '2'.repeat(32));
  await page.getByRole('button', { name: 'Check now', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('Intake check complete');
  await app.close(); app = null; await launch();
  await page.getByRole('button', { name: 'Inspect source', exact: true }).click();
  await expect(page.getByLabel('Source inspection')).toContainText('My independent interpretation.');
  expect(await fs.readFile(path.join(dir, file), 'utf8')).toBe(original);
});

test('verified moves keep stable capture identity and repair annotation links before later imports', async () => {
  await artifact(); await launch(); await setup(); await connect(true);
  await page.getByRole('button', { name: 'Inspect source', exact: true }).click();
  await page.getByLabel('New annotation').fill('Keep this relationship.');
  await page.getByRole('button', { name: 'Save annotation', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('Annotation saved');
  const base = path.join(root, 'vault', 'Companion'), dir = path.join(base, 'Captures');
  const original = path.join(dir, (await fs.readdir(dir)).find(x => x.endsWith('.md')));
  const before = await fs.readFile(original, 'utf8'), id = before.match(/companion_id: "([^"]+)"/)[1];
  const moved = path.join(root, 'vault', 'Projects', 'Moved source.md'); await fs.mkdir(path.dirname(moved), { recursive: true }); await fs.rename(original, moved);
  await page.getByRole('button', { name: 'Refresh', exact: true }).click();
  await expect(page.locator('#captures article')).toHaveCount(1);
  await page.getByRole('button', { name: 'Open in Obsidian', exact: true }).click();
  await expect.poll(() => fs.readFile(path.join(root, 'opened-uri.txt'), 'utf8').catch(error => { if (error.code === 'ENOENT') return null; throw error; })).toBe(`obsidian://open?path=${encodeURIComponent(moved)}`);
  const annotations = path.join(base, 'Annotations'), annotation = (await fs.readdir(annotations)).find(x => x.endsWith('.md'));
  const linked = await fs.readFile(path.join(annotations, annotation), 'utf8');
  expect(linked).toContain('../../Projects/Moved%20source.md'); expect(linked).toContain(`capture_id: "${id}"`);
  await artifact('next', '2'.repeat(32));
  await page.getByRole('button', { name: 'Check now', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('Intake check complete');
  expect(await fs.readFile(moved, 'utf8')).toContain(`companion_id: "${id}"`);
  expect(await fs.readFile(original, 'utf8').catch(error => { if (error.code === 'ENOENT') return null; throw error; })).toBeNull();
  expect((await fs.readdir(path.join(base, 'Revisions'))).filter(x => x.endsWith('.json'))).toHaveLength(2);
  await app.close(); app = null; await launch();
  await expect(page.locator('#captures article')).toHaveCount(1);
});

test('duplicate identities preserve both files until explicit selection while independent intake continues', async () => {
  await artifact(); await launch(); await setup(); await connect(true);
  const base = path.join(root, 'vault', 'Companion'), dir = path.join(base, 'Captures'), name = (await fs.readdir(dir)).find(x => x.endsWith('.md'));
  const original = path.join(dir, name), before = await fs.readFile(original, 'utf8');
  const copy = path.join(root, 'vault', 'Projects', 'Copied source.md'); await fs.mkdir(path.dirname(copy), { recursive: true });
  const copied = before + '\nKeep my copied local writing.\n'; await fs.writeFile(copy, copied);
  await artifact('next', '2'.repeat(32));
  const independent = await artifact('independent', '3'.repeat(32)); const run = JSON.parse(await fs.readFile(path.join(independent, 'run.json'), 'utf8')); run.input_sha256 = 'c'.repeat(64); await fs.writeFile(path.join(independent, 'run.json'), JSON.stringify(run));
  await page.getByRole('button', { name: 'Check now', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('Intake check complete');
  await expect(page.getByLabel('Vault repairs')).toContainText('Duplicate identity');
  expect(await fs.readFile(original, 'utf8')).toBe(before); expect(await fs.readFile(copy, 'utf8')).toBe(copied);
  await app.close(); app = null; await launch();
  await expect(page.getByLabel('Vault repairs')).toContainText('Copied source.md');
  await page.getByRole('button', { name: `Use this file: Companion/Captures/${name}`, exact: true }).click();
  await expect(page.getByRole('status')).toContainText('Identity selection saved');
  expect(await fs.readFile(copy, 'utf8')).toBe(copied);
  await page.getByRole('button', { name: 'Check now', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('Intake check complete');
  await expect(page.locator('#captures article')).toHaveCount(2);
  expect(await fs.readFile(copy, 'utf8')).toBe(copied);
  await fs.appendFile(copy, '\nA later change must reopen repair.\n');
  await page.getByRole('button', { name: 'Refresh', exact: true }).click();
  await expect(page.getByLabel('Vault repairs')).toContainText('Duplicate identity');
});

test('missing captures pause until explicit restore or confirmed intake removal with retained history', async () => {
  await artifact(); await launch(); await setup(); await connect(true);
  const base = path.join(root, 'vault', 'Companion'), dir = path.join(base, 'Captures'), name = (await fs.readdir(dir)).find(x => x.endsWith('.md')), file = path.join(dir, name);
  const saved = await fs.readFile(file, 'utf8'); await fs.rename(file, path.join(root, 'user-removed.md'));
  await artifact('next', '2'.repeat(32));
  const independent = await artifact('independent', '3'.repeat(32)); const run = JSON.parse(await fs.readFile(path.join(independent, 'run.json'), 'utf8')); run.input_sha256 = 'c'.repeat(64); await fs.writeFile(path.join(independent, 'run.json'), JSON.stringify(run));
  await page.getByRole('button', { name: 'Check now', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('Intake check complete');
  await expect(page.getByLabel('Vault repairs')).toContainText('Missing managed note');
  expect((await fs.readdir(path.join(base, 'Revisions'))).filter(x => x.endsWith('.json'))).toHaveLength(2);
  expect(await fs.readFile(file, 'utf8').catch(error => { if (error.code === 'ENOENT') return null; throw error; })).toBeNull();
  await app.close(); app = null; await launch();
  await expect(page.getByLabel('Vault repairs')).toContainText('Missing managed note');
  await page.getByRole('button', { name: 'Restore last managed revision', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('Missing capture restored');
  expect(await fs.readFile(file, 'utf8')).toBe(saved);
  await page.getByRole('button', { name: 'Check now', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('Intake check complete');
  expect((await fs.readdir(path.join(base, 'Revisions'))).filter(x => x.endsWith('.json'))).toHaveLength(3);
  await fs.rename(file, path.join(root, 'user-removed-again.md'));
  await page.getByRole('button', { name: 'Refresh', exact: true }).click();
  await expect(page.getByLabel('Vault repairs')).toContainText('Retain revision history and annotations');
  await page.getByRole('button', { name: 'Confirm missing capture removal from intake', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('Missing capture removed from active intake');
  await artifact('third', '4'.repeat(32));
  await page.getByRole('button', { name: 'Check now', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('Intake check complete');
  expect(await fs.readFile(file, 'utf8').catch(error => { if (error.code === 'ENOENT') return null; throw error; })).toBeNull();
  expect((await fs.readdir(path.join(base, 'Revisions'))).filter(x => x.endsWith('.json'))).toHaveLength(3);
  expect(await fs.readFile(path.join(root, 'user-removed.md'), 'utf8')).toBe(saved);
  await expect(page.locator('#captures article')).toHaveCount(1);
});

test('an unavailable vault is an access failure and never becomes missing notes or recreated storage', async () => {
  await artifact(); await launch(); await setup(); await connect(true);
  const vault = path.join(root, 'vault'), offline = path.join(root, 'offline-vault'), base = path.join(vault, 'Companion');
  const ledger = await fs.readFile(path.join(base, '.intake', 'ledger.json'), 'utf8');
  await fs.writeFile(path.join(vault, 'Unrelated.md'), 'Unrelated writing must survive.');
  await fs.rename(vault, offline);
  await page.getByRole('button', { name: 'Refresh', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('Vault access failure');
  await app.close(); app = null; await launch();
  await expect(page.getByRole('status')).toContainText('Vault access failure');
  expect(await fs.stat(vault).then(() => true, error => { if (error.code === 'ENOENT') return false; throw error; })).toBe(false);
  expect(await fs.readFile(path.join(offline, 'Companion', '.intake', 'ledger.json'), 'utf8')).toBe(ledger);
  await fs.rename(offline, vault);
  await page.getByRole('button', { name: 'Refresh', exact: true }).click();
  await expect(page.locator('#captures article')).toHaveCount(1);
  await expect(page.getByLabel('Vault repairs')).not.toContainText('Missing managed note');
  expect(await fs.readFile(path.join(vault, 'Unrelated.md'), 'utf8')).toBe('Unrelated writing must survive.');
});

test('a moved capture conflict transfers writing and applies incoming at its verified destination', async () => {
  await artifact(); await launch(); await setup(); await connect(true);
  const base = path.join(root, 'vault', 'Companion'), dir = path.join(base, 'Captures'), original = path.join(dir, (await fs.readdir(dir)).find(x => x.endsWith('.md')));
  const moved = path.join(root, 'vault', 'Projects', 'Moved edited.md'); await fs.mkdir(path.dirname(moved), { recursive: true }); await fs.rename(original, moved);
  await fs.appendFile(moved, '\nMy moved local writing.\n'); await artifact('next', '2'.repeat(32));
  await page.getByRole('button', { name: 'Check now', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('Intake check complete');
  await expect(page.getByLabel('Vault repairs')).toContainText('My moved local writing.');
  await page.getByLabel('Transfer local writing').fill('My moved local writing.');
  await page.getByRole('button', { name: 'Save annotation and apply incoming', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('Conflict resolved');
  expect(await fs.readFile(moved, 'utf8')).not.toContain('My moved local writing.');
  expect(await fs.readFile(original, 'utf8').catch(error => { if (error.code === 'ENOENT') return null; throw error; })).toBeNull();
  const annotations = path.join(base, 'Annotations'), file = (await fs.readdir(annotations)).find(x => x.endsWith('.md'));
  const content = await fs.readFile(path.join(annotations, file), 'utf8');
  expect(content).toContain('Source: [Capture](../../Projects/Moved%20edited.md)');
  expect(content).toContain('My moved local writing.');
});

test('an edit during conflict resolution preserves both archives and does not block restart or independent intake', async () => {
  await artifact(); await launch(); await setup(); await connect(true);
  const base = path.join(root, 'vault', 'Companion'), dir = path.join(base, 'Captures'), file = path.join(dir, (await fs.readdir(dir)).find(x => x.endsWith('.md')));
  await fs.appendFile(file, '\nFirst external writing.\n'); await artifact('next', '2'.repeat(32));
  await page.getByRole('button', { name: 'Check now', exact: true }).click(); await expect(page.getByRole('status')).toContainText('Intake check complete');
  await expect(page.getByLabel('Vault repairs')).toContainText('First external writing.');
  const intake = path.join(base, '.intake'), archive = (await fs.readdir(intake)).find(x => /^conflict-.*\.json$/.test(x)), originalArchive = await fs.readFile(path.join(intake, archive), 'utf8');
  await fs.writeFile(path.join(root, 'faults.json'), JSON.stringify({ pause: 'repair-annotation-published' }));
  await page.getByLabel('Transfer local writing').fill('First external writing.');
  await page.getByRole('button', { name: 'Save annotation and apply incoming', exact: true }).click();
  await expect.poll(() => fs.readFile(path.join(root, 'checkpoint.txt'), 'utf8').catch(error => { if (error.code === 'ENOENT') return ''; throw error; })).toBe('repair-annotation-published');
  await fs.appendFile(file, '\nSecond external writing during resolution.\n');
  await fs.writeFile(path.join(root, 'release.txt'), 'continue');
  await expect(page.getByRole('status')).toContainText('Annotation preserved. Incoming publication remains paused for repair.');
  await fs.unlink(path.join(root, 'faults.json')); await fs.unlink(path.join(root, 'release.txt'));
  expect(await fs.readFile(path.join(intake, archive), 'utf8')).toBe(originalArchive);
  expect((await fs.readdir(intake)).filter(x => /^conflict-.*\.json$/.test(x))).toHaveLength(2);
  expect(await fs.readFile(file, 'utf8')).toContain('Second external writing during resolution.');
  await app.close(); app = null; await launch();
  await expect(page.getByLabel('Vault repairs')).toContainText('Second external writing during resolution.');
  const independent = await artifact('independent', '3'.repeat(32)), run = JSON.parse(await fs.readFile(path.join(independent, 'run.json'), 'utf8')); run.input_sha256 = 'c'.repeat(64); await fs.writeFile(path.join(independent, 'run.json'), JSON.stringify(run));
  await page.getByRole('button', { name: 'Check now', exact: true }).click(); await expect(page.getByRole('status')).toContainText('Intake check complete');
  await expect(page.locator('#captures article')).toHaveCount(2);
  await page.getByLabel('Transfer local writing').fill('Second external writing during resolution.');
  await page.getByRole('button', { name: 'Save annotation and apply incoming', exact: true }).click(); await expect(page.getByRole('status')).toContainText('Conflict resolved');
  const annotations = path.join(base, 'Annotations'), files = (await fs.readdir(annotations)).filter(x => x.endsWith('.md'));
  expect(files).toHaveLength(2);
  const contents = await Promise.all(files.map(name => fs.readFile(path.join(annotations, name), 'utf8')));
  expect(contents.some(text => text.includes('First external writing.'))).toBe(true);
  expect(contents.some(text => text.includes('Second external writing during resolution.'))).toBe(true);
  expect(await fs.readFile(path.join(intake, archive), 'utf8')).toBe(originalArchive);
});

test('a conflict moved after detection resolves at current verified identity and keeps the current title', async () => {
  await artifact(); await launch(); await setup(); await connect(true);
  const base = path.join(root, 'vault', 'Companion'), dir = path.join(base, 'Captures'), original = path.join(dir, (await fs.readdir(dir)).find(x => x.endsWith('.md')));
  const initial = await fs.readFile(original, 'utf8'), id = initial.match(/companion_id: "([^"]+)"/)[1];
  await fs.appendFile(original, '\nBefore moving local writing.\n'); await artifact('next', '2'.repeat(32));
  await page.getByRole('button', { name: 'Check now', exact: true }).click();
  await expect(page.getByLabel('Vault repairs')).toContainText('Before moving local writing.');
  const intake = path.join(base, '.intake'), archive = (await fs.readdir(intake)).find(x => /^conflict-.*\.json$/.test(x)), archiveBytes = await fs.readFile(path.join(intake, archive), 'utf8');
  const moved = path.join(root, 'vault', 'Projects', 'Conflict moved later.md'); await fs.mkdir(path.dirname(moved), { recursive: true }); await fs.rename(original, moved);
  const edited = (await fs.readFile(moved, 'utf8')).replace(/^title: .*$/m, 'title: "My moved conflict title"'); await fs.writeFile(moved, edited);
  await page.getByRole('button', { name: 'Refresh', exact: true }).click();
  await expect(page.getByLabel('Vault repairs')).toContainText('My moved conflict title');
  await page.getByLabel('Transfer local writing').fill('Before moving local writing.');
  await page.getByRole('button', { name: 'Save annotation and apply incoming', exact: true }).click(); await expect(page.getByRole('status')).toContainText('Conflict resolved');
  const applied = await fs.readFile(moved, 'utf8');
  expect(applied).toContain('title: "My moved conflict title"'); expect(applied).toContain(`companion_id: "${id}"`); expect(applied).toContain('captured_at: "2026-11-08T06:59:00.000Z"');
  expect(await fs.readFile(original, 'utf8').catch(error => { if (error.code === 'ENOENT') return null; throw error; })).toBeNull();
  expect(await fs.readFile(path.join(intake, archive), 'utf8')).toBe(archiveBytes);
  const annotations = path.join(base, 'Annotations'), file = (await fs.readdir(annotations)).find(x => x.endsWith('.md'));
  expect(await fs.readFile(path.join(annotations, file), 'utf8')).toContain('Source: [Capture](../../Projects/Conflict%20moved%20later.md)');
});
