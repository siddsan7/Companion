const fs = require('node:fs/promises');
const local = require('node:fs');
const path = require('node:path');
const { createHash, randomUUID, randomInt } = require('node:crypto');
const { Briefs } = require('./briefs');
const { withBriefMutation } = require('./briefs-lock');
const { fixtures, prompts } = require('./comparison-fixtures');
const hash = text => createHash('sha256').update(text).digest('hex');
const uuid = value => typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(value);

// Main owns packages and the private display mapping. Listing never generates.
class Comparisons {
  constructor({ dataRoot, getVault, clock, checkpoint }) {
    Object.assign(this, { dataRoot: path.resolve(dataRoot), getVault, clock, checkpoint });
    this.directory = path.join(this.dataRoot, 'comparisons');
    try { this.anchor(); } catch { /* Storage failure must not block capture startup. */ }
  }
  anchor() {
    if (this.rootIdentity) return;
    this.dataRoot = local.realpathSync(this.dataRoot);
    this.rootIdentity = local.statSync(this.dataRoot, { bigint: true });
    this.directory = path.join(this.dataRoot, 'comparisons');
  }
  safeDirectory(create = false, expected) {
    this.anchor();
    const same = (a, b) => a.dev === b.dev && a.ino === b.ino;
    const reject = () => { throw Error('Comparison directory is not an ordinary contained local history folder. Restore the folder before continuing.'); };
    const root = local.lstatSync(this.dataRoot, { bigint: true });
    if (!root.isDirectory() || root.isSymbolicLink() || !same(root, this.rootIdentity) || local.realpathSync(this.dataRoot) !== this.dataRoot) reject();
    if (create) { try { local.mkdirSync(this.directory); } catch (error) { if (error.code !== 'EEXIST') throw error; } }
    const directory = local.lstatSync(this.directory, { bigint: true });
    if (!directory.isDirectory() || directory.isSymbolicLink() || local.realpathSync(this.directory) !== this.directory || expected && !same(directory, expected)) reject();
    return directory;
  }
  async lock(work) {
    const directory = this.safeDirectory(true);
    return withBriefMutation(this.directory, () => { this.safeDirectory(false, directory); return work(); });
  }
  async read(id) {
    if (!uuid(id)) throw Error('Comparison identity is invalid.');
    const directory = this.safeDirectory(), file = path.join(this.directory, `${id}.json`);
    const stat = await fs.lstat(file); this.safeDirectory(false, directory);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) throw Error('Comparison is not an ordinary local history file.');
    const bytes = await fs.readFile(file); this.safeDirectory(false, directory);
    const record = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    if (record.schema !== 1 || record.id !== id || !Array.isArray(record.fixtures) || record.fixtures.length !== 3 || !Array.isArray(record.slots) || record.slots.length !== 6 || !Array.isArray(record.displayOrder) || record.displayOrder.length !== 6 || new Set(record.displayOrder).size !== 6 || record.displayOrder.some(slotId => !record.slots.some(slot => slot.id === slotId)) || record.slots.some(slot => !uuid(slot.id) || !['direct', 'analogy'].includes(slot.method) || slot.package?.digest !== hash(slot.package.text))) throw Error('Comparison history needs repair. Preserve the file.');
    return record;
  }
  async write(record) {
    await this.checkpoint('comparison-before-store');
    const directory = this.safeDirectory(), stage = path.join(this.directory, `${randomUUID()}.pending`);
    let handle;
    try {
      handle = await fs.open(stage, 'wx'); this.safeDirectory(false, directory);
      await handle.writeFile(JSON.stringify(record, null, 2), 'utf8'); await handle.sync();
      await handle.close(); handle = null; this.safeDirectory(false, directory);
      // Creation is exclusive. A preexisting record is never replaced.
      await fs.link(stage, path.join(this.directory, `${record.id}.json`));
      this.safeDirectory(false, directory);
    } finally {
      await handle?.close();
      this.safeDirectory(false, directory);
      await fs.unlink(stage).catch(error => { if (error.code !== 'ENOENT') throw error; });
    }
  }
  view(record) {
    return {
      id: record.id, createdAt: record.createdAt, brief: { id: record.brief.id, version: record.brief.version, digest: record.brief.digest },
      fixtures: record.fixtures, notice: record.notice,
      slots: record.displayOrder.map((id, index) => ({ displayId: `Output ${index + 1}`, status: record.slots.find(slot => slot.id === id).status }))
    };
  }
  async list() {
    const vault = this.getVault(); if (!vault) return { comparisons: [] };
    const directory = this.safeDirectory(true), names = await fs.readdir(this.directory);
    this.safeDirectory(false, directory);
    const records = [];
    for (const name of names) if (name.endsWith('.json')) {
      const record = await this.read(name.slice(0, -5));
      if (record.vault.root === vault.root) records.push(record);
    }
    return { comparisons: records.sort((a, b) => b.createdAt.localeCompare(a.createdAt) || a.id.localeCompare(b.id)).map(record => this.view(record)) };
  }
  async create(input) {
    return this.lock(async () => {
      const vault = this.getVault(); if (!vault) throw Error('Choose a vault first.');
      const pin = await new Briefs(vault).pinned(input?.briefVersion);
      if (pin.issues.length) throw Error('MyTune brief inputs changed or are unavailable. Review and approve a current brief before creating a comparison.');
      const brief = { id: pin.id, version: pin.version, digest: pin.digest, snapshot: structuredClone(pin) };
      const slots = [];
      for (const fixture of fixtures) {
        // Fit labels are inspection metadata, never part of a model request.
        const source = { id: fixture.id, version: fixture.version, synthetic: true, passages: fixture.passages, limitations: fixture.limitations };
        const shared = JSON.stringify({ source, brief }, null, 2).replace(/\r\n?/g, '\n');
        for (const method of ['direct', 'analogy']) {
          const text = `Synthetic comparison input. Authored source material is not actual reel evidence.\n\n${shared}\n\n${prompts[method].text}`;
          const count = [...text].length;
          if (count > 32000) throw Error('Comparison package exceeds 32000 Unicode code points. Nothing was shortened. Review a smaller brief explicitly.');
          slots.push({ id: randomUUID(), fixtureId: fixture.id, method, status: 'pending', prompt: structuredClone(prompts[method]), package: { text, digest: hash(text), sharedInputDigest: hash(shared), count, limit: 32000 }, reply: '', usage: null, elapsedMs: null });
        }
      }
      const displayOrder = slots.map(slot => slot.id);
      for (let i = displayOrder.length - 1; i > 0; i--) { const j = randomInt(i + 1); [displayOrder[i], displayOrder[j]] = [displayOrder[j], displayOrder[i]]; }
      const record = { schema: 1, id: randomUUID(), createdAt: this.clock().now, vault: { root: vault.root }, brief, fixtures: structuredClone(fixtures), slots, displayOrder,
        notice: 'Synthetic exploratory comparison: three authored cases, six outcome slots. No generation has run. No equal consumption, statistical reliability or numerical release threshold is established.' };
      // Brief and selected input bytes must still be current at publication.
      if (JSON.stringify(await new Briefs(vault).pinned(pin.version)) !== JSON.stringify(pin) || this.getVault()?.root !== vault.root) throw Error('Approved brief or vault changed. Review it and create the comparison again.');
      await this.write(record); return this.view(record);
    });
  }
}
function installComparisons({ ipcMain, ...options }) {
  const store = new Comparisons(options);
  ipcMain.handle('comparison-list', () => store.list());
  ipcMain.handle('comparison-create', (_, input) => store.create(input));
  return store;
}
module.exports = { installComparisons };
