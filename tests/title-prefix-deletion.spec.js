const { test, expect, _electron: electron } = require('@playwright/test');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { randomUUID, createHash } = require('node:crypto');
const YAML = require('yaml');
const fixture = require('./fixtures/reel-draft/example.json');
let root, app, page;

test.beforeEach(async () => { root = await fs.mkdtemp(path.join(os.tmpdir(), 'companion-title-prefix-')); });
test.afterEach(async () => { if (app) await app.close(); app = null; await fs.rm(root, { recursive: true, force: true }); });
async function launch() {
  await fs.writeFile(path.join(root, 'clock.json'), JSON.stringify({ now: '2026-11-08T06:59:00Z', timezone: 'America/Phoenix' }));
  app = await electron.launch({ args: ['.'], env: { ...process.env, COMPANION_TEST_ROOT: root } });
  page = await app.firstWindow();
  await expect(page.locator('#timezone')).toContainText('America/Phoenix');
}
const present = file => fs.lstat(file).then(() => true, error => { if (error.code === 'ENOENT') return false; throw error; });
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
async function identity(file) {
  const stat = await fs.lstat(file, { bigint: true });
  expect(stat.isFile()).toBe(true); expect(stat.isSymbolicLink()).toBe(false); expect(stat.nlink).toBe(1n);
  return { dev: String(stat.dev), ino: String(stat.ino), bytes: String(stat.size) };
}
async function files(folder, prefix = '') {
  const result = {};
  for (const entry of await fs.readdir(folder, { withFileTypes: true })) {
    const file = path.join(folder, entry.name), relative = prefix + entry.name;
    if (entry.isDirectory()) Object.assign(result, await files(file, relative + '/'));
    else result[relative] = (await fs.readFile(file)).toString('base64');
  }
  return result;
}

