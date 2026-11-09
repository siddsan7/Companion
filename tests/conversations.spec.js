const { test, expect, _electron: electron } = require('@playwright/test');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
let root, app, page;
let diagnostic, diagnosticWatcher, diagnosticReads = Promise.resolve(), diagnosticFiles = [], diagnosticPriorTimelines = [];
test.beforeEach(async () => {
  diagnostic = false; diagnosticWatcher = null; diagnosticReads = Promise.resolve(); diagnosticFiles = []; diagnosticPriorTimelines = [];
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'companion-conversation-'));
  await fs.writeFile(path.join(root, 'clock.json'), JSON.stringify({ now: '2026-11-08T12:00:00Z', timezone: 'America/Phoenix' }));
});
test.afterEach(async ({}, testInfo) => {
  diagnosticWatcher?.close(); await diagnosticReads;
  if (diagnostic) {
    const destination = testInfo.outputPath('conversation-state'); await fs.mkdir(destination, { recursive: true });
    const manifest = { title: testInfo.title, status: testInfo.status, wrapperPid: app?.process().pid, mainPid: app ? await app.evaluate(() => process.pid).catch(() => null) : null, testRoot: root, files: diagnosticFiles, priorVisibleTimelines: diagnosticPriorTimelines };
    manifest.visible = await page.evaluate(() => ({ timeline: window.__conversationDiagnostic || [], history: document.getElementById('conversation-history')?.textContent, error: document.getElementById('conversation-error')?.textContent, status: document.querySelector('[role="status"]')?.textContent })).catch(error => ({ unavailable: error.message }));
    const copy = async (name, target) => { try { await fs.copyFile(path.join(root, name), path.join(destination, target)); } catch (error) { if (error.code !== 'ENOENT') throw error; } };
    for (const name of ['conversation-provider.json', 'conversation-submissions.jsonl', 'conversation-release.json', 'codex-requests.jsonl', 'conversation-store-failures.jsonl', 'clock.json', 'faults.json', 'checkpoint.txt', 'release.txt']) await copy(name, name);
    await copy(path.join('conversation-transport', 'readiness.json'), 'conversation-transport-readiness.json');
    await fs.mkdir(path.join(destination, 'conversations'));
    for (const name of await fs.readdir(path.join(root, 'conversations')).catch(() => [])) if (/^[a-f0-9-]{36}\.json$/.test(name)) await copy(path.join('conversations', name), path.join('conversations', name));
    await fs.writeFile(path.join(destination, 'observations.json'), JSON.stringify(manifest, null, 2));
    console.log(`Saved whitelisted conversation evidence: ${destination}`);
  }
  if (app) await app.close(); app = null; await fs.rm(root, { recursive: true, force: true });
});
async function observeConversation(watchFiles = true) {
  diagnostic = true;
  await page.evaluate(() => {
    const timeline = window.__conversationDiagnostic = []; let previous;
    const record = () => {
      const state = { error: document.getElementById('conversation-error')?.textContent, status: document.querySelector('[role="status"]')?.textContent, requests: [...document.querySelectorAll('#conversation-history > article')].map(article => ({ state: article.querySelector('p:not(.history-exclusion)')?.textContent, replyLength: article.querySelectorAll('pre')[1]?.textContent.length })) };
      const key = JSON.stringify(state); if (key === previous) return; previous = key;
      timeline.push({ at: Date.now(), ...state }); if (timeline.length > 128) timeline.shift();
    };
    const observer = new MutationObserver(record);
    observer.observe(document.getElementById('conversation-section'), { childList: true, subtree: true, characterData: true });
    observer.observe(document.querySelector('[role="status"]'), { childList: true, subtree: true, characterData: true }); record();
  });
  if (!watchFiles) return;
  diagnosticWatcher = require('node:fs').watch(path.join(root, 'conversations'), (_, name) => {
    if (!/^[a-f0-9-]{36}\.json$/.test(String(name))) return;
    diagnosticReads = diagnosticReads.then(async () => {
      try { const record = JSON.parse(await fs.readFile(path.join(root, 'conversations', String(name)), 'utf8')); diagnosticFiles.push({ at: Date.now(), file: String(name), storageWarning: record.storageWarning, requests: record.requests.map(request => ({ id: request.id, status: request.status, error: request.error, replyLength: request.reply.length, messages: request.messages?.map(message => ({ id: message.id, completed: message.completed, length: message.text.length })) })) }); }
      catch (error) { diagnosticFiles.push({ at: Date.now(), file: String(name), error: error.code || error.message }); }
      if (diagnosticFiles.length > 128) diagnosticFiles.shift();
    });
  }).on('error', error => diagnosticFiles.push({ watcherError: error.code || error.message }));
}
async function launch(configure = true, extraEnv = {}) {
  app = await electron.launch({ args: ['.'], env: { ...process.env, ...extraEnv, COMPANION_TEST_ROOT: root } }); page = await app.firstWindow();
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

async function prepareConversation(extraEnv = {}) {
  await launch(true, extraEnv);
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

test('changed evidence after preview or during asynchronous thread preflight requires a new review and never starts a turn', async () => {
  test.setTimeout(60000);
  await fs.writeFile(path.join(root, 'conversation-provider.json'), JSON.stringify({ reply: 'Authored synthetic response that must never be requested.' }));
  await prepareConversation();
  const captureDir = path.join(root, 'vault', 'Companion', 'Captures');
  const file = path.join(captureDir, (await fs.readdir(captureDir)).find(name => name.endsWith('.md')));
  const original = await fs.readFile(file, 'utf8');
  await fs.writeFile(file, `${original}\nFIRST_EDIT_BEFORE_SEND\n`);
  await page.getByRole('button', { name: 'Send reviewed package', exact: true }).click();
  await expect(page.locator('#conversation-error')).toContainText(/changed|unavailable/);
  await expect(page.getByRole('button', { name: 'Send reviewed package', exact: true })).toBeDisabled();
  expect(await fs.stat(path.join(root, 'conversation-submissions.jsonl')).catch(error => error.code)).toBe('ENOENT');
  await selectCapture();
  await page.getByRole('button', { name: 'Preview conversation', exact: true }).click();
  await expect(page.getByLabel('Reviewed conversation package', { exact: true })).toHaveValue(/FIRST_EDIT_BEFORE_SEND/);
  await fs.writeFile(path.join(root, 'faults.json'), JSON.stringify({ pause: 'conversation-before-turn-start' }));
  await page.getByRole('button', { name: 'Send reviewed package', exact: true }).click();
  await expect.poll(() => fs.readFile(path.join(root, 'checkpoint.txt'), 'utf8').catch(() => '')).toBe('conversation-before-turn-start');
  await fs.writeFile(file, `${original}\nSECOND_EDIT_DURING_PREFLIGHT\n`);
  await fs.writeFile(path.join(root, 'release.txt'), 'release controlled preflight');
  await expect(page.locator('#conversation-history')).toContainText(/Context changed|Selected evidence changed/);
  await expect(page.locator('#conversation-history')).toContainText('failed');
  expect(await fs.stat(path.join(root, 'conversation-submissions.jsonl')).catch(error => error.code)).toBe('ENOENT');
  const rpc = (await fs.readFile(path.join(root, 'codex-requests.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
  expect(rpc.filter(call => call.method === 'thread/start')).toHaveLength(1);
  expect(rpc.filter(call => call.method === 'turn/start')).toEqual([]);
  const files = await fs.readdir(path.join(root, 'conversations'));
  const saved = JSON.parse(await fs.readFile(path.join(root, 'conversations', files.find(name => name.endsWith('.json'))), 'utf8'));
  expect(saved.requests).toHaveLength(1);
  expect(saved.requests[0].package.text).toContain('FIRST_EDIT_BEFORE_SEND');
  expect(saved.requests[0].package.text).not.toContain('SECOND_EDIT_DURING_PREFLIGHT');
  await page.getByLabel('Thought or link', { exact: true }).fill('Capture remains available after stale preflight.');
  await page.getByRole('button', { name: 'Save capture', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('Capture saved.');
});

test('full long replies remain inspectable while explicit history omission bounds the actual package and excludes dependent dialogue', async () => {
  test.setTimeout(60000);
  await fs.writeFile(path.join(root, 'conversation-provider.json'), JSON.stringify({ reply: 'Authored synthetic FIRST_HISTORICAL_CANARY.' }));
  await prepareConversation();
  await page.getByRole('button', { name: 'Send reviewed package', exact: true }).click();
  await expect(page.locator('#conversation-history')).toContainText('FIRST_HISTORICAL_CANARY');
  await expect(page.locator('#conversation-history article').last()).toContainText('completed');
  await page.getByLabel('Context question', { exact: true }).fill('Expand the previous hypothesis with limitations.');
  await page.getByRole('button', { name: 'Preview conversation', exact: true }).click();
  await expect(page.getByLabel('Reviewed conversation package', { exact: true })).toHaveValue(/FIRST_HISTORICAL_CANARY/);
  const longReply = `Authored synthetic LONG_REPLY_START\n${'🎸'.repeat(128001)}\nLONG_REPLY_END`;
  await fs.writeFile(path.join(root, 'conversation-provider.json'), JSON.stringify({ reply: longReply }));
  await page.getByRole('button', { name: 'Send reviewed package', exact: true }).click();
  await expect(page.locator('#conversation-history')).toContainText('LONG_REPLY_END');
  await expect(page.locator('#conversation-history article').last()).toContainText('completed');
  const files = await fs.readdir(path.join(root, 'conversations'));
  const saved = JSON.parse(await fs.readFile(path.join(root, 'conversations', files.find(name => name.endsWith('.json'))), 'utf8'));
  expect(saved.requests[1].reply).toBe(longReply);
  expect(saved.requests[1].package.historyIds).toEqual([saved.requests[0].id]);
  await page.getByLabel('Context question', { exact: true }).fill('What small observable test can we support?');
  await page.getByRole('button', { name: 'Preview conversation', exact: true }).click();
  await expect(page.locator('#conversation-summary')).toContainText('Oversized');
  await expect(page.getByRole('button', { name: 'Send reviewed package', exact: true })).toBeDisabled();
  await expect(page.getByLabel('Reviewed conversation package', { exact: true })).toHaveValue(/LONG_REPLY_END/);
  await page.locator('#conversation-history article').first().getByRole('checkbox', { name: 'Include request in next context', exact: true }).uncheck();
  await page.getByRole('button', { name: 'Preview conversation', exact: true }).click();
  await expect(page.getByLabel('Reviewed conversation package', { exact: true })).toHaveValue(/What small observable test/);
  await expect(page.getByLabel('Reviewed conversation package', { exact: true })).not.toHaveValue(/FIRST_HISTORICAL_CANARY|LONG_REPLY_START|LONG_REPLY_END/);
  await expect(page.getByLabel('Reviewed conversation package', { exact: true })).toHaveValue(/Spaced retrieval revisits a learned chord/);
  await expect(page.locator('#conversation-summary')).toContainText('depends on an explicitly omitted historical request');
  await expect(page.getByRole('button', { name: 'Send reviewed package', exact: true })).toBeEnabled();
  await fs.writeFile(path.join(root, 'conversation-provider.json'), JSON.stringify({ reply: 'Authored synthetic small test after explicit omission.' }));
  await page.getByRole('button', { name: 'Send reviewed package', exact: true }).click();
  await expect(page.locator('#conversation-history')).toContainText('small test after explicit omission');
  await expect(page.locator('#conversation-history')).toContainText('LONG_REPLY_END');
  const submissions = (await fs.readFile(path.join(root, 'conversation-submissions.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
  expect(submissions).toHaveLength(3);
  expect(submissions[2].text).not.toMatch(/FIRST_HISTORICAL_CANARY|LONG_REPLY_START|LONG_REPLY_END/);
  await page.locator('#conversation-history article').first().getByText('Inspect approved context', { exact: true }).click();
  await expect(page.locator('#conversation-history article').first().getByLabel('Saved approved context', { exact: true })).toHaveValue(/How could retrieval help MyTune\?/);
});

test('reviewed source and history scope survives restart before send and after send until an explicit re-add and recheck', async () => {
  // Four explicit turns and two restarts extend the measured 30.6s three-turn journey.
  test.setTimeout(90000);
  await fs.writeFile(path.join(root, 'conversation-provider.json'), JSON.stringify({ reply: 'Authored synthetic PERSIST_SOURCE_CANARY.' }));
  await prepareConversation();
  await page.getByRole('button', { name: 'Send reviewed package', exact: true }).click();
  await expect(page.locator('#conversation-history article').last()).toContainText('completed');
  await page.getByLabel('Context question', { exact: true }).fill('What limitations follow from that hypothesis?');
  await page.getByRole('button', { name: 'Preview conversation', exact: true }).click();
  await expect(page.getByLabel('Reviewed conversation package', { exact: true })).toHaveValue(/PERSIST_SOURCE_CANARY/);
  await fs.writeFile(path.join(root, 'conversation-provider.json'), JSON.stringify({ reply: 'Authored synthetic PERSIST_DESCENDANT_CANARY.' }));
  await page.getByRole('button', { name: 'Send reviewed package', exact: true }).click();
  await expect(page.locator('#conversation-history')).toContainText('PERSIST_DESCENDANT_CANARY');
  await expect(page.locator('#conversation-history article').last()).toContainText('completed');
  await page.locator('#conversation-history article').first().getByRole('checkbox', { name: 'Include request in next context', exact: true }).uncheck();
  await page.locator('#context-selected').getByRole('button', { name: 'Remove from context', exact: true }).click();
  await page.getByLabel('Context question', { exact: true }).fill('Use only the approved project context.');
  await page.getByRole('button', { name: 'Preview conversation', exact: true }).click();
  await expect(page.getByLabel('Reviewed conversation package', { exact: true })).toHaveValue(/Use only the approved project context/);
  await expect(page.getByLabel('Reviewed conversation package', { exact: true })).not.toHaveValue(/PERSIST_SOURCE_CANARY|PERSIST_DESCENDANT_CANARY|Spaced retrieval/);
  const callsBeforeRestart = await fs.readFile(path.join(root, 'conversation-submissions.jsonl'), 'utf8');
  await app.close(); app = null; await launch(false);
  await expect(page.locator('#conversation-history')).toContainText('PERSIST_DESCENDANT_CANARY');
  await page.getByLabel('Context question', { exact: true }).fill('Continue with project context alone.');
  await page.getByRole('button', { name: 'Preview conversation', exact: true }).click();
  await expect(page.getByLabel('Reviewed conversation package', { exact: true })).toHaveValue(/Continue with project context alone/);
  await expect(page.getByLabel('Reviewed conversation package', { exact: true })).not.toHaveValue(/PERSIST_SOURCE_CANARY|PERSIST_DESCENDANT_CANARY|Spaced retrieval/);
  await expect(page.locator('#conversation-history article').first().getByRole('checkbox', { name: 'Include request in next context', exact: true })).not.toBeChecked();
  expect(await fs.readFile(path.join(root, 'conversation-submissions.jsonl'), 'utf8')).toBe(callsBeforeRestart);
  const files = await fs.readdir(path.join(root, 'conversations'));
  const savedFile = path.join(root, 'conversations', files.find(name => name.endsWith('.json')));
  const scoped = JSON.parse(await fs.readFile(savedFile, 'utf8'));
  expect(scoped.requests).toHaveLength(2);
  expect(scoped.scope.excludedHistory).toContain(scoped.requests[0].id);
  expect(scoped.scope.excludedSources).toContain(scoped.requests[0].package.dependencies.find(item => item.key.startsWith('capture:')).key);
  await fs.writeFile(path.join(root, 'conversation-provider.json'), JSON.stringify({ reply: 'Authored synthetic project-only response.' }));
  await page.getByRole('button', { name: 'Send reviewed package', exact: true }).click();
  await expect(page.locator('#conversation-history')).toContainText('project-only response');
  await expect(page.locator('#conversation-history article').last()).toContainText('completed');
  await app.close(); app = null; await launch(false);
  await expect(page.locator('#conversation-history')).toContainText('project-only response');
  await page.getByLabel('Context question', { exact: true }).fill('retrieval: inspect the still excluded source');
  await page.getByRole('button', { name: 'Preview conversation', exact: true }).click();
  await expect(page.getByLabel('Reviewed conversation package', { exact: true })).toHaveValue(/inspect the still excluded source/);
  await expect(page.getByLabel('Reviewed conversation package', { exact: true })).not.toHaveValue(/PERSIST_SOURCE_CANARY|PERSIST_DESCENDANT_CANARY|Spaced retrieval/);
  await selectCapture();
  await page.locator('#conversation-history article').first().getByRole('checkbox', { name: 'Include request in next context', exact: true }).check();
  await expect(page.getByRole('button', { name: 'Send reviewed package', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: 'Preview conversation', exact: true }).click();
  await expect(page.getByLabel('Reviewed conversation package', { exact: true })).toHaveValue(/PERSIST_SOURCE_CANARY/);
  await expect(page.getByLabel('Reviewed conversation package', { exact: true })).toHaveValue(/PERSIST_DESCENDANT_CANARY/);
  await fs.writeFile(path.join(root, 'conversation-provider.json'), JSON.stringify({ reply: 'Authored synthetic explicitly restored response.' }));
  await page.getByRole('button', { name: 'Send reviewed package', exact: true }).click();
  await expect(page.locator('#conversation-history')).toContainText('explicitly restored response');
  await expect(page.locator('#conversation-history article').last()).toContainText('completed');
  const submissions = (await fs.readFile(path.join(root, 'conversation-submissions.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
  expect(submissions).toHaveLength(4);
  expect(submissions[2].text).not.toMatch(/PERSIST_SOURCE_CANARY|PERSIST_DESCENDANT_CANARY|Spaced retrieval/);
  expect(submissions[3].text).toMatch(/PERSIST_SOURCE_CANARY/);
  expect(submissions[3].text).toMatch(/PERSIST_DESCENDANT_CANARY/);
});

test('a completed restoration in a stale window cannot undo another windows later reviewed exclusion', async () => {
  test.setTimeout(90000);
  await fs.writeFile(path.join(root, 'conversation-provider.json'), JSON.stringify({ reply: 'Authored synthetic STALE_RESTORE_HISTORY_CANARY.' }));
  await prepareConversation();
  await page.getByRole('button', { name: 'Send reviewed package', exact: true }).click();
  await expect(page.locator('#conversation-history')).toContainText('STALE_RESTORE_HISTORY_CANARY');
  await expect(page.locator('#conversation-history article').last()).toContainText('completed');
  await page.locator('#context-selected').getByRole('button', { name: 'Remove from context', exact: true }).click();
  await page.locator('#conversation-history article').first().getByRole('checkbox', { name: 'Include request in next context', exact: true }).uncheck();
  await page.getByLabel('Context question', { exact: true }).fill('retrieval: exclude this evidence and its history');
  await page.getByRole('button', { name: 'Preview conversation', exact: true }).click();
  await expect(page.getByLabel('Reviewed conversation package', { exact: true })).toHaveValue(/exclude this evidence/);
  const otherApp = await electron.launch({ args: ['.'], env: { ...process.env, COMPANION_TEST_ROOT: root } });
  try {
    const other = await otherApp.firstWindow();
    await expect(other.locator('#timezone')).toContainText('America/Phoenix');
    await expect(other.locator('#conversation-history')).toContainText('STALE_RESTORE_HISTORY_CANARY');
    // Complete an intentional restore in the first window. Its action must be consumed.
    await selectCapture();
    await page.locator('#conversation-history article').first().getByRole('checkbox', { name: 'Include request in next context', exact: true }).check();
    await page.getByRole('button', { name: 'Preview conversation', exact: true }).click();
    await expect(page.getByLabel('Reviewed conversation package', { exact: true })).toHaveValue(/STALE_RESTORE_HISTORY_CANARY/);
    // A later independent window explicitly removes the same source and history.
    await other.getByLabel('Context question', { exact: true }).fill('retrieval: later independent exclusion');
    await other.getByRole('button', { name: 'Find context', exact: true }).click();
    await other.locator('#context-results article').filter({ hasText: 'Spaced retrieval' }).first().getByRole('button', { name: 'Add to context', exact: true }).click();
    await other.locator('#context-selected').getByRole('button', { name: 'Remove from context', exact: true }).click();
    const otherHistory = other.locator('#conversation-history article').first().getByRole('checkbox', { name: 'Include request in next context', exact: true });
    await otherHistory.check(); await otherHistory.uncheck();
    await other.getByRole('button', { name: 'Preview conversation', exact: true }).click();
    await expect(other.getByLabel('Reviewed conversation package', { exact: true })).toHaveValue(/later independent exclusion/);
    await expect(other.getByLabel('Reviewed conversation package', { exact: true })).not.toHaveValue(/STALE_RESTORE_HISTORY_CANARY|Spaced retrieval/);
    const submissions = await fs.readFile(path.join(root, 'conversation-submissions.jsonl'), 'utf8');
    // The earlier approved token is revoked by the newer main-owned scope revision.
    await page.getByRole('button', { name: 'Send reviewed package', exact: true }).click();
    await expect(page.locator('#conversation-error')).toContainText(/changed|preview/i);
    expect(await fs.readFile(path.join(root, 'conversation-submissions.jsonl'), 'utf8')).toBe(submissions);
    await page.getByLabel('Context question', { exact: true }).fill('Continue without another Add or history recheck.');
    await page.getByRole('button', { name: 'Preview conversation', exact: true }).click();
    await expect(page.getByLabel('Reviewed conversation package', { exact: true })).toHaveValue(/Continue without another Add/);
    await expect(page.getByLabel('Reviewed conversation package', { exact: true })).not.toHaveValue(/STALE_RESTORE_HISTORY_CANARY|Spaced retrieval/);
    // Fresh explicit actions can restore the material, followed by a new review.
    await page.getByLabel('Context question', { exact: true }).fill('retrieval: intentionally restore after the independent exclusion');
    await selectCapture();
    const ownHistory = page.locator('#conversation-history article').first().getByRole('checkbox', { name: 'Include request in next context', exact: true });
    await ownHistory.uncheck(); await ownHistory.check();
    await page.getByRole('button', { name: 'Preview conversation', exact: true }).click();
    await expect(page.getByLabel('Reviewed conversation package', { exact: true })).toHaveValue(/STALE_RESTORE_HISTORY_CANARY/);
    await expect(page.getByLabel('Reviewed conversation package', { exact: true })).toHaveValue(/Spaced retrieval/);
  } finally { await otherApp.close(); }
});

test('ordered assistant items retain every full completed message and phase across restart', async () => {
  test.setTimeout(60000);
  const messages = [
    { phase: 'commentary', delta: 'OBSOLETE_COMMENTARY_FRAGMENT', text: 'COMMENTARY_COMPLETE_CANARY: authored synthetic mechanism explanation.' },
    { phase: 'final_answer', delta: 'OBSOLETE_FINAL_FRAGMENT', text: 'FINAL_COMPLETE_CANARY: authored synthetic hypothesis, limitation and observable test.' },
    { phase: null, delta: 'OBSOLETE_LEGACY_FRAGMENT', text: 'UNKNOWN_PHASE_COMPLETE_CANARY: authored synthetic legacy message.' }
  ];
  await fs.writeFile(path.join(root, 'conversation-provider.json'), JSON.stringify({ messages }));
  await prepareConversation();
  await observeConversation();
  await page.getByRole('button', { name: 'Send reviewed package', exact: true }).click();
  await expect(page.locator('#conversation-history')).toContainText('UNKNOWN_PHASE_COMPLETE_CANARY');
  await expect(page.locator('#conversation-history article').last()).toContainText('completed');
  await expect(page.locator('#conversation-history')).toContainText('COMMENTARY_COMPLETE_CANARY');
  await expect(page.locator('#conversation-history')).toContainText('FINAL_COMPLETE_CANARY');
  await expect(page.locator('#conversation-history')).not.toContainText('OBSOLETE_');
  const files = await fs.readdir(path.join(root, 'conversations'));
  const saved = JSON.parse(await fs.readFile(path.join(root, 'conversations', files.find(name => name.endsWith('.json'))), 'utf8'));
  expect(saved.requests[0].reply).toBe('COMMENTARY_COMPLETE_CANARY: authored synthetic mechanism explanation.\n\nFINAL_COMPLETE_CANARY: authored synthetic hypothesis, limitation and observable test.\n\nUNKNOWN_PHASE_COMPLETE_CANARY: authored synthetic legacy message.');
  expect(saved.requests[0].messages.map(({ text, phase, completed }) => ({ text, phase, completed }))).toEqual([
    { text: messages[0].text, phase: 'commentary', completed: true },
    { text: messages[1].text, phase: 'final_answer', completed: true },
    { text: messages[2].text, phase: null, completed: true }
  ]);
  expect(new Set(saved.requests[0].messages.map(message => message.id)).size).toBe(3);
  const calls = await fs.readFile(path.join(root, 'conversation-submissions.jsonl'), 'utf8');
  expect(calls.trim().split('\n').filter(Boolean)).toHaveLength(1);
  await app.close(); app = null; await launch(false);
  await expect(page.locator('#conversation-history')).toContainText('COMMENTARY_COMPLETE_CANARY');
  await expect(page.locator('#conversation-history')).toContainText('FINAL_COMPLETE_CANARY');
  await expect(page.locator('#conversation-history')).toContainText('UNKNOWN_PHASE_COMPLETE_CANARY');
  expect(await fs.readFile(path.join(root, 'conversation-submissions.jsonl'), 'utf8')).toBe(calls);
});

test('full terminal item order includes an earlier assistant item whose individual events were absent', async () => {
  test.setTimeout(60000);
  await fs.writeFile(path.join(root, 'conversation-provider.json'), JSON.stringify({ messages: [
    { text: 'TERMINAL_EARLIER_CANARY: authored synthetic commentary.', phase: 'commentary', omitIndividualEvents: true },
    { text: 'STREAMED_LATER_CANARY: authored synthetic final hypothesis.', phase: 'final_answer' }
  ] }));
  await prepareConversation(); await observeConversation();
  await page.getByRole('button', { name: 'Send reviewed package', exact: true }).click();
  await expect(page.locator('#conversation-history')).toContainText('STREAMED_LATER_CANARY');
  await expect(page.locator('#conversation-history article').last()).toContainText('completed');
  await expect(page.locator('#conversation-history')).toContainText('TERMINAL_EARLIER_CANARY');
  const files = await fs.readdir(path.join(root, 'conversations'));
  const saved = JSON.parse(await fs.readFile(path.join(root, 'conversations', files.find(name => name.endsWith('.json'))), 'utf8'));
  expect(saved.requests[0].reply).toBe('TERMINAL_EARLIER_CANARY: authored synthetic commentary.\n\nSTREAMED_LATER_CANARY: authored synthetic final hypothesis.');
  expect(saved.requests[0].messages.map(message => message.phase)).toEqual(['commentary', 'final_answer']);
  const visible = await page.locator('#conversation-history').textContent();
  expect(visible.indexOf('TERMINAL_EARLIER_CANARY')).toBeLessThan(visible.indexOf('STREAMED_LATER_CANARY'));
  const calls = await fs.readFile(path.join(root, 'conversation-submissions.jsonl'), 'utf8');
  expect(calls.trim().split('\n').filter(Boolean)).toHaveLength(1);
  await app.close(); app = null; await launch(false);
  await expect(page.locator('#conversation-history')).toContainText('TERMINAL_EARLIER_CANARY');
  await expect(page.locator('#conversation-history')).toContainText('STREAMED_LATER_CANARY');
  expect(await fs.readFile(path.join(root, 'conversation-submissions.jsonl'), 'utf8')).toBe(calls);
});

for (const boundary of ['memory citation', 'terminal-only command', 'unconfirmed assistant completion']) {
  test(`protocol boundary preserves safe incomplete text without replay: ${boundary}`, async () => {
    test.setTimeout(60000);
    const scenario = { messages: [{ text: 'Authored synthetic SAFE_BOUNDARY_PARTIAL_CANARY.', phase: 'partial_answer' }] };
    if (boundary === 'memory citation') scenario.messages.push({ text: 'UNSELECTED_MEMORY_CONTENT_CANARY', phase: 'final_answer', memoryCitation: { entries: [{ path: 'UNSELECTED_MEMORY_PATH_CANARY.md', lineStart: 1, lineEnd: 1, note: 'UNSELECTED_MEMORY_METADATA_CANARY' }], threadIds: ['UNSELECTED_HIDDEN_THREAD_CANARY'] } });
    if (boundary === 'terminal-only command') scenario.terminalCommand = true;
    if (boundary === 'unconfirmed assistant completion') { scenario.messages[0].omitCompletedEvent = true; scenario.terminalView = 'notLoaded'; }
    await fs.writeFile(path.join(root, 'conversation-provider.json'), JSON.stringify(scenario));
    await prepareConversation(); await observeConversation();
    await page.getByRole('button', { name: 'Send reviewed package', exact: true }).click();
    await expect(page.locator('#conversation-history')).toContainText('SAFE_BOUNDARY_PARTIAL_CANARY');
    const files = await fs.readdir(path.join(root, 'conversations'));
    const savedFile = path.join(root, 'conversations', files.find(name => name.endsWith('.json')));
    await expect.poll(async () => JSON.parse(await fs.readFile(savedFile, 'utf8')).requests[0].status).toMatch(/^(completed|failed|interrupted)$/);
    const savedText = await fs.readFile(savedFile, 'utf8'), saved = JSON.parse(savedText);
    expect(['failed', 'interrupted']).toContain(saved.requests[0].status);
    await expect(page.locator('#conversation-history')).toContainText('incomplete');
    if (boundary !== 'unconfirmed assistant completion') await expect(page.locator('#conversation-history')).toContainText(/unselected memory|unselected tool/i);
    expect(savedText).not.toMatch(/UNSELECTED_MEMORY_|UNSELECTED_HIDDEN_THREAD_|UNSELECTED_COMMAND_CONTENT_CANARY/);
    expect(saved.requests[0].reply).toContain('SAFE_BOUNDARY_PARTIAL_CANARY');
    const calls = await fs.readFile(path.join(root, 'conversation-submissions.jsonl'), 'utf8');
    expect(calls.trim().split('\n').filter(Boolean)).toHaveLength(1);
    const rpc = (await fs.readFile(path.join(root, 'codex-requests.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
    expect(rpc.filter(call => /command\/exec|login/.test(call.method))).toEqual([]);
    await page.getByLabel('Thought or link', { exact: true }).fill('Capture remains available after a protocol boundary failure.');
    await page.getByRole('button', { name: 'Save capture', exact: true }).click();
    await expect(page.getByRole('status')).toContainText('Capture saved.');
    await app.close(); app = null; await launch(false);
    await expect(page.locator('#conversation-history')).toContainText('SAFE_BOUNDARY_PARTIAL_CANARY');
    await expect(page.locator('#conversation-history')).toContainText('incomplete');
    expect(await fs.readFile(path.join(root, 'conversation-submissions.jsonl'), 'utf8')).toBe(calls);
  });
}

test('a late memory citation removes the offending item from retained partial text and future context', async () => {
  test.setTimeout(60000);
  await fs.writeFile(path.join(root, 'conversation-provider.json'), JSON.stringify({ messages: [
    { text: 'Authored synthetic SAFE_EARLIER_ITEM_CANARY.', phase: 'partial_answer' },
    { text: 'UNSELECTED_LATE_MEMORY_CANARY', phase: 'final_answer', citationAtCompletion: true, memoryCitation: { entries: [{ path: 'UNSELECTED_LATE_MEMORY_PATH_CANARY.md', lineStart: 1, lineEnd: 1, note: 'Authored synthetic unselected memory' }], threadIds: ['UNSELECTED_LATE_MEMORY_THREAD_CANARY'] } }
  ] }));
  await prepareConversation(); await observeConversation();
  await page.getByRole('button', { name: 'Send reviewed package', exact: true }).click();
  await expect(page.locator('#conversation-history')).toContainText(/unselected memory/i);
  await expect(page.locator('#conversation-history')).toContainText('incomplete');
  await expect(page.locator('#conversation-history')).toContainText('SAFE_EARLIER_ITEM_CANARY');
  // Previously displayed provisional bytes cannot be unseen. Current retained output must be safe.
  await expect(page.locator('#conversation-history')).not.toContainText('UNSELECTED_LATE_MEMORY_CANARY');
  const files = await fs.readdir(path.join(root, 'conversations'));
  const savedFile = path.join(root, 'conversations', files.find(name => name.endsWith('.json')));
  const savedText = await fs.readFile(savedFile, 'utf8'), saved = JSON.parse(savedText);
  expect(['failed', 'interrupted']).toContain(saved.requests[0].status);
  expect(saved.requests[0].reply).toBe('Authored synthetic SAFE_EARLIER_ITEM_CANARY.');
  expect(savedText).not.toMatch(/UNSELECTED_LATE_MEMORY_/);
  expect(saved.requests[0].messages).toHaveLength(1);
  await page.getByLabel('Context question', { exact: true }).fill('What is supported by the selected source and project alone?');
  await page.getByRole('button', { name: 'Preview conversation', exact: true }).click();
  await expect(page.getByLabel('Reviewed conversation package', { exact: true })).toHaveValue(/What is supported/);
  await expect(page.getByLabel('Reviewed conversation package', { exact: true })).not.toHaveValue(/SAFE_EARLIER_ITEM_CANARY|UNSELECTED_LATE_MEMORY_/);
  await expect(page.locator('#conversation-summary')).toContainText('Excluded incomplete historical request');
  await fs.writeFile(path.join(root, 'conversation-provider.json'), JSON.stringify({ reply: 'Authored synthetic clean next reply.' }));
  await page.getByRole('button', { name: 'Send reviewed package', exact: true }).click();
  await expect(page.locator('#conversation-history')).toContainText('clean next reply');
  await expect(page.locator('#conversation-history article').last()).toContainText('completed');
  const calls = await fs.readFile(path.join(root, 'conversation-submissions.jsonl'), 'utf8'), submissions = calls.trim().split('\n').map(line => JSON.parse(line));
  expect(submissions).toHaveLength(2);
  expect(submissions[1].text).not.toMatch(/SAFE_EARLIER_ITEM_CANARY|UNSELECTED_LATE_MEMORY_/);
  await app.close(); app = null; await launch(false);
  await expect(page.locator('#conversation-history')).toContainText('SAFE_EARLIER_ITEM_CANARY');
  await expect(page.locator('#conversation-history')).not.toContainText('UNSELECTED_LATE_MEMORY_CANARY');
  expect(await fs.readFile(path.join(root, 'conversation-submissions.jsonl'), 'utf8')).toBe(calls);
});

async function unavailableFinalHistory() {
  await fs.writeFile(path.join(root, 'conversation-provider.json'), JSON.stringify({ holdCompletion: true, messages: [
    { delta: 'Authored synthetic DURABLE_PREFIX.', text: 'Authored synthetic LATEST_VISIBLE_REPLY_CANARY after the history failure.', phase: 'final_answer' }
  ] }));
  await prepareConversation(); await observeConversation();
  await page.getByRole('button', { name: 'Send reviewed package', exact: true }).click();
  await expect(page.locator('#conversation-history')).toContainText('DURABLE_PREFIX');
  const files = await fs.readdir(path.join(root, 'conversations'));
  const savedFile = path.join(root, 'conversations', files.find(name => name.endsWith('.json')));
  await expect.poll(async () => JSON.parse(await fs.readFile(savedFile, 'utf8')).requests[0].reply).toContain('DURABLE_PREFIX');
  // Existing filesystem checkpoint fails all later history writes; provider release is external.
  await fs.writeFile(path.join(root, 'faults.json'), JSON.stringify({ fail: 'conversation-before-store', code: 'EACCES' }));
  await fs.writeFile(path.join(root, 'conversation-release.json'), '{}');
  await expect.poll(() => page.evaluate(() => window.__conversationDiagnostic.some(entry => entry.error?.includes('may not survive restart')))).toBe(true);
  await page.getByLabel('Thought or link', { exact: true }).fill('Capture after unavailable history storage.');
  await page.getByRole('button', { name: 'Save capture', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('Capture saved.');
  await fs.unlink(path.join(root, 'faults.json'));
  const mainPid = await app.evaluate(() => process.pid);
  diagnosticPriorTimelines.push({ mainPid, timeline: await page.evaluate(() => window.__conversationDiagnostic) });
  await page.reload(); await observeConversation(false);
  expect(await app.evaluate(() => process.pid)).toBe(mainPid);
  await expect(page.locator('#conversation-history')).toContainText('LATEST_VISIBLE_REPLY_CANARY');
  await expect(page.locator('#conversation-error')).toContainText('may not survive restart');
  const durable = JSON.parse(await fs.readFile(savedFile, 'utf8'));
  expect(durable.requests[0].reply).toContain('DURABLE_PREFIX');
  expect(durable.requests[0].reply).not.toContain('LATEST_VISIBLE_REPLY_CANARY');
  expect(durable.requests[0].status).not.toBe('completed');
  const calls = await fs.readFile(path.join(root, 'conversation-submissions.jsonl'), 'utf8');
  expect(calls.trim().split('\n').filter(Boolean)).toHaveLength(1);
  return { savedFile, calls };
}

test('persistent history storage failure retains latest text and warning until an explicit local resave', async () => {
  test.setTimeout(60000);
  const { savedFile, calls } = await unavailableFinalHistory();
  await page.getByRole('button', { name: 'Save retained reply locally', exact: true }).click();
  await expect(page.locator('#conversation-error')).not.toContainText('may not survive restart');
  await expect.poll(async () => JSON.parse(await fs.readFile(savedFile, 'utf8')).requests[0].reply).toContain('LATEST_VISIBLE_REPLY_CANARY');
  const saved = JSON.parse(await fs.readFile(savedFile, 'utf8'));
  expect(saved.requests[0].status).toBe('interrupted');
  expect(saved.storageWarning).toBeUndefined();
  expect(saved.requests).toHaveLength(1);
  await app.close(); app = null; await launch(false);
  await expect(page.locator('#conversation-history')).toContainText('LATEST_VISIBLE_REPLY_CANARY');
  await expect(page.locator('#conversation-history')).toContainText('incomplete');
  await expect(page.getByRole('heading', { name: 'Capture after unavailable history storage.', exact: true })).toBeVisible();
  expect(await fs.readFile(path.join(root, 'conversation-submissions.jsonl'), 'utf8')).toBe(calls);
});

test('persistent history storage recovery preserves a conflicting update from another desktop instance', async () => {
  test.setTimeout(90000);
  const { savedFile, calls } = await unavailableFinalHistory();
  const otherApp = await electron.launch({ args: ['.'], env: { ...process.env, COMPANION_TEST_ROOT: root } });
  try {
    const other = await otherApp.firstWindow();
    await expect(other.locator('#conversation-history')).toContainText('DURABLE_PREFIX');
    await expect(other.locator('#conversation-history')).toContainText('interrupted');
    const changed = await fs.readFile(savedFile, 'utf8');
    await page.getByRole('button', { name: 'Save retained reply locally', exact: true }).click();
    await expect(page.locator('#conversation-error')).toContainText(/changed|conflict/i);
    await expect(page.locator('#conversation-history')).toContainText('LATEST_VISIBLE_REPLY_CANARY');
    expect(await fs.readFile(savedFile, 'utf8')).toBe(changed);
    await page.reload(); await observeConversation(false);
    await expect(page.locator('#conversation-history')).toContainText('LATEST_VISIBLE_REPLY_CANARY');
    await expect(page.locator('#conversation-error')).toContainText(/unsaved|may not survive restart/i);
    expect(await fs.readFile(savedFile, 'utf8')).toBe(changed);
    expect(await fs.readFile(path.join(root, 'conversation-submissions.jsonl'), 'utf8')).toBe(calls);
  } finally { await otherApp.close(); }
});

for (const outcome of ['completed', 'failed', 'interrupted', 'late citation']) {
  test(`conversation transport persists truthful terminal setup diagnostics: ${outcome}`, async () => {
    test.setTimeout(60000);
    const scenario = outcome === 'late citation' ? { messages: [
      { text: 'Authored synthetic DIAGNOSTIC_SAFE_REPLY_CANARY.', phase: 'partial_answer' },
      { text: 'DIAGNOSTIC_UNSELECTED_MEMORY_CANARY', phase: 'final_answer', citationAtCompletion: true, memoryCitation: { entries: [{ path: 'DIAGNOSTIC_UNSELECTED_PATH_CANARY.md', lineStart: 1, lineEnd: 1, note: 'Authored synthetic boundary finding' }], threadIds: ['diagnostic-unselected-thread'] } }
    ] } : { reply: 'Authored synthetic DIAGNOSTIC_SAFE_REPLY_CANARY.', ...(outcome === 'failed' ? { turn: 'usage-limit' } : { turn: outcome }) };
    await fs.writeFile(path.join(root, 'conversation-provider.json'), JSON.stringify(scenario));
    await prepareConversation(); await observeConversation();
    await page.getByRole('button', { name: 'Send reviewed package', exact: true }).click();
    await expect(page.locator('#conversation-history')).toContainText('DIAGNOSTIC_SAFE_REPLY_CANARY');
    const files = await fs.readdir(path.join(root, 'conversations'));
    const historyFile = path.join(root, 'conversations', files.find(name => name.endsWith('.json')));
    const terminal = outcome === 'late citation' ? 'interrupted' : outcome;
    await expect.poll(async () => JSON.parse(await fs.readFile(historyFile, 'utf8')).requests[0].status).toBe(terminal);
    const reportFile = path.join(root, 'conversation-transport', 'readiness.json');
    await expect.poll(async () => JSON.parse(await fs.readFile(reportFile, 'utf8')).status).toBe(terminal);
    const reportText = await fs.readFile(reportFile, 'utf8'), report = JSON.parse(reportText);
    expect(report.turns.at(-1).status).toBe(terminal);
    expect(report.reply).toContain('DIAGNOSTIC_SAFE_REPLY_CANARY');
    expect(reportText).not.toMatch(/DIAGNOSTIC_UNSELECTED_|userCode|fixture@example/);
    expect(report.ready).toBe(false); expect(report.evidence).toBe('controlled-fixture-not-live');
    const rpc = (await fs.readFile(path.join(root, 'codex-requests.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
    expect(rpc.filter(call => /account\/|command\/exec|config\/|skills\//.test(call.method))).toEqual([]);
    const calls = await fs.readFile(path.join(root, 'conversation-submissions.jsonl'), 'utf8');
    expect(calls.trim().split('\n').filter(Boolean)).toHaveLength(1);
    await app.close(); app = null; await launch(false);
    await expect(page.locator('#conversation-history')).toContainText('DIAGNOSTIC_SAFE_REPLY_CANARY');
    expect(await fs.readFile(path.join(root, 'conversation-submissions.jsonl'), 'utf8')).toBe(calls);
  });
}

test('explicit conversation selection preserves independent brief pins and resumes both conversations after restart', async () => {
  // Existing setup/send/restart takes about18s; this journey adds refresh, another turn and switching.
  test.setTimeout(90000);
  await fs.writeFile(path.join(root, 'conversation-provider.json'), JSON.stringify({ reply: 'Authored synthetic CONVERSATION_A_V1_REPLY_CANARY.' }));
  await prepareConversation();
  await page.getByRole('button', { name: 'Send reviewed package', exact: true }).click();
  await expect(page.locator('#conversation-history article').last()).toContainText('completed');
  const originalA = await onlyConversation();
  expect(originalA.brief.version).toBe(1);
  const originalContext = originalA.requests[0].package.text;
  const callsA = await fs.readFile(path.join(root, 'conversation-submissions.jsonl'), 'utf8');
  await fs.writeFile(path.join(root, 'README.md'), '# MyTune\n\nBRIEF_V2_SOURCE_CANARY: A rhythm practice tutor with a new metronome goal.\n');
  await page.getByRole('button', { name: 'Propose brief', exact: true }).click();
  await page.getByRole('button', { name: 'Approve proposed brief', exact: true }).click();
  await expect(page.locator('#brief-view')).toContainText('Approved version 2');
  await expect(page.getByLabel('Conversation brief version', { exact: true })).toHaveValue('1');
  await expect(page.getByLabel('Conversation brief version', { exact: true })).toBeDisabled();
  await page.getByLabel('Context question', { exact: true }).fill('Continue conversation A using its original approved project context.');
  await page.getByRole('button', { name: 'Preview conversation', exact: true }).click();
  await expect(page.getByLabel('Reviewed conversation package', { exact: true })).toHaveValue(/Approved brief version 1/);
  await expect(page.getByLabel('Reviewed conversation package', { exact: true })).not.toHaveValue(/BRIEF_V2_SOURCE_CANARY/);
  expect(await fs.readFile(path.join(root, 'conversation-submissions.jsonl'), 'utf8')).toBe(callsA);

  await page.getByRole('button', { name: 'New conversation', exact: true }).click();
  await expect(page.locator('#conversation-history article')).toHaveCount(0);
  await expect(page.getByLabel('Context question', { exact: true })).toHaveValue('');
  await expect(page.getByLabel('Reviewed conversation package', { exact: true })).toHaveValue('');
  await expect(page.getByRole('button', { name: 'Send reviewed package', exact: true })).toBeDisabled();
  await expect(page.getByLabel('Allow beyond-evidence speculation', { exact: true })).not.toBeChecked();
  await expect(page.getByLabel('Conversation brief version', { exact: true })).toBeEnabled();
  await page.getByLabel('Conversation brief version', { exact: true }).fill('2');
  await page.getByLabel('Context question', { exact: true }).fill('CONVERSATION_B_QUESTION_CANARY: relate retrieval to the refreshed rhythm goal.');
  await selectCapture();
  await page.getByRole('button', { name: 'Preview conversation', exact: true }).click();
  await expect(page.getByLabel('Reviewed conversation package', { exact: true })).toHaveValue(/Approved brief version 2/);
  await expect(page.getByLabel('Reviewed conversation package', { exact: true })).toHaveValue(/BRIEF_V2_SOURCE_CANARY/);
  await expect(page.getByLabel('Reviewed conversation package', { exact: true })).not.toHaveValue(/CONVERSATION_A_V1_REPLY_CANARY/);
  const reviewedB = await page.getByLabel('Reviewed conversation package', { exact: true }).inputValue();
  await fs.writeFile(path.join(root, 'conversation-provider.json'), JSON.stringify({ reply: 'Authored synthetic CONVERSATION_B_V2_REPLY_CANARY.' }));
  await page.getByRole('button', { name: 'Send reviewed package', exact: true }).click();
  await expect(page.locator('#conversation-history article').last()).toContainText('completed');
  await expect(page.locator('#conversation-history')).toContainText('CONVERSATION_B_V2_REPLY_CANARY');
  await expect(page.locator('#conversation-history')).not.toContainText('CONVERSATION_A_V1_REPLY_CANARY');
  const records = await Promise.all((await fs.readdir(path.join(root, 'conversations'))).filter(name => name.endsWith('.json')).map(async name => JSON.parse(await fs.readFile(path.join(root, 'conversations', name), 'utf8'))));
  expect(records).toHaveLength(2);
  const a = records.find(record => record.id === originalA.id), b = records.find(record => record.id !== originalA.id);
  expect(a.requests).toHaveLength(1); expect(a.brief).toEqual(originalA.brief); expect(a.requests[0].package.text).toBe(originalContext);
  expect(b.brief.version).toBe(2); expect(b.requests).toHaveLength(1); expect(b.requests[0].package.text).toBe(reviewedB);
  const choose = page.getByLabel('Retained conversation', { exact: true });
  await choose.selectOption(a.id);
  await expect(page.locator('#conversation-history')).toContainText('CONVERSATION_A_V1_REPLY_CANARY');
  await expect(page.locator('#conversation-history')).not.toContainText('CONVERSATION_B_V2_REPLY_CANARY');
  await expect(page.getByLabel('Conversation brief version', { exact: true })).toHaveValue('1');
  await expect(page.getByLabel('Saved approved context', { exact: true })).toHaveValue(originalContext);
  await choose.selectOption(b.id);
  await expect(page.locator('#conversation-history')).toContainText('CONVERSATION_B_V2_REPLY_CANARY');
  await expect(page.getByLabel('Conversation brief version', { exact: true })).toHaveValue('2');
  const calls = await fs.readFile(path.join(root, 'conversation-submissions.jsonl'), 'utf8');
  expect(calls.trim().split('\n').map(JSON.parse).map(call => call.text)).toEqual([originalContext, reviewedB]);
  await app.close(); app = null; await launch(false);
  await page.getByLabel('Retained conversation', { exact: true }).selectOption(a.id);
  await expect(page.locator('#conversation-history')).toContainText('CONVERSATION_A_V1_REPLY_CANARY');
  await expect(page.getByLabel('Conversation brief version', { exact: true })).toHaveValue('1');
  await page.getByLabel('Retained conversation', { exact: true }).selectOption(b.id);
  await expect(page.locator('#conversation-history')).toContainText('CONVERSATION_B_V2_REPLY_CANARY');
  await expect(page.getByLabel('Conversation brief version', { exact: true })).toHaveValue('2');
  expect(await fs.readFile(path.join(root, 'conversation-submissions.jsonl'), 'utf8')).toBe(calls);
});

// Authored main-process capacity evidence is a controlled boundary, never live readiness.
const capacityEvidence = () => ({
  capacity: { maxCodePoints: 32000, model: 'fixture', evidence: 'Authored synthetic capacity proof v1', harnessAndOutputEvidence: 'Authored synthetic harness and output proof v1' },
  proofFingerprint: 'controlled-proof-1', settingsRevision: 'controlled-settings-1', dispatchEnabled: true,
  privateProofMarker: 'PRIVATE_CAPACITY_PROOF_CANARY'
});
async function writeCapacity(evidence) { await fs.writeFile(path.join(root, 'conversation-evidence.json'), JSON.stringify(evidence)); }
async function conversationRpc() {
  return (await fs.readFile(path.join(root, 'codex-requests.jsonl'), 'utf8').catch(error => { if (error.code === 'ENOENT') return ''; throw error; })).trim().split('\n').filter(Boolean).map(JSON.parse);
}
async function noSubmission() { expect(await fs.stat(path.join(root, 'conversation-submissions.jsonl')).catch(error => error.code)).toBe('ENOENT'); }
async function onlyConversation() {
  const files = await fs.readdir(path.join(root, 'conversations'));
  return JSON.parse(await fs.readFile(path.join(root, 'conversations', files.find(name => name.endsWith('.json'))), 'utf8'));
}

test('shared verified capacity bounds the complete Unicode package without trimming and keeps private proof local', async () => {
  test.setTimeout(60000);
  const evidence = capacityEvidence(); await writeCapacity(evidence);
  await fs.writeFile(path.join(root, 'conversation-provider.json'), JSON.stringify({ reply: 'Authored synthetic bounded reply.' }));
  await prepareConversation();
  const question = page.getByLabel('Context question', { exact: true }), reviewed = page.getByLabel('Reviewed conversation package', { exact: true });
  const initial = await reviewed.inputValue(), originalQuestion = await question.inputValue();
  // Dynamic vault provenance has a variable length. Pad only the question to the literal limit.
  const padding = 32000 - [...initial].length;
  await question.fill(originalQuestion + '🎸'.repeat(padding));
  await page.getByRole('button', { name: 'Preview conversation', exact: true }).click();
  await expect(page.locator('#conversation-summary')).toContainText('32000 / 32000 Unicode code points');
  expect([...(await reviewed.inputValue())]).toHaveLength(32000);
  await expect(page.getByRole('button', { name: 'Send reviewed package', exact: true })).toBeEnabled();
  await question.fill(originalQuestion + '🎸'.repeat(padding + 1));
  await page.getByRole('button', { name: 'Preview conversation', exact: true }).click();
  await expect(page.locator('#conversation-summary')).toContainText('32001 / 32000 Unicode code points');
  expect([...(await reviewed.inputValue())]).toHaveLength(32001);
  await expect(page.getByRole('button', { name: 'Send reviewed package', exact: true })).toBeDisabled();
  evidence.capacity.maxCodePoints = 2000; await writeCapacity(evidence);
  await page.getByRole('button', { name: 'Preview conversation', exact: true }).click();
  await expect(page.locator('#conversation-summary')).toContainText('32001 / 2000 Unicode code points');
  await page.getByRole('button', { name: 'Preview context', exact: true }).click();
  await expect(page.locator('#context-summary')).toContainText('/ 2000 Unicode code points');
  await expect(page.locator('#context-summary')).toContainText('Authored synthetic capacity proof v1');
  await question.fill(originalQuestion);
  await page.getByRole('button', { name: 'Preview conversation', exact: true }).click();
  await expect(page.locator('#conversation-summary')).toContainText('/ 2000 Unicode code points');
  await expect(page.getByRole('button', { name: 'Send reviewed package', exact: true })).toBeEnabled();
  const exact = await reviewed.inputValue();
  await page.getByRole('button', { name: 'Send reviewed package', exact: true }).click();
  await expect(page.locator('#conversation-history article').last()).toContainText('completed');
  const record = await onlyConversation();
  expect(record.requests[0].package.limit).toBe(2000); expect(record.requests[0].package.text).toBe(exact);
  expect(JSON.stringify(record)).not.toContain('PRIVATE_CAPACITY_PROOF_CANARY');
  expect(JSON.stringify(record)).not.toContain('controlled-proof-1');
  const submissions = (await fs.readFile(path.join(root, 'conversation-submissions.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
  expect(submissions.map(value => value.text)).toEqual([exact]);
  const report = JSON.parse(await fs.readFile(path.join(root, 'conversation-transport', 'readiness.json'), 'utf8'));
  expect(report.ready).toBe(false); expect(report.evidence).toBe('controlled-fixture-not-live');
});

test('model proof settings and dispatch changes revoke a reviewed capacity snapshot before any provider request', async () => {
  test.setTimeout(60000);
  await writeCapacity(capacityEvidence());
  await fs.writeFile(path.join(root, 'conversation-provider.json'), JSON.stringify({ reply: 'Authored synthetic binding reply.' }));
  await prepareConversation();
  for (const change of [
    evidence => { evidence.capacity.model = 'changed-model'; },
    evidence => { evidence.capacity.harnessAndOutputEvidence = 'changed output proof'; },
    evidence => { evidence.proofFingerprint = 'changed-private-proof'; },
    evidence => { evidence.settingsRevision = 'changed-settings'; },
    evidence => { evidence.dispatchEnabled = false; }
  ]) {
    const changed = capacityEvidence(); change(changed); await writeCapacity(changed);
    await page.getByRole('button', { name: 'Send reviewed package', exact: true }).click();
    await expect(page.locator('#conversation-error')).toContainText(/changed|unavailable|preview/i);
    await expect(page.getByRole('button', { name: 'Send reviewed package', exact: true })).toBeDisabled();
    await noSubmission(); expect(await conversationRpc()).toEqual([]);
    await writeCapacity(capacityEvidence());
    await page.getByRole('button', { name: 'Preview conversation', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Send reviewed package', exact: true })).toBeEnabled();
  }
  const exact = await page.getByLabel('Reviewed conversation package', { exact: true }).inputValue();
  await page.getByRole('button', { name: 'Send reviewed package', exact: true }).click();
  await expect(page.locator('#conversation-history article').last()).toContainText('completed');
  expect((await onlyConversation()).requests).toHaveLength(1);
  expect(JSON.parse((await fs.readFile(path.join(root, 'conversation-submissions.jsonl'), 'utf8')).trim()).text).toBe(exact);
});

for (const checkpoint of ['conversation-before-dispatch', 'conversation-before-turn-start']) {
  test(`capacity evidence changed at ${checkpoint} preserves intent and never starts a model turn`, async () => {
    test.setTimeout(60000);
    await writeCapacity(capacityEvidence());
    await fs.writeFile(path.join(root, 'conversation-provider.json'), JSON.stringify({ reply: 'Authored synthetic forbidden stale-bound reply.' }));
    await prepareConversation();
    const exact = await page.getByLabel('Reviewed conversation package', { exact: true }).inputValue();
    await fs.writeFile(path.join(root, 'faults.json'), JSON.stringify({ pause: checkpoint }));
    await page.getByRole('button', { name: 'Send reviewed package', exact: true }).click();
    await expect.poll(() => fs.readFile(path.join(root, 'checkpoint.txt'), 'utf8').catch(() => '')).toBe(checkpoint);
    const changed = capacityEvidence(); changed.proofFingerprint = 'changed-during-preflight'; await writeCapacity(changed);
    await fs.writeFile(path.join(root, 'release.txt'), 'release controlled capacity preflight');
    await expect(page.locator('#conversation-history')).toContainText('failed');
    await expect(page.locator('#conversation-history')).toContainText(/changed|preview/i);
    const record = await onlyConversation(); expect(record.requests).toHaveLength(1);
    expect(record.requests[0].package.text).toBe(exact); expect(record.requests[0].reply).toBe('');
    await noSubmission();
    const rpc = await conversationRpc();
    expect(rpc.filter(call => call.method === 'turn/start')).toEqual([]);
    expect(rpc.filter(call => call.method === 'thread/start')).toHaveLength(checkpoint === 'conversation-before-turn-start' ? 1 : 0);
  });
}

test('returned model must match the reviewed capacity model before turn start', async () => {
  test.setTimeout(60000);
  await writeCapacity(capacityEvidence());
  await fs.writeFile(path.join(root, 'conversation-provider.json'), JSON.stringify({ model: 'unexpected-fixture-model', reply: 'Authored synthetic forbidden model reply.' }));
  await prepareConversation();
  await page.getByRole('button', { name: 'Send reviewed package', exact: true }).click();
  await expect(page.locator('#conversation-history')).toContainText('failed');
  await expect(page.locator('#conversation-history')).toContainText(/model changed|model.*preview/i);
  await noSubmission();
  const rpc = await conversationRpc(); expect(rpc.filter(call => call.method === 'thread/start')).toHaveLength(1);
  expect(rpc.filter(call => call.method === 'turn/start')).toEqual([]);
});

test('production conversation without verified capacity and isolation proof stays closed while capture works', async () => {
  test.setTimeout(60000);
  await prepareConversation({ COMPANION_TEST_REAL_PROVIDER_GUARD: '1' });
  await page.getByRole('button', { name: 'Send reviewed package', exact: true }).click();
  await expect(page.locator('#conversation-history')).toContainText('failed');
  await expect(page.locator('#conversation-history')).toContainText(/verified isolation.*capacity evidence/i);
  expect(await conversationRpc()).toEqual([]); await noSubmission();
  await page.getByLabel('Thought or link', { exact: true }).fill('Capture while production conversation evidence is unavailable.');
  await page.getByRole('button', { name: 'Save capture', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('Capture saved.');
  await expect(page.getByRole('heading', { name: 'Capture while production conversation evidence is unavailable.', exact: true })).toBeVisible();
});

for (const variant of ['matching updates', 'failed turn', 'unavailable']) {
  test(`observed turn usage stays scoped and truthful: ${variant}`, async () => {
    test.setTimeout(60000);
    const first = { total: { totalTokens: 43, inputTokens: 32, cachedInputTokens: 16, cacheWriteInputTokens: 4, outputTokens: 11, reasoningOutputTokens: 5 }, last: { totalTokens: 19, inputTokens: 15, cachedInputTokens: 7, cacheWriteInputTokens: 0, outputTokens: 4, reasoningOutputTokens: 2 }, modelContextWindow: 16384 };
    const observed = { total: { totalTokens: 137, inputTokens: 100, cachedInputTokens: 20, cacheWriteInputTokens: 5, outputTokens: 37, reasoningOutputTokens: 12 }, last: { totalTokens: 57, inputTokens: 40, cachedInputTokens: 10, cacheWriteInputTokens: 0, outputTokens: 17, reasoningOutputTokens: 4 }, modelContextWindow: 16384 };
    const malformed = { ...observed, total: { ...observed.total, totalTokens: 'not-a-counter' } };
    const usageUpdates = [
      { otherThread: true, tokenUsage: observed },
      ...(variant === 'unavailable' ? [] : [{ tokenUsage: first }, { tokenUsage: observed }]),
      { otherTurn: true, tokenUsage: first },
      { tokenUsage: malformed }
    ];
    await fs.writeFile(path.join(root, 'conversation-provider.json'), JSON.stringify({ reply: 'Authored synthetic observed-usage reply.', usageUpdates, ...(variant === 'failed turn' ? { turn: 'usage-limit' } : {}) }));
    await prepareConversation(); await observeConversation();
    await page.getByRole('button', { name: 'Send reviewed package', exact: true }).click();
    await expect(page.locator('#conversation-history')).toContainText('observed-usage reply');
    const files = await fs.readdir(path.join(root, 'conversations'));
    const historyFile = path.join(root, 'conversations', files.find(name => name.endsWith('.json')));
    const terminal = variant === 'failed turn' ? 'failed' : 'completed';
    await expect.poll(async () => JSON.parse(await fs.readFile(historyFile, 'utf8')).requests[0].status).toBe(terminal);
    const saved = JSON.parse(await fs.readFile(historyFile, 'utf8')), request = saved.requests[0];
    const report = JSON.parse(await fs.readFile(path.join(root, 'conversation-transport', 'readiness.json'), 'utf8'));
    if (variant === 'unavailable') {
      expect(request.usage).toBeNull(); expect(report.turns.at(-1).usage).toBeNull();
      expect(request.usageEvidence).toMatch(/unavailable|not provide|not observed/i);
    } else {
      expect(request.usage).toEqual(observed); expect(report.turns.at(-1).usage).toEqual(observed);
      expect(request.usageEvidence).toMatch(/observed/i); expect(request.usageEvidence).toMatch(/incomplete|not complete/i);
    }
    expect(report.ready).toBe(false);
    if (variant === 'failed turn') await expect(page.locator('#conversation-history')).toContainText('usage limit');
    await page.getByLabel('Context question', { exact: true }).fill('Keep character limits independent of observed token counters.');
    await page.getByRole('button', { name: 'Preview conversation', exact: true }).click();
    await expect(page.getByLabel('Reviewed conversation package', { exact: true })).toHaveValue(/Keep character limits independent/);
    await expect(page.locator('#conversation-summary')).toContainText('/ 32000 Unicode code points');
    await expect(page.locator('#conversation-summary')).toContainText('No verified provider input bound');
    const rpc = (await fs.readFile(path.join(root, 'codex-requests.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
    expect(rpc.filter(call => /account\//.test(call.method))).toEqual([]);
    const calls = await fs.readFile(path.join(root, 'conversation-submissions.jsonl'), 'utf8');
    expect(calls.trim().split('\n').filter(Boolean)).toHaveLength(1);
    await app.close(); app = null; await launch(false);
    await expect(page.locator('#conversation-history')).toContainText('observed-usage reply');
    expect(JSON.parse(await fs.readFile(historyFile, 'utf8')).requests[0].usage).toEqual(variant === 'unavailable' ? null : observed);
    expect(await fs.readFile(path.join(root, 'conversation-submissions.jsonl'), 'utf8')).toBe(calls);
  });
}
