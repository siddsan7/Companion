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
test('a history-directory junction cannot expose or change outside history and capture stays usable', async ({}, testInfo) => {
  test.setTimeout(90000);
  const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'companion-outside-history-'));
  const directory = path.join(root, 'conversations'), externalHistory = path.join(outside, 'history');
  let redirected = false;
  const snapshot = async () => Object.fromEntries(await Promise.all((await fs.readdir(externalHistory)).sort().map(async name => [name, await fs.readFile(path.join(externalHistory, name), 'utf8')])));
  try {
    await fs.writeFile(path.join(root, 'conversation-provider.json'), JSON.stringify({ reply: 'Authored synthetic OUTSIDE_HISTORY_PRIVATE_CANARY.' }), 'utf8');
    await prepareConversation();
    await page.getByRole('button', { name: 'Send reviewed package', exact: true }).click();
    await expect(page.locator('#conversation-history')).toContainText('OUTSIDE_HISTORY_PRIVATE_CANARY');
    await expect(page.locator('#conversation-history')).toContainText('completed');
    await app.close(); app = null;
    await fs.rename(directory, externalHistory);
    const before = await snapshot();
    const submissions = await fs.readFile(path.join(root, 'conversation-submissions.jsonl'), 'utf8');
    await fs.symlink(externalHistory, directory, process.platform === 'win32' ? 'junction' : 'dir'); redirected = true;
    await launch(false);
    await expect(page.getByRole('heading', { name: 'Spaced retrieval revisits a learned chord.', exact: true })).toBeVisible();
    await expect.soft(page.locator('#conversation-error')).toContainText(/ordinary|local history|directory|contained/i);
    await expect.soft(page.locator('#conversation-section')).not.toContainText('OUTSIDE_HISTORY_PRIVATE_CANARY');
    await expect.soft(page.getByLabel('Retained conversation', { exact: true }).locator('option')).toHaveCount(1);

    await page.getByRole('button', { name: 'New conversation', exact: true }).click();
    await page.getByLabel('Context question', { exact: true }).fill('How could spaced retrieval help MyTune without reading outside history?');
    await selectCapture();
    await page.getByRole('button', { name: 'Preview conversation', exact: true }).click();
    // A new draft can be reviewed without stored history; durable intent must still reject the alias.
    await expect.poll(async () => await page.getByRole('button', { name: 'Send reviewed package', exact: true }).isEnabled() || /ordinary|local history|directory|contained/i.test(await page.locator('#conversation-error').innerText())).toBe(true);
    if (await page.getByRole('button', { name: 'Send reviewed package', exact: true }).isEnabled()) {
      await page.getByRole('button', { name: 'Send reviewed package', exact: true }).click();
      await expect.soft(page.locator('#conversation-error')).toContainText(/ordinary|local history|directory|contained/i);
    }
    await expect.soft(page.getByLabel('Reviewed conversation package', { exact: true })).not.toHaveValue(/OUTSIDE_HISTORY_PRIVATE_CANARY/);
    await page.getByLabel('Thought or link', { exact: true }).fill('Capture remains usable when history is redirected.');
    await page.getByRole('button', { name: 'Save capture', exact: true }).click();
    await expect(page.getByRole('status')).toContainText('Capture saved.');
    await expect(page.getByRole('heading', { name: 'Capture remains usable when history is redirected.', exact: true })).toBeVisible();
    await app.close(); app = null;
    const after = await snapshot();
    await testInfo.attach('outside-history-boundary.json', { body: JSON.stringify({ before, after }, null, 2), contentType: 'application/json' });
    expect.soft(after).toEqual(before);
    expect.soft(await fs.readFile(path.join(root, 'conversation-submissions.jsonl'), 'utf8')).toBe(submissions);
  } finally {
    if (app) { await app.close(); app = null; }
    if (redirected) await fs.unlink(directory);
    await fs.rm(outside, { recursive: true, force: true });
  }
});

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

