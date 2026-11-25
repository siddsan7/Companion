const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { createHash } = require('node:crypto');
const assert = require('node:assert/strict');

function identity(stat) {
  return { Volume: String(stat.dev), Index: String(stat.ino), Born: String(stat.birthtimeNs / 100n + 116444736000000000n) };
}
function identityFromEntry({ Volume, Index, Born }) { return { Volume, Index, Born }; }
function openTrace(root) {
  const stat = fs.lstatSync(root, { bigint: true });
  assert(stat.isDirectory() && fs.realpathSync.native(root) === root);
  const entries = [{ Relative: '', Directory: true, ...identity(stat) }];
  return { root, entries };
}
function observe(trace, relative, directory = false) {
  assert(!path.isAbsolute(relative) && relative.split(path.sep).every(part => part && part !== '.' && part !== '..'));
  assert.deepEqual(identity(fs.lstatSync(trace.root, { bigint: true })), identityFromEntry(trace.entries[0]));
  const file = path.join(trace.root, relative);
  assert(fs.realpathSync.native(file) === file);
  const stat = fs.lstatSync(file, { bigint: true });
  assert(directory ? stat.isDirectory() : stat.isFile() && stat.nlink === 1n);
  const entry = { Relative: relative, Directory: directory, ...identity(stat) };
  if (!directory) {
    const descriptor = fs.openSync(file, 'r');
    try {
      assert.deepEqual(identity(fs.fstatSync(descriptor, { bigint: true })), identity(stat));
      const bytes = fs.readFileSync(descriptor);
      entry.Digest = createHash('sha256').update(bytes).digest('hex');
      trace.entries.push(entry);
      return bytes;
    } finally { fs.closeSync(descriptor); }
  }
  trace.entries.push(entry);
}
function retireTrace(trace) {
  const shell = path.join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const result = spawnSync(shell, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File',
    path.join(__dirname, 'retire-chat-trace.ps1')], { windowsHide: true, encoding: 'utf8', input: JSON.stringify(trace), timeout: 30000 });
  if (result.status !== 0 || result.error) throw Error('Trace cleanup incomplete. Inspect the disposable staging directory.');
}
module.exports = { openTrace, observe, retireTrace };