for (const kind of ['manual thought', 'imported draft']) test(`${kind} deletion holds a new mixed-case title copy after actual first unlink and main exit`, async ({}, testInfo) => {
  test.setTimeout(150000);
  const imported = kind === 'imported draft';
  if (imported) {
    const folder = path.join(root, 'producer', 'first'); await fs.mkdir(folder, { recursive: true });
    await fs.writeFile(path.join(folder, 'run.json'), JSON.stringify({ job_id: 'b'.repeat(64), attempt_id: '1'.repeat(32), started_utc: '2026-11-01T10:00:00Z', input_sha256: 'a'.repeat(64), input_kind: 'local_video', result_kind: 'local_video_unreviewed', state: 'partial', validation: 'passed' }));
    await fs.writeFile(path.join(folder, 'evidence.json'), JSON.stringify({ ...fixture.input, clip_id: 'b'.repeat(64) }));
    await fs.writeFile(path.join(folder, 'first-pass-target.json'), JSON.stringify(fixture.target));
    await fs.copyFile(path.join(__dirname, 'fixtures/reel-draft/notes.md'), path.join(folder, 'notes.md'));
  }
  const producerBefore = imported ? await files(path.join(root, 'producer')) : null;
  await launch();
  await page.getByRole('button', { name: 'Choose vault', exact: true }).click();
  await page.getByRole('button', { name: 'Use this folder', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('Vault ready.');
  if (imported) {
    await page.getByLabel('Draft source folder', { exact: true }).fill(path.join(root, 'producer'));
    await page.getByRole('checkbox', { name: 'Scan existing drafts now', exact: true }).check();
    await page.getByRole('button', { name: 'Connect draft source', exact: true }).click();
    await expect(page.getByRole('status')).toContainText('Intake check complete');
  } else {
    await page.getByLabel('Thought or link', { exact: true }).fill('TITLEPREFIXGUARD A thought about practising a chord.\nRetain this actual source body.');
    await page.getByRole('button', { name: 'Save capture', exact: true }).click();
    await expect(page.getByRole('status')).toContainText('Capture saved.');
  }
  const base = path.join(root, 'vault', 'Companion'), captures = path.join(base, 'Captures');
  const ledgerFile = path.join(base, '.intake', 'ledger.json');
  const readLedger = () => fs.readFile(ledgerFile, 'utf8').then(JSON.parse);
  const names = (await fs.readdir(captures)).filter(name => name.endsWith('.md')); expect(names).toHaveLength(1);
  const current = path.join(captures, names[0]), originalBytes = await fs.readFile(current);
  const frontmatter = bytes => YAML.parse(bytes.toString('utf8').match(/^---\r?\n([\s\S]*?)\r?\n---/)[1]);
  const source = frontmatter(originalBytes), sourceId = source.companion_id, title = 'Completed title before arriving case copy';
  expect(sourceId).toMatch(/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/);
  await page.getByLabel('Display title', { exact: true }).fill(title);
  await page.getByRole('button', { name: 'Save title', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('Title saved.');
  await expect(page.getByRole('heading', { name: title, exact: true })).toBeVisible();
  const backupNames = (await fs.readdir(captures)).filter(name => name.startsWith(names[0] + '.before-title-'));
  expect(backupNames).toHaveLength(1);
  const backup = path.join(captures, backupNames[0]), currentBytes = await fs.readFile(current);
  expect(await fs.readFile(backup)).toEqual(originalBytes);
  expect(frontmatter(currentBytes)).toEqual({ ...source, title });
  const body = bytes => bytes.toString('utf8').split(/\r?\n---\r?\n/)[1].replace(/^\n# [^\n]*\n/, '');
  expect(body(currentBytes)).toBe(body(originalBytes));
  const titled = await fs.readFile(ledgerFile, 'utf8').then(JSON.parse, error => { if (error.code === 'ENOENT') return null; throw error; });
  const targets = [current, backup];
  if (imported) targets.push(path.join(base, 'Revisions', titled.captures['a'.repeat(64)].currentRevision + '.json'));
  const bytes = new Map(), identities = new Map();
  for (const file of targets) { bytes.set(file, await fs.readFile(file)); identities.set(file, await identity(file)); }
  expect(new Set([...identities.values()].map(value => value.dev + ':' + value.ino)).size).toBe(targets.length);
  const relative = file => path.relative(path.join(root, 'vault'), file).split(path.sep).join('/');
  await page.getByRole('button', { name: 'Delete capture', exact: true }).click();
  const preview = page.getByLabel('Capture deletion preview'); await expect(preview).toBeVisible();
  expect((await preview.locator('p').allTextContents()).filter(text => text.startsWith('Remove: ')).sort()).toEqual(targets.map(file => 'Remove: ' + relative(file)).sort());
  const observer = path.join(root, 'first-native-unlink.json'), faults = path.join(root, 'faults.json');
  // Observe the real filesystem boundary; do not omit or replace source files.
  await app.evaluate((_electron, options) => {
    const io = process.getBuiltinModule('fs').promises, nativeUnlink = io.unlink;
    io.unlink = async function (file, ...args) {
      const result = await nativeUnlink.call(this, file, ...args);
      if (options.targets.includes(file)) {
        io.unlink = nativeUnlink;
        await io.writeFile(options.observer, JSON.stringify({ mainPid: process.pid, actualFirstRemovedFile: file, nativeUnlinkReturned: true, controlledSourceOmissions: [] }));
        await io.writeFile(options.faults, JSON.stringify({ pause: 'capture-deletion-unlinked' }));
      }
      return result;
    };
  }, { targets, observer, faults });
  await preview.getByRole('button', { name: 'Confirm capture deletion', exact: true }).click();
  await expect.poll(() => fs.readFile(path.join(root, 'checkpoint.txt'), 'utf8').catch(error => { if (error.code === 'ENOENT') return ''; throw error; })).toBe('capture-deletion-unlinked');
  const observed = JSON.parse(await fs.readFile(observer, 'utf8')), removed = [], survivors = [];
  expect(observed.mainPid).toBe(await app.evaluate(() => process.pid)); expect(observed.nativeUnlinkReturned).toBe(true);
  for (const file of targets) (await present(file) ? survivors : removed).push(file);
  expect(removed).toEqual([observed.actualFirstRemovedFile]); expect(survivors).toHaveLength(targets.length - 1);
  for (const file of survivors) { expect(await fs.readFile(file)).toEqual(bytes.get(file)); expect(await identity(file)).toEqual(identities.get(file)); }
  const authorized = await readLedger(), authority = authorized.sourceAuthority[sourceId];
  expect(authority.phase).toBe('deleting'); expect(authority.inventoryVersion).toBe(imported ? 2 : 1);
  expect(authority.targets.map(target => target.file).sort()).toEqual(targets.map(relative).sort());
  const child = app.process(), exited = new Promise(resolve => child.once('exit', (code, signal) => resolve({ code, signal })));
  const abrupt = app.evaluate(({ app: electronApp }) => electronApp.exit(77)).catch(error => { if (!/closed|disposed/i.test(error.message)) throw error; });
  const wrapperExit = await exited; await abrupt;
  await expect.poll(() => { try { process.kill(observed.mainPid, 0); return 'alive'; } catch (error) { if (error.code === 'ESRCH') return 'exited'; throw error; } }).toBe('exited');
  app = null;
  const copyFrom = survivors.find(file => file === backup) || survivors.find(file => file === current);
  expect(copyFrom).toBeTruthy();
  const literalSurvivingBytes = await fs.readFile(copyFrom), alias = current + `.BeFoRe-TiTlE-${randomUUID()}.bak`;
  expect(frontmatter(literalSurvivingBytes).companion_id).toBe(sourceId); expect(await present(alias)).toBe(false);
  await fs.writeFile(alias, literalSurvivingBytes, { flag: 'wx' });
  const aliasIdentity = await identity(alias);
  expect(aliasIdentity).not.toEqual(identities.get(copyFrom)); expect(await fs.readFile(alias)).toEqual(literalSurvivingBytes);
  for (const file of survivors) { expect(await fs.readFile(file)).toEqual(bytes.get(file)); expect(await identity(file)).toEqual(identities.get(file)); }
  expect(await present(removed[0])).toBe(false); expect(await readLedger()).toEqual(authorized);
  const evidence = { kind, actualWriter: { current: relative(current), backup: relative(backup), beforeSha256: sha256(originalBytes), afterSha256: sha256(currentBytes) }, ...observed, wrapperExit, actualMainExited: true, removed: removed.map(relative), survivors: survivors.map(file => ({ file: relative(file), kind: authority.targets.find(target => target.file === relative(file)).kind, ...identities.get(file) })), controlledArrival: { file: relative(alias), copiedFrom: relative(copyFrom), sha256: sha256(literalSurvivingBytes), ...aliasIdentity }, originalDeletingAuthority: authority };
  await fs.writeFile(testInfo.outputPath('title-prefix-reached-boundaries.json'), JSON.stringify(evidence, null, 2));
  await fs.writeFile(faults, '{}'); await launch();
  await expect(page.locator('#idea-support-status')).toContainText('Current support inspected.');
  const recovered = await readLedger();
  evidence.afterRestart = { phase: recovered.sourceAuthority[sourceId].phase, aliasPresent: await present(alias), originalTargets: await Promise.all(targets.map(async file => ({ file: relative(file), present: await present(file) }))) };
  await fs.writeFile(testInfo.outputPath('title-prefix-reached-boundaries.json'), JSON.stringify(evidence, null, 2));
  expect(recovered.sourceAuthority[sourceId]).toEqual(authority);
  for (const file of survivors) { expect(await fs.readFile(file)).toEqual(bytes.get(file)); expect(await identity(file)).toEqual(identities.get(file)); }
  expect(await present(removed[0])).toBe(false); expect(await fs.readFile(alias)).toEqual(literalSurvivingBytes); expect(await identity(alias)).toEqual(aliasIdentity);
  for (const key of ['captures', 'attempts', 'admissions', 'suppressed']) expect(recovered[key]).toEqual(authorized[key]);
  if (imported) expect(await files(path.join(root, 'producer'))).toEqual(producerBefore);
});
