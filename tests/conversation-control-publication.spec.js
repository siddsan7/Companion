const { test, expect } = require('@playwright/test');
const fs = require('node:fs/promises');
const local = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawn } = require('node:child_process');
const { createHash, randomUUID } = require('node:crypto');
const { performance } = require('node:perf_hooks');
const { Conversations } = require('../app/conversations');

const sharingRefusals = ['EPERM', 'EBUSY', 'EACCES'];
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const withBom = bytes => Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), bytes]);

function holdControl(file) {
  const script = [
    '$ErrorActionPreference = "Stop"',
    '$stream = [IO.File]::Open($env:COMPANION_CONTROL_FIXTURE, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read)',
    'try { [Console]::WriteLine("READY:" + $PID); [void][Console]::ReadLine() } finally { $stream.Dispose(); [Console]::WriteLine("RELEASED:" + $PID) }'
  ].join('; ');
  const child = spawn('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script], {
    windowsHide: true,
    env: { ...process.env, COMPANION_CONTROL_FIXTURE: file },
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

async function prepareRestoration(store, record) {
  const generation = randomUUID();
  const payloadStage = path.join(store.directory, `${randomUUID()}.pending`);
  const payload = Buffer.from(JSON.stringify({ ...record, generation }));
  const archiveId = randomUUID();
  await store.lock(async () => {
    await fs.writeFile(payloadStage, payload, { flag: 'wx', flush: true });
    const staged = await store.controls.file(payloadStage, store.safeDirectory());
    await store.controls.put({
      schema: 1, id: record.id, generation, phase: 'restoring',
      scope: { excludedSources: record.scope.excludedSources, excludedHistory: record.scope.excludedHistory },
      targets: [staged.owned, { ...staged.owned, name: `${record.id}.json` }],
      restoration: { archiveId, recordDigest: digest(payload) }
    });
  });
  const preview = await store.controls.resumeRestoration(record.id);
  expect(preview).toMatchObject({ id: record.id, generation, archiveId, text: payload.toString('utf8') });
  expect(preview.targets).toEqual([path.basename(payloadStage), `${record.id}.json`]);
  return { preview, payload, payloadStage, generation, archiveId };
}

async function withControlFixture(testInfo, operation, changeAfterRefusal, verify) {
  const restoring = operation === 'restoration';
  const temp = await fs.realpath(os.tmpdir());
  const root = await fs.mkdtemp(path.join(temp, 'companion-control-publication-'));
  const identity = await fs.lstat(root, { bigint: true });
  const id = randomUUID();
  const scope = { version: randomUUID(), excludedSources: ['capture:excluded-fixture'], excludedHistory: [randomUUID()] };
  const record = {
    schema: 1, id, scope, vault: { root }, brief: { id: randomUUID(), version: 1, digest: 'a'.repeat(64) },
    createdAt: '2026-11-08T12:00:00Z', requests: []
  };
  const attempts = [], checkpoints = [];
  const rename = local.renameSync, open = fs.open;
  const holdAt = restoring ? 'archive-restore-before-active' : 'conversation-delete-after-tombstone';
  let holder;
  const store = new Conversations({ dataRoot: root, getVault: () => record.vault, checkpoint: async name => {
    checkpoints.push(name);
    if (name === holdAt) {
      holder = holdControl(control);
      await holder.ready();
    }
  } });
  const recordFile = path.join(store.directory, `${id}.json`);
  const controlDirectory = path.join(store.directory, '.control');
  const control = path.join(controlDirectory, `${id}.json`);
  const independent = path.join(root, 'independent.md');
  const independentBytes = 'Independent fixture writing\n';
  let refused, change;
  try {
    store.safeDirectory(true);
    await fs.writeFile(independent, independentBytes, { flag: 'wx' });
    let restoration, preview;
    if (restoring) {
      restoration = await prepareRestoration(store, record);
      preview = restoration.preview;
    } else {
      await fs.writeFile(recordFile, JSON.stringify(record), { flag: 'wx' });
      preview = await store.controls.preview(id);
      expect(preview.targets).toEqual([`${id}.json`]);
    }

    // Each attempt still makes the real Windows rename call. Hold the next
    // retry's first read until the independent writer finishes after refusal.
    fs.open = async (...args) => { await change; return open(...args); };
    local.renameSync = (source, destination) => {
      if (destination !== control || path.dirname(source) !== controlDirectory || !/^[a-f0-9-]{36}\.pending$/.test(path.basename(source))) {
        return rename(source, destination);
      }
      try {
        rename(source, destination);
        attempts.push({ source, destination, code: null });
      } catch (error) {
        attempts.push({ source, destination, code: error.code, syscall: error.syscall });
        if (attempts.length === 1 && sharingRefusals.includes(error.code)) {
          const baseline = local.readFileSync(control), staged = local.readFileSync(source);
          const stat = local.lstatSync(source, { bigint: true });
          refused = { source, baseline, staged, dev: stat.dev, ino: stat.ino, at: performance.now() };
          if (changeAfterRefusal) {
            holder.release();
            change = holder.awaitRelease().then(() => changeAfterRefusal({ control, recordFile, baseline, restoration }));
          }
        }
        throw error;
      }
    };
    const outcome = await store.controls.confirm(preview.token, operation).then(result => ({ result }), error => ({ error }));
    const afterRefusalMs = refused ? Math.round(performance.now() - refused.at) : null;
    local.renameSync = rename; fs.open = open;
    holder?.release();
    if (holder) await holder.closed;

    await fs.writeFile(testInfo.outputPath('native-control-publication.json'), JSON.stringify({
      attempts, checkpoints, holder: holder?.proof, afterRefusalMs,
      refused: refused ? { baselineSha256: digest(refused.baseline), stagedSha256: digest(refused.staged), dev: String(refused.dev), ino: String(refused.ino) } : null,
      error: outcome.error ? { code: outcome.error.code, message: outcome.error.message } : null
    }, null, 2));
    expect(holder?.proof.exit).toEqual({ code: 0, signal: null });
    expect(holder.proof.stdout).toContain(`READY:${holder.proof.pid}`);
    expect(holder.proof.stdout).toContain(`RELEASED:${holder.proof.pid}`);
    expect(attempts[0]?.syscall).toBe('rename');
    expect(sharingRefusals).toContain(attempts[0]?.code);
    expect(refused).toBeDefined();
    expect(JSON.parse(refused.baseline).phase).toBe(restoring ? 'restoring' : 'deleting');
    expect(JSON.parse(refused.staged).phase).toBe(restoring ? 'active' : 'deleted');
    expect(checkpoints).toEqual(restoring ? ['archive-restore-after-link', holdAt] : [holdAt, 'conversation-delete-after-unlink']);
    expect(await fs.readFile(independent, 'utf8')).toBe(independentBytes);
    await verify({ attempts, outcome, refused, control, recordFile, store, id, scope, afterRefusalMs, restoration });
  } finally {
    local.renameSync = rename; fs.open = open;
    holder?.release();
    if (holder) await holder.closed;
    const current = await fs.lstat(root, { bigint: true });
    if (path.dirname(root) !== temp || await fs.realpath(root) !== root || current.isSymbolicLink() || current.dev !== identity.dev || current.ino !== identity.ino) {
      throw Error('The disposable control fixture changed identity. Preserve it for review.');
    }
    await fs.rm(root, { recursive: true });
  }
}

async function expectPublishedStage({ attempts, refused, control }) {
  expect(attempts.length).toBeGreaterThan(1);
  expect(attempts.every(attempt => attempt.source === refused.source && attempt.destination === control)).toBe(true);
  expect(attempts.slice(0, -1).every(attempt => sharingRefusals.includes(attempt.code))).toBe(true);
  expect(attempts.at(-1).code).toBeNull();
  expect(await fs.readFile(control)).toEqual(refused.staged);
  const published = await fs.lstat(control, { bigint: true });
  expect({ dev: published.dev, ino: published.ino }).toEqual({ dev: refused.dev, ino: refused.ino });
  await expect(fs.lstat(refused.source)).rejects.toMatchObject({ code: 'ENOENT' });
}

test.describe('Windows conversation control publication', () => {
  test.skip(process.platform !== 'win32', 'Requires a real Windows FileShare.Read handle that refuses replacement.');

  test('a brief sharing refusal finishes the confirmed deletion from its original control stage', async ({}, testInfo) => {
    await withControlFixture(testInfo, 'deletion', async () => {}, async ({ attempts, outcome, refused, control, recordFile, id, scope }) => {
      expect(outcome.error).toBeUndefined();
      const marker = JSON.parse(refused.staged);
      expect(outcome.result).toEqual({ id, generation: JSON.parse(refused.baseline).generation });
      expect(marker.scope).toEqual({ excludedSources: scope.excludedSources, excludedHistory: scope.excludedHistory });
      await expectPublishedStage({ attempts, refused, control });
      await expect(fs.lstat(recordFile)).rejects.toMatchObject({ code: 'ENOENT' });
    });
  });

  test('a persistent sharing refusal leaves the deleting marker and stage for explicit recovery', async ({}, testInfo) => {
    await withControlFixture(testInfo, 'deletion', null, async ({ attempts, outcome, refused, control, recordFile, store, id, afterRefusalMs }) => {
      expect(sharingRefusals).toContain(outcome.error?.code);
      expect(attempts.length).toBeGreaterThan(1);
      expect(afterRefusalMs).toBeLessThan(5000);
      expect(attempts.every(attempt => attempt.source === refused.source && sharingRefusals.includes(attempt.code))).toBe(true);
      expect(await fs.readFile(control)).toEqual(refused.baseline);
      expect(await fs.readFile(refused.source)).toEqual(refused.staged);
      await expect(fs.lstat(recordFile)).rejects.toMatchObject({ code: 'ENOENT' });
      const recovery = await store.controls.pending();
      expect(recovery.records).toEqual([expect.objectContaining({ id, remaining: [], canResume: true })]);
      expect(recovery.issues).toEqual([expect.stringContaining(path.basename(refused.source))]);
    });
  });

  test('a change to the prior marker bytes blocks another rename', async ({}, testInfo) => {
    await withControlFixture(testInfo, 'deletion', async ({ control, baseline }) => fs.writeFile(control, withBom(baseline)), async ({ attempts, outcome, refused, control }) => {
      expect(outcome.error).toBeInstanceOf(Error);
      expect(sharingRefusals).not.toContain(outcome.error.code);
      expect(attempts).toHaveLength(1);
      expect(await fs.readFile(control)).toEqual(withBom(refused.baseline));
      expect(await fs.readFile(refused.source)).toEqual(refused.staged);
    });
  });

  test('independent writing at the original payload path blocks another rename', async ({}, testInfo) => {
    const writing = 'Independently recreated writing\n';
    await withControlFixture(testInfo, 'deletion', async ({ recordFile }) => fs.writeFile(recordFile, writing, { flag: 'wx' }), async ({ attempts, outcome, refused, control, recordFile }) => {
      expect(outcome.error).toBeInstanceOf(Error);
      expect(sharingRefusals).not.toContain(outcome.error.code);
      expect(attempts).toHaveLength(1);
      expect(await fs.readFile(recordFile, 'utf8')).toBe(writing);
      expect(await fs.readFile(control)).toEqual(refused.baseline);
      expect(await fs.readFile(refused.source)).toEqual(refused.staged);
    });
  });

  test('a brief sharing refusal activates the explicitly restored conversation from its original control stage', async ({}, testInfo) => {
    await withControlFixture(testInfo, 'restoration', async () => {}, async ({ attempts, outcome, refused, control, recordFile, store, id, scope, restoration }) => {
      expect(outcome.error).toBeUndefined();
      expect(outcome.result).toEqual({ id, generation: restoration.generation });
      await expectPublishedStage({ attempts, refused, control });
      expect(await fs.readFile(recordFile)).toEqual(restoration.payload);
      expect(await store.readStored(id)).toMatchObject({ id, generation: restoration.generation, scope });
      expect(JSON.parse(refused.staged)).toMatchObject({
        phase: 'active', generation: restoration.generation, targets: [],
        restoration: { archiveId: restoration.archiveId, recordDigest: digest(restoration.payload) }
      });
      await expect(fs.lstat(restoration.payloadStage)).rejects.toMatchObject({ code: 'ENOENT' });
    });
  });

  test('a change to the restored payload bytes blocks activation and preserves writing', async ({}, testInfo) => {
    const change = ({ recordFile, restoration }) => fs.writeFile(recordFile, withBom(restoration.payload));
    await withControlFixture(testInfo, 'restoration', change, async ({ attempts, outcome, refused, control, recordFile, store, id, restoration }) => {
      expect(outcome.error).toBeInstanceOf(Error);
      expect(sharingRefusals).not.toContain(outcome.error.code);
      expect(attempts).toHaveLength(1);
      expect(await fs.readFile(recordFile)).toEqual(withBom(restoration.payload));
      expect(await fs.readFile(control)).toEqual(refused.baseline);
      expect(await fs.readFile(refused.source)).toEqual(refused.staged);
      await expect(fs.lstat(restoration.payloadStage)).rejects.toMatchObject({ code: 'ENOENT' });
      await expect(store.controls.check(JSON.parse(restoration.payload))).rejects.toThrow(/generation changed/);
    });
  });
});

async function deletionFixture(checkpoint, verify) {
  const temp = await fs.realpath(os.tmpdir());
  const root = await fs.mkdtemp(path.join(temp, 'companion-control-publication-'));
  const identity = await fs.lstat(root, { bigint: true });
  const id = randomUUID();
  const record = {
    schema: 1, id, scope: { version: randomUUID(), excludedSources: [], excludedHistory: [] },
    vault: { root }, brief: { id: randomUUID(), version: 1, digest: 'a'.repeat(64) },
    createdAt: '2026-11-08T12:00:00Z', requests: []
  };
  const store = new Conversations({ dataRoot: root, getVault: () => record.vault, checkpoint });
  try {
    store.safeDirectory(true);
    const file = path.join(store.directory, `${id}.json`), control = path.join(store.directory, '.control', `${id}.json`);
    const bytes = Buffer.from(JSON.stringify(record));
    await fs.writeFile(file, bytes, { flag: 'wx' });
    await verify({ store, record, file, control, bytes, preview: await store.controls.preview(id) });
  } finally {
    const current = await fs.lstat(root, { bigint: true });
    if (path.dirname(root) !== temp || await fs.realpath(root) !== root || current.isSymbolicLink() || current.dev !== identity.dev || current.ino !== identity.ino) {
      throw Error('The disposable deletion fixture changed identity. Preserve it for review.');
    }
    await fs.rm(root, { recursive: true });
  }
}

for (const change of ['equal-byte inode replacement', 'in-place raw-byte edit']) {
  test(`confirmed conversation deletion preserves an ${change} after the final payload read`, async () => {
    let armed = false;
    await deletionFixture(async name => { if (name === 'conversation-delete-after-tombstone') armed = true; },
      async ({ store, file, control, bytes, preview }) => {
        const open = fs.open, parked = `${file}.original`;
        let reads = 0, injected = false;
        fs.open = async (name, ...args) => {
          const handle = await open(name, ...args);
          if (name !== file || !armed || ++reads !== 2) return handle;
          const close = handle.close.bind(handle);
          handle.close = async () => {
            await close();
            if (change === 'equal-byte inode replacement') {
              await fs.rename(file, parked);
              await fs.writeFile(file, bytes, { flag: 'wx' });
            } else await fs.writeFile(file, withBom(bytes));
            injected = true;
          };
          return handle;
        };
        let outcome;
        try { outcome = await store.controls.confirm(preview.token).catch(error => error); }
        finally { fs.open = open; }
        expect(injected).toBe(true);
        expect(outcome).toBeInstanceOf(Error);
        expect(await fs.readFile(file)).toEqual(change === 'in-place raw-byte edit' ? withBom(bytes) : bytes);
        if (change === 'equal-byte inode replacement') expect(await fs.readFile(parked)).toEqual(bytes);
        expect(JSON.parse(await fs.readFile(control)).phase).toBe('deleting');
      });
  });
}

test('confirmed conversation deletion preserves a raw-byte edit made before the final payload read', async () => {
  let edit;
  await deletionFixture(async name => { if (name === 'conversation-delete-after-tombstone') await edit(); },
    async ({ store, file, control, bytes, preview }) => {
      edit = () => fs.writeFile(file, withBom(bytes));
      await expect(store.controls.confirm(preview.token)).rejects.toThrow(/deletion target changed/i);
      expect(await fs.readFile(file)).toEqual(withBom(bytes));
      expect(JSON.parse(await fs.readFile(control)).phase).toBe('deleting');
    });
});

for (const addition of ['a same-ID pending payload', 'a first-publication receipt']) {
  test(`conversation deletion leaves authority incomplete when ${addition} arrives during final stage preparation`, async () => {
    await deletionFixture(async () => {}, async ({ store, record, file, control, bytes, preview }) => {
      const additionFile = addition === 'a same-ID pending payload' ? path.join(store.directory, `${randomUUID()}.pending`) : `${file}.first-publication`;
      const content = addition === 'a same-ID pending payload' ? bytes : Buffer.from('Independent first-publication receipt bytes');
      const open = fs.open;
      let injected = false;
      fs.open = async (name, flag, ...args) => {
        const handle = await open(name, flag, ...args);
        if (flag !== 'wx' || path.dirname(name) !== path.dirname(control) || !name.endsWith('.pending')) return handle;
        const close = handle.close.bind(handle);
        handle.close = async () => {
          await close();
          if (JSON.parse(await fs.readFile(name)).phase !== 'deleted') return;
          await fs.writeFile(additionFile, content, { flag: 'wx' });
          injected = true;
        };
        return handle;
      };
      let outcome;
      try { outcome = await store.controls.confirm(preview.token).catch(error => error); }
      finally { fs.open = open; }
      expect(injected).toBe(true);
      expect(outcome).toBeInstanceOf(Error);
      expect(await fs.readFile(additionFile)).toEqual(content);
      expect(JSON.parse(await fs.readFile(control))).toMatchObject({ id: record.id, phase: 'deleting' });
    });
  });
}
