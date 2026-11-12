const { test, expect, _electron: electron } = require('@playwright/test');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
let root, app, page;
test.beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'companion-context-'));
  await fs.writeFile(path.join(root, 'clock.json'), JSON.stringify({ now: '2026-11-08T06:59:00Z', timezone: 'America/Phoenix' }));
});
test.afterEach(async () => { if (app) await app.close(); app = null; await fs.rm(root, { recursive: true, force: true }); });
async function settledStartup(window) {
  // A new window starts with an empty status. This current-epoch completion
  // follows its accepted base refresh and all initial saved-idea support reads.
  await expect(window.locator('#idea-support-status')).toContainText('Current support inspected.');
}
async function launch(configure = true) {
  app = await electron.launch({ args: ['.'], env: { ...process.env, COMPANION_TEST_ROOT: root } }); page = await app.firstWindow();
  if (configure) { await page.getByRole('button', { name: 'Choose vault' }).click(); await page.getByRole('button', { name: 'Use this folder' }).click(); await expect(page.getByRole('status')).toContainText('Vault ready.'); }
  else await settledStartup(page);
}
async function capture(text) { await page.getByLabel('Thought or link', { exact: true }).fill(text); await page.getByRole('button', { name: 'Save capture', exact: true }).click(); await expect(page.getByLabel('Thought or link', { exact: true })).toHaveValue(''); await expect(page.getByRole('status')).toContainText('Capture saved.'); }
async function search(question) {
  const completed = page.getByRole('region', { name: 'Context discovery', exact: true }).getByText('Context search complete.', { exact: true });
  await page.getByLabel('Context question', { exact: true }).fill(question);
  await expect(completed).toHaveCount(0);
  await page.getByRole('button', { name: 'Find context', exact: true }).click();
  await expect(completed).toBeVisible();
}
test('a pending Find retires earlier context choices until current capture text is ready for explicit selection', async () => {
  await launch(); await capture('FINDCOMPLETION earlier capture text.');
  await search('FINDCOMPLETION');
  const results = page.locator('#context-results');
  const manual = page.getByLabel('Manual context source', { exact: true });
  await expect(results.getByRole('button', { name: 'Add to context', exact: true })).toBeEnabled();
  await expect(manual.locator('option')).toHaveText(['FINDCOMPLETION earlier capture text.']);
  await expect(page.getByRole('button', { name: 'Add manual source', exact: true })).toBeEnabled();
  const captures = path.join(root, 'vault', 'Companion', 'Captures');
  const file = path.join(captures, (await fs.readdir(captures)).find(name => name.endsWith('.md')));
  await fs.appendFile(file, '\nFINDCOMPLETION newly inspected capture text.\n');

  // Hold delivery only after actual discovery has read the changed file.
  // Preserve the real handler's result/error and call it once per invocation.
  await app.evaluate(({ ipcMain }) => {
    if (!process.env.COMPANION_TEST_ROOT) throw Error('Delayed Find requires the disposable fixture.');
    const original = ipcMain._invokeHandlers.get('context-find');
    if (!original) throw Error('Context Find handler is unavailable.');
    const gate = globalThis.__contextFindDelivery = { original, held: false, calls: 0 };
    const delivery = new Promise(resolve => { gate.release = resolve; });
    ipcMain._invokeHandlers.set('context-find', async function (...args) {
      gate.calls++;
      const result = await Reflect.apply(original, this, args);
      gate.held = true;
      await delivery;
      return result;
    });
  });
  try {
    await page.getByRole('button', { name: 'Find context', exact: true }).click();
    await expect.poll(() => app.evaluate(() => globalThis.__contextFindDelivery.held)).toBe(true);
    await expect(page.locator('#context-results button:enabled, #context-add-manual:enabled')).toHaveCount(0);
    await expect(manual).toBeDisabled();
    const discovery = page.getByRole('region', { name: 'Context discovery', exact: true });
    await expect(discovery.getByText('Finding context…', { exact: true })).toBeVisible();
    await expect(page.locator('#context-selected article')).toHaveCount(0);
    await app.evaluate(() => globalThis.__contextFindDelivery.release());
    await expect(discovery.getByText('Context search complete.', { exact: true })).toBeVisible();
    await expect(results).toContainText('FINDCOMPLETION newly inspected capture text.');
    await expect(manual).toBeEnabled();
    await results.getByRole('button', { name: 'Add to context', exact: true }).click();
    await page.getByRole('button', { name: 'Preview context', exact: true }).click();
    await expect(page.getByLabel('Actual context package', { exact: true })).toHaveValue(/FINDCOMPLETION newly inspected capture text\./);
    await expect(page.locator('#context-error')).toHaveText('');
  } finally {
    await app.evaluate(({ ipcMain }) => {
      const gate = globalThis.__contextFindDelivery;
      ipcMain._invokeHandlers.set('context-find', gate.original);
      gate.release();
      delete globalThis.__contextFindDelivery;
    });
  }
});

test('an older Find response cannot replace the results for the newer context question', async () => {
  await launch();
  await capture('OLDERQUESTION earlier capture text.');
  await capture('NEWERQUESTION current capture text.');
  await app.evaluate(({ ipcMain }) => {
    if (!process.env.COMPANION_TEST_ROOT) throw Error('Delayed Find requires the disposable fixture.');
    const original = ipcMain._invokeHandlers.get('context-find');
    if (!original) throw Error('Context Find handler is unavailable.');
    const gate = globalThis.__olderFindDelivery = { original, held: false, calls: 0 };
    const delivery = new Promise(resolve => { gate.release = resolve; });
    ipcMain._invokeHandlers.set('context-find', async function (...args) {
      const first = ++gate.calls === 1;
      const result = await Reflect.apply(original, this, args);
      if (first) { gate.held = true; await delivery; }
      return result;
    });
  });
  try {
    await page.evaluate(() => {
      const button = document.getElementById('context-find');
      const observation = window.__findOnclickSettlement = { original: button.onclick, calls: 0, first: null };
      button.onclick = function (...args) {
        const first = ++observation.calls === 1;
        const returned = Reflect.apply(observation.original, this, args);
        if (first) observation.first = returned;
        return returned;
      };
    });
    await page.getByLabel('Context question', { exact: true }).fill('OLDERQUESTION');
    await page.getByRole('button', { name: 'Find context', exact: true }).click();
    await expect.poll(() => app.evaluate(() => globalThis.__olderFindDelivery.held)).toBe(true);
    await page.getByLabel('Context question', { exact: true }).fill('NEWERQUESTION');
    await page.getByRole('button', { name: 'Find context', exact: true }).click();
    const results = page.locator('#context-results');
    await expect(results).toContainText('NEWERQUESTION current capture text.');
    await expect(results).not.toContainText('OLDERQUESTION earlier capture text.');
    await app.evaluate(() => globalThis.__olderFindDelivery.release());
    // Await the first real renderer handler, including its publication/error/finally path.
    await page.evaluate(() => window.__findOnclickSettlement.first);
    await expect(page.getByLabel('Context question', { exact: true })).toHaveValue('NEWERQUESTION');
    await expect(results).toContainText('NEWERQUESTION current capture text.');
    await expect(results).not.toContainText('OLDERQUESTION earlier capture text.');
    await expect(page.locator('#context-selected article')).toHaveCount(0);
  } finally {
    await app.evaluate(({ ipcMain }) => {
      const gate = globalThis.__olderFindDelivery;
      ipcMain._invokeHandlers.set('context-find', gate.original); gate.release();
      delete globalThis.__olderFindDelivery;
    });
    await page.evaluate(async () => {
      const observation = window.__findOnclickSettlement;
      if (observation) {
        try { await observation.first; }
        finally { document.getElementById('context-find').onclick = observation.original; delete window.__findOnclickSettlement; }
      }
    });
  }
});

