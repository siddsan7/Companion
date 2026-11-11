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
test('explicit draft scan imports source evidence and immutable revision across restart', async () => {
  await artifact(); await launch(); await setup(); await connect();
  await expect(page.getByRole('heading', { name: fixture.target.title, exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'Check now', exact: true }).click();
  await expect(page.getByRole('heading', { name: fixture.target.title, exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Inspect source', exact: true }).click();
  await expect(page.getByLabel('Source inspection')).toContainText('Human review: unreviewed');
  await expect(page.getByLabel('Source inspection')).toContainText('Extraction: partial');
  await expect(page.getByLabel('Source inspection')).toContainText('v1');
  const base = path.join(root, 'vault', 'Companion');
  const notes = (await fs.readdir(path.join(base, 'Captures'))).filter(x => x.endsWith('.md'));
  expect(notes).toHaveLength(1);
  expect(await fs.readFile(path.join(base, 'Captures', notes[0]), 'utf8')).toContain('captured_at: "2026-11-08T06:59:00.000Z"');
  expect((await fs.readdir(path.join(base, 'Revisions'))).filter(x => x.endsWith('.json'))).toHaveLength(1);
  await app.close(); app = null; await launch();
  await page.getByRole('button', { name: 'Check now', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('Intake check complete');
  expect((await fs.readdir(path.join(base, 'Revisions'))).filter(x => x.endsWith('.json'))).toHaveLength(1);
});
test('same source bytes group distinct attempts and preserve user title and first capture time', async () => {
  await artifact(); await launch(); await setup(); await connect(true);
  await page.getByLabel('Display title').fill('My stable source title');
  await page.getByRole('button', { name: 'Save title', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('Title saved.');
  await artifact('second', '2'.repeat(32));
  await fs.writeFile(path.join(root, 'clock.json'), JSON.stringify({ now: '2026-11-09T06:59:00Z', timezone: 'America/Phoenix' }));
  await page.getByRole('button', { name: 'Check now', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('Intake check complete');
  await page.getByRole('button', { name: 'All captures', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'My stable source title', exact: true })).toBeVisible();
  await expect(page.locator('#captures article')).toHaveCount(1);
  await expect(page.locator('#captures article')).toContainText('Updated source');
  await page.getByRole('button', { name: 'Inspect source', exact: true }).click();
  const inspection = page.getByLabel('Source inspection');
  await expect(inspection.locator('article')).toHaveCount(2);
  await expect(inspection).toContainText('First captured: 2026-11-08T06:59:00.000Z');
  const base = path.join(root, 'vault', 'Companion');
  const files = (await fs.readdir(path.join(base, 'Captures'))).filter(x => x.endsWith('.md'));
  expect(files).toHaveLength(1);
  expect(await fs.readFile(path.join(base, 'Captures', files[0]), 'utf8')).toContain('captured_at: "2026-11-08T06:59:00.000Z"');
  const snapshots = (await fs.readdir(path.join(base, 'Revisions'))).filter(x => x.endsWith('.json'));
  expect(snapshots).toHaveLength(2);
  expect(new Set(await Promise.all(snapshots.map(async file => JSON.parse(await fs.readFile(path.join(base, 'Revisions', file), 'utf8')).run.attempt_id)))).toEqual(new Set(['1'.repeat(32), '2'.repeat(32)]));
});
test('ambiguous copies across sources and incomplete transfers are held while independent ready drafts continue', async () => {
  const first = await artifact();
  const copy = path.join(root, 'other-source', 'ambiguous'); await fs.mkdir(copy, { recursive: true });
  await fs.cp(first, copy, { recursive: true });
  const run = JSON.parse(await fs.readFile(path.join(copy, 'run.json'), 'utf8')); run.started_utc = '2026-11-02T10:00:00Z';
  await fs.writeFile(path.join(copy, 'run.json'), JSON.stringify(run));
  const independent = await artifact('independent', '3'.repeat(32));
  const independentRun = JSON.parse(await fs.readFile(path.join(independent, 'run.json'), 'utf8')); independentRun.input_sha256 = 'c'.repeat(64);
  await fs.writeFile(path.join(independent, 'run.json'), JSON.stringify(independentRun));
  const partial = await artifact('incomplete', '4'.repeat(32)); await fs.unlink(path.join(partial, 'notes.md'));
  await launch(); await setup(); await connect();
  await page.getByLabel('Draft source folder').fill(path.join(root, 'other-source'));
  await page.getByRole('button', { name: 'Connect draft source', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('Source connected');
  await page.getByRole('button', { name: 'Check now', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('Intake check complete');
  await expect(page.locator('#captures article')).toHaveCount(1);
  await expect(page.locator('#held-imports')).toContainText('Ambiguous attempt identity');
  await expect(page.locator('#held-imports')).toContainText('Incomplete transfer');
  await app.close(); app = null; await launch();
  await expect(page.locator('#held-imports')).toContainText('Ambiguous attempt identity');
  // Resolution is an explicit producer repair and retry, never a filename guess.
  await fs.rm(copy, { recursive: true }); await fs.copyFile(path.join(__dirname, 'fixtures/reel-draft/notes.md'), path.join(partial, 'notes.md'));
  await page.getByRole('button', { name: 'Check now', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('Intake check complete');
  await expect(page.locator('#captures article')).toHaveCount(2);
  await expect(page.locator('#held-imports')).toHaveText('No held imports.');
});
test('interrupted snapshot staging recovers once and overlapping checks cannot publish', async () => {
  await artifact(); await launch(); await setup(); await connect();
  const base = path.join(root, 'vault', 'Companion');
  const faults = path.join(root, 'faults.json');
  const transaction = path.join(base, '.intake', 'transaction.json');
  const check = page.getByRole('button', { name: 'Check now', exact: true });
  const expectNoPublication = async () => {
    expect((await fs.readdir(path.join(base, 'Revisions'))).filter(x => x.endsWith('.json'))).toHaveLength(0);
    expect((await fs.readdir(path.join(base, 'Captures'))).filter(x => x.endsWith('.md'))).toHaveLength(0);
  };
  await fs.writeFile(faults, JSON.stringify({ pause: 'intake-snapshot-staged' }));
  try {
    await check.click();
    await expect.poll(() => fs.readFile(path.join(root, 'checkpoint.txt'), 'utf8').catch(() => '')).toBe('intake-snapshot-staged');
    await expect(check).toBeDisabled();
    await expectNoPublication();
    const heldTransaction = await fs.readFile(transaction);
    const mainPid = await app.evaluate((_, root) => {
      if (process.env.COMPANION_TEST_ROOT !== root) throw Error('Crash recovery requires the disposable fixture.');
      return process.pid;
    }, root);

    const execFile = require('node:util').promisify(require('node:child_process').execFile);
    const script = `
      const path = require('node:path');
      const [appDir, vault, parent] = process.argv.slice(1);
      const { Intake } = require(path.join(appDir, 'intake.js'));
      const { Vault } = require(path.join(appDir, 'vault.js'));
      new Intake(new Vault(vault, parent)).reconcile({ trigger: 'manual', now: '2026-11-08T06:59:00Z' }).then(
        () => console.log(JSON.stringify({ pid: process.pid, admitted: true })),
        error => console.log(JSON.stringify({ pid: process.pid, code: error.code, message: error.message }))
      );
    `;
    const { stdout } = await execFile(process.execPath, ['-e', script, '--', path.resolve(__dirname, '../app'), path.dirname(base), path.basename(base)]);
    const contender = JSON.parse(stdout);
    expect(contender.pid).not.toBe(mainPid);
    expect(contender).toMatchObject({ code: 'INTAKE_BUSY', message: 'An intake check is already running. Wait for it to finish.' });
    await expect(check).toBeDisabled();
    await expectNoPublication();
    expect(await fs.readFile(transaction)).toEqual(heldTransaction);

    const exited = new Promise(resolve => app.process().once('exit', resolve));
    const crash = app.evaluate(({ app: electronApp }, { root, mainPid }) => {
      if (process.env.COMPANION_TEST_ROOT !== root || process.pid !== mainPid) throw Error('The staged write owner changed.');
      electronApp.exit(77);
    }, { root, mainPid }).catch(error => { if (!/closed|disposed/i.test(error.message)) throw error; });
    await Promise.all([exited, crash]);
    await expect.poll(() => {
      try { process.kill(mainPid, 0); return 'alive'; }
      catch (error) { if (error.code === 'ESRCH') return 'exited'; throw error; }
    }).toBe('exited');
    app = null;
  } finally {
    if (app) await fs.writeFile(path.join(root, 'release.txt'), 'continue after fixture failure');
  }
  await fs.unlink(faults); await launch();
  await expect(page.getByRole('heading', { name: fixture.target.title, exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Check now', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('Intake check complete');
  expect((await fs.readdir(path.join(base, 'Revisions'))).filter(x => x.endsWith('.json'))).toHaveLength(1);
  expect((await fs.readdir(path.join(base, 'Captures'))).filter(x => x.endsWith('.md'))).toHaveLength(1);
  await expect(fs.access(transaction)).rejects.toMatchObject({ code: 'ENOENT' });
});
test('repairing a damaged artifact retains its imported attempt identity without duplicate snapshots', async () => {
  const dir = await artifact(); await launch(); await setup(); await connect(true);
  const base = path.join(root, 'vault', 'Companion');
  const snapshots = (await fs.readdir(path.join(base, 'Revisions'))).filter(x => x.endsWith('.json'));
  const original = await fs.readFile(path.join(base, 'Revisions', snapshots[0]), 'utf8');
  await fs.appendFile(path.join(dir, 'notes.md'), '\nUnvalidated extra text.');
  await page.getByRole('button', { name: 'Check now', exact: true }).click();
  await expect(page.locator('#held-imports')).toContainText('Notes do not match');
  await app.close(); app = null; await launch();
  await expect(page.locator('#timezone')).toContainText('America/Phoenix');
  await fs.copyFile(path.join(__dirname, 'fixtures/reel-draft/notes.md'), path.join(dir, 'notes.md'));
  await page.getByRole('button', { name: 'Check now', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('Intake check complete');
  expect((await fs.readdir(path.join(base, 'Revisions'))).filter(x => x.endsWith('.json'))).toEqual(snapshots);
  expect(await fs.readFile(path.join(base, 'Revisions', snapshots[0]), 'utf8')).toBe(original);
  await expect(page.locator('#captures article')).toHaveCount(1);
});
test('a recovered user title remains owned by the user when a later attempt arrives', async () => {
  await artifact(); await launch(); await setup(); await connect(true);
  await fs.writeFile(path.join(root, 'faults.json'), JSON.stringify({ pause: 'title-staged' }));
  await page.getByLabel('Display title').fill('Recovered user title');
  await page.getByRole('button', { name: 'Save title', exact: true }).click();
  await expect.poll(() => fs.readFile(path.join(root, 'checkpoint.txt'), 'utf8').catch(() => '')).toBe('title-staged');
  app.process().kill(); await app.close().catch(() => {}); app = null;
  await fs.unlink(path.join(root, 'faults.json')); await launch();
  await expect(page.getByRole('heading', { name: 'Recovered user title', exact: true })).toBeVisible();
  await artifact('second', '2'.repeat(32));
  await page.getByRole('button', { name: 'Check now', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('Intake check complete');
  expect((await fs.readdir(path.join(root, 'vault', 'Companion', 'Revisions'))).filter(x => x.endsWith('.json'))).toHaveLength(2);
  await expect(page.getByRole('heading', { name: 'Recovered user title', exact: true })).toBeVisible();
  await page.getByLabel('Display title').fill('Still editable after an import');
  await page.getByRole('button', { name: 'Save title', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('Title saved.');
});
test('an external edit during revision publication preserves local writing and independent intake', async () => {
  await artifact('a-original'); await launch(); await setup(); await connect(true);
  const base = path.join(root, 'vault', 'Companion'), captures = path.join(base, 'Captures');
  const filename = (await fs.readdir(captures)).find(x => x.endsWith('.md')), destination = path.join(captures, filename);
  const local = (await fs.readFile(destination, 'utf8')) + '\nIndependent local writing.\n';
  await artifact('b-update', '2'.repeat(32));
  const independent = await artifact('z-independent', '3'.repeat(32));
  const run = JSON.parse(await fs.readFile(path.join(independent, 'run.json'), 'utf8')); run.input_sha256 = 'c'.repeat(64);
  await fs.writeFile(path.join(independent, 'run.json'), JSON.stringify(run));
  await fs.writeFile(path.join(root, 'faults.json'), JSON.stringify({ pause: 'intake-moved' }));
  await page.getByRole('button', { name: 'Check now', exact: true }).click();
  await expect.poll(() => fs.readFile(path.join(root, 'checkpoint.txt'), 'utf8').catch(() => '')).toBe('intake-moved');
  await fs.writeFile(destination, local); await fs.writeFile(path.join(root, 'release.txt'), 'continue');
  await expect(page.locator('#captures article')).toHaveCount(2);
  await expect(page.locator('#held-imports')).toContainText('Destination changed outside Companion');
  expect(await fs.readFile(destination, 'utf8')).toBe(local);
  await app.close(); app = null; await fs.unlink(path.join(root, 'faults.json')); await launch();
  await expect(page.locator('#captures article')).toHaveCount(2);
  await page.getByRole('button', { name: 'Check now', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('Intake check complete');
  expect(await fs.readFile(destination, 'utf8')).toBe(local);
  await expect(page.locator('#captures article')).toHaveCount(2);
});
test('a file-specific snapshot destination failure pauses only its source and preserves independent intake', async () => {
  await artifact('a-original'); await launch(); await setup(); await connect(true);
  const base = path.join(root, 'vault', 'Companion'), captures = path.join(base, 'Captures');
  const filename = (await fs.readdir(captures)).find(x => x.endsWith('.md'));
  const original = await fs.readFile(path.join(captures, filename), 'utf8');
  await artifact('b-update', '2'.repeat(32));
  const independent = await artifact('z-independent', '3'.repeat(32));
  const run = JSON.parse(await fs.readFile(path.join(independent, 'run.json'), 'utf8')); run.input_sha256 = 'c'.repeat(64);
  await fs.writeFile(path.join(independent, 'run.json'), JSON.stringify(run));
  await fs.writeFile(path.join(root, 'faults.json'), JSON.stringify({ pause: 'intake-snapshot-staged' }));
  await page.getByRole('button', { name: 'Check now', exact: true }).click();
  await expect.poll(() => fs.readFile(path.join(root, 'checkpoint.txt'), 'utf8').catch(() => '')).toBe('intake-snapshot-staged');
  const tx = JSON.parse(await fs.readFile(path.join(base, '.intake', 'transaction.json'), 'utf8'));
  const unexpected = path.join(base, 'Revisions', `${tx.revision.id}.json`);
  const stage = path.join(base, '.intake', `${tx.revision.id}.snapshot.stage`);
  const staged = await fs.readFile(stage, 'utf8');
  await fs.mkdir(unexpected); await fs.writeFile(path.join(unexpected, 'keep.txt'), 'Preserve this unexpected directory.');
  await fs.writeFile(path.join(root, 'release.txt'), 'continue');
  await expect(page.locator('#captures article')).toHaveCount(2);
  await expect(page.locator('#held-imports')).toContainText('Immutable revision snapshot');
  expect(await fs.readFile(path.join(captures, filename), 'utf8')).toBe(original);
  expect(await fs.readFile(stage, 'utf8')).toBe(staged);
  expect(await fs.readFile(path.join(unexpected, 'keep.txt'), 'utf8')).toBe('Preserve this unexpected directory.');
  await app.close(); app = null; await fs.unlink(path.join(root, 'faults.json')); await launch();
  await expect(page.locator('#captures article')).toHaveCount(2);
  await page.getByRole('button', { name: 'Check now', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('Intake check complete');
  await expect(page.locator('#captures article')).toHaveCount(2);
});
test('a locked capture destination does not block independent intake or publish a partial update', async () => {
  await artifact('a-original'); await launch(); await setup(); await connect(true);
  const base = path.join(root, 'vault', 'Companion'), captures = path.join(base, 'Captures');
  const filename = (await fs.readdir(captures)).find(x => x.endsWith('.md'));
  const original = await fs.readFile(path.join(captures, filename), 'utf8');
  await artifact('b-update', '2'.repeat(32));
  const independent = await artifact('z-independent', '3'.repeat(32));
  const run = JSON.parse(await fs.readFile(path.join(independent, 'run.json'), 'utf8')); run.input_sha256 = 'c'.repeat(64);
  await fs.writeFile(path.join(independent, 'run.json'), JSON.stringify(run));
  await fs.writeFile(path.join(root, 'faults.json'), JSON.stringify({ fail: 'intake-before-move', code: 'EACCES' }));
  await page.getByRole('button', { name: 'Check now', exact: true }).click();
  await expect(page.locator('#captures article')).toHaveCount(2);
  await expect(page.locator('#held-imports')).toContainText('Capture destination is locked');
  expect(await fs.readFile(path.join(captures, filename), 'utf8')).toBe(original);
  await fs.unlink(path.join(root, 'faults.json')); await app.close(); app = null; await launch();
  await expect(page.locator('#captures article')).toHaveCount(2);
  expect(await fs.readFile(path.join(captures, filename), 'utf8')).toBe(original);
  await page.getByRole('button', { name: 'Check now', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('Intake check complete');
  await expect(page.locator('#held-imports')).toHaveText('No held imports.');
  await page.locator('#captures article').filter({ hasText: 'Updated source' }).getByRole('button', { name: 'Inspect source', exact: true }).click();
  await expect(page.getByLabel('Source inspection').locator('article')).toHaveCount(2);
});
for (const [kind, alias] of [['snapshot', 'hardlink'], ['capture', 'hardlink'], ['snapshot', 'symlink']]) {
  test(`${kind} staging refuses a mutable outside ${alias} while independent intake continues`, async () => {
    if (alias === 'symlink') {
      const probe = path.join(root, 'symlink-probe'), target = path.join(root, 'probe-target'); await fs.writeFile(target, 'probe');
      try { await fs.symlink(target, probe, 'file'); } catch (error) { if (error.code === 'EPERM') test.skip(true, 'Actual Windows file-symlink capability is unavailable (EPERM); hardlink aliases are tested.'); throw error; }
      await fs.unlink(probe);
    }
    await artifact('a-original'); await launch(); await setup(); await connect(true);
    const base = path.join(root, 'vault', 'Companion'), captures = path.join(base, 'Captures');
    const filename = (await fs.readdir(captures)).find(x => x.endsWith('.md'));
    const original = await fs.readFile(path.join(captures, filename), 'utf8');
    await artifact('b-update', '2'.repeat(32));
    const independent = await artifact('z-independent', '3'.repeat(32));
    const run = JSON.parse(await fs.readFile(path.join(independent, 'run.json'), 'utf8')); run.input_sha256 = 'c'.repeat(64);
    await fs.writeFile(path.join(independent, 'run.json'), JSON.stringify(run));
    const checkpoint = kind === 'snapshot' ? 'intake-snapshot-staged' : 'intake-capture-staged';
    await fs.writeFile(path.join(root, 'faults.json'), JSON.stringify({ pause: checkpoint }));
    await page.getByRole('button', { name: 'Check now', exact: true }).click();
    await expect.poll(() => fs.readFile(path.join(root, 'checkpoint.txt'), 'utf8').catch(() => '')).toBe(checkpoint);
    const tx = JSON.parse(await fs.readFile(path.join(base, '.intake', 'transaction.json'), 'utf8'));
    const stage = path.join(base, '.intake', `${tx.revision.id}.${kind === 'snapshot' ? 'snapshot.stage' : 'stage'}`);
    const outside = path.join(root, 'outside-stage-copy'), bytes = await fs.readFile(stage, 'utf8');
    await fs.writeFile(outside, bytes); await fs.unlink(stage);
    if (alias === 'symlink') await fs.symlink(outside, stage, 'file'); else await fs.link(outside, stage);
    await fs.writeFile(path.join(root, 'release.txt'), 'continue');
    await expect(page.locator('#captures article')).toHaveCount(2);
    await expect(page.locator('#held-imports')).toContainText('Unsafe import staging file');
    expect(await fs.readFile(path.join(captures, filename), 'utf8')).toBe(original);
    expect(await fs.readFile(outside, 'utf8')).toBe(bytes);
    await app.close(); app = null; await fs.unlink(path.join(root, 'faults.json')); await launch();
    await expect(page.locator('#captures article')).toHaveCount(2);
    expect(await fs.readFile(outside, 'utf8')).toBe(bytes);
    expect(await fs.readFile(path.join(captures, filename), 'utf8')).toBe(original);
  });
}
test('restored capture backup refuses an equal-byte outside hardlink before independent recovery', async () => {
  // Two publication boundaries and a restart exercise the public recovery path.
  test.setTimeout(45000);
  await artifact('a-original'); await launch(); await setup(); await connect(true);
  const base = path.join(root, 'vault', 'Companion'), intake = path.join(base, '.intake');
  const captures = path.join(base, 'Captures'), filename = (await fs.readdir(captures)).find(x => x.endsWith('.md'));
  const file = path.join(captures, filename), original = await fs.readFile(file, 'utf8');
  await artifact('b-update', '2'.repeat(32));
  await fs.writeFile(path.join(root, 'faults.json'), JSON.stringify({ pause: 'intake-capture-staged' }));
  await page.getByRole('button', { name: 'Check now', exact: true }).click();
  await expect.poll(() => fs.readFile(path.join(root, 'checkpoint.txt'), 'utf8').catch(() => '')).toBe('intake-capture-staged');
  const tx = JSON.parse(await fs.readFile(path.join(intake, 'transaction.json'), 'utf8'));
  const incomingStage = path.join(intake, tx.revision.id + '.stage'), outsideIncoming = path.join(root, 'outside-incoming');
  await fs.copyFile(incomingStage, outsideIncoming); await fs.unlink(incomingStage); await fs.link(outsideIncoming, incomingStage);
  await fs.writeFile(path.join(root, 'release.txt'), 'continue');
  await expect(page.getByRole('status')).toHaveText('Intake check complete. Inspect held imports and source errors.');
  await expect(page.locator('#held-imports')).toContainText('Unsafe import staging file');
  await app.close(); app = null;
  const backup = path.join(intake, tx.backup), independent = backup + '.independent';
  expect(await fs.readFile(backup, 'utf8')).toBe(original);
  // Reproduce the persisted known-peer state before its independent-copy step.
  await fs.unlink(backup); await fs.link(file, backup);
  await fs.unlink(path.join(root, 'release.txt'));
  await fs.writeFile(path.join(root, 'faults.json'), JSON.stringify({ pause: 'intake-restored-backup-independent' }));
  await launch();
  await expect.poll(() => fs.readFile(path.join(root, 'checkpoint.txt'), 'utf8').catch(() => '')).toBe('intake-restored-backup-independent');
  const outside = path.join(root, 'outside-independent');
  await fs.writeFile(outside, original); await fs.unlink(independent); await fs.link(outside, independent);
  const before = await fs.stat(file, { bigint: true });
  await fs.writeFile(path.join(root, 'release.txt'), 'continue');
  await expect(page.getByRole('status')).toContainText('Independent restored capture backup: an unexpected hardlink alias');
  for (const target of [file, backup, outside, independent]) expect(await fs.readFile(target, 'utf8')).toBe(original);
  const preserved = await fs.stat(backup, { bigint: true });
  expect(preserved.ino).toBe(before.ino); expect(preserved.dev).toBe(before.dev); expect(preserved.nlink).toBe(2n);
  await fs.unlink(independent); await fs.unlink(path.join(root, 'faults.json'));
  const unrelated = await artifact('z-independent', '3'.repeat(32));
  const run = JSON.parse(await fs.readFile(path.join(unrelated, 'run.json'), 'utf8')); run.input_sha256 = 'c'.repeat(64);
  await fs.writeFile(path.join(unrelated, 'run.json'), JSON.stringify(run));
  await page.getByRole('button', { name: 'Check now', exact: true }).click();
  await expect(page.getByRole('status')).toHaveText('Intake check complete. Inspect held imports and source errors.');
  await expect(page.locator('#captures article')).toHaveCount(2);
  for (const target of [file, backup, outside]) expect(await fs.readFile(target, 'utf8')).toBe(original);
  expect((await fs.stat(file, { bigint: true })).nlink).toBe(1n);
  expect((await fs.stat(backup, { bigint: true })).nlink).toBe(1n);
  expect((await fs.stat(outside, { bigint: true })).nlink).toBe(1n);
});
test('restored capture recovery preserves a recreated backup across same-slot producer reconnection', async () => {
  // Two publication boundaries and a restart exercise the public recovery path.
  test.setTimeout(45000);
  await artifact('a-original'); await launch(); await setup(); await connect(true);
  const base = path.join(root, 'vault', 'Companion'), intake = path.join(base, '.intake');
  const captures = path.join(base, 'Captures'), filename = (await fs.readdir(captures)).find(x => x.endsWith('.md'));
  const file = path.join(captures, filename), original = await fs.readFile(file, 'utf8');
  await artifact('b-update', '2'.repeat(32));
  await fs.writeFile(path.join(root, 'faults.json'), JSON.stringify({ pause: 'intake-capture-staged' }));
  await page.getByRole('button', { name: 'Check now', exact: true }).click();
  await expect.poll(() => fs.readFile(path.join(root, 'checkpoint.txt'), 'utf8').catch(() => '')).toBe('intake-capture-staged');
  const tx = JSON.parse(await fs.readFile(path.join(intake, 'transaction.json'), 'utf8'));
  const incomingStage = path.join(intake, tx.revision.id + '.stage'), outsideIncoming = path.join(root, 'outside-incoming');
  await fs.copyFile(incomingStage, outsideIncoming); await fs.unlink(incomingStage); await fs.link(outsideIncoming, incomingStage);
  await fs.writeFile(path.join(root, 'release.txt'), 'continue');
  await expect(page.getByRole('status')).toHaveText('Intake check complete. Inspect held imports and source errors.');
  await expect(page.locator('#held-imports')).toContainText('Unsafe import staging file');
  await app.close(); app = null;
  const backup = path.join(intake, tx.backup), independent = backup + '.independent';
  expect(await fs.readFile(backup, 'utf8')).toBe(original);
  // Reproduce the persisted known-peer state before its independent-copy step.
  await fs.unlink(backup); await fs.link(file, backup);
  await fs.unlink(path.join(root, 'release.txt'));
  await fs.writeFile(path.join(root, 'faults.json'), JSON.stringify({ pause: 'intake-restored-backup-publish' }));
  await launch();
  await expect.poll(() => fs.readFile(path.join(root, 'checkpoint.txt'), 'utf8').catch(() => '')).toBe('intake-restored-backup-publish');
  const recreated = original + '\nExternal editor recreated this backup during recovery.\n';
  await fs.unlink(backup); await fs.writeFile(backup, recreated);
  await fs.writeFile(path.join(root, 'release.txt'), 'continue');
  await expect.poll(async () => (await page.getByRole('status').textContent()).includes('Restored capture backup changed') || (await page.locator('#timezone').textContent()).includes('America/Phoenix')).toBe(true);
  const evidence = await Promise.all((await fs.readdir(intake)).filter(name => name.startsWith(tx.backup)).map(name => fs.readFile(path.join(intake, name), 'utf8')));
  expect(evidence).toContain(recreated);
  expect(await fs.readFile(file, 'utf8')).toBe(original);
  await expect(page.locator('#held-imports')).toContainText('Restored capture backup changed');
  const ledger = JSON.parse(await fs.readFile(path.join(intake, 'ledger.json'), 'utf8'));
  const hold = ledger.blocks[sha].detachHold;
  expect(hold.evidence.map(item => item.role).sort()).toEqual(['independent-editor-writing', 'original-source-copy']);
  const heldArchive = await fs.readFile(path.join(intake, hold.journal), 'utf8');
  expect(JSON.parse(heldArchive).evidence).toEqual(hold.evidence);
  expect(await fs.readFile(path.join(intake, hold.evidence.find(item => item.role === 'independent-editor-writing').file), 'utf8')).toBe(recreated);
  expect((await fs.readdir(intake)).filter(name => name.endsWith('.detach.json'))).toEqual([]);
  const transactionFile = path.join(intake, ledger.blocks[sha].journal);
  const transactionBytes = await fs.readFile(transactionFile);
  const recoveryKey = JSON.parse(transactionBytes).key;
  const recoveryOutcome = ledger.outcomes[recoveryKey];
  const producer = await fs.realpath(path.join(root, 'producer'));
  expect(recoveryOutcome).toMatchObject({ status: 'held', reason: hold.reason, locator: path.join(producer, 'b-update') });
  await app.close(); app = null; await fs.unlink(path.join(root, 'faults.json')); await launch();
  await expect(page.locator('#idea-support-status')).toHaveText('Current support inspected. Warnings do not change note ownership or independently verify claims.');
  await fs.rename(producer, path.join(root, 'relocated-original'));
  const unrelated = await artifact('b-update', '3'.repeat(32));
  const replacement = path.join(root, 'replacement-producer');
  await fs.rename(path.dirname(unrelated), replacement);
  const runPath = path.join(replacement, 'b-update', 'run.json');
  const run = JSON.parse(await fs.readFile(runPath, 'utf8')); run.input_sha256 = 'c'.repeat(64);
  await fs.writeFile(runPath, JSON.stringify(run));
  await page.getByLabel('Producer source to reconnect').selectOption({ label: `Drafts: ${producer}` });
  await page.getByLabel('Replacement producer folder').fill(replacement);
  await page.getByRole('button', { name: 'Reconnect source', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('Source reconnected');
  await page.getByRole('button', { name: 'Check now', exact: true }).click();
  await expect(page.getByRole('status')).toHaveText('Intake check complete. Inspect held imports and source errors.');
  await expect(page.locator('#captures article')).toHaveCount(2);
  expect(await fs.readFile(file, 'utf8')).toBe(original);
  expect(await fs.readFile(path.join(intake, hold.journal), 'utf8')).toBe(heldArchive);
  expect(await fs.readFile(path.join(intake, hold.evidence.find(item => item.role === 'independent-editor-writing').file), 'utf8')).toBe(recreated);
  expect((await fs.stat(file, { bigint: true })).nlink).toBe(1n);
  const after = JSON.parse(await fs.readFile(path.join(intake, 'ledger.json'), 'utf8'));
  expect(after.captures[run.input_sha256]).toBeDefined();
  expect(after.blocks[sha]).toEqual(ledger.blocks[sha]);
  expect(await fs.readFile(transactionFile)).toEqual(transactionBytes);
  expect(after.outcomes[recoveryKey]).toEqual(recoveryOutcome);
  expect(Object.values(after.outcomes)).toContainEqual(expect.objectContaining({ status: 'imported', sourceHash: run.input_sha256, locator: await fs.realpath(path.dirname(runPath)) }));
  expect(after.lastCheck.status).toBe('held');
  for (const [key, attempt] of Object.entries(ledger.attempts)) expect(after.attempts[key]).toEqual(attempt);
});
for (const boundary of ['moved', 'published', 'cleaned']) {
  test(`restored capture detach resumes after actual main exits at backup ${boundary}`, async () => {
    test.setTimeout(45000);
    await artifact('a-original'); await launch(); await setup(); await connect(true);
    const base = path.join(root, 'vault', 'Companion'), intake = path.join(base, '.intake'), captures = path.join(base, 'Captures');
    const file = path.join(captures, (await fs.readdir(captures)).find(name => name.endsWith('.md'))), original = await fs.readFile(file, 'utf8');
    await artifact('b-update', '2'.repeat(32));
    await fs.writeFile(path.join(root, 'faults.json'), JSON.stringify({ pause: 'intake-capture-staged' }));
    await page.getByRole('button', { name: 'Check now', exact: true }).click();
    await expect.poll(() => fs.readFile(path.join(root, 'checkpoint.txt'), 'utf8').catch(() => '')).toBe('intake-capture-staged');
    const tx = JSON.parse(await fs.readFile(path.join(intake, 'transaction.json'), 'utf8'));
    const incoming = path.join(intake, tx.revision.id + '.stage'), outside = path.join(root, 'outside-incoming');
    await fs.copyFile(incoming, outside); await fs.unlink(incoming); await fs.link(outside, incoming);
    await fs.writeFile(path.join(root, 'release.txt'), 'continue');
    await expect(page.getByRole('status')).toHaveText('Intake check complete. Inspect held imports and source errors.');
    const before = JSON.parse(await fs.readFile(path.join(intake, 'ledger.json'), 'utf8'));
    const conflictFile = path.join(intake, before.blocks[sha].journal), conflictBytes = await fs.readFile(conflictFile, 'utf8');
    const snapshots = await Promise.all(Object.values(before.attempts).map(async attempt => ({ file: path.join(base, 'Revisions', attempt.revision + '.json'), bytes: await fs.readFile(path.join(base, 'Revisions', attempt.revision + '.json'), 'utf8') })));
    await app.close(); app = null;
    const backup = path.join(intake, tx.backup), intentFile = backup + '.detach.json';
    await fs.unlink(backup); await fs.link(file, backup);
    await fs.unlink(path.join(root, 'release.txt'));
    const checkpoint = 'intake-restored-backup-' + boundary;
    await fs.writeFile(path.join(root, 'faults.json'), JSON.stringify({ pause: checkpoint }));
    await launch();
    await expect.poll(() => fs.readFile(path.join(root, 'checkpoint.txt'), 'utf8').catch(() => '')).toBe(checkpoint);
    expect(JSON.parse(await fs.readFile(intentFile, 'utf8')).sourceHash).toBe(sha);
    const child = app.process(), mainPid = await app.evaluate(() => process.pid);
    const crashEvidence = { root, wrapperPid: child.pid, mainPid, boundary, exitBoundary: 'Electron app.exit(77)' };
    const exited = new Promise(resolve => child.once('exit', (code, signal) => resolve({ code, signal })));
    const abrupt = app.evaluate(({ app: electronApp }) => electronApp.exit(77)).catch(error => { if (!/closed|disposed/i.test(error.message)) throw error; });
    crashEvidence.wrapperExit = await exited; await abrupt;
    await expect.poll(() => { try { process.kill(mainPid, 0); return 'alive'; } catch (error) { if (error.code === 'ESRCH') return 'exited'; throw error; } }).toBe('exited');
    await fs.writeFile(test.info().outputPath('crash-processes.json'), JSON.stringify(crashEvidence, null, 2), { encoding: 'utf8' });
    app = null; await fs.writeFile(path.join(root, 'faults.json'), '{}'); await launch();
    await expect(page.locator('#timezone')).toContainText('America/Phoenix');
    await expect(page.locator('#captures article')).toHaveCount(1);
    expect((await fs.readdir(intake)).filter(name => name.endsWith('.detach.json'))).toEqual([]);
    for (const target of [file, backup]) { expect(await fs.readFile(target, 'utf8')).toBe(original); expect((await fs.stat(target, { bigint: true })).nlink).toBe(1n); }
    expect(await fs.readFile(conflictFile, 'utf8')).toBe(conflictBytes);
    const unrelated = await artifact('z-independent', '3'.repeat(32));
    const run = JSON.parse(await fs.readFile(path.join(unrelated, 'run.json'), 'utf8')); run.input_sha256 = 'c'.repeat(64);
    await fs.writeFile(path.join(unrelated, 'run.json'), JSON.stringify(run));
    await page.getByRole('button', { name: 'Check now', exact: true }).click();
    await expect(page.getByRole('status')).toHaveText('Intake check complete. Inspect held imports and source errors.');
    await expect(page.locator('#captures article')).toHaveCount(2);
    await app.close(); app = null; await launch();
    await expect(page.locator('#captures article')).toHaveCount(2);
    const after = JSON.parse(await fs.readFile(path.join(intake, 'ledger.json'), 'utf8'));
    for (const [key, attempt] of Object.entries(before.attempts)) expect(after.attempts[key]).toEqual(attempt);
    for (const snapshot of snapshots) expect(await fs.readFile(snapshot.file, 'utf8')).toBe(snapshot.bytes);
    expect(await fs.readFile(conflictFile, 'utf8')).toBe(conflictBytes);
    expect((await fs.readdir(intake)).filter(name => name.endsWith('.detach.json'))).toEqual([]);
    for (const target of [file, backup]) { expect(await fs.readFile(target, 'utf8')).toBe(original); expect((await fs.stat(target, { bigint: true })).nlink).toBe(1n); }
  });
}
for (const checkpoint of ['intake-snapshot', 'intake-published']) {
  test(`own staged publication recovers after a crash at ${checkpoint}`, async () => {
    await artifact(); await launch(); await setup(); await connect();
    await fs.writeFile(path.join(root, 'faults.json'), JSON.stringify({ pause: checkpoint }));
    await page.getByRole('button', { name: 'Check now', exact: true }).click();
    await expect.poll(() => fs.readFile(path.join(root, 'checkpoint.txt'), 'utf8').catch(() => '')).toBe(checkpoint);
    app.process().kill(); await app.close().catch(() => {}); app = null;
    await fs.unlink(path.join(root, 'faults.json')); await launch();
    await expect(page.locator('#captures article')).toHaveCount(1);
    await expect(page.locator('#held-imports')).toHaveText('No held imports.');
    const base = path.join(root, 'vault', 'Companion');
    expect((await fs.readdir(path.join(base, 'Revisions'))).filter(x => x.endsWith('.json'))).toHaveLength(1);
    await page.getByRole('button', { name: 'Check now', exact: true }).click();
    await expect(page.getByRole('status')).toContainText('Intake check complete');
    await expect(page.locator('#captures article')).toHaveCount(1);
  });
}
test('producer title syntax remains literal in Markdown and editable without changing fenced source text', async () => {
  const dir = await artifact(), title = '![remote](https://example.invalid/image.png) <b>Source</b> [[Other note]]';
  await fs.writeFile(path.join(dir, 'first-pass-target.json'), JSON.stringify({ ...fixture.target, title }));
  const sourceNotes = (await fs.readFile(path.join(__dirname, 'fixtures/reel-draft/notes.md'), 'utf8')).replace(fixture.target.title, title);
  await fs.writeFile(path.join(dir, 'notes.md'), sourceNotes);
  await launch(); await setup(); await connect(true);
  await expect(page.locator('#captures img')).toHaveCount(0);
  const base = path.join(root, 'vault', 'Companion'), captures = path.join(base, 'Captures');
  const filename = (await fs.readdir(captures)).find(x => x.endsWith('.md'));
  let note = await fs.readFile(path.join(captures, filename), 'utf8');
  expect(note).toContain(String.raw`# \!\[remote\]\(https\:\/\/example\.invalid\/image\.png\) \<b\>Source\<\/b\> \[\[Other note\]\]`);
  expect(note).toContain(sourceNotes);
  const snapshotFile = (await fs.readdir(path.join(base, 'Revisions'))).find(x => x.endsWith('.json'));
  expect(JSON.parse(await fs.readFile(path.join(base, 'Revisions', snapshotFile), 'utf8')).target.title).toBe(title);
  await page.getByLabel('Display title').fill('My [literal] title');
  await page.getByRole('button', { name: 'Save title', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('Title saved.');
  note = await fs.readFile(path.join(captures, filename), 'utf8');
  expect(note).toContain(String.raw`# My \[literal\] title`);
  expect(note).toContain(sourceNotes);
});

for (const substitute of ['junction', 'ordinary replacement']) {
  test(`a ${substitute} at a connected producer path cannot import unselected files`, async () => {
    const first = await artifact();
    await launch(); await setup(); await connect(true);
    const base = path.join(root, 'vault', 'Companion');
    const ledger = async () => JSON.parse(await fs.readFile(path.join(base, '.intake', 'ledger.json'), 'utf8'));
    const before = await ledger();
    const producer = path.dirname(first), relocated = path.join(root, 'relocated-producer');
    await fs.rename(producer, relocated);

    const unselected = substitute === 'junction' ? path.join(root, 'unselected-producer') : producer;
    const incoming = path.join(unselected, 'new-attempt');
    await fs.mkdir(unselected);
    await fs.cp(path.join(relocated, path.basename(first)), incoming, { recursive: true });
    const runPath = path.join(incoming, 'run.json');
    const run = JSON.parse(await fs.readFile(runPath, 'utf8'));
    await fs.writeFile(runPath, JSON.stringify({ ...run, input_sha256: 'c'.repeat(64), attempt_id: '2'.repeat(32) }));
    const names = (await fs.readdir(incoming)).sort();
    const bytes = await Promise.all(names.map(name => fs.readFile(path.join(incoming, name))));
    if (substitute === 'junction') await fs.symlink(unselected, producer, process.platform === 'win32' ? 'junction' : 'dir');

    await fs.writeFile(path.join(root, 'clock.json'), JSON.stringify({ now: '2026-11-08T07:00:00Z', timezone: 'America/Phoenix' }));
    await page.getByRole('button', { name: 'Check now', exact: true }).click();
    await expect(page.getByRole('status')).toContainText('Intake check complete');
    const after = await ledger();
    expect(after.attempts).toEqual(before.attempts);
    expect(after.captures).toEqual(before.captures);
    expect(after.lastSuccess).toEqual(before.lastSuccess);
    expect(after.lastCheck.status).toBe('error');
    await expect(page.locator('#intake-state')).toContainText('Reconnect it, then Check now.');
    expect((await fs.readdir(path.join(base, 'Revisions'))).filter(name => name.endsWith('.json'))).toHaveLength(1);
    expect((await fs.readdir(incoming)).sort()).toEqual(names);
    expect(await Promise.all(names.map(name => fs.readFile(path.join(incoming, name))))).toEqual(bytes);
  });
}

test('a changed nested producer candidate holds only that candidate and imports its sibling', async () => {
  const stable = await artifact('a-independent');
  const candidate = await fs.realpath(await artifact(path.join('nested', 'z-volatile'), '2'.repeat(32)));
  const parked = path.join(root, 'parked-candidate'), substitute = path.join(root, 'unselected-candidate');
  const observed = path.join(root, 'native-readdir.json');
  await fs.cp(candidate, substitute, { recursive: true });
  const substituteRun = path.join(substitute, 'run.json');
  const run = JSON.parse(await fs.readFile(substituteRun, 'utf8'));
  await fs.writeFile(substituteRun, JSON.stringify({ ...run, input_sha256: 'c'.repeat(64), attempt_id: '3'.repeat(32) }));
  const names = (await fs.readdir(substitute)).sort();
  const unselectedBytes = await Promise.all(names.map(name => fs.readFile(path.join(substitute, name))));
  const original = await fs.readFile(path.join(candidate, 'run.json'));
  await launch(); await setup(); await connect();
  await app.evaluate((_, { candidate, parked, substitute, observed }) => {
    const nativeFs = process.getBuiltinModule('fs').promises, nativeReadDir = nativeFs.readdir;
    nativeFs.readdir = async function(folder, ...args) {
      const entries = await nativeReadDir.call(this, folder, ...args);
      if (folder === candidate) {
        nativeFs.readdir = nativeReadDir;
        await nativeFs.rename(candidate, parked);
        await nativeFs.rename(substitute, candidate);
        await nativeFs.writeFile(observed, JSON.stringify(entries.map(entry => entry.name).sort()));
      }
      return entries;
    };
  }, { candidate, parked, substitute, observed });
  await page.getByRole('button', { name: 'Check now', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('Intake check complete');
  expect(JSON.parse(await fs.readFile(observed, 'utf8'))).toEqual(names);
  expect(await fs.readFile(path.join(parked, 'run.json'))).toEqual(original);
  expect(await Promise.all(names.map(name => fs.readFile(path.join(candidate, name))))).toEqual(unselectedBytes);
  const base = path.join(root, 'vault', 'Companion');
  const ledger = JSON.parse(await fs.readFile(path.join(base, '.intake', 'ledger.json'), 'utf8'));
  expect(Object.keys(ledger.captures)).toEqual([sha]);
  expect(Object.values(ledger.attempts).map(attempt => attempt.locator)).toEqual([await fs.realpath(stable)]);
  expect(ledger.sources[0].error).toBeUndefined();
  expect(ledger.lastCheck.status).toBe('held');
  expect(Object.values(ledger.outcomes)).toContainEqual(expect.objectContaining({ status: 'held', locator: candidate }));
  await expect(page.locator('#held-imports')).toContainText(candidate);
});
