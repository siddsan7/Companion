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
  app = await electron.launch({ args: ['.'], env: { ...process.env, COMPANION_TEST_ROOT: root } });
  page = await app.firstWindow();
  await expect(page.locator('#timezone')).toContainText('America/Phoenix');
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

test('Check now stays unavailable until its own repair refresh completes', async () => {
  const producer = await artifact();
  const producerNames = (await fs.readdir(producer)).sort();
  const producerBytes = await Promise.all(producerNames.map(name => fs.readFile(path.join(producer, name))));
  await launch(); await setup(); await connect(false);
  await app.evaluate(({ app: mainApp, ipcMain }) => {
    if (!process.env.COMPANION_TEST_ROOT) throw Error('Held intake refresh requires the disposable fixture.');
    const load = process.getBuiltinModule('module').createRequire(mainApp.getAppPath() + '/app/main.js');
    const { Intake } = load('./intake');
    const originalRepairs = Intake.prototype.repairs, originalCheck = ipcMain._invokeHandlers.get('check-intake');
    const gate = globalThis.__checkNowRepairOwner = { held: false, claimed: false, checkCompleted: false, checkCalls: 0 };
    const delivery = new Promise(resolve => { gate.release = resolve; });
    gate.finished = new Promise(resolve => { gate.finish = resolve; });
    ipcMain._invokeHandlers.set('check-intake', async function (...args) {
      gate.checkCalls++;
      const result = await Reflect.apply(originalCheck, this, args);
      gate.checkCompleted = true;
      return result;
    });
    Intake.prototype.repairs = async function (...args) {
      if (!gate.checkCompleted || gate.claimed) return Reflect.apply(originalRepairs, this, args);
      gate.claimed = true;
      const ownLocked = Object.getOwnPropertyDescriptor(this, 'locked'), nativeLocked = this.locked;
      this.locked = function (work, ...lockedArgs) {
        return Reflect.apply(nativeLocked, this, [async function (...workArgs) {
          // The original locked method has already acquired its real owner and recovered.
          gate.held = true;
          await delivery;
          return Reflect.apply(work, this, workArgs);
        }, ...lockedArgs]);
      };
      try { return await Reflect.apply(originalRepairs, this, args); }
      finally {
        if (ownLocked) Object.defineProperty(this, 'locked', ownLocked); else delete this.locked;
        gate.finish();
      }
    };
    gate.restore = () => {
      Intake.prototype.repairs = originalRepairs;
      ipcMain._invokeHandlers.set('check-intake', originalCheck);
    };
  });
  await page.evaluate(() => {
    const button = document.getElementById('check-intake'), original = button.onclick;
    const observation = window.__checkNowSettlement = { settled: 0, original };
    button.onclick = async function (...args) {
      try { return await Reflect.apply(original, this, args); }
      finally { observation.settled++; }
    };
  });
  try {
    await page.getByRole('button', { name: 'Check now', exact: true }).click();
    await expect.poll(() => app.evaluate(() => globalThis.__checkNowRepairOwner.held)).toBe(true);
    await expect(page.getByRole('button', { name: 'Check now', exact: true })).toBeDisabled();
    expect(await app.evaluate(() => globalThis.__checkNowRepairOwner.checkCalls)).toBe(1);
    expect(await page.evaluate(() => window.__checkNowSettlement.settled)).toBe(0);
    await app.evaluate(() => globalThis.__checkNowRepairOwner.release());
    await expect.poll(() => page.evaluate(() => window.__checkNowSettlement.settled)).toBe(1);
    await expect(page.getByRole('status')).toContainText('Intake check complete');
    await expect(page.getByRole('button', { name: 'Check now', exact: true })).toBeEnabled();
    await expect(page.locator('#captures article')).toHaveCount(1);
    await page.getByRole('button', { name: 'Check now', exact: true }).click();
    await expect.poll(() => page.evaluate(() => window.__checkNowSettlement.settled)).toBe(2);
    expect(await app.evaluate(() => globalThis.__checkNowRepairOwner.checkCalls)).toBe(2);
    await expect(page.getByRole('status')).toContainText('Intake check complete');
    await expect(page.getByRole('button', { name: 'Check now', exact: true })).toBeEnabled();
    await expect(page.locator('#captures article')).toHaveCount(1);
    const base = path.join(root, 'vault', 'Companion');
    expect((await fs.readdir(path.join(base, 'Captures'))).filter(name => name.endsWith('.md'))).toHaveLength(1);
    expect((await fs.readdir(path.join(base, 'Revisions'))).filter(name => name.endsWith('.json'))).toHaveLength(1);
    const ledger = JSON.parse(await fs.readFile(path.join(base, '.intake', 'ledger.json'), 'utf8'));
    expect(ledger.lastCheck).toMatchObject({ trigger: 'manual', status: 'complete' });
    expect(Object.values(ledger.captures)).toHaveLength(1);
    expect(Object.values(ledger.captures)[0].revisions).toHaveLength(1);
    expect((await fs.readdir(producer)).sort()).toEqual(producerNames);
    for (const [index, name] of producerNames.entries()) expect(await fs.readFile(path.join(producer, name))).toEqual(producerBytes[index]);
  } finally {
    await app.evaluate(async () => {
      const gate = globalThis.__checkNowRepairOwner;
      gate.release();
      try { if (gate.claimed) await gate.finished; }
      finally { gate.restore(); delete globalThis.__checkNowRepairOwner; }
    });
    await page.evaluate(() => {
      document.getElementById('check-intake').onclick = window.__checkNowSettlement.original;
      delete window.__checkNowSettlement;
    });
  }
});