test('late completion of conversation A preserves the explicitly reviewed new conversation B draft', async () => {
  test.setTimeout(90000);
  await fs.writeFile(path.join(root, 'conversation-provider.json'), JSON.stringify({ holdCompletion: true, messages: [
    { delta: 'Authored synthetic A_PENDING_VIEW_CANARY.', text: 'Authored synthetic A_LATE_COMPLETION_CANARY.', phase: 'final_answer' }
  ] }));
  await prepareConversation();
  await page.getByRole('button', { name: 'Send reviewed package', exact: true }).click();
  await expect(page.locator('#conversation-history')).toContainText('A_PENDING_VIEW_CANARY');
  const a = await onlyConversation(); expect(a.requests[0].status).toBe('inProgress');
  await page.getByRole('button', { name: 'New conversation', exact: true }).click();
  await page.getByLabel('Conversation brief version', { exact: true }).fill('1');
  const questionB = 'B_DRAFT_VIEW_CANARY: what can spaced retrieval support independently?';
  await page.getByLabel('Context question', { exact: true }).fill(questionB); await selectCapture();
  await page.getByRole('button', { name: 'Preview conversation', exact: true }).click();
  await expect(page.getByLabel('Reviewed conversation package', { exact: true })).toHaveValue(/B_DRAFT_VIEW_CANARY/);
  const reviewedB = await page.getByLabel('Reviewed conversation package', { exact: true }).inputValue();
  expect(reviewedB).not.toMatch(/A_PENDING_VIEW_CANARY|A_LATE_COMPLETION_CANARY/);
  await expect(page.locator('#conversation-history article')).toHaveCount(0);
  await fs.writeFile(path.join(root, 'conversation-release.json'), '{}');
  await expect.poll(async () => (await onlyConversation()).requests[0].status).toBe('completed');
  // A normal capture round trip after terminal publication also lets queued renderer replies settle.
  await page.getByLabel('Thought or link', { exact: true }).fill('Capture after A completes while B remains a draft.');
  await page.getByRole('button', { name: 'Save capture', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('Capture saved.');
  await expect(page.getByLabel('Retained conversation', { exact: true })).toHaveValue('');
  await expect(page.getByLabel('Context question', { exact: true })).toHaveValue(questionB);
  await expect(page.getByLabel('Conversation brief version', { exact: true })).toHaveValue('1');
  await expect(page.getByLabel('Conversation brief version', { exact: true })).toBeEnabled();
  await expect(page.getByLabel('Reviewed conversation package', { exact: true })).toHaveValue(reviewedB);
  await expect(page.getByRole('button', { name: 'Send reviewed package', exact: true })).toBeEnabled();
  await expect(page.locator('#conversation-history article')).toHaveCount(0);
  const completedA = await onlyConversation(); expect(completedA.requests).toHaveLength(1);
  expect(completedA.requests[0].reply).toContain('A_LATE_COMPLETION_CANARY');
  expect((await fs.readFile(path.join(root, 'conversation-submissions.jsonl'), 'utf8')).trim().split('\n')).toHaveLength(1);
  await fs.writeFile(path.join(root, 'conversation-provider.json'), JSON.stringify({ reply: 'Authored synthetic B_REVIEWED_COMPLETION_CANARY.' }));
  await page.getByRole('button', { name: 'Send reviewed package', exact: true }).click();
  await expect(page.locator('#conversation-history')).toContainText('B_REVIEWED_COMPLETION_CANARY');
  await expect(page.locator('#conversation-history article').last()).toContainText('completed');
  await expect(page.locator('#conversation-history')).not.toContainText('A_LATE_COMPLETION_CANARY');
  const submissions = (await fs.readFile(path.join(root, 'conversation-submissions.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
  expect(submissions).toHaveLength(2); expect(submissions[1].text).toBe(reviewedB);
  expect(submissions[0].threadId).not.toBe(submissions[1].threadId);
  await page.getByLabel('Retained conversation', { exact: true }).selectOption(a.id);
  await expect(page.locator('#conversation-history')).toContainText('A_LATE_COMPLETION_CANARY');
  await expect(page.locator('#conversation-history')).not.toContainText('B_REVIEWED_COMPLETION_CANARY');
});

test('beyond-evidence speculation requires a fresh explicit review for permission and its removal', async () => {
  test.setTimeout(60000);
  await fs.writeFile(path.join(root, 'conversation-provider.json'), JSON.stringify({ reply: 'Authored synthetic Speculative: a rhythm reminder might help; selected evidence does not establish this transfer.' }));
  await prepareConversation();
  const permission = page.getByLabel('Allow beyond-evidence speculation', { exact: true });
  const reviewed = page.getByLabel('Reviewed conversation package', { exact: true });
  const send = page.getByRole('button', { name: 'Send reviewed package', exact: true });
  await expect(permission).not.toBeChecked();
  await expect(reviewed).toHaveValue(/Beyond-evidence speculation: Not permitted\./);
  await expect(send).toBeEnabled();
  await permission.check();
  await expect(send).toBeDisabled(); await expect(reviewed).toHaveValue('');
  await noSubmission();
  await page.getByRole('button', { name: 'Preview conversation', exact: true }).click();
  await expect(reviewed).toHaveValue(/Beyond-evidence speculation: Explicitly permitted; label every beyond-evidence suggestion Speculative and do not invent citations\./);
  await expect(send).toBeEnabled(); const allowed = await reviewed.inputValue();
  await send.click();
  await expect(page.locator('#conversation-history article').last()).toContainText('completed');
  await expect(page.locator('#conversation-history')).toContainText('Speculative: a rhythm reminder');
  const first = await onlyConversation();
  expect(first.requests).toHaveLength(1); expect(first.requests[0].speculation).toBe(true);
  expect(first.requests[0].package.speculation).toBe(true); expect(first.requests[0].package.text).toBe(allowed);
  await page.getByLabel('Context question', { exact: true }).fill('What limitations follow from the selected spaced retrieval evidence?');
  await page.getByRole('button', { name: 'Preview conversation', exact: true }).click();
  await expect(send).toBeEnabled(); await expect(reviewed).toHaveValue(/Beyond-evidence speculation: Explicitly permitted/);
  await permission.uncheck();
  await expect(send).toBeDisabled(); await expect(reviewed).toHaveValue('');
  expect((await fs.readFile(path.join(root, 'conversation-submissions.jsonl'), 'utf8')).trim().split('\n')).toHaveLength(1);
  await page.getByRole('button', { name: 'Preview conversation', exact: true }).click();
  await expect(reviewed).toHaveValue(/Beyond-evidence speculation: Not permitted\./);
  await expect(reviewed).not.toHaveValue(/Beyond-evidence speculation: Explicitly permitted/);
  await expect(send).toBeEnabled(); const disallowed = await reviewed.inputValue();
  await fs.writeFile(path.join(root, 'conversation-provider.json'), JSON.stringify({ reply: 'Authored synthetic No Supported Connection: the selected evidence does not establish this transfer mechanism.' }));
  await send.click();
  await expect(page.locator('#conversation-history article').last()).toContainText('completed');
  await expect(page.locator('#conversation-history')).toContainText('No Supported Connection');
  const saved = await onlyConversation(); expect(saved.requests).toHaveLength(2);
  expect(saved.requests[1].speculation).toBe(false); expect(saved.requests[1].package.speculation).toBe(false);
  expect(saved.requests[1].package.text).toBe(disallowed);
  expect(saved.requests[0].speculation).toBe(true); expect(saved.requests[0].reply).toContain('Speculative:');
  const submissions = (await fs.readFile(path.join(root, 'conversation-submissions.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
  expect(submissions.map(call => call.text)).toEqual([allowed, disallowed]);
});

test('producer rejection excludes directly and transitively derived dialogue while independent selected evidence remains usable', async () => {
  test.setTimeout(90000);
  const producer = path.join(root, 'producer');
  await fs.cp(path.join(__dirname, 'fixtures/reel-review/accept'), path.join(producer, 'accept'), { recursive: true });
  await fs.writeFile(path.join(root, 'conversation-provider.json'), JSON.stringify({ reply: 'Authored synthetic REJECT_DIRECT_REPLY_CANARY based on both selected sources.' }));
  await prepareConversation();
  await page.getByLabel('Finalized review folder', { exact: true }).fill(producer);
  await page.getByRole('button', { name: 'Connect finalized reviews', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('Source connected');
  const check = async instant => {
    await fs.writeFile(path.join(root, 'clock.json'), JSON.stringify({ now: instant, timezone: 'America/Phoenix' }));
    await page.getByRole('button', { name: 'Check now', exact: true }).click();
    await expect(page.locator('#intake-state')).toContainText(`Last check: ${instant} · manual · complete`);
  };
  await check('2026-11-08T12:00:01Z');
  await page.getByLabel('Context question', { exact: true }).fill('How could synthetic review and spaced retrieval inform MyTune?');
  await page.getByRole('button', { name: 'Find context', exact: true }).click();
  await page.locator('#context-results article').filter({ hasText: 'Human review: accept' }).getByRole('button', { name: 'Add to context', exact: true }).click();
  await page.getByRole('button', { name: 'Preview conversation', exact: true }).click();
  await expect(page.getByLabel('Reviewed conversation package', { exact: true })).toHaveValue(/Authored synthetic review fixture only\./);
  await expect(page.getByLabel('Reviewed conversation package', { exact: true })).toHaveValue(/Spaced retrieval revisits/);
  await page.getByRole('button', { name: 'Send reviewed package', exact: true }).click();
  await expect(page.locator('#conversation-history article').last()).toContainText('completed');
  const first = await onlyConversation();
  expect(first.requests[0].package.dependencies.filter(dep => dep.key.startsWith('capture:'))).toHaveLength(2);
  const independent = first.requests[0].package.dependencies.find(dep => dep.key.startsWith('capture:') && !dep.revisionId);
  expect(independent).toBeTruthy();
  await app.close(); app = null; await launch(false);
  await expect(page.locator('#conversation-history')).toContainText('REJECT_DIRECT_REPLY_CANARY');
  await page.getByLabel('Context question', { exact: true }).fill('What limitations follow from that prior reasoning?');
  await page.getByRole('button', { name: 'Preview conversation', exact: true }).click();
  await expect(page.getByLabel('Reviewed conversation package', { exact: true })).toHaveValue(/REJECT_DIRECT_REPLY_CANARY/);
  await fs.writeFile(path.join(root, 'conversation-provider.json'), JSON.stringify({ reply: 'Authored synthetic REJECT_TRANSITIVE_REPLY_CANARY based on the included dialogue.' }));
  await page.getByRole('button', { name: 'Send reviewed package', exact: true }).click();
  await expect(page.locator('#conversation-history article').last()).toContainText('completed');
  await expect(page.locator('#conversation-history')).toContainText('REJECT_TRANSITIVE_REPLY_CANARY');
  await fs.cp(path.join(__dirname, 'fixtures/reel-review/reject'), path.join(producer, 'reject'), { recursive: true });
  await check('2026-11-08T12:00:02Z');
  await page.getByRole('button', { name: 'Inspect source', exact: true }).click();
  await page.getByLabel('Source inspection').locator('article').filter({ hasText: 'Human review: reject' }).getByRole('button', { name: 'Make current', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('Current revision selected');
  await page.getByLabel('Context question', { exact: true }).fill('What does independent spaced retrieval evidence support for MyTune?');
  await selectCapture();
  await page.getByRole('button', { name: 'Preview conversation', exact: true }).click();
  const reviewed = page.getByLabel('Reviewed conversation package', { exact: true });
  await expect(reviewed).toHaveValue(/Spaced retrieval revisits/);
  await expect(reviewed).not.toHaveValue(/Authored synthetic review fixture only\.|REJECT_DIRECT_REPLY_CANARY|REJECT_TRANSITIVE_REPLY_CANARY/);
  await expect(page.locator('#conversation-summary')).toContainText(/rejected|unavailable/);
  await expect(page.locator('#conversation-history .history-exclusion')).toHaveCount(2);
  await expect(page.locator('#conversation-history')).toContainText('REJECT_DIRECT_REPLY_CANARY');
  await expect(page.locator('#conversation-history')).toContainText('REJECT_TRANSITIVE_REPLY_CANARY');
  const exact = await reviewed.inputValue();
  await fs.writeFile(path.join(root, 'conversation-provider.json'), JSON.stringify({ reply: 'Authored synthetic independent evidence remains usable after producer rejection.' }));
  await page.getByRole('button', { name: 'Send reviewed package', exact: true }).click();
  await expect(page.locator('#conversation-history')).toContainText('independent evidence remains usable after producer rejection.');
  await expect(page.locator('#conversation-history article')).toHaveCount(3);
  await expect(page.locator('#conversation-history article').last()).toContainText('completed');
  const saved = await onlyConversation();
  expect(saved.requests[1].package.historyIds).toEqual([saved.requests[0].id]);
  expect(saved.requests[2].package.historyIds).toEqual([]);
  expect(saved.requests[2].package.dependencies.filter(dep => dep.key.startsWith('capture:'))).toEqual([independent]);
  const submissions = (await fs.readFile(path.join(root, 'conversation-submissions.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
  expect(submissions).toHaveLength(3); expect(submissions[1].text).toContain('REJECT_DIRECT_REPLY_CANARY');
  expect(submissions[2].text).toBe(exact); expect(submissions[2].text).not.toMatch(/Authored synthetic review fixture only\.|REJECT_DIRECT_REPLY_CANARY|REJECT_TRANSITIVE_REPLY_CANARY/);
  await page.getByLabel('Thought or link', { exact: true }).fill('Capture remains usable after producer rejection.');
  await page.getByRole('button', { name: 'Save capture', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('Capture saved.');
});

test('unknown historical source attribution excludes that reply and its derivative without hiding retained text', async () => {
  test.setTimeout(90000);
  await fs.writeFile(path.join(root, 'conversation-provider.json'), JSON.stringify({ reply: 'Authored synthetic UNKNOWN_ATTRIBUTION_REPLY_CANARY.' }));
  await prepareConversation();
  await page.getByRole('button', { name: 'Send reviewed package', exact: true }).click();
  await expect(page.locator('#conversation-history')).toContainText('UNKNOWN_ATTRIBUTION_REPLY_CANARY');
  await expect(page.locator('#conversation-history article').last()).toContainText('completed');
  await app.close(); app = null; await launch(false);
  await expect(page.locator('#conversation-history')).toContainText('UNKNOWN_ATTRIBUTION_REPLY_CANARY');
  await page.getByLabel('Context question', { exact: true }).fill('What limitations follow from the prior dialogue?');
  await page.getByRole('button', { name: 'Preview conversation', exact: true }).click();
  await expect(page.getByLabel('Reviewed conversation package', { exact: true })).toHaveValue(/UNKNOWN_ATTRIBUTION_REPLY_CANARY/);
  await fs.writeFile(path.join(root, 'conversation-provider.json'), JSON.stringify({ reply: 'Authored synthetic UNKNOWN_DERIVATIVE_REPLY_CANARY based on the included reply.' }));
  await page.getByRole('button', { name: 'Send reviewed package', exact: true }).click();
  await expect(page.locator('#conversation-history')).toContainText('UNKNOWN_DERIVATIVE_REPLY_CANARY');
  await expect(page.locator('#conversation-history article')).toHaveCount(2);
  await expect(page.locator('#conversation-history article').last()).toContainText('completed');
  const before = await onlyConversation();
  expect(before.requests[1].package.historyIds).toEqual([before.requests[0].id]);
  const callsBefore = await fs.readFile(path.join(root, 'conversation-submissions.jsonl'), 'utf8');
  await app.close(); app = null;
  // External corruption at the accepted files seam: leave original text intact, lose attribution.
  const damaged = structuredClone(before); delete damaged.requests[0].package.dependencies;
  await fs.writeFile(path.join(root, 'conversations', `${damaged.id}.json`), JSON.stringify(damaged, null, 2));
  await launch(false);
  await expect(page.locator('#conversation-history')).toContainText('UNKNOWN_ATTRIBUTION_REPLY_CANARY');
  await expect(page.locator('#conversation-history')).toContainText('UNKNOWN_DERIVATIVE_REPLY_CANARY');
  expect(await fs.readFile(path.join(root, 'conversation-submissions.jsonl'), 'utf8')).toBe(callsBefore);
  await page.getByLabel('Context question', { exact: true }).fill('What can selected spaced retrieval evidence support without earlier dialogue?');
  await selectCapture();
  await page.getByRole('button', { name: 'Preview conversation', exact: true }).click();
  const reviewed = page.getByLabel('Reviewed conversation package', { exact: true });
  await expect(reviewed).toHaveValue(/Spaced retrieval revisits/);
  await expect(reviewed).not.toHaveValue(/UNKNOWN_ATTRIBUTION_REPLY_CANARY|UNKNOWN_DERIVATIVE_REPLY_CANARY/);
  await expect(page.locator('#conversation-summary')).toContainText('unknown');
  await expect(page.locator('#conversation-history .history-exclusion')).toHaveCount(2);
  const inspect = page.getByLabel('Saved approved context', { exact: true });
  await expect(inspect.nth(0)).toHaveValue(before.requests[0].package.text);
  await expect(inspect.nth(1)).toHaveValue(before.requests[1].package.text);
  const exact = await reviewed.inputValue();
  await fs.writeFile(path.join(root, 'conversation-provider.json'), JSON.stringify({ reply: 'Authored synthetic KNOWN_SELECTED_EVIDENCE_REPLY_CANARY.' }));
  await page.getByRole('button', { name: 'Send reviewed package', exact: true }).click();
  await expect(page.locator('#conversation-history')).toContainText('KNOWN_SELECTED_EVIDENCE_REPLY_CANARY');
  await expect(page.locator('#conversation-history article')).toHaveCount(3);
  await expect(page.locator('#conversation-history article').last()).toContainText('completed');
  const saved = await onlyConversation(); expect(saved.requests[2].package.historyIds).toEqual([]);
  expect(saved.requests[0].reply).toBe(before.requests[0].reply); expect(saved.requests[1].reply).toBe(before.requests[1].reply);
  expect(saved.requests[0].package.text).toBe(before.requests[0].package.text); expect(saved.requests[1].package.text).toBe(before.requests[1].package.text);
  const submissions = (await fs.readFile(path.join(root, 'conversation-submissions.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
  expect(submissions).toHaveLength(3); expect(submissions[2].text).toBe(exact);
  expect(submissions[2].text).not.toMatch(/UNKNOWN_ATTRIBUTION_REPLY_CANARY|UNKNOWN_DERIVATIVE_REPLY_CANARY/);
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

test('prior conversation search is opt-in and selected excerpts are labelled historical dialogue in the exact new package', async () => {
  test.setTimeout(90000);
  const canary = 'HISTORICAL_DIALOGUE_12_CANARY';
  await fs.writeFile(path.join(root, 'conversation-provider.json'), JSON.stringify({ reply: `Authored synthetic ${canary}: revisit one chord after a delay; this is an unverified transfer.` }), 'utf8');
  await prepareConversation();
  await page.getByRole('button', { name: 'Send reviewed package', exact: true }).click();
  await expect(page.locator('#conversation-history')).toContainText(canary);
  await expect(page.locator('#conversation-history')).toContainText('completed');
  const originals = await fs.readdir(path.join(root, 'conversations'));
  const originalFile = originals.find(name => /^[a-f0-9-]{36}\.json$/.test(name));
  const original = JSON.parse(await fs.readFile(path.join(root, 'conversations', originalFile), 'utf8'));

  await page.getByRole('button', { name: 'New conversation', exact: true }).click();
  await page.getByLabel('Context question', { exact: true }).fill(`What did we previously discuss about ${canary}?`);
  await page.getByRole('button', { name: 'Find context', exact: true }).click();
  await expect(page.locator('#context-results')).not.toContainText('unverified transfer');
  await page.getByRole('button', { name: 'Preview conversation', exact: true }).click();
  await expect(page.getByLabel('Reviewed conversation package', { exact: true })).toHaveValue(/What did we previously discuss/);
  await expect(page.getByLabel('Reviewed conversation package', { exact: true })).not.toHaveValue(/revisit one chord after a delay/);

  await page.getByRole('button', { name: 'Search prior conversations', exact: true }).click();
  const excerpt = page.getByRole('region', { name: 'Prior conversation search', exact: true }).getByRole('article').filter({ hasText: canary });
  await expect(excerpt).toHaveCount(1);
  await expect(excerpt).toContainText('Historical dialogue');
  await expect(excerpt).toContainText('unverified transfer');
  await excerpt.getByRole('button', { name: 'Add historical dialogue', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Send reviewed package', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: 'Preview conversation', exact: true }).click();
  await expect(page.getByLabel('Reviewed conversation package', { exact: true })).toHaveValue(/revisit one chord after a delay/);
  const reviewed = await page.getByLabel('Reviewed conversation package', { exact: true }).inputValue();
  expect(reviewed).toContain('Historical dialogue');
  expect(reviewed).toContain(original.id);
  expect(reviewed).toContain(original.requests[0].id);
  await fs.writeFile(path.join(root, 'conversation-provider.json'), JSON.stringify({ reply: 'Authored synthetic selected historical dialogue reply.' }), 'utf8');
  await page.getByRole('button', { name: 'Send reviewed package', exact: true }).click();
  await expect(page.locator('#conversation-history')).toContainText('selected historical dialogue reply.');
  await expect(page.locator('#conversation-history')).toContainText('completed');

  const submissions = (await fs.readFile(path.join(root, 'conversation-submissions.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
  expect(submissions).toHaveLength(2);
  expect(submissions[1].text).toBe(reviewed);
  expect(submissions[1].threadId).not.toBe(submissions[0].threadId);
  const records = await Promise.all((await fs.readdir(path.join(root, 'conversations'))).filter(name => /^[a-f0-9-]{36}\.json$/.test(name)).map(async name => JSON.parse(await fs.readFile(path.join(root, 'conversations', name), 'utf8'))));
  expect(records).toHaveLength(2);
  const saved = records.find(record => record.id !== original.id).requests[0].package;
  expect(saved.text).toBe(reviewed);
  expect(saved.count).toBe([...reviewed].length);
  expect(saved.historyRefs).toEqual([expect.objectContaining({ conversationId: original.id, requestId: original.requests[0].id })]);
  for (const dependency of original.requests[0].package.dependencies) expect(saved.dependencies).toContainEqual(dependency);
  expect(await fs.readdir(path.join(root, 'vault', 'Companion', 'Ideas'))).toEqual([]);
  await page.getByRole('button', { name: 'New conversation', exact: true }).click();
  await page.getByLabel('Context question', { exact: true }).fill('Use only current project context.');
  await page.getByRole('button', { name: 'Preview conversation', exact: true }).click();
  await expect(page.getByLabel('Reviewed conversation package', { exact: true })).toHaveValue(/Use only current project context/);
  await expect(page.getByLabel('Reviewed conversation package', { exact: true })).not.toHaveValue(/HISTORICAL_DIALOGUE_12_CANARY|revisit one chord after a delay/);
});

test('omitting prior dialogue retains dependency authority without resending unselected raw ancestor text', async () => {
  test.setTimeout(120000);
  const ancestor = 'RAW_ANCESTOR_ONLY_12_CANARY', derived = 'DERIVED_REPLY_ONLY_12_CANARY';
  await fs.writeFile(path.join(root, 'conversation-provider.json'), JSON.stringify({ reply: `Authored synthetic ${ancestor}: a private prior-dialogue detail.` }), 'utf8');
  await prepareConversation();
  await page.getByRole('button', { name: 'Send reviewed package', exact: true }).click();
  await expect(page.locator('#conversation-history')).toContainText('completed');
  await expect(page.locator('#conversation-history')).toContainText(ancestor);
  const firstName = (await fs.readdir(path.join(root, 'conversations'))).find(name => /^[a-f0-9-]{36}\.json$/.test(name));
  const first = JSON.parse(await fs.readFile(path.join(root, 'conversations', firstName), 'utf8'));

  await page.getByRole('button', { name: 'New conversation', exact: true }).click();
  await page.getByLabel('Context question', { exact: true }).fill(`Consider the historical discussion ${ancestor}.`);
  await page.getByRole('button', { name: 'Search prior conversations', exact: true }).click();
  await page.getByRole('region', { name: 'Prior conversation search', exact: true }).getByRole('article').filter({ hasText: ancestor }).getByRole('button', { name: 'Add historical dialogue', exact: true }).click();
  await page.getByLabel('Context question', { exact: true }).fill('Apply the selected historical discussion to a controlled test.');
  await page.getByRole('button', { name: 'Preview conversation', exact: true }).click();
  await expect(page.getByLabel('Reviewed conversation package', { exact: true })).toHaveValue(/a private prior-dialogue detail/);
  await fs.writeFile(path.join(root, 'conversation-provider.json'), JSON.stringify({ reply: `Authored synthetic ${derived}: the proposed application needs a controlled test.` }), 'utf8');
  await page.getByRole('button', { name: 'Send reviewed package', exact: true }).click();
  await expect(page.locator('#conversation-history')).toContainText(derived);
  await expect(page.locator('#conversation-history')).toContainText('completed');

  // A fresh request allows B's own dialogue after explicitly removing raw A.
  await page.getByRole('button', { name: 'Remove historical dialogue', exact: true }).click();
  await page.getByLabel('Context question', { exact: true }).fill('Continue with the proposed controlled test.');
  await page.getByRole('button', { name: 'Preview conversation', exact: true }).click();
  await expect(page.getByLabel('Reviewed conversation package', { exact: true })).toHaveValue(/the proposed application needs a controlled test/);
  await expect(page.getByLabel('Reviewed conversation package', { exact: true })).not.toHaveValue(/RAW_ANCESTOR_ONLY_12_CANARY|a private prior-dialogue detail/);
  await fs.writeFile(path.join(root, 'conversation-provider.json'), JSON.stringify({ reply: 'Authored synthetic continuing the controlled test without quoting its ancestor.' }), 'utf8');
  await page.getByRole('button', { name: 'Send reviewed package', exact: true }).click();
  await expect(page.locator('#conversation-history')).toContainText('continuing the controlled test without quoting its ancestor');
  const records = await Promise.all((await fs.readdir(path.join(root, 'conversations'))).filter(name => /^[a-f0-9-]{36}\.json$/.test(name)).map(async name => JSON.parse(await fs.readFile(path.join(root, 'conversations', name), 'utf8'))));
  const second = records.find(record => record.id !== first.id);
  expect(second.requests).toHaveLength(2);
  expect(second.requests[1].package.historyRefs).toContainEqual(expect.objectContaining({ conversationId: first.id, requestId: first.requests[0].id }));
  for (const dependency of first.requests[0].package.dependencies) expect(second.requests[1].package.dependencies).toContainEqual(dependency);
  expect(second.requests[1].package.text).not.toContain('a private prior-dialogue detail');

  // Explicitly selecting derived B in C permits B's actual turn, not its unselected raw ancestry.
  await page.getByRole('button', { name: 'New conversation', exact: true }).click();
  await page.getByLabel('Context question', { exact: true }).fill(`Inspect ${derived}.`);
  await page.getByRole('button', { name: 'Search prior conversations', exact: true }).click();
  const result = page.getByRole('region', { name: 'Prior conversation search', exact: true }).getByRole('article').filter({ hasText: derived });
  await expect(result).toHaveCount(1);
  await result.getByRole('button', { name: 'Add historical dialogue', exact: true }).click();
  await page.getByRole('button', { name: 'Preview conversation', exact: true }).click();
  await expect(page.getByLabel('Reviewed conversation package', { exact: true })).toHaveValue(/the proposed application needs a controlled test/);
  await expect(page.getByLabel('Reviewed conversation package', { exact: true })).not.toHaveValue(/RAW_ANCESTOR_ONLY_12_CANARY|a private prior-dialogue detail/);
  expect((await page.getByLabel('Reviewed conversation package', { exact: true }).inputValue())).toContain(first.id);
});

test('foreign history revocation invalidates stale reviewed selections and asynchronous dispatch while retaining independent writing', async () => {
  test.setTimeout(180000);
  const ancestor = 'REVOCATION_ANCESTOR_12_CANARY', derived = 'REVOCATION_DERIVED_12_CANARY';
  await fs.writeFile(path.join(root, 'conversation-provider.json'), JSON.stringify({ reply: `Authored synthetic ${ancestor}: a retained historical mechanism.` }), 'utf8');
  await prepareConversation();
  await page.getByRole('button', { name: 'Send reviewed package', exact: true }).click();
  await expect(page.locator('#conversation-history')).toContainText(ancestor);
  await expect(page.locator('#conversation-history')).toContainText('completed');
  const firstName = (await fs.readdir(path.join(root, 'conversations'))).find(name => /^[a-f0-9-]{36}\.json$/.test(name));
  const original = JSON.parse(await fs.readFile(path.join(root, 'conversations', firstName), 'utf8'));
  const captures = path.join(root, 'vault', 'Companion', 'Captures');
  const capture = path.join(captures, (await fs.readdir(captures)).find(name => name.endsWith('.md')));
  const sourceBytes = await fs.readFile(capture, 'utf8');

  await page.getByRole('button', { name: 'New conversation', exact: true }).click();
  await page.getByLabel('Context question', { exact: true }).fill(ancestor);
  await page.getByRole('button', { name: 'Search prior conversations', exact: true }).click();
  await page.getByRole('region', { name: 'Prior conversation search', exact: true }).getByRole('article').filter({ hasText: ancestor }).getByRole('button', { name: 'Add historical dialogue', exact: true }).click();
  await page.getByLabel('Context question', { exact: true }).fill('Use the selected discussion to propose a cautious application.');
  await page.getByRole('button', { name: 'Preview conversation', exact: true }).click();
  await expect(page.getByLabel('Reviewed conversation package', { exact: true })).toHaveValue(/REVOCATION_ANCESTOR_12_CANARY/);
  await fs.writeFile(path.join(root, 'conversation-provider.json'), JSON.stringify({ reply: `Authored synthetic ${derived}: an unverified application with a small test.` }), 'utf8');
  await page.getByRole('button', { name: 'Send reviewed package', exact: true }).click();
  await expect(page.locator('#conversation-history')).toContainText(derived);
  await expect(page.locator('#conversation-history')).toContainText('completed');
  const secondName = (await fs.readdir(path.join(root, 'conversations'))).find(name => /^[a-f0-9-]{36}\.json$/.test(name) && name !== firstName);
  const second = JSON.parse(await fs.readFile(path.join(root, 'conversations', secondName), 'utf8'));
  await page.getByRole('button', { name: 'Draft saved idea', exact: true }).click();
  await page.getByLabel('Idea title', { exact: true }).fill('Independent writing survives history revocation');
  await page.getByLabel('Idea explanation', { exact: true }).fill('The user retains this interpretation independently of conversation history.');
  await page.getByLabel('Idea limitations', { exact: true }).fill('The transfer is unverified and no outcome was measured.');
  await page.getByRole('button', { name: 'Preview saved idea', exact: true }).click();
  await expect(page.getByLabel('Proposed idea Markdown', { exact: true })).toHaveValue(/Independent writing survives/);
  const ideaFile = await page.getByLabel('Proposed idea destination', { exact: true }).inputValue();
  await page.getByRole('button', { name: 'Confirm saved idea', exact: true }).click();
  await expect(page.locator('#idea-status')).toContainText('Saved idea');
  const ideaBytes = await fs.readFile(ideaFile, 'utf8');
  const calls = await fs.readFile(path.join(root, 'conversation-submissions.jsonl'), 'utf8');

  await page.getByRole('button', { name: 'New conversation', exact: true }).click();
  await page.getByLabel('Context question', { exact: true }).fill(derived);
  await page.getByRole('button', { name: 'Search prior conversations', exact: true }).click();
  await page.getByRole('region', { name: 'Prior conversation search', exact: true }).getByRole('article').filter({ hasText: derived }).getByRole('button', { name: 'Add historical dialogue', exact: true }).click();
  await page.getByLabel('Context question', { exact: true }).fill('Inspect the selected application and its limitations.');
  await page.getByRole('button', { name: 'Preview conversation', exact: true }).click();
  await expect(page.getByLabel('Reviewed conversation package', { exact: true })).toHaveValue(/REVOCATION_DERIVED_12_CANARY/);
  const otherApp = await electron.launch({ args: ['.'], env: { ...process.env, COMPANION_TEST_ROOT: root } });
  try {
    const other = await otherApp.firstWindow();
    await expect(other.locator('#timezone')).toContainText('America/Phoenix');
    await other.getByLabel('Retained conversation', { exact: true }).selectOption(original.id);
    await expect(other.locator('#conversation-history')).toContainText(ancestor);
    await other.locator('#conversation-history article').first().getByRole('checkbox', { name: 'Include request in next context', exact: true }).uncheck();
    await other.getByLabel('Context question', { exact: true }).fill('Exclude the original historical turn from future context.');
    await other.getByRole('button', { name: 'Preview conversation', exact: true }).click();
    await expect(other.getByLabel('Reviewed conversation package', { exact: true })).toHaveValue(/Exclude the original historical turn/);
    await expect(other.getByLabel('Reviewed conversation package', { exact: true })).not.toHaveValue(/REVOCATION_ANCESTOR_12_CANARY/);
    await page.getByRole('button', { name: 'Send reviewed package', exact: true }).click();
    await expect(page.locator('#conversation-error')).toContainText(/historical|changed|preview/i);
    expect(await fs.readFile(path.join(root, 'conversation-submissions.jsonl'), 'utf8')).toBe(calls);
    await page.getByRole('button', { name: 'Preview conversation', exact: true }).click();
    await expect(page.locator('#conversation-error')).toContainText(/historical|changed|unavailable/i);
    await page.getByRole('button', { name: 'Remove historical dialogue', exact: true }).click();
    await page.getByRole('button', { name: 'Preview conversation', exact: true }).click();
    await expect(page.getByLabel('Reviewed conversation package', { exact: true })).toHaveValue(/Inspect the selected application/);
    await expect(page.getByLabel('Reviewed conversation package', { exact: true })).not.toHaveValue(/REVOCATION_ANCESTOR_12_CANARY|REVOCATION_DERIVED_12_CANARY/);

    await other.getByLabel('Retained conversation', { exact: true }).selectOption(second.id);
    await expect(other.locator('#conversation-history')).toContainText(derived);
    await other.getByLabel('Context question', { exact: true }).fill('Continue using only currently eligible project context.');
    await other.getByRole('button', { name: 'Preview conversation', exact: true }).click();
    await expect(other.getByLabel('Reviewed conversation package', { exact: true })).toHaveValue(/currently eligible project context/);
    await expect(other.getByLabel('Reviewed conversation package', { exact: true })).not.toHaveValue(/REVOCATION_ANCESTOR_12_CANARY|REVOCATION_DERIVED_12_CANARY/);
    await expect(other.locator('#conversation-history .history-exclusion')).toContainText(/Excluded from next request/);
    await expect(other.locator('#conversation-history')).toContainText(derived);
    expect(await fs.readFile(capture, 'utf8')).toBe(sourceBytes);
    expect(await fs.readFile(ideaFile, 'utf8')).toBe(ideaBytes);

    // Restore A through its explicit UI, then make a fresh direct selection for the async boundary.
    await other.getByLabel('Retained conversation', { exact: true }).selectOption(original.id);
    await other.locator('#conversation-history article').first().getByRole('checkbox', { name: 'Include request in next context', exact: true }).check();
    await other.getByLabel('Context question', { exact: true }).fill('Explicitly restore the original historical turn.');
    await other.getByRole('button', { name: 'Preview conversation', exact: true }).click();
    await expect(other.getByLabel('Reviewed conversation package', { exact: true })).toHaveValue(/REVOCATION_ANCESTOR_12_CANARY/);
  } finally { await otherApp.close(); }

  await page.getByLabel('Context question', { exact: true }).fill(ancestor);
  await page.getByRole('button', { name: 'Search prior conversations', exact: true }).click();
  await page.getByRole('region', { name: 'Prior conversation search', exact: true }).getByRole('article').filter({ hasText: ancestor }).getByRole('button', { name: 'Add historical dialogue', exact: true }).click();
  await page.getByLabel('Context question', { exact: true }).fill('Review the freshly selected original discussion.');
  await page.getByRole('button', { name: 'Preview conversation', exact: true }).click();
  await expect(page.getByLabel('Reviewed conversation package', { exact: true })).toHaveValue(/REVOCATION_ANCESTOR_12_CANARY/);
  await fs.writeFile(path.join(root, 'faults.json'), JSON.stringify({ pause: 'conversation-before-turn-start' }), 'utf8');
  await page.getByRole('button', { name: 'Send reviewed package', exact: true }).click();
  await expect.poll(() => fs.readFile(path.join(root, 'checkpoint.txt'), 'utf8').catch(() => '')).toBe('conversation-before-turn-start');
  const editedSource = `${sourceBytes}\nEXPLICIT_SOURCE_EDIT_DURING_FOREIGN_PREFLIGHT\n`;
  await fs.writeFile(capture, editedSource, 'utf8');
  await fs.writeFile(path.join(root, 'release.txt'), 'release controlled historical preflight', 'utf8');
  await expect(page.locator('#conversation-history')).toContainText('failed');
  await expect(page.locator('#conversation-history')).toContainText(/changed|unavailable/i);
  expect(await fs.readFile(path.join(root, 'conversation-submissions.jsonl'), 'utf8')).toBe(calls);
  const rpc = (await fs.readFile(path.join(root, 'codex-requests.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
  expect(rpc.filter(call => call.method === 'turn/start')).toHaveLength(2);
  expect(await fs.readFile(capture, 'utf8')).toBe(editedSource);
  expect(await fs.readFile(ideaFile, 'utf8')).toBe(ideaBytes);
  await page.getByRole('button', { name: 'Remove historical dialogue', exact: true }).click();
  await page.getByLabel('Context question', { exact: true }).fill('Continue after source change using project context alone.');
  await page.getByRole('button', { name: 'Preview conversation', exact: true }).click();
  await expect(page.getByLabel('Reviewed conversation package', { exact: true })).toHaveValue(/project context alone/);
  await expect(page.getByLabel('Reviewed conversation package', { exact: true })).not.toHaveValue(/REVOCATION_ANCESTOR_12_CANARY|REVOCATION_DERIVED_12_CANARY/);
});

test('transcript export is explicitly previewed and cancelled before exact readable publication at the chosen vault destination', async () => {
  test.setTimeout(150000);
  await fs.writeFile(path.join(root, 'conversation-provider.json'), JSON.stringify({ reply: 'TRANSCRIPT_FOREIGN_ORIGIN_12: authored synthetic earlier discussion.' }), 'utf8');
  await prepareConversation();
  await page.getByRole('button', { name: 'Send reviewed package', exact: true }).click();
  await expect(page.locator('#conversation-history')).toContainText('TRANSCRIPT_FOREIGN_ORIGIN_12');
  await expect(page.locator('#conversation-history')).toContainText('completed');
  const originName = (await fs.readdir(path.join(root, 'conversations'))).find(name => /^[a-f0-9-]{36}\.json$/.test(name));
  const origin = JSON.parse(await fs.readFile(path.join(root, 'conversations', originName), 'utf8'));
  await page.getByRole('button', { name: 'New conversation', exact: true }).click();
  await page.getByLabel('Context question', { exact: true }).fill('TRANSCRIPT_FOREIGN_ORIGIN_12');
  await page.getByRole('button', { name: 'Search prior conversations', exact: true }).click();
  await page.getByRole('region', { name: 'Prior conversation search', exact: true }).getByRole('article').filter({ hasText: 'TRANSCRIPT_FOREIGN_ORIGIN_12' }).getByRole('button', { name: 'Add historical dialogue', exact: true }).click();
  await page.getByLabel('Context question', { exact: true }).fill('Retain a careful account of this selected historical discussion.');
  await page.getByRole('button', { name: 'Preview conversation', exact: true }).click();
  await expect(page.getByLabel('Reviewed conversation package', { exact: true })).toHaveValue(/TRANSCRIPT_FOREIGN_ORIGIN_12/);
  const messages = [
    { phase: 'commentary', text: 'TRANSCRIPT_COMMENTARY_12: the mechanism needs checking.' },
    { phase: 'final_answer', text: 'TRANSCRIPT_FINAL_12: a hypothesis with limitations and an observable test.' },
    { phase: null, text: 'TRANSCRIPT_UNKNOWN_PHASE_12: retained legacy assistant writing.' }
  ];
  await fs.writeFile(path.join(root, 'conversation-provider.json'), JSON.stringify({ messages }), 'utf8');
  await page.getByRole('button', { name: 'Send reviewed package', exact: true }).click();
  await expect(page.locator('#conversation-history')).toContainText('TRANSCRIPT_UNKNOWN_PHASE_12');
  await expect(page.locator('#conversation-history')).toContainText('completed');
  await page.getByRole('button', { name: 'Draft saved idea', exact: true }).click();
  await page.getByLabel('Idea title', { exact: true }).fill('Independent idea beside the transcript');
  await page.getByLabel('Idea explanation', { exact: true }).fill('Keep this author interpretation separate from the exported conversation.');
  await page.getByLabel('Idea limitations', { exact: true }).fill('No outcome was verified.');
  await page.getByRole('button', { name: 'Preview saved idea', exact: true }).click();
  await expect(page.getByLabel('Proposed idea Markdown', { exact: true })).toHaveValue(/Independent idea beside/);
  const ideaFile = await page.getByLabel('Proposed idea destination', { exact: true }).inputValue();
  await page.getByRole('button', { name: 'Confirm saved idea', exact: true }).click();
  await expect(page.locator('#idea-status')).toContainText('Saved idea');

  const history = {};
  for (const name of (await fs.readdir(path.join(root, 'conversations'))).filter(name => /^[a-f0-9-]{36}\.json$/.test(name))) history[name] = await fs.readFile(path.join(root, 'conversations', name), 'utf8');
  const current = Object.values(history).map(text => JSON.parse(text)).find(record => record.id !== origin.id);
  const captureDir = path.join(root, 'vault', 'Companion', 'Captures');
  const captureFile = path.join(captureDir, (await fs.readdir(captureDir)).find(name => name.endsWith('.md')));
  // This explicit external edit precedes export, so the transcript must warn about stale support.
  await fs.appendFile(captureFile, '\nTRANSCRIPT_SOURCE_CHANGED_BEFORE_EXPORT\n', 'utf8');
  const sourceBytes = await fs.readFile(captureFile, 'utf8'), ideaBytes = await fs.readFile(ideaFile, 'utf8');
  const calls = await fs.readFile(path.join(root, 'conversation-submissions.jsonl'), 'utf8');
  const destinationDir = path.join(root, 'vault', 'Exports'); await fs.mkdir(destinationDir);
  const destination = path.join(destinationDir, 'Chosen readable conversation.md');
  await fs.writeFile(path.join(root, 'transcript-selection.json'), JSON.stringify({ canceled: false, filePath: destination }), 'utf8');
  await page.getByRole('button', { name: 'Preview transcript export', exact: true }).click();
  await expect(page.getByLabel('Proposed transcript Markdown', { exact: true })).toBeVisible();
  await expect(page.getByLabel('Transcript destination', { exact: true })).toHaveValue(destination);
  await expect(page.getByLabel('Proposed transcript Markdown', { exact: true })).toHaveValue(/TRANSCRIPT_COMMENTARY_12/);
  let proposed = await page.getByLabel('Proposed transcript Markdown', { exact: true }).inputValue();
  expect(proposed).toContain('artifact_type: conversation_transcript');
  expect(proposed).toContain(current.id);
  expect(proposed).toContain(current.requests[0].id);
  expect(proposed).toContain('Retain a careful account of this selected historical discussion.');
  for (const message of messages) expect(proposed).toContain(message.text);
  expect(proposed.indexOf(messages[0].text)).toBeLessThan(proposed.indexOf(messages[1].text));
  expect(proposed.indexOf(messages[1].text)).toBeLessThan(proposed.indexOf(messages[2].text));
  expect(proposed).toContain('commentary'); expect(proposed).toContain('final_answer');
  expect(proposed).toMatch(/unknown.*phase|phase.*unknown/i);
  expect(proposed).toContain('completed');
  expect(proposed).toContain(current.brief.id); expect(proposed).toContain(current.brief.digest);
  expect(proposed).toContain(origin.id); expect(proposed).toContain(origin.requests[0].id);
  for (const dependency of current.requests[0].package.dependencies) { expect(proposed).toContain(dependency.key); expect(proposed).toContain(dependency.digest); }
  expect(proposed).toMatch(/changed|unavailable|missing/i);
  expect(proposed).toMatch(/previous.*provider|provider.*submission/i);
  expect(proposed).toMatch(/independent.*cop|separate.*cop|separate.*export/i);
  expect(await fs.stat(destination).catch(error => error.code)).toBe('ENOENT');
  await page.getByRole('button', { name: 'Cancel transcript preview', exact: true }).click();
  expect(await fs.readdir(destinationDir)).toEqual([]);
  expect(await fs.stat(path.join(root, 'vault', 'Companion', '.transcripts')).catch(error => error.code)).toBe('ENOENT');
  for (const [name, bytes] of Object.entries(history)) expect(await fs.readFile(path.join(root, 'conversations', name), 'utf8')).toBe(bytes);
  expect(await fs.readFile(captureFile, 'utf8')).toBe(sourceBytes);
  expect(await fs.readFile(ideaFile, 'utf8')).toBe(ideaBytes);

  await page.getByRole('button', { name: 'Preview transcript export', exact: true }).click();
  await expect(page.getByLabel('Proposed transcript Markdown', { exact: true })).toBeVisible();
  await expect(page.getByLabel('Proposed transcript Markdown', { exact: true })).toHaveValue(/TRANSCRIPT_FINAL_12/);
  proposed = await page.getByLabel('Proposed transcript Markdown', { exact: true }).inputValue();
  await page.getByRole('button', { name: 'Export reviewed transcript', exact: true }).click();
  await expect(page.locator('#transcript-status')).toContainText('Transcript exported');
  expect(await fs.readFile(destination, 'utf8')).toBe(proposed);
  expect(await fs.readdir(destinationDir)).toEqual(['Chosen readable conversation.md']);
  for (const [name, bytes] of Object.entries(history)) expect(await fs.readFile(path.join(root, 'conversations', name), 'utf8')).toBe(bytes);
  expect(await fs.readFile(captureFile, 'utf8')).toBe(sourceBytes);
  expect(await fs.readFile(ideaFile, 'utf8')).toBe(ideaBytes);
  expect(await fs.readFile(path.join(root, 'conversation-submissions.jsonl'), 'utf8')).toBe(calls);
  await app.close(); app = null; await launch(false);
  expect(await fs.readFile(destination, 'utf8')).toBe(proposed);
  expect(await fs.readFile(path.join(root, 'conversation-submissions.jsonl'), 'utf8')).toBe(calls);
});

test('a copied transcript cannot bypass source eligibility through context or brief inputs using artifact metadata alone', async () => {
  test.setTimeout(120000);
  await fs.writeFile(path.join(root, 'conversation-provider.json'), JSON.stringify({ reply: 'TRANSCRIPT_OPAQUE_COPY_12_CANARY: authored synthetic historical writing.' }), 'utf8');
  await prepareConversation();
  await page.getByRole('button', { name: 'Send reviewed package', exact: true }).click();
  await expect(page.locator('#conversation-history')).toContainText('TRANSCRIPT_OPAQUE_COPY_12_CANARY');
  await expect(page.locator('#conversation-history')).toContainText('completed');
  await page.getByRole('button', { name: 'Draft saved idea', exact: true }).click();
  await page.getByLabel('Idea title', { exact: true }).fill('Independent idea survives transcript guard checks');
  await page.getByLabel('Idea explanation', { exact: true }).fill('Retain the interpretation as separate author writing.');
  await page.getByLabel('Idea limitations', { exact: true }).fill('The transfer remains unverified.');
  await page.getByRole('button', { name: 'Preview saved idea', exact: true }).click();
  await expect(page.getByLabel('Proposed idea Markdown', { exact: true })).toHaveValue(/Independent idea survives/);
  const ideaFile = await page.getByLabel('Proposed idea destination', { exact: true }).inputValue();
  await page.getByRole('button', { name: 'Confirm saved idea', exact: true }).click();
  await expect(page.locator('#idea-status')).toContainText('Saved idea');
  const destination = path.join(root, 'vault', 'Companion', 'Readable transcript.md');
  await fs.writeFile(path.join(root, 'transcript-selection.json'), JSON.stringify({ canceled: false, filePath: destination }), 'utf8');
  await page.getByRole('button', { name: 'Preview transcript export', exact: true }).click();
  await expect(page.getByLabel('Proposed transcript Markdown', { exact: true })).toBeVisible();
  const proposed = await page.getByLabel('Proposed transcript Markdown', { exact: true }).inputValue();
  await page.getByRole('button', { name: 'Export reviewed transcript', exact: true }).click();
  await expect(page.locator('#transcript-status')).toContainText('Transcript exported');
  expect(await fs.readFile(destination, 'utf8')).toBe(proposed);
  const YAML = require('yaml'), front = proposed.match(/^---\n([\s\S]*?)\n---\n/), metadata = YAML.parse(front[1]);
  delete metadata.companion_id;
  expect(metadata.artifact_type).toBe('conversation_transcript');
  const copied = `---\n${YAML.stringify(metadata)}---\n${proposed.slice(front[0].length)}`;
  const copiedFile = path.join(root, 'vault', 'Copied historical transcript.md');
  await fs.writeFile(copiedFile, copied, 'utf8');
  const histories = {};
  for (const name of (await fs.readdir(path.join(root, 'conversations'))).filter(name => /^[a-f0-9-]{36}\.json$/.test(name))) histories[name] = await fs.readFile(path.join(root, 'conversations', name), 'utf8');
  const captureDir = path.join(root, 'vault', 'Companion', 'Captures');
  const captureFile = path.join(captureDir, (await fs.readdir(captureDir)).find(name => name.endsWith('.md')));
  const sourceBytes = await fs.readFile(captureFile, 'utf8'), ideaBytes = await fs.readFile(ideaFile, 'utf8');
  const calls = await fs.readFile(path.join(root, 'conversation-submissions.jsonl'), 'utf8');
  await fs.writeFile(path.join(root, 'context-selection.json'), JSON.stringify([copiedFile]), 'utf8');
  await page.getByRole('button', { name: 'Include vault notes', exact: true }).click();
  await expect(page.locator('#context-error')).toContainText(/managed artifact metadata.*cannot bypass context/i);
  await page.getByLabel('Context question', { exact: true }).fill('TRANSCRIPT_OPAQUE_COPY_12_CANARY');
  await page.getByRole('button', { name: 'Find context', exact: true }).click();
  await expect(page.locator('#context-notes')).not.toContainText('Copied historical transcript');
  await expect(page.locator('#context-results')).not.toContainText('TRANSCRIPT_OPAQUE_COPY_12_CANARY');
  await fs.writeFile(path.join(root, 'brief-selection.json'), JSON.stringify([copiedFile]), 'utf8');
  await page.getByRole('button', { name: 'Select MyTune README', exact: true }).click();
  await expect(page.locator('#brief-view')).toContainText(copiedFile);
  await page.getByRole('button', { name: 'Propose brief', exact: true }).click();
  await expect(page.locator('#brief-error')).toContainText(/transcripts.*historical dialogue.*cannot.*brief inputs/i);
  await expect(page.locator('#brief-view')).toContainText('Approved version 1');
  expect(await fs.readFile(destination, 'utf8')).toBe(proposed);
  expect(await fs.readFile(copiedFile, 'utf8')).toBe(copied);
  for (const [name, bytes] of Object.entries(histories)) expect(await fs.readFile(path.join(root, 'conversations', name), 'utf8')).toBe(bytes);
  expect(await fs.readFile(captureFile, 'utf8')).toBe(sourceBytes);
  expect(await fs.readFile(ideaFile, 'utf8')).toBe(ideaBytes);
  expect(await fs.readFile(path.join(root, 'conversation-submissions.jsonl'), 'utf8')).toBe(calls);
});
