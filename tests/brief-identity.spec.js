const { test, expect } = require('@playwright/test');
const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { Briefs } = require('../app/briefs');
const { Context } = require('../app/context');
const { Vault } = require('../app/vault');

const now = '2026-11-08T12:00:00Z';
const execute = promisify(execFile);

async function fixture(testInfo) {
  const root = testInfo.outputPath('brief-fixture');
  const vault = new Vault(path.join(root, 'vault'), 'Companion');
  await vault.setup();
  const readme = path.join(root, 'README.md');
  await fs.writeFile(readme, '# MyTune\n\nA guitar practice tutor.\n');
  const restart = () => new Briefs(new Vault(vault.vault, 'Companion'));
  async function propose(briefs = restart()) {
    const { proposed } = await briefs.propose([readme], now);
    return {
      id: proposed.id,
      digest: proposed.digest,
      sections: proposed.sections.map(section => section.text),
      references: proposed.sections.map(section => section.references
        .map(ref => `${ref.source + 1}:${ref.start}-${ref.end}`).join(', '))
    };
  }
  async function approve(briefs = restart()) {
    const request = await propose(briefs);
    const { approved } = await briefs.approve(request, now);
    const record = approved.find(brief => brief.id === request.id);
    expect(record).toBeDefined();
    return { record, file: path.join(briefs.dir, record.file), request };
  }
  async function archiveFile(name) {
    const directory = path.join(vault.vault, 'Project writing', 'History');
    await fs.mkdir(directory, { recursive: true });
    return path.join(directory, name);
  }
  return { root, vault, restart, propose, approve, archiveFile };
}

async function interruptedApproval(vault, request, at) {
  const child = `
    const fs = require('node:fs');
    const path = require('node:path');
    const { Briefs } = require('./app/briefs');
    const { Vault } = require('./app/vault');
    const [vault, input, now, at] = process.argv.slice(1);
    const briefs = new Briefs(new Vault(vault, 'Companion'));
    const link = fs.linkSync;
    fs.linkSync = (from, to) => {
      if (path.dirname(from) !== briefs.dir || path.dirname(to) !== briefs.dir ||
          !path.basename(from).startsWith('.brief-stage-') || !path.basename(to).startsWith('approved-2-')) {
        return link(from, to);
      }
      if (at === 'before') process.exit(71);
      link(from, to);
      process.exit(72);
    };
    briefs.approve(JSON.parse(input), now).then(() => {
      console.error('Approval did not reach the filesystem interruption.');
      process.exitCode = 73;
    }, error => {
      console.error(error);
      process.exitCode = 74;
    });
  `;
  await expect(execute(process.execPath, ['-e', child, vault.vault, JSON.stringify(request), now, at], {
    cwd: path.resolve(__dirname, '..'), windowsHide: true
  })).rejects.toMatchObject({ code: at === 'before' ? 71 : 72 });
}

async function interruptedFiles(briefs) {
  const names = await fs.readdir(briefs.dir);
  const stages = names.filter(name => name.startsWith('.brief-stage-'));
  const destinations = names.filter(name => name.startsWith('approved-2-'));
  expect(stages).toHaveLength(1);
  return {
    stage: path.join(briefs.dir, stages[0]),
    published: destinations.map(name => path.join(briefs.dir, name))
  };
}

async function interruptMarkerOpen(root, vault, marker, request = null) {
  const trace = path.join(root, 'interrupted-marker-path.txt');
  const child = `
    const fs = require('node:fs');
    const path = require('node:path');
    const { Briefs } = require('./app/briefs');
    const { Vault } = require('./app/vault');
    const [vault, input, now, marker, trace] = process.argv.slice(1);
    const briefs = new Briefs(new Vault(vault, 'Companion'));
    const open = fs.promises.open;
    fs.promises.open = async (file, flags, ...args) => {
      const handle = await open(file, flags, ...args);
      if (flags === 'wx' && path.dirname(file) === briefs.dir) {
        const name = path.basename(file);
        if (name === marker || name.startsWith(marker + '.')) {
          fs.writeFileSync(trace, file, { flag: 'wx' });
          process.exit(75);
        }
      }
      return handle;
    };
    const operation = JSON.parse(input);
    const result = operation ? briefs.approve(operation, now) : briefs.pinned(1);
    result.then(() => {
      console.error('Approval did not reach the marker open interruption.');
      process.exitCode = 76;
    }, error => {
      console.error(error);
      process.exitCode = 77;
    });
  `;
  await expect(execute(process.execPath, ['-e', child, vault.vault, JSON.stringify(request), now, marker, trace], {
    cwd: path.resolve(__dirname, '..'), windowsHide: true
  })).rejects.toMatchObject({ code: 75 });
  const opened = await fs.readFile(trace, 'utf8');
  expect((await fs.lstat(opened)).size).toBe(0);
}

