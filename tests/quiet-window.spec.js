const { test, expect, _electron: electron } = require('@playwright/test');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const entry = path.join(__dirname, 'fixtures', 'observe-window.cjs');

async function checkWindow(desktop) {
  expect(await desktop.evaluate(({ app, BrowserWindow }) => {
    const [window] = BrowserWindow.getAllWindows();
    return {
      events: app.windowActivity, visible: window.isVisible(), focused: window.isFocused(),
      focusable: window.isFocusable(), throttled: window.webContents.getBackgroundThrottling(),
    };
  })).toEqual({ events: ['created'], visible: false, focused: false, focusable: false, throttled: false });
}

test('disposable window stays hidden and renders through capture and restart', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'companion-quiet-'));
  const env = { ...process.env, COMPANION_TEST_ROOT: root };
  delete env.COMPANION_TEST_SHOW_WINDOW;
  try {
    await fs.writeFile(path.join(root, 'clock.json'), JSON.stringify({ now: '2026-11-08T06:59:00Z', timezone: 'UTC' }));
    for (const firstLaunch of [true, false]) {
      const desktop = await electron.launch({ args: [entry], env });
      try {
        const page = await desktop.firstWindow();
        if (firstLaunch) {
          await page.getByRole('button', { name: 'Choose vault' }).click();
          await page.getByRole('button', { name: 'Use this folder' }).click();
          await page.getByLabel('Thought or link').fill('Quiet capture');
          await page.getByRole('button', { name: 'Save capture', exact: true }).click();
        }
        await expect(page.getByRole('heading', { name: 'Quiet capture' })).toBeVisible();
        // Hidden Chromium windows previously fell to one animation frame per second.
        const elapsed = await page.evaluate(async () => {
          const frame = () => new Promise(resolve => requestAnimationFrame(resolve));
          const start = await frame();
          for (let i = 0; i < 10; i++) await frame();
          return performance.now() - start;
        });
        expect(elapsed).toBeLessThan(1000);
        await checkWindow(desktop);
      } finally { await desktop.close(); }
    }
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('release probe can hide the production window with fixture mode disabled', async () => {
  const profile = await fs.mkdtemp(path.join(os.tmpdir(), 'companion-quiet-profile-'));
  const env = { ...process.env };
  delete env.COMPANION_TEST_ROOT;
  try {
    const desktop = await electron.launch({ args: [entry, '--user-data-dir=' + profile, '--companion-hidden-window'], env });
    try {
      const page = await desktop.firstWindow();
      await expect(page.getByRole('button', { name: 'Choose vault' })).toBeVisible();
      await checkWindow(desktop);
    } finally { await desktop.close(); }
  } finally { await fs.rm(profile, { recursive: true, force: true }); }
});