for (const channel of ['state', 'vault-repairs']) test(`repair choices wait for current ${channel} inspection before accepting a changed-copy selection`, async () => {
  await artifact(); await launch(); await setup(); await connect(true);
  const base = path.join(root, 'vault', 'Companion'), captures = path.join(base, 'Captures');
  const name = (await fs.readdir(captures)).find(file => file.endsWith('.md'));
  const original = path.join(captures, name), before = await fs.readFile(original, 'utf8');
  const copy = path.join(root, 'vault', 'Projects', 'Preserved duplicate.md');
  await fs.mkdir(path.dirname(copy), { recursive: true });
  await fs.writeFile(copy, before + '\nKeep independent copied writing.\n');
  await page.getByRole('button', { name: 'Refresh', exact: true }).click();
  const choice = page.getByRole('button', { name: `Use this file: Companion/Captures/${name}`, exact: true });
  await expect(page.getByLabel('Vault repairs')).toContainText('Duplicate identity');
  await expect(choice).toBeEnabled();
  const previousChoice = await choice.elementHandle();
  await fs.appendFile(copy, '\nLater independent copy writing changes the reviewed inventory.\n');
  const copied = await fs.readFile(copy, 'utf8');
  await app.evaluate(({ ipcMain }, channel) => {
    if (!process.env.COMPANION_TEST_ROOT) throw Error('Delayed repair inspection requires the disposable fixture.');
    const original = ipcMain._invokeHandlers.get(channel);
    const gate = globalThis.__repairInspectionDelivery = { original, channel, held: false };
    const delivery = new Promise(resolve => { gate.release = resolve; });
    ipcMain._invokeHandlers.set(channel, async function (...args) {
      const result = await Reflect.apply(original, this, args);
      gate.held = true; await delivery; return result;
    });
  }, channel);
  try {
    await page.getByRole('button', { name: 'Refresh', exact: true }).click();
    await expect.poll(() => app.evaluate(() => globalThis.__repairInspectionDelivery.held)).toBe(true);
    await expect(choice).toBeDisabled();
    expect(await fs.readFile(original, 'utf8')).toBe(before);
    expect(await fs.readFile(copy, 'utf8')).toBe(copied);
    await app.evaluate(() => globalThis.__repairInspectionDelivery.release());
    await expect.poll(() => previousChoice.evaluate(node => node.isConnected)).toBe(false);
    await expect(choice).toBeEnabled();
    await choice.click();
    await expect(page.getByRole('status')).toContainText('Identity selection saved');
    expect(await fs.readFile(original, 'utf8')).toBe(before);
    expect(await fs.readFile(copy, 'utf8')).toBe(copied);
  } finally {
    await app.evaluate(({ ipcMain }) => {
      const gate = globalThis.__repairInspectionDelivery;
      ipcMain._invokeHandlers.set(gate.channel, gate.original); gate.release();
      delete globalThis.__repairInspectionDelivery;
    });
    await previousChoice.dispose();
  }
});

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

