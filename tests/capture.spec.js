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
test('interrupted quick capture keeps exact recovery proof through a temporary link refusal', async () => {
  test.setTimeout(90000);
  await launch(); await setup();
  const writer = app, writerPage = page;
  app = null;
  try {
    await launch();
    await expect(page.locator('#timezone')).toContainText('America/Phoenix');
    const dir = path.join(root, 'vault', 'My Companion', 'Captures'), draft = 'Recover after a temporary sharing refusal.';
    await fs.writeFile(path.join(root, 'faults.json'), JSON.stringify({ pause: 'capture-staged' }));
    await writerPage.getByLabel('Thought or link').fill(draft);
    await writerPage.getByRole('button', { name: 'Save capture', exact: true }).click();
    await expect.poll(() => fs.readFile(path.join(root, 'checkpoint.txt'), 'utf8').catch(() => '')).toBe('capture-staged');
    const stage = path.join(dir, (await fs.readdir(dir)).find(file => file.endsWith('.md.pending')));
    const destination = stage.slice(0, -'.pending'.length), lock = `${destination}.lock`;
    const stageBytes = await fs.readFile(stage), proofBytes = await fs.readFile(lock);
    expect(JSON.parse(proofBytes).publication.kind).toBe('capture');
    const refused = path.join(root, 'capture-recovery-link-refusal.json');
    await app.evaluate((_, { root, stage, destination, refused }) => {
      if (process.env.COMPANION_TEST_ROOT !== root) throw Error('Link refusal requires a disposable capture fixture.');
      const io = process.getBuiltinModule('fs'), native = io.linkSync;
      io.linkSync = function (from, to) {
        if (from !== stage || to !== destination) return native.call(this, from, to);
        const observed = io.lstatSync(from, { bigint: true });
        io.writeFileSync(refused, JSON.stringify({ from, to, ino: String(observed.ino) }));
        throw Object.assign(Error('Temporary recovery link refusal.'), { code: 'EACCES', syscall: 'link' });
      };
    }, { root, stage, destination, refused });
    const child = writer.process(), pid = await writer.evaluate(() => process.pid);
    const exited = new Promise(resolve => child.once('exit', resolve));
    const abrupt = writer.evaluate(({ app: electronApp }) => electronApp.exit(77)).catch(error => { if (!/closed|disposed/i.test(error.message)) throw error; });
    await exited; await abrupt;
    await expect.poll(() => { try { process.kill(pid, 0); return 'alive'; } catch (error) { if (error.code === 'ESRCH') return 'exited'; throw error; } }).toBe('exited');
    await fs.unlink(path.join(root, 'faults.json'));
    await page.getByRole('button', { name: 'Refresh', exact: true }).click();
    await expect(page.locator('#warnings')).toContainText('Temporary recovery link refusal.');
    expect(JSON.parse(await fs.readFile(refused))).toEqual({ from: stage, to: destination, ino: String((await fs.lstat(stage, { bigint: true })).ino) });
    expect(await fs.readFile(stage)).toEqual(stageBytes);
    expect(await fs.stat(destination).catch(error => error.code)).toBe('ENOENT');
    expect.soft(await fs.readFile(lock).catch(error => error.code)).toEqual(proofBytes);
    await app.close(); app = null; await launch();
    await expect(page.getByRole('heading', { name: draft, exact: true })).toHaveCount(1);
    expect(await fs.readFile(destination)).toEqual(stageBytes);
    expect(await fs.stat(stage).catch(error => error.code)).toBe('ENOENT');
    expect(await fs.stat(lock).catch(error => error.code)).toBe('ENOENT');
  } finally { await writer.close().catch(() => {}); }
});
test('a changed quick capture stage is held through restart even when it still parses', async () => {
  await launch(); await setup();
  const dir = path.join(root, 'vault', 'My Companion', 'Captures');
  const draft = 'Keep the reviewed quick capture.';
  await fs.writeFile(path.join(root, 'faults.json'), JSON.stringify({ pause: 'capture-staged' }));
  await page.getByLabel('Thought or link').fill(draft);
  await page.getByRole('button', { name: 'Save capture', exact: true }).click();
  await expect.poll(() => fs.readFile(path.join(root, 'checkpoint.txt'), 'utf8').catch(() => '')).toBe('capture-staged');
  const name = (await fs.readdir(dir)).find(file => file.endsWith('.md.pending'));
  expect(name).toBeDefined();
  const stage = path.join(dir, name), destination = stage.slice(0, -'.pending'.length);
  const original = await fs.readFile(stage);
  expect(original.toString()).toContain(draft);
  const foreign = Buffer.concat([original, Buffer.from('\nIndependent stage edit 🎸.\n')]);
  await fs.writeFile(stage, foreign);
  await fs.writeFile(path.join(root, 'release.txt'), 'resume');
  await expect(page.getByRole('status')).toContainText(/staging.*preserv|Capture saved/i);
  expect.soft(await fs.stat(destination).catch(error => error.code)).toBe('ENOENT');
  expect.soft(await fs.readFile(stage).catch(error => error.code)).toEqual(foreign);
  await expect(page.getByRole('status')).toContainText(/staging.*preserv/i);
  await expect(page.getByLabel('Thought or link')).toHaveValue(draft);
  await app.close(); app = null; await launch();
  await expect(page.locator('#warnings')).toContainText(/staging.*preserv/i);
  expect(await fs.stat(destination).catch(error => error.code)).toBe('ENOENT');
  expect(await fs.readFile(stage)).toEqual(foreign);
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
    expect.soft(await page.getByRole('button', { name: 'Use this folder', exact: true }).isDisabled(), 'The selected vault cannot change during an admitted Save').toBe(true);
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
for (const failure of ['link', 'cleanup']) test('active title recovers exactly after a temporary ' + failure + ' refusal', async () => {
  test.setTimeout(90000);
  await launch(); await setup();
  const originalTitle = 'Keep the old title until publication is verified.';
  const newTitle = 'Recover the exact reviewed title ' + failure;
  await page.getByLabel('Thought or link').fill(originalTitle);
  await page.getByRole('button', { name: 'Save capture', exact: true }).click();
  await expect(page.getByRole('heading', { name: originalTitle, exact: true })).toBeVisible();
  const dir = path.join(root, 'vault', 'My Companion', 'Captures');
  const file = path.join(dir, (await fs.readdir(dir)).find(name => name.endsWith('.md')));
  const original = await fs.readFile(file), stage = file + '.pending', journal = file + '.title-transaction.json', lock = file + '.lock';
  const observation = path.join(root, 'active-title-io-refusal.json');
  await app.evaluate((_, { root, stage, file, observation, failure }) => {
    if (process.env.COMPANION_TEST_ROOT !== root) throw Error('Title refusal requires a disposable capture fixture.');
    const io = process.getBuiltinModule('fs');
    const operation = failure === 'link' ? 'link' : 'unlink';
    const method = operation + 'Sync', native = io[method];
    io[method] = function (from, to, ...args) {
      if (from !== stage || operation === 'link' && to !== file) return native.call(this, from, ...(operation === 'link' ? [to, ...args] : []));
      const staged = io.lstatSync(stage, { bigint: true });
      const current = io.lstatSync(file, { bigint: true, throwIfNoEntry: false });
      const bytes = io.readFileSync(stage);
      io.writeFileSync(observation, JSON.stringify({ operation, links: String(staged.nlink), same: !!current && current.dev === staged.dev && current.ino === staged.ino, bytes: bytes.toString('base64') }));
      throw Object.assign(Error('Temporary active title ' + failure + ' refusal.'), { code: 'EACCES', syscall: operation });
    };
  }, { root, stage, file, observation, failure });
  await page.getByLabel('Display title').fill(newTitle);
  await page.getByRole('button', { name: 'Save title' }).click();
  await expect(page.getByRole('status')).toContainText(/Temporary active title|title.*recover/i);
  const refused = JSON.parse(await fs.readFile(observation));
  const reviewed = await fs.readFile(stage), transaction = JSON.parse(await fs.readFile(journal));
  const backup = path.join(dir, transaction.backup);
  expect(refused).toEqual({ operation: failure === 'link' ? 'link' : 'unlink', links: failure === 'link' ? '1' : '2', same: failure === 'cleanup', bytes: reviewed.toString('base64') });
  expect(await fs.readFile(backup)).toEqual(original);
  expect.soft(await fs.readFile(lock).then(bytes => JSON.parse(bytes).publication.kind, error => error.code)).toBe('title');
  if (failure === 'link') expect.soft(await fs.stat(file).catch(error => error.code)).toBe('ENOENT');
  else expect(await fs.readFile(file)).toEqual(reviewed);
  await app.close(); app = null; await launch();
  await expect(page.getByRole('heading', { name: newTitle, exact: true })).toHaveCount(1);
  expect(await fs.readFile(file)).toEqual(reviewed);
  expect(await fs.readFile(backup)).toEqual(original);
  expect((await fs.lstat(file)).nlink).toBe(1);
  expect((await fs.lstat(backup)).nlink).toBe(1);
  for (const sidecar of [stage, journal, lock]) expect(await fs.stat(sidecar).catch(error => error.code)).toBe('ENOENT');
});
test('a title stage replaced with the same bytes after the move preserves the prior title and recovery journal', async () => {
  await launch(); await setup();
  const draft = 'Keep the original title and body.';
  await page.getByLabel('Thought or link').fill(draft);
  await page.getByRole('button', { name: 'Save capture', exact: true }).click();
  await expect(page.getByRole('heading', { name: draft, exact: true })).toBeVisible();
  const dir = path.join(root, 'vault', 'My Companion', 'Captures');
  const file = path.join(dir, (await fs.readdir(dir)).find(name => name.endsWith('.md')));
  const original = await fs.readFile(file), stage = `${file}.pending`, journal = `${file}.title-transaction.json`;
  await fs.writeFile(path.join(root, 'faults.json'), JSON.stringify({ pause: 'title-moved' }));
  await page.getByLabel('Display title').fill('Reviewed title change');
  await page.getByRole('button', { name: 'Save title', exact: true }).click();
  await expect.poll(() => fs.readFile(path.join(root, 'checkpoint.txt'), 'utf8').catch(() => '')).toBe('title-moved');
  const journalBytes = await fs.readFile(journal);
  const backup = path.join(dir, JSON.parse(journalBytes).backup), reviewed = await fs.readFile(stage);
  expect(await fs.readFile(backup)).toEqual(original);
  expect(reviewed.toString()).toContain('Reviewed title change');
  const movedStage = path.join(root, 'original-title-stage');
  await fs.rename(stage, movedStage);
  await fs.writeFile(stage, reviewed, { flag: 'wx' });
  expect((await fs.stat(stage, { bigint: true })).ino).not.toBe((await fs.stat(movedStage, { bigint: true })).ino);
  await fs.writeFile(path.join(root, 'release.txt'), 'resume');
  await expect(page.getByRole('status')).toContainText(/staging.*preserv|Title saved/i);
  expect.soft(await fs.readFile(file).catch(error => error.code)).toEqual(original);
  expect.soft(await fs.readFile(stage).catch(error => error.code)).toEqual(reviewed);
  expect.soft(await fs.readFile(journal).catch(error => error.code)).toEqual(journalBytes);
  expect(await fs.readFile(backup)).toEqual(original);
  expect(await fs.readFile(movedStage)).toEqual(reviewed);
  await expect(page.getByRole('status')).toContainText(/staging.*preserv/i);
});
test('legacy PID-only title recovery restores the verified original and holds the untrusted stage', async () => {
  await launch(); await setup();
  const draft = 'Prior title from an interrupted older installation.';
  await page.getByLabel('Thought or link').fill(draft);
  await page.getByRole('button', { name: 'Save capture', exact: true }).click();
  await expect(page.getByRole('heading', { name: draft, exact: true })).toBeVisible();
  const dir = path.join(root, 'vault', 'My Companion', 'Captures');
  const file = path.join(dir, (await fs.readdir(dir)).find(name => name.endsWith('.md')));
  const original = await fs.readFile(file), stage = `${file}.pending`, journal = `${file}.title-transaction.json`;
  await fs.writeFile(path.join(root, 'faults.json'), JSON.stringify({ pause: 'title-moved' }));
  await page.getByLabel('Display title').fill('Unverified proposed title');
  await page.getByRole('button', { name: 'Save title' }).click();
  await expect.poll(() => fs.readFile(path.join(root, 'checkpoint.txt'), 'utf8').catch(() => '')).toBe('title-moved');
  const journalBytes = await fs.readFile(journal), pendingBytes = await fs.readFile(stage);
  const backup = path.join(dir, JSON.parse(journalBytes).backup), lock = `${file}.lock`;
  const { pid } = JSON.parse(await fs.readFile(lock));
  app.process().kill(); await app.close().catch(() => {}); app = null;
  await fs.writeFile(lock, JSON.stringify({ pid }));
  await fs.unlink(path.join(root, 'faults.json')); await launch();
  await expect(page.locator('#warnings')).toContainText(/staging.*preserv/i);
  expect(await fs.readFile(backup)).toEqual(original);
  expect(await fs.readFile(stage)).toEqual(pendingBytes);
  expect(await fs.readFile(journal)).toEqual(journalBytes);
  expect.soft(await fs.readFile(file).catch(error => error.code)).toEqual(original);
  await expect(page.getByRole('heading', { name: draft, exact: true })).toBeVisible();
  expect((await fs.lstat(file, { bigint: true })).nlink).toBe(1n);
  expect((await fs.lstat(backup, { bigint: true })).nlink).toBe(1n);
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
