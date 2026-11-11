const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const fs = require('node:fs/promises');
const path = require('node:path');
const { Vault } = require('./vault');
const { CodexSetup } = require('./codex');
const { Intake } = require('./intake');
const { Schedule } = require('./schedule');
const { installBriefs } = require('./briefs-ipc');
const { installContext } = require('./context');
const { installConversations } = require('./conversations');
const { installArchives } = require('./archives');
const { installIdeas } = require('./ideas');
const { installTranscripts } = require('./transcripts');
const { installComparisons } = require('./comparisons');
const { installCaptureDeletion } = require('./capture-deletion');
const { installAnnotationRemoval } = require('./annotation-removal');
const { ConversationProvider } = require('./conversation-provider');
const { ConversationEvidence } = require('./conversation-evidence');
let codex, conversationProvider;
let testRoot = process.env.COMPANION_TEST_ROOT;
let vault, settingsPath;
const workerMode = process.argv.includes('--intake-worker');
const workerFile = process.argv[process.argv.indexOf('--schedule-file') + 1];
const workerBinding = process.argv.indexOf('--schedule-id');
async function resolveDataRoot(requested) {
  const supplied = path.resolve(requested), actual = await fs.realpath(supplied);
  // Case alone is not an alias on the supported Windows data volume. Keep the
  // original spelling because an owned task validates its launch arguments.
  return process.platform === 'win32' && supplied.toLowerCase() === actual.toLowerCase() ? supplied : actual;
}
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
  if (testRoot) testRoot = await resolveDataRoot(testRoot);
  if (workerMode) {
    try {
      if (!process.argv.includes('--schedule-file') || typeof workerFile !== 'string' || !path.isAbsolute(workerFile)) throw Error('Worker requires its absolute daily intake settings path.');
      const state = await new Schedule(workerFile, null, scheduleOptions()).load();
      if (!state) throw Error('Daily intake settings are missing.');
      // Old registered tasks may omit the ID only while their unbound record is current.
      const requestedId = workerBinding < 0 ? undefined : process.argv[workerBinding + 1];
      if ((state.launchBinding === 1 || workerBinding >= 0) && requestedId !== state.id) { app.exit(0); return; }
      const selected = new Vault(state.vault, state.parent, { checkpoint });
      const schedule = new Schedule(workerFile, selected, {
        ...scheduleOptions(),
        assertSelected: state.launchBinding === 1 ? () => schedule.assertConfiguration(path.join(path.dirname(workerFile), 'settings.json')) : undefined
      });
      const result = await schedule.run(clock().now, 'scheduled', state.id);
      app.exit(result && !result.skipped && result.lastCheck.status !== 'complete' ? 1 : 0);
    } catch (error) { console.error(error.message); app.exit(1); }
    return;
  }
  const requestedDataRoot = testRoot || app.getPath('userData');
  await fs.mkdir(requestedDataRoot, { recursive: true });
  // Keep every local store bound to the same original installation directory.
  const dataRoot = testRoot || await resolveDataRoot(requestedDataRoot);
  settingsPath = path.join(dataRoot, 'settings.json');
  codex = new CodexSetup({ dataRoot: path.join(dataRoot, 'codex'), testRoot });
  ipcMain.handle('codex-state', () => codex.snapshot());
  ipcMain.handle('codex-action', (_, input) => codex.action(input, { vault: vault?.root }));
  try { const settings = JSON.parse(await fs.readFile(settingsPath, 'utf8')); vault = new Vault(settings.vault, settings.parent, { checkpoint }); } catch (error) { if (error.code !== 'ENOENT') console.error('Cannot load settings:', error.message); }
  const schedule = (selected = vault) => {
    const current = new Schedule(path.join(path.dirname(settingsPath), 'schedule.json'), selected, {
      ...scheduleOptions(),
      assertSelected: async () => {
        if (selected !== vault) throw Error('Vault selection changed. Refresh and try again.');
        await current.assertConfiguration(settingsPath);
        if (selected !== vault) throw Error('Vault selection changed. Refresh and try again.');
      }
    });
    return current;
  };
  ipcMain.handle('choose-vault', async () => testRoot ? path.join(testRoot, 'vault') : (await dialog.showOpenDialog({ properties: ['openDirectory'] })).filePaths[0]);
  ipcMain.handle('configure', async (_, settings) => {
    const next = new Vault(settings.vault, settings.parent, { checkpoint });
    await fs.mkdir(path.dirname(settingsPath), { recursive: true });
    const nextSchedule = schedule(next);
    return nextSchedule.change(async guard => {
      const existing = await nextSchedule.snapshot(guard);
      if (existing && !nextSchedule.matches(existing.state)) await nextSchedule.requireDisabled(existing.state);
      await next.setup();
      const stored = await fs.lstat(settingsPath).catch(error => {
        if (error.code === 'ENOENT') return null;
        throw error;
      });
      if (stored && (!stored.isFile() || stored.isSymbolicLink() || stored.nlink !== 1)) throw Error('Vault selection settings are not an ordinary file. Preserve them for repair.');
      nextSchedule.requireCurrent(existing?.proof || null, guard);
      await fs.writeFile(settingsPath, JSON.stringify(settings));
      vault = next; codex.invalidate(); return true;
    });
  });
  const localVaultWork = new Map();
  async function orderVaultWork(selected, work) {
    if (!selected) return work();
    const root = await fs.realpath(selected.root).catch(() => selected.root);
    const key = process.platform === 'win32' ? root.toLowerCase() : root;
    const result = (localVaultWork.get(key) || Promise.resolve()).then(() => {
      if (selected !== vault) throw Error('Vault selection changed. Refresh and try again.');
      return work();
    });
    // This orders local requests only. The original native owner still decides admission.
    const tail = result.then(() => undefined, () => undefined);
    localVaultWork.set(key, tail);
    try { return await result; }
    finally { if (localVaultWork.get(key) === tail) localVaultWork.delete(key); }
  }
  await schedule().run(clock().now).catch(error => console.error('Scheduled catch-up:', error.message));
  for (const operation of ['enable', 'pause', 'resume', 'disable', 'repair']) ipcMain.handle(`schedule-${operation}`, async (_, view) => {
    const selected = vault;
    if (!selected) throw Error('Choose a vault first.');
    if (typeof view?.location !== 'string' || view.scheduleId !== null && typeof view.scheduleId !== 'string') throw Error('Refresh the daily intake view before changing its task.');
    return schedule(selected).control(operation, clock().now, view);
  });
  ipcMain.handle('state', async () => {
    const selected = vault, selectedSchedule = schedule(selected);
    const { intake, captures, vaultError, warnings } = await orderVaultWork(selected, async () => {
      let intake = null, captures = [], vaultError;
      try { if (selected) { intake = await new Intake(selected).info(); captures = await selected.list(); } }
      catch (error) { vaultError = error.message; }
      return { intake, captures, vaultError, warnings: [...(selected?.warnings || []), ...(vaultError ? [vaultError] : [])] };
    });
    const imported = new Map(Object.values(intake?.captures || {}).map(capture => [capture.id, capture]));
    const daily = await selectedSchedule.info(clock().now);
    return { ...clock(), configured: !!selected, location: selected?.root, captures: captures.filter(note => imported.has(note.id) ? !imported.get(note.id).removed : note.type !== 'reel_import').map(note => imported.has(note.id) ? { ...note, type: 'reel_import' } : note), warnings, intake, vaultError, schedule: selectedSchedule.matches(daily) ? daily : null, scheduleRecordId: daily?.id || null };
  });
  ipcMain.handle('capture', async (_, input) => {
    const selected = vault, now = clock().now;
    if (!selected) throw Error('Choose a vault first.');
    return orderVaultWork(selected, () => selected.capture(input, now));
  });
  ipcMain.handle('title', async (_, { id, title }) => new Intake(vault).title(id, title));
  async function intakeRequest(work) {
    const selected = vault, now = clock().now;
    if (!selected) throw Error('Choose a vault first.');
    const selectedSchedule = schedule(selected);
    const result = await orderVaultWork(selected, () => work(new Intake(selected), now));
    return selectedSchedule.record(result);
  }
  ipcMain.handle('connect-drafts', (_, { folder, scan }) => intakeRequest((intake, now) => intake.connect(folder, scan, now)));
  ipcMain.handle('connect-reviews', (_, { folder, scan }) => intakeRequest((intake, now) => intake.connect(folder, scan, now, 'review')));
  ipcMain.handle('reconnect-source', (_, { location, ...input }) => intakeRequest(intake => {
    if (intake.vault.root !== location) throw Error('Vault selection changed. Refresh and try again.');
    return intake.reconnect(input);
  }));
  ipcMain.handle('check-intake', () => intakeRequest((intake, now) => intake.reconcile({ trigger: 'manual', now })));
  ipcMain.handle('add-annotation', async (_, input) => new Intake(vault).addAnnotation(input, clock().now));
  ipcMain.handle('choose-identity', async (_, input) => new Intake(vault).chooseIdentity(input));
  ipcMain.handle('retry-annotation-link', async (_, input) => new Intake(vault).retryLink(input));
  ipcMain.handle('restore-missing', async (_, input) => new Intake(vault).restoreMissing(input, clock().now));
  ipcMain.handle('remove-missing', async (_, input) => new Intake(vault).removeMissing(input, clock().now));
  ipcMain.handle('vault-repairs', () => {
    const selected = vault;
    return orderVaultWork(selected, () => new Intake(selected).repairs());
  });
  ipcMain.handle('resolve-conflict', async (_, input) => new Intake(vault).resolveConflict(input, clock().now));
  ipcMain.handle('inspect-source', async (_, id) => {
    const selected = vault;
    const info = await new Intake(selected).inspect(id, { verifyCurrentNote: true });
    let linkedIdeas = [], linkedIdeasWarning;
    try { linkedIdeas = await ideas.linkedToCapture(selected, id); }
    catch { linkedIdeasWarning = 'Linked saved ideas are unavailable. Their writing was preserved.'; }
    if (vault !== selected) throw Error('Selected vault changed. Inspect the source again.');
    return { ...info, linkedIdeas, linkedIdeasWarning };
  });
  ipcMain.handle('select-review', async (_, { id, revision }) => new Intake(vault).selectCurrent(id, revision, clock().now));
  ipcMain.handle('link-sources', async (_, { id, related }) => new Intake(vault).linkSources(id, related, clock().now));
  ipcMain.handle('open-note', async (_, id) => {
    const note = await vault.find(id);
    const uri = `obsidian://open?path=${encodeURIComponent(note.file)}`;
    if (testRoot) await fs.writeFile(path.join(testRoot, 'opened-uri.txt'), uri); else await shell.openExternal(uri);
  });
  installBriefs({ ipcMain, dialog, fs, path, testRoot, getVault: () => vault, clock });
  const evidence = new ConversationEvidence({ setup: codex, getVault: () => vault, settingsPath, testRoot });
  const getEvidence = () => evidence.read();
  let ideas;
  const context = installContext({ ipcMain, getVault: () => vault, dialog, testRoot, dataRoot, getEvidence, ideaEligibility: (selected, id) => {
    if (!ideas || ideas.getVault()?.root !== selected.root) throw Error('Selected vault changed. Inspect saved idea context again.');
    ideas.guard(selected);
    if (id) ideas.removal.allow(selected, id);
  } });
  // Controlled desktop tests can exercise the closed production gate without sign-in or probes.
  conversationProvider = new ConversationProvider({ setup: codex, testRoot: testRoot && process.env.COMPANION_TEST_REAL_PROVIDER_GUARD !== '1' ? testRoot : undefined, getVault: () => vault, getEvidence });
  const conversations = installConversations({ ipcMain, getContext: context.store, getVault: () => vault, dataRoot, clock, checkpoint, provider: conversationProvider, testRoot });
  installCaptureDeletion({ ipcMain, getVault: () => vault, conversations, clearApprovals: context.clearApprovals, clock });
  installAnnotationRemoval({ ipcMain, getVault: () => vault, clearApprovals: context.clearApprovals });
  installTranscripts({ ipcMain, conversations, getVault: () => vault, getContext: context.store, clock, checkpoint, choose: async selected => {
    const selection = testRoot ? JSON.parse(await fs.readFile(path.join(testRoot, 'transcript-selection.json'), 'utf8')) : await dialog.showSaveDialog({ title: 'Export readable conversation transcript', defaultPath: path.join(selected.vault, 'Conversation transcript.md'), filters: [{ name: 'Markdown transcript', extensions: ['md'] }] });
    return selection.canceled ? null : selection.filePath;
  } });
  installArchives({ ipcMain, history: conversations, settingsPath, dialog, testRoot, clock, checkpoint, appVersion: app.getVersion(), invalidateContextApprovals: context.clearApprovals, getSchedule: schedule });
  ideas = installIdeas({ ipcMain, getVault: () => vault, conversations, clock, checkpoint, open: async uri => {
    if (testRoot) await fs.writeFile(path.join(testRoot, 'opened-uri.txt'), uri, 'utf8'); else await shell.openExternal(uri);
  } });
  installComparisons({ ipcMain, getVault: () => vault, dataRoot, clock, checkpoint, provider: conversationProvider, getEvidence });
  const fixtureRendering = testRoot ? { backgroundThrottling: false } : {};
  const window = new BrowserWindow({ width: 1000, height: 780, show: !testRoot, webPreferences: { ...fixtureRendering, preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true } });
  window.webContents.session.webRequest.onBeforeRequest(({ url }, callback) => callback({ cancel: !url.startsWith('file:') && !url.startsWith('devtools:') }));
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', event => event.preventDefault());
  await window.loadFile(path.join(__dirname, 'index.html'));
  // Give disposable desktop fixtures normal frame cadence without taking focus.
  if (testRoot) window.showInactive();
});
app.on('before-quit', () => { codex?.close(); conversationProvider?.close(); });
app.on('window-all-closed', () => app.quit());
