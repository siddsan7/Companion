// Run from a verified Companion worktree. Only fresh disposable roots are accepted.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { createRequire } = require('node:module');
const { createHash } = require('node:crypto');
const { execFileSync } = require('node:child_process');
const repository = process.cwd();
const local = createRequire(path.join(repository, 'package.json'));
const { _electron: electron, expect } = local('@playwright/test');
const { TaskScheduler } = local('./app/task-scheduler');
const executable = local('electron');
const tasks = new TaskScheduler({ executable, appPath: repository });
const evidence = process.argv[2];
assert.ok(process.platform === 'win32' && evidence && path.isAbsolute(evidence), 'Supply a fresh absolute evidence directory on Windows.');
const roots = ['source', 'target'].map(name => path.join(evidence, name));
const [source, target] = roots;
const archiveFile = path.join(evidence, 'history-archive.json');
const scheduleFile = root => path.join(root, 'schedule.json');
const write = (file, value) => fs.writeFile(file, JSON.stringify(value, null, 2), 'utf8');
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const missing = async file => assert.equal(await fs.lstat(file).then(() => false, error => { if (error.code === 'ENOENT') return true; throw error; }), true, `Expected absent: ${file}`);
const isId = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/;
let desktop;

async function close() { if (desktop) { await desktop.close(); desktop = null; } }
async function launch(root, configure) {
  const profile = path.join(root, 'electron-profile'), roaming = path.join(root, 'roaming'), localData = path.join(root, 'local');
  await Promise.all([profile, roaming, localData].map(directory => fs.mkdir(directory, { recursive: true })));
  desktop = await electron.launch({ args: [`--user-data-dir=${profile}`, repository], env: { ...process.env, APPDATA: roaming, LOCALAPPDATA: localData, COMPANION_TEST_ROOT: root, COMPANION_NATIVE_SCHEDULER: '1' } });
  const paths = await desktop.evaluate(({ app }) => ({ userData: app.getPath('userData'), sessionData: app.getPath('sessionData') }));
  for (const current of Object.values(paths)) assert.equal(path.resolve(current).toLowerCase(), profile.toLowerCase(), 'Electron profile is outside the disposable root.');
  await write(path.join(root, 'electron-paths.json'), paths);
  const page = await desktop.firstWindow();
  await expect(page.locator('#timezone')).toContainText('UTC');
  if (configure) {
    await page.getByRole('button', { name: 'Choose vault', exact: true }).click();
    await page.getByRole('button', { name: 'Use this folder', exact: true }).click();
    await expect(page.getByRole('status')).toContainText('Vault ready.');
  }
  return page;
}
async function schedule(root) {
  const file = scheduleFile(root), bytes = await fs.readFile(file);
  const state = JSON.parse(bytes.toString('utf8'));
  assert.ok(isId.test(state.id) && state.vault === path.join(root, 'vault') && state.parent === 'Companion', 'Schedule is not owned by this fixture.');
  return { file, bytes, state };
}
function matchingNativeNames(file) {
  const code = `
$ErrorActionPreference='Stop'
[Console]::InputEncoding=[Text.UTF8Encoding]::new($false,$true)
$r=[Console]::In.ReadToEnd() | ConvertFrom-Json
$s=New-Object -ComObject Schedule.Service
$s.Connect()
$folder=$s.GetFolder('\\')
$bound='^{0} "--schedule-id" "[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}"$' -f [regex]::Escape($r.arguments)
$names=@(foreach($task in $folder.GetTasks(1)){
  foreach($action in $task.Definition.Actions){
    if($action.Type -eq 0 -and $action.Path -ieq $r.executable -and ($action.Arguments -ceq $r.arguments -or $action.Arguments -cmatch $bound) -and $action.WorkingDirectory -ieq $r.directory){$task.Name; break}
  }
})
ConvertTo-Json -InputObject $names -Compress`;
  const powershell = path.join(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe');
  return JSON.parse(execFileSync(powershell, ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(code, 'utf16le').toString('base64')], { input: JSON.stringify(tasks.request('inspect', { id: 'action-only', anchor: '1970-01-01T00:00:00.000Z' }, file)), encoding: 'utf8', windowsHide: true }));
}
async function inspect(record) {
  const effective = await tasks.apply('inspect', record.state, record.file);
  assert.ok(effective && effective.enabled && tasks.matchesSchedule(effective, record.state, record.file));
  assert.equal(effective.name, `Companion-${record.state.id}`);
  assert.deepEqual(matchingNativeNames(record.file), [effective.name]);
  return effective;
}
async function cleanup() {
  const results = [];
  for (const root of [...roots].reverse()) {
    let record;
    try {
      record = await schedule(root);
      // Native disable checks the actual owner, SID and exact action before deletion.
      await tasks.apply('disable', record.state, record.file);
      assert.equal(await tasks.apply('inspect', record.state, record.file), null);
      assert.deepEqual(matchingNativeNames(record.file), []);
      results.push({ root, task: `Companion-${record.state.id}`, exactTaskAbsent: true });
    } catch (error) {
      if (!record && error.code === 'ENOENT') {
        try {
          const names = matchingNativeNames(scheduleFile(root));
          if (names.length) results.push({ root, names, error: 'Native task lacks its fixture schedule record; preserve it for exact recovery.' });
          else results.push({ root, notRegistered: true, matchingTasks: [] });
        } catch (inspectionError) { results.push({ root, error: inspectionError.message }); }
      }
      else results.push({ root, task: record && `Companion-${record.state.id}`, error: error.message });
    }
  }
  await write(path.join(evidence, 'cleanup.json'), results);
  assert.ok(results.every(result => !result.error), 'Exact owned task cleanup requires attention.');
  return results;
}

