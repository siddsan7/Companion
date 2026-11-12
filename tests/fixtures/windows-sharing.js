const { expect } = require('@playwright/test');
const { spawn } = require('node:child_process');

const sharingRefusals = ['EPERM', 'EBUSY', 'EACCES'];

function holdReadSharing(file) {
  const script = [
    '$ErrorActionPreference = "Stop"',
    '$stream = [IO.File]::Open($env:COMPANION_SHARING_FIXTURE, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read)',
    'try { [Console]::WriteLine("READY:" + $PID); [void][Console]::ReadLine() } finally { $stream.Dispose(); [Console]::WriteLine("RELEASED:" + $PID) }'
  ].join('; ');
  const child = spawn('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script], {
    windowsHide: true,
    env: { ...process.env, COMPANION_SHARING_FIXTURE: file },
    stdio: ['pipe', 'pipe', 'pipe']
  });
  const proof = { pid: child.pid, file, access: 'FileAccess.Read', share: 'FileShare.Read', stdout: '', stderr: '' };
  child.stdout.on('data', chunk => { proof.stdout += chunk.toString(); });
  child.stderr.on('data', chunk => { proof.stderr += chunk.toString(); });
  child.on('error', error => { proof.error = error.message; });
  child.stdin.on('error', error => { proof.inputError = error.message; });
  const closed = new Promise(resolve => child.once('close', (code, signal) => {
    proof.exit = { code, signal };
    resolve();
  }));
  let released = false;
  return {
    proof,
    async ready() {
      await expect.poll(() => {
        if (proof.error || proof.exit) throw Error(JSON.stringify(proof));
        return proof.stdout;
      }).toContain(`READY:${child.pid}`);
    },
    release() {
      if (!released) {
        released = true;
        child.stdin.end('\n');
      }
    },
    async awaitRelease() {
      await expect.poll(() => {
        if (proof.error || proof.exit?.code) throw Error(JSON.stringify(proof));
        return proof.stdout;
      }, { intervals: [5, 10, 20, 40] }).toContain(`RELEASED:${child.pid}`);
    },
    closed
  };
}

module.exports = { holdReadSharing, sharingRefusals };
