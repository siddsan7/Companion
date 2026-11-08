const { test, expect, _electron: electron } = require('@playwright/test');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
let root, app, page;
test.beforeEach(async () => { root = await fs.mkdtemp(path.join(os.tmpdir(), 'companion-codex-')); await fs.writeFile(path.join(root, 'clock.json'), JSON.stringify({ now: '2026-11-08T06:59:00Z', timezone: 'America/Phoenix' })); });
test.afterEach(async () => { if (app) await app.close(); app = null; await fs.rm(root, { recursive: true, force: true }); });
async function launch() { app = await electron.launch({ args: ['.'], env: { ...process.env, COMPANION_TEST_ROOT: root } }); page = await app.firstWindow(); }
test('unverified Codex setup blocks model turns while offline capture remains available after restart', async () => {
  await launch();
  await expect(page.getByRole('heading', { name: 'Codex setup' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Send synthetic turn', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: 'Choose vault' }).click();
  await page.getByRole('button', { name: 'Use this folder' }).click();
  await page.getByLabel('Thought or link').fill('Capture while Codex is unavailable');
  await page.getByRole('button', { name: 'Save capture', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Capture while Codex is unavailable', exact: true })).toBeVisible();
  await app.close(); app = null; await launch();
  await expect(page.getByRole('button', { name: 'Send synthetic turn', exact: true })).toBeDisabled();
  await expect(page.getByRole('heading', { name: 'Capture while Codex is unavailable', exact: true })).toBeVisible();
});
test('managed sign-in can be cancelled and expired without enabling a model turn', async () => {
  await fs.writeFile(path.join(root, 'codex-fixture.json'), JSON.stringify({ login: 'pending' }));
  await launch();
  await page.getByLabel('Codex executable').fill('controlled-fixture');
  await page.getByLabel('Project folder to protect').fill(path.join(root, 'project'));
  await fs.mkdir(path.join(root, 'project'));
  await page.getByRole('button', { name: 'Check Codex setup' }).click();
  await expect(page.getByRole('button', { name: 'Sign in with ChatGPT' })).toBeEnabled();
  await page.getByRole('button', { name: 'Sign in with ChatGPT' }).click();
  await expect(page.locator('#codex-login-info')).toContainText('ABCD-1234');
  await page.getByRole('button', { name: 'Cancel sign-in' }).click();
  await expect(page.locator('#codex-status')).toContainText('cancelled');
  await fs.writeFile(path.join(root, 'codex-fixture.json'), JSON.stringify({ login: 'expired' }));
  await page.getByRole('button', { name: 'Sign in with ChatGPT' }).click();
  await expect(page.locator('#codex-status')).toContainText('expired');
  await expect(page.getByRole('button', { name: 'Send synthetic turn', exact: true })).toBeDisabled();
});
test('an outside-context readable canary keeps chat incomplete and never starts a model turn', async () => {
  await fs.writeFile(path.join(root, 'codex-fixture.json'), JSON.stringify({ login: 'complete' }));
  await fs.mkdir(path.join(root, 'project'));
  await launch();
  await page.getByRole('button', { name: 'Choose vault' }).click();
  await page.getByRole('button', { name: 'Use this folder' }).click();
  await page.getByLabel('Codex executable').fill('controlled-fixture');
  await page.getByLabel('Project folder to protect').fill(path.join(root, 'project'));
  await page.getByRole('button', { name: 'Check Codex setup' }).click();
  await page.getByRole('button', { name: 'Sign in with ChatGPT' }).click();
  await expect(page.getByRole('button', { name: 'Verify isolation', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: 'Verify isolation', exact: true }).click();
  await expect(page.locator('#codex-status')).toContainText('protected canary');
  await expect(page.getByRole('button', { name: 'Send synthetic turn', exact: true })).toBeDisabled();
  const requests = (await fs.readFile(path.join(root, 'codex-requests.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
  expect(requests.some(request => request.method === 'command/exec')).toBe(true);
  expect(requests.some(request => ['thread/start', 'turn/start', 'thread/shellCommand'].includes(request.method))).toBe(false);
  const report = JSON.parse(await fs.readFile(path.join(root, 'codex', 'readiness.json'), 'utf8'));
  expect(report.evidence).toBe('controlled-fixture-not-live'); expect(report.ready).toBe(false);
  expect(JSON.stringify(report)).not.toMatch(/ABCD-1234|fixture@example|auth.openai/);
});


test('fresh synthetic turns finish only on terminal completion and retain an interrupted reply across restart', async () => {
  await fs.writeFile(path.join(root, 'codex-fixture.json'), JSON.stringify({ login: 'complete', isolation: 'denied', turn: 'completed' }));
  await fs.mkdir(path.join(root, 'project')); await launch();
  await page.getByRole('button', { name: 'Choose vault' }).click(); await page.getByRole('button', { name: 'Use this folder' }).click();
  await page.getByLabel('Codex executable').fill('controlled-fixture'); await page.getByLabel('Project folder to protect').fill(path.join(root, 'project'));
  await page.getByRole('button', { name: 'Check Codex setup' }).click(); await page.getByRole('button', { name: 'Sign in with ChatGPT' }).click();
  await expect(page.getByRole('button', { name: 'Verify isolation', exact: true })).toBeEnabled(); await page.getByRole('button', { name: 'Verify isolation', exact: true }).click();
  for (let index = 0; index < 2; index++) {
    await page.getByRole('button', { name: 'Send synthetic turn', exact: true }).click();
    await expect.poll(async () => JSON.parse(await fs.readFile(path.join(root, 'codex', 'readiness.json'), 'utf8')).turns.length).toBe(index + 1);
    await expect(page.locator('#codex-status')).toContainText('Synthetic turn completed');
  }
  const before = JSON.parse(await fs.readFile(path.join(root, 'codex', 'readiness.json'), 'utf8'));
  expect(before.turns).toHaveLength(2); expect(new Set(before.turns.map(turn => turn.threadId)).size).toBe(2);
  await fs.writeFile(path.join(root, 'codex-fixture.json'), JSON.stringify({ login: 'complete', isolation: 'denied', turn: 'pending' }));
  await page.getByRole('button', { name: 'Send synthetic turn', exact: true }).click();
  await expect(page.locator('#codex-reply')).toContainText('Incomplete fixture reply 🎸');
  await page.getByRole('button', { name: 'Interrupt turn', exact: true }).click();
  await expect(page.locator('#codex-status')).toContainText('turn interrupted');
  const report = JSON.parse(await fs.readFile(path.join(root, 'codex', 'readiness.json'), 'utf8'));
  expect(report.turns.at(-1).status).toBe('interrupted');
  expect(report.evidence).toBe('controlled-fixture-not-live');
  await app.close(); app = null; await launch();
  await expect(page.locator('#codex-status')).toContainText('interrupted');
  await expect(page.getByRole('button', { name: 'Send synthetic turn', exact: true })).toBeDisabled();
});

test('a usage limit is actionable, preserves a failed terminal and never replays on restart', async () => {
  await fs.writeFile(path.join(root, 'codex-fixture.json'), JSON.stringify({ login: 'complete', isolation: 'denied', turn: 'usage-limit' }));
  await fs.mkdir(path.join(root, 'project')); await launch();
  await page.getByRole('button', { name: 'Choose vault' }).click(); await page.getByRole('button', { name: 'Use this folder' }).click();
  await page.getByLabel('Codex executable').fill('controlled-fixture'); await page.getByLabel('Project folder to protect').fill(path.join(root, 'project'));
  await page.getByRole('button', { name: 'Check Codex setup' }).click(); await page.getByRole('button', { name: 'Sign in with ChatGPT' }).click();
  await expect(page.getByRole('button', { name: 'Verify isolation', exact: true })).toBeEnabled(); await page.getByRole('button', { name: 'Verify isolation', exact: true }).click();
  await page.getByRole('button', { name: 'Send synthetic turn', exact: true }).click();
  await expect(page.locator('#codex-status')).toContainText('usage limit');
  await expect.poll(async () => JSON.parse(await fs.readFile(path.join(root, 'codex', 'readiness.json'), 'utf8')).turns.at(-1)?.status).toBe('failed');
  const report = await fs.readFile(path.join(root, 'codex', 'readiness.json'), 'utf8'); expect(report).not.toContain('PRIVATE_PROVIDER_DETAIL');
  await app.close(); app = null; await launch();
  await expect(page.getByRole('button', { name: 'Send synthetic turn', exact: true })).toBeDisabled();
  const requests = (await fs.readFile(path.join(root, 'codex-requests.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
  expect(requests.filter(request => request.method === 'turn/start')).toHaveLength(1);
});

test('an App Server exit before turn acknowledgement leaves an interrupted terminal without replay', async () => {
  await fs.writeFile(path.join(root, 'codex-fixture.json'), JSON.stringify({ login: 'complete', isolation: 'denied', turn: 'exit-before-ack' }));
  await fs.mkdir(path.join(root, 'project')); await launch();
  await page.getByRole('button', { name: 'Choose vault' }).click(); await page.getByRole('button', { name: 'Use this folder' }).click();
  await page.getByLabel('Codex executable').fill('controlled-fixture'); await page.getByLabel('Project folder to protect').fill(path.join(root, 'project'));
  await page.getByRole('button', { name: 'Check Codex setup' }).click(); await page.getByRole('button', { name: 'Sign in with ChatGPT' }).click();
  await expect(page.getByRole('button', { name: 'Verify isolation', exact: true })).toBeEnabled(); await page.getByRole('button', { name: 'Verify isolation', exact: true }).click();
  await page.getByRole('button', { name: 'Send synthetic turn', exact: true }).click();
  await expect(page.locator('#codex-status')).toContainText('interrupted');
  await expect.poll(async () => JSON.parse(await fs.readFile(path.join(root, 'codex', 'readiness.json'), 'utf8')).turns.at(-1)?.status).toBe('interrupted');
  await expect(page.getByRole('button', { name: 'Send synthetic turn', exact: true })).toBeDisabled();
  await app.close(); app = null; await launch();
  await expect(page.locator('#codex-status')).toContainText('interrupted');
  const requests = (await fs.readFile(path.join(root, 'codex-requests.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
  expect(requests.filter(request => request.method === 'turn/start')).toHaveLength(1);
});

test('a history write failure clears turn controls before any model request and keeps capture usable', async () => {
  await fs.writeFile(path.join(root, 'codex-fixture.json'), JSON.stringify({ login: 'complete', isolation: 'denied', turn: 'completed' }));
  await fs.mkdir(path.join(root, 'project')); await launch();
  await page.getByRole('button', { name: 'Choose vault' }).click(); await page.getByRole('button', { name: 'Use this folder' }).click();
  await page.getByLabel('Codex executable').fill('controlled-fixture'); await page.getByLabel('Project folder to protect').fill(path.join(root, 'project'));
  await page.getByRole('button', { name: 'Check Codex setup' }).click(); await page.getByRole('button', { name: 'Sign in with ChatGPT' }).click();
  await expect(page.getByRole('button', { name: 'Verify isolation', exact: true })).toBeEnabled(); await page.getByRole('button', { name: 'Verify isolation', exact: true }).click();
  const reportFile = path.join(root, 'codex', 'readiness.json');
  await expect.poll(async () => JSON.parse(await fs.readFile(reportFile, 'utf8')).status).toBe('isolated');
  await expect(page.getByRole('button', { name: 'Send synthetic turn', exact: true })).toBeEnabled();
  await fs.unlink(reportFile); await fs.mkdir(reportFile);
  await page.getByRole('button', { name: 'Send synthetic turn', exact: true }).click();
  await expect(page.locator('#codex-status')).toContainText(/incomplete|failed/i);
  await expect(page.getByRole('button', { name: 'Interrupt turn', exact: true })).toBeDisabled();
  const requests = (await fs.readFile(path.join(root, 'codex-requests.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
  expect(requests.some(request => request.method === 'turn/start')).toBe(false);
  await page.getByLabel('Thought or link').fill('Capture despite a Codex history failure');
  await page.getByRole('button', { name: 'Save capture', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Capture despite a Codex history failure', exact: true })).toBeVisible();
});
