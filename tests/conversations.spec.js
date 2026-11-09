const { test, expect, _electron: electron } = require('@playwright/test');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
let root, app, page;
let diagnostic, diagnosticWatcher, diagnosticReads = Promise.resolve(), diagnosticFiles = [];
test.beforeEach(async () => {
  diagnostic = false; diagnosticWatcher = null; diagnosticReads = Promise.resolve(); diagnosticFiles = [];
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'companion-conversation-'));
  await fs.writeFile(path.join(root, 'clock.json'), JSON.stringify({ now: '2026-11-08T12:00:00Z', timezone: 'America/Phoenix' }));
});
test.afterEach(async ({}, testInfo) => {
  diagnosticWatcher?.close(); await diagnosticReads;
  if (diagnostic && testInfo.status !== testInfo.expectedStatus) {
    const destination = testInfo.outputPath('conversation-state'); await fs.mkdir(destination, { recursive: true });
    const manifest = { title: testInfo.title, status: testInfo.status, wrapperPid: app?.process().pid, mainPid: app ? await app.evaluate(() => process.pid).catch(() => null) : null, testRoot: root, files: diagnosticFiles };
    manifest.visible = await page.evaluate(() => ({ timeline: window.__conversationDiagnostic || [], history: document.getElementById('conversation-history')?.textContent, error: document.getElementById('conversation-error')?.textContent, status: document.querySelector('[role="status"]')?.textContent })).catch(error => ({ unavailable: error.message }));
    const copy = async (name, target) => { try { await fs.copyFile(path.join(root, name), path.join(destination, target)); } catch (error) { if (error.code !== 'ENOENT') throw error; } };
    for (const name of ['conversation-provider.json', 'conversation-submissions.jsonl', 'codex-requests.jsonl', 'conversation-store-failures.jsonl', 'clock.json', 'faults.json', 'checkpoint.txt', 'release.txt']) await copy(name, name);
    await fs.mkdir(path.join(destination, 'conversations'));
    for (const name of await fs.readdir(path.join(root, 'conversations')).catch(() => [])) if (/^[a-f0-9-]{36}\.json$/.test(name)) await copy(path.join('conversations', name), path.join('conversations', name));
    await fs.writeFile(path.join(destination, 'observations.json'), JSON.stringify(manifest, null, 2));
    console.log(`Saved whitelisted conversation failure evidence: ${destination}`);
  }
  if (app) await app.close(); app = null; await fs.rm(root, { recursive: true, force: true });
});
async function observeConversation() {
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
  diagnosticWatcher = require('node:fs').watch(path.join(root, 'conversations'), (_, name) => {
    if (!/^[a-f0-9-]{36}\.json$/.test(String(name))) return;
    diagnosticReads = diagnosticReads.then(async () => {
      try { const record = JSON.parse(await fs.readFile(path.join(root, 'conversations', String(name)), 'utf8')); diagnosticFiles.push({ at: Date.now(), file: String(name), storageWarning: record.storageWarning, requests: record.requests.map(request => ({ id: request.id, status: request.status, error: request.error, replyLength: request.reply.length, messages: request.messages?.map(message => ({ id: message.id, completed: message.completed, length: message.text.length })) })) }); }
      catch (error) { diagnosticFiles.push({ at: Date.now(), file: String(name), error: error.code || error.message }); }
      if (diagnosticFiles.length > 128) diagnosticFiles.shift();
    });
  }).on('error', error => diagnosticFiles.push({ watcherError: error.code || error.message }));
}
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
  await app.close(); app = null; await launch(false);
  await expect(page.locator('#conversation-history')).toContainText('COMMENTARY_COMPLETE_CANARY');
  await expect(page.locator('#conversation-history')).toContainText('FINAL_COMPLETE_CANARY');
  await expect(page.locator('#conversation-history')).toContainText('UNKNOWN_PHASE_COMPLETE_CANARY');
  expect(await fs.readFile(path.join(root, 'conversation-submissions.jsonl'), 'utf8')).toBe(calls);
});
