const fs = require('node:fs/promises');
const local = require('node:fs');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
const { performance } = require('node:perf_hooks');
const { setTimeout: wait } = require('node:timers/promises');
const { ordinaryDirectories, readExactSync, verifyStageSync } = require('./staged-publication');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const same = (a, b) => a && b && a.dev === b.dev && a.ino === b.ino;
const changed = () => Error('Intake ledger changed during this operation. Refresh before retrying; the changed authority was preserved.');
const ordinary = () => Error('An ordinary unlinked intake ledger is required. Preserve linked or nonordinary authority for repair.');

// One operation observes and replaces authority under Intake exclusion. A new
// ordinary file at the same path is not the file that operation reviewed.
class IntakeLedger {
  constructor(vault) { this.vault = vault; this.directory = path.join(vault.root, '.intake'); this.file = path.join(this.directory, 'ledger.json'); }
  async parents() {
    const relative = path.relative(this.vault.vault, this.directory);
    if (!relative || path.isAbsolute(relative) || relative.split(path.sep).some(part => !part || part === '.' || part === '..')) throw ordinary();
    const result = []; let current = this.vault.vault;
    for (const part of ['', ...relative.split(path.sep)]) {
      if (part) current = path.join(current, part);
      let stat;
      try { stat = await fs.lstat(current, { bigint: true }); }
      catch (error) { if (error.code === 'ENOENT' && current === this.directory) return { directories: result, missing: true }; throw error; }
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw ordinary();
      await this.vault.contained(current);
      result.push({ file: current, dev: String(stat.dev), ino: String(stat.ino) });
    }
    return { directories: result, missing: false };
  }
  async view(file = this.file) {
    const parents = await this.parents();
    let before;
    try { before = await fs.lstat(file, { bigint: true }); }
    catch (error) { if (error.code === 'ENOENT') return { parents, text: null, identity: null }; throw error; }
    if (parents.missing || !before.isFile() || before.isSymbolicLink() || before.nlink !== 1n) throw ordinary();
    const handle = await fs.open(file, 'r');
    let bytes;
    try {
      const opened = await handle.stat({ bigint: true });
      if (!same(before, opened) || opened.nlink !== 1n) throw ordinary();
      bytes = await handle.readFile();
      const after = await handle.stat({ bigint: true }), leaf = await fs.lstat(file, { bigint: true });
      if (!same(before, after) || !same(before, leaf) || !leaf.isFile() || leaf.isSymbolicLink() || after.nlink !== 1n || leaf.nlink !== 1n || before.size !== after.size || before.mtimeNs !== after.mtimeNs || leaf.size !== after.size || leaf.mtimeNs !== after.mtimeNs || BigInt(bytes.length) !== after.size) throw changed();
    } finally { await handle.close(); }
    if (JSON.stringify(await this.parents()) !== JSON.stringify(parents)) throw changed();
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    return { parents, text, identity: { dev: String(before.dev), ino: String(before.ino), digest: hash(bytes) } };
  }
  async read() { const view = await this.view(); this.expected = view; return view.text; }
  matches(view, expected = this.expected) { return !!expected && JSON.stringify(view.parents) === JSON.stringify(expected.parents) && JSON.stringify(view.identity) === JSON.stringify(expected.identity); }
  async guard() { if (!this.matches(await this.view())) throw changed(); }
  async guardParents() { if (!this.expected || JSON.stringify(await this.parents()) !== JSON.stringify(this.expected.parents)) throw changed(); }
  parentGuard(expected) {
    if (!expected || expected.parents.missing) throw changed();
    const directories = expected.parents.directories;
    return ordinaryDirectories(directories.map(item => item.file), changed().message, directories).guard;
  }
  guardSync(expected = this.expected, guard = this.parentGuard(expected)) {
    try {
      const current = readExactSync(this.file, guard, 1, expected.identity || undefined);
      if (!expected.identity || current.proof.digest !== expected.identity.digest) throw changed();
    } catch (error) {
      if (error.code === 'ENOENT' && expected.identity === null) { guard(); return; }
      if (['ENOENT', 'STAGING_CHANGED'].includes(error.code)) throw changed();
      throw error;
    }
  }
  async publish(stage, proof, expected, guard) {
    const deadline = performance.now() + 1000;
    let delay = 15, refusal;
    for (;;) {
      if (refusal && performance.now() >= deadline) throw refusal;
      this.guardSync(expected, guard);
      try { verifyStageSync(stage, guard, proof); }
      catch (error) { if (error.code === 'STAGING_CHANGED') throw changed(); throw error; }
      try { local.renameSync(stage, this.file); return; }
      catch (error) {
        const remaining = deadline - performance.now();
        if (process.platform !== 'win32' || !['EPERM', 'EBUSY', 'EACCES'].includes(error.code) || remaining <= 0) throw error;
        refusal = error;
        await wait(Math.min(delay, remaining));
        delay = Math.min(delay * 2, 100);
      }
    }
  }
  async replace(text) {
    if (!this.matches(await this.view()) || this.expected.parents.missing) throw changed();
    const stage = path.join(this.directory, `ledger-${randomUUID()}.tmp`), bytes = Buffer.from(text, 'utf8');
    const expected = this.expected, digest = hash(bytes);
    if (digest === expected.identity?.digest) return;
    const guard = this.parentGuard(expected);
    let proof;
    try {
      const handle = await fs.open(stage, 'wx');
      try {
        await handle.writeFile(bytes);
        await handle.sync();
        const own = await handle.stat({ bigint: true });
        proof = { dev: String(own.dev), ino: String(own.ino), digest };
      }
      finally { await handle.close(); }
      const prepared = await this.view(stage);
      if (!this.matches(prepared, { parents: expected.parents, identity: proof })) throw changed();
      if (!this.matches(await this.view(), expected)) throw changed();
      await this.publish(stage, proof, expected, guard);
      const published = await this.view();
      if (!this.matches(published, { parents: expected.parents, identity: proof })) throw changed();
      this.guardSync(published, guard);
      this.expected = published;
    } finally {
      if (proof) {
        // Never clean a new file or a path reached through a replaced parent.
        try {
          readExactSync(stage, guard, 1, proof);
          local.unlinkSync(stage);
        } catch (error) { if (error.code !== 'ENOENT') this.vault.warnings.push('An intake ledger stage remains for guarded inspection.'); }
      }
    }
  }
}
module.exports = { IntakeLedger };
