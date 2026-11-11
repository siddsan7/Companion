const { spawnSync } = require('node:child_process');
const { createHash } = require('node:crypto');
const { readFileSync } = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const utf8 = new TextDecoder('utf-8', { fatal: true });
const parsePowerShell = Buffer.from(`
$ErrorActionPreference = 'Stop'
if ($PSVersionTable.PSVersion.Major -ne 5 -or $PSVersionTable.PSVersion.Minor -ne 1) {
  throw 'Windows PowerShell 5.1 is required.'
}
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
$reader = [IO.StreamReader]::new([Console]::OpenStandardInput(), [Text.UTF8Encoding]::new($false, $true), $false)
$source = $reader.ReadToEnd()
$tokens = $null
$errors = $null
[void][System.Management.Automation.Language.Parser]::ParseInput($source, [ref]$tokens, [ref]$errors)
foreach ($errorFound in $errors) {
  [Console]::Error.WriteLine(('{0}:{1}: {2}' -f $errorFound.Extent.StartLineNumber, $errorFound.Extent.StartColumnNumber, $errorFound.Message))
}
if ($errors.Count) { exit 1 }
`, 'utf16le').toString('base64');

function run(executable, args, description, options = {}) {
  const result = spawnSync(executable, args, { cwd: root, windowsHide: true, ...options });
  if (result.error) throw new Error(`${description}\n${result.error.message}`);
  if (result.status !== 0) {
    const detail = [result.stderr, result.stdout].map(output => output.toString('utf8').trim()).filter(Boolean);
    throw new Error([description, ...detail, `Exit: ${result.status ?? result.signal}`].join('\n'));
  }
  return result.stdout;
}

function read(relative) {
  try {
    return readFileSync(path.join(root, relative));
  } catch (error) {
    throw new Error(`Cannot read ${relative}. ${error.message}`);
  }
}

function decode(bytes, name, decoder = utf8) {
  try {
    return decoder.decode(bytes);
  } catch {
    throw new Error(`Invalid UTF-8 in ${name}.`);
  }
}

function checkNativeProbe() {
  const manifestPath = 'app/native/codex-read-probe.json';
  const manifestText = decode(read(manifestPath), manifestPath);
  let manifest;
  try {
    manifest = JSON.parse(manifestText);
  } catch {
    throw new Error(`Invalid JSON in ${manifestPath}.`);
  }
  if (manifest?.schema !== 1 || manifest.platform !== 'win32' || manifest.arch !== 'x64' || manifest.textNormalization !== 'LF') {
    throw new Error(`Invalid schema or platform in ${manifestPath}.`);
  }
  const pins = [
    ['app/native/codex-read-probe.c', manifest.sourceSha256, true],
    ['scripts/build-codex-probe.ps1', manifest.buildScriptSha256, true],
    ['app/native/codex-read-probe.exe', manifest.binarySha256, false]
  ];
  for (const [relative, expected, isText] of pins) {
    const bytes = read(relative);
    const content = isText ? decode(bytes, relative).replace(/\r\n/g, '\n') : bytes;
    if (createHash('sha256').update(content).digest('hex') !== expected) {
      throw new Error(`SHA-256 mismatch for ${relative} against ${manifestPath}.`);
    }
  }
}

function check() {
  if (process.platform !== 'win32' || !process.env.SystemRoot) {
    throw new Error('Run the source check on Windows with Windows PowerShell 5.1.');
  }
  const powershell = path.join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const inventory = run('git', ['ls-files', '-z', '--', '*.js', '*.cjs', '*.ps1'], 'Cannot list tracked sources.');
  const paths = decode(inventory, 'the Git file list', new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }));
  if (!paths.endsWith('\0')) throw new Error('Git returned no tracked sources or an incomplete file list.');
  const tracked = paths.slice(0, -1).split('\0');
  const nodeEnv = { ...process.env, NODE_OPTIONS: '' };
  for (const relative of tracked) {
    const source = decode(read(relative), relative);
    if (relative.endsWith('.ps1')) {
      run(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', parsePowerShell],
        `PowerShell syntax check failed for ${relative}.`, { input: source });
    } else {
      run(process.execPath, ['--check', '--', path.join(root, relative)],
        `JavaScript syntax check failed for ${relative}.`, { env: nodeEnv });
    }
  }
  checkNativeProbe();
  console.log(`Checked ${tracked.length} tracked source files and the native probe hashes.`);
}

try {
  check();
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