for (const outcome of ['success', 'error']) {
  test(`an older Refresh ${outcome} cannot replace a newer saved capture or its status`, async () => {
    await launch(); await capture('REFRESHOLDER earlier capture.');
    const scheduleFile = path.join(root, 'schedule.json');
    const scheduleBefore = await fs.readFile(scheduleFile).catch(error => { if (error.code !== 'ENOENT') throw error; return null; });
    const restoreSchedule = async () => {
      if (outcome !== 'error') return;
      if (scheduleBefore === null) await fs.rm(scheduleFile, { force: true });
      else await fs.writeFile(scheduleFile, scheduleBefore);
    };
    await app.evaluate(({ ipcMain }) => {
      if (!process.env.COMPANION_TEST_ROOT) throw Error('Delayed Refresh requires the disposable fixture.');
      const original = ipcMain._invokeHandlers.get('state');
      if (!original) throw Error('State handler is unavailable.');
      const gate = globalThis.__refreshDelivery = { original, held: false, error: null, calls: 0 };
      const delivery = new Promise(resolve => { gate.release = resolve; });
      ipcMain._invokeHandlers.set('state', async function (...args) {
        const first = ++gate.calls === 1;
        let result;
        try { result = await Reflect.apply(original, this, args); }
        catch (error) {
          if (first) { gate.error = error.message; gate.held = true; await delivery; }
          throw error;
        }
        if (first) { gate.held = true; await delivery; }
        return result;
      });
    });
    try {
      await page.evaluate(() => {
        const button = document.getElementById('refresh');
        const observation = window.__refreshOnclickSettlement = { original: button.onclick, calls: 0, first: null };
        button.onclick = function (...args) {
          const first = ++observation.calls === 1;
          const returned = Reflect.apply(observation.original, this, args);
          if (first) observation.first = returned;
          return returned;
        };
      });
      // The error comes from Schedule.load's real JSON parse, never a fabricated IPC rejection.
      if (outcome === 'error') await fs.writeFile(scheduleFile, '{');
      await page.getByRole('button', { name: 'Refresh', exact: true }).click();
      await expect.poll(() => app.evaluate(() => globalThis.__refreshDelivery.held)).toBe(true);
      if (outcome === 'error') expect(await app.evaluate(() => globalThis.__refreshDelivery.error)).toBe('Daily intake settings are unreadable. Preserve them for repair.');
      await restoreSchedule();
      await capture('REFRESHNEWER newly saved capture.');
      const captures = page.locator('#captures');
      await expect(captures).toContainText('REFRESHNEWER newly saved capture.');
      await expect(page.getByRole('status')).toHaveText('Capture saved.');
      const folder = path.join(root, 'vault', 'Companion', 'Captures');
      const names = (await fs.readdir(folder)).filter(name => name.endsWith('.md')).sort();
      const before = await Promise.all(names.map(name => fs.readFile(path.join(folder, name), 'utf8')));
      await app.evaluate(() => globalThis.__refreshDelivery.release());
      await page.evaluate(() => window.__refreshOnclickSettlement.first);
      await expect(captures).toContainText('REFRESHNEWER newly saved capture.');
      await expect(page.getByRole('status')).toHaveText('Capture saved.');
      expect((await fs.readdir(folder)).filter(name => name.endsWith('.md')).sort()).toEqual(names);
      expect(await Promise.all(names.map(name => fs.readFile(path.join(folder, name), 'utf8')))).toEqual(before);
    } finally {
      await restoreSchedule();
      await app.evaluate(({ ipcMain }) => {
        const gate = globalThis.__refreshDelivery;
        ipcMain._invokeHandlers.set('state', gate.original); gate.release();
        delete globalThis.__refreshDelivery;
      });
      await page.evaluate(async () => {
        const observation = window.__refreshOnclickSettlement;
        if (observation) {
          try { await observation.first; }
          finally { document.getElementById('refresh').onclick = observation.original; delete window.__refreshOnclickSettlement; }
        }
      });
    }
  });
}