async function makeLegacy(briefs, first) {
  const receipt = path.join(briefs.dir, '.brief-approval-1.json');
  const modern = await fs.readFile(first.file, 'utf8');
  const legacy = modern.replace(/^managed_parent: .*\r?\n/m, '');
  expect(legacy).not.toBe(modern);
  const digest = createHash('sha256').update(legacy).digest('hex');
  const canonical = path.join(briefs.dir, `approved-1-${digest}.md`);
  await fs.unlink(receipt);
  await fs.unlink(first.file);
  await fs.writeFile(canonical, legacy, { flag: 'wx' });
  return { legacy, digest, canonical };
}

test('an approved brief keeps its exact pin and discovery entry after a vault move', async ({}, testInfo) => {
  const { root, vault, restart, approve, archiveFile } = await fixture(testInfo);
  const { record, file } = await approve();
  const bytes = await fs.readFile(file);
  const moved = await archiveFile('Early MyTune plan.md');
  await fs.rename(file, moved);

  const pin = { id: record.id, version: record.version, digest: record.digest };
  await expect.soft(restart().pinned(1)).resolves.toMatchObject({
    ...pin, sources: record.sources, sections: record.sections
  });
  const discovered = await new Context(vault, { scopeFile: path.join(root, 'app', 'notes.json') }).corpus();
  expect.soft(discovered.all).toEqual(expect.arrayContaining([
    expect.objectContaining({ key: 'brief:1', briefVersion: 1, digest: record.digest })
  ]));
  expect(await fs.readFile(moved)).toEqual(bytes);
  await expect(fs.lstat(file)).rejects.toMatchObject({ code: 'ENOENT' });
});

test('a missing approved brief keeps its version reserved for historical pins', async ({}, testInfo) => {
  const { root, restart, approve } = await fixture(testInfo);
  const { record, file } = await approve();
  const bytes = await fs.readFile(file);
  const backup = path.join(root, 'Retained original outside vault.md');
  await fs.rename(file, backup);

  const newer = await approve();
  expect.soft(newer.record).toMatchObject({ version: 2 });
  expect.soft(newer.record.id).not.toBe(record.id);
  await expect.soft(restart().pinned(1)).rejects.toThrow(/unavailable/i);
  await expect.soft(restart().pinned(2)).resolves.toMatchObject({ id: newer.record.id, digest: newer.record.digest });
  expect(await fs.readFile(backup)).toEqual(bytes);
});

test('a renamed duplicate holds its own approved version and preserves other pins', async ({}, testInfo) => {
  const { restart, approve, archiveFile } = await fixture(testInfo);
  const first = await approve();
  const second = await approve();
  const duplicate = await archiveFile('Copy of the early MyTune plan.md');
  const bytes = await fs.readFile(first.file);
  await fs.copyFile(first.file, duplicate, require('node:fs').constants.COPYFILE_EXCL);

  await expect.soft(restart().pinned(1)).rejects.toThrow(/duplicate|ambiguous/i);
  await expect.soft(restart().pinned(2)).resolves.toMatchObject({ id: second.record.id, digest: second.record.digest });
  expect(await fs.readFile(first.file)).toEqual(bytes);
  expect(await fs.readFile(duplicate)).toEqual(bytes);
});

test('editing a moved approval holds its own pin without affecting another version', async ({}, testInfo) => {
  const { restart, approve, archiveFile } = await fixture(testInfo);
  const first = await approve();
  const second = await approve();
  const moved = await archiveFile('Changed early MyTune plan.md');
  await fs.rename(first.file, moved);
  await fs.appendFile(moved, '\nUnreviewed changes after the move.\n');
  const edited = await fs.readFile(moved);

  await expect.soft(restart().pinned(1)).rejects.toThrow(/integrity|changed/i);
  await expect.soft(restart().pinned(2)).resolves.toMatchObject({ id: second.record.id, digest: second.record.digest });
  expect(await fs.readFile(moved)).toEqual(edited);
});

test('a legacy canonical approval observed before moving keeps its pin and version', async ({}, testInfo) => {
  const { restart, approve, archiveFile } = await fixture(testInfo);
  const first = await approve();
  const { legacy, digest, canonical } = await makeLegacy(restart(), first);

  const pin = { id: first.record.id, version: 1, digest };
  await expect(restart().pinned(1)).resolves.toMatchObject(pin);
  const moved = await archiveFile('Legacy MyTune brief.md');
  await fs.rename(canonical, moved);
  await expect.soft(restart().pinned(1)).resolves.toMatchObject(pin);
  const next = await approve();
  expect.soft(next.record.version).toBe(2);
  expect(await fs.readFile(moved, 'utf8')).toBe(legacy);
});

