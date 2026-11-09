const { test, expect, _electron: electron } = require('@playwright/test');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
let root, app, page;
test.beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'companion-conversation-'));
  await fs.writeFile(path.join(root, 'clock.json'), JSON.stringify({ now: '2026-11-08T12:00:00Z', timezone: 'America/Phoenix' }));
});
test.afterEach(async () => { if (app) await app.close(); app = null; await fs.rm(root, { recursive: true, force: true }); });
async function launch(configure = true) {
  app = await electron.launch({ args: ['.'], env: { ...process.env, COMPANION_TEST_ROOT: root } }); page = await app.firstWindow();
  if (configure) {
    await page.getByRole('button', { name: 'Choose vault', exact: true }).click();
    await page.getByRole('button', { name: 'Use this folder', exact: true }).click();
    await expect(page.getByRole('status')).toContainText('Vault ready.');
  }
}
test('explicit reviewed synthetic turn persists the exact package and resumes without replay or automatic idea notes', async () => {
  await fs.writeFile(path.join(root, 'conversation-provider.json'), JSON.stringify({ reply: 'Authored synthetic response. Hypothesis: spaced retrieval could help practice. Mechanism: revisit a chord. Application: MyTune practice queue. Limitations: transfer is unverified. Test: compare next-day recall.' }));
  await launch();
  await page.getByLabel('Thought or link', { exact: true }).fill('Spaced retrieval revisits a learned chord.');
  await page.getByRole('button', { name: 'Save capture', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('Capture saved.');
  const readme = path.join(root, 'README.md'); await fs.writeFile(readme, '# MyTune\n\nA guitar practice tutor.\n');
  await fs.writeFile(path.join(root, 'brief-selection.json'), JSON.stringify([readme]));
  await page.getByRole('button', { name: 'Select MyTune README', exact: true }).click();
  await page.getByRole('button', { name: 'Propose brief', exact: true }).click();
  await page.getByRole('button', { name: 'Approve proposed brief', exact: true }).click();
  await expect(page.locator('#brief-view')).toContainText('Approved version 1');
  await page.getByLabel('Context question', { exact: true }).fill('How could retrieval help MyTune?');
  await page.getByRole('button', { name: 'Find context', exact: true }).click();
  await page.locator('#context-results article').filter({ hasText: 'Spaced retrieval' }).first().getByRole('button', { name: 'Add to context', exact: true }).click();
  await page.getByLabel('Conversation brief version', { exact: true }).fill('1');
  await page.getByRole('button', { name: 'Preview conversation', exact: true }).click();
  await expect(page.getByLabel('Reviewed conversation package', { exact: true })).toHaveValue(/How could retrieval help MyTune\?/);
  await expect(page.getByRole('button', { name: 'Send reviewed package', exact: true })).toBeEnabled();
  const reviewed = await page.getByLabel('Reviewed conversation package', { exact: true }).inputValue();
  expect(reviewed).toContain('How could retrieval help MyTune?');
  expect(reviewed).toContain('Approved brief version 1');
  await page.getByRole('button', { name: 'Send reviewed package', exact: true }).click();
  await expect(page.locator('#conversation-history')).toContainText('completed');
  await expect(page.locator('#conversation-history')).toContainText('Authored synthetic response.');
  const files = await fs.readdir(path.join(root, 'conversations'));
  const saved = JSON.parse(await fs.readFile(path.join(root, 'conversations', files.find(file => file.endsWith('.json'))), 'utf8'));
  expect(saved.requests).toHaveLength(1); expect(saved.requests[0].package.text).toBe(reviewed);
  expect(saved.requests[0].status).toBe('completed'); expect(saved.brief.version).toBe(1);
  const calls = await fs.readFile(path.join(root, 'conversation-submissions.jsonl'), 'utf8');
  expect(JSON.parse(calls.trim()).text).toBe(reviewed);
  expect(await fs.readdir(path.join(root, 'vault', 'Companion', 'Ideas'))).toEqual([]);
  await app.close(); app = null; await launch(false);
  await expect(page.locator('#conversation-history')).toContainText('Authored synthetic response.');
  expect(await fs.readFile(path.join(root, 'conversation-submissions.jsonl'), 'utf8')).toBe(calls);
});

async function prepareConversation() {
  await launch();
  await page.getByLabel('Thought or link', { exact: true }).fill('Spaced retrieval revisits a learned chord.');
  await page.getByRole('button', { name: 'Save capture', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('Capture saved.');
  const readme = path.join(root, 'README.md'); await fs.writeFile(readme, '# MyTune\n\nA guitar practice tutor.\n');
  await fs.writeFile(path.join(root, 'brief-selection.json'), JSON.stringify([readme]));
  await page.getByRole('button', { name: 'Select MyTune README', exact: true }).click();
  await page.getByRole('button', { name: 'Propose brief', exact: true }).click();
  await page.getByRole('button', { name: 'Approve proposed brief', exact: true }).click();
  await expect(page.locator('#brief-view')).toContainText('Approved version 1');
  await page.getByLabel('Context question', { exact: true }).fill('How could retrieval help MyTune?');
  await selectCapture();
  await page.getByRole('button', { name: 'Preview conversation', exact: true }).click();
  await expect(page.getByLabel('Reviewed conversation package', { exact: true })).toHaveValue(/How could retrieval help MyTune\?/);
}
async function selectCapture() {
  await page.getByRole('button', { name: 'Find context', exact: true }).click();
  await page.locator('#context-results article').filter({ hasText: 'Spaced retrieval' }).first().getByRole('button', { name: 'Add to context', exact: true }).click();
}
test('streamed incomplete replies survive restart and explicit retry uses a fresh App Server thread and request', async () => {
  // First measured complete setup/send/restart was 17.1s; this case adds another explicit turn.
  test.setTimeout(60000);
  await fs.writeFile(path.join(root, 'conversation-provider.json'), JSON.stringify({ turn: 'pending', reply: 'Authored synthetic partial reply 🎸' }));
  await prepareConversation();
  await page.getByRole('button', { name: 'Send reviewed package', exact: true }).click();
  await expect(page.locator('#conversation-history')).toContainText('inProgress');
  await expect(page.locator('#conversation-history')).toContainText('Authored synthetic partial reply 🎸');
  const calls = await fs.readFile(path.join(root, 'conversation-submissions.jsonl'), 'utf8');
  await app.close(); app = null; await launch(false);
  await expect(page.locator('#conversation-history')).toContainText('interrupted');
  await expect(page.locator('#conversation-history')).toContainText('incomplete');
  await expect(page.locator('#conversation-history')).toContainText('Authored synthetic partial reply 🎸');
  expect(await fs.readFile(path.join(root, 'conversation-submissions.jsonl'), 'utf8')).toBe(calls);
  await fs.writeFile(path.join(root, 'conversation-provider.json'), JSON.stringify({ reply: 'Authored synthetic retried response.' }));
  await page.getByRole('button', { name: 'Retry or edit request', exact: true }).click();
  await expect(page.getByLabel('Context question', { exact: true })).toHaveValue('How could retrieval help MyTune?');
  await selectCapture();
  await page.getByRole('button', { name: 'Preview conversation', exact: true }).click();
  await expect(page.getByLabel('Reviewed conversation package', { exact: true })).toHaveValue(/How could retrieval help MyTune\?/);
  await expect(page.locator('#conversation-summary')).toContainText('Excluded incomplete historical request');
  await page.getByRole('button', { name: 'Send reviewed package', exact: true }).click();
  await expect(page.locator('#conversation-history')).toContainText('Authored synthetic retried response.');
  const files = await fs.readdir(path.join(root, 'conversations'));
  const saved = JSON.parse(await fs.readFile(path.join(root, 'conversations', files.find(file => file.endsWith('.json'))), 'utf8'));
  expect(saved.requests.map(request => request.status)).toEqual(['interrupted', 'completed']);
  expect(saved.requests[0].id).not.toBe(saved.requests[1].id);
  expect(saved.requests[0].threadId).not.toBe(saved.requests[1].threadId);
  const rpc = (await fs.readFile(path.join(root, 'codex-requests.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
  expect(rpc.filter(call => call.method === 'thread/start')).toHaveLength(2);
  expect(rpc.filter(call => call.method === 'thread/start').every(call => call.params.ephemeral === true)).toBe(true);
  expect(rpc.filter(call => /login|fixture\/login/.test(call.method))).toEqual([]);
});

test('removing original evidence excludes directly and transitively derived replies from the next fresh turn while warning local history', async () => {
  test.setTimeout(60000);
  await fs.writeFile(path.join(root, 'conversation-provider.json'), JSON.stringify({ reply: 'Authored synthetic FIRST_DERIVED_CANARY grounded in the source.' }));
  await prepareConversation();
  await page.getByRole('button', { name: 'Send reviewed package', exact: true }).click();
  await expect(page.locator('#conversation-history')).toContainText('FIRST_DERIVED_CANARY');
  // Resume with no current source selections. The next reply depends on included history.
  await app.close(); app = null; await launch(false);
  await expect(page.locator('#conversation-history')).toContainText('FIRST_DERIVED_CANARY');
  await page.getByLabel('Context question', { exact: true }).fill('What are the limitations of that hypothesis?');
  await page.getByRole('button', { name: 'Preview conversation', exact: true }).click();
  await expect(page.getByLabel('Reviewed conversation package', { exact: true })).toHaveValue(/FIRST_DERIVED_CANARY/);
  await fs.writeFile(path.join(root, 'conversation-provider.json'), JSON.stringify({ reply: 'Authored synthetic SECOND_DERIVED_CANARY based on the previous reply.' }));
  await page.getByRole('button', { name: 'Send reviewed package', exact: true }).click();
  await expect(page.locator('#conversation-history')).toContainText('SECOND_DERIVED_CANARY');
  // Explicitly remove the evidence after inspecting it again.
  await page.getByLabel('Context question', { exact: true }).fill('retrieval'); await selectCapture();
  await page.locator('#context-selected').getByRole('button', { name: 'Remove from context', exact: true }).click();
  await page.getByLabel('Context question', { exact: true }).fill('What can we support from project context alone?');
  await page.getByRole('button', { name: 'Preview conversation', exact: true }).click();
  await expect(page.getByLabel('Reviewed conversation package', { exact: true })).toHaveValue(/What can we support/);
  await expect(page.getByLabel('Reviewed conversation package', { exact: true })).not.toHaveValue(/FIRST_DERIVED_CANARY|SECOND_DERIVED_CANARY|Spaced retrieval/);
  await expect(page.locator('#conversation-summary')).toContainText('Excluded historical request');
  await expect(page.locator('#conversation-history')).toContainText('Excluded from next request');
  await fs.writeFile(path.join(root, 'conversation-provider.json'), JSON.stringify({ reply: 'Authored synthetic No Supported Connection: the available project context does not establish a shared source mechanism.' }));
  await page.getByRole('button', { name: 'Send reviewed package', exact: true }).click();
  await expect(page.locator('#conversation-history')).toContainText('No Supported Connection');
  await expect(page.locator('#conversation-history')).toContainText('FIRST_DERIVED_CANARY');
  const submissions = (await fs.readFile(path.join(root, 'conversation-submissions.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
  expect(submissions).toHaveLength(3);
  expect(submissions[1].text).toContain('FIRST_DERIVED_CANARY');
  expect(submissions[2].text).not.toMatch(/FIRST_DERIVED_CANARY|SECOND_DERIVED_CANARY|Spaced retrieval/);
  expect(new Set(submissions.map(item => item.threadId)).size).toBe(3);
  const files = await fs.readdir(path.join(root, 'conversations'));
  const saved = JSON.parse(await fs.readFile(path.join(root, 'conversations', files.find(file => file.endsWith('.json'))), 'utf8'));
  expect(saved.requests[1].package.dependencies.some(item => item.key.startsWith('capture:'))).toBe(true);
  expect(saved.requests[2].package.dependencies.some(item => item.key.startsWith('capture:'))).toBe(false);
});
