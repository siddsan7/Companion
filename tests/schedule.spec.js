const { test, expect, _electron: electron } = require('@playwright/test');
const fs = require('node:fs/promises');
const { readFileSync } = require('node:fs');
const { randomUUID } = require('node:crypto');
const os = require('node:os');
const path = require('node:path');
let root, app, page;
const children = new Set();
async function clock(now = '2026-11-08T06:59:00Z') { await fs.writeFile(path.join(root, 'clock.json'), JSON.stringify({ now, timezone: 'America/Phoenix' })); }
async function launch(dataRoot = root) { app = await electron.launch({ args: ['.'], env: { ...process.env, COMPANION_TEST_ROOT: dataRoot } }); page = await app.firstWindow(); }
test.beforeEach(async () => { root = await fs.mkdtemp(path.join(os.tmpdir(), 'companion-schedule-')); await clock(); });
test.afterEach(async () => {
  if (app) await app.close(); app = null;
  await Promise.all([...children].map(child => new Promise(resolve => { child.once('exit', resolve); child.kill(); })));
  await fs.rm(root, { recursive: true, force: true });
});
async function setup() {
  await page.getByRole('button', { name: 'Choose vault', exact: true }).click();
  await page.getByRole('button', { name: 'Use this folder', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('Vault ready.');
  await fs.mkdir(path.join(root, 'producer'));
  await page.getByLabel('Draft source folder').fill(path.join(root, 'producer'));
  await page.getByRole('button', { name: 'Connect draft source', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('Source connected');
}
test('explicit schedule setup preserves the first due instant without an unrequested first scan across restart', async () => {
  await launch(); await setup();
  await page.getByRole('button', { name: 'Enable daily intake', exact: true }).click();
  await expect(page.getByLabel('Daily intake schedule')).toContainText('2026-11-09T06:59:00.000Z');
  await expect(page.locator('#intake-state')).toContainText('No intake check yet.');
  await app.close(); app = null; await clock('2026-11-09T06:58:59Z'); await launch();
  await expect(page.getByLabel('Daily intake schedule')).toContainText('2026-11-09T06:59:00.000Z');
  await expect(page.locator('#intake-state')).toContainText('No intake check yet.');
  await page.getByRole('button', { name: 'Check now', exact: true }).click();
  await expect(page.locator('#intake-state')).toContainText('manual');
  expect(JSON.parse(await fs.readFile(path.join(root, 'schedule.json'), 'utf8')).anchor).toBe('2026-11-08T06:59:00.000Z');
});

test('late desktop launch coalesces missed slots into one retained check without changing the daily anchor', async () => {
  await launch(); await setup();
  await page.getByRole('button', { name: 'Enable daily intake', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('Daily intake enabled');
  await app.close(); app = null; await clock('2026-11-12T08:00:00Z'); await launch();
  await expect(page.locator('#intake-state')).toContainText('catch-up');
  const scheduled = JSON.parse(await fs.readFile(path.join(root, 'vault', 'Companion', '.intake', 'ledger.json'), 'utf8'));
  expect(scheduled.lastSuccess.at).toBe('2026-11-12T08:00:00Z');
  const state = JSON.parse(await fs.readFile(path.join(root, 'schedule.json'), 'utf8'));
  expect(state.anchor).toBe('2026-11-08T06:59:00.000Z');
  expect(state.handledSlot).toBe(4);
  await expect(page.getByLabel('Daily intake schedule')).toContainText('2026-11-13T06:59:00.000Z');
  await app.close(); app = null; await clock('2026-11-12T09:00:00Z'); await launch();
  await expect(page.locator('#intake-state')).toContainText('2026-11-12T08:00:00Z');
  await fs.rename(path.join(root, 'producer'), path.join(root, 'unavailable'));
  await page.getByRole('button', { name: 'Check now', exact: true }).click();
  await expect(page.locator('#intake-state')).toContainText('missing or unreadable');
  await expect(page.getByLabel('Daily intake schedule')).toContainText('Last success: 2026-11-12T08:00:00Z');
});

function startWorker(expectedId) {
  const { spawn } = require('node:child_process');
  const scheduleFile = path.join(root, 'schedule.json');
  const state = JSON.parse(readFileSync(scheduleFile, 'utf8'));
  const id = expectedId === undefined ? state.launchBinding === 1 ? state.id : null : expectedId;
  const args = ['.', '--intake-worker', '--schedule-file', scheduleFile];
  if (id !== null) args.push('--schedule-id', id);
  const child = spawn(require('electron'), args, { env: { ...process.env, COMPANION_TEST_ROOT: root }, stdio: ['ignore', 'pipe', 'pipe'] });
  children.add(child);
  let output = ''; child.stderr.on('data', bytes => { output += bytes; });
  const done = new Promise((resolve, reject) => { child.on('error', reject); child.on('exit', code => { children.delete(child); resolve({ code, output }); }); });
  return { child, done };
}
async function worker(expectedId) { return startWorker(expectedId).done; }

test('a queued worker without the current task identity leaves a bound schedule and its sources untouched', async () => {
  await launch(); await setup();
  await page.getByRole('button', { name: 'Enable daily intake', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('Daily intake enabled');
  await app.close(); app = null;
  const file = path.join(root, 'schedule.json');
  const ledgerFile = path.join(root, 'vault', 'Companion', '.intake', 'ledger.json');
  const before = await fs.readFile(file, 'utf8'), ledger = await fs.readFile(ledgerFile, 'utf8');
  const state = JSON.parse(before);
  const task = JSON.parse(await fs.readFile(path.join(root, 'scheduler-task.json'), 'utf8'));
  await clock('2026-11-09T07:00:00Z');
  expect((await worker(randomUUID())).code).toBe(0);
  expect((await worker(null)).code).toBe(0);
  expect(await fs.readFile(file, 'utf8')).toBe(before);
  expect(await fs.readFile(ledgerFile, 'utf8')).toBe(ledger);
  expect(task.arguments).toContain(`"--schedule-id" "${state.id}"`);
  expect((await worker()).code).toBe(0);
  expect(JSON.parse(await fs.readFile(ledgerFile, 'utf8')).lastCheck).toMatchObject({ trigger: 'scheduled', status: 'complete' });
});

test('an existing unbound task still runs and disables through its original launch action', async () => {
  await launch(); await setup();
  await page.getByRole('button', { name: 'Enable daily intake', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('Daily intake enabled');
  await app.close(); app = null;
  const file = path.join(root, 'schedule.json'), taskFile = path.join(root, 'scheduler-task.json');
  const state = JSON.parse(await fs.readFile(file, 'utf8'));
  const task = JSON.parse(await fs.readFile(taskFile, 'utf8'));
  const suffix = ` "--schedule-id" "${state.id}"`;
  if (state.launchBinding === 1) {
    expect(task.arguments.endsWith(suffix)).toBe(true);
    task.arguments = task.arguments.slice(0, -suffix.length);
    delete state.launchBinding;
    await fs.writeFile(file, JSON.stringify(state));
    await fs.writeFile(taskFile, JSON.stringify(task));
  }
  await clock('2026-11-09T07:00:00Z');
  expect((await worker(null)).code).toBe(0);
  expect(JSON.parse(await fs.readFile(file, 'utf8'))).toMatchObject({ id: state.id, handledSlot: 1 });
  await launch();
  await page.getByRole('button', { name: 'Disable daily intake', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('Daily intake disabled');
  expect(await fs.lstat(taskFile).then(() => null, error => error.code)).toBe('ENOENT');
});

test('an existing Windows task retains its case-only data path spelling for ownership checks', async () => {
  test.skip(process.platform !== 'win32', 'Windows task arguments retain exact path spelling');
  await launch(); await setup();
  const runtime = await app.evaluate(({ app: electronApp }) => ({ appPath: electronApp.getAppPath(), executable: process.execPath }));
  await app.close(); app = null;
  const ordinary = await fs.realpath(root);
  const caseVariant = path.join(path.dirname(ordinary), path.basename(ordinary).toUpperCase());
  expect(caseVariant).not.toBe(ordinary);
  expect(await fs.realpath(caseVariant)).toBe(ordinary);
  const { Schedule } = require('../app/schedule'), { Vault } = require('../app/vault');
  const file = path.join(caseVariant, 'schedule.json'), taskFile = path.join(root, 'scheduler-task.json');
  const schedule = new Schedule(file, new Vault(path.join(root, 'vault'), 'Companion'), { ...runtime, testRoot: root });
  const state = await schedule.enable('2026-11-08T06:59:00Z');
  const task = JSON.parse(await fs.readFile(taskFile, 'utf8'));
  expect(task.arguments).toContain(`"--schedule-file" "${file}"`);
  await launch(caseVariant);
  await expect(page.getByLabel('Daily intake schedule')).toContainText('enabled');
  await page.getByRole('button', { name: 'Disable daily intake', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('Daily intake disabled');
  expect((await schedule.load())).toMatchObject({ id: state.id, mode: 'disabled' });
  expect(await fs.lstat(taskFile).then(() => null, error => error.code)).toBe('ENOENT');
});

test('pause blocks queued headless work and resume preserves the task anchor while disable removes only its registration', async () => {
  await launch(); await setup();
  await page.getByRole('button', { name: 'Enable daily intake', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('Daily intake enabled');
  const registered = JSON.parse(await fs.readFile(path.join(root, 'scheduler-task.json'), 'utf8'));
  expect(registered.firstDue).toBe('2026-11-09T06:59:00.000Z');
  expect(registered.interval).toBe('PT24H');
  await page.getByRole('button', { name: 'Pause daily intake', exact: true }).click();
  await expect(page.getByLabel('Daily intake schedule')).toContainText('paused');
  await app.close(); app = null; await clock('2026-11-10T07:00:00Z');
  expect((await worker()).code).toBe(0);
  expect(await fs.stat(path.join(root, 'vault', 'Companion', '.intake', 'ledger.json')).then(() => true, () => false)).toBe(true);
  const paused = JSON.parse(await fs.readFile(path.join(root, 'vault', 'Companion', '.intake', 'ledger.json'), 'utf8'));
  expect(paused.lastCheck).toBeUndefined();
  await launch(); await page.getByRole('button', { name: 'Resume daily intake', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('Daily intake resumed');
  await app.close(); app = null;
  expect((await worker()).code).toBe(0);
  const ledger = JSON.parse(await fs.readFile(path.join(root, 'vault', 'Companion', '.intake', 'ledger.json'), 'utf8'));
  expect(ledger.lastCheck.trigger).toBe('scheduled');
  expect(ledger.lastSuccess.at).toBe('2026-11-10T07:00:00Z');
  await launch(); await page.getByRole('button', { name: 'Disable daily intake', exact: true }).click();
  await expect(page.getByLabel('Daily intake schedule')).toContainText('disabled');
  expect(await fs.stat(path.join(root, 'scheduler-task.json')).then(() => true, () => false)).toBe(false);
  const state = JSON.parse(await fs.readFile(path.join(root, 'schedule.json'), 'utf8'));
  expect(state.anchor).toBe('2026-11-08T06:59:00.000Z');
});

async function artifact() {
  const fixture = require('./fixtures/reel-draft/example.json'), dir = path.join(root, 'producer', 'ready'); await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, 'run.json'), JSON.stringify({ job_id: 'b'.repeat(64), attempt_id: '1'.repeat(32), started_utc: '2026-11-01T10:00:00Z', input_sha256: 'a'.repeat(64), input_kind: 'local_video', result_kind: 'local_video_unreviewed', state: 'partial', validation: 'passed' }));
  await fs.writeFile(path.join(dir, 'evidence.json'), JSON.stringify({ ...fixture.input, clip_id: 'b'.repeat(64) }));
  await fs.writeFile(path.join(dir, 'first-pass-target.json'), JSON.stringify(fixture.target));
  await fs.copyFile(path.join(__dirname, 'fixtures/reel-draft/notes.md'), path.join(dir, 'notes.md'));
}
test('headless intake publishes source files and preserves visible success when its vault later becomes inaccessible', async () => {
  await launch(); await setup(); await artifact();
  await page.getByRole('button', { name: 'Enable daily intake', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('Daily intake enabled');
  await app.close(); app = null; await clock('2026-11-09T07:00:00Z');
  expect((await worker()).code).toBe(0);
  const vault = path.join(root, 'vault'), base = path.join(vault, 'Companion');
  const captures = await fs.readdir(path.join(base, 'Captures')); expect(captures).toHaveLength(1);
  const text = await fs.readFile(path.join(base, 'Captures', captures[0]), 'utf8');
  expect(text).toContain('capture_type: "reel_import"');
  expect((await fs.readdir(path.join(base, 'Revisions'))).filter(x => x.endsWith('.json'))).toHaveLength(1);
  await fs.rename(vault, path.join(root, 'unavailable-vault')); await clock('2026-11-10T07:00:00Z');
  expect((await worker()).code).toBe(1);
  await launch();
  await expect(page.getByLabel('Daily intake schedule')).toContainText('Last success: 2026-11-09T07:00:00Z');
  await expect(page.getByLabel('Daily intake schedule')).toContainText('Error:');
  expect(await fs.readFile(path.join(root, 'unavailable-vault', 'Companion', 'Captures', captures[0]), 'utf8')).toBe(text);
});

test('task access failures remain visible and repair preserves identity while drift and ownership collisions are explicit', async () => {
  await launch(); await setup();
  await fs.writeFile(path.join(root, 'scheduler-control.json'), JSON.stringify({ fail: 'enable' }));
  await page.getByRole('button', { name: 'Enable daily intake', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('access denied');
  await expect(page.getByLabel('Daily intake schedule')).toContainText('Error:');
  const original = JSON.parse(await fs.readFile(path.join(root, 'schedule.json'), 'utf8'));
  await fs.unlink(path.join(root, 'scheduler-control.json'));
  await page.getByRole('button', { name: 'Repair daily intake', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Repair daily intake', exact: true })).toBeEnabled();
  await expect(page.getByRole('status')).toContainText('Daily intake repaired');
  const registered = JSON.parse(await fs.readFile(path.join(root, 'scheduler-task.json'), 'utf8'));
  registered.enabled = false; await fs.writeFile(path.join(root, 'scheduler-task.json'), JSON.stringify(registered));
  await page.getByRole('button', { name: 'Refresh', exact: true }).click();
  await expect(page.getByLabel('Daily intake schedule')).toContainText('Task state differs');
  await page.getByRole('button', { name: 'Repair daily intake', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Repair daily intake', exact: true })).toBeEnabled();
  await expect(page.getByRole('status')).toContainText('Daily intake repaired');
  const repaired = JSON.parse(await fs.readFile(path.join(root, 'schedule.json'), 'utf8'));
  expect(repaired.id).toBe(original.id); expect(repaired.anchor).toBe(original.anchor);
  const foreign = { ...JSON.parse(await fs.readFile(path.join(root, 'scheduler-task.json'), 'utf8')), owner: 'Unrelated registration' };
  const foreignText = JSON.stringify(foreign); await fs.writeFile(path.join(root, 'scheduler-task.json'), foreignText);
  await page.getByRole('button', { name: 'Disable daily intake', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('ownership');
  expect(await fs.readFile(path.join(root, 'scheduler-task.json'), 'utf8')).toBe(foreignText);
});

test('a later manual success remains visible when the scheduled vault becomes inaccessible', async () => {
  await launch(); await setup();
  await page.getByRole('button', { name: 'Enable daily intake', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('Daily intake enabled');
  await clock('2026-11-08T08:00:00Z');
  await page.getByRole('button', { name: 'Check now', exact: true }).click();
  await expect(page.locator('#intake-state')).toContainText('manual');
  await app.close(); app = null;
  await fs.rename(path.join(root, 'vault'), path.join(root, 'unavailable-vault'));
  await launch();
  await expect(page.getByLabel('Daily intake schedule')).toContainText('Last success: 2026-11-08T08:00:00Z');
});

test('fractional setup retains its exact anchor and registers a first due boundary that Windows cannot fire early', async () => {
  await clock('2026-11-08T06:59:00.750Z'); await launch(); await setup();
  await page.getByRole('button', { name: 'Enable daily intake', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('Daily intake enabled');
  const state = JSON.parse(await fs.readFile(path.join(root, 'schedule.json'), 'utf8'));
  const task = JSON.parse(await fs.readFile(path.join(root, 'scheduler-task.json'), 'utf8'));
  expect(state.anchor).toBe('2026-11-08T06:59:00.750Z');
  expect(task.firstDue).toBe('2026-11-09T06:59:01.000Z');
  await app.close(); app = null; await clock('2026-11-09T06:59:00.700Z');
  expect((await worker()).code).toBe(0);
  const before = JSON.parse(await fs.readFile(path.join(root, 'vault', 'Companion', '.intake', 'ledger.json'), 'utf8'));
  expect(before.lastCheck).toBeUndefined();
  await clock('2026-11-09T06:59:01.000Z'); expect((await worker()).code).toBe(0);
  const after = JSON.parse(await fs.readFile(path.join(root, 'vault', 'Companion', '.intake', 'ledger.json'), 'utf8'));
  expect(after.lastCheck.trigger).toBe('scheduled');
  expect(after.lastSuccess.at).toBe('2026-11-09T06:59:01.000Z');
});


test('scheduled and manual checks share the native lock and publish one source revision', async () => {
  await launch(); await setup(); await artifact();
  await page.getByRole('button', { name: 'Enable daily intake', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('Daily intake enabled');
  await clock('2026-11-09T07:00:00Z');
  await fs.writeFile(path.join(root, 'faults.json'), JSON.stringify({ pause: 'intake-snapshot-staged' }));
  const running = startWorker();
  await expect.poll(() => fs.readFile(path.join(root, 'checkpoint.txt'), 'utf8').catch(error => { if (error.code === 'ENOENT') return ''; throw error; })).toBe('intake-snapshot-staged');
  await page.getByRole('button', { name: 'Check now', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('already running');
  await fs.writeFile(path.join(root, 'release.txt'), 'continue');
  expect((await running.done).code).toBe(0);
  await page.getByRole('button', { name: 'Refresh', exact: true }).click();
  await expect(page.locator('#captures article')).toHaveCount(1);
  const base = path.join(root, 'vault', 'Companion');
  expect((await fs.readdir(path.join(base, 'Revisions'))).filter(x => x.endsWith('.json'))).toHaveLength(1);
  await clock('2026-11-09T08:00:00Z'); expect((await worker()).code).toBe(0);
  const ledger = JSON.parse(await fs.readFile(path.join(base, '.intake', 'ledger.json'), 'utf8'));
  expect(ledger.lastCheck).toEqual({ at: '2026-11-09T07:00:00Z', trigger: 'scheduled', status: 'complete' });
  const scheduled = JSON.parse(await fs.readFile(path.join(root, 'schedule.json'), 'utf8'));
  expect(scheduled.handledSlot).toBe(1);
  expect(scheduled.anchor).toBe('2026-11-08T06:59:00.000Z');
});

test('effective trigger and scheduler policy drift stays visible until owned repair restores the anchored schedule', async () => {
  // Eleven desktop drift/repair cycles include normal scrolling and IPC refresh.
  test.setTimeout(60000);
  await launch(); await setup();
  await page.getByRole('button', { name: 'Enable daily intake', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Enable daily intake', exact: true })).toBeEnabled();
  await expect(page.getByRole('status')).toContainText('Daily intake enabled');
  const initial = JSON.parse(await fs.readFile(path.join(root, 'schedule.json'), 'utf8'));
  const changes = [
    ['triggerCount', 0], ['triggerType', 2], ['triggerEnabled', false],
    ['firstDue', '2026-11-09T07:59:00.000Z'], ['interval', 'PT1H'],
    ['repetitionDuration', 'P2D'], ['stopAtDurationEnd', true], ['endBoundary', '2026-11-10T06:59:00Z'],
    ['startWhenAvailable', false], ['wakeToRun', true], ['multipleInstances', 0]
  ];
  for (const [field, value] of changes) {
    await test.step(field, async () => {
      const taskFile = path.join(root, 'scheduler-task.json');
      const changed = JSON.parse(await fs.readFile(taskFile, 'utf8')); changed[field] = value;
      await fs.writeFile(taskFile, JSON.stringify(changed));
      await page.getByRole('button', { name: 'Refresh', exact: true }).click();
      await expect(page.getByLabel('Daily intake schedule'), field).toContainText('Task schedule differs');
      await page.getByRole('button', { name: 'Repair daily intake', exact: true }).click();
      await expect(page.getByRole('button', { name: 'Repair daily intake', exact: true })).toBeEnabled();
      await expect(page.getByRole('status')).toContainText('Daily intake repaired');
      await expect(page.getByLabel('Daily intake schedule')).not.toContainText('Task schedule differs');
      const restored = JSON.parse(await fs.readFile(path.join(root, 'schedule.json'), 'utf8'));
      expect(restored.id).toBe(initial.id); expect(restored.anchor).toBe(initial.anchor);
    });
  }
});
