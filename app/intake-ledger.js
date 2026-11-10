const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
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
  async guardParents() { if (!this.expected || JSON.stringify(await this.parents()) !== JSON.stringify(this.expected.parents)) throw changed(); }
  async replace(text) {
    if (!this.matches(await this.view()) || this.expected.parents.missing) throw changed();
    if (hash(Buffer.from(text, 'utf8')) === this.expected.identity?.digest) return;
    const stage = path.join(this.directory, `ledger-${randomUUID()}.tmp`), bytes = Buffer.from(text, 'utf8');
    let own;
    try {
      const handle = await fs.open(stage, 'wx');
      try { await handle.writeFile(bytes); await handle.sync(); own = await handle.stat({ bigint: true }); }
      finally { await handle.close(); }
      const prepared = await this.view(stage);
      if (prepared.identity?.dev !== String(own.dev) || prepared.identity?.ino !== String(own.ino) || prepared.identity?.digest !== hash(bytes) || JSON.stringify(prepared.parents) !== JSON.stringify(this.expected.parents)) throw changed();
      if (!this.matches(await this.view())) throw changed();
      await fs.rename(stage, this.file);
      const published = await this.view();
      if (published.identity?.dev !== String(own.dev) || published.identity?.ino !== String(own.ino) || published.identity?.digest !== hash(bytes) || JSON.stringify(published.parents) !== JSON.stringify(this.expected.parents)) throw changed();
      this.expected = published;
    } finally {
      if (own) {
        // Never clean a new file or a path reached through a replaced parent.
        try {
          if (JSON.stringify(await this.parents()) === JSON.stringify(this.expected.parents)) {
            const remaining = await this.view(stage);
            if (remaining.identity?.dev === String(own.dev) && remaining.identity?.ino === String(own.ino) && remaining.identity?.digest === hash(bytes)) await fs.unlink(stage);
          }
        } catch (error) { if (error.code !== 'ENOENT') this.vault.warnings.push('An intake ledger stage remains for guarded inspection.'); }
      }
    }
  }
}
module.exports = { IntakeLedger };