test('a failed Check refresh cannot replace a newer saved capture status when its error reports later', async () => {
  await reviewBundle('accept'); await launch();
  await page.getByLabel('Finalized review folder').fill(path.join(root, 'producer'));
  await page.getByRole('button', { name: 'Connect finalized reviews', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('Source connected');
  const settings = path.join(root, 'schedule.json');
  const previous = await fs.readFile(settings).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
  const restoreSettings = () => previous === null ? fs.rm(settings, { force: true }) : fs.writeFile(settings, previous);
  await app.evaluate(({ ipcMain, app: mainApp }) => {
    const load = process.getBuiltinModule('module').createRequire(mainApp.getAppPath() + '/app/main.js');
    const io = load('node:fs/promises'), paths = load('node:path');
    if (!process.env.COMPANION_TEST_ROOT) throw Error('Check error control requires the disposable fixture.');
    const original = ipcMain._invokeHandlers.get('check-intake');
    const control = globalThis.__checkReporting = { original, calls: 0 };
    ipcMain._invokeHandlers.set('check-intake', async function (...args) {
      const result = await Reflect.apply(original, this, args);
      if (++control.calls === 1) await io.writeFile(paths.join(process.env.COMPANION_TEST_ROOT, 'schedule.json'), '{');
      return result;
    });
  });
  await page.evaluate(() => {
    const control = window.__checkReporting = { originalAction: window.action, originalCheck: document.getElementById('check-intake').onclick, inCheck: false, claimed: false, held: false };
    control.wait = new Promise(resolve => { control.release = resolve; });
    window.action = function (work, ...args) {
      if (!control.inCheck || control.claimed) return Reflect.apply(control.originalAction, this, [work, ...args]);
      control.claimed = true;
      // Hold the genuine work rejection before the unchanged outer action reports it.
      return Reflect.apply(control.originalAction, this, [async () => {
        try { return await work(); }
        catch (error) { control.error = error.message; control.held = true; await control.wait; throw error; }
      }, ...args]);
    };
    document.getElementById('check-intake').onclick = function (...args) {
      control.inCheck = true;
      try { const returned = Reflect.apply(control.originalCheck, this, args); control.first = returned; return returned; }
      finally { control.inCheck = false; }
    };
  });
  try {
    await page.getByRole('button', { name: 'Check now', exact: true }).click();
    await expect.poll(() => page.evaluate(() => window.__checkReporting.held)).toBe(true);
    expect(await page.evaluate(() => window.__checkReporting.error)).toContain('Daily intake settings are unreadable');
    await restoreSettings();
    await page.evaluate(() => { window.action = window.__checkReporting.originalAction; });
    await capture('CHECKREPORT newer saved capture.');
    await expect(page.locator('#captures')).toContainText('CHECKREPORT newer saved capture.');
    const folder = path.join(root, 'vault', 'Companion', 'Captures');
    const names = (await fs.readdir(folder)).filter(name => name.endsWith('.md')).sort();
    const bytes = await Promise.all(names.map(name => fs.readFile(path.join(folder, name))));
    await page.evaluate(() => window.__checkReporting.release());
    await page.evaluate(() => window.__checkReporting.first);
    await expect(page.getByRole('status')).toHaveText('Capture saved.');
    await expect(page.locator('#captures')).toContainText('CHECKREPORT newer saved capture.');
    expect(await app.evaluate(() => globalThis.__checkReporting.calls)).toBe(1);
    expect((await fs.readdir(folder)).filter(name => name.endsWith('.md')).sort()).toEqual(names);
    expect(await Promise.all(names.map(name => fs.readFile(path.join(folder, name))))).toEqual(bytes);
  } finally {
    await restoreSettings();
    await app.evaluate(({ ipcMain }) => { ipcMain._invokeHandlers.set('check-intake', globalThis.__checkReporting.original); delete globalThis.__checkReporting; });
    await page.evaluate(async () => {
      const control = window.__checkReporting; control.release();
      try { await control.first; }
      finally { window.action = control.originalAction; document.getElementById('check-intake').onclick = control.originalCheck; delete window.__checkReporting; }
    });
  }
});

test('local exact matches show reasons and manual selection previews the literal question and source provenance', async () => {
  await launch(); await capture('Spaced retrieval can revisit a learned chord.');
  await search('How can retrieval help MyTune?');
  await expect(page.locator('#context-results')).toContainText(/Text match:[^;]*retrieval/);
  await page.locator('#context-results').getByRole('button', { name: 'Add to context', exact: true }).click();
  await page.getByRole('button', { name: 'Preview context', exact: true }).click();
  await expect(page.getByLabel('Actual context package', { exact: true })).toHaveValue(/Question:\nHow can retrieval help MyTune\?/);
  await expect(page.getByLabel('Actual context package', { exact: true })).toHaveValue(/Spaced retrieval can revisit a learned chord/);
  await expect(page.getByLabel('Actual context package', { exact: true })).toHaveValue(/user capture/);
  await expect(page.locator('#context-summary')).toContainText('Within limit');
  await page.locator('#context-selected').getByRole('button', { name: 'Remove from context', exact: true }).click();
  await page.getByRole('button', { name: 'Preview context', exact: true }).click();
  await expect(page.getByLabel('Actual context package', { exact: true })).not.toHaveValue(/Spaced retrieval/);
});


test('explicit vault note scope persists and manual sources recover a lexical paraphrase miss without reading private notes', async () => {
  await launch(); await capture('Spaced retrieval can revisit a learned chord.');
  const personal = path.join(root, 'vault', 'personal.md');
  await fs.writeFile(personal, '---\nartifact_type: diary\n---\nCANARYPRIVATE a personal source about practice.');
  await search('CANARYPRIVATE');
  await expect(page.locator('#context-results')).toContainText('No Relevant Context');
  await expect(page.locator('#context-results')).not.toContainText('a personal source');
  await fs.writeFile(path.join(root, 'context-selection.json'), JSON.stringify([personal]));
  await page.getByRole('button', { name: 'Include vault notes', exact: true }).click();
  await search('CANARYPRIVATE');
  await expect(page.locator('#context-results')).toContainText('a personal source');
  await app.close(); app = null; await launch(false); await search('CANARYPRIVATE');
  await expect(page.locator('#context-results')).toContainText('a personal source');
  await page.locator('#context-notes').getByRole('button', { name: 'Exclude note', exact: true }).click();
  await search('CANARYPRIVATE'); await expect(page.locator('#context-results')).toContainText('No Relevant Context');
  // Relevant authored paraphrase deliberately shares no searchable terms.
  await search('Remember earlier lessons');
  await expect(page.locator('#context-results')).toContainText('No Relevant Context');
  await page.getByLabel('Manual context source', { exact: true }).selectOption({ label: 'Spaced retrieval can revisit a learned chord.' });
  await page.getByRole('button', { name: 'Add manual source', exact: true }).click();
  await page.getByRole('button', { name: 'Preview context', exact: true }).click();
  await expect(page.getByLabel('Actual context package', { exact: true })).toHaveValue(/Spaced retrieval/);
  await expect(page.getByLabel('Actual context package', { exact: true })).not.toHaveValue(/CANARYPRIVATE/);
});

async function reviewBundle(name) {
  const target = path.join(root, 'producer', name); await fs.cp(path.join(__dirname, 'fixtures', 'reel-review', name), target, { recursive: true }); return target;
}
async function intakeCheck() {
  await page.getByRole('button', { name: 'Check now', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('Intake check complete');
}
test('moved annotations enter context only through the canonical copy and preserve independent header and footer text', async () => {
  test.setTimeout(90000);
  await reviewBundle('accept'); await launch();
  await page.getByLabel('Finalized review folder').fill(path.join(root, 'producer'));
  await page.getByRole('button', { name: 'Connect finalized reviews', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('Source connected'); await intakeCheck();
  await page.getByRole('button', { name: 'Inspect source', exact: true }).click();
  const writing = 'MOVEDANNOTATION independent chord interpretation.\n\n---\n\n# Annotation\n\nSource: [Capture](user-owned-footer)\n\nKeep this user footer.';
  await page.getByLabel('New annotation').fill(writing);
  await page.getByRole('button', { name: 'Save annotation', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('Annotation saved');
  const folder = path.join(root, 'vault', 'Companion', 'Annotations');
  const name = (await fs.readdir(folder)).find(file => file.endsWith('.md'));
  const moved = path.join(root, 'vault', 'Projects', 'Moved annotation.md');
  await fs.mkdir(path.dirname(moved), { recursive: true }); await fs.rename(path.join(folder, name), moved);
  await app.close(); app = null; await launch(false);
  await search('MOVEDANNOTATION');
  const result = page.locator('#context-results article').filter({ hasText: 'Independent user annotation' });
  await expect(result).toHaveCount(1);
  await result.getByRole('button', { name: 'Add to context', exact: true }).click();
  await page.getByRole('button', { name: 'Preview context', exact: true }).click();
  const preview = page.getByLabel('Actual context package', { exact: true });
  await expect(preview).toHaveValue(new RegExp(writing.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  await expect(preview).not.toHaveValue(/Source: \[Capture\]\([^\n]*Captures/);
  await expect(preview).toHaveValue(/unversioned capture association[^\n]*original source revision unknown/);
  const canonical = await fs.readFile(moved, 'utf8'), copy = path.join(folder, 'Preserved copy.md');
  const copied = canonical + '\nEXCLUDEDCOPY independent text.\n'; await fs.writeFile(copy, copied);
  await page.getByRole('button', { name: 'Refresh', exact: true }).click();
  await expect(page.getByLabel('Vault repairs')).toContainText('Duplicate identity');
  await page.getByRole('button', { name: 'Preview context', exact: true }).click();
  await expect(page.locator('#context-error')).toContainText('unavailable'); await expect(preview).toHaveValue('');
  await search('MOVEDANNOTATION EXCLUDEDCOPY'); await expect(result).toHaveCount(0);
  await page.getByRole('button', { name: 'Inspect source', exact: true }).click();
  await expect(page.getByLabel('Source inspection')).toContainText('EXCLUDEDCOPY');
  await page.getByRole('button', { name: 'Use this file: Projects/Moved annotation.md', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('Identity selection saved');
  await search('MOVEDANNOTATION EXCLUDEDCOPY'); await expect(result).toHaveCount(1);
  await expect(result).not.toContainText('EXCLUDEDCOPY');
  // A custom immediate header makes its Source line independent user text.
  const custom = canonical.replace('\n# Annotation\n', '\n# My annotation\n'); await fs.writeFile(moved, custom);
  await search('MOVEDANNOTATION'); await expect(result).toHaveCount(1);
  await result.getByRole('button', { name: 'Add to context', exact: true }).click();
  await page.getByRole('button', { name: 'Preview context', exact: true }).click();
  await expect(preview).toHaveValue(/# My annotation\n\nSource: \[Capture\]/);
  await expect(preview).toHaveValue(/Source: \[Capture\]\(user-owned-footer\)/);
  expect(await fs.readFile(moved, 'utf8')).toBe(custom); expect(await fs.readFile(copy, 'utf8')).toBe(copied);
  await fs.appendFile(copy, '\nChanged preserved copy.\n');
  await app.close(); app = null; await launch(false);
  await expect(page.locator('#timezone')).toContainText('America/Phoenix');
  await search('MOVEDANNOTATION'); await expect(page.locator('#context-results article').filter({ hasText: 'Independent user annotation' })).toHaveCount(0);
  await expect(page.getByLabel('Vault repairs')).toContainText('Duplicate identity');
  expect(await fs.readFile(moved, 'utf8')).toBe(custom);
  expect(await fs.readFile(copy, 'utf8')).toBe(copied + '\nChanged preserved copy.\n');
});
test('a missing canonical annotation keeps its recorded excluded copy outside context and relationship repair', async () => {
  test.setTimeout(60000);
  await reviewBundle('accept'); await launch();
  await page.getByLabel('Finalized review folder').fill(path.join(root, 'producer'));
  await page.getByRole('button', { name: 'Connect finalized reviews', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('Source connected'); await intakeCheck();
  await page.getByRole('button', { name: 'Inspect source', exact: true }).click();
  await page.getByLabel('New annotation').fill('EXCLUDEDANNOTATION independent writing.');
  await page.getByRole('button', { name: 'Save annotation', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('Annotation saved');
  const base = path.join(root, 'vault', 'Companion'), folder = path.join(base, 'Annotations');
  const name = (await fs.readdir(folder)).find(file => file.endsWith('.md'));
  const original = path.join(folder, name), before = await fs.readFile(original, 'utf8');
  const copy = path.join(root, 'vault', 'Projects', 'Excluded annotation.md');
  await fs.mkdir(path.dirname(copy), { recursive: true }); await fs.writeFile(copy, before);
  await page.getByRole('button', { name: 'Refresh', exact: true }).click();
  await expect(page.getByLabel('Vault repairs')).toContainText('Duplicate identity');
  await page.getByRole('button', { name: `Use this file: Companion/Annotations/${name}`, exact: true }).click();
  await expect(page.getByRole('status')).toContainText('Identity selection saved');
  await fs.unlink(original);
  // Moving the source would rewrite the surviving copy's link if it were promoted.
  const captures = path.join(base, 'Captures'), capture = (await fs.readdir(captures)).find(file => file.endsWith('.md'));
  await fs.rename(path.join(captures, capture), path.join(root, 'vault', 'Projects', 'Moved source.md'));
  await app.close(); app = null; await launch(false);
  await search('EXCLUDEDANNOTATION');
  expect(await fs.readFile(copy, 'utf8')).toBe(before);
  await expect(page.locator('#context-results article').filter({ hasText: 'Independent user annotation' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Use this file: Projects/Excluded annotation.md', exact: true })).toBeVisible();
  const changed = before + '\nLater excluded-copy writing.\n'; await fs.writeFile(copy, changed);
  await search('EXCLUDEDANNOTATION');
  await expect(page.locator('#context-results article').filter({ hasText: 'Independent user annotation' })).toHaveCount(0);
  expect(await fs.readFile(copy, 'utf8')).toBe(changed);
  await page.getByRole('button', { name: 'Refresh', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Use this file: Projects/Excluded annotation.md', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Use this file: Projects/Excluded annotation.md', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('Identity selection saved');
  await search('EXCLUDEDANNOTATION');
  await expect(page.locator('#context-results article').filter({ hasText: 'Independent user annotation' })).toHaveCount(1);
  expect(await fs.readFile(copy, 'utf8')).toContain('Source: [Capture](Moved%20source.md)');
  expect(await fs.readFile(copy, 'utf8')).toContain('Later excluded-copy writing.');
});

test('managed reviewed evidence and independent annotations are searchable but ambiguity and rejection invalidate selected support', async () => {
  test.setTimeout(90000); // Three real intake checks and explicit reviewed-revision choices.
  await reviewBundle('accept'); await launch();
  await page.getByLabel('Finalized review folder').fill(path.join(root, 'producer'));
  await page.getByRole('button', { name: 'Connect finalized reviews', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('Source connected'); await intakeCheck();
  const base = path.join(root, 'vault', 'Companion');
  const ledger = JSON.parse(await fs.readFile(path.join(base, '.intake', 'ledger.json'), 'utf8'));
  const imported = Object.values(ledger.captures)[0];
  await fs.writeFile(path.join(base, 'Annotations', 'independent.md'), `---\ncompanion_id: 11111111-1111-4111-8111-111111111111\nartifact_type: annotation\nschema_version: 1\ncapture_id: ${imported.id}\n---\n\nAnnotation canary about chord drills.\n`);
  await search('synthetic');
  await expect(page.locator('#context-results')).toContainText('Human review: accept');
  await expect(page.locator('#context-results')).toContainText('Extraction: partial');
  await expect(page.locator('#context-results')).toContainText('Source association');
  await expect(page.locator('#context-results')).toContainText('Annotation canary');
  await expect(page.locator('#context-results')).toContainText('unversioned capture association');
  await page.locator('#context-results article').filter({ hasText: 'Text match:' }).first().getByRole('button', { name: 'Add to context', exact: true }).click();
  await page.getByRole('button', { name: 'Preview context', exact: true }).click();
  await expect(page.getByLabel('Actual context package', { exact: true })).toHaveValue(new RegExp(imported.currentRevision));
  await expect(page.getByLabel('Actual context package', { exact: true })).not.toHaveValue(/reviewSourceText|locator|source\.json|AppData/);
  await reviewBundle('edit'); await intakeCheck();
  await page.getByRole('button', { name: 'Preview context', exact: true }).click();
  await expect(page.locator('#context-error')).toContainText('unavailable');
  await expect(page.getByLabel('Actual context package', { exact: true })).toHaveValue('');
  await search('synthetic');
  await expect(page.locator('#context-results')).toContainText('No Relevant Context');
  await expect(page.locator('#context-error')).toContainText('unavailable');
  await expect(page.locator('#context-results')).not.toContainText('Annotation canary');
  await page.getByRole('button', { name: 'Inspect source', exact: true }).click();
  await page.getByLabel('Source inspection').getByRole('button', { name: 'Make current', exact: true }).first().click();
  await expect(page.getByRole('status')).toContainText('Current revision selected');
  await reviewBundle('reject'); await intakeCheck();
  await page.getByRole('button', { name: 'Inspect source', exact: true }).click();
  const rejected = page.getByLabel('Source inspection').locator('article').filter({ hasText: 'Human review: reject' });
  await rejected.getByRole('button', { name: 'Make current', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('Current revision selected');
  await search('Annotation synthetic');
  await expect(page.locator('#context-results')).toContainText('No Relevant Context');
  await expect(page.locator('#context-error')).toContainText('rejected');
});



test('approved brief versions and saved-idea dependencies stay exact while proposals, unknown dependencies and damaged pins remain unavailable', async () => {
  test.setTimeout(90000);
  await launch(); await capture('Spaced retrieval can revisit a learned chord.');
  const base = path.join(root, 'vault', 'Companion'), captureDir = path.join(base, 'Captures');
  const file = path.join(captureDir, (await fs.readdir(captureDir)).find(name => name.endsWith('.md')));
  const bytes = await fs.readFile(file, 'utf8'), id = bytes.match(/companion_id: "([^"]+)"/)[1];
  const sha = require('node:crypto').createHash('sha256').update(bytes).digest('hex');
  const readme = path.join(root, 'README.md'); await fs.writeFile(readme, '# MyTune\n\nA guitar practice tutor.\n');
  await fs.writeFile(path.join(root, 'brief-selection.json'), JSON.stringify([readme]));
  await page.getByRole('button', { name: 'Select MyTune README', exact: true }).click();
  await page.getByRole('button', { name: 'Propose brief', exact: true }).click();
  await page.getByLabel('Project purpose', { exact: true }).fill('A guitar practice tutor. PROPOSALCANARY');
  await search('PROPOSALCANARY'); await expect(page.locator('#context-results')).toContainText('No Relevant Context');
  await page.getByLabel('Project purpose', { exact: true }).fill('A guitar practice tutor.');
  await page.getByRole('button', { name: 'Approve proposed brief', exact: true }).click();
  await expect(page.locator('#brief-view')).toContainText('Approved version 1');
  const idea = `---\nartifact_type: saved_idea\nschema_version: 1\ncompanion_id: 22222222-2222-4222-8222-222222222222\nproject_brief_version: 1\nsource_dependencies:\n  - capture_id: ${id}\n    content_sha256: ${sha}\n---\n\nImprovisation canary: an untested user idea.\n`;
  await fs.writeFile(path.join(base, 'Ideas', 'supported.md'), idea);
  await fs.writeFile(path.join(base, 'Ideas', 'unknown.md'), '---\nartifact_type: saved_idea\nschema_version: 1\ncompanion_id: 33333333-3333-4333-8333-333333333333\n---\nUNKNOWNDEPENDENCYCANARY\n');
  await search('guitar');
  await expect(page.locator('#context-results')).toContainText('Approved brief version 1');
  await expect(page.locator('#context-results')).toContainText('Project association');
  await expect(page.locator('#context-results')).toContainText('Improvisation canary');
  await expect(page.locator('#context-error')).toContainText('dependency');
  await expect(page.locator('#context-results')).not.toContainText('UNKNOWNDEPENDENCYCANARY');
  await page.locator('#context-results article').filter({ hasText: 'Approved brief version 1' }).first().getByRole('button', { name: 'Add to context', exact: true }).click();
  await page.locator('#context-results article').filter({ hasText: 'Improvisation canary' }).getByRole('button', { name: 'Add to context', exact: true }).click();
  await fs.writeFile(readme, '# MyTune\n\nA rhythm practice coach.\n');
  await page.getByRole('button', { name: 'Propose brief', exact: true }).click();
  await page.getByRole('button', { name: 'Approve proposed brief', exact: true }).click();
  await expect(page.locator('#brief-view')).toContainText('Approved version 2');
  await page.getByRole('button', { name: 'Preview context', exact: true }).click();
  await expect(page.getByLabel('Actual context package', { exact: true })).toHaveValue(/Approved brief version 1/);
  await expect(page.getByLabel('Actual context package', { exact: true })).not.toHaveValue(/rhythm practice coach|AppData/);
  await expect(page.locator('#context-summary')).toContainText('brief input');
  await fs.unlink(file); await page.getByRole('button', { name: 'Preview context', exact: true }).click();
  await expect(page.locator('#context-error')).toContainText('unavailable');
  await fs.writeFile(file, bytes);
  const approved = (await fs.readdir(path.join(base, 'Briefs'))).find(name => name.startsWith('approved-1-'));
  await fs.writeFile(path.join(base, 'Briefs', approved), 'Damaged requested historical pin.');
  await page.getByRole('button', { name: 'Preview context', exact: true }).click();
  await expect(page.locator('#context-error')).toContainText('unavailable');
  await expect(page.getByLabel('Actual context package', { exact: true })).toHaveValue('');
});

test('actual serialized package counts Unicode code points at 32000 and 32001 and enforces a stricter verified input bound', async () => {
  test.setTimeout(60000);
  await launch();
  const question = '😀'.repeat(31976) + 'e\u0301\n'; // 31979 code points, plus the literal 21-point package envelope.
  await page.getByLabel('Context question', { exact: true }).fill(question);
  await page.getByRole('button', { name: 'Preview context', exact: true }).click();
  await expect(page.locator('#context-summary')).toContainText('32000 / 32000 Unicode code points. Within limit');
  await expect(page.getByLabel('Actual context package', { exact: true })).toHaveValue('Question:\n' + question + '\n\nSources:\n');
  await page.getByLabel('Context question', { exact: true }).fill(question + 'x');
  await page.getByRole('button', { name: 'Preview context', exact: true }).click();
  await expect(page.locator('#context-summary')).toContainText('32001 / 32000 Unicode code points. Oversized');
  await expect(page.getByLabel('Actual context package', { exact: true })).toHaveValue('Question:\n' + question + 'x\n\nSources:\n');
  await fs.writeFile(path.join(root, 'context-bound.json'), JSON.stringify({ model: 'controlled-model', maxCodePoints: 100, evidence: 'controlled verified model-input bound' }));
  await page.getByLabel('Context question', { exact: true }).fill('😀'.repeat(80));
  await page.getByRole('button', { name: 'Preview context', exact: true }).click();
  await expect(page.locator('#context-summary')).toContainText('101 / 100 Unicode code points. Oversized');
  await expect(page.locator('#context-summary')).toContainText('controlled verified model-input bound');
  await expect(page.locator('#context-summary')).toContainText('Application cap: 32000');
});

test('editing a shorter passage keeps the new text unapproved when an older approval arrives', async () => {
  await launch();
  const text = '# Shortening notes\n\nEDITSHORT older supported sentence.\nEDITSHORT newly selected sentence.\n\nSurrounding source material.\n';
  const file = path.join(root, 'vault', 'shortening.md'); await fs.writeFile(file, text);
  await fs.writeFile(path.join(root, 'context-selection.json'), JSON.stringify([file]));
  await page.getByRole('button', { name: 'Include vault notes', exact: true }).click();
  await expect(page.locator('#context-notes')).toContainText(file);
  await page.getByLabel('Context question', { exact: true }).fill('EDITSHORT');
  await page.getByRole('button', { name: 'Find context', exact: true }).click();
  const results = page.locator('#context-results');
  await expect(results).toContainText('EDITSHORT older supported sentence.');
  await results.getByRole('button', { name: 'Add to context', exact: true }).click();
  const selected = page.locator('#context-selected');
  const editor = selected.getByLabel('Shorter passage', { exact: true });
  await editor.fill('EDITSHORT older supported sentence.');
  await app.evaluate(({ ipcMain }) => {
    if (!process.env.COMPANION_TEST_ROOT) throw Error('Delayed shortening requires the disposable fixture.');
    const original = ipcMain._invokeHandlers.get('context-shorten');
    if (!original) throw Error('Context shortening handler is unavailable.');
    const gate = globalThis.__shorteningDelivery = { original, held: false, calls: 0 };
    const delivery = new Promise(resolve => { gate.release = resolve; });
    ipcMain._invokeHandlers.set('context-shorten', async function (...args) {
      const first = ++gate.calls === 1;
      const result = await Reflect.apply(original, this, args);
      if (first) { gate.held = true; await delivery; }
      return result;
    });
  });
  try {
    await page.evaluate(() => {
      const button = [...document.querySelectorAll('#context-selected button')].find(node => node.textContent === 'Approve shorter passage');
      const observation = window.__shorteningOnclickSettlement = { button, original: button.onclick, calls: 0, first: null };
      button.onclick = function (...args) {
        const first = ++observation.calls === 1;
        const returned = Reflect.apply(observation.original, this, args);
        if (first) observation.first = returned;
        return returned;
      };
    });
    await selected.getByRole('button', { name: 'Approve shorter passage', exact: true }).click();
    await expect.poll(() => app.evaluate(() => globalThis.__shorteningDelivery.held)).toBe(true);
    await editor.fill('EDITSHORT newly selected sentence.');
    await expect(selected).toContainText('Shortening needs explicit approval.');
    await app.evaluate(() => globalThis.__shorteningDelivery.release());
    await page.evaluate(() => window.__shorteningOnclickSettlement.first);
    await expect(editor).toHaveValue('EDITSHORT newly selected sentence.');
    await expect(selected).toContainText('Shortening needs explicit approval.');
    await expect(selected).not.toContainText('Shortening approved.');
    await page.getByRole('button', { name: 'Preview context', exact: true }).click();
    const preview = page.getByLabel('Actual context package', { exact: true });
    await expect(preview).toHaveValue(/Surrounding source material\./);
    await expect(preview).not.toHaveValue(/Explicitly shortened passage/);
    await selected.getByRole('button', { name: 'Approve shorter passage', exact: true }).click();
    await expect(selected).toContainText('Shortening approved.');
    await page.getByRole('button', { name: 'Preview context', exact: true }).click();
    const sha = require('node:crypto').createHash('sha256').update(text).digest('hex');
    const expected = `Question:\nEDITSHORT\n\nSources:\nExplicit vault note shortening.md; sha256 ${sha}; user selected; not independently verified; Explicitly shortened passage\nEDITSHORT newly selected sentence.`;
    await expect(preview).toHaveValue(expected);
    await expect(page.locator('#context-error')).toHaveText('');
  } finally {
    await app.evaluate(({ ipcMain }) => {
      const gate = globalThis.__shorteningDelivery;
      ipcMain._invokeHandlers.set('context-shorten', gate.original); gate.release();
      delete globalThis.__shorteningDelivery;
    });
    await page.evaluate(async () => {
      const observation = window.__shorteningOnclickSettlement;
      if (observation) {
        try { await observation.first; }
        finally { observation.button.onclick = observation.original; delete window.__shorteningOnclickSettlement; }
      }
    });
  }
});

test('oversized selections stay intact until the inspected shorter passage is explicitly approved and source changes revoke approval', async () => {
  test.setTimeout(60000);
  await launch(); await capture('Long excerpt:\n' + 'x'.repeat(32000) + '\nFinal supported sentence.');
  await search('supported');
  await page.locator('#context-results').getByRole('button', { name: 'Add to context', exact: true }).click();
  await page.getByRole('button', { name: 'Preview context', exact: true }).click();
  await expect(page.locator('#context-summary')).toContainText('Oversized');
  await expect(page.getByLabel('Actual context package', { exact: true })).toHaveValue(/x{32000}/);
  await expect(page.locator('#context-selected')).toContainText('Long excerpt:');
  await page.getByLabel('Shorter passage', { exact: true }).fill('Final supported sentence.');
  await page.getByRole('button', { name: 'Preview context', exact: true }).click();
  await expect(page.locator('#context-summary')).toContainText('Oversized');
  await expect(page.getByLabel('Actual context package', { exact: true })).toHaveValue(/x{32000}/);
  await page.getByRole('button', { name: 'Approve shorter passage', exact: true }).click();
  await expect(page.locator('#context-selected')).toContainText('Shortening approved');
  await page.getByRole('button', { name: 'Preview context', exact: true }).click();
  await expect(page.locator('#context-summary')).toContainText('Within limit');
  await expect(page.getByLabel('Actual context package', { exact: true })).toHaveValue(/Explicitly shortened passage/);
  await expect(page.getByLabel('Actual context package', { exact: true })).toHaveValue(/Final supported sentence\./);
  await expect(page.getByLabel('Actual context package', { exact: true })).not.toHaveValue(/x{100}/);
  const dir = path.join(root, 'vault', 'Companion', 'Captures');
  const file = path.join(dir, (await fs.readdir(dir)).find(name => name.endsWith('.md')));
  await fs.appendFile(file, '\nChanged source after shortening approval.\n');
  await page.getByRole('button', { name: 'Preview context', exact: true }).click();
  await expect(page.locator('#context-error')).toContainText('changed or is unavailable');
  await expect(page.getByLabel('Actual context package', { exact: true })).toHaveValue('');
});

test('pending passage approval keeps both previews unavailable until the inspected passage is selected', async () => {
  await launch();
  const text = '# Field notes\n\nUnrelated opening material.\n\nSpaced retrieval revisits a learned chord.\nA short practice check measures recall.\n\nUnrelated closing material.\n';
  const file = path.join(root, 'vault', 'field.md'); await fs.writeFile(file, text);
  await fs.writeFile(path.join(root, 'context-selection.json'), JSON.stringify([file]));
  await page.getByRole('button', { name: 'Include vault notes', exact: true }).click();
  await search('retrieval recall');
  const passage = page.locator('#context-results .context-passage').first();
  await expect(passage).toContainText('lines 5-6');
  await expect(passage).toContainText('Spaced retrieval revisits a learned chord.');
  await expect(passage).toContainText('A short practice check measures recall.');
  await app.evaluate(({ ipcMain }) => {
    if (!process.env.COMPANION_TEST_ROOT) throw Error('Delayed passage requires the disposable fixture.');
    const original = ipcMain._invokeHandlers.get('context-passage');
    if (!original) throw Error('Context passage handler is unavailable.');
    const gate = globalThis.__contextPassageDelivery = { original, held: false };
    const delivery = new Promise(resolve => { gate.release = resolve; });
    ipcMain._invokeHandlers.set('context-passage', async function (...args) {
      const result = await Reflect.apply(original, this, args);
      gate.held = true;
      await delivery;
      return result;
    });
  });
  try {
    await passage.getByRole('button', { name: 'Add passage', exact: true }).click();
    await expect.poll(() => app.evaluate(() => globalThis.__contextPassageDelivery.held)).toBe(true);
    await expect(page.getByRole('button', { name: 'Preview context', exact: true })).toBeDisabled();
    await expect(page.getByRole('button', { name: 'Preview conversation', exact: true })).toBeDisabled();
    await expect(page.locator('#context-selected article')).toHaveCount(0);
    await app.evaluate(() => globalThis.__contextPassageDelivery.release());
    await expect(page.locator('#context-selected').getByLabel('Shorter passage', { exact: true })).toHaveValue('Spaced retrieval revisits a learned chord.\nA short practice check measures recall.');
    await expect(page.locator('#context-selected')).toContainText('Explicit passage lines 5-6');
    await expect(page.getByRole('button', { name: 'Preview context', exact: true })).toBeEnabled();
    await expect(page.getByRole('button', { name: 'Preview conversation', exact: true })).toBeEnabled();
    await page.getByRole('button', { name: 'Preview context', exact: true }).click();
    const sha = require('node:crypto').createHash('sha256').update(text).digest('hex');
    const expected = `Question:\nretrieval recall\n\nSources:\nExplicit vault note field.md; sha256 ${sha}; user selected; not independently verified; Explicit passage lines 5-6\nSpaced retrieval revisits a learned chord.\nA short practice check measures recall.`;
    await expect(page.getByLabel('Actual context package', { exact: true })).toHaveValue(expected);
    await expect(page.locator('#context-error')).toHaveText('');
  } finally {
    await app.evaluate(({ ipcMain }) => {
      const gate = globalThis.__contextPassageDelivery;
      ipcMain._invokeHandlers.set('context-passage', gate.original);
      gate.release();
      delete globalThis.__contextPassageDelivery;
    });
  }
});

test('ranked matching paragraphs expose exact line anchors and explicit passage selection preserves the inspected text', async () => {
  await launch();
  const text = '# Field notes\r\n\r\nUnrelated opening material.\r\n\r\nSpaced retrieval revisits a learned chord.\r\nA short practice check measures recall.\r\n\r\nUnrelated closing material.\r\n';
  const file = path.join(root, 'vault', 'field.md'); await fs.writeFile(file, text);
  await fs.writeFile(path.join(root, 'context-selection.json'), JSON.stringify([file]));
  await page.getByRole('button', { name: 'Include vault notes', exact: true }).click();
  await search('retrieval recall');
  const passage = page.locator('#context-results .context-passage').first();
  await expect(passage).toContainText('lines 5-6');
  await expect(passage).toContainText('Spaced retrieval revisits a learned chord.');
  await expect(passage).toContainText('A short practice check measures recall.');
  await expect(passage).not.toContainText('Unrelated opening material');
  await passage.getByRole('button', { name: 'Add passage', exact: true }).click();
  await page.getByRole('button', { name: 'Preview context', exact: true }).click();
  const sha = require('node:crypto').createHash('sha256').update(text).digest('hex');
  const expected = `Question:\nretrieval recall\n\nSources:\nExplicit vault note field.md; sha256 ${sha}; user selected; not independently verified; Explicit passage lines 5-6\nSpaced retrieval revisits a learned chord.\nA short practice check measures recall.`;
  await expect(page.getByLabel('Actual context package', { exact: true })).toHaveValue(expected);
  await expect(page.locator('#context-summary')).toContainText(`${Array.from(expected).length} / 32000`);
  await page.locator('#context-selected').getByRole('button', { name: 'Use full source', exact: true }).click();
  await page.getByRole('button', { name: 'Preview context', exact: true }).click();
  await expect(page.getByLabel('Actual context package', { exact: true })).toHaveValue(/Unrelated opening material/);
});

test('source-associated saved ideas can be selected and explicit source removal excludes their support until a new selection', async () => {
  await launch(); await capture('Needle source statement.');
  const base = path.join(root, 'vault', 'Companion'), dir = path.join(base, 'Captures');
  const content = await fs.readFile(path.join(dir, (await fs.readdir(dir)).find(name => name.endsWith('.md'))), 'utf8');
  const id = content.match(/companion_id: "([^"]+)"/)[1], sha = require('node:crypto').createHash('sha256').update(content).digest('hex');
  await fs.writeFile(path.join(base, 'Ideas', 'associated.md'), `---\nartifact_type: saved_idea\nschema_version: 1\ncompanion_id: 44444444-4444-4444-8444-444444444444\ntitle: Dependent idea\nsource_dependencies:\n  - capture_id: ${id}\n    content_sha256: ${sha}\n---\n\nDifferently worded derived canary.\n`);
  await search('Needle');
  const idea = page.locator('#context-results article').filter({ has: page.getByRole('heading', { name: 'Dependent idea', exact: true }) });
  await expect(idea).toContainText(`Source association with ${id}`);
  await expect(idea).not.toContainText('Text match:');
  await page.locator('#context-results article').filter({ has: page.getByRole('heading', { name: 'Needle source statement.', exact: true }) }).getByRole('button', { name: 'Add to context', exact: true }).click();
  await idea.getByRole('button', { name: 'Add to context', exact: true }).click();
  await page.getByRole('button', { name: 'Preview context', exact: true }).click();
  await expect(page.getByLabel('Actual context package', { exact: true })).toHaveValue(/Differently worded derived canary/);
  await page.locator('#context-selected article').filter({ has: page.getByText('Needle source statement.', { exact: true }) }).getByRole('button', { name: 'Remove from context', exact: true }).click();
  await page.getByRole('button', { name: 'Preview context', exact: true }).click();
  await expect(page.locator('#context-summary')).toContainText('Excluded');
  await expect(page.getByLabel('Actual context package', { exact: true })).not.toHaveValue(/derived canary|Needle source statement/);
  expect(await fs.readFile(path.join(base, 'Ideas', 'associated.md'), 'utf8')).toContain('Differently worded derived canary');
  await page.getByLabel('Manual context source', { exact: true }).selectOption({ label: 'Needle source statement.' });
  await page.getByRole('button', { name: 'Add manual source', exact: true }).click();
  await expect(page.getByLabel('Actual context package', { exact: true })).toHaveValue('');
  await page.getByRole('button', { name: 'Preview context', exact: true }).click();
  await expect(page.getByLabel('Actual context package', { exact: true })).toHaveValue(/Needle source statement/);
  await expect(page.getByLabel('Actual context package', { exact: true })).toHaveValue(/derived canary/);
});


test('intake authority survives mutable capture type labels and explicit-note inclusion cannot bypass managed rejection', async () => {
  await reviewBundle('reject'); await launch();
  await page.getByLabel('Finalized review folder').fill(path.join(root, 'producer'));
  await page.getByRole('button', { name: 'Connect finalized reviews', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('Source connected'); await intakeCheck();
  const dir = path.join(root, 'vault', 'Companion', 'Captures'), file = path.join(dir, (await fs.readdir(dir)).find(name => name.endsWith('.md')));
  const original = await fs.readFile(file, 'utf8');
  await fs.writeFile(file, original.replace('capture_type: "reel_import"', 'capture_type: "thought"') + '\nTYPEBYPASSCANARY\n');
  await search('TYPEBYPASSCANARY');
  await expect(page.locator('#context-results')).toContainText('No Relevant Context');
  await expect(page.locator('#context-error')).toContainText('rejected');
  await page.getByRole('button', { name: 'Refresh', exact: true }).click();
  await expect(page.locator('#captures article')).toContainText('reel_import');
  await expect(page.locator('#captures article').getByRole('button', { name: 'Inspect source', exact: true })).toBeVisible();
  await fs.writeFile(path.join(root, 'context-selection.json'), JSON.stringify([file]));
  await page.getByRole('button', { name: 'Include vault notes', exact: true }).click();
  await expect(page.locator('#context-error')).toContainText('Managed material');
  const copy = path.join(root, 'vault', 'copied.md'); await fs.writeFile(copy, original);
  await fs.writeFile(path.join(root, 'context-selection.json'), JSON.stringify([copy]));
  await page.getByRole('button', { name: 'Include vault notes', exact: true }).click();
  await expect(page.locator('#context-error')).toContainText('cannot bypass context eligibility');
  await fs.writeFile(file, original); await search('synthetic');
  await expect(page.locator('#context-results')).toContainText('No Relevant Context');
});


test('two desktop instances preserve an explicit scope exclusion during an overlapping note inclusion', async () => {
  test.setTimeout(90000);
  await launch();
  const base = path.join(root, 'vault', 'base.md'), added = path.join(root, 'vault', 'added.md');
  await fs.writeFile(base, 'BASESCOPECANARY'); await fs.writeFile(added, 'ADDEDSCOPECANARY');
  await fs.writeFile(path.join(root, 'context-selection.json'), JSON.stringify([base]));
  await page.getByRole('button', { name: 'Include vault notes', exact: true }).click();
  await expect(page.locator('#context-notes')).toContainText(base);
  const secondApp = await electron.launch({ args: ['.'], env: { ...process.env, COMPANION_TEST_ROOT: root } });
  try {
    const second = await secondApp.firstWindow();
    await settledStartup(second);
    await second.getByLabel('Context question', { exact: true }).fill('BASESCOPECANARY');
    await second.getByRole('button', { name: 'Find context', exact: true }).click();
    await expect(second.locator('#context-notes')).toContainText(base);
    await fs.writeFile(path.join(root, 'context-selection.json'), JSON.stringify([added]));
    await fs.writeFile(path.join(root, 'faults.json'), JSON.stringify({ pause: 'context-before-scope-publish' }));
    await page.getByRole('button', { name: 'Include vault notes', exact: true }).click();
    await expect.poll(() => fs.readFile(path.join(root, 'checkpoint.txt'), 'utf8').catch(() => '')).toBe('context-before-scope-publish');
    await second.locator('#context-notes').getByRole('button', { name: 'Exclude note', exact: true }).click();
    await expect.poll(async () => (await second.locator('#context-error').textContent()).includes('busy') || await second.locator('#context-notes').getByRole('button', { name: 'Exclude note', exact: true }).count() === 0).toBe(true);
    const busy = (await second.locator('#context-error').textContent()).includes('busy');
    await fs.writeFile(path.join(root, 'release.txt'), 'release');
    await expect(page.locator('#context-notes')).toContainText(added);
    if (busy) {
      await second.locator('#context-notes p').filter({ hasText: base }).getByRole('button', { name: 'Exclude note', exact: true }).click();
      await expect(second.locator('#context-notes')).not.toContainText(base);
    }
    await second.getByRole('button', { name: 'Find context', exact: true }).click();
    await expect(second.locator('#context-notes')).toContainText(added);
    await expect(second.locator('#context-results')).toContainText('No Relevant Context');
    await expect(second.locator('#context-notes')).not.toContainText(base);
  } finally { await fs.writeFile(path.join(root, 'release.txt'), 'release'); await secondApp.close(); }
  await app.close(); app = null; await launch(false); await search('BASESCOPECANARY');
  await expect(page.locator('#context-results')).toContainText('No Relevant Context');
  await expect(page.locator('#context-notes')).toContainText(added);
});


test('supported unreviewed drafts and explicit link excerpts retain provenance while held and unadmitted material stay outside discovery', async () => {
  test.setTimeout(60000);
  const fixture = require('./fixtures/reel-draft/example.json'), ready = path.join(root, 'producer', 'ready'); await fs.mkdir(ready, { recursive: true });
  const run = { job_id: 'b'.repeat(64), attempt_id: '1'.repeat(32), started_utc: '2026-11-01T10:00:00Z', input_sha256: 'a'.repeat(64), input_kind: 'synthetic_fixture', result_kind: 'synthetic_video_wiring', state: 'partial', validation: 'passed' };
  await fs.writeFile(path.join(ready, 'run.json'), JSON.stringify(run));
  await fs.writeFile(path.join(ready, 'evidence.json'), JSON.stringify({ ...fixture.input, clip_id: run.job_id }));
  await fs.writeFile(path.join(ready, 'first-pass-target.json'), JSON.stringify(fixture.target));
  await fs.copyFile(path.join(__dirname, 'fixtures/reel-draft/notes.md'), path.join(ready, 'notes.md'));
  const held = path.join(root, 'producer', 'held'); await fs.cp(ready, held, { recursive: true });
  await fs.writeFile(path.join(held, 'run.json'), JSON.stringify({ ...run, state: 'failed' })); await fs.appendFile(path.join(held, 'notes.md'), '\nHELDMATERIALCANARY\n');
  await launch();
  await page.getByLabel('Draft source folder').fill(path.join(root, 'producer'));
  await page.getByRole('button', { name: 'Connect draft source', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('Source connected'); await intakeCheck();
  await fs.writeFile(path.join(root, 'vault', 'Companion', 'Captures', 'unadmitted.md'), '---\ncompanion_id: 55555555-5555-4555-8555-555555555555\nartifact_type: capture\nschema_version: 1\ncapture_type: reel_import\ncaptured_at: 2026-11-08T06:59:00Z\ntitle: Unadmitted\n---\nUNADMITTEDCANARY\n');
  await search('retries');
  await expect(page.locator('#context-results')).toContainText('Human review: unreviewed');
  await expect(page.locator('#context-results')).toContainText('Processing: partial');
  await expect(page.locator('#context-results')).toContainText('Extraction: partial');
  await expect(page.locator('#context-results')).toContainText('Authored synthetic fixture');
  await page.locator('#context-results').getByRole('button', { name: 'Add to context', exact: true }).click();
  await search('HELDMATERIALCANARY UNADMITTEDCANARY');
  await expect(page.locator('#context-results')).toContainText('No Relevant Context');
  await expect(page.locator('#context-error')).toContainText('not admitted');
  await capture('https://example.test/barecanary'); await search('barecanary');
  await expect(page.locator('#context-results')).toContainText('user-supplied link; webpage not fetched or verified');
  await page.getByLabel('Thought or link', { exact: true }).fill('https://example.test/excerptcanary');
  await page.getByRole('button', { name: 'Add source excerpt', exact: true }).click();
  await page.getByLabel('User-supplied excerpt').fill('USEREXCERPTCANARY spaced practice.');
  await page.getByRole('button', { name: 'Save capture', exact: true }).click();
  await expect(page.getByLabel('Thought or link', { exact: true })).toHaveValue('');
  await expect(page.getByRole('status')).toContainText('Capture saved.');
  await search('USEREXCERPTCANARY');
  await expect(page.locator('#context-results')).toContainText('user-supplied excerpt; webpage not verified');
  await page.locator('#context-results').getByRole('button', { name: 'Add to context', exact: true }).click();
  await page.getByRole('button', { name: 'Preview context', exact: true }).click();
  await expect(page.getByLabel('Actual context package', { exact: true })).toHaveValue(/Human review: unreviewed/);
  await expect(page.getByLabel('Actual context package', { exact: true })).toHaveValue(/Authored synthetic fixture/);
  await expect(page.getByLabel('Actual context package', { exact: true })).toHaveValue(/USEREXCERPTCANARY/);
  await expect(page.getByLabel('Actual context package', { exact: true })).toHaveValue(/https:\/\/example\.test\/excerptcanary/);
  await expect(page.getByLabel('Actual context package', { exact: true })).not.toHaveValue(/HELDMATERIALCANARY|UNADMITTEDCANARY|source\.json|AppData/);
});



test('explicit brief removal excludes a saved idea with that validated project dependency until a new preview', async () => {
  test.setTimeout(60000);
  await launch();
  const readme = path.join(root, 'README.md'); await fs.writeFile(readme, '# MyTune\n\nA guitar practice tutor.\n');
  await fs.writeFile(path.join(root, 'brief-selection.json'), JSON.stringify([readme]));
  await page.getByRole('button', { name: 'Select MyTune README', exact: true }).click();
  await page.getByRole('button', { name: 'Propose brief', exact: true }).click();
  await page.getByRole('button', { name: 'Approve proposed brief', exact: true }).click();
  await expect(page.locator('#brief-view')).toContainText('Approved version 1');
  const ideaFile = path.join(root, 'vault', 'Companion', 'Ideas', 'project-dependent.md');
  const ideaText = '---\nartifact_type: saved_idea\nschema_version: 1\ncompanion_id: 66666666-6666-4666-8666-666666666666\ntitle: Brief dependent idea\nsource_dependencies: []\nproject_brief_version: 1\n---\nBRIEFDERIVEDCANARY retained user interpretation.\n';
  await fs.writeFile(ideaFile, ideaText); await search('guitar');
  const brief = page.locator('#context-results article').filter({ has: page.getByRole('heading', { name: 'Approved brief version 1', exact: true }) });
  const idea = page.locator('#context-results article').filter({ has: page.getByRole('heading', { name: 'Brief dependent idea', exact: true }) });
  await expect(idea).toContainText('Project association');
  await brief.getByRole('button', { name: 'Add to context', exact: true }).click();
  await idea.getByRole('button', { name: 'Add to context', exact: true }).click();
  await page.getByRole('button', { name: 'Preview context', exact: true }).click();
  await expect(page.getByLabel('Actual context package', { exact: true })).toHaveValue(/BRIEFDERIVEDCANARY/);
  await page.locator('#context-selected article').filter({ has: page.getByText('Approved brief version 1', { exact: true }) }).getByRole('button', { name: 'Remove from context', exact: true }).click();
  await page.getByRole('button', { name: 'Preview context', exact: true }).click();
  await expect(page.locator('#context-summary')).toContainText('Excluded');
  await expect(page.getByLabel('Actual context package', { exact: true })).not.toHaveValue(/BRIEFDERIVEDCANARY/);
  expect(await fs.readFile(ideaFile, 'utf8')).toBe(ideaText);
  await page.getByLabel('Manual context source', { exact: true }).selectOption({ label: 'Approved brief version 1' });
  await page.getByRole('button', { name: 'Add manual source', exact: true }).click();
  await expect(page.getByLabel('Actual context package', { exact: true })).toHaveValue('');
  await page.getByRole('button', { name: 'Preview context', exact: true }).click();
  await expect(page.getByLabel('Actual context package', { exact: true })).toHaveValue(/BRIEFDERIVEDCANARY/);
});

test('delayed preview results and errors cannot replace the package for changed current controls', async () => {
  test.setTimeout(90000);
  await launch(); await capture('Preview race source.'); await search('Preview');
  await page.locator('#context-results').getByRole('button', { name: 'Add to context', exact: true }).click();
  await fs.writeFile(path.join(root, 'faults.json'), JSON.stringify({ pause: 'context-before-preview-read' }));
  await page.getByRole('button', { name: 'Preview context', exact: true }).click();
  await expect.poll(() => fs.readFile(path.join(root, 'checkpoint.txt'), 'utf8').catch(() => '')).toBe('context-before-preview-read');
  await page.getByLabel('Context question', { exact: true }).fill('New question');
  await fs.writeFile(path.join(root, 'release.txt'), 'release');
  await expect(page.locator('#context-summary')).toContainText('Earlier preview ignored');
  await expect(page.getByLabel('Actual context package', { exact: true })).toHaveValue('');
  await fs.unlink(path.join(root, 'release.txt')); await fs.unlink(path.join(root, 'checkpoint.txt'));
  await page.getByRole('button', { name: 'Preview context', exact: true }).click();
  await expect.poll(() => fs.readFile(path.join(root, 'checkpoint.txt'), 'utf8').catch(() => '')).toBe('context-before-preview-read');
  await page.locator('#context-selected').getByRole('button', { name: 'Remove from context', exact: true }).click();
  await page.getByLabel('Context question', { exact: true }).fill('Newest question');
  const dir = path.join(root, 'vault', 'Companion', 'Captures'), file = path.join(dir, (await fs.readdir(dir)).find(name => name.endsWith('.md')));
  await fs.appendFile(file, '\nChanged before older request reads its selection.\n');
  await fs.writeFile(path.join(root, 'faults.json'), '{}');
  await page.getByRole('button', { name: 'Preview context', exact: true }).click();
  const expected = 'Question:\nNewest question\n\nSources:\n';
  await expect(page.getByLabel('Actual context package', { exact: true })).toHaveValue(expected);
  await expect(page.locator('#context-summary')).toContainText('Within limit');
  await fs.writeFile(path.join(root, 'release.txt'), 'release');
  await expect(page.locator('#context-summary')).toContainText('Earlier preview ignored');
  await expect(page.getByLabel('Actual context package', { exact: true })).toHaveValue(expected);
  await expect(page.locator('#context-error')).toHaveText('');
});
