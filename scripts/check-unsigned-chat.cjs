// Use --hidden for local verification, or run the visible smoke on an isolated Windows desktop.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { _electron: electron, expect } = require('@playwright/test');

async function main(executable, ...options) {
  assert(process.platform === 'win32', 'Use Windows for this Electron check.');
  assert(options.length === 0 || (options.length === 1 && ['--hidden', '--allow-visible-window'].includes(options[0])), 'Unexpected unsigned chat check option.');
  const hosted = process.env.GITHUB_ACTIONS === 'true' && process.env.RUNNER_OS === 'Windows' && process.env.RUNNER_ENVIRONMENT === 'github-hosted';
  const hidden = options[0] === '--hidden';
  assert(hidden || hosted || options[0] === '--allow-visible-window', 'This check opens a visible window. Use hosted Windows CI or explicitly pass --allow-visible-window on a coordinated local desktop.');
  assert(executable && path.isAbsolute(executable), 'Supply an absolute Codex executable path.');
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'companion-unsigned-chat-'));
  const profile = path.join(root, 'profile'), vault = path.join(root, 'vault'), project = path.join(root, 'project');
  const readme = path.join(project, 'README.md');
  const env = { ...process.env };
  delete env.COMPANION_TEST_ROOT;
  delete env.ELECTRON_RUN_AS_NODE;
  let app;
  try {
    await Promise.all([profile, vault, project].map(folder => fs.mkdir(folder)));
    await fs.writeFile(readme, '# MyTune\n\nPractice spaced retrieval.\n');
    app = await electron.launch({ args: ['--user-data-dir=' + profile, ...(hidden ? ['--companion-hidden-window'] : []), path.resolve(__dirname, '..')], env });
    assert.equal(await app.evaluate(({ app }) => app.getPath('userData')), profile);
    // Supply only the two native picker selections. All application checks and the provider are real.
    await app.evaluate(({ dialog }, { vault, readme }) => {
      dialog.showOpenDialog = async options => ({ canceled: false, filePaths: [options.properties.includes('openDirectory') ? vault : readme] });
    }, { vault, readme });
    const page = await app.firstWindow();
    const button = name => page.getByRole('button', { name, exact: true });
    await button('Choose vault').click();
    await button('Use this folder').click();
    await expect(page.getByRole('status')).toContainText('Vault ready.');
    await page.getByLabel('Codex executable').fill(executable);
    await page.getByLabel('Project folder to protect').fill(project);
    await button('Check Codex setup').click();
    await expect(page.locator('#codex-status')).toContainText('sign-in-required', { timeout: 30000 });
    await expect(button('Verify isolation')).toBeDisabled();
    await button('Select MyTune README').click();
    await button('Propose brief').click();
    await button('Approve proposed brief').click();
    await expect(page.locator('#brief-view')).toContainText('Approved version 1');
    const source = 'Spaced retrieval repeats the amber chord at noon.';
    await page.getByLabel('Thought or link', { exact: true }).fill(source);
    await button('Save capture').click();
    await expect(page.getByRole('status')).toContainText('Capture saved.');
    await page.getByLabel('Context question').fill('How could spaced retrieval help MyTune?');
    await button('Find context').click();
    await page.locator('#context-results article').filter({ hasText: source }).first().getByRole('button', { name: 'Add to context' }).click();
    await page.getByLabel('Conversation brief version').fill('1');
    await button('Preview conversation').click();
    await expect(page.getByLabel('Reviewed conversation package')).toHaveValue(/amber chord at noon/);
    const draft = page.getByLabel('Context question'), selected = page.locator('#context-selected');
    const reviewedSelection = await selected.innerText();
    assert(reviewedSelection.length);
    await expect(button('Send reviewed package')).toBeDisabled();
    await expect(page.locator('#conversation-summary')).toContainText('Ordinary chat is unavailable');
    await page.locator('#conversation-personal').check();
    await button('Preview conversation').click();
    await expect(page.locator('#conversation-error')).toContainText('verify isolation');
    await expect(button('Send reviewed package')).toBeDisabled();
    await expect(draft).toHaveValue('How could spaced retrieval help MyTune?');
    assert.equal(await selected.innerText(), reviewedSelection);
    assert.deepEqual(await page.evaluate(async () => (await window.companion['conversation-list']()).conversations), []);
    const report = JSON.parse(await fs.readFile(path.join(profile, 'codex', 'readiness.json'), 'utf8'));
    assert.equal(report.ready, false);
    assert.deepEqual(report.turns, []);
    console.log('Unsigned production profile accepted local capture and source review, refused chat and recorded zero provider turns.');
  } finally {
    try { await app?.close(); }
    finally { await fs.rm(root, { recursive: true, force: true, maxRetries: 3 }); }
  }
}
main(...process.argv.slice(2)).catch(error => { console.error(error.message); process.exitCode = 1; });