test('a readable approval rename inside Briefs resolves the original receipt', async ({}, testInfo) => {
  const { restart, approve } = await fixture(testInfo);
  const first = await approve();
  const moved = path.join(restart().dir, 'approved-1-MyTune.md');
  const bytes = await fs.readFile(first.file);
  await fs.rename(first.file, moved);

  await expect.soft(restart().pinned(1)).resolves.toMatchObject({
    id: first.record.id, version: 1, digest: first.record.digest
  });
  expect(await fs.readFile(moved)).toEqual(bytes);
});

test('retrying an already reserved approval cannot give the same proposal a new version', async ({}, testInfo) => {
  const { root, restart, approve } = await fixture(testInfo);
  const first = await approve();
  const retained = path.join(root, 'Missing approved original.md');
  const bytes = await fs.readFile(first.file);
  await fs.rename(first.file, retained);

  const attempt = await restart().approve(first.request, now).catch(error => error);
  if (attempt instanceof Error) expect(attempt.message).toMatch(/unavailable|missing|already approved/i);
  await expect(restart().pinned(2)).rejects.toThrow(/unavailable/i);
  expect(await fs.readFile(retained)).toEqual(bytes);
});

test('a moved approval in a sibling Briefs folder leaves both parents on their own exact pins', async ({}, testInfo) => {
  const { root, vault, restart, approve } = await fixture(testInfo);
  const sibling = new Vault(vault.vault, 'Other managed parent');
  await sibling.setup();
  const other = new Briefs(sibling);
  const first = await approve();
  const second = await approve(other);
  const moved = path.join(other.dir, first.record.file);
  const bytes = await fs.readFile(first.file);
  await fs.rename(first.file, moved);

  await expect.soft(restart().pinned(1)).resolves.toMatchObject({
    id: first.record.id, digest: first.record.digest
  });
  await expect.soft(other.pinned(1)).resolves.toMatchObject({
    id: second.record.id, digest: second.record.digest
  });
  for (const [selected, approval] of [[vault, first], [sibling, second]]) {
    const scopeFile = path.join(root, path.basename(selected.root), 'notes.json');
    const { all } = await new Context(selected, { scopeFile }).corpus();
    expect.soft(all.filter(source => source.key.startsWith('brief:'))).toMatchObject([
      { key: 'brief:1', digest: approval.record.digest }
    ]);
  }
  expect(await fs.readFile(moved)).toEqual(bytes);
});

test('a sibling move into an empty Briefs folder does not reserve a local approval number', async ({}, testInfo) => {
  const { vault, restart, approve } = await fixture(testInfo);
  const sibling = new Vault(vault.vault, 'Other managed parent');
  await sibling.setup();
  const other = new Briefs(sibling);
  const first = await approve();
  const moved = path.join(other.dir, first.record.file);
  await fs.rename(first.file, moved);

  const second = await approve(other);
  expect(second.record.version).toBe(1);
  await expect(other.pinned(1)).resolves.toMatchObject({ id: second.record.id, digest: second.record.digest });
  await expect(restart().pinned(1)).resolves.toMatchObject({ id: first.record.id, digest: first.record.digest });
});

test('an interrupted unpublished approval can be explicitly retried at its original version', async ({}, testInfo) => {
  const { vault, restart, propose, approve } = await fixture(testInfo);
  const first = await approve();
  const request = await propose();
  await interruptedApproval(vault, request, 'before');
  const { stage, published } = await interruptedFiles(restart());
  const originalStage = await fs.readFile(stage);
  expect(published).toEqual([]);
  await expect(restart().pinned(1)).resolves.toMatchObject({ id: first.record.id, digest: first.record.digest });
  await expect(restart().pinned(2)).rejects.toThrow(/unavailable/i);
  expect((await restart().state()).approved.map(record => record.version)).toEqual([1]);

  const result = await restart().approve(request, now);
  expect(result.approved.map(record => [record.version, record.id])).toEqual([[2, request.id], [1, first.record.id]]);
  const pin = await restart().pinned(2);
  expect(await fs.readFile(path.resolve(restart().dir, pin.file))).toEqual(originalStage);
  await expect(fs.lstat(stage)).rejects.toMatchObject({ code: 'ENOENT' });
});

