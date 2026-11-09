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
