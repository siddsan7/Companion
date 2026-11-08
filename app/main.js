const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const fs = require('node:fs/promises');
const path = require('node:path');
const { Vault } = require('./vault');
const { CodexSetup } = require('./codex');
const { Intake } = require('./intake');
const { Schedule } = require('./schedule');
const { installBriefs } = require('./briefs-ipc');
let codex;
const testRoot = process.env.COMPANION_TEST_ROOT;
let vault, settingsPath;
const workerMode = process.argv.includes('--intake-worker');
const workerFile = process.argv[process.argv.indexOf('--schedule-file') + 1];
function scheduleOptions() { return { testRoot, executable: process.execPath, appPath: app.getAppPath(), packaged: app.isPackaged }; }
async function checkpoint(name) {
  if (!testRoot) return;
  let control; try { control = JSON.parse(await fs.readFile(path.join(testRoot, 'faults.json'), 'utf8')); } catch { return; }
  if (control.fail === name) throw Object.assign(Error('Controlled filesystem boundary failure.'), { code: control.code || 'EACCES' });
  if (control.pause !== name) return;
  await fs.writeFile(path.join(testRoot, 'checkpoint.txt'), name);
  while (true) {
    try { await fs.access(path.join(testRoot, 'release.txt')); return; } catch {}
    await new Promise(resolve => setTimeout(resolve, 30));
  }
}
function clock() {
  if (testRoot) return JSON.parse(require('node:fs').readFileSync(path.join(testRoot, 'clock.json'), 'utf8'));
  return { now: new Date().toISOString(), timezone: Intl.DateTimeFormat().resolvedOptions().timeZone };
}
app.whenReady().then(async () => {
  if (workerMode) {
    try {
      if (!process.argv.includes('--schedule-file') || !path.isAbsolute(workerFile)) throw Error('Worker requires its absolute daily intake settings path.');
      const state = await new Schedule(workerFile, null, scheduleOptions()).load();
      if (!state) throw Error('Daily intake settings are missing.');
      const selected = new Vault(state.vault, state.parent, { checkpoint });
      const result = await new Schedule(workerFile, selected, scheduleOptions()).run(clock().now, 'scheduled');
      app.exit(result && !result.skipped && result.lastCheck.status !== 'complete' ? 1 : 0);
    } catch (error) { console.error(error.message); app.exit(1); }
    return;
  }
  settingsPath = path.join(testRoot || app.getPath('userData'), 'settings.json');
  codex = new CodexSetup({ dataRoot: path.join(testRoot || app.getPath('userData'), 'codex'), testRoot });
  ipcMain.handle('codex-state', () => codex.snapshot());
  ipcMain.handle('codex-action', (_, input) => codex.action(input, { vault: vault?.root }));
  try { const settings = JSON.parse(await fs.readFile(settingsPath, 'utf8')); vault = new Vault(settings.vault, settings.parent, { checkpoint }); } catch (error) { if (error.code !== 'ENOENT') console.error('Cannot load settings:', error.message); }
  ipcMain.handle('choose-vault', async () => testRoot ? path.join(testRoot, 'vault') : (await dialog.showOpenDialog({ properties: ['openDirectory'] })).filePaths[0]);
  ipcMain.handle('configure', async (_, settings) => {
    const next = new Vault(settings.vault, settings.parent, { checkpoint });
    const existing = await schedule().load();
    if (existing && existing.mode !== 'disabled' && path.resolve(existing.vault, existing.parent).toLowerCase() !== next.root.toLowerCase()) throw Error('Disable daily intake before changing its vault.');
    await next.setup();
    await fs.mkdir(path.dirname(settingsPath), { recursive: true });
    await fs.writeFile(settingsPath, JSON.stringify(settings)); vault = next; codex.invalidate(); return true;
  });
  const schedule = () => new Schedule(path.join(path.dirname(settingsPath), 'schedule.json'), vault, scheduleOptions());
  await schedule().run(clock().now).catch(error => console.error('Scheduled catch-up:', error.message));
  for (const operation of ['enable', 'pause', 'resume', 'disable', 'repair']) ipcMain.handle(`schedule-${operation}`, async () => {
    if (!vault) throw Error('Choose a vault first.'); return schedule().control(operation, clock().now);
  });
  ipcMain.handle('state', async () => {
    let intake = null, captures = [], vaultError;
    try { intake = vault ? await new Intake(vault).info() : null; captures = vault ? await vault.list() : []; }
    catch (error) { vaultError = error.message; }
    return { ...clock(), configured: !!vault, location: vault?.root, captures: captures.filter(note => note.type !== 'reel_import' || Object.values(intake?.captures || {}).some(x => x.id === note.id && !x.removed)), warnings: [...(vault?.warnings || []), ...(vaultError ? [vaultError] : [])], intake, vaultError, schedule: await schedule().info(clock().now) };
  });
  ipcMain.handle('capture', async (_, input) => { if (!vault) throw Error('Choose a vault first.'); return vault.capture(input, clock().now); });
  ipcMain.handle('title', async (_, { id, title }) => new Intake(vault).title(id, title));
  ipcMain.handle('connect-drafts', async (_, { folder, scan }) => { if (!vault) throw Error('Choose a vault first.'); return schedule().record(await new Intake(vault).connect(folder, scan, clock().now)); });
  ipcMain.handle('connect-reviews', async (_, { folder, scan }) => { if (!vault) throw Error('Choose a vault first.'); return schedule().record(await new Intake(vault).connect(folder, scan, clock().now, 'review')); });
  ipcMain.handle('check-intake', async () => { if (!vault) throw Error('Choose a vault first.'); return schedule().record(await new Intake(vault).reconcile({ trigger: 'manual', now: clock().now })); });
  ipcMain.handle('add-annotation', async (_, input) => new Intake(vault).addAnnotation(input, clock().now));
  ipcMain.handle('choose-identity', async (_, input) => new Intake(vault).chooseIdentity(input));
  ipcMain.handle('retry-annotation-link', async (_, input) => new Intake(vault).retryLink(input));
  ipcMain.handle('restore-missing', async (_, input) => new Intake(vault).restoreMissing(input, clock().now));
  ipcMain.handle('remove-missing', async (_, input) => new Intake(vault).removeMissing(input, clock().now));
  ipcMain.handle('vault-repairs', async () => new Intake(vault).repairs());
  ipcMain.handle('resolve-conflict', async (_, input) => new Intake(vault).resolveConflict(input, clock().now));
  ipcMain.handle('inspect-source', async (_, id) => new Intake(vault).inspect(id));
  ipcMain.handle('select-review', async (_, { id, revision }) => new Intake(vault).selectCurrent(id, revision, clock().now));
  ipcMain.handle('link-sources', async (_, { id, related }) => new Intake(vault).linkSources(id, related, clock().now));
  ipcMain.handle('open-note', async (_, id) => {
    const note = await vault.find(id);
    const uri = `obsidian://open?path=${encodeURIComponent(note.file)}`;
    if (testRoot) await fs.writeFile(path.join(testRoot, 'opened-uri.txt'), uri); else await shell.openExternal(uri);
  });
  installBriefs({ ipcMain, dialog, fs, path, testRoot, getVault: () => vault, clock });
  const window = new BrowserWindow({ width: 1000, height: 780, show: !testRoot, webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true } });
  window.webContents.session.webRequest.onBeforeRequest(({ url }, callback) => callback({ cancel: !url.startsWith('file:') && !url.startsWith('devtools:') }));
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', event => event.preventDefault());
  await window.loadFile(path.join(__dirname, 'index.html'));
});
app.on('before-quit', () => codex?.close());
app.on('window-all-closed', () => app.quit());