async function main() {
  await fs.mkdir(evidence); // Fail if it already exists; never touch an existing installation.
  const now = new Date().toISOString();
  await write(path.join(evidence, 'run.json'), { repository, executable, roots, started: now, label: 'Actual native Windows task registration and archive cadence reconnect; no natural timing or provider claims.' });
  for (const root of roots) {
    await fs.mkdir(root);
    await write(path.join(root, 'clock.json'), { now, timezone: 'UTC' });
  }
  try {
    const draft = path.join(source, 'producer');
    await fs.mkdir(draft);
    const sourcePage = await launch(source, true);
    await sourcePage.getByLabel('Draft source folder', { exact: true }).fill(draft);
    await sourcePage.getByRole('button', { name: 'Connect draft source', exact: true }).click();
    await expect(sourcePage.getByRole('status')).toContainText('Source connected');
    await sourcePage.getByRole('button', { name: 'Enable daily intake', exact: true }).click();
    await expect(sourcePage.getByRole('status')).toContainText('Daily intake enabled', { timeout: 15000 });
    const original = await schedule(source), originalTask = await inspect(original);
    await write(path.join(evidence, 'source-native-task.json'), originalTask);
    await write(path.join(source, 'archive-dialog.json'), { save: archiveFile });
    const sourceRegion = sourcePage.getByRole('region', { name: 'Local history archive', exact: true });
    await sourceRegion.getByRole('button', { name: 'Preview history archive', exact: true }).click();
    await sourceRegion.getByRole('button', { name: 'Export reviewed archive', exact: true }).click();
    await expect(sourceRegion).toContainText('Archive exported');
    const archiveBytes = await fs.readFile(archiveFile), archive = JSON.parse(archiveBytes.toString('utf8'));
    assert.deepEqual(archive.payload.conversations, []);
    const intent = archive.payload.scheduleIntent;
    assert.ok(intent.reconnectRequired && intent.mode === 'enabled');
    assert.equal(intent.anchor, original.state.anchor);
    assert.equal(intent.id, original.state.id);
    await close();

    await fs.cp(path.join(source, 'vault'), path.join(target, 'vault'), { recursive: true });
    await write(path.join(target, 'archive-dialog.json'), { open: archiveFile });
    const targetPage = await launch(target, true);
    const region = targetPage.getByRole('region', { name: 'Local history archive', exact: true });
    await region.getByRole('button', { name: 'Inspect history archive', exact: true }).click();
    await expect(region).toContainText('Integrity and version validated');
    await region.getByLabel('Archive vault to match', { exact: true }).selectOption(path.join(source, 'vault', 'Companion'));
    await region.getByLabel('Match archive vault to the currently selected vault', { exact: true }).check();
    await region.getByRole('button', { name: 'Preview matched restore', exact: true }).click();
    await region.getByRole('button', { name: 'Restore reviewed additions', exact: true }).click();
    await expect(region).toContainText('Imported daily intake intent is inactive');
    await missing(scheduleFile(target));
    assert.deepEqual(matchingNativeNames(scheduleFile(target)), [], 'Inactive restore or preview must not register a task.');
    const sourceRoot = path.join(source, 'vault', 'Companion'), targetRoot = path.join(target, 'vault', 'Companion');
    async function preview(view) {
      await view.getByLabel('Imported cadence to reconnect', { exact: true }).selectOption(JSON.stringify({ archiveId: archive.id, sourceRoot, targetRoot }));
      await view.getByRole('button', { name: 'Preview imported daily intake reconnect', exact: true }).click();
      return view.getByRole('button', { name: 'Reconnect reviewed daily intake', exact: true });
    }
    const confirm = await preview(region);
    await expect(region.locator('#archive-reconnect-summary')).toContainText(`Matched vault: ${targetRoot}`);
    await expect(region).toContainText(`Original anchor: ${intent.anchor}`);
    await expect(region).toContainText('A fresh local task identity will be used');
    await missing(scheduleFile(target));
    assert.deepEqual(matchingNativeNames(scheduleFile(target)), [], 'Inactive restore or preview must not register a task.');
    await confirm.click();
    await expect(region).toContainText('Imported daily intake connected', { timeout: 15000 });
    const connected = await schedule(target), connectedTask = await inspect(connected);
    assert.equal(connected.state.anchor, original.state.anchor);
    assert.notEqual(connected.state.id, original.state.id);
    assert.equal(connected.state.archiveReconnect.status, 'connected');
    assert.equal(connected.state.handledSlot, 0);
    assert.equal(connected.state.worker, undefined);
    await write(path.join(evidence, 'target-native-task.json'), connectedTask);
    await close();

    const restartedPage = await launch(target, false);
    const restarted = restartedPage.getByRole('region', { name: 'Local history archive', exact: true });
    const again = await preview(restarted);
    await expect(restarted).toContainText('This imported cadence is already connected');
    await expect(again).toBeDisabled();
    const restartedRecord = await schedule(target);
    assert.deepEqual(restartedRecord.bytes, connected.bytes);
    assert.equal((await inspect(restartedRecord)).xml, connectedTask.xml);
    const sourceNow = await schedule(source);
    assert.deepEqual(sourceNow.bytes, original.bytes);
    assert.equal((await inspect(sourceNow)).xml, originalTask.xml);
    assert.deepEqual(await fs.readFile(archiveFile), archiveBytes);
    for (const root of roots) await missing(path.join(root, 'scheduler-task.json'));
    await write(path.join(evidence, 'observed.json'), { original: { id: original.state.id, xmlSha256: digest(originalTask.xml) }, reconnected: { id: connected.state.id, xmlSha256: digest(connectedTask.xml) }, anchor: intent.anchor, archiveSha256: digest(archiveBytes), matchingTasksPerRoot: 1, originalUnchanged: true, restartIdempotent: true, finished: new Date().toISOString() });
  } finally {
    try { await close(); } finally { await cleanup(); }
  }
}
main().then(() => console.log(JSON.stringify({ evidence, gate: 'native archive cadence reconnect', passed: true }))).catch(error => { console.error(error.stack); process.exitCode = 1; });
