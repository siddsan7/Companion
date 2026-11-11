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
  return { archiveId, sourceRoot, targetRoot: vault.root };
}

async function reconnectFixture() {
  const vault = new Vault(path.join(root, 'vault'), 'Companion');
  await vault.setup();
  const settingsPath = path.join(root, 'settings.json');
  await fs.writeFile(settingsPath, JSON.stringify({ vault: vault.vault, parent: 'Companion' }));
  const selection = await importedCadence(vault);
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
  const preview = (request = selection) => handlers.get('archive-reconnect-preview')(null, request);
  const confirm = review => handlers.get('archive-reconnect')(null, { token: review.token });
  return { vault, ...selection, scheduleFile, taskFile, calls, preview, confirm };
}

async function secondMatch({ vault, archiveId, sourceRoot }) {
  const currentName = `archive-intent-${archiveId}-${hash(sourceRoot + '\n' + vault.root)}.json`;
  const record = JSON.parse(await readOptional(path.join(root, currentName)));
  const other = new Vault(vault.vault, 'Other managed parent');
  await other.setup();
  const otherName = `archive-intent-${archiveId}-${hash(sourceRoot + '\n' + other.root)}.json`;
  await fs.writeFile(path.join(root, otherName), JSON.stringify({ ...record, targetRoot: other.root }), { flag: 'wx' });
  return { sourceRoot, other };
}

test('archive cadence IPC requires the exact retained match when an archive has two targets', async () => {
  const fixture = await reconnectFixture();
  const { sourceRoot, other } = await secondMatch(fixture);
  const selected = { archiveId: fixture.archiveId, sourceRoot, targetRoot: fixture.vault.root };
  await expect(fixture.preview({ ...selected, targetRoot: other.root }), 'choosing the other match must not preview the current vault').rejects.toThrow('Select exactly one imported cadence matched to the current vault');
  await expect(fixture.preview({ archiveId: fixture.archiveId })).rejects.toThrow('Select exactly one imported cadence matched to the current vault');
  expect(await readOptional(fixture.scheduleFile)).toBeNull();
  expect(await readOptional(fixture.taskFile)).toBeNull();

  const reviewed = await fixture.preview(selected);
  expect(reviewed).toMatchObject({ targetRoot: fixture.vault.root, sourceRoot, anchor, mode: 'enabled' });
  expect(await readOptional(fixture.scheduleFile)).toBeNull();
  expect(await readOptional(fixture.taskFile)).toBeNull();
  const result = await fixture.confirm(reviewed);
  expect(result).toMatchObject({ connected: true, anchor });
  expect(JSON.parse(await readOptional(fixture.scheduleFile))).toMatchObject({
    id: result.id,
    mode: 'enabled',
    archiveReconnect: { ...selected, status: 'connected' }
  });
  expect(JSON.parse(await readOptional(fixture.taskFile)).name).toBe(`Companion-${result.id}`);
});

test('archive cadence menu preserves the chosen target when an archive has two matches', async () => {
  const fixture = await reconnectFixture();
  const { other } = await secondMatch(fixture);
  await fs.writeFile(path.join(root, 'clock.json'), JSON.stringify(clock()));
  const app = await electron.launch({ args: ['.'], env: { ...process.env, COMPANION_TEST_ROOT: root } });
  try {
    const page = await app.firstWindow();
    const region = page.getByRole('region', { name: 'Local history archive', exact: true });
    const choices = region.getByLabel('Imported cadence to reconnect', { exact: true });
    const preview = region.getByRole('button', { name: 'Preview imported daily intake reconnect', exact: true });
    const confirm = region.getByRole('button', { name: 'Reconnect reviewed daily intake', exact: true });
    const summary = region.locator('#archive-reconnect-summary');
    await expect(page.locator('#location')).toHaveText(fixture.vault.root);
    await expect(choices.locator('option')).toHaveCount(3);

    const choose = async location => {
      const entry = choices.locator('option').filter({ hasText: location });
      await expect(entry).toHaveCount(1);
      await choices.selectOption({ label: await entry.textContent() });
      await preview.click();
      await expect(preview).toBeEnabled();
    };
    await choose(other.root);
    expect(await summary.textContent(), 'the menu must send the exact chosen target').toContain('Select exactly one imported cadence matched to the current vault');
    await expect(confirm).toBeDisabled();
    expect(await readOptional(fixture.scheduleFile)).toBeNull();
    expect(await readOptional(fixture.taskFile)).toBeNull();

    await choose(fixture.vault.root);
    await expect(summary).toContainText(fixture.vault.root);
    await expect(summary).toContainText(anchor);
    await expect(confirm).toBeEnabled();
    expect(await readOptional(fixture.scheduleFile)).toBeNull();
    expect(await readOptional(fixture.taskFile)).toBeNull();
  } finally { await app.close(); }
});

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

