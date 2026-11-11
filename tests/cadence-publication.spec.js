const { test, expect, _electron: electron } = require('@playwright/test');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { randomUUID } = require('node:crypto');
const { installArchives } = require('../app/archives');
const { hash } = require('../app/archive-format');
const { Conversations } = require('../app/conversations');
const { Schedule } = require('../app/schedule');
const { Intake } = require('../app/intake');
const { Vault } = require('../app/vault');

const now = '2026-11-12T08:00:00.000Z';
const anchor = '2026-11-08T07:00:00.000Z';
const clock = () => ({ now, timezone: 'America/Phoenix' });
let temp, root, identity;

test.beforeEach(async () => {
  if (process.env.COMPANION_NATIVE_SCHEDULER) throw Error('Cadence regressions require the controlled task fixture.');
  temp = await fs.realpath(os.tmpdir());
  root = await fs.mkdtemp(path.join(temp, 'companion-cadence-publication-'));
  identity = await fs.lstat(root, { bigint: true });
});

test.afterEach(async () => {
  if (!identity) return;
  const current = await fs.lstat(root, { bigint: true });
  if (path.dirname(root) !== temp || !current.isDirectory() || current.isSymbolicLink() ||
      current.dev !== identity.dev || current.ino !== identity.ino || await fs.realpath(root) !== root) {
    throw Error('Cadence fixture root changed. Preserve it for inspection.');
  }
  await fs.rm(root, { recursive: true });
  identity = null;
});

