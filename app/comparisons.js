const fs = require('node:fs/promises');
const local = require('node:fs');
const path = require('node:path');
const { createHash, randomUUID, randomInt } = require('node:crypto');
const { performance } = require('node:perf_hooks');
const { Briefs } = require('./briefs');
const { withBriefMutation } = require('./briefs-lock');
const { fixtures, prompts } = require('./comparison-fixtures');
const hash = text => createHash('sha256').update(text).digest('hex');
const uuid = value => typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(value);
function makePackage(brief, fixture, method) {
  // Fit labels are inspection metadata, never part of a model request.
  const source = { id: fixture.id, version: fixture.version, synthetic: true, passages: fixture.passages, limitations: fixture.limitations };
  const shared = JSON.stringify({ source, brief }, null, 2).replace(/\r\n?/g, '\n');
  const text = `Synthetic comparison input. Authored source material is not actual reel evidence.\n\n${shared}\n\n${prompts[method].text}`;
  return { text, digest: hash(text), sharedInputDigest: hash(shared), count: [...text].length, limit: 32000 };
}

// Main owns packages and the private display mapping. Listing never generates.
class Comparisons {
  constructor({ dataRoot, getVault, clock, checkpoint, provider, getEvidence }) {
    Object.assign(this, { dataRoot: path.resolve(dataRoot), getVault, clock, checkpoint, provider, getEvidence });
    this.tokens = new Map(); this.running = new Set(); this.unsaved = new Map(); this.durable = new Map();
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
    if (this.unsaved.has(id)) return structuredClone(this.unsaved.get(id));
    return this.readStored(id);
  }
  async readStored(id) {
    if (!uuid(id)) throw Error('Comparison identity is invalid.');
    const directory = this.safeDirectory(), file = path.join(this.directory, `${id}.json`);
    const stat = await fs.lstat(file); this.safeDirectory(false, directory);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) throw Error('Comparison is not an ordinary local history file.');
    const bytes = await fs.readFile(file); this.safeDirectory(false, directory);
    const record = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    if (record.schema !== 1 || record.id !== id || !Array.isArray(record.fixtures) || record.fixtures.length !== 3 || !Array.isArray(record.slots) || record.slots.length !== 6 || !Array.isArray(record.displayOrder) || record.displayOrder.length !== 6 || new Set(record.displayOrder).size !== 6 || record.displayOrder.some(slotId => !record.slots.some(slot => slot.id === slotId)) || record.slots.some(slot => !uuid(slot.id) || !['direct', 'analogy'].includes(slot.method) || slot.package?.digest !== hash(slot.package.text))) throw Error('Comparison history needs repair. Preserve the file.');
    const pairs = record.slots.map(slot => `${slot.fixtureId}:${slot.method}`);
    if (new Set(pairs).size !== 6 || fixtures.some(fixture => ['direct', 'analogy'].some(method => !pairs.includes(`${fixture.id}:${method}`))) || record.slots.some(slot => !['pending', 'inProgress', 'completed', 'failed', 'interrupted'].includes(slot.status))) throw Error('Comparison outcome slots need repair. Preserve the file.');
    this.durable.set(id, hash(bytes)); return record;
  }
  async write(record, create = false) {
    await this.checkpoint('comparison-before-store');
    const directory = this.safeDirectory(), stage = path.join(this.directory, `${randomUUID()}.pending`);
    let handle;
    try {
      handle = await fs.open(stage, 'wx'); this.safeDirectory(false, directory);
      const text = JSON.stringify(record, null, 2);
      await handle.writeFile(text, 'utf8'); await handle.sync();
      await handle.close(); handle = null; this.safeDirectory(false, directory);
      const destination = path.join(this.directory, `${record.id}.json`);
      if (create) await fs.link(stage, destination);
      else {
        const expected = this.durable.get(record.id);
        const directoryIdentity = this.safeDirectory(false, directory), stat = await fs.lstat(destination);
        this.safeDirectory(false, directoryIdentity);
        if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || !expected) throw Error('Comparison history changed or is unavailable. Preserve the retained text.');
        const bytes = await fs.readFile(destination); this.safeDirectory(false, directory);
        if (hash(bytes) !== expected) throw Error('Comparison history changed in another process. Existing history was not replaced.');
        const deadline = performance.now() + 1000; let delay = 15;
        while (true) {
          try { this.safeDirectory(false, directory); await fs.rename(stage, destination); this.safeDirectory(false, directory); break; }
          catch (error) {
            const remaining = deadline - performance.now();
            if (process.platform !== 'win32' || !['EPERM', 'EBUSY', 'EACCES'].includes(error.code) || remaining <= 0) throw error;
            await new Promise(resolve => setTimeout(resolve, Math.min(delay, remaining))); delay = Math.min(delay * 2, 100);
          }
        }
      }
      this.safeDirectory(false, directory);
      this.durable.set(record.id, hash(text));
    } finally {
      await handle?.close();
      this.safeDirectory(false, directory);
      await fs.unlink(stage).catch(error => { if (error.code !== 'ENOENT') throw error; });
    }
  }
  view(record) {
    return {
      id: record.id, createdAt: record.createdAt, brief: { id: record.brief.id, version: record.brief.version, digest: record.brief.digest },
      fixtures: record.fixtures, notice: record.slots.some(slot => slot.status !== 'pending') ? record.notice.replace('No generation has run.', 'Every attempt is retained; no slot is rerolled.') : record.notice,
      storageWarning: record.storageWarning || null,
      slots: record.displayOrder.map((id, index) => {
        const slot = record.slots.find(slot => slot.id === id);
        return { displayId: `Output ${index + 1}`, status: slot.status, candidate: slot.candidate || null, error: slot.error || null, elapsedMs: slot.elapsedMs, elapsedBoundary: slot.elapsedBoundary || null, usage: slot.usage, usageEvidence: slot.usageEvidence || 'Usage unavailable: no turn has run.', wordCount: slot.candidate?.wordCount ?? null };
      })
    };
  }
  async list() {
    const vault = this.getVault(); if (!vault) return { comparisons: [] };
    const directory = this.safeDirectory(true), names = await fs.readdir(this.directory);
    this.safeDirectory(false, directory);
    const records = [];
    for (const name of names) if (name.endsWith('.json')) {
      let record = await this.read(name.slice(0, -5));
      if (!this.unsaved.has(record.id) && !this.running.has(record.id) && record.slots.some(slot => slot.status === 'inProgress')) record = await this.lock(async () => {
        const latest = await this.read(record.id);
        for (const slot of latest.slots) if (slot.status === 'inProgress') {
          Object.assign(slot, { status: 'interrupted', completedAt: this.clock().now, elapsedMs: null, error: 'Previous request interrupted. Duration is unavailable after restart. No request was replayed.' });
          this.selectCandidate(slot);
        }
        try { await this.write(latest); }
        catch { latest.storageWarning = 'Comparison storage failed. Retained text is unsaved and may not survive restart. Copy it before closing.'; this.unsaved.set(latest.id, structuredClone(latest)); }
        return latest;
      });
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
        for (const method of ['direct', 'analogy']) {
          const packet = makePackage(brief, fixture, method);
          if (packet.count > 32000) throw Error('Comparison package exceeds 32000 Unicode code points. Nothing was shortened. Review a smaller brief explicitly.');
          slots.push({ id: randomUUID(), fixtureId: fixture.id, method, status: 'pending', prompt: structuredClone(prompts[method]), package: packet, reply: '', usage: null, elapsedMs: null });
        }
      }
      const displayOrder = slots.map(slot => slot.id);
      for (let i = displayOrder.length - 1; i > 0; i--) { const j = randomInt(i + 1); [displayOrder[i], displayOrder[j]] = [displayOrder[j], displayOrder[i]]; }
      const record = { schema: 1, id: randomUUID(), createdAt: this.clock().now, vault: { root: vault.root }, brief, fixtures: structuredClone(fixtures), slots, displayOrder,
        notice: 'Synthetic exploratory comparison: three authored cases, six outcome slots. No generation has run. No equal consumption, statistical reliability or numerical release threshold is established.' };
      // Brief and selected input bytes must still be current at publication.
      if (JSON.stringify(await new Briefs(vault).pinned(pin.version)) !== JSON.stringify(pin) || this.getVault()?.root !== vault.root) throw Error('Approved brief or vault changed. Review it and create the comparison again.');
      await this.write(record, true); return this.view(record);
    });
  }
  async build(record, slot) {
    const vault = this.getVault();
    if (!vault || vault.root !== record.vault.root) throw Error('Comparison belongs to another vault.');
    if (this.unsaved.has(record.id)) throw Error('Comparison has unsaved output. Copy retained text and repair storage before continuing.');
    const brief = await new Briefs(vault).pinned(record.brief.version);
    if (JSON.stringify(brief) !== JSON.stringify(record.brief.snapshot) || brief.issues.length) throw Error('Pinned approved brief or its selected inputs changed or are unavailable. No request was sent.');
    if (JSON.stringify(record.fixtures) !== JSON.stringify(fixtures)) throw Error('Versioned comparison fixtures changed. Create and inspect a separate comparison.');
    const fixture = fixtures.find(item => item.id === slot.fixtureId);
    if (!fixture || JSON.stringify(slot.prompt) !== JSON.stringify(prompts[slot.method]) || JSON.stringify(slot.package) !== JSON.stringify(makePackage(record.brief, fixture, slot.method))) throw Error('Comparison package or prompt changed. No request was sent.');
    const evidence = await this.getEvidence(), capacity = evidence.capacity, settings = evidence.comparisonSettings;
    if (!evidence.dispatchEnabled || !capacity || !capacity.harnessAndOutputEvidence || !settings) throw Error('Comparison unavailable: independent model, settings, input capacity and harness/output evidence are required. Production readiness remains closed without proof.');
    const requested = { model: capacity.model, modelProvider: settings.modelProvider, reasoningEffort: settings.reasoningEffort, serviceTier: settings.serviceTier };
    const pin = { requested, capacity, settings, binding: evidence.binding, bindingEvidence: 'Random process-local evidence binding, not portable capacity or authentication proof.' };
    const count = [...slot.package.text].length, limit = Math.min(32000, capacity.maxCodePoints);
    if (count > limit) throw Error('Comparison package exceeds the verified context limit. Nothing was shortened or sent.');
    return { pin, package: slot.package, slotId: slot.id };
  }
  async preview(input) {
    return this.lock(async () => {
      const record = await this.read(input?.id), slotId = record.displayOrder[input?.displayIndex], slot = record.slots.find(item => item.id === slotId);
      if (!slot || slot.status !== 'pending') throw Error('This slot already has an attempt or is unavailable. It cannot be rerolled.');
      const snapshot = await this.build(record, slot);
      if (record.generationPin && JSON.stringify(record.generationPin) !== JSON.stringify(snapshot.pin) && record.slots.some(item => item.status !== 'pending')) throw Error('Evidence changed or the process restarted. This run cannot establish matched conditions. Preserve it and create a separate comparison.');
      if (JSON.stringify(record.generationPin) !== JSON.stringify(snapshot.pin)) { record.generationPin = snapshot.pin; await this.write(record); }
      const packageId = randomUUID();
      if (this.tokens.size >= 64) this.tokens.delete(this.tokens.keys().next().value);
      this.tokens.set(packageId, { id: record.id, snapshot });
      return { packageId, text: slot.package.text, count: slot.package.count, requested: snapshot.pin.requested, evidence: snapshot.pin, notice: 'Review the exact synthetic package. One explicit send consumes this slot; failure or restart never rerolls it.' };
    });
  }
  selectCandidate(slot) {
    const finals = (slot.messages || []).filter(message => message.phase === 'final_answer' && message.completed);
    const authoritative = slot.status === 'completed' && finals.length === 1;
    const text = authoritative ? finals[0].text : slot.reply;
    const wordCount = text.trim() ? text.trim().split(/\s+/u).length : 0;
    slot.candidate = { text, wordCount, overRequestedLimit: wordCount > 600,
      warning: authoritative ? null : 'A single authoritative completed final answer is unavailable or ambiguous. Full actual output is retained; it may be partial or include commentary.' };
  }
  async send(input) {
    const approved = this.tokens.get(input?.packageId); this.tokens.delete(input?.packageId);
    if (!approved) throw Error('Preview the comparison slot again before sending.');
    return this.lock(async () => {
      const record = await this.read(approved.id), slot = record.slots.find(item => item.id === approved.snapshot.slotId);
      if (!slot || slot.status !== 'pending' || JSON.stringify(record.generationPin) !== JSON.stringify(approved.snapshot.pin) || JSON.stringify(await this.build(record, slot)) !== JSON.stringify(approved.snapshot)) throw Error('Comparison conditions changed. Review the current package again.');
      Object.assign(slot, { status: 'inProgress', startedAt: this.clock().now, completedAt: null, requested: approved.snapshot.pin.requested, effective: null, messages: [], usage: null, usageEvidence: 'Usage unavailable: no valid matching provider update was observed.', elapsedMs: null, elapsedBoundary: 'Monotonic local elapsed time from before preflight to provider terminal handling, including intermediate persistence; excludes initial intent and final publication, not pure generation time.' });
      this.running.add(record.id);
      try { await this.write(record); }
      catch (error) { this.running.delete(record.id); throw error; }
      const started = performance.now();
      try {
        await this.provider.preflight(); await this.checkpoint('comparison-before-dispatch');
        const revalidate = async () => {
          if (JSON.stringify(await this.build(record, slot)) !== JSON.stringify(approved.snapshot)) throw Error('Comparison context, settings or proof changed before dispatch. No request was sent.');
        };
        await revalidate();
        const result = await this.provider.turn(slot.package.text, { comparisonPin: slot.requested, capacityBinding: approved.snapshot.pin.binding,
          beforeStart: async () => { await this.checkpoint('comparison-before-turn-start'); await revalidate(); },
          onState: async snapshot => { Object.assign(slot, snapshot); await this.write(record); }
        });
        Object.assign(slot, result, { status: 'completed' });
      } catch (error) { slot.status = error.terminalStatus || 'failed'; slot.error = error.message; }
      slot.completedAt = this.clock().now; slot.elapsedMs = performance.now() - started; this.selectCandidate(slot);
      try { await this.write(record); }
      catch {
        slot.status = 'interrupted'; this.selectCandidate(slot);
        record.storageWarning = 'Comparison storage failed. Retained text is incomplete and unsaved and may not survive restart. Copy it before closing. No request will be replayed.';
        this.unsaved.set(record.id, structuredClone(record));
      } finally { this.running.delete(record.id); }
      return this.view(record);
    });
  }
}
function installComparisons({ ipcMain, ...options }) {
  const store = new Comparisons(options);
  ipcMain.handle('comparison-list', () => store.list());
  ipcMain.handle('comparison-create', (_, input) => store.create(input));
  ipcMain.handle('comparison-preview', (_, input) => store.preview(input));
  ipcMain.handle('comparison-send', (_, input) => store.send(input));
  return store;
}
module.exports = { installComparisons };
