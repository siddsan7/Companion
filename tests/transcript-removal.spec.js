const { test, expect, _electron: electron } = require('@playwright/test');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
let root, app, page;

test.beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'companion-transcript-removal-'));
  await fs.writeFile(path.join(root, 'clock.json'), JSON.stringify({ now: '2026-11-08T12:00:00Z', timezone: 'America/Phoenix' }));
});

async function transcriptProtocolFixture(selectedFailure, selectedRelative = 'Selected protocol transcript.md') {
  await fs.writeFile(path.join(root, 'conversation-provider.json'), JSON.stringify({ reply: 'TRANSCRIPT_PROTOCOL_13: authored historical writing stays in its origin conversation.' }));
  await launch();
  await page.getByLabel('Thought or link', { exact: true }).fill('Transcript protocol recovery preserves this independent source capture.');
  await page.getByRole('button', { name: 'Save capture', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('Capture saved.');
  const readme = path.join(root, 'README.md'); await fs.writeFile(readme, '# MyTune\n\nA guitar practice tutor.\n');
  await fs.writeFile(path.join(root, 'brief-selection.json'), JSON.stringify([readme]));
  await page.getByRole('button', { name: 'Select MyTune README', exact: true }).click();
  await page.getByRole('button', { name: 'Propose brief', exact: true }).click();
  await page.getByRole('button', { name: 'Approve proposed brief', exact: true }).click();
  await expect(page.locator('#brief-view')).toContainText('Approved version 1');
  await page.getByLabel('Context question', { exact: true }).fill('Keep this conversation independent of both exported transcripts.');
  await page.getByRole('button', { name: 'Preview conversation', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Send reviewed package', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: 'Send reviewed package', exact: true }).click();
  await expect(page.locator('#conversation-history')).toContainText('TRANSCRIPT_PROTOCOL_13');
  await expect(page.locator('#conversation-history')).toContainText('completed');
  const vault = path.join(root, 'vault'), directory = path.join(vault, 'Companion', '.transcripts');
  const selected = path.join(vault, selectedRelative), other = path.join(vault, 'Other protocol transcript.md');
  await fs.mkdir(path.dirname(selected), { recursive: true });
  let selectedBytes;
  for (const file of [other, selected]) {
    await fs.writeFile(path.join(root, 'transcript-selection.json'), JSON.stringify({ canceled: false, filePath: file }));
    await page.getByRole('button', { name: 'Preview transcript export', exact: true }).click();
    await expect(page.getByLabel('Proposed transcript Markdown', { exact: true })).toBeVisible();
    if (file === selected) {
      selectedBytes = await page.getByLabel('Proposed transcript Markdown', { exact: true }).inputValue();
      if (selectedFailure) await fs.writeFile(path.join(root, 'faults.json'), JSON.stringify({ fail: selectedFailure }));
    }
    await page.getByRole('button', { name: 'Export reviewed transcript', exact: true }).click();
    await expect(page.locator('#transcript-status')).toContainText(file === selected && selectedFailure ? 'Controlled filesystem boundary failure' : 'Transcript exported');
  }
  if (selectedFailure) await fs.writeFile(path.join(root, 'faults.json'), '{}');
  let intent;
  for (const name of await fs.readdir(directory)) {
    if (!name.endsWith('.intent.json')) continue;
    const record = JSON.parse(await fs.readFile(path.join(directory, name), 'utf8'));
    if (record.destination === selected) intent = record;
  }
  expect(intent).toBeDefined();
  const selectedCopies = [selected, path.join(directory, `${intent.operation}.intent.json`), path.join(directory, `${intent.operation}.published.json`)];
  if (selectedFailure) selectedCopies.push(path.join(directory, `${intent.operation}.md.pending`));
  if (selectedFailure) {
    const outputStat = await fs.stat(selected), stageStat = await fs.stat(path.join(directory, `${intent.operation}.md.pending`));
    expect(outputStat.nlink).toBe(2);
    expect(stageStat.dev).toBe(outputStat.dev); expect(stageStat.ino).toBe(outputStat.ino);
  }
  const backup = path.join(root, 'protocol-external-backup.md'); await fs.copyFile(selected, backup);
  return {
    vault, directory, selected, other, selectedBytes, selectedCopies, backup, intent,
    before: await files(vault), history: await files(path.join(root, 'conversations')),
    calls: await fs.readFile(path.join(root, 'conversation-submissions.jsonl'), 'utf8')
  };
}
async function reviewProtocolRemoval(fixture) {
  await page.getByRole('combobox', { name: 'Retained transcript export', exact: true }).selectOption(fixture.intent.operation);
  await page.getByRole('button', { name: 'Preview transcript removal', exact: true }).click();
  const review = page.getByRole('region', { name: 'Transcript removal review', exact: true });
  await expect(review).toBeVisible();
  for (const file of fixture.selectedCopies) await expect(review).toContainText(file);
  return review;
}
async function expectProtocolIndependence(fixture) {
  expect(await files(path.join(root, 'conversations'))).toEqual(fixture.history);
  expect(await fs.readFile(fixture.backup, 'utf8')).toBe(fixture.selectedBytes);
  expect(await fs.readFile(path.join(root, 'conversation-submissions.jsonl'), 'utf8')).toBe(fixture.calls);
  const current = await files(fixture.vault);
  for (const [file, bytes] of Object.entries(fixture.before)) if (!fixture.selectedCopies.includes(file)) expect(current[file]).toBe(bytes);
}

for (const boundary of ['transcript-remove-after-stage', 'transcript-remove-after-tombstone', 'transcript-remove-after-unlink']) {
  test(`actual main exit at ${boundary} keeps exact transcript removal recoverable only after explicit review`, async ({}, testInfo) => {
    test.setTimeout(150000);
    const fixture = boundary === 'transcript-remove-after-stage'
      ? await transcriptProtocolFixture('transcript-after-receipt', path.join('a', 'Transcript.md'))
      : await transcriptProtocolFixture();
    const review = await reviewProtocolRemoval(fixture);
    await fs.writeFile(path.join(root, 'faults.json'), JSON.stringify({ pause: boundary }));
    await review.getByRole('button', { name: 'Confirm transcript removal', exact: true }).click();
    await expect.poll(() => fs.readFile(path.join(root, 'checkpoint.txt'), 'utf8').catch(error => { if (error.code === 'ENOENT') return ''; throw error; })).toBe(boundary);
    const markerFile = path.join(fixture.directory, `${fixture.intent.id}.removed.json`), stage = `${markerFile}.pending`;
    const markerExists = boundary !== 'transcript-remove-after-stage', stageExists = boundary !== 'transcript-remove-after-unlink';
    expect(await fs.stat(markerFile).then(() => true, error => { if (error.code === 'ENOENT') return false; throw error; })).toBe(markerExists);
    expect(await fs.stat(stage).then(() => true, error => { if (error.code === 'ENOENT') return false; throw error; })).toBe(stageExists);
    const authorityFile = markerExists ? markerFile : stage, markerBytes = await fs.readFile(authorityFile, 'utf8'), marker = JSON.parse(markerBytes);
    expect(marker.id).toBe(fixture.intent.id); expect(marker.exportOperation).toBe(fixture.intent.operation);
    expect(marker.targets.map(target => path.resolve(fixture.vault, target.file)).sort()).toEqual([...fixture.selectedCopies].sort());
    expect((await fs.stat(authorityFile)).nlink).toBe(boundary === 'transcript-remove-after-tombstone' ? 2 : 1);
    const remaining = [];
    for (const file of fixture.selectedCopies) if (await fs.stat(file).then(() => true, error => { if (error.code === 'ENOENT') return false; throw error; })) remaining.push(file);
    expect(remaining).toHaveLength(boundary === 'transcript-remove-after-unlink' ? fixture.selectedCopies.length - 1 : fixture.selectedCopies.length);
    await expectProtocolIndependence(fixture);
    const crashedVault = await files(fixture.vault);

    const child = app.process(), mainPid = await app.evaluate(() => process.pid);
    const proof = { boundary, wrapperPid: child.pid, mainPid, exitBoundary: 'Electron app.exit(77)' };
    const exited = new Promise(resolve => child.once('exit', (code, signal) => resolve({ code, signal })));
    const abrupt = app.evaluate(({ app: electronApp }) => electronApp.exit(77)).catch(error => { if (!/closed|disposed/i.test(error.message)) throw error; });
    proof.wrapperExit = await exited; await abrupt;
    await expect.poll(() => { try { process.kill(mainPid, 0); return 'alive'; } catch (error) { if (error.code === 'ESRCH') return 'exited'; throw error; } }).toBe('exited');
    proof.mainExitObserved = true;
    const proofFile = testInfo.outputPath('transcript-removal-exit-proof.json');
    await fs.mkdir(path.dirname(proofFile), { recursive: true });
    await fs.writeFile(proofFile, JSON.stringify(proof, null, 2));
    app = null; await fs.writeFile(path.join(root, 'faults.json'), '{}');

    await launch(false);
    const pending = page.getByRole('region', { name: 'Pending transcript removals', exact: true });
    await expect(pending).toContainText(fixture.intent.id);
    await expect(pending.getByRole('button', { name: 'Resume transcript removal', exact: true })).toBeEnabled();
    expect(await files(fixture.vault)).toEqual(crashedVault);
    await expectProtocolIndependence(fixture);
    await pending.getByRole('button', { name: 'Resume transcript removal', exact: true }).click();
    const recoveredReview = page.getByRole('region', { name: 'Transcript removal review', exact: true });
    await expect(recoveredReview).toBeVisible();
    for (const file of fixture.selectedCopies) await expect(recoveredReview).toContainText(file);
    expect(await files(fixture.vault)).toEqual(crashedVault);
    if (boundary === 'transcript-remove-after-stage') {
      // Pause at final authority publication on the resumed attempt: no target can be erased first.
      await fs.writeFile(path.join(root, 'faults.json'), JSON.stringify({ pause: 'transcript-remove-after-tombstone' }));
      await recoveredReview.getByRole('button', { name: 'Confirm transcript removal', exact: true }).click();
      await expect.poll(() => fs.readFile(path.join(root, 'checkpoint.txt'), 'utf8')).toBe('transcript-remove-after-tombstone');
      expect(await fs.readFile(markerFile, 'utf8')).toBe(markerBytes);
      expect((await fs.stat(markerFile)).nlink).toBe(2);
      for (const file of fixture.selectedCopies) expect((await fs.readFile(file)).toString('base64')).toBe(fixture.before[file]);
      await fs.writeFile(path.join(root, 'faults.json'), '{}'); await fs.writeFile(path.join(root, 'release.txt'), 'continue');
    } else await recoveredReview.getByRole('button', { name: 'Confirm transcript removal', exact: true }).click();
    await expect(page.locator('#transcript-remove-status')).toContainText('Transcript removed locally');
    expect(await fs.readFile(markerFile, 'utf8')).toBe(markerBytes);
    expect((await fs.stat(markerFile)).nlink).toBe(1);
    expect(await fs.stat(stage).catch(error => error.code)).toBe('ENOENT');
    for (const file of fixture.selectedCopies) expect(await fs.stat(file).catch(error => error.code)).toBe('ENOENT');
    await expectProtocolIndependence(fixture);
    const completedVault = await files(fixture.vault);
    await app.close(); app = null; await launch(false);
    await expect(page.getByRole('region', { name: 'Pending transcript removals', exact: true }).getByRole('button', { name: 'Resume transcript removal', exact: true })).toHaveCount(0);
    expect(await files(fixture.vault)).toEqual(completedVault);
    await expectProtocolIndependence(fixture);
  });
}

for (const authority of ['intact', 'externally removed after observation']) {
  test(`stale normal transcript confirmation cannot recreate a removed identity when its marker is ${authority}`, async ({}, testInfo) => {
    test.setTimeout(150000);
    const fixture = await transcriptProtocolFixture('transcript-after-receipt');
    const staleReview = page.getByLabel('Proposed transcript Markdown', { exact: true });
    await expect(staleReview).toBeVisible(); await expect(staleReview).toHaveValue(fixture.selectedBytes);
    await expect(page.getByRole('button', { name: 'Export reviewed transcript', exact: true })).toBeEnabled();
    const review = await reviewProtocolRemoval(fixture);
    await review.getByRole('button', { name: 'Confirm transcript removal', exact: true }).click();
    await expect(page.locator('#transcript-remove-status')).toContainText('Transcript removed locally');
    const markerFile = path.join(fixture.directory, `${fixture.intent.id}.removed.json`);
    const markerBytes = await fs.readFile(markerFile, 'utf8');
    for (const file of fixture.selectedCopies) expect(await fs.stat(file).catch(error => error.code)).toBe('ENOENT');
    await expect(staleReview).toBeVisible(); await expect(staleReview).toHaveValue(fixture.selectedBytes);
    const directoryBefore = await fs.stat(fixture.directory, { bigint: true });
    if (authority === 'externally removed after observation') await fs.unlink(markerFile);
    const beforeStale = await files(fixture.vault), priorStatus = await page.locator('#transcript-status').textContent();
    await page.getByRole('button', { name: 'Export reviewed transcript', exact: true }).click();
    await expect.poll(() => page.locator('#transcript-status').textContent()).not.toBe(priorStatus);

    // Save actual unexpected publication facts before any refusal or absence assertion.
    const observed = [];
    for (const file of fixture.selectedCopies) {
      try {
        const bytes = await fs.readFile(file);
        observed.push({ file, bytes: bytes.length, sha256: require('node:crypto').createHash('sha256').update(bytes).digest('hex') });
      } catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    const directoryAfter = await fs.stat(fixture.directory, { bigint: true });
    const diagnostic = {
      authority, id: fixture.intent.id, exportOperation: fixture.intent.operation,
      directoryBefore: { dev: String(directoryBefore.dev), ino: String(directoryBefore.ino) },
      directoryAfter: { dev: String(directoryAfter.dev), ino: String(directoryAfter.ino) },
      status: await page.locator('#transcript-status').textContent(), unexpectedReappearances: observed
    };
    const evidence = testInfo.outputPath('transcript-stale-confirmation.json');
    await fs.mkdir(path.dirname(evidence), { recursive: true }); await fs.writeFile(evidence, JSON.stringify(diagnostic, null, 2));
    expect(diagnostic.directoryAfter).toEqual(diagnostic.directoryBefore);
    expect(observed).toEqual([]);
    await expect(page.locator('#transcript-status')).toContainText(/removed|removal/i);
    expect(await files(fixture.vault)).toEqual(beforeStale);
    if (authority === 'intact') expect(await fs.readFile(markerFile, 'utf8')).toBe(markerBytes);
    else expect(await fs.stat(markerFile).catch(error => error.code)).toBe('ENOENT');
    await expectProtocolIndependence(fixture);

    const fresh = path.join(fixture.vault, 'Fresh explicit transcript.md');
    await fs.writeFile(path.join(root, 'transcript-selection.json'), JSON.stringify({ canceled: false, filePath: fresh }));
    await page.getByRole('button', { name: 'Preview transcript export', exact: true }).click();
    await expect(staleReview).toBeVisible();
    const freshBytes = await staleReview.inputValue();
    await page.getByRole('button', { name: 'Export reviewed transcript', exact: true }).click();
    await expect(page.locator('#transcript-status')).toContainText('Transcript exported');
    expect(await fs.readFile(fresh, 'utf8')).toBe(freshBytes);
    const YAML = require('yaml'), metadata = YAML.parse(freshBytes.match(/^---\n([\s\S]*?)\n---\n/)[1]);
    expect(metadata.companion_id).not.toBe(fixture.intent.id);
    for (const file of fixture.selectedCopies) expect(await fs.stat(file).catch(error => error.code)).toBe('ENOENT');
    if (authority === 'intact') expect(await fs.readFile(markerFile, 'utf8')).toBe(markerBytes);
    else expect(await fs.stat(markerFile).catch(error => error.code)).toBe('ENOENT');
    await expectProtocolIndependence(fixture);
  });
}

for (const ownership of ['unknown external hardlink', 'replaced known transcript parent']) {
  test(`selected transcript removal preserves every copy after preview with an ownership change: ${ownership}`, async () => {
    test.setTimeout(120000);
    const fixture = await transcriptProtocolFixture();
    const review = await reviewProtocolRemoval(fixture);
    const marker = path.join(fixture.directory, `${fixture.intent.id}.removed.json`);
    const alias = path.join(root, 'unselected-external-transcript-alias.md');
    const retained = path.join(root, 'retained-original-transcript-store');
    const sentinel = path.join(fixture.directory, 'independent-replacement-writing.txt');
    const relativeFiles = async directory => Object.fromEntries(Object.entries(await files(directory)).map(([file, bytes]) => [path.relative(directory, file), bytes]));
    const originalStore = await relativeFiles(fixture.directory);
    let moved = false, replaced = false;
    try {
      if (ownership === 'unknown external hardlink') {
        await fs.link(fixture.selected, alias);
        expect((await fs.stat(fixture.selected)).nlink).toBe(2);
      } else {
        await fs.rename(fixture.directory, retained); moved = true;
        await fs.mkdir(fixture.directory); replaced = true;
        await fs.writeFile(sentinel, 'Independent replacement-folder writing must remain unchanged.\n');
      }
      const changedVault = await files(fixture.vault);
      await review.getByRole('button', { name: 'Confirm transcript removal', exact: true }).click();
      await expect(page.locator('#transcript-remove-status')).toContainText(ownership === 'unknown external hardlink' ? /linked|nonordinary|identity|scope/i : /folder|identity|ordinary/i);
      expect(await files(fixture.vault)).toEqual(changedVault);
      expect(await fs.stat(marker).catch(error => error.code)).toBe('ENOENT');
      expect(await fs.stat(`${marker}.pending`).catch(error => error.code)).toBe('ENOENT');
      expect(await fs.readFile(fixture.selected, 'utf8')).toBe(fixture.selectedBytes);
      expect(await files(path.join(root, 'conversations'))).toEqual(fixture.history);
      expect(await fs.readFile(fixture.backup, 'utf8')).toBe(fixture.selectedBytes);
      expect(await fs.readFile(path.join(root, 'conversation-submissions.jsonl'), 'utf8')).toBe(fixture.calls);
      for (const [file, bytes] of Object.entries(fixture.before)) {
        if (!file.startsWith(`${fixture.directory}${path.sep}`)) expect((await fs.readFile(file)).toString('base64')).toBe(bytes);
      }
      if (ownership === 'unknown external hardlink') {
        expect(await fs.readFile(alias, 'utf8')).toBe(fixture.selectedBytes);
        expect((await fs.stat(fixture.selected)).nlink).toBe(2);
        expect(await relativeFiles(fixture.directory)).toEqual(originalStore);
      } else {
        expect(await relativeFiles(retained)).toEqual(originalStore);
        expect(await fs.readdir(fixture.directory)).toEqual([path.basename(sentinel)]);
        expect(await fs.readFile(sentinel, 'utf8')).toBe('Independent replacement-folder writing must remain unchanged.\n');
      }
    } finally {
      if (app) { await app.close(); app = null; }
      if (replaced) { await fs.unlink(sentinel); await fs.rmdir(fixture.directory); }
      if (moved) await fs.rename(retained, fixture.directory);
    }
    await expectProtocolIndependence(fixture);
    expect(await files(fixture.vault)).toEqual(fixture.before);
  });
}
test.afterEach(async () => {
  if (app) await app.close(); app = null;
  await fs.rm(root, { recursive: true, force: true });
});
async function launch(configure = true) {
  app = await electron.launch({ args: ['.'], env: { ...process.env, COMPANION_TEST_ROOT: root } });
  page = await app.firstWindow();
  if (configure) {
    await page.getByRole('button', { name: 'Choose vault', exact: true }).click();
    await page.getByRole('button', { name: 'Use this folder', exact: true }).click();
    await expect(page.getByRole('status')).toContainText('Vault ready.');
  } else await expect(page.locator('#timezone')).toContainText('America/Phoenix');
}
async function files(directory) {
  const entries = {};
  for (const item of await fs.readdir(directory, { withFileTypes: true })) {
    const file = path.join(directory, item.name);
    if (item.isDirectory()) Object.assign(entries, await files(file));
    else entries[file] = (await fs.readFile(file)).toString('base64');
  }
  return entries;
}

test('separately selected transcript removal previews every managed copy, cancels exactly, and removes only that export across restart', async () => {
  test.setTimeout(150000);
  await fs.writeFile(path.join(root, 'conversation-provider.json'), JSON.stringify({ reply: 'TRANSCRIPT_REMOVE_13: authored synthetic independent historical writing.' }));
  await launch();
  await page.getByLabel('Thought or link', { exact: true }).fill('Transcript removal retains this source capture.');
  await page.getByRole('button', { name: 'Save capture', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('Capture saved.');
  const readme = path.join(root, 'README.md');
  await fs.writeFile(readme, '# MyTune\n\nA guitar practice tutor.\n');
  await fs.writeFile(path.join(root, 'brief-selection.json'), JSON.stringify([readme]));
  await page.getByRole('button', { name: 'Select MyTune README', exact: true }).click();
  await page.getByRole('button', { name: 'Propose brief', exact: true }).click();
  await page.getByRole('button', { name: 'Approve proposed brief', exact: true }).click();
  await expect(page.locator('#brief-view')).toContainText('Approved version 1');
  await page.getByLabel('Context question', { exact: true }).fill('Retain this discussion separately from any chosen transcript export.');
  await page.getByRole('button', { name: 'Find context', exact: true }).click();
  await page.locator('#context-results article').filter({ hasText: 'Transcript removal retains' }).first().getByRole('button', { name: 'Add to context', exact: true }).click();
  await page.getByRole('button', { name: 'Preview conversation', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Send reviewed package', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: 'Send reviewed package', exact: true }).click();
  await expect(page.locator('#conversation-history')).toContainText('TRANSCRIPT_REMOVE_13');
  await expect(page.locator('#conversation-history')).toContainText('completed');
  const vault = path.join(root, 'vault'), managed = path.join(vault, 'Companion'), directory = path.join(managed, '.transcripts');
  const selected = path.join(vault, 'a', 'Transcript.md'), other = path.join(vault, 'Other transcript.md');
  await fs.mkdir(path.dirname(selected));
  // Keep an app-created stage/output hardlink pair and receipt for the selected export.
  // The controlled filesystem failure is at the approved OS boundary, after publication.
  await fs.writeFile(path.join(root, 'faults.json'), JSON.stringify({ fail: 'transcript-after-receipt' }));
  await fs.writeFile(path.join(root, 'transcript-selection.json'), JSON.stringify({ canceled: false, filePath: selected }));
  await page.getByRole('button', { name: 'Preview transcript export', exact: true }).click();
  await expect(page.getByLabel('Proposed transcript Markdown', { exact: true })).toBeVisible();
  const selectedBytes = await page.getByLabel('Proposed transcript Markdown', { exact: true }).inputValue();
  await page.getByRole('button', { name: 'Export reviewed transcript', exact: true }).click();
  await expect(page.locator('#transcript-status')).toContainText('Controlled filesystem boundary failure');
  expect(await fs.readFile(selected, 'utf8')).toBe(selectedBytes);
  const intentName = (await fs.readdir(directory)).find(name => name.endsWith('.intent.json'));
  const intent = JSON.parse(await fs.readFile(path.join(directory, intentName), 'utf8'));
  const selectedCopies = [selected, path.join(directory, intentName), path.join(directory, `${intent.operation}.md.pending`), path.join(directory, `${intent.operation}.published.json`)];
  expect((await fs.stat(selected)).nlink).toBe(2);
  await fs.writeFile(path.join(root, 'faults.json'), '{}');
  await fs.writeFile(path.join(root, 'transcript-selection.json'), JSON.stringify({ canceled: false, filePath: other }));
  await page.getByRole('button', { name: 'Preview transcript export', exact: true }).click();
  await expect(page.getByLabel('Proposed transcript Markdown', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Export reviewed transcript', exact: true }).click();
  await expect(page.locator('#transcript-status')).toContainText('Transcript exported');
  const backup = path.join(root, 'independent-backup.md'); await fs.copyFile(selected, backup);
  const before = await files(vault), history = await files(path.join(root, 'conversations'));
  const calls = await fs.readFile(path.join(root, 'conversation-submissions.jsonl'), 'utf8');

  await page.getByRole('combobox', { name: 'Retained transcript export', exact: true }).selectOption(intent.operation);
  await page.getByRole('button', { name: 'Preview transcript removal', exact: true }).click();
  const review = page.getByRole('region', { name: 'Transcript removal review', exact: true });
  await expect(review).toBeVisible();
  for (const file of selectedCopies) await expect(review).toContainText(file);
  await expect(review).toContainText(/originating conversation|origin conversation/i);
  await expect(review).toContainText(/external.*cop|independent.*cop|backup/i);
  await expect(review).not.toContainText(other);
  expect(await files(vault)).toEqual(before);
  await review.getByRole('button', { name: 'Cancel transcript removal', exact: true }).click();
  await expect(review).toBeHidden();
  expect(await files(vault)).toEqual(before);
  expect(await files(path.join(root, 'conversations'))).toEqual(history);

  await page.getByRole('button', { name: 'Preview transcript removal', exact: true }).click();
  await expect(review).toBeVisible();
  await review.getByRole('button', { name: 'Confirm transcript removal', exact: true }).click();
  await expect(page.locator('#transcript-remove-status')).toContainText('Transcript removed locally');
  for (const file of selectedCopies) expect(await fs.stat(file).catch(error => error.code)).toBe('ENOENT');
  const after = await files(vault);
  for (const [file, bytes] of Object.entries(before)) if (!selectedCopies.includes(file)) expect(after[file]).toBe(bytes);
  const added = Object.keys(after).filter(file => !Object.hasOwn(before, file));
  expect(added).toHaveLength(1); expect(path.basename(added[0])).toMatch(/\.removed\.json$/);
  const markerBytes = await fs.readFile(added[0], 'utf8'), marker = JSON.parse(markerBytes);
  expect(marker.id).toBe(intent.id); expect(marker.exportOperation).toBe(intent.operation);
  expect(marker.operation).not.toBe(intent.operation);
  expect(markerBytes).not.toContain('TRANSCRIPT_REMOVE_13');
  expect(markerBytes).not.toContain('Retain this discussion');
  expect(await files(path.join(root, 'conversations'))).toEqual(history);
  expect(await fs.readFile(backup, 'utf8')).toBe(selectedBytes);
  expect(await fs.readFile(path.join(root, 'conversation-submissions.jsonl'), 'utf8')).toBe(calls);
  await app.close(); app = null; await launch(false);
  await expect(page.locator('#conversation-history')).toContainText('TRANSCRIPT_REMOVE_13');
  for (const file of selectedCopies) expect(await fs.stat(file).catch(error => error.code)).toBe('ENOENT');
  expect(await files(vault)).toEqual(after);
  expect(await files(path.join(root, 'conversations'))).toEqual(history);
  expect(await fs.readFile(backup, 'utf8')).toBe(selectedBytes);
  expect(await fs.readFile(path.join(root, 'conversation-submissions.jsonl'), 'utf8')).toBe(calls);
});

test('retained transcript intent is separately removable when its completed output is missing without recreating the writing', async () => {
  test.setTimeout(120000);
  await fs.writeFile(path.join(root, 'conversation-provider.json'), JSON.stringify({ reply: 'TRANSCRIPT_INTENT_ONLY_13: preserve origin discussion independently.' }));
  await launch();
  await page.getByLabel('Thought or link', { exact: true }).fill('Intent-only transcript removal keeps this source capture.');
  await page.getByRole('button', { name: 'Save capture', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('Capture saved.');
  const readme = path.join(root, 'README.md'); await fs.writeFile(readme, '# MyTune\n\nA guitar practice tutor.\n');
  await fs.writeFile(path.join(root, 'brief-selection.json'), JSON.stringify([readme]));
  await page.getByRole('button', { name: 'Select MyTune README', exact: true }).click();
  await page.getByRole('button', { name: 'Propose brief', exact: true }).click();
  await page.getByRole('button', { name: 'Approve proposed brief', exact: true }).click();
  await expect(page.locator('#brief-view')).toContainText('Approved version 1');
  await page.getByLabel('Context question', { exact: true }).fill('Keep the conversation after removing its separately chosen retained export.');
  await page.getByRole('button', { name: 'Preview conversation', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Send reviewed package', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: 'Send reviewed package', exact: true }).click();
  await expect(page.locator('#conversation-history')).toContainText('TRANSCRIPT_INTENT_ONLY_13');
  await expect(page.locator('#conversation-history')).toContainText('completed');
  const vault = path.join(root, 'vault'), directory = path.join(vault, 'Companion', '.transcripts');
  const destination = path.join(vault, 'Externally missing transcript.md');
  await fs.writeFile(path.join(root, 'transcript-selection.json'), JSON.stringify({ canceled: false, filePath: destination }));
  await page.getByRole('button', { name: 'Preview transcript export', exact: true }).click();
  await expect(page.getByLabel('Proposed transcript Markdown', { exact: true })).toBeVisible();
  const writing = await page.getByLabel('Proposed transcript Markdown', { exact: true }).inputValue();
  await page.getByRole('button', { name: 'Export reviewed transcript', exact: true }).click();
  await expect(page.locator('#transcript-status')).toContainText('Transcript exported');
  const intentName = (await fs.readdir(directory)).find(name => name.endsWith('.intent.json'));
  const intentFile = path.join(directory, intentName), intent = JSON.parse(await fs.readFile(intentFile, 'utf8'));
  const receiptFile = path.join(directory, `${intent.operation}.published.json`), receiptBytes = await fs.readFile(receiptFile, 'utf8');
  const backup = path.join(root, 'outside-selected-scope.md'); await fs.copyFile(destination, backup);
  // Actual external file removal leaves the app-owned intent as the only retained export writing.
  // Its success receipt remains an immutable historical fact, never a reconstruction instruction.
  await fs.unlink(destination);
  await page.reload(); await expect(page.locator('#timezone')).toContainText('America/Phoenix');
  const before = await files(vault), history = await files(path.join(root, 'conversations'));
  const calls = await fs.readFile(path.join(root, 'conversation-submissions.jsonl'), 'utf8');
  await page.getByRole('combobox', { name: 'Retained transcript export', exact: true }).selectOption(intent.operation);
  await page.getByRole('button', { name: 'Preview transcript removal', exact: true }).click();
  const review = page.getByRole('region', { name: 'Transcript removal review', exact: true });
  await expect(review).toBeVisible();
  await expect(review).toContainText(intentFile); await expect(review).toContainText(receiptFile);
  await expect(review).not.toContainText(destination);
  expect(await fs.readFile(receiptFile, 'utf8')).toBe(receiptBytes);
  expect(await files(vault)).toEqual(before);
  await review.getByRole('button', { name: 'Cancel transcript removal', exact: true }).click();
  expect(await files(vault)).toEqual(before);
  await page.getByRole('button', { name: 'Preview transcript removal', exact: true }).click();
  await expect(review).toBeVisible();
  await review.getByRole('button', { name: 'Confirm transcript removal', exact: true }).click();
  await expect(page.locator('#transcript-remove-status')).toContainText('Transcript removed locally');
  for (const file of [destination, intentFile, receiptFile]) expect(await fs.stat(file).catch(error => error.code)).toBe('ENOENT');
  const after = await files(vault);
  for (const [file, bytes] of Object.entries(before)) if (![intentFile, receiptFile].includes(file)) expect(after[file]).toBe(bytes);
  const added = Object.keys(after).filter(file => !Object.hasOwn(before, file));
  expect(added).toHaveLength(1);
  const marker = JSON.parse(await fs.readFile(added[0], 'utf8'));
  expect(marker.targets.map(target => target.kind).sort()).toEqual(['intent', 'receipt']);
  expect(marker.exportOperation).toBe(intent.operation); expect(marker.id).toBe(intent.id);
  expect(await files(path.join(root, 'conversations'))).toEqual(history);
  expect(await fs.readFile(backup, 'utf8')).toBe(writing);
  expect(await fs.readFile(path.join(root, 'conversation-submissions.jsonl'), 'utf8')).toBe(calls);
  await app.close(); app = null; await launch(false);
  expect(await files(vault)).toEqual(after);
  expect(await files(path.join(root, 'conversations'))).toEqual(history);
  expect(await fs.readFile(backup, 'utf8')).toBe(writing);
  expect(await fs.readFile(path.join(root, 'conversation-submissions.jsonl'), 'utf8')).toBe(calls);
});
