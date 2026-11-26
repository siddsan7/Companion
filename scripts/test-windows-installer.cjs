const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { _electron: electron, expect } = require('@playwright/test');
const { TaskScheduler } = require('../app/task-scheduler');

const hostedWindows = process.platform === 'win32' && process.env.GITHUB_ACTIONS === 'true' &&
  process.env.RUNNER_ENVIRONMENT === 'github-hosted' && process.env.RUNNER_OS === 'Windows';
if (!hostedWindows && !process.argv.slice(2).includes('--allow-visible-windows')) {
  console.error('The installer test opens visible Companion windows. Use hosted Windows CI or explicitly pass --allow-visible-windows on a coordinated disposable desktop.');
  process.exit(2);
}

// These tests register the real product in the current user's MSI database.
// Refuse to run over an existing installation, including older product codes.
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'Companion MSI '));
const install = path.join(root, 'Program');
const menu = path.join(root, 'Menu');
const profile = path.join(root, 'Profile');
const vault = path.join(root, 'Vault');
const exe = path.join(install, 'Companion.exe');
const appPath = path.join(install, 'resources/app');
const scheduleFile = path.join(profile, 'schedule.json');
const tasks = new TaskScheduler({ executable: exe, appPath, packaged: true });
const system32 = path.join(process.env.SystemRoot, 'System32');
const packageFile = v => path.resolve(__dirname, '../dist', 'Companion-' + v + '-windows-x64.msi');
const current = packageFile(require('../package.json').version);
const previous = packageFile('0.1.0');
let app, state, installed, defaultLocations;
let log = 0;
function powershell(script, environment = {}) {
  return execFileSync(path.join(system32, 'WindowsPowerShell/v1.0/powershell.exe'),
    ['-NoProfile', '-NonInteractive', '-Command', "$ErrorActionPreference='Stop'; " + script],
    { encoding: 'utf8', windowsHide: true, env: { ...process.env, ...environment } }).trim();
}
function registered() {
  return powershell("((New-Object -ComObject WindowsInstaller.Installer).RelatedProducts('{E57AA071-C0BB-4266-B083-812F2A6F5685}')) -join ','");
}
function msi(action, file, defaults = false) {
  const logfile = path.join(root, ++log + '.log');
  // MSI parses PROPERTY="value with spaces" itself. Node's default Windows
  // quoting would quote the whole assignment and display MSI command help.
  const locations = defaults ? [] : ['INSTALLFOLDER="' + install + '"', 'MENUDIR="' + menu + '"', 'COMPANIONPROFILE="' + profile + '"'];
  execFileSync(path.join(system32, 'msiexec.exe'), [action, '"' + file + '"', '/qn', '/norestart', ...locations, '/l*v', '"' + logfile + '"'],
  { windowsVerbatimArguments: true, windowsHide: true, timeout: 180000 });
  installed = action === '/i' ? file : null;
  defaultLocations = defaults;
}
async function launch() {
  const env = { ...process.env, PATH: system32, COMPANION_TEST_ROOT: path.join(root, 'unused checkout fixture') };
  delete env.ELECTRON_RUN_AS_NODE;
  app = await electron.launch({ executablePath: exe, args: ['--user-data-dir=' + profile], cwd: root, env });
  const facts = await app.evaluate(({ app }) => [app.isPackaged, app.getAppPath(), app.getPath('userData'), app.getVersion()]);
  assert.deepEqual(facts, [true, appPath, profile, installed === previous ? '0.1.0' : require('../package.json').version]);
  const catalog = fs.readFileSync(path.join(appPath, 'app/codex-model-catalog.json'));
  assert.equal(createHash('sha256').update(catalog).digest('hex'), '1fe7b99c44ff65badad9291e2a3a0e7988dbda60d57ee2132105058106282901', 'Installed catalog must match the signed-in inventory qualification.');
  return app.firstWindow();
}
async function close() { if (app) await app.close(); app = null; }
async function verifyHostedDefaults() {
  const folder = name => powershell("[Environment]::GetFolderPath('" + name + "')");
  const program = path.join(folder('LocalApplicationData'), 'Companion Desktop');
  const data = path.join(folder('ApplicationData'), 'companion');
  const start = path.join(folder('Programs'), 'Companion');
  for (const dir of [program, data, start]) assert.equal(fs.existsSync(dir), false, 'Expected a fresh hosted account: ' + dir);
  msi('/i', current, true);
  const shortcut = path.join(start, 'Companion.lnk');
  const executable = path.join(program, 'Companion.exe');
  assert.equal(powershell('(New-Object -ComObject WScript.Shell).CreateShortcut($env:LINK).TargetPath', { LINK: shortcut }), executable);
  powershell('Start-Process -FilePath $env:LINK', { LINK: shortcut });
  const mainWindow = "Get-Process Companion -ErrorAction SilentlyContinue | Where-Object { $_.Path -eq $env:EXE -and $_.MainWindowTitle -eq 'Companion' }";
  const processes = { EXE: executable };
  await expect.poll(() => powershell('@(' + mainWindow + ').Count', processes), { timeout: 30000 }).toBe('1');
  assert.equal(powershell('(' + mainWindow + ').CloseMainWindow()', processes), 'True');
  await expect.poll(() => powershell("@(Get-Process Companion -ErrorAction SilentlyContinue | Where-Object Path -eq $env:EXE).Count", processes),
    { timeout: 20000 }).toBe('0');
  assert.ok(fs.existsSync(path.join(data, 'Local State')));

  const file = path.join(data, 'schedule.json');
  const native = new TaskScheduler({ executable, appPath: path.join(program, 'resources/app'), packaged: true });
  const saved = JSON.stringify(state);
  fs.writeFileSync(file, saved, { flag: 'wx' });
  await native.apply('enable', state, file);
  try {
    msi('/x', current, true);
    assert.equal(await native.apply('inspect', state, file), null);
    assert.equal(fs.readFileSync(file, 'utf8'), saved);
    assert.equal(fs.existsSync(executable) || fs.existsSync(shortcut), false);
    assert.equal(registered(), '');

    msi('/i', current, true);
    await native.apply('enable', state, file);
    fs.writeFileSync(file, '{interrupted');
    msi('/x', current, true);
    assert.ok(await native.apply('inspect', state, file));
    assert.equal(fs.readFileSync(file, 'utf8'), '{interrupted');
    assert.equal(registered(), '');
  } finally { await native.apply('disable', state, file); }
}
async function verify() {
  console.log('Disposable evidence:', root);
  assert.equal(registered(), '', 'Run this check in an account without an installed copy of Companion.');
  for (const file of [previous, current]) {
    const sha = createHash('sha256').update(fs.readFileSync(file)).digest('hex');
    assert.equal(fs.readFileSync(file + '.sha256', 'utf8').trim(), sha + '  ' + path.basename(file));
  }
  for (const dir of [profile, vault, path.join(root, 'Producer')]) fs.mkdirSync(dir);
  msi('/i', current);
  const fresh = await launch();
  await expect(fresh.getByRole('button', { name: 'Choose vault' })).toBeVisible();
  await close();
  const unsupported = '{"schema":999}';
  fs.writeFileSync(scheduleFile, unsupported);
  msi('/x', current);
  assert.equal(fs.readFileSync(scheduleFile, 'utf8'), unsupported);
  fs.unlinkSync(scheduleFile);
  assert.equal(registered(), '');
  msi('/i', previous);
  const formerId = registered();
  assert.match(formerId, /^\{[\w-]+\}$/);
  const shortcut = path.join(menu, 'Companion.lnk');
  assert.equal(powershell('(New-Object -ComObject WScript.Shell).CreateShortcut($env:LINK).TargetPath', { LINK: shortcut }), exe);
  let page = await launch();
  await app.evaluate(({ dialog, shell }, folder) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [folder] });
    shell.openExternal = async uri => { globalThis.openedTestUri = uri; };
  }, vault);
  await page.getByRole('button', { name: 'Choose vault' }).click();
  await page.getByRole('button', { name: 'Use this folder' }).click();
  await expect(page.getByRole('status')).toContainText('Vault ready.');
  const title = 'Installer capture across restart';
  await page.getByLabel('Thought or link').fill(title);
  await page.getByRole('button', { name: 'Save capture', exact: true }).click();
  await expect(page.getByRole('heading', { name: title })).toBeVisible();
  const captures = path.join(vault, 'Companion/Captures');
  const note = path.join(captures, fs.readdirSync(captures).find(name => name.endsWith('.md')));
  const contents = fs.readFileSync(note, 'utf8');
  assert.ok(contents.includes(title));
  await page.getByRole('button', { name: 'Open in Obsidian' }).click();
  await expect.poll(() => app.evaluate(() => globalThis.openedTestUri)).toBe('obsidian://open?path=' + encodeURIComponent(note));
  assert.equal(fs.existsSync(scheduleFile), false);
  await page.getByLabel('Draft source folder').fill(path.join(root, 'Producer'));
  await page.getByRole('button', { name: 'Connect draft source', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('Source connected');
  await page.getByRole('button', { name: 'Enable daily intake', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('Daily intake enabled', { timeout: 20000 });
  state = JSON.parse(fs.readFileSync(scheduleFile));
  assert.ok(await tasks.apply('inspect', state, scheduleFile));
  const settings = fs.readFileSync(path.join(profile, 'settings.json'));
  await close();
  page = await launch();
  await expect(page.getByRole('heading', { name: title })).toBeVisible();
  await close();
  msi('/i', current);
  const nextId = registered();
  assert.match(nextId, /^\{[\w-]+\}$/);
  assert.notEqual(nextId, formerId);
  page = await launch();
  await expect(page.getByRole('heading', { name: title })).toBeVisible();
  await close();
  const nativeTask = await tasks.apply('inspect', state, scheduleFile);
  assert.ok(nativeTask.enabled);
  const { prepareProbe, auditProbe } = require(path.join(appPath, 'app/codex-probe'));
  const probe = { work: root };
  await prepareProbe(probe);
  assert.match((await auditProbe(probe)).binarySha256, /^[a-f0-9]{64}$/);
  execFileSync(path.join(system32, 'schtasks.exe'), ['/Run', '/TN', nativeTask.name]);
  await expect.poll(async () => {
    const task = await tasks.apply('inspect', state, scheduleFile);
    return task.lastRun !== nativeTask.lastRun && task.state === 3 && task.lastResult === 0;
  }, { timeout: 30000 }).toBe(true);

  // A checkout or a different installation can use the same profile. Its
  // executable/action must fail the ownership match and keep its exact task.
  const foreign = new TaskScheduler({ executable: process.execPath, appPath: root });
  await tasks.apply('disable', state, scheduleFile);
  await foreign.apply('enable', state, scheduleFile);
  try {
    execFileSync(exe, ['--user-data-dir=' + profile, '--uninstall-daily-intake'], { timeout: 20000 });
    assert.ok(await foreign.apply('inspect', state, scheduleFile));
  } finally { await foreign.apply('disable', state, scheduleFile); }
  await tasks.apply('enable', state, scheduleFile);
  const scheduleBytes = fs.readFileSync(scheduleFile);
  const sentinel = path.join(install, 'user-created.txt');
  fs.writeFileSync(sentinel, 'keep');
  msi('/x', current);
  assert.equal(registered(), '');
  assert.equal(await tasks.apply('inspect', state, scheduleFile), null);
  assert.equal(fs.existsSync(exe) || fs.existsSync(shortcut), false);
  assert.equal(fs.readFileSync(note, 'utf8'), contents);
  assert.deepEqual(fs.readFileSync(path.join(profile, 'settings.json')), settings);
  assert.deepEqual(fs.readFileSync(scheduleFile), scheduleBytes);
  assert.equal(fs.readFileSync(sentinel, 'utf8'), 'keep');
  if (hostedWindows) await verifyHostedDefaults();
  console.log('PASS: MSI installation, packaged desktop, capture, restart, optional integrations, upgrade, ownership checks and uninstall.');
}
verify().finally(async () => {
  await close();
  if (installed) msi('/x', installed, defaultLocations);
}).catch(error => { console.error(error); process.exitCode = 1; });