test('an interrupted linked approval settles the exact peer and keeps its original version', async ({}, testInfo) => {
  const { vault, restart, propose, approve } = await fixture(testInfo);
  const first = await approve();
  const request = await propose();
  await interruptedApproval(vault, request, 'after');
  const { stage, published } = await interruptedFiles(restart());
  expect(published).toHaveLength(1);
  const [destination] = published;
  const staged = await fs.lstat(stage, { bigint: true });
  const linked = await fs.lstat(destination, { bigint: true });
  expect([staged.dev, staged.ino, staged.nlink]).toEqual([linked.dev, linked.ino, 2n]);
  const bytes = await fs.readFile(destination);
  const digest = createHash('sha256').update(bytes).digest('hex');
  await expect(restart().pinned(1)).resolves.toMatchObject({ id: first.record.id, digest: first.record.digest });

  await expect(restart().pinned(2)).resolves.toMatchObject({ id: request.id, version: 2, digest });
  await expect(fs.lstat(stage)).rejects.toMatchObject({ code: 'ENOENT' });
  expect((await fs.lstat(destination)).nlink).toBe(1);
  expect(await fs.readFile(destination)).toEqual(bytes);
  const repeated = await restart().approve(request, now);
  expect(repeated.approved.map(record => [record.version, record.id])).toEqual([[2, request.id], [1, first.record.id]]);
});

for (const at of ['before', 'after']) test(`an interrupted approval preserves a changed ${at === 'before' ? 'stage before linking' : 'destination after linking'}`, async ({}, testInfo) => {
  const { root, vault, restart, propose, approve } = await fixture(testInfo);
  const first = await approve();
  const request = await propose();
  await interruptedApproval(vault, request, at);
  const { stage, published } = await interruptedFiles(restart());
  const changed = at === 'before' ? stage : published[0];
  expect(changed).toBeDefined();
  const retained = path.join(root, 'Retained original approved bytes.md');
  const original = await fs.readFile(changed);
  await fs.rename(changed, retained);
  const foreign = Buffer.from('Independent writing at the interrupted approval path.\n');
  await fs.writeFile(changed, foreign, { flag: 'wx' });

  await expect(restart().pinned(1)).resolves.toMatchObject({ id: first.record.id, digest: first.record.digest });
  await expect(restart().pinned(2)).rejects.toThrow(/held|integrity|changed/i);
  await expect(restart().approve(request, now)).rejects.toThrow(/held|integrity|changed/i);
  expect(await fs.readFile(changed)).toEqual(foreign);
  expect(await fs.readFile(retained)).toEqual(original);
  if (at === 'before') expect((await fs.readdir(restart().dir)).filter(name => name.startsWith('approved-2-'))).toEqual([]);
  else expect(await fs.readFile(stage)).toEqual(original);
});

test('an exit before writing the pending approval marker leaves explicit retry available', async ({}, testInfo) => {
  const { root, vault, restart, propose, approve } = await fixture(testInfo);
  const first = await approve();
  const request = await propose();
  await interruptMarkerOpen(root, vault, '.brief-approval-2.pending.json', request);
  const { published } = await interruptedFiles(restart());
  expect(published).toEqual([]);
  await expect(restart().pinned(1)).resolves.toMatchObject({ id: first.record.id, digest: first.record.digest });

  await expect.soft(restart().pinned(2)).rejects.toThrow(/unavailable/i);
  const repeated = await restart().approve(request, now);
  expect(repeated.approved.map(record => [record.version, record.id])).toEqual([[2, request.id], [1, first.record.id]]);
});

test('an exit before writing the permanent approval marker leaves the exact linked approval recoverable', async ({}, testInfo) => {
  const { root, vault, restart, propose, approve } = await fixture(testInfo);
  const first = await approve();
  const request = await propose();
  await interruptMarkerOpen(root, vault, '.brief-approval-2.json', request);
  const { stage, published } = await interruptedFiles(restart());
  expect(published).toHaveLength(1);
  const [destination] = published;
  const before = await fs.lstat(destination, { bigint: true });
  const stageBefore = await fs.lstat(stage, { bigint: true });
  expect([before.dev, before.ino, before.nlink]).toEqual([stageBefore.dev, stageBefore.ino, 2n]);
  const bytes = await fs.readFile(destination);
  const digest = createHash('sha256').update(bytes).digest('hex');
  await expect(restart().pinned(1)).resolves.toMatchObject({ id: first.record.id, digest: first.record.digest });

  await expect.soft(restart().pinned(2)).resolves.toMatchObject({ id: request.id, version: 2, digest });
  await expect.soft(fs.lstat(stage)).rejects.toMatchObject({ code: 'ENOENT' });
  expect(await fs.readFile(destination)).toEqual(bytes);
});

test('an exit before writing an observed legacy approval marker preserves its canonical pin', async ({}, testInfo) => {
  const { root, vault, restart, approve, archiveFile } = await fixture(testInfo);
  const first = await approve();
  const { legacy, digest, canonical } = await makeLegacy(restart(), first);
  await interruptMarkerOpen(root, vault, '.brief-approval-1.json');

  await expect(restart().pinned(1)).resolves.toMatchObject({ id: first.record.id, digest });
  const moved = await archiveFile('Observed legacy brief.md');
  await fs.rename(canonical, moved);
  await expect(restart().pinned(1)).resolves.toMatchObject({ id: first.record.id, digest });
  expect(await fs.readFile(moved, 'utf8')).toBe(legacy);
});