async function readOptional(file) {
  try { return await fs.readFile(file, 'utf8'); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

async function importedCadence(vault) {
  const oldVault = path.join(root, 'previous-vault');
  const sourceRoot = path.join(oldVault, 'Companion');
  const archiveId = randomUUID();
  const intent = { schema: 1, id: randomUUID(), anchor, vault: oldVault, parent: 'Companion', mode: 'enabled', reconnectRequired: true };
  const filename = `archive-intent-${archiveId}-${hash(sourceRoot + '\n' + vault.root)}.json`;
  await fs.writeFile(path.join(root, filename), JSON.stringify({ schema: 1, archiveId, sourceRoot, targetRoot: vault.root, intent }));
  return archiveId;
}

async function reconnectFixture() {
  const vault = new Vault(path.join(root, 'vault'), 'Companion');
  await vault.setup();
  const settingsPath = path.join(root, 'settings.json');
  await fs.writeFile(settingsPath, JSON.stringify({ vault: vault.vault, parent: 'Companion' }));
  const archiveId = await importedCadence(vault);
  const scheduleFile = path.join(root, 'schedule.json'), taskFile = path.join(root, 'scheduler-task.json');
  const schedule = new Schedule(scheduleFile, vault, { testRoot: root });
  const calls = [];
  const apply = schedule.tasks.apply.bind(schedule.tasks);
  schedule.tasks.apply = async (...args) => {
    const result = await apply(...args);
    calls.push(args[0]);
    return result;
  };
  const handlers = new Map();
  const history = new Conversations({ dataRoot: root, getVault: () => vault, clock, checkpoint: async () => {}, testRoot: root });
  installArchives({ ipcMain: { handle: (name, handle) => handlers.set(name, handle) }, history, settingsPath, testRoot: root, clock, checkpoint: async () => {}, getSchedule: () => schedule });
  const preview = () => handlers.get('archive-reconnect-preview')(null, { archiveId });
  const confirm = review => handlers.get('archive-reconnect')(null, { token: review.token });
  return { scheduleFile, taskFile, calls, preview, confirm };
}

for (const phase of ['pending', 'connected']) {
  test(`archive cadence preserves a substituted ${phase} stage and does not publish it`, async () => {
    const fixture = await reconnectFixture();
    const review = await fixture.preview();
    const foreignBytes = `Independent writing substituted for the ${phase} stage.\n`;
    const originalOpen = fs.open;
    let substitution;
    fs.open = async (file, flags, ...args) => {
      const handle = await originalOpen(file, flags, ...args);
      if (flags !== 'wx' || typeof file !== 'string' || path.dirname(file) !== root ||
          !/^\.archive-reconnect-.+\.pending$/.test(path.basename(file))) return handle;
      const close = handle.close.bind(handle);
      handle.close = async () => {
        await close();
        if (substitution) return;
        const bytes = await fs.readFile(file, 'utf8');
        const state = JSON.parse(bytes);
        if (state.archiveReconnect.status !== phase) return;
        const parked = `${file}.original-fixture`;
        const previous = await readOptional(fixture.scheduleFile);
        await fs.rename(file, parked);
        await fs.writeFile(file, foreignBytes, { flag: 'wx' });
        substitution = { file, parked, bytes, previous };
      };
      return handle;
    };
    let outcome;
    try { outcome = await fixture.confirm(review).then(value => ({ value }), error => ({ error: error.message })); }
    finally { fs.open = originalOpen; }

    expect(substitution, 'the exact written stage was substituted before its publication').toBeDefined();
    expect(await readOptional(fixture.scheduleFile), 'the reviewed destination was preserved').toBe(substitution.previous);
    expect(await readOptional(substitution.file), 'independent staged writing was preserved').toBe(foreignBytes);
    expect(await readOptional(substitution.parked)).toBe(substitution.bytes);
    expect(outcome.error).toBeTruthy();
    if (phase === 'pending') {
      expect(substitution.previous).toBeNull();
      expect(fixture.calls).not.toContain('enable');
      expect(await readOptional(fixture.taskFile)).toBeNull();
    } else {
      const pending = JSON.parse(substitution.previous);
      expect(pending).toMatchObject({ mode: 'disabled', archiveReconnect: { status: 'pending' } });
      expect(fixture.calls.filter(action => action === 'enable')).toHaveLength(1);
      expect(await fixture.preview()).toMatchObject({ pending: true, alreadyConnected: false });
    }
    const retry = await fixture.confirm(await fixture.preview());
    expect(retry).toMatchObject({ connected: true, anchor });
    if (substitution.previous) expect(retry.id).toBe(JSON.parse(substitution.previous).id);
    expect(JSON.parse(await readOptional(fixture.taskFile)).name).toBe(`Companion-${retry.id}`);
    expect(await readOptional(substitution.file)).toBe(foreignBytes);
  });
}

test('after verified Disable, explicit Enable sets up a fresh schedule for a different vault', async () => {
  const file = path.join(root, 'schedule.json'), taskFile = path.join(root, 'scheduler-task.json');
  async function connect(name) {
    const vault = new Vault(path.join(root, `vault-${name}`), 'Companion');
    await vault.setup();
    const producer = path.join(root, `producer-${name}`);
    await fs.mkdir(producer);
    await new Intake(vault).connect(producer, false, anchor);
    return new Schedule(file, vault, { testRoot: root });
  }
  const first = await connect('A');
  const initial = await first.control('enable', anchor);
  await first.run('2026-11-09T08:00:00.000Z');
  const prior = await first.control('disable', now);
  expect(prior).toMatchObject({ id: initial.id, anchor, mode: 'disabled', handledSlot: 1, lastSuccess: { at: '2026-11-09T08:00:00.000Z' } });
  expect(await readOptional(taskFile)).toBeNull();

  const second = await connect('B');
  const next = await second.control('enable', now);
  expect(next).toMatchObject({ vault: second.vault.vault, parent: 'Companion', anchor: now, mode: 'enabled' });
  expect(next.id).not.toBe(initial.id);
  expect(next.handledSlot || 0).toBe(0);
  expect(next.lastSuccess ?? null).toBeNull();
  const task = JSON.parse(await readOptional(taskFile));
  expect(task).toMatchObject({ name: `Companion-${next.id}`, firstDue: '2026-11-13T08:00:00.000Z', enabled: true });
  const nextBytes = await readOptional(file);
  expect(await first.run('2026-11-13T09:00:00.000Z', 'scheduled')).toEqual({ skipped: true });
  expect(await readOptional(file)).toBe(nextBytes);
});

test('Configure cannot switch managed parents during native cadence reconnection', async () => {
  const vault = new Vault(path.join(root, 'vault'), 'Companion');
  await vault.setup();
  const settingsFile = path.join(root, 'settings.json');
  const originalSettings = JSON.stringify({ vault: vault.vault, parent: 'Companion' });
  await fs.writeFile(settingsFile, originalSettings);
  await fs.writeFile(path.join(root, 'clock.json'), JSON.stringify(clock()));
  const archiveId = await importedCadence(vault);
  const app = await electron.launch({ args: ['.'], env: { ...process.env, COMPANION_TEST_ROOT: root } });
  try {
    const page = await app.firstWindow();
    await app.evaluate(({ app: mainApp }) => {
      const load = process.getBuiltinModule('module').createRequire(mainApp.getAppPath() + '/app/main.js');
      const { TaskScheduler } = load('./task-scheduler');
      const apply = TaskScheduler.prototype.apply;
      let release;
      const held = new Promise(resolve => { release = resolve; });
      const control = globalThis.__cadenceRegistration = { entered: false, release };
      TaskScheduler.prototype.apply = async function (operation, ...args) {
        if (operation === 'enable' && args[0]?.archiveReconnect?.status === 'pending') {
          control.entered = true;
          await held;
        }
        return apply.call(this, operation, ...args);
      };
    });
    const review = await page.evaluate(id => window.companion['archive-reconnect-preview']({ archiveId: id }), archiveId);
    const reconnect = page.evaluate(async token => {
      try { return { value: await window.companion['archive-reconnect']({ token }) }; }
      catch (error) { return { error: error.message }; }
    }, review.token);
    let switched;
    try {
      await expect.poll(() => app.evaluate(() => globalThis.__cadenceRegistration.entered)).toBe(true);
      const pending = JSON.parse(await readOptional(path.join(root, 'schedule.json')));
      expect(pending).toMatchObject({ mode: 'disabled', archiveReconnect: { status: 'pending' } });
      switched = await page.evaluate(async selected => {
        try { return { value: await window.companion.configure(selected) }; }
        catch (error) { return { error: error.message }; }
      }, { vault: vault.vault, parent: 'Other parent' });
    } finally { await app.evaluate(() => globalThis.__cadenceRegistration.release()); }
    const result = await reconnect;
    expect(await readOptional(settingsFile)).toBe(originalSettings);
    expect(switched.error).toBeTruthy();
    expect(result.value).toMatchObject({ connected: true });
    const connected = JSON.parse(await readOptional(path.join(root, 'schedule.json')));
    expect(connected).toMatchObject({ id: result.value.id, vault: vault.vault, parent: 'Companion', mode: 'enabled' });
    const task = JSON.parse(await readOptional(path.join(root, 'scheduler-task.json')));
    expect(task.name).toBe(`Companion-${connected.id}`);
  } finally { await app.close(); }
});
