const { test, expect, _electron: electron } = require('@playwright/test');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
let root, app, page;
test.beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'companion-comparison-'));
  await fs.writeFile(path.join(root, 'clock.json'), JSON.stringify({ now: '2026-11-09T12:00:00Z', timezone: 'America/Phoenix' }), 'utf8');
});
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
  }
}
async function approveBrief() {
  const readme = path.join(root, 'README.md');
  await fs.writeFile(readme, '# MyTune\nA guitar practice tutor.\n\n## Current behavior\nLearners revisit previously learned chord changes and log clean plays manually.\n\n## Constraints\nFive-minute practice sessions; no audio recognition or social ranking.\n\n## Known limitations\nNo controlled evidence of retention gains.\n\n## Questions\nWhich small practice change deserves a test?\n', 'utf8');
  await fs.writeFile(path.join(root, 'brief-selection.json'), JSON.stringify([readme]), 'utf8');
  await page.getByRole('button', { name: 'Select MyTune README', exact: true }).click();
  await page.getByRole('button', { name: 'Propose brief', exact: true }).click();
  await page.getByRole('button', { name: 'Approve proposed brief', exact: true }).click();
  await expect(page.locator('#brief-view')).toContainText('Approved version 1');
}
async function savedComparison() {
  const names = await fs.readdir(path.join(root, 'comparisons'));
  return JSON.parse(await fs.readFile(path.join(root, 'comparisons', names.find(name => name.endsWith('.json'))), 'utf8'));
}
test('authored comparison keeps three inspectable cases and six pending slots across restart without generation', async () => {
  await launch(); await approveBrief();
  await page.getByLabel('Comparison brief version', { exact: true }).fill('1');
  await page.getByRole('button', { name: 'Create comparison', exact: true }).click();
  await expect(page.locator('#comparison-cases article')).toHaveCount(3);
  await expect(page.locator('#comparison-cases')).toContainText('Synthetic');
  await expect(page.locator('#comparison-cases')).toContainText('plausible');
  await expect(page.locator('#comparison-cases')).toContainText('weak');
  await expect(page.locator('#comparison-cases')).toContainText('misleading');
  await expect(page.locator('#comparison-cases')).toContainText('Limitations:');
  await expect(page.locator('#comparison-slots article')).toHaveCount(6);
  const before = await savedComparison();
  expect(before.slots.map(slot => slot.status)).toEqual(Array(6).fill('pending'));
  expect(before.brief.version).toBe(1);
  expect(before.brief.snapshot.sources[0].text).toContain('Five-minute practice sessions');
  expect(new Set(before.slots.map(slot => slot.method))).toEqual(new Set(['direct', 'analogy']));
  expect(before.fixtures.map(fixture => fixture.fit)).toEqual(['plausible', 'weak', 'misleading']);
  expect(before.fixtures.every(fixture => fixture.synthetic && fixture.version === 1 && fixture.passages.length && fixture.limitations)).toBe(true);
  for (const slot of before.slots) {
    expect(slot.package.text).toContain('final answer up to 600 words');
    expect(slot.package.text).toContain('Five-minute practice sessions');
  }
  await app.close(); app = null; await launch(false);
  await expect(page.locator('#comparison-slots article')).toHaveCount(6);
  expect(await savedComparison()).toEqual(before);
  expect(await fs.readFile(path.join(root, 'conversation-submissions.jsonl'), 'utf8').catch(error => error.code)).toBe('ENOENT');
});

