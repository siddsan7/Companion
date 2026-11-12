const { test, expect, _electron: electron } = require('@playwright/test');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
let root, app, page, readme;
test.beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'companion-brief-'));
  readme = path.join(root, 'README.md');
  await fs.writeFile(readme, '# MyTune\n\nA guitar practice tutor.\n\n## Constraints\n\nEight free lessons.\n');
  await fs.writeFile(path.join(root, 'clock.json'), JSON.stringify({ now: '2026-11-08T06:59:00Z', timezone: 'America/Phoenix' }));
  await fs.writeFile(path.join(root, 'brief-selection.json'), JSON.stringify([readme]));
});
test.afterEach(async () => { if (app) await app.close(); app = null; await fs.rm(root, { recursive: true, force: true }); });
async function launch() { app = await electron.launch({ args: ['.'], env: { ...process.env, COMPANION_TEST_ROOT: root } }); page = await app.firstWindow(); }
test('an unfinished brief refresh cannot approve the previously displayed proposal', async () => {
  await launch();
  await page.getByRole('button', { name: 'Choose vault', exact: true }).click();
  await page.getByRole('button', { name: 'Use this folder', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('Vault ready.');
  await page.getByRole('button', { name: 'Select MyTune README', exact: true }).click();
  await page.getByRole('button', { name: 'Propose brief', exact: true }).click();
  await page.getByRole('button', { name: 'Approve proposed brief', exact: true }).click();
  await expect(page.locator('#brief-view')).toContainText('Approved version 1');
  const folder = path.join(root, 'vault', 'Companion', 'Briefs');
  const first = path.join(folder, (await fs.readdir(folder)).find(name => name.startsWith('approved-1-')));
  const approvedBytes = await fs.readFile(first);
  await fs.writeFile(readme, '# MyTune\n\nA rhythm practice coach.\n');
  await app.evaluate(({ ipcMain }) => {
    if (!process.env.COMPANION_TEST_ROOT) throw Error('Delayed brief refresh requires the disposable fixture.');
    const original = ipcMain._invokeHandlers.get('brief-propose');
    const gate = globalThis.__briefProposalDelivery = { original, held: false };
    const delivery = new Promise(resolve => { gate.release = resolve; });
    ipcMain._invokeHandlers.set('brief-propose', async function (...args) {
      const result = await Reflect.apply(original, this, args);
      gate.held = true;
      await delivery;
      return result;
    });
  });
  try {
    await page.getByRole('button', { name: 'Propose brief', exact: true }).click();
    await expect.poll(() => app.evaluate(() => globalThis.__briefProposalDelivery.held)).toBe(true);
    await expect(page.getByRole('button', { name: 'Approve proposed brief', exact: true })).toBeDisabled();
    expect(await fs.readFile(first)).toEqual(approvedBytes);
    await app.evaluate(() => globalThis.__briefProposalDelivery.release());
    await expect(page.getByLabel('Project purpose', { exact: true })).toHaveValue('A rhythm practice coach.');
    await page.getByRole('button', { name: 'Approve proposed brief', exact: true }).click();
    await expect(page.locator('#brief-view')).toContainText('Approved version 2');
    expect(await fs.readFile(first)).toEqual(approvedBytes);
    const second = path.join(folder, (await fs.readdir(folder)).find(name => name.startsWith('approved-2-')));
    expect(await fs.readFile(second, 'utf8')).toContain('A rhythm practice coach.');
    await expect(page.locator('#brief-error')).toHaveText('');
  } finally {
    await app.evaluate(({ ipcMain }) => {
      const gate = globalThis.__briefProposalDelivery;
      ipcMain._invokeHandlers.set('brief-propose', gate.original);
      gate.release();
      delete globalThis.__briefProposalDelivery;
    });
  }
});

test('same-vault configuration keeps a persisted failed proposal unavailable for approval', async () => {
  await launch();
  await page.getByRole('button', { name: 'Choose vault', exact: true }).click();
  await page.getByRole('button', { name: 'Use this folder', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('Vault ready.');
  await page.getByRole('button', { name: 'Select MyTune README', exact: true }).click();
  await page.getByRole('button', { name: 'Propose brief', exact: true }).click();
  await page.getByRole('button', { name: 'Approve proposed brief', exact: true }).click();
  await expect(page.locator('#brief-view')).toContainText('Approved version 1');
  const folder = path.join(root, 'vault', 'Companion', 'Briefs');
  const first = path.join(folder, (await fs.readdir(folder)).find(name => name.startsWith('approved-1-')));
  const approvedBytes = await fs.readFile(first);
  await fs.unlink(readme);
  await page.getByRole('button', { name: 'Propose brief', exact: true }).click();
  await expect(page.locator('#brief-error')).toContainText('ENOENT');
  const failure = (await fs.readdir(folder)).find(name => name.startsWith('failure-'));
  expect(await fs.readFile(path.join(folder, failure), 'utf8')).toContain('ENOENT');
  await page.getByRole('button', { name: 'Check brief inputs', exact: true }).click();
  await expect(page.locator('#brief-view')).toContainText('Refresh failed:');
  await expect(page.getByRole('button', { name: 'Approve proposed brief', exact: true })).toBeDisabled();
  const previousProposal = await page.locator('#brief-proposal').elementHandle();
  await page.evaluate(() => {
    const view = document.getElementById('brief-view');
    const observation = window.__failedBriefApprovalObservation = { exposed: false, samples: 0 };
    observation.observer = new MutationObserver(() => {
      // Sample the settled DOM, not temporary default-enabled nodes constructed before controls().
      const approve = view.querySelector('#brief-proposal button');
      observation.samples++;
      if (approve?.isConnected && !approve.disabled && view.textContent.includes('Refresh failed:')) observation.exposed = true;
    });
    observation.observer.observe(view, { childList: true, subtree: true, attributes: true, attributeFilter: ['disabled'] });
  });
  try {
    await page.getByRole('button', { name: 'Use this folder', exact: true }).click();
    // The old ready status is unchanged; only a replacement article proves this state was rendered.
    await expect.poll(() => previousProposal.evaluate(node => node.isConnected)).toBe(false);
    await expect(page.locator('#brief-view')).toContainText('Refresh failed:');
    const observation = await page.evaluate(() => ({ exposed: window.__failedBriefApprovalObservation.exposed, samples: window.__failedBriefApprovalObservation.samples }));
    expect(observation.samples).toBeGreaterThan(0);
    expect(observation.exposed).toBe(false);
    await expect(page.getByRole('button', { name: 'Approve proposed brief', exact: true })).toBeDisabled();
    expect(await fs.readFile(first)).toEqual(approvedBytes);
    expect((await fs.readdir(folder)).filter(name => name.startsWith('approved-'))).toHaveLength(1);
  } finally {
    await page.evaluate(() => {
      window.__failedBriefApprovalObservation.observer.disconnect();
      delete window.__failedBriefApprovalObservation;
    });
    await previousProposal.dispose();
  }
});

test('same-vault configuration read failure leaves explicit brief recovery available', async () => {
  await launch();
  await page.getByRole('button', { name: 'Choose vault', exact: true }).click();
  await page.getByRole('button', { name: 'Use this folder', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('Vault ready.');
  await page.getByRole('button', { name: 'Select MyTune README', exact: true }).click();
  await page.getByRole('button', { name: 'Propose brief', exact: true }).click();
  await page.getByRole('button', { name: 'Approve proposed brief', exact: true }).click();
  await expect(page.locator('#brief-view')).toContainText('Approved version 1');
  await expect(page.locator('#brief-error')).toHaveText('');
  const folder = path.join(root, 'vault', 'Companion', 'Briefs'), preserved = path.join(root, 'preserved-briefs');
  const file = (await fs.readdir(folder)).find(name => name.startsWith('approved-1-'));
  const approvedBytes = await fs.readFile(path.join(folder, file));
  await fs.rename(folder, preserved);
  let restored = false;
  try {
    const obstruction = 'Owned fixture obstruction: preserve the approved directory.';
    await fs.writeFile(folder, obstruction);
    await page.getByRole('button', { name: 'Use this folder', exact: true }).click();
    // The real configured read reaches the ordinary-folder guard.
    await expect(page.locator('#brief-error')).toHaveText('The Briefs folder changed or is an alias. Files were preserved for inspection.');
    await expect(page.getByRole('button', { name: 'Check brief inputs', exact: true })).toBeEnabled();
    await expect(page.getByRole('button', { name: 'Propose brief', exact: true })).toBeEnabled();
    await expect(page.getByRole('button', { name: 'Approve proposed brief', exact: true })).toBeDisabled();
    expect(await fs.readFile(folder, 'utf8')).toBe(obstruction);
    expect(await fs.readFile(path.join(preserved, file))).toEqual(approvedBytes);
    await fs.unlink(folder); await fs.rename(preserved, folder); restored = true;
    const previousProposal = await page.locator('#brief-proposal').elementHandle();
    try {
      await page.getByRole('button', { name: 'Check brief inputs', exact: true }).click();
      await expect.poll(() => previousProposal.evaluate(node => node.isConnected)).toBe(false);
    } finally { await previousProposal.dispose(); }
    await fs.writeFile(readme, '# MyTune\n\nA recovered rhythm practice coach.\n');
    await page.getByRole('button', { name: 'Propose brief', exact: true }).click();
    await expect(page.getByLabel('Project purpose', { exact: true })).toHaveValue('A recovered rhythm practice coach.');
    await expect(page.getByRole('button', { name: 'Approve proposed brief', exact: true })).toBeEnabled();
    await expect(page.locator('#brief-error')).toHaveText('');
    expect(await fs.readFile(path.join(folder, file))).toEqual(approvedBytes);
    expect((await fs.readdir(folder)).filter(name => name.startsWith('approved-'))).toHaveLength(1);
  } finally {
    if (!restored) { await fs.rm(folder, { force: true }); await fs.rename(preserved, folder); }
  }
});

test('selected README produces a locally inspectable proposal and explicit immutable approval across restart', async () => {
  await launch();
  await page.getByRole('button', { name: 'Choose vault' }).click();
  await page.getByRole('button', { name: 'Use this folder' }).click();
  await expect(page.getByRole('status')).toContainText('Vault ready.');
  await page.getByRole('button', { name: 'Select MyTune README' }).click();
  await page.getByRole('button', { name: 'Propose brief' }).click();
  await expect(page.getByLabel('Project purpose', { exact: true })).toHaveValue(/A guitar practice tutor/);
  await expect(page.getByLabel('Known limitations', { exact: true })).toHaveValue(/Gap:/);
  await expect(page.locator('#brief-view')).toContainText('README.md:L3-L3');
  await expect(page.locator('#brief-view')).toContainText('No approved brief');
  await page.getByRole('button', { name: 'Approve proposed brief' }).click();
  await expect(page.locator('#brief-view')).toContainText('Approved version 1');
  const dir = path.join(root, 'vault', 'Companion', 'Briefs');
  const files = await fs.readdir(dir); const approved = files.find(file => file.startsWith('approved-'));
  const content = await fs.readFile(path.join(dir, approved), 'utf8');
  expect(content).toContain('A guitar practice tutor.'); expect(content).toContain('sha256');
  await app.close(); app = null; await launch();
  await expect(page.locator('#brief-view')).toContainText('Approved version 1');
  expect(await fs.readFile(path.join(dir, approved), 'utf8')).toBe(content);
});

test('source changes and failed refresh preserve approved pins, and explicit added documents need a new approval', async () => {
  await launch();
  await page.getByRole('button', { name: 'Choose vault' }).click();
  await page.getByRole('button', { name: 'Use this folder' }).click();
  await expect(page.getByRole('status')).toContainText('Vault ready.');
  await page.getByRole('button', { name: 'Select MyTune README' }).click();
  await page.getByRole('button', { name: 'Propose brief' }).click();
  await page.getByRole('button', { name: 'Approve proposed brief' }).click();
  await expect(page.locator('#brief-view')).toContainText('Approved version 1');
  const pinned = await page.evaluate(() => window.companion['brief-pin'](1));
  await fs.writeFile(readme, '# MyTune\n\nA changed guitar tutor.\n');
  await page.getByRole('button', { name: 'Check brief inputs' }).click();
  await expect(page.locator('#brief-view')).toContainText('Outdated approved brief');
  await page.getByRole('button', { name: 'Approve proposed brief' }).click();
  await expect(page.locator('#brief-error')).toContainText('Refresh approval blocked');
  await fs.unlink(readme);
  await page.getByRole('button', { name: 'Propose brief' }).click();
  await expect(page.locator('#brief-error')).toContainText('ENOENT');
  await app.close(); app = null; await launch();
  await expect(page.locator('#brief-view')).toContainText('Refresh failed');
  const afterFailure = await page.evaluate(() => window.companion['brief-pin'](1));
  expect(afterFailure.sources).toEqual(pinned.sources); expect(afterFailure.sections).toEqual(pinned.sections);
  expect(afterFailure.issues.join(' ')).toContain('Missing');
  await fs.writeFile(readme, '# MyTune\n\nA changed guitar tutor.\n');
  const extra = path.join(root, 'limits.md'), unselected = path.join(root, 'private.md');
  await fs.writeFile(extra, '# Known limitations\n\nTeacher review pending.\n');
  await fs.writeFile(unselected, 'PRIVATE DOCUMENT MUST NOT BE READ');
  await fs.writeFile(path.join(root, 'brief-selection.json'), JSON.stringify([extra]));
  await page.getByRole('button', { name: 'Add selected documents' }).click();
  await page.getByRole('button', { name: 'Propose brief' }).click();
  await expect(page.getByLabel('Known limitations', { exact: true })).toHaveValue('Teacher review pending.');
  await expect(page.locator('#brief-view')).toContainText('Approved version 1');
  await page.getByRole('button', { name: 'Approve proposed brief' }).click();
  await expect(page.locator('#brief-view')).toContainText('Approved version 2');
  const next = await page.evaluate(() => window.companion['brief-pin'](2));
  expect(next.sources.map(s => path.basename(s.path))).toEqual(['README.md', 'limits.md']);
  expect(JSON.stringify(next)).not.toContain('PRIVATE DOCUMENT');
  expect((await page.evaluate(() => window.companion['brief-pin'](1))).sections).toEqual(pinned.sections);
});

test('reviewed passage references navigate retained snapshots, approvals are idempotent and damaged versions cannot be pinned', async () => {
  await launch();
  await page.getByRole('button', { name: 'Choose vault' }).click();
  await page.getByRole('button', { name: 'Use this folder' }).click();
  await expect(page.getByRole('status')).toContainText('Vault ready.');
  await page.getByRole('button', { name: 'Select MyTune README' }).click();
  await page.getByRole('button', { name: 'Propose brief' }).click();
  await page.getByLabel('Questions worth exploring', { exact: true }).fill('Can the tutor support another practice pattern? (Question, not an established outcome.)');
  await page.getByLabel('Questions worth exploring references', { exact: true }).fill('1:3-3');
  const approve = page.getByRole('button', { name: 'Approve proposed brief' });
  await approve.click();
  await expect(page.locator('#brief-view')).toContainText('Approved version 1');
  await approve.click();
  await expect(approve).toBeEnabled();
  await expect(page.locator('#brief-error')).toBeEmpty();
  const repeated = await page.evaluate(() => window.companion['brief-state']());
  expect(repeated.approved.map(record => record.version)).toEqual([1]);
  await page.locator('#brief-proposal').getByRole('link', { name: 'README.md:L3-L3', exact: true }).first().click();
  await expect(page.locator('#brief-proposal').getByText('1 | # MyTune', { exact: false })).toBeVisible();
  const approved = await page.evaluate(() => window.companion['brief-pin'](1));
  expect(approved.sections[4].references).toEqual([{ source: 0, start: 3, end: 3 }]);
  const dir = path.join(root, 'vault', 'Companion', 'Briefs'), file = path.join(dir, approved.file);
  const original = await fs.readFile(file, 'utf8');
  expect(original).toContain('](#source-1)');
  await fs.writeFile(file, original.replace('A guitar practice tutor.', 'A silently altered tutor.'));
  const pinError = await page.evaluate(() => window.companion['brief-pin'](1).then(() => '', error => error.message));
  expect(pinError).toContain('integrity');
  expect(await fs.readFile(file, 'utf8')).toContain('A silently altered tutor.');
});

test('oversized source refresh is explicit, never shortened, and preserves the approved version across restart', async () => {
  await launch();
  await page.getByRole('button', { name: 'Choose vault' }).click();
  await page.getByRole('button', { name: 'Use this folder' }).click();
  await expect(page.getByRole('status')).toContainText('Vault ready.');
  await page.getByRole('button', { name: 'Select MyTune README' }).click();
  await page.getByRole('button', { name: 'Propose brief' }).click();
  await page.getByRole('button', { name: 'Approve proposed brief' }).click();
  await expect(page.locator('#brief-view')).toContainText('Approved version 1');
  const original = await page.evaluate(() => window.companion['brief-pin'](1));
  await fs.writeFile(readme, '# MyTune\n\n' + 'a'.repeat(32001));
  await page.getByRole('button', { name: 'Propose brief' }).click();
  await expect(page.locator('#brief-error')).toContainText('Nothing was shortened');
  await page.getByRole('button', { name: 'Check brief inputs' }).click();
  await expect(page.locator('#brief-view')).toContainText('Refresh failed');
  await expect(page.getByLabel('Project purpose', { exact: true })).toHaveValue('A guitar practice tutor.');
  await app.close(); app = null; await launch();
  await expect(page.locator('#brief-view')).toContainText('outdated');
  const preserved = await page.evaluate(() => window.companion['brief-pin'](1));
  expect(preserved.digest).toBe(original.digest); expect(preserved.sources).toEqual(original.sources);
  expect((await fs.readdir(path.join(root, 'vault', 'Companion', 'Briefs'))).filter(name => name.startsWith('approved-'))).toHaveLength(1);
});

test('a redirected Briefs folder cannot publish into unrelated files', async () => {
  await launch();
  await page.getByRole('button', { name: 'Choose vault' }).click();
  await page.getByRole('button', { name: 'Use this folder' }).click();
  await expect(page.getByRole('status')).toContainText('Vault ready.');
  const outside = path.join(root, 'unrelated'), briefDir = path.join(root, 'vault', 'Companion', 'Briefs');
  await fs.mkdir(outside); await fs.writeFile(path.join(outside, 'keep.md'), 'Unrelated writing.');
  await fs.rmdir(briefDir); await fs.symlink(outside, briefDir, 'junction');
  await page.getByRole('button', { name: 'Select MyTune README' }).click();
  await page.getByRole('button', { name: 'Propose brief' }).click();
  await expect(page.locator('#brief-error')).toContainText('outside the selected vault');
  expect(await fs.readdir(outside)).toEqual(['keep.md']);
  expect(await fs.readFile(path.join(outside, 'keep.md'), 'utf8')).toBe('Unrelated writing.');
});

test('two desktop instances cannot publish the same approved version and busy approval preserves edits for retry', async () => {
  await launch();
  await page.getByRole('button', { name: 'Choose vault' }).click();
  await page.getByRole('button', { name: 'Use this folder' }).click();
  await expect(page.getByRole('status')).toContainText('Vault ready.');
  await page.getByRole('button', { name: 'Select MyTune README' }).click();
  await page.getByRole('button', { name: 'Propose brief' }).click();
  await expect(page.getByLabel('Project purpose', { exact: true })).toHaveValue('A guitar practice tutor.');
  const secondApp = await electron.launch({ args: ['.'], env: { ...process.env, COMPANION_TEST_ROOT: root } });
  try {
    const second = await secondApp.firstWindow();
    await expect(second.getByLabel('Project purpose', { exact: true })).toHaveValue('A guitar practice tutor.');
    const firstProposal = await second.evaluate(() => window.companion['brief-state']().then(state => state.proposed.id));
    await second.getByRole('button', { name: 'Propose brief' }).click();
    await expect.poll(() => second.evaluate(() => window.companion['brief-state']().then(state => state.proposed.id))).not.toBe(firstProposal);
    const secondProposal = await second.evaluate(() => window.companion['brief-state']().then(state => state.proposed.id));
    await expect(second.locator('#brief-proposal')).toContainText(secondProposal);
    await second.getByLabel('Project purpose', { exact: true }).fill('Second explicitly reviewed description.');
    await fs.writeFile(path.join(root, 'faults.json'), JSON.stringify({ pause: 'brief-before-approval-publish' }));
    await page.getByRole('button', { name: 'Approve proposed brief' }).click();
    await expect.poll(() => fs.readFile(path.join(root, 'checkpoint.txt'), 'utf8').catch(() => '')).toBe('brief-before-approval-publish');
    await second.getByRole('button', { name: 'Approve proposed brief' }).click();
    await expect(second.locator('#brief-error')).toContainText('busy');
    await expect(second.getByLabel('Project purpose', { exact: true })).toHaveValue('Second explicitly reviewed description.');
    await fs.writeFile(path.join(root, 'release.txt'), 'release');
    await expect(page.locator('#brief-view')).toContainText('Approved version 1');
    await second.getByRole('button', { name: 'Approve proposed brief' }).click();
    await expect(second.locator('#brief-view')).toContainText('Approved version 2');
    const old = await second.evaluate(() => window.companion['brief-pin'](1));
    const next = await second.evaluate(() => window.companion['brief-pin'](2));
    expect(old.sections[0].text).toBe('A guitar practice tutor.');
    expect(next.sections[0].text).toBe('Second explicitly reviewed description.');
    const files = await fs.readdir(path.join(root, 'vault', 'Companion', 'Briefs'));
    expect(files.filter(name => name.startsWith('approved-1-'))).toHaveLength(1);
    expect(files.filter(name => name.startsWith('approved-2-'))).toHaveLength(1);
  } finally { await fs.writeFile(path.join(root, 'release.txt'), 'release'); await secondApp.close(); }
});

test('a held brief refresh displays the prior approved brief after desktop restart', async () => {
  await launch();
  await page.getByRole('button', { name: 'Choose vault', exact: true }).click();
  await page.getByRole('button', { name: 'Use this folder', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('Vault ready.');
  await page.getByRole('button', { name: 'Select MyTune README', exact: true }).click();
  await page.getByRole('button', { name: 'Propose brief', exact: true }).click();
  await page.getByRole('button', { name: 'Approve proposed brief', exact: true }).click();
  await expect(page.locator('#brief-approved-1')).toBeAttached();
  const original = await page.evaluate(() => window.companion['brief-pin'](1));
  await fs.writeFile(readme, '# MyTune\n\nA rhythm practice coach.\n');
  await page.getByRole('button', { name: 'Propose brief', exact: true }).click();
  await expect(page.getByLabel('Project purpose', { exact: true })).toHaveValue('A rhythm practice coach.');
  await app.evaluate(() => {
    if (!process.env.COMPANION_TEST_ROOT) throw Error('Interrupted approval requires a disposable fixture.');
    const local = process.getBuiltinModule('fs'), path = process.getBuiltinModule('path');
    const folder = path.join(process.env.COMPANION_TEST_ROOT, 'vault', 'Companion', 'Briefs');
    const link = local.linkSync;
    local.linkSync = (source, destination) => {
      link(source, destination);
      if (path.dirname(destination) === folder && path.basename(destination).startsWith('approved-2-')) {
        local.linkSync = link;
        throw Error('Fixture stopped approval immediately after the exclusive link.');
      }
    };
  });
  await page.getByRole('button', { name: 'Approve proposed brief', exact: true }).click();
  await expect(page.locator('#brief-error')).toContainText('Fixture stopped approval');
  await app.close(); app = null;

  const dir = path.join(root, 'vault', 'Companion', 'Briefs');
  const names = await fs.readdir(dir);
  expect(names).toContain('.brief-approval-2.pending.json');
  const destination = path.join(dir, names.find(name => name.startsWith('approved-2-')));
  const stage = path.join(dir, names.find(name => name.startsWith('.brief-stage-')));
  const originalStage = await fs.readFile(stage);
  expect(await fs.readFile(destination)).toEqual(originalStage);
  await fs.unlink(destination);
  const replacement = Buffer.from('Independent writing at the interrupted approval path.\n');
  await fs.writeFile(destination, replacement, { flag: 'wx' });

  await launch();
  await expect(page.locator('#brief-view')).toContainText(/Refresh failed:.*(?:held|integrity|changed)/i);
  await page.getByText('Approved version 1 | pin 1', { exact: true }).click();
  await expect(page.locator('#brief-approved-1')).toContainText('A guitar practice tutor.');
  await expect(page.locator('#brief-approved-2')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Approve proposed brief', exact: true })).toBeDisabled();
  expect(await page.evaluate(() => window.companion['brief-pin'](1))).toMatchObject({ id: original.id, digest: original.digest });
  expect(await fs.readFile(destination)).toEqual(replacement);
  expect(await fs.readFile(stage)).toEqual(originalStage);
});

test('an exact approved historical pin survives unrelated damaged records without substituting another version', async () => {
  await launch();
  await page.getByRole('button', { name: 'Choose vault' }).click();
  await page.getByRole('button', { name: 'Use this folder' }).click();
  await expect(page.getByRole('status')).toContainText('Vault ready.');
  await page.getByRole('button', { name: 'Select MyTune README' }).click();
  await page.getByRole('button', { name: 'Propose brief' }).click();
  await page.getByRole('button', { name: 'Approve proposed brief' }).click();
  await expect(page.locator('#brief-view')).toContainText('Approved version 1');
  const original = await page.evaluate(() => window.companion['brief-pin'](1));
  const initial = await page.evaluate(() => window.companion['brief-state']().then(state => state.proposed.id));
  await page.getByRole('button', { name: 'Propose brief' }).click();
  await expect.poll(() => page.evaluate(() => window.companion['brief-state']().then(state => state.proposed.id))).not.toBe(initial);
  const state = await page.evaluate(() => window.companion['brief-state']());
  await expect(page.locator('#brief-proposal')).toContainText(state.proposed.id);
  await page.getByRole('button', { name: 'Approve proposed brief' }).click();
  await expect(page.locator('#brief-view')).toContainText('Approved version 2');
  const newer = await page.evaluate(() => window.companion['brief-pin'](2));
  const dir = path.join(root, 'vault', 'Companion', 'Briefs');
  await fs.writeFile(path.join(dir, state.proposed.file), 'Damaged unrelated draft.');
  await fs.writeFile(path.join(dir, newer.file), '---\nartifact_type: project_brief\nrecord: [\n---\n');
  await app.close(); app = null; await launch();
  const historical = await page.evaluate(() => window.companion['brief-pin'](1));
  expect(historical.digest).toBe(original.digest);
  expect(historical.sources).toEqual(original.sources); expect(historical.sections).toEqual(original.sections);
  const damaged = await page.evaluate(() => window.companion['brief-pin'](2).then(() => '', error => error.message));
  expect(damaged).toContain('integrity');
  const missing = await page.evaluate(() => window.companion['brief-pin'](3).then(() => '', error => error.message));
  expect(missing).toContain('unavailable');
  await fs.writeFile(path.join(dir, 'approved-1-unexpected.md'), 'Ambiguous requested version.');
  const ambiguous = await page.evaluate(() => window.companion['brief-pin'](1).then(() => '', error => error.message));
  expect(ambiguous).toMatch(/integrity|Duplicate/);
});