test('moved annotations remain inspectable with repaired links and unchanged independent writing across restart', async () => {
  await artifact(); await launch(); await setup(); await connect(true);
  await page.getByRole('button', { name: 'Inspect source', exact: true }).click();
  const writing = 'Independent writing.\n\nSource: [Capture](my-private-reference.md)\n\nUnicode: café 📝';
  await page.getByLabel('New annotation').fill(writing);
  await page.getByRole('button', { name: 'Save annotation', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('Annotation saved');
  const base = path.join(root, 'vault', 'Companion'), annotations = path.join(base, 'Annotations');
  const name = (await fs.readdir(annotations)).find(x => x.endsWith('.md'));
  let file = path.join(annotations, name);
  const original = await fs.readFile(file, 'utf8');
  const captureName = (await fs.readdir(path.join(base, 'Captures'))).find(x => x.endsWith('.md'));
  const privateNote = path.join(root, 'vault', 'Private.md'), privateBytes = '# Private\n\nSource: [Capture](private.md)\n';
  await fs.writeFile(privateNote, privateBytes);
  for (const [folder, expected] of [
    [path.join(annotations, 'Nested'), '../../Captures/'],
    [path.join(root, 'vault', 'Projects', 'Writing'), '../../Companion/Captures/']
  ]) {
    const moved = path.join(folder, name); await fs.mkdir(folder, { recursive: true }); await fs.rename(file, moved); file = moved;
    await app.close(); app = null; await launch();
    await page.getByRole('button', { name: 'Inspect source', exact: true }).click();
    await expect(page.getByLabel('Source inspection')).toContainText('Independent writing.');
    const expectedBytes = original.replace(/^Source: \[Capture\]\([^\r\n]*\)$/m, `Source: [Capture](${expected}${encodeURIComponent(captureName)})`);
    expect(await fs.readFile(file, 'utf8')).toBe(expectedBytes);
    expect(await fs.readFile(privateNote, 'utf8')).toBe(privateBytes);
  }
});

test('duplicate annotations preserve both copies and pause relationship repair until explicit selection', async () => {
  await artifact(); await launch(); await setup(); await connect(true);
  await page.getByRole('button', { name: 'Inspect source', exact: true }).click();
  await page.getByLabel('New annotation').fill('Canonical annotation writing.');
  await page.getByRole('button', { name: 'Save annotation', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('Annotation saved');
  const base = path.join(root, 'vault', 'Companion'), folder = path.join(base, 'Annotations');
  const name = (await fs.readdir(folder)).find(x => x.endsWith('.md')), original = path.join(folder, name);
  const before = await fs.readFile(original, 'utf8'), copy = path.join(root, 'vault', 'Projects', 'Copied annotation.md');
  const copied = before + '\nPreserved duplicate writing.\n';
  await fs.mkdir(path.dirname(copy), { recursive: true }); await fs.writeFile(copy, copied);
  const capture = path.join(base, 'Captures', (await fs.readdir(path.join(base, 'Captures'))).find(x => x.endsWith('.md')));
  const moved = path.join(root, 'vault', 'Projects', 'Moved annotated source.md'); await fs.rename(capture, moved);
  const independent = await artifact('independent', '3'.repeat(32));
  const run = JSON.parse(await fs.readFile(path.join(independent, 'run.json'), 'utf8')); run.input_sha256 = 'c'.repeat(64);
  await fs.writeFile(path.join(independent, 'run.json'), JSON.stringify(run));
  await page.getByRole('button', { name: 'Check now', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('Intake check complete');
  await expect(page.locator('#captures article')).toHaveCount(2);
  expect(await fs.readFile(original, 'utf8')).toBe(before); expect(await fs.readFile(copy, 'utf8')).toBe(copied);
  await expect(page.getByLabel('Vault repairs')).toContainText('Duplicate identity');
  await app.close(); app = null; await launch();
  await expect(page.getByLabel('Vault repairs')).toContainText('Copied annotation.md');
  const captureId = before.match(/capture_id: "([^"]+)"/)[1];
  await page.locator('#captures article').filter({ hasText: captureId }).getByRole('button', { name: 'Inspect source', exact: true }).click();
  await expect(page.getByLabel('Source inspection')).toContainText('Canonical annotation writing.');
  await expect(page.getByLabel('Source inspection')).toContainText('Preserved duplicate writing.');
  await page.getByRole('button', { name: `Use this file: Companion/Annotations/${name}`, exact: true }).click();
  await expect(page.getByRole('status')).toContainText('Identity selection saved');
  expect(await fs.readFile(original, 'utf8')).toBe(before.replace(/^Source: \[Capture\]\([^\r\n]*\)$/m, 'Source: [Capture](../../Projects/Moved%20annotated%20source.md)'));
  expect(await fs.readFile(copy, 'utf8')).toBe(copied);
  await fs.appendFile(copy, '\nLater duplicate change.\n');
  await page.getByRole('button', { name: 'Refresh', exact: true }).click();
  await expect(page.getByLabel('Vault repairs')).toContainText('Duplicate identity');
  expect(await fs.readFile(copy, 'utf8')).toBe(copied + '\nLater duplicate change.\n');
});

test('custom annotation headers preserve user-owned Source links after the first frontmatter block', async () => {
  await artifact(); await launch(); await setup(); await connect(true);
  await page.getByRole('button', { name: 'Inspect source', exact: true }).click();
  await page.getByLabel('New annotation').fill('Independent body.\n\n---\n\n# Annotation\n\nSource: [Capture](my-owned-link)\n\nUser-owned footer.');
  await page.getByRole('button', { name: 'Save annotation', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('Annotation saved');
  const folder = path.join(root, 'vault', 'Companion', 'Annotations');
  const name = (await fs.readdir(folder)).find(x => x.endsWith('.md'));
  let file = path.join(folder, name);
  const original = await fs.readFile(file, 'utf8');
  const variants = [
    original.replace('# Annotation', '# My commentary'),
    original.replace('# Annotation\n\n', '').replace(/^Source: \[Capture\]\([^\r\n]*\)\n/m, '')
  ];
  for (const [index, content] of variants.entries()) {
    await fs.writeFile(file, content);
    const moved = path.join(root, 'vault', 'Projects', `Custom-${index}`, name);
    await fs.mkdir(path.dirname(moved), { recursive: true }); await fs.rename(file, moved); file = moved;
    await app.close(); app = null; await launch();
    await page.getByRole('button', { name: 'Inspect source', exact: true }).click();
    await expect(page.getByLabel('Source inspection')).toContainText('User-owned footer.');
    expect(await fs.readFile(file, 'utf8')).toBe(content);
  }
});

test('an editor change after a durable relationship intent stays held across restart while independent intake continues', async () => {
  await artifact(); await launch(); await setup(); await connect(true);
  await page.getByRole('button', { name: 'Inspect source', exact: true }).click();
  await page.getByLabel('New annotation').fill('Original independent writing.');
  await page.getByRole('button', { name: 'Save annotation', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('Annotation saved');
  const base = path.join(root, 'vault', 'Companion'), folder = path.join(base, 'Annotations');
  const name = (await fs.readdir(folder)).find(x => x.endsWith('.md')), original = path.join(folder, name);
  const before = await fs.readFile(original, 'utf8'), moved = path.join(folder, 'Nested', name);
  await fs.mkdir(path.dirname(moved), { recursive: true }); await fs.rename(original, moved);
  await fs.writeFile(path.join(root, 'faults.json'), JSON.stringify({ pause: 'link-intent-published' }));
  await page.getByRole('button', { name: 'Refresh', exact: true }).click();
  await expect.poll(() => fs.readFile(path.join(root, 'checkpoint.txt'), 'utf8').catch(error => { if (error.code === 'ENOENT') return ''; throw error; })).toBe('link-intent-published');
  const intentFile = path.join(base, '.intake', 'link-intent.json'), intentBytes = await fs.readFile(intentFile, 'utf8'), intent = JSON.parse(intentBytes);
  await fs.appendFile(moved, '\nEditor writing after the durable relationship intent.\n');
  const edited = await fs.readFile(moved, 'utf8');
  expect(edited).not.toBe(intent.before); expect(await fs.readFile(intentFile, 'utf8')).toBe(intentBytes);
  const child = app.process(), mainPid = await app.evaluate(() => process.pid);
  const crashEvidence = { root, wrapperPid: child.pid, mainPid, exitBoundary: 'Electron app.exit(77)' };
  await fs.writeFile(test.info().outputPath('crash-processes.json'), JSON.stringify(crashEvidence, null, 2), { encoding: 'utf8' });
  const exited = new Promise(resolve => child.once('exit', (code, signal) => resolve({ code, signal })));
  const abruptExit = app.evaluate(({ app: electronApp }) => electronApp.exit(77)).catch(error => { if (!/closed|disposed/i.test(error.message)) throw error; });
  crashEvidence.wrapperExit = await exited; await abruptExit;
  await expect.poll(() => { try { process.kill(mainPid, 0); return 'alive'; } catch (error) { if (error.code === 'ESRCH') return 'exited'; throw error; } }).toBe('exited');
  await fs.writeFile(test.info().outputPath('crash-processes.json'), JSON.stringify(crashEvidence, null, 2), { encoding: 'utf8' });
  app = null;
  await fs.writeFile(path.join(root, 'faults.json'), '{}');
  const independent = await artifact('independent', '3'.repeat(32));
  const run = JSON.parse(await fs.readFile(path.join(independent, 'run.json'), 'utf8')); run.input_sha256 = 'c'.repeat(64);
  await fs.writeFile(path.join(independent, 'run.json'), JSON.stringify(run));
  await launch();
  await expect(page.getByLabel('Vault repairs')).toContainText('Annotation relationship paused');
  expect(await fs.readFile(moved, 'utf8')).toBe(edited);
  const archive = path.join(base, '.intake', `link-${intent.id}.json`);
  expect(await fs.readFile(archive, 'utf8')).toBe(intentBytes);
  await page.getByRole('button', { name: 'Check now', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('Intake check complete');
  await expect(page.locator('#captures article')).toHaveCount(2);
  expect(await fs.readFile(moved, 'utf8')).toBe(edited);
  await page.getByRole('button', { name: 'Retry annotation relationship', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('Annotation relationship retry complete');
  const captureName = (await fs.readdir(path.join(base, 'Captures'))).find(x => x.includes(before.match(/capture_id: "([^"]+)"/)[1]));
  expect(await fs.readFile(moved, 'utf8')).toBe(edited.replace(/^Source: \[Capture\]\([^\r\n]*\)$/m, `Source: [Capture](../../Captures/${encodeURIComponent(captureName)})`));
  expect(await fs.readFile(archive, 'utf8')).toBe(intentBytes);
  expect(await fs.readFile(intentFile, 'utf8').catch(error => { if (error.code === 'ENOENT') return null; throw error; })).toBeNull();
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

test('Open in Obsidian waits for Browse Refresh before opening a moved capture', async () => {
  const producer = await artifact();
  const producerNames = (await fs.readdir(producer)).sort();
  const producerBytes = await Promise.all(producerNames.map(name => fs.readFile(path.join(producer, name))));
  await launch(); await setup(); await connect(true);
  await page.getByRole('button', { name: 'Inspect source', exact: true }).click();
  await page.getByLabel('New annotation').fill('Keep this relationship.');
  await page.getByRole('button', { name: 'Save annotation', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('Annotation saved');

  const base = path.join(root, 'vault', 'Companion'), captures = path.join(base, 'Captures'), annotations = path.join(base, 'Annotations');
  const name = (await fs.readdir(captures)).find(file => file.endsWith('.md'));
  const original = path.join(captures, name), before = await fs.readFile(original, 'utf8');
  const id = before.match(/companion_id: "([^"]+)"/)[1];
  const annotation = path.join(annotations, (await fs.readdir(annotations)).find(file => file.endsWith('.md')));
  const annotationBefore = await fs.readFile(annotation, 'utf8');
  const originalLink = `Source: [Capture](../Captures/${encodeURIComponent(name)})`;
  expect(annotationBefore).toContain(originalLink);
  const moved = path.join(root, 'vault', 'Projects', 'Moved source.md');
  const opened = path.join(root, 'opened-uri.txt');
  const open = page.locator('#captures').getByRole('button', { name: 'Open in Obsidian', exact: true });
  await expect(open).toBeEnabled();
  const previousOpen = await open.elementHandle();

  try {
    await fs.mkdir(path.dirname(moved), { recursive: true });
    await fs.rename(original, moved);
    await app.evaluate(({ app: mainApp, ipcMain }, { root, base }) => {
      if (process.env.COMPANION_TEST_ROOT !== root) throw Error('Held Browse refresh requires the disposable fixture.');
      const load = process.getBuiltinModule('module').createRequire(mainApp.getAppPath() + '/app/main.js');
      const { Intake } = load('./intake');
      const originalRepairs = Intake.prototype.repairs, originalOpen = ipcMain._invokeHandlers.get('open-note');
      const gate = globalThis.__browseRepairOwner = { held: false, claimed: false, openRequests: [] };
      const delivery = new Promise(resolve => { gate.release = resolve; });
      gate.finished = new Promise(resolve => { gate.finish = resolve; });
      Intake.prototype.repairs = async function (...args) {
        if (gate.claimed || this.vault.root !== base) return Reflect.apply(originalRepairs, this, args);
        gate.claimed = true;
        const ownLocked = Object.getOwnPropertyDescriptor(this, 'locked'), nativeLocked = this.locked;
        this.locked = function (work, ...lockedArgs) {
          return Reflect.apply(nativeLocked, this, [async function (...workArgs) {
            // The original locked method has acquired the real owner and recovered.
            gate.held = true;
            await delivery;
            return Reflect.apply(work, this, workArgs);
          }, ...lockedArgs]);
        };
        try { return await Reflect.apply(originalRepairs, this, args); }
        finally {
          if (ownLocked) Object.defineProperty(this, 'locked', ownLocked); else delete this.locked;
          gate.finish();
        }
      };
      ipcMain._invokeHandlers.set('open-note', function (...args) {
        gate.openRequests.push(args[1]);
        return Reflect.apply(originalOpen, this, args);
      });
      gate.restore = () => {
        Intake.prototype.repairs = originalRepairs;
        ipcMain._invokeHandlers.set('open-note', originalOpen);
      };
    }, { root, base });

    await page.getByRole('button', { name: 'Refresh', exact: true }).click();
    await expect.poll(() => app.evaluate(() => globalThis.__browseRepairOwner.held)).toBe(true);
    expect(await previousOpen.isDisabled(), 'Previous Open in Obsidian is disabled while Refresh owns the vault').toBe(true);
    expect(await app.evaluate(() => globalThis.__browseRepairOwner.openRequests)).toEqual([]);

    await app.evaluate(() => globalThis.__browseRepairOwner.release());
    await expect.poll(() => previousOpen.evaluate(node => node.isConnected)).toBe(false);
    await expect(page.locator('#captures article')).toHaveCount(1);
    await expect(open).toBeEnabled();
    expect(await app.evaluate(() => globalThis.__browseRepairOwner.openRequests)).toEqual([]);
    await expect(fs.access(opened)).rejects.toMatchObject({ code: 'ENOENT' });
    await open.click();
    await expect(page.getByRole('status')).toContainText('Requested Obsidian to open the note.');
    expect(await app.evaluate(() => globalThis.__browseRepairOwner.openRequests)).toEqual([id]);
    expect(await fs.readFile(opened, 'utf8')).toBe(`obsidian://open?path=${encodeURIComponent(moved)}`);
    expect(await fs.readFile(moved, 'utf8')).toBe(before);
    await expect(fs.access(original)).rejects.toMatchObject({ code: 'ENOENT' });
    const linked = await fs.readFile(annotation, 'utf8');
    expect(linked).toContain(`capture_id: "${id}"`);
    expect(linked).toBe(annotationBefore.replace(originalLink, 'Source: [Capture](../../Projects/Moved%20source.md)'));
    expect((await fs.readdir(producer)).sort()).toEqual(producerNames);
    for (const [index, name] of producerNames.entries()) expect(await fs.readFile(path.join(producer, name))).toEqual(producerBytes[index]);
  } finally {
    try {
      await app.evaluate(async () => {
        const gate = globalThis.__browseRepairOwner;
        if (!gate) return;
        gate.release();
        try { if (gate.claimed) await gate.finished; }
        finally { gate.restore(); delete globalThis.__browseRepairOwner; }
      });
    } finally { await previousOpen.dispose(); }
  }
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

test('a missing canonical capture never promotes its recorded excluded copy during intake', async () => {
  await artifact(); await launch(); await setup(); await connect(true);
  const base = path.join(root, 'vault', 'Companion'), dir = path.join(base, 'Captures');
  const name = (await fs.readdir(dir)).find(file => file.endsWith('.md'));
  const original = path.join(dir, name), before = await fs.readFile(original, 'utf8');
  const copy = path.join(root, 'vault', 'Projects', 'Excluded capture.md');
  await fs.mkdir(path.dirname(copy), { recursive: true }); await fs.writeFile(copy, before);
  await page.getByRole('button', { name: 'Refresh', exact: true }).click();
  await expect(page.getByLabel('Vault repairs')).toContainText('Duplicate identity');
  await page.getByRole('button', { name: `Use this file: Companion/Captures/${name}`, exact: true }).click();
  await expect(page.getByRole('status')).toContainText('Identity selection saved');
  await fs.unlink(original);
  await artifact('next', '2'.repeat(32));
  const independent = await artifact('independent', '3'.repeat(32));
  const run = JSON.parse(await fs.readFile(path.join(independent, 'run.json'), 'utf8')); run.input_sha256 = 'c'.repeat(64);
  await fs.writeFile(path.join(independent, 'run.json'), JSON.stringify(run));
  await page.getByRole('button', { name: 'Check now', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('Intake check complete');
  expect(await fs.readFile(copy, 'utf8')).toBe(before);
  await expect(page.getByRole('button', { name: 'Use this file: Projects/Excluded capture.md', exact: true })).toBeVisible();
  const ledger = JSON.parse(await fs.readFile(path.join(base, '.intake', 'ledger.json'), 'utf8'));
  const independentId = ledger.captures['c'.repeat(64)].id;
  const excludedId = Object.values(ledger.captures).find(capture => capture.id !== independentId).id;
  const captures = () => page.locator('#captures article');
  await expect(captures()).toHaveCount(1);
  await expect(captures().first()).toContainText(independentId);
  await expect(captures().filter({ hasText: excludedId })).toHaveCount(0);
  await app.close(); app = null; await launch();
  expect(await fs.readFile(copy, 'utf8')).toBe(before);
  await page.getByRole('button', { name: 'Use this file: Projects/Excluded capture.md', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('Identity selection saved');
  await page.getByRole('button', { name: 'Check now', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('Intake check complete');
  expect(await fs.readFile(copy, 'utf8')).not.toBe(before);
  expect(await fs.readFile(original, 'utf8').catch(error => { if (error.code === 'ENOENT') return null; throw error; })).toBeNull();
  await expect(captures().filter({ hasText: excludedId })).toHaveCount(1);
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