test('one reviewed comparison slot retains the authoritative final candidate and never replays on restart', async () => {
  test.setTimeout(60000);
  await fs.writeFile(path.join(root, 'conversation-evidence.json'), JSON.stringify({
    dispatchEnabled: true,
    capacity: { maxCodePoints: 32000, model: 'fixture', evidence: 'authored fixture input bound, not live proof', harnessAndOutputEvidence: 'authored fixture harness and output allowance, not live proof' },
    comparisonSettings: { modelProvider: 'fixture-provider', reasoningEffort: 'medium', serviceTier: 'default', evidence: 'authored fixture settings, not live proof' }
  }), 'utf8');
  await fs.writeFile(path.join(root, 'conversation-provider.json'), JSON.stringify({
    model: 'fixture', modelProvider: 'fixture-provider', reasoningEffort: 'medium', serviceTier: 'default',
    messages: [
      { phase: 'commentary', text: 'Authored commentary is retained separately.' },
      { phase: 'final_answer', text: 'Authored final candidate: no supported connection is established. See supplied source limitations and approved project constraints. A synthetic answer is not an executed experiment.' }
    ]
  }), 'utf8');
  await launch(); await approveBrief();
  await page.getByRole('button', { name: 'Create comparison', exact: true }).click();
  await expect(page.locator('#comparison-slots article')).toHaveCount(6);
  await page.getByRole('button', { name: 'Preview Output 1', exact: true }).click();
  await expect(page.getByLabel('Reviewed comparison package', { exact: true })).toHaveValue(/final answer up to 600 words/);
  await expect(page.getByRole('button', { name: 'Send reviewed comparison slot', exact: true })).toBeEnabled();
  const reviewed = await page.getByLabel('Reviewed comparison package', { exact: true }).inputValue();
  expect(reviewed).toContain('final answer up to 600 words');
  await page.getByRole('button', { name: 'Send reviewed comparison slot', exact: true }).click();
  await expect(page.locator('#comparison-slots article').first()).toContainText('completed');
  await expect(page.locator('#comparison-slots article').first()).toContainText('Authored final candidate:');
  const saved = await savedComparison();
  const completed = saved.slots.filter(slot => slot.status === 'completed');
  expect(completed).toHaveLength(1);
  const slot = completed[0];
  expect(slot.package.text).toBe(reviewed);
  expect(slot.reply).toContain('Authored commentary is retained separately.');
  expect(slot.messages.map(message => message.phase)).toEqual(['commentary', 'final_answer']);
  expect(slot.candidate.text).toBe('Authored final candidate: no supported connection is established. See supplied source limitations and approved project constraints. A synthetic answer is not an executed experiment.');
  expect(slot.candidate.warning).toBeNull();
  expect(slot.requested).toEqual({ model: 'fixture', modelProvider: 'fixture-provider', reasoningEffort: 'medium', serviceTier: 'default' });
  expect(slot.effective).toEqual(slot.requested);
  expect(slot.evidence).toBe('controlled-fixture-not-live');
  expect(slot.usage).toBeNull(); expect(slot.usageEvidence).toContain('unavailable');
  expect(Number.isFinite(slot.elapsedMs) && slot.elapsedMs >= 0).toBe(true);
  expect(slot.elapsedBoundary).toContain('preflight');
  expect(saved.slots.filter(slot => slot.status === 'pending')).toHaveLength(5);
  const calls = await fs.readFile(path.join(root, 'conversation-submissions.jsonl'), 'utf8');
  expect(calls.trim().split('\n').map(line => JSON.parse(line).text)).toEqual([reviewed]);
  const requests = (await fs.readFile(path.join(root, 'codex-requests.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  const threadStart = requests.find(request => request.method === 'thread/start').params;
  expect(threadStart.model).toBe('fixture'); expect(threadStart.modelProvider).toBe('fixture-provider');
  expect(threadStart.serviceTier).toBe('default'); expect(threadStart.config.model_reasoning_effort).toBe('medium');
  await app.close(); app = null; await launch(false);
  await expect(page.locator('#comparison-slots article').first()).toContainText('Authored final candidate:');
  await expect(page.getByRole('button', { name: 'Preview Output 1', exact: true })).toBeDisabled();
  expect(await fs.readFile(path.join(root, 'conversation-submissions.jsonl'), 'utf8')).toBe(calls);
});

test('returned comparison settings mismatch consumes the failed slot before turn start without replay', async () => {
  test.setTimeout(60000);
  await fs.writeFile(path.join(root, 'conversation-evidence.json'), JSON.stringify({
    dispatchEnabled: true,
    capacity: { maxCodePoints: 32000, model: 'fixture', evidence: 'authored fixture input bound', harnessAndOutputEvidence: 'authored fixture harness and output allowance' },
    comparisonSettings: { modelProvider: 'fixture-provider', reasoningEffort: 'medium', serviceTier: 'default', evidence: 'authored fixture settings, not live proof' }
  }), 'utf8');
  // This external server control returns schema-valid observed metadata that
  // disagrees with the reviewed settings. It is not a wire protocol extension.
  await fs.writeFile(path.join(root, 'conversation-provider.json'), JSON.stringify({
    model: 'fixture', modelProvider: 'fixture-provider', reasoningEffort: 'low', serviceTier: 'default',
    messages: [{ phase: 'final_answer', text: 'THIS_SYNTHETIC_REPLY_MUST_NEVER_BE_GENERATED' }]
  }), 'utf8');
  await launch(); await approveBrief();
  await page.getByRole('button', { name: 'Create comparison', exact: true }).click();
  await expect(page.locator('#comparison-slots article')).toHaveCount(6);
  await page.getByRole('button', { name: 'Preview Output 1', exact: true }).click();
  await expect(page.getByLabel('Reviewed comparison package', { exact: true })).toHaveValue(/final answer up to 600 words/);
  await expect(page.getByRole('button', { name: 'Send reviewed comparison slot', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: 'Send reviewed comparison slot', exact: true }).click();
  await expect(page.locator('#comparison-slots article').first()).toContainText('failed');
  await expect(page.locator('#comparison-slots article').first()).toContainText('settings changed or are unavailable');
  await expect(page.getByRole('button', { name: 'Preview Output 1', exact: true })).toBeDisabled();
  const saved = await savedComparison(), failed = saved.slots.filter(slot => slot.status === 'failed');
  expect(failed).toHaveLength(1);
  expect(failed[0].requested.reasoningEffort).toBe('medium');
  expect(failed[0].effective.reasoningEffort).toBe('low');
  expect(failed[0].reply).toBe('');
  expect(failed[0].candidate.warning).toContain('unavailable or ambiguous');
  expect(saved.slots.filter(slot => slot.status === 'pending')).toHaveLength(5);
  const requests = await fs.readFile(path.join(root, 'codex-requests.jsonl'), 'utf8');
  expect(requests.trim().split('\n').map(line => JSON.parse(line)).filter(request => request.method === 'thread/start')).toHaveLength(1);
  expect(requests.trim().split('\n').map(line => JSON.parse(line)).filter(request => request.method === 'turn/start')).toHaveLength(0);
  expect(await fs.readFile(path.join(root, 'conversation-submissions.jsonl'), 'utf8').catch(error => error.code)).toBe('ENOENT');
  await app.close(); app = null; await launch(false);
  await expect(page.locator('#comparison-slots article').first()).toContainText('failed');
  await expect(page.getByRole('button', { name: 'Preview Output 1', exact: true })).toBeDisabled();
  expect(await fs.readFile(path.join(root, 'codex-requests.jsonl'), 'utf8')).toBe(requests);
});

test('changed comparison proof during thread preflight blocks turn start while capture stays usable', async () => {
  test.setTimeout(60000);
  const proof = {
    dispatchEnabled: true,
    capacity: { maxCodePoints: 32000, model: 'fixture', evidence: 'authored fixture input bound', harnessAndOutputEvidence: 'authored fixture harness and output allowance' },
    comparisonSettings: { modelProvider: 'fixture-provider', reasoningEffort: 'medium', serviceTier: 'default', evidence: 'authored fixture settings version 1, not live proof' }
  };
  await fs.writeFile(path.join(root, 'conversation-evidence.json'), JSON.stringify(proof), 'utf8');
  await fs.writeFile(path.join(root, 'conversation-provider.json'), JSON.stringify({ model: 'fixture', modelProvider: 'fixture-provider', reasoningEffort: 'medium', serviceTier: 'default', messages: [{ phase: 'final_answer', text: 'NO_OUTPUT_SHOULD_BE_GENERATED_AFTER_PROOF_CHANGE' }] }), 'utf8');
  await fs.writeFile(path.join(root, 'faults.json'), JSON.stringify({ pause: 'comparison-before-turn-start' }), 'utf8');
  await launch(); await approveBrief();
  await page.getByRole('button', { name: 'Create comparison', exact: true }).click();
  await expect(page.locator('#comparison-slots article')).toHaveCount(6);
  await page.getByRole('button', { name: 'Preview Output 1', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Send reviewed comparison slot', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: 'Send reviewed comparison slot', exact: true }).click();
  await expect.poll(() => fs.readFile(path.join(root, 'checkpoint.txt'), 'utf8').catch(() => '')).toBe('comparison-before-turn-start');
  proof.comparisonSettings.evidence = 'authored fixture settings version 2, not live proof';
  await fs.writeFile(path.join(root, 'conversation-evidence.json'), JSON.stringify(proof), 'utf8');
  await fs.writeFile(path.join(root, 'release.txt'), 'release', 'utf8');
  await expect(page.locator('#comparison-slots article').first()).toContainText('failed');
  await expect(page.locator('#comparison-slots article').first()).toContainText(/changed/);
  const requests = (await fs.readFile(path.join(root, 'codex-requests.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  expect(requests.filter(request => request.method === 'thread/start')).toHaveLength(1);
  expect(requests.filter(request => request.method === 'turn/start')).toHaveLength(0);
  expect(await fs.readFile(path.join(root, 'conversation-submissions.jsonl'), 'utf8').catch(error => error.code)).toBe('ENOENT');
  const saved = await savedComparison();
  expect(saved.generationPin.settings.evidence).toContain('version 1');
  expect(saved.slots.filter(slot => slot.status === 'failed')).toHaveLength(1);
  expect(saved.slots.filter(slot => slot.status === 'pending')).toHaveLength(5);
  await page.getByLabel('Thought or link', { exact: true }).fill('Capture survives a rejected changed comparison proof.');
  await page.getByRole('button', { name: 'Save capture', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('Capture saved.');
});

test('changed pinned brief input before comparison dispatch starts no provider thread or turn', async () => {
  test.setTimeout(60000);
  await fs.writeFile(path.join(root, 'conversation-evidence.json'), JSON.stringify({
    dispatchEnabled: true,
    capacity: { maxCodePoints: 32000, model: 'fixture', evidence: 'authored fixture input bound', harnessAndOutputEvidence: 'authored fixture harness and output allowance' },
    comparisonSettings: { modelProvider: 'fixture-provider', reasoningEffort: 'medium', serviceTier: 'default', evidence: 'authored fixture settings, not live proof' }
  }), 'utf8');
  await fs.writeFile(path.join(root, 'conversation-provider.json'), JSON.stringify({ model: 'fixture', modelProvider: 'fixture-provider', reasoningEffort: 'medium', serviceTier: 'default', messages: [{ phase: 'final_answer', text: 'NO_OUTPUT_AFTER_BRIEF_INPUT_CHANGE' }] }), 'utf8');
  await fs.writeFile(path.join(root, 'faults.json'), JSON.stringify({ pause: 'comparison-before-dispatch' }), 'utf8');
  await launch(); await approveBrief();
  await page.getByRole('button', { name: 'Create comparison', exact: true }).click();
  await expect(page.locator('#comparison-slots article')).toHaveCount(6);
  await page.getByRole('button', { name: 'Preview Output 1', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Send reviewed comparison slot', exact: true })).toBeEnabled();
  const pinned = await savedComparison();
  await page.getByRole('button', { name: 'Send reviewed comparison slot', exact: true }).click();
  await expect.poll(() => fs.readFile(path.join(root, 'checkpoint.txt'), 'utf8').catch(() => '')).toBe('comparison-before-dispatch');
  await fs.appendFile(path.join(root, 'README.md'), '\nA newly supplied constraint requires a fresh brief review.\n', 'utf8');
  await fs.writeFile(path.join(root, 'release.txt'), 'release', 'utf8');
  await expect(page.locator('#comparison-slots article').first()).toContainText('failed');
  await expect(page.locator('#comparison-slots article').first()).toContainText('Pinned approved brief or its selected inputs changed');
  const requests = (await fs.readFile(path.join(root, 'codex-requests.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  expect(requests.filter(request => request.method === 'thread/start')).toHaveLength(0);
  expect(requests.filter(request => request.method === 'turn/start')).toHaveLength(0);
  expect(await fs.readFile(path.join(root, 'conversation-submissions.jsonl'), 'utf8').catch(error => error.code)).toBe('ENOENT');
  const saved = await savedComparison();
  expect(saved.brief).toEqual(pinned.brief);
  expect(saved.slots.filter(slot => slot.status === 'failed')).toHaveLength(1);
  await page.getByLabel('Thought or link', { exact: true }).fill('Capture survives stale comparison brief inputs.');
  await page.getByRole('button', { name: 'Save capture', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('Capture saved.');
});

for (const alias of ['directory junction', 'history hardlink']) test(`comparison ${alias} rejects outside history while capture remains usable`, async () => {
  test.setTimeout(60000);
  const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'companion-outside-comparison-'));
  const directory = path.join(root, 'comparisons'), outsideDirectory = path.join(outside, 'records');
  let linkedDirectory = false;
  try {
    await fs.writeFile(path.join(root, 'conversation-evidence.json'), JSON.stringify({
      dispatchEnabled: true,
      capacity: { maxCodePoints: 32000, model: 'fixture', evidence: 'authored fixture input bound', harnessAndOutputEvidence: 'authored fixture harness and output allowance' },
      comparisonSettings: { modelProvider: 'fixture-provider', reasoningEffort: 'medium', serviceTier: 'default', evidence: 'authored fixture settings, not live proof' }
    }), 'utf8');
    await fs.writeFile(path.join(root, 'conversation-provider.json'), JSON.stringify({ model: 'fixture', modelProvider: 'fixture-provider', reasoningEffort: 'medium', serviceTier: 'default', messages: [{ phase: 'final_answer', text: 'PRIVATE_OUTSIDE_COMPARISON_CANARY. Authored synthetic response.' }] }), 'utf8');
    await launch(); await approveBrief();
    await page.getByRole('button', { name: 'Create comparison', exact: true }).click();
    await expect(page.locator('#comparison-slots article')).toHaveCount(6);
    await page.getByRole('button', { name: 'Preview Output 1', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Send reviewed comparison slot', exact: true })).toBeEnabled();
    await page.getByRole('button', { name: 'Send reviewed comparison slot', exact: true }).click();
    await expect(page.locator('#comparison-slots article').first()).toContainText('completed');
    const record = await savedComparison(), file = path.join(directory, `${record.id}.json`);
    const submissions = await fs.readFile(path.join(root, 'conversation-submissions.jsonl'), 'utf8');
    await app.close(); app = null;
    if (alias === 'directory junction') {
      await fs.rename(directory, outsideDirectory);
      await fs.symlink(outsideDirectory, directory, process.platform === 'win32' ? 'junction' : 'dir'); linkedDirectory = true;
    } else {
      await fs.mkdir(outsideDirectory);
      const outsideFile = path.join(outsideDirectory, `${record.id}.json`);
      await fs.rename(file, outsideFile); await fs.link(outsideFile, file);
      expect((await fs.stat(file)).nlink).toBe(2);
    }
    const snapshot = async () => Object.fromEntries(await Promise.all((await fs.readdir(outsideDirectory)).sort().map(async name => [name, await fs.readFile(path.join(outsideDirectory, name), 'utf8')])));
    const before = await snapshot();
    await launch(false);
    await expect(page.locator('#comparison-error')).toContainText(/ordinary|contained|history/i);
    await expect(page.locator('#comparison-section')).not.toContainText('PRIVATE_OUTSIDE_COMPARISON_CANARY');
    await expect(page.getByLabel('Retained comparison', { exact: true }).locator('option')).toHaveCount(1);
    if (alias === 'directory junction') {
      await page.getByRole('button', { name: 'Create comparison', exact: true }).click();
      await expect(page.locator('#comparison-error')).toContainText(/ordinary|contained/i);
    }
    await page.getByLabel('Thought or link', { exact: true }).fill(`Capture works with rejected comparison ${alias}.`);
    await page.getByRole('button', { name: 'Save capture', exact: true }).click();
    await expect(page.getByRole('status')).toContainText('Capture saved.');
    expect(await snapshot()).toEqual(before);
    expect(await fs.readFile(path.join(root, 'conversation-submissions.jsonl'), 'utf8')).toBe(submissions);
  } finally {
    if (app) { await app.close(); app = null; }
    if (linkedDirectory) await fs.unlink(directory);
    await fs.rm(outside, { recursive: true, force: true });
  }
});

test('abrupt Electron main exit retains an interrupted comparison and never reuses process proof or replays', async () => {
  test.setTimeout(60000);
  await fs.writeFile(path.join(root, 'conversation-evidence.json'), JSON.stringify({
    dispatchEnabled: true,
    capacity: { maxCodePoints: 32000, model: 'fixture', evidence: 'authored fixture input bound', harnessAndOutputEvidence: 'authored fixture harness and output allowance' },
    comparisonSettings: { modelProvider: 'fixture-provider', reasoningEffort: 'medium', serviceTier: 'default', evidence: 'authored fixture settings, not live proof' }
  }), 'utf8');
  await fs.writeFile(path.join(root, 'conversation-provider.json'), JSON.stringify({ model: 'fixture', modelProvider: 'fixture-provider', reasoningEffort: 'medium', serviceTier: 'default', turn: 'pending', messages: [{ phase: 'partial_answer', text: 'DURABLE_INTERRUPTED_COMPARISON_TEXT. Authored partial response, not a completed result.' }] }), 'utf8');
  await launch(); await approveBrief();
  await page.getByRole('button', { name: 'Create comparison', exact: true }).click();
  await expect(page.locator('#comparison-slots article')).toHaveCount(6);
  await page.getByRole('button', { name: 'Preview Output 1', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Send reviewed comparison slot', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: 'Send reviewed comparison slot', exact: true }).click();
  await expect.poll(async () => (await savedComparison()).slots.some(slot => slot.status === 'inProgress' && slot.reply.includes('DURABLE_INTERRUPTED_COMPARISON_TEXT'))).toBe(true);
  const submissions = await fs.readFile(path.join(root, 'conversation-submissions.jsonl'), 'utf8');
  const child = app.process(), mainPid = await app.evaluate(() => process.pid);
  const evidence = { wrapperPid: child.pid, mainPid, exitBoundary: 'Electron app.exit(77)' };
  const exited = new Promise(resolve => child.once('exit', (code, signal) => resolve({ code, signal })));
  const abrupt = app.evaluate(({ app: electronApp }) => electronApp.exit(77)).catch(error => { if (!/closed|disposed/i.test(error.message)) throw error; });
  evidence.wrapperExit = await exited; await abrupt;
  await expect.poll(() => { try { process.kill(mainPid, 0); return 'alive'; } catch (error) { if (error.code === 'ESRCH') return 'exited'; throw error; } }).toBe('exited');
  await fs.writeFile(test.info().outputPath('comparison-crash-processes.json'), JSON.stringify(evidence, null, 2), 'utf8');
  app = null; await launch(false);
  await expect(page.locator('#comparison-slots article').first()).toContainText('interrupted');
  await expect(page.locator('#comparison-slots article').first()).toContainText('DURABLE_INTERRUPTED_COMPARISON_TEXT');
  await expect(page.locator('#comparison-slots article').first()).toContainText('Elapsed: unavailable');
  await expect(page.getByRole('button', { name: 'Preview Output 1', exact: true })).toBeDisabled();
  const saved = await savedComparison(), interrupted = saved.slots.find(slot => slot.status === 'interrupted');
  expect(interrupted.elapsedMs).toBeNull();
  expect(interrupted.candidate.warning).toContain('unavailable or ambiguous');
  expect(interrupted.messages[0].completed).toBe(false);
  expect(saved.slots.filter(slot => slot.status === 'pending')).toHaveLength(5);
  await page.getByRole('button', { name: 'Preview Output 2', exact: true }).click();
  await expect(page.locator('#comparison-error')).toContainText('Evidence changed or the process restarted');
  expect(await fs.readFile(path.join(root, 'conversation-submissions.jsonl'), 'utf8')).toBe(submissions);
  const requests = (await fs.readFile(path.join(root, 'codex-requests.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  expect(requests.filter(request => request.method === 'turn/start')).toHaveLength(1);
});

test('an active comparison poll cannot authorize overwriting an external history edit', async () => {
  test.setTimeout(60000);
  await fs.writeFile(path.join(root, 'conversation-evidence.json'), JSON.stringify({
    dispatchEnabled: true,
    capacity: { maxCodePoints: 32000, model: 'fixture', evidence: 'authored fixture input bound', harnessAndOutputEvidence: 'authored fixture harness and output allowance' },
    comparisonSettings: { modelProvider: 'fixture-provider', reasoningEffort: 'medium', serviceTier: 'default', evidence: 'authored fixture settings, not live proof' }
  }), 'utf8');
  await fs.writeFile(path.join(root, 'conversation-provider.json'), JSON.stringify({
    model: 'fixture', modelProvider: 'fixture-provider', reasoningEffort: 'medium', serviceTier: 'default', holdCompletion: true,
    messages: [{ phase: 'final_answer', text: 'FULL_AUTHORED_REPLY_RETAINED_AFTER_EXTERNAL_EDIT. Synthetic output only.' }]
  }), 'utf8');
  await launch(); await approveBrief();
  await page.getByRole('button', { name: 'Create comparison', exact: true }).click();
  await expect(page.locator('#comparison-slots article')).toHaveCount(6);
  await page.getByRole('button', { name: 'Preview Output 1', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Send reviewed comparison slot', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: 'Send reviewed comparison slot', exact: true }).click();
  await expect.poll(async () => (await savedComparison()).slots.some(slot => slot.status === 'inProgress' && slot.reply.includes('FULL_AUTHORED_REPLY_RETAINED_AFTER_EXTERNAL_EDIT'))).toBe(true);
  const external = await savedComparison(); external.externalMarker = 'EXTERNAL_EDIT_MUST_REMAIN_BYTE_FOR_BYTE';
  const file = path.join(root, 'comparisons', `${external.id}.json`), externalBytes = JSON.stringify(external, null, 2);
  await fs.writeFile(file, externalBytes, 'utf8');
  // This public read models an in-flight list refresh observing the other
  // writer. It must never change the active mutation's publication baseline.
  await page.evaluate(() => window.companion['comparison-list']());
  await fs.writeFile(path.join(root, 'conversation-release.json'), '{}', 'utf8');
  await expect(page.locator('#comparison-slots article').first()).toContainText(/completed|interrupted|failed/);
  expect(await fs.readFile(file, 'utf8')).toBe(externalBytes);
  await expect(page.locator('#comparison-notice')).toContainText('unsaved');
  await expect(page.locator('#comparison-slots article').first()).toContainText('FULL_AUTHORED_REPLY_RETAINED_AFTER_EXTERNAL_EDIT');
  const submissions = await fs.readFile(path.join(root, 'conversation-submissions.jsonl'), 'utf8');
  expect(submissions.trim().split('\n')).toHaveLength(1);
  await page.reload();
  await expect(page.locator('#comparison-notice')).toContainText('unsaved');
  await expect(page.locator('#comparison-slots article').first()).toContainText('FULL_AUTHORED_REPLY_RETAINED_AFTER_EXTERNAL_EDIT');
  expect(await fs.readFile(file, 'utf8')).toBe(externalBytes);
  expect(await fs.readFile(path.join(root, 'conversation-submissions.jsonl'), 'utf8')).toBe(submissions);
});

test('a missing comparison file keeps unsaved output visible until exact local storage recovery without generation', async () => {
  test.setTimeout(60000);
  await fs.writeFile(path.join(root, 'conversation-evidence.json'), JSON.stringify({
    dispatchEnabled: true,
    capacity: { maxCodePoints: 32000, model: 'fixture', evidence: 'authored fixture input bound', harnessAndOutputEvidence: 'authored fixture harness and output allowance' },
    comparisonSettings: { modelProvider: 'fixture-provider', reasoningEffort: 'medium', serviceTier: 'default', evidence: 'authored fixture settings, not live proof' }
  }), 'utf8');
  await fs.writeFile(path.join(root, 'conversation-provider.json'), JSON.stringify({
    model: 'fixture', modelProvider: 'fixture-provider', reasoningEffort: 'medium', serviceTier: 'default', holdCompletion: true,
    messages: [{ phase: 'final_answer', text: 'MISSING_FILE_RETAINED_ACTUAL_SYNTHETIC_OUTPUT. Keep this full text without another turn.' }]
  }), 'utf8');
  await launch(); await approveBrief();
  await page.getByRole('button', { name: 'Create comparison', exact: true }).click();
  await expect(page.locator('#comparison-slots article')).toHaveCount(6);
  await page.getByRole('button', { name: 'Preview Output 1', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Send reviewed comparison slot', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: 'Send reviewed comparison slot', exact: true }).click();
  await expect.poll(async () => (await savedComparison()).slots.some(slot => slot.status === 'inProgress' && slot.reply.includes('MISSING_FILE_RETAINED_ACTUAL_SYNTHETIC_OUTPUT'))).toBe(true);
  const durable = await savedComparison(), file = path.join(root, 'comparisons', `${durable.id}.json`), retainedFile = path.join(root, 'last-durable-comparison.json');
  await fs.rename(file, retainedFile);
  await fs.writeFile(path.join(root, 'conversation-release.json'), '{}', 'utf8');
  await expect(page.locator('#comparison-notice')).toContainText('unsaved');
  await expect(page.locator('#comparison-slots article').first()).toContainText('MISSING_FILE_RETAINED_ACTUAL_SYNTHETIC_OUTPUT');
  const submissions = await fs.readFile(path.join(root, 'conversation-submissions.jsonl'), 'utf8');
  await page.reload();
  await expect(page.locator('#comparison-notice')).toContainText('unsaved');
  await expect(page.locator('#comparison-slots article')).toHaveCount(6);
  await expect(page.locator('#comparison-slots article').first()).toContainText('MISSING_FILE_RETAINED_ACTUAL_SYNTHETIC_OUTPUT');
  expect(await fs.access(file).then(() => 'exists', error => error.code)).toBe('ENOENT');
  await page.getByRole('button', { name: 'Save retained comparison locally', exact: true }).click();
  await expect(page.locator('#comparison-error')).toContainText(/changed|unavailable/);
  expect(await fs.access(file).then(() => 'exists', error => error.code)).toBe('ENOENT');
  // Restore the exact last durable file identity/content, then explicitly save
  // the retained bytes. Neither repair step permits another model request.
  await fs.rename(retainedFile, file);
  await page.getByRole('button', { name: 'Save retained comparison locally', exact: true }).click();
  await expect(page.locator('#comparison-notice')).not.toContainText('unsaved');
  await expect(page.locator('#comparison-slots article').first()).toContainText('MISSING_FILE_RETAINED_ACTUAL_SYNTHETIC_OUTPUT');
  const recovered = await savedComparison();
  expect(recovered).not.toHaveProperty('storageWarning');
  expect(recovered.slots.filter(slot => slot.status === 'interrupted')).toHaveLength(1);
  expect(recovered.slots.filter(slot => slot.status === 'pending')).toHaveLength(5);
  expect(recovered.slots.find(slot => slot.status === 'interrupted').reply).toContain('MISSING_FILE_RETAINED_ACTUAL_SYNTHETIC_OUTPUT');
  await app.close(); app = null; await launch(false);
  await expect(page.locator('#comparison-slots article').first()).toContainText('MISSING_FILE_RETAINED_ACTUAL_SYNTHETIC_OUTPUT');
  expect(await fs.readFile(path.join(root, 'conversation-submissions.jsonl'), 'utf8')).toBe(submissions);
});

test('independent blind aliases retain six validated ratings and reveal methods only after feedback', async () => {
  test.setTimeout(180000);
  await fs.writeFile(path.join(root, 'conversation-evidence.json'), JSON.stringify({
    dispatchEnabled: true,
    capacity: { maxCodePoints: 32000, model: 'fixture', evidence: 'authored fixture input bound', harnessAndOutputEvidence: 'authored fixture harness and output allowance' },
    comparisonSettings: { modelProvider: 'fixture-provider', reasoningEffort: 'medium', serviceTier: 'default', evidence: 'authored fixture settings, not live proof' }
  }), 'utf8');
  await launch(); await approveBrief();
  await page.getByRole('button', { name: 'Create comparison', exact: true }).click();
  await expect(page.locator('#comparison-slots article')).toHaveCount(6);
  const initial = await savedComparison();
  const counters = { totalTokens: 37, inputTokens: 20, cachedInputTokens: 2, cacheWriteInputTokens: 0, outputTokens: 17, reasoningOutputTokens: 4 };
  for (let index = 1; index <= 6; index++) {
    const text = index === 2 ? 'Authored synthetic long answer. ' + 'retained '.repeat(610) : `Authored synthetic candidate ${index}. The supplied passage and approved brief do not establish a learning benefit; limitations apply. This is a controlled output, not an executed experiment.`;
    await fs.writeFile(path.join(root, 'conversation-provider.json'), JSON.stringify({
      model: 'fixture', modelProvider: 'fixture-provider', reasoningEffort: 'medium', serviceTier: 'default',
      turn: index === 6 ? 'usage-limit' : 'completed',
      messages: [{ phase: index === 3 ? null : 'final_answer', text }],
      ...(index === 1 ? { usageUpdates: [{ tokenUsage: { total: counters, last: counters, modelContextWindow: null } }] } : {})
    }), 'utf8');
    await page.getByRole('button', { name: `Preview Output ${index}`, exact: true }).click();
    await expect(page.getByLabel('Reviewed comparison package', { exact: true })).toHaveValue(/final answer up to 600 words/);
    await expect(page.getByRole('button', { name: 'Send reviewed comparison slot', exact: true })).toBeEnabled();
    await page.getByRole('button', { name: 'Send reviewed comparison slot', exact: true }).click();
    await expect(page.locator('#comparison-slots article').nth(index - 1)).toContainText(index === 6 ? 'failed' : 'completed');
  }
  const generated = await savedComparison();
  expect(generated.slots).toHaveLength(6);
  expect(generated.slots.filter(slot => slot.status === 'completed')).toHaveLength(5);
  expect(generated.slots.filter(slot => slot.status === 'failed')).toHaveLength(1);
  expect(generated.displayOrder).toEqual(initial.displayOrder);
  for (const fixture of generated.fixtures) {
    const pair = generated.slots.filter(slot => slot.fixtureId === fixture.id);
    expect(pair).toHaveLength(2);
    expect(pair[0].package.sharedInputDigest).toBe(pair[1].package.sharedInputDigest);
    expect(pair[0].requested).toEqual(pair[1].requested);
    const direct = pair.find(slot => slot.method === 'direct'), analogy = pair.find(slot => slot.method === 'analogy');
    expect(direct.package.text).not.toContain('Explicitly map');
    expect(analogy.package.text).toContain('Explicitly map the source mechanism');
    expect(direct.prompt.version).toBe(1); expect(analogy.prompt.version).toBe(1);
  }
  const byDisplay = generated.displayOrder.map(id => generated.slots.find(slot => slot.id === id));
  expect(byDisplay[0].usage.last).toEqual(counters);
  expect(byDisplay[1].candidate.overRequestedLimit).toBe(true);
  expect(byDisplay[1].candidate.text).toContain('retained '.repeat(610));
  expect(byDisplay[2].candidate.warning).toContain('unavailable or ambiguous');
  expect(byDisplay[5].error).toContain('usage limit');
  const submissions = await fs.readFile(path.join(root, 'conversation-submissions.jsonl'), 'utf8');
  expect(submissions.trim().split('\n')).toHaveLength(6);
  await page.getByRole('button', { name: 'Start blind scoring', exact: true }).click();
  await expect(page.locator('#comparison-score article')).toHaveCount(6);
  await expect(page.locator('#comparison-score')).not.toContainText('analogy');
  await expect(page.locator('#comparison-score')).not.toContainText('sharedInputDigest');
  await expect(page.locator('#comparison-rubric')).toContainText('No concrete project decision is helped');
  await expect(page.locator('#comparison-rubric')).toContainText('Claims and transfer follow');
  const blindLabels = await page.locator('#comparison-score article h4').allTextContents();
  expect(blindLabels).toHaveLength(6);
  expect(blindLabels.every(label => /^Sample [a-f0-9]{8}$/.test(label))).toBe(true);
  const firstLabel = blindLabels[0];
  const shownCandidate = await page.locator('#comparison-score article').first().locator('pre').innerText();
  expect(shownCandidate).not.toBe('');
  await expect(page.locator('#comparison-cases')).toBeHidden();
  await expect(page.locator('#comparison-slots')).toBeHidden();
  await expect(page.getByLabel('Reviewed comparison package', { exact: true })).toBeHidden();
  const blind = await page.evaluate(id => window.companion['comparison-score-view']({ id }), generated.id);
  const blindJson = JSON.stringify(blind);
  for (const slot of generated.slots) expect(blindJson).not.toContain(slot.id);
  expect(blindJson).not.toContain('Output 1');
  for (const output of blind.outputs) {
    for (const field of ['slotId', 'method', 'package', 'prompt', 'requested', 'effective', 'usage', 'elapsedMs', 'capacity', 'generationPin']) expect(output).not.toHaveProperty(field);
  }
  await page.getByLabel(firstLabel + ' Usefulness', { exact: true }).fill('3');
  await page.getByLabel(firstLabel + ' Surprise', { exact: true }).fill('5');
  await page.getByLabel(firstLabel + ' Grounding', { exact: true }).fill('1');
  await page.getByLabel(firstLabel + ' Ease of testing', { exact: true }).fill('2');
  await page.getByLabel(firstLabel + ' Rating reason', { exact: true }).fill('High surprise does not excuse an unsupported claim. This authored score is a UI fixture.');
  await page.getByLabel(firstLabel + ' Material error', { exact: true }).check();
  await page.getByRole('button', { name: 'Save feedback ' + firstLabel, exact: true }).click();
  await expect(page.locator('#comparison-score article').first()).toContainText('Feedback saved');
  const scored = await savedComparison();
  expect(scored.slots.find(slot => slot.candidate?.text === shownCandidate).rating).toMatchObject({ usefulness: 3, surprise: 5, grounding: 1, easeOfTesting: 2, reason: 'High surprise does not excuse an unsupported claim. This authored score is a UI fixture.', materialError: true });
  expect(scored.slots.filter(slot => slot.rating)).toHaveLength(1);
  expect(scored.blindOrder.map(entry => entry.label)).toEqual(blindLabels);
  expect(new Set(scored.blindOrder.map(entry => entry.slotId)).size).toBe(6);
  expect(scored.displayOrder).toEqual(initial.displayOrder);
  await page.getByRole('button', { name: 'Save feedback ' + firstLabel, exact: true }).click();
  await expect(page.getByRole('button', { name: 'Save feedback ' + firstLabel, exact: true })).toBeEnabled();
  expect((await savedComparison()).slots.find(slot => slot.candidate?.text === shownCandidate).rating).toEqual(scored.slots.find(slot => slot.candidate?.text === shownCandidate).rating);
  const nextLabel = blindLabels[1];
  await page.getByLabel(nextLabel + ' Usefulness', { exact: true }).fill('6');
  await page.getByLabel(nextLabel + ' Surprise', { exact: true }).fill('3');
  await page.getByLabel(nextLabel + ' Grounding', { exact: true }).fill('3');
  await page.getByLabel(nextLabel + ' Ease of testing', { exact: true }).fill('3');
  await page.getByLabel(nextLabel + ' Rating reason', { exact: true }).fill('An authored validation check.');
  await page.getByRole('button', { name: 'Save feedback ' + nextLabel, exact: true }).click();
  await expect(page.getByRole('button', { name: 'Save feedback ' + nextLabel, exact: true })).toBeEnabled();
  await expect(page.locator('#comparison-error')).toContainText('four separate integer ratings from 1 to 5');
  expect((await savedComparison()).slots.filter(slot => slot.rating)).toHaveLength(1);
  await page.getByLabel(nextLabel + ' Usefulness', { exact: true }).fill('1.5');
  await page.getByRole('button', { name: 'Save feedback ' + nextLabel, exact: true }).click();
  await expect(page.getByRole('button', { name: 'Save feedback ' + nextLabel, exact: true })).toBeEnabled();
  await expect(page.locator('#comparison-error')).toContainText('four separate integer ratings from 1 to 5');
  await page.getByLabel(nextLabel + ' Usefulness', { exact: true }).fill('3');
  await page.getByLabel(nextLabel + ' Rating reason', { exact: true }).fill('');
  await page.getByRole('button', { name: 'Save feedback ' + nextLabel, exact: true }).click();
  await expect(page.getByRole('button', { name: 'Save feedback ' + nextLabel, exact: true })).toBeEnabled();
  await expect(page.locator('#comparison-error')).toContainText('short reason');
  expect((await savedComparison()).slots.filter(slot => slot.rating)).toHaveLength(1);
  await expect(page.getByRole('button', { name: 'Reveal methods and effort', exact: true })).toBeDisabled();
  await app.close(); app = null; await launch(false);
  await page.getByRole('button', { name: 'Start blind scoring', exact: true }).click();
  await expect(page.locator('#comparison-score article')).toHaveCount(6);
  expect(await page.locator('#comparison-score article h4').allTextContents()).toEqual(blindLabels);
  expect(await page.locator('#comparison-score article').first().locator('pre').innerText()).toBe(shownCandidate);
  await expect(page.getByLabel(firstLabel + ' Surprise', { exact: true })).toHaveValue('5');
  await expect(page.getByLabel(firstLabel + ' Material error', { exact: true })).toBeChecked();
  const otherApp = await electron.launch({ args: ['.'], env: { ...process.env, COMPANION_TEST_ROOT: root } });
  try {
    const other = await otherApp.firstWindow();
    await expect(other.locator('#comparison-slots article')).toHaveCount(6);
    await other.getByRole('button', { name: 'Start blind scoring', exact: true }).click();
    await expect(other.locator('#comparison-score article')).toHaveCount(6);
    await other.getByLabel(firstLabel + ' Rating reason', { exact: true }).fill('A later independently confirmed rating reason.');
    await other.getByRole('button', { name: 'Save feedback ' + firstLabel, exact: true }).click();
    await expect(other.locator('#comparison-error')).toHaveText('');
    await expect.poll(async () => (await savedComparison()).slots.find(slot => slot.candidate?.text === shownCandidate).rating.reason).toBe('A later independently confirmed rating reason.');
    await page.getByLabel(firstLabel + ' Rating reason', { exact: true }).fill('This stale confirmation must not replace the later feedback.');
    await page.getByRole('button', { name: 'Save feedback ' + firstLabel, exact: true }).click();
    await expect(page.locator('#comparison-error')).toContainText('Feedback changed in another view');
    expect((await savedComparison()).slots.find(slot => slot.candidate?.text === shownCandidate).rating.reason).toBe('A later independently confirmed rating reason.');
  } finally { await otherApp.close(); }
  for (const label of blindLabels.slice(1)) {
    for (const dimension of ['Usefulness', 'Surprise', 'Grounding', 'Ease of testing']) await page.getByLabel(label + ' ' + dimension, { exact: true }).fill('3');
    await page.getByLabel(label + ' Rating reason', { exact: true }).fill('Authored exploratory judgment; a generation failure is distinct from grounded abstention.');
    await page.getByRole('button', { name: 'Save feedback ' + label, exact: true }).click();
    await expect(page.locator('#comparison-score article').filter({ has: page.getByRole('heading', { name: label, exact: true }) })).toContainText('Feedback saved');
  }
  const fullyScored = await savedComparison();
  expect(fullyScored.slots.filter(slot => slot.rating)).toHaveLength(6);
  await expect(page.getByRole('button', { name: 'Reveal methods and effort', exact: true })).toBeEnabled();
  await expect(page.locator('#comparison-reveal')).toBeEmpty();
  await page.getByRole('button', { name: 'Reveal methods and effort', exact: true }).click();
  await expect(page.locator('#comparison-reveal article')).toHaveCount(6);
  for (const entry of fullyScored.blindOrder) {
    const slot = fullyScored.slots.find(item => item.id === entry.slotId);
    const audit = page.locator('#comparison-reveal article').filter({ has: page.getByRole('heading', { name: entry.label, exact: true }) });
    await expect(audit).toContainText(slot.method);
    await expect(audit).toContainText(slot.package.text);
    await expect(audit).toContainText(slot.reply);
    await expect(audit).toContainText('controlled-fixture-not-live');
    await expect(audit).toContainText(slot.usageEvidence);
  }
  await expect(page.locator('#comparison-reveal')).toContainText('No equal consumption');
  const final = await savedComparison();
  expect(final.revealedAt).toBeTruthy();
  expect(final.slots.find(slot => slot.candidate?.text === shownCandidate).rating.materialError).toBe(true);
  expect(final.slots.find(slot => slot.candidate?.text === shownCandidate).rating.surprise).toBe(5);
  expect(final).not.toHaveProperty('compositeScore');
  expect(await fs.readFile(path.join(root, 'conversation-submissions.jsonl'), 'utf8')).toBe(submissions);
});