for (const target of ['linked stage', 'initial receipt', 'final schedule']) {
  test(`archive cadence detects a substituted ${target} when its proof handle closes`, async () => {
    const fixture = await reconnectFixture();
    const review = await fixture.preview();
    const receipt = `${fixture.scheduleFile}.initial-publication.json`;
    const foreignBytes = `Independent writing substituted for the ${target}.\n`;
    const originalOpen = fs.open;
    let linkedStageReads = 0, substitution;
    fs.open = async (file, flags, ...args) => {
      const handle = await originalOpen(file, flags, ...args);
      if (typeof flags !== 'number' || typeof file !== 'string' || path.dirname(file) !== root) return handle;
      const close = handle.close.bind(handle);
      handle.close = async () => {
        await close();
        if (substitution) return;
        let replace = false;
        if (target === 'linked stage' && /^\.archive-reconnect-.+\.pending$/.test(path.basename(file))) {
          const leaf = await fs.lstat(file);
          // The first read proves the pair. The second authorizes stage cleanup.
          replace = leaf.nlink === 2 && ++linkedStageReads === 2;
        }
        if (target === 'initial receipt') replace = file === receipt;
        if (target === 'final schedule' && file === fixture.scheduleFile && fixture.calls.includes('enable')) {
          replace = JSON.parse(await readOptional(file)).archiveReconnect.status === 'connected';
        }
        if (!replace) return;
        const original = await readOptional(file), parked = `${file}.original-fixture`;
        await fs.rename(file, parked);
        await fs.writeFile(file, foreignBytes, { flag: 'wx' });
        substitution = { file, parked, original };
      };
      return handle;
    };
    let outcome;
    try { outcome = await fixture.confirm(review).then(value => ({ value }), error => ({ error: error.message })); }
    finally { fs.open = originalOpen; }

    expect(substitution, 'the replacement happened after the real proof read').toBeDefined();
    expect(await readOptional(substitution.file), 'independent writing was preserved').toBe(foreignBytes);
    expect(await readOptional(substitution.parked)).toBe(substitution.original);
    expect(outcome.error, 'the operation refused to report an unproved publication').toBeTruthy();
    if (target === 'final schedule') {
      const connected = JSON.parse(substitution.original), task = JSON.parse(await readOptional(fixture.taskFile));
      expect(connected).toMatchObject({ mode: 'enabled', archiveReconnect: { status: 'connected' } });
      expect(task.name).toBe(`Companion-${connected.id}`);
      expect(fixture.calls.filter(action => action === 'enable')).toHaveLength(1);
    } else {
      expect(JSON.parse(await readOptional(fixture.scheduleFile))).toMatchObject({ mode: 'disabled', archiveReconnect: { status: 'pending' } });
      expect(fixture.calls).not.toContain('enable');
      expect(await readOptional(fixture.taskFile)).toBeNull();
    }
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

test('an old worker cannot admit intake or update a replacement schedule record', async () => {
  const file = path.join(root, 'schedule.json');
  const oldVault = new Vault(path.join(root, 'vault-A'), 'Companion');
  const nextVault = new Vault(path.join(root, 'vault-B'), 'Companion');
  await oldVault.setup();
  await nextVault.setup();
  const producer = path.join(root, 'producer-A');
  await fs.mkdir(producer);
  await new Intake(oldVault).connect(producer, false, anchor);
  const schedule = new Schedule(file, oldVault, { testRoot: root });
  const initial = await schedule.control('enable', anchor);
  const ledger = path.join(oldVault.root, '.intake', 'ledger.json');
  const originalLedger = await readOptional(ledger);
  const replacement = JSON.stringify({ schema: 1, id: randomUUID(), anchor, vault: nextVault.vault, parent: 'Companion', mode: 'enabled' });

  const originalReconcile = Intake.prototype.reconcile;
  const originalRecover = Intake.prototype.recover;
  let replaced = false, recoveryCalls = 0, result;
  Intake.prototype.reconcile = async function (...args) {
    if (this.vault.root === oldVault.root) {
      await fs.writeFile(file, replacement);
      replaced = true;
    }
    return originalReconcile.apply(this, args);
  };
  Intake.prototype.recover = async function (...args) {
    if (this.vault.root === oldVault.root) recoveryCalls++;
    return originalRecover.apply(this, args);
  };
  try { result = await schedule.run(now, 'scheduled'); }
  finally {
    Intake.prototype.reconcile = originalReconcile;
    Intake.prototype.recover = originalRecover;
  }

  expect(replaced, `record replaced after worker loaded ${initial.id}`).toBe(true);
  expect(result).toEqual({ skipped: true });
  expect(recoveryCalls).toBe(0);
  expect(await readOptional(file)).toBe(replacement);
  expect(await readOptional(ledger)).toBe(originalLedger);
});

test('Configure cannot switch managed parents during native cadence reconnection', async () => {
  const vault = new Vault(path.join(root, 'vault'), 'Companion');
  await vault.setup();
  const settingsFile = path.join(root, 'settings.json');
  const originalSettings = JSON.stringify({ vault: vault.vault, parent: 'Companion' });
  await fs.writeFile(settingsFile, originalSettings);
  await fs.writeFile(path.join(root, 'clock.json'), JSON.stringify(clock()));
  const selection = await importedCadence(vault);
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
    const review = await page.evaluate(input => window.companion['archive-reconnect-preview'](input), selection);
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

test('daily intake controls cannot enable a new vault from the old displayed schedule', async () => {
  const vaultFolder = path.join(root, 'vault');
  const first = new Vault(vaultFolder, 'Companion');
  const second = new Vault(vaultFolder, 'Other parent');
  const settings = path.join(root, 'settings.json'), scheduleFile = path.join(root, 'schedule.json');
  const taskFile = path.join(root, 'scheduler-task.json');
  for (const [name, vault] of [['A', first], ['B', second]]) {
    await vault.setup();
    const producer = path.join(root, `producer-${name}`);
    await fs.mkdir(producer);
    await new Intake(vault).connect(producer, false, anchor);
  }
  await fs.writeFile(settings, JSON.stringify({ vault: vaultFolder, parent: 'Companion' }));
  await fs.writeFile(path.join(root, 'clock.json'), JSON.stringify(clock()));
  const originalSchedule = new Schedule(scheduleFile, first, { testRoot: root });
  await originalSchedule.control('enable', anchor);
  const original = await originalSchedule.control('disable', now);
  const before = await readOptional(scheduleFile);
  expect(await readOptional(taskFile)).toBeNull();

  const app = await electron.launch({ args: ['.'], env: { ...process.env, COMPANION_TEST_ROOT: root } });
  try {
    const page = await app.firstWindow();
    const enable = page.getByRole('button', { name: 'Enable daily intake', exact: true });
    await expect(page.locator('#location')).toHaveText(first.root);
    await expect(page.getByLabel('Daily intake schedule')).toContainText('disabled');
    await expect(enable).toBeEnabled();
    await app.evaluate(({ ipcMain }) => {
      const original = ipcMain._invokeHandlers.get('configure');
      let release;
      const wait = new Promise(resolve => { release = resolve; });
      const control = globalThis.__heldCadenceConfiguration = { entered: false, release };
      ipcMain._invokeHandlers.set('configure', async (...args) => {
        const result = await original(...args);
        control.entered = true;
        await wait;
        return result;
      });
    });
    await page.getByRole('button', { name: 'Choose vault', exact: true }).click();
    await expect(page.locator('#vault')).toHaveText(vaultFolder);
    await page.getByLabel('Parent folder', { exact: true }).fill('Other parent');
    await page.getByRole('button', { name: 'Use this folder', exact: true }).click();
    try {
      await expect.poll(() => app.evaluate(() => globalThis.__heldCadenceConfiguration.entered)).toBe(true);
      await expect(page.locator('#location')).toHaveText(first.root);
      expect(JSON.parse(await readOptional(settings))).toEqual({ vault: vaultFolder, parent: 'Other parent' });
      const stale = await page.evaluate(async request => {
        try { return { value: await window.companion['schedule-enable'](request) }; }
        catch (error) { return { error: error.message }; }
      }, { location: first.root, scheduleId: original.id });
      expect(await readOptional(taskFile), 'the old view cannot authorize registration for the new vault').toBeNull();
      expect(await readOptional(scheduleFile)).toBe(before);
      expect(stale.error).toBeTruthy();
      await expect(enable).toBeDisabled();
    } finally { await app.evaluate(() => globalThis.__heldCadenceConfiguration.release()); }

    await expect(page.locator('#location')).toHaveText(second.root);
    await expect(page.getByRole('status')).toContainText('Vault ready.');
    await enable.click();
    await expect(page.getByRole('status')).toContainText('Daily intake enabled');
    const next = JSON.parse(await readOptional(scheduleFile));
    expect(next).toMatchObject({ vault: vaultFolder, parent: 'Other parent', anchor: now, mode: 'enabled' });
    expect(next.id).not.toBe(original.id);
    expect(JSON.parse(await readOptional(taskFile)).name).toBe(`Companion-${next.id}`);
  } finally { await app.close(); }
});
