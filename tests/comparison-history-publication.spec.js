const { test, expect } = require('@playwright/test');
const { spawn } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const fs = require('node:fs/promises');
const local = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { installComparisons } = require('../app/comparisons');

function holdHistory(file) {
  const script = [
    '$ErrorActionPreference = "Stop"',
    '$stream = [IO.File]::Open($env:COMPANION_COMPARISON_LOCK, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read)',
    'try { [Console]::WriteLine("READY:" + $PID); [void][Console]::ReadLine() } finally { $stream.Dispose() }'
  ].join('; ');
  const child = spawn('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script], {
    windowsHide: true,
    env: { ...process.env, COMPANION_COMPARISON_LOCK: file },
    stdio: ['pipe', 'pipe', 'pipe']
  });
  let output = '';
  child.stdout.on('data', chunk => { output += chunk; });
  child.stderr.on('data', chunk => { output += chunk; });
  child.on('error', error => { output += error.message; });
  child.stdin.on('error', error => { output += error.message; });
  const closed = new Promise(resolve => child.once('close', (code, signal) => resolve({ code, signal })));
  return {
    ready: () => expect.poll(() => output).toContain(`READY:${child.pid}`),
    async release() {
      if (!child.stdin.writableEnded) child.stdin.end('\n');
      return closed;
    }
  };
}

async function exactFile(file) {
  const stat = await fs.lstat(file, { bigint: true });
  return { dev: stat.dev, ino: stat.ino, bytes: await fs.readFile(file) };
}

test.describe('Windows comparison history publication', () => {
  test.skip(process.platform !== 'win32', 'Requires native Windows FileShare.Read replacement refusal.');

  for (const replacement of ['none', 'destination', 'stage']) {
    const condition = replacement === 'none' ? 'an unchanged history lock' : `a foreign ${replacement} replacement`;
    test(`comparison retry preserves exact artifacts after ${condition}`, async () => {
      const temp = await fs.realpath(os.tmpdir());
      const root = await fs.mkdtemp(path.join(temp, 'companion-comparison-publication-'));
      const rootIdentity = await fs.lstat(root, { bigint: true });
      const record = { id: randomUUID(), text: 'Original durable comparison history.' };
      const updated = { ...record, text: 'Only the original staged comparison may publish.' };
      const moved = path.join(root, 'original-artifact');
      const nativeRename = local.renameSync;
      const attempts = [];
      let holder, stage, prior, staged, foreign;
      const store = installComparisons({ ipcMain: { handle() {} }, dataRoot: root, checkpoint: async name => {
        if (name !== 'comparison-after-rename-refusal' || attempts.length !== 1) return;
        expect(await holder.release()).toEqual({ code: 0, signal: null });
        if (replacement !== 'none') {
          const changed = replacement === 'destination' ? destination : stage;
          nativeRename(changed, moved);
          const contents = replacement === 'destination' ? Buffer.from('External history must remain byte for byte.') : staged.bytes;
          await fs.writeFile(changed, contents, { flag: 'wx' });
          foreign = await exactFile(changed);
        }
      } });
      const destination = path.join(store.directory, `${record.id}.json`);
      try {
        await store.lock(() => store.write(record, true));
        prior = await exactFile(destination);
        holder = holdHistory(destination);
        await holder.ready();
        local.renameSync = (source, target) => {
          if (target !== destination || path.dirname(source) !== store.directory || !/^[a-f0-9-]{36}\.pending$/.test(path.basename(source))) {
            return nativeRename(source, target);
          }
          if (!attempts.length) {
            stage = source;
            const { dev, ino } = local.lstatSync(stage, { bigint: true });
            staged = { dev, ino, bytes: local.readFileSync(stage) };
          }
          try {
            nativeRename(source, target);
            attempts.push({ source, code: null });
          } catch (error) {
            attempts.push({ source, code: error.code, syscall: error.syscall });
            throw error;
          }
        };
        const failure = await store.lock(() => store.write(updated)).then(() => null, error => error);
        expect(attempts[0]).toMatchObject({ source: stage, code: expect.stringMatching(/^(EPERM|EBUSY|EACCES)$/), syscall: 'rename' });
        expect(JSON.parse(staged.bytes.toString('utf8'))).toEqual(updated);
        if (replacement === 'none') {
          expect(failure).toBeNull();
          expect(attempts.at(-1)).toEqual({ source: stage, code: null });
          expect(await exactFile(destination)).toEqual(staged);
          await expect(fs.lstat(stage)).rejects.toMatchObject({ code: 'ENOENT' });
        } else {
          const replacingDestination = replacement === 'destination';
          const changed = replacingDestination ? destination : stage;
          const original = replacingDestination ? prior : staged;
          expect(await exactFile(moved)).toEqual(original);
          expect(foreign.ino).not.toBe(original.ino);
          const retainedForeign = await exactFile(changed).catch(error => ({ code: error.code }));
          expect(retainedForeign).toEqual(foreign);
          if (!replacingDestination) expect(await exactFile(destination)).toEqual(prior);
          expect(attempts).toHaveLength(1);
          expect(failure).toMatchObject({ code: replacingDestination ? 'HISTORY_CONFLICT' : 'STAGING_CHANGED' });
        }
      } finally {
        local.renameSync = nativeRename;
        if (holder) await holder.release();
        const current = await fs.lstat(root, { bigint: true });
        if (path.dirname(root) !== temp || await fs.realpath(root) !== root || current.isSymbolicLink() || current.dev !== rootIdentity.dev || current.ino !== rootIdentity.ino) {
          throw Error('The disposable comparison fixture changed identity. Preserve it for review.');
        }
        await fs.rm(root, { recursive: true });
      }
    });
  }
});
