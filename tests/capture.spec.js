const { test, expect, _electron: electron } = require('@playwright/test');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
let root, app, page;
test.beforeEach(async () => { root = await fs.mkdtemp(path.join(os.tmpdir(), 'companion-')); });
test.afterEach(async () => { if (app) await app.close(); app = null; await fs.rm(root, { recursive: true, force: true }); });
async function launch(now = '2026-11-08T06:59:00Z', timezone = 'America/Phoenix') {
  await fs.writeFile(path.join(root, 'clock.json'), JSON.stringify({ now, timezone }));
  app = await electron.launch({ args: ['.'], env: { ...process.env, COMPANION_TEST_ROOT: root } });
  page = await app.firstWindow();
}
async function setup() {
  await page.getByRole('button', { name: 'Choose vault' }).click();
  await page.getByLabel('Parent folder').fill('My Companion');
  await page.getByRole('button', { name: 'Use this folder' }).click();
  await expect(page.getByRole('status')).toContainText('Vault ready.');
}
test('capture offline, reject empty input, retain readable note and title across restart', async () => {
  await launch(); await setup();
  await page.context().setOffline(true);
  await page.getByRole('button', { name: 'Save capture', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('Enter a thought');
  await page.getByLabel('Thought or link').fill('Practice the chord change slowly.');
  await page.getByRole('button', { name: 'Save capture', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Practice the chord change slowly.' })).toBeVisible();
  const files = await fs.readdir(path.join(root, 'vault', 'My Companion', 'Captures'));
  expect(files).toHaveLength(1);
  const note = await fs.readFile(path.join(root, 'vault', 'My Companion', 'Captures', files[0]), 'utf8');
  expect(note).toContain('captured_at: "2026-11-08T06:59:00.000Z"');
  expect(note).toContain('Practice the chord change slowly.');
  await page.getByLabel('Display title').fill('Slow changes');
  await page.getByRole('button', { name: 'Save title' }).click();
  await expect(page.getByRole('status')).toContainText('Title saved.');
  await app.close(); app = null; await launch();
  await expect(page.getByRole('heading', { name: 'Slow changes' })).toBeVisible();
  expect((await fs.readdir(path.join(root, 'vault', 'My Companion', 'Captures'))).filter(file => file.endsWith('.md'))).toEqual(files);
});
test('title edits preserve literal text and external edits are not overwritten', async () => {
  await launch(); await setup();
  await page.getByLabel('Thought or link').fill('A thought');
  await page.getByRole('button', { name: 'Save capture', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'A thought', exact: true })).toBeVisible();
  await page.getByLabel('Display title').fill('Cost $& and $\'');
  await page.getByRole('button', { name: 'Save title' }).click();
  await expect(page.getByRole('heading', { name: 'Cost $& and $\'', exact: true })).toBeVisible();
  const dir = path.join(root, 'vault', 'My Companion', 'Captures');
  const file = (await fs.readdir(dir)).find(file => file.endsWith('.md'));
  await fs.appendFile(path.join(dir, file), '\nExternal writing.\n');
  await page.getByLabel('Display title').fill('New name');
  await page.getByRole('button', { name: 'Save title' }).click();
  await expect(page.getByRole('status')).toContainText('changed outside Companion');
  expect(await fs.readFile(path.join(dir, file), 'utf8')).toContain('External writing.');
});
test('restart recovers an interrupted title save and permits the next edit', async () => {
  await launch(); await setup();
  await page.getByLabel('Thought or link').fill('Original thought');
  await page.getByRole('button', { name: 'Save capture', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Original thought', exact: true })).toBeVisible();
  await fs.writeFile(path.join(root, 'faults.json'), JSON.stringify({ pause: 'title-staged' }));
  await page.getByLabel('Display title').fill('Recovered title');
  await page.getByRole('button', { name: 'Save title' }).click();
  await expect.poll(() => fs.readFile(path.join(root, 'checkpoint.txt'), 'utf8').catch(() => '')).toBe('title-staged');
  app.process().kill(); await app.close().catch(() => {}); app = null;
  await fs.unlink(path.join(root, 'faults.json'));
  await launch();
  await expect(page.getByRole('heading', { name: 'Recovered title', exact: true })).toBeVisible();
  await page.getByLabel('Display title').fill('Next title');
  await page.getByRole('button', { name: 'Save title' }).click();
  await expect(page.getByRole('status')).toContainText('Title saved.');
});
test('a damaged capture reports its file without hiding valid captures', async () => {
  await launch(); await setup();
  await page.getByLabel('Thought or link').fill('Still available');
  await page.getByRole('button', { name: 'Save capture', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Still available', exact: true })).toBeVisible();
  const dir = path.join(root, 'vault', 'My Companion', 'Captures');
  const file = (await fs.readdir(dir)).find(file => file.endsWith('.md'));
  const note = await fs.readFile(path.join(dir, file), 'utf8');
  await fs.writeFile(path.join(dir, file), note.replace('artifact_type: "capture"', 'artifact_type: capture').replace('title: "Still available"', "title: 'Still available'"));
  await fs.writeFile(path.join(dir, 'damaged.md'), note.replace(/^companion_id: .*$/m, 'companion_id: "different-id"').replace(/^captured_at: .*$/m, 'captured_at: 123'));
  await page.getByRole('button', { name: 'Refresh', exact: true }).click();
  await expect(page.locator('#warnings')).toContainText('damaged.md');
  await expect(page.getByRole('heading', { name: 'Still available', exact: true })).toBeVisible();
});
test('a junction cannot redirect capture writes outside the selected vault', async () => {
  const outside = path.join(root, 'outside');
  const parent = path.join(root, 'vault', 'My Companion');
  await fs.mkdir(outside); await fs.mkdir(parent, { recursive: true });
  await fs.writeFile(path.join(outside, 'unrelated.md'), 'Keep this unchanged.');
  await fs.symlink(outside, path.join(parent, 'Captures'), 'junction');
  await launch();
  await page.getByRole('button', { name: 'Choose vault' }).click();
  await page.getByLabel('Parent folder').fill('My Companion');
  await page.getByRole('button', { name: 'Use this folder' }).click();
  await expect(page.getByRole('status')).toContainText('outside the selected vault');
  await page.getByLabel('Thought or link').fill('Must stay local to the selected vault');
  await page.getByRole('button', { name: 'Save capture', exact: true }).click();
  expect(await fs.readdir(outside)).toEqual(['unrelated.md']);
  expect(await fs.readFile(path.join(outside, 'unrelated.md'), 'utf8')).toBe('Keep this unchanged.');
});
test('a staged capture recovers exactly once after interruption', async () => {
  await launch(); await setup();
  await fs.writeFile(path.join(root, 'faults.json'), JSON.stringify({ pause: 'capture-staged' }));
  await page.getByLabel('Thought or link').fill('Keep the interrupted thought.');
  await page.getByRole('button', { name: 'Save capture', exact: true }).click();
  await expect.poll(() => fs.readFile(path.join(root, 'checkpoint.txt'), 'utf8').catch(() => '')).toBe('capture-staged');
  await page.getByRole('button', { name: 'Refresh', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Keep the interrupted thought.', exact: true })).toHaveCount(0);
  expect((await fs.readdir(path.join(root, 'vault', 'My Companion', 'Captures'))).filter(file => file.endsWith('.pending'))).toHaveLength(1);
  app.process().kill(); await app.close().catch(() => {}); app = null;
  await fs.unlink(path.join(root, 'faults.json')); await launch();
  await expect(page.getByRole('heading', { name: 'Keep the interrupted thought.', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Refresh', exact: true }).click();
  const files = (await fs.readdir(path.join(root, 'vault', 'My Companion', 'Captures'))).filter(file => file.endsWith('.md'));
  expect(files).toHaveLength(1);
  expect(await fs.readFile(path.join(root, 'vault', 'My Companion', 'Captures', files[0]), 'utf8')).toContain('captured_at: "2026-11-08T06:59:00.000Z"');
});
test('link excerpts roundtrip Unicode and Markdown rules with explicit provenance and Obsidian URI', async () => {
  await launch(); await setup(); await page.context().setOffline(true);
  const url = 'https://example.invalid/Path?keep=%2f#Notes';
  const excerpt = 'A user passage 🎸\n\n---\n\nKeep this tail and its uncertainty.';
  await page.getByLabel('Thought or link').fill(url);
  await page.getByRole('button', { name: 'Add source excerpt', exact: true }).click();
  await page.getByLabel('User-supplied excerpt').fill(excerpt);
  await page.getByRole('button', { name: 'Save capture', exact: true }).click();
  await expect(page.locator('article pre')).toContainText(excerpt);
  await expect(page.locator('article pre')).toContainText('did not fetch or verify');
  await page.getByLabel('Search captures').fill('Keep this tail');
  await expect(page.getByRole('heading', { name: url, exact: true })).toBeVisible();
  const dir = path.join(root, 'vault', 'My Companion', 'Captures');
  const file = (await fs.readdir(dir)).find(file => file.endsWith('.md'));
  const note = await fs.readFile(path.join(dir, file), 'utf8'); expect(note).toContain(excerpt); expect(note).toContain(`source_url: "${url}"`);
  await page.getByRole('button', { name: 'Open in Obsidian' }).click();
  await expect.poll(() => fs.readFile(path.join(root, 'opened-uri.txt'), 'utf8').catch(() => '')).toBe(`obsidian://open?path=${encodeURIComponent(path.join(dir, file))}`);
});
test('Today changes at local midnight and during travel while history and capture instant remain', async () => {
  await launch(); await setup();
  await page.getByLabel('Thought or link').fill('A midnight thought');
  await page.getByRole('button', { name: 'Save capture', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'A midnight thought', exact: true })).toBeVisible();
  const dir = path.join(root, 'vault', 'My Companion', 'Captures'), file = (await fs.readdir(dir)).find(file => file.endsWith('.md'));
  const original = await fs.readFile(path.join(dir, file), 'utf8');
  await fs.writeFile(path.join(root, 'clock.json'), JSON.stringify({ now: '2026-11-08T07:01:00Z', timezone: 'America/Phoenix' }));
  await page.getByRole('button', { name: 'Refresh', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'A midnight thought', exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'All captures', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'A midnight thought', exact: true })).toBeVisible();
  await fs.writeFile(path.join(root, 'clock.json'), JSON.stringify({ now: '2026-11-08T07:01:00Z', timezone: 'America/Los_Angeles' }));
  await page.getByRole('button', { name: 'Today', exact: true }).click();
  await expect(page.locator('#timezone')).toContainText('America/Los_Angeles');
  await expect(page.getByRole('heading', { name: 'A midnight thought', exact: true })).toBeVisible();
  expect(await fs.readFile(path.join(dir, file), 'utf8')).toBe(original);
});
test('Today follows DST midnight rather than an elapsed 24 hour window', async () => {
  await launch('2026-11-01T04:30:00Z', 'America/New_York'); await setup();
  await page.getByLabel('Thought or link').fill('Fall-back day thought');
  await page.getByRole('button', { name: 'Save capture', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Fall-back day thought', exact: true })).toBeVisible();
  await fs.writeFile(path.join(root, 'clock.json'), JSON.stringify({ now: '2026-11-02T04:59:00Z', timezone: 'America/New_York' }));
  await page.getByRole('button', { name: 'Refresh', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Fall-back day thought', exact: true })).toBeVisible();
  await fs.writeFile(path.join(root, 'clock.json'), JSON.stringify({ now: '2026-11-02T05:01:00Z', timezone: 'America/New_York' }));
  await page.getByRole('button', { name: 'Refresh', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Fall-back day thought', exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'All captures', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Fall-back day thought', exact: true })).toBeVisible();
});

async function holdBrowseRepairs(contender) {
  const base = path.join(root, 'vault', 'My Companion');
  await app.evaluate(({ app: mainApp, ipcMain }, { root, base, contender }) => {
    if (process.env.COMPANION_TEST_ROOT !== root) throw Error('Held Browse repairs require the disposable fixture.');
    const load = process.getBuiltinModule('module').createRequire(mainApp.getAppPath() + '/app/main.js');
    const { Intake } = load('./intake');
    const originalRepairs = Intake.prototype.repairs;
    const channels = contender === 'state' ? ['state', 'vault-repairs'] : ['capture'];
    const handlers = new Map(channels.map(channel => [channel, ipcMain._invokeHandlers.get(channel)]));
    const gate = globalThis.__browseAdmission = { claimed: false, held: false, requests: [] };
    let resume, finish;
    const delivery = new Promise(resolve => { resume = resolve; });
    gate.finished = new Promise(resolve => { finish = resolve; });
    gate.release = reason => {
      if (gate.releaseReason) return;
      clearTimeout(gate.timer);
      gate.releaseReason = reason;
      try {
        if (contender === 'capture') {
          const dir = process.getBuiltinModule('path').join(base, 'Captures');
          gate.filesBeforeRelease = process.getBuiltinModule('fs').readdirSync(dir);
        }
      } finally { resume(); }
    };
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
        finish();
      }
    };
    for (const [channel, original] of handlers) {
      ipcMain._invokeHandlers.set(channel, async function (...args) {
        if (!gate.held) return Reflect.apply(original, this, args);
        const request = { channel, duringHold: !gate.releaseReason };
        if (channel === 'capture') request.input = args[1];
        gate.requests.push(request);
        if (channel === contender && request.duringHold && !gate.timer) {
          // Let a waiting contender finish after a bounded fixture hold.
          gate.timer = setTimeout(() => gate.release('fixture boundary'), 1500);
        }
        try {
          const result = await Reflect.apply(original, this, args);
          if (channel === 'state') {
            request.outcome = { now: result.now, error: result.vaultError ?? null };
            if (result.vaultError) gate.release('state failed');
          } else {
            request.outcome = channel === 'capture' ? { id: result } : { count: result.length };
          }
          return result;
        } catch (error) {
          request.outcome = { error: error.message };
          if (channel === 'state') gate.release('state failed');
          throw error;
        } finally {
          if (channel !== 'state') gate.release(`${channel} settled`);
        }
      });
    }
    gate.restore = () => {
      Intake.prototype.repairs = originalRepairs;
      for (const [channel, original] of handlers) ipcMain._invokeHandlers.set(channel, original);
    };
  }, { root, base, contender });
}

async function restoreBrowseRepairs() {
  await app.evaluate(async () => {
    const gate = globalThis.__browseAdmission;
    try {
      gate.release('cleanup');
      if (gate.claimed) await gate.finished;
    } finally {
      gate.restore();
      delete globalThis.__browseAdmission;
    }
  });
}

test('a newer Browse Refresh shows Today after DST midnight while earlier repairs own the vault', async () => {
  const timezone = 'America/New_York', title = 'Thought from the fall-back day';
  await launch('2026-11-01T04:30:00Z', timezone); await setup();
  await page.getByLabel('Thought or link').fill(title);
  await page.getByRole('button', { name: 'Save capture', exact: true }).click();
  const note = page.getByRole('heading', { name: title, exact: true });
  await expect(note).toBeVisible();
  const dir = path.join(root, 'vault', 'My Companion', 'Captures');
  const [file] = await fs.readdir(dir), original = await fs.readFile(path.join(dir, file));
  const refresh = page.getByRole('button', { name: 'Refresh', exact: true });
  const open = page.getByRole('button', { name: 'Open in Obsidian', exact: true });
  await fs.writeFile(path.join(root, 'clock.json'), JSON.stringify({ now: '2026-11-02T04:59:00Z', timezone }));
  await holdBrowseRepairs('state');
  try {
    await refresh.click();
    await expect.poll(() => app.evaluate(() => globalThis.__browseAdmission.held)).toBe(true);
    await expect(open).toBeDisabled();
    const now = '2026-11-02T05:01:00Z';
    await fs.writeFile(path.join(root, 'clock.json'), JSON.stringify({ now, timezone }));
    await refresh.click();
    const observation = () => app.evaluate(() => {
      const { requests, releaseReason } = globalThis.__browseAdmission;
      return { requests, releaseReason };
    });
    await expect.poll(async () => (await observation()).requests[0]?.outcome).toBeDefined();
    const { requests, releaseReason } = await observation();
    expect({ request: requests[0], releaseReason }).toEqual({
      request: { channel: 'state', duringHold: true, outcome: { now, error: null } },
      releaseReason: 'fixture boundary'
    });
    await expect.poll(async () => (await observation()).requests.find(request => request.channel === 'vault-repairs')?.outcome).toEqual({ count: 0 });
    await expect(page.locator('#timezone')).toHaveText('Today · America/New_York · 2026-11-02');
    await expect(note).toHaveCount(0);
    await expect(page.locator('#warnings')).toBeEmpty();
    await page.getByRole('button', { name: 'All captures', exact: true }).click();
    await expect(note).toBeVisible();
    await expect(open).toBeEnabled();
    expect(await fs.readdir(dir)).toEqual([file]);
    expect(await fs.readFile(path.join(dir, file))).toEqual(original);
  } finally { await restoreBrowseRepairs(); }
});

test('one explicit Save capture publishes once after earlier Browse repairs release the vault', async () => {
  await launch(); await setup();
  const text = 'Save this thought once after Browse.';
  const draft = page.getByLabel('Thought or link');
  await draft.fill(text);
  const dir = path.join(root, 'vault', 'My Companion', 'Captures');
  await holdBrowseRepairs('capture');
  try {
    const refresh = page.getByRole('button', { name: 'Refresh', exact: true });
    await refresh.click();
    await expect.poll(() => app.evaluate(() => globalThis.__browseAdmission.held)).toBe(true);
    await page.getByRole('button', { name: 'Save capture', exact: true }).click();
    const observation = () => app.evaluate(() => {
      const { requests, releaseReason, filesBeforeRelease } = globalThis.__browseAdmission;
      return { requests, releaseReason, filesBeforeRelease };
    });
    await expect.poll(async () => (await observation()).requests[0]?.outcome).toBeDefined();
    expect(await observation()).toEqual({
      requests: [{ channel: 'capture', duringHold: true, input: { text, excerpt: '' }, outcome: { id: expect.any(String) } }],
      releaseReason: 'fixture boundary',
      filesBeforeRelease: []
    });
    await expect(page.getByRole('status')).toHaveText('Capture saved.');
    await expect(draft).toHaveValue('');
    const heading = page.getByRole('heading', { name: text, exact: true });
    await expect(heading).toBeVisible();
    const saved = await heading.elementHandle();
    try {
      await refresh.click();
      await expect.poll(() => saved.evaluate(node => node.isConnected)).toBe(false);
      await expect(heading).toHaveCount(1);
    } finally { await saved.dispose(); }
    expect((await observation()).requests).toHaveLength(1);
    const files = await fs.readdir(dir);
    expect(files).toHaveLength(1);
    expect(files[0]).toMatch(/\.md$/);
    expect(await fs.readFile(path.join(dir, files[0]), 'utf8')).toContain(text);
  } finally { await restoreBrowseRepairs(); }
});

test('Save capture waits for vault setup and an explicit click persists one note', async () => {
  await launch();
  await page.getByRole('button', { name: 'Choose vault', exact: true }).click();
  await page.getByLabel('Parent folder').fill('My Companion');
  const base = path.join(root, 'vault', 'My Companion');
  await app.evaluate(({ app: mainApp }, { root, base }) => {
    if (process.env.COMPANION_TEST_ROOT !== root) throw Error('Held vault setup requires the disposable fixture.');
    const load = process.getBuiltinModule('module').createRequire(mainApp.getAppPath() + '/app/main.js');
    const { Vault } = load('./vault');
    const original = Vault.prototype.setup;
    const gate = globalThis.__captureSetup = { held: false };
    const delivery = new Promise(resolve => { gate.release = resolve; });
    Vault.prototype.setup = async function (...args) {
      const result = await Reflect.apply(original, this, args);
      if (this.root === base) {
        gate.held = true;
        await delivery;
      }
      return result;
    };
    gate.restore = () => { Vault.prototype.setup = original; };
  }, { root, base });
  const text = 'Keep this draft during vault setup.';
  const draft = page.getByLabel('Thought or link');
  const save = page.getByRole('button', { name: 'Save capture', exact: true });
  const dir = path.join(base, 'Captures');
  try {
    await page.getByRole('button', { name: 'Use this folder', exact: true }).click();
    await expect.poll(() => app.evaluate(() => globalThis.__captureSetup.held)).toBe(true);
    await draft.fill(text);
    await expect(fs.access(path.join(root, 'settings.json'))).rejects.toMatchObject({ code: 'ENOENT' });
    expect.soft(await save.isDisabled(), 'Save is disabled before the selected vault is published').toBe(true);
  } finally {
    await app.evaluate(() => {
      const gate = globalThis.__captureSetup;
      gate.restore();
      gate.release();
      delete globalThis.__captureSetup;
    });
  }
  await expect(page.getByRole('status')).toHaveText('Vault ready.');
  await expect(save).toBeEnabled();
  await expect(draft).toHaveValue(text);
  expect(await fs.readdir(dir)).toEqual([]);
  await save.click();
  await expect(page.getByRole('status')).toHaveText('Capture saved.');
  await app.close(); app = null; await launch();
  await expect(page.getByRole('heading', { name: text, exact: true })).toHaveCount(1);
  const files = await fs.readdir(dir);
  expect(files).toHaveLength(1);
  expect(files[0]).toMatch(/\.md$/);
  expect(await fs.readFile(path.join(dir, files[0]), 'utf8')).toContain(text);
});

test('failed capture retains the draft and explicit retry creates one note', async () => {
  await launch(); await setup();
  const dir = path.join(root, 'vault', 'My Companion', 'Captures'); await fs.rmdir(dir);
  await page.getByLabel('Thought or link').fill('Retry this draft.');
  await page.getByRole('button', { name: 'Save capture', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('ENOENT');
  await expect(page.getByLabel('Thought or link')).toHaveValue('Retry this draft.');
  await fs.mkdir(dir);
  await page.getByRole('button', { name: 'Save capture', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Retry this draft.', exact: true })).toBeVisible();
  expect((await fs.readdir(dir)).filter(file => file.endsWith('.md'))).toHaveLength(1);
});
for (const phase of ['title-staged', 'title-moved']) test(`an editor write at ${phase} is preserved and reported`, async () => {
  await launch(); await setup();
  await page.getByLabel('Thought or link').fill('Keep the source body.');
  await page.getByRole('button', { name: 'Save capture', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Keep the source body.', exact: true })).toBeVisible();
  const dir = path.join(root, 'vault', 'My Companion', 'Captures'), file = (await fs.readdir(dir)).find(file => file.endsWith('.md'));
  const original = await fs.readFile(path.join(dir, file), 'utf8');
  await fs.writeFile(path.join(root, 'faults.json'), JSON.stringify({ pause: phase }));
  await page.getByLabel('Display title').fill('Proposed title');
  await page.getByRole('button', { name: 'Save title' }).click();
  await expect.poll(() => fs.readFile(path.join(root, 'checkpoint.txt'), 'utf8').catch(() => '')).toBe(phase);
  await fs.writeFile(path.join(dir, file), original + '\nInterleaved external writing.\n');
  await fs.writeFile(path.join(root, 'release.txt'), 'resume');
  await expect(page.getByRole('status')).toContainText(/conflict|preserved/i);
  expect(await fs.readFile(path.join(dir, file), 'utf8')).toContain('Interleaved external writing.');
});
test('recovery never restores an unrelated backup from an invalid title transaction', async () => {
  await launch(); await setup();
  await page.getByLabel('Thought or link').fill('Managed original');
  await page.getByRole('button', { name: 'Save capture', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Managed original', exact: true })).toBeVisible();
  const dir = path.join(root, 'vault', 'My Companion', 'Captures'), file = (await fs.readdir(dir)).find(file => file.endsWith('.md'));
  await fs.writeFile(path.join(root, 'faults.json'), JSON.stringify({ pause: 'title-staged' }));
  await page.getByLabel('Display title').fill('Proposed title');
  await page.getByRole('button', { name: 'Save title' }).click();
  await expect.poll(() => fs.readFile(path.join(root, 'checkpoint.txt'), 'utf8').catch(() => '')).toBe('title-staged');
  app.process().kill(); await app.close().catch(() => {}); app = null;
  const journal = JSON.parse(await fs.readFile(path.join(dir, `${file}.title-transaction.json`), 'utf8'));
  await fs.rename(path.join(dir, file), path.join(root, 'user-moved-original.md'));
  await fs.writeFile(path.join(dir, journal.backup), 'Unrelated personal writing.');
  await fs.unlink(path.join(root, 'faults.json')); await launch();
  await expect(page.locator('#warnings')).toContainText(/conflict|Invalid/i);
  expect(await fs.readFile(path.join(dir, file), 'utf8').catch(error => { if (error.code === 'ENOENT') return null; throw error; })).toBeNull();
  expect(await fs.readFile(path.join(dir, journal.backup), 'utf8')).toBe('Unrelated personal writing.');
  expect(await fs.readFile(path.join(dir, `${file}.pending`), 'utf8')).toContain('Proposed title');
});
test('display title edits preserve deleted or changed generated headings and later source headings', async () => {
  await launch(); await setup();
  const dir = path.join(root, 'vault', 'My Companion', 'Captures'), fixtures = [];
  for (const title of ['First thought', 'Second thought']) {
    await page.getByLabel('Thought or link').fill(`${title}\n\n# Source heading\nEvidence`);
    await page.getByRole('button', { name: 'Save capture', exact: true }).click();
    await expect(page.getByRole('heading', { name: title, exact: true })).toBeVisible();
  }
  await app.close(); app = null;
  for (const file of (await fs.readdir(dir)).filter(file => file.endsWith('.md'))) {
    const original = await fs.readFile(path.join(dir, file), 'utf8');
    const title = original.includes('title: "First thought"') ? 'First thought' : 'Second thought';
    const edited = original.replace(`# ${title}\n`, title === 'First thought' ? '' : '# My own heading\n');
    await fs.writeFile(path.join(dir, file), edited);
    fixtures.push({ file, title, body: edited.slice(edited.indexOf('\n---\n') + 5) });
  }
  await launch();
  for (const fixture of fixtures) {
    const article = page.locator('article').filter({ has: page.getByRole('heading', { name: fixture.title, exact: true }) });
    await article.getByLabel('Display title').fill(`New ${fixture.title}`);
    await article.getByRole('button', { name: 'Save title' }).click();
    await expect(page.getByRole('heading', { name: `New ${fixture.title}`, exact: true })).toBeVisible();
    const updated = await fs.readFile(path.join(dir, fixture.file), 'utf8');
    expect(updated.slice(updated.indexOf('\n---\n') + 5)).toBe(fixture.body);
  }
});
