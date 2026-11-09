const fs = require('node:fs/promises');
const local = require('node:fs');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
const hash = text => createHash('sha256').update(text).digest('hex');
const uuid = value => typeof value === 'string' && /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(value);
const same = (a, b) => a.dev === b.dev && a.ino === b.ino;
const fields = (value, allowed) => value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).every(key => allowed.includes(key));

// Local controls are authority, not archived conversation content. Never infer consent from absence.
class ConversationControls {
  constructor(store) { this.store = store; this.previews = new Map(); this.known = new Set(); }
  guard(create = false, expected) {
    const parent = this.store.safeDirectory(), directory = path.join(this.store.directory, '.control');
    if (create) { try { local.mkdirSync(directory); } catch (error) { if (error.code !== 'EEXIST') throw error; } }
    let stat;
    try { stat = local.lstatSync(directory, { bigint: true }); }
    catch (error) { if (error.code === 'ENOENT' && !this.identity && !expected) return null; throw error; }
    if (!stat.isDirectory() || stat.isSymbolicLink() || local.realpathSync(directory) !== directory || this.identity && !same(stat, this.identity) || expected && !same(stat, expected)) throw Error('Conversation controls require the original ordinary contained folder. Preserve local writing for repair.');
    this.store.safeDirectory(false, parent); this.identity = stat;
    return { directory, stat, parent };
  }
  async file(file, directory, expected, links = 1, control = false) {
    if (control) this.guard(false, directory.stat); else this.store.safeDirectory(false, directory);
    const before = await fs.lstat(file, { bigint: true });
    if (!before.isFile() || before.isSymbolicLink() || before.nlink !== BigInt(links)) throw Error('Conversation deletion encountered a linked or nonordinary file. Preserve it for review.');
    const handle = await fs.open(file, 'r');
    try {
      if (!same(before, await handle.stat({ bigint: true }))) throw Error('Conversation deletion file identity changed.');
      const text = new TextDecoder('utf-8', { fatal: true }).decode(await handle.readFile());
      if (control) this.guard(false, directory.stat); else this.store.safeDirectory(false, directory);
      const after = await fs.lstat(file, { bigint: true });
      if (!same(before, after) || after.nlink !== BigInt(links)) throw Error('Conversation deletion file identity changed.');
      const owned = { name: path.basename(file), sha256: hash(text), dev: String(after.dev), ino: String(after.ino), bytes: Buffer.byteLength(text, 'utf8') };
      if (expected && JSON.stringify(owned) !== JSON.stringify(expected)) throw Error('Conversation deletion target changed. Preserve it and preview again.');
      return { text, stat: after, owned };
    } finally { await handle.close(); }
  }
  validate(value, id) {
    const fail = () => { throw Error('Conversation control is unknown or corrupt. Preserve all writing; ordinary history access is blocked.'); };
    if (!fields(value, ['schema', 'id', 'generation', 'phase', 'scope', 'targets', 'publication']) || value.schema !== 1 || value.id !== id || !uuid(id) || !uuid(value.generation) || !uuid(value.publication) || !['deleting', 'deleted', 'restoring', 'active'].includes(value.phase)) fail();
    if (!fields(value.scope, ['excludedSources', 'excludedHistory']) || !Array.isArray(value.scope.excludedSources) || value.scope.excludedSources.some(key => typeof key !== 'string') || !Array.isArray(value.scope.excludedHistory) || value.scope.excludedHistory.some(key => !uuid(key)) || !Array.isArray(value.targets)) fail();
    const names = new Set();
    for (const target of value.targets) {
      if (!fields(target, ['name', 'sha256', 'dev', 'ino', 'bytes']) || typeof target.name !== 'string' || !/^[a-f0-9-]{36}\.(json|pending)$/.test(target.name) || !uuid(target.name.split('.')[0]) || names.has(target.name) || typeof target.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(target.sha256) || typeof target.dev !== 'string' || typeof target.ino !== 'string' || !Number.isSafeInteger(target.bytes) || target.bytes < 0) fail();
      names.add(target.name);
      if (target.name.endsWith('.json') && target.name !== `${id}.json`) fail();
    }
    if (['deleting', 'deleted'].includes(value.phase) && !names.has(`${id}.json`)) fail();
    return value;
  }
  async state(id) {
    if (!uuid(id)) throw Error('Conversation identity is invalid.');
    const directory = this.guard(); if (!directory) return null;
    const file = path.join(directory.directory, `${id}.json`);
    let marker;
    try {
      const stat = await fs.lstat(file);
      if (![1, 2].includes(stat.nlink)) throw Error('Conversation control has unknown linked peers.');
      const data = await this.file(file, directory, null, stat.nlink, true);
      marker = this.validate(JSON.parse(data.text), id);
      if (stat.nlink !== 1) {
        if (stat.nlink !== 2) throw Error('Conversation control has unknown linked peers.');
        const stage = await this.file(path.join(directory.directory, `${marker.publication}.pending`), directory, null, 2, true);
        if (!same(data.stat, stage.stat) || data.text !== stage.text) throw Error('Conversation control has unknown linked peers.');
      }
      this.known.add(id);
    } catch (error) { if (error.code !== 'ENOENT' || marker || this.known.has(id)) throw error; }
    for (const name of await fs.readdir(directory.directory)) {
      if (/^[a-f0-9-]{36}\.json$/.test(name)) {
        const otherId = name.slice(0, -5); if (otherId === id && marker) continue;
        const other = await this.file(path.join(directory.directory, name), directory, null, 1, true);
        this.validate(JSON.parse(other.text), otherId); continue;
      }
      if (!/^[a-f0-9-]{36}\.pending$/.test(name)) throw Error('Unknown conversation control file remains preserved; access is blocked.');
      const stat = await fs.lstat(path.join(directory.directory, name));
      if (![1, 2].includes(stat.nlink)) throw Error('Conversation control stage has unknown linked peers.');
      const stage = await this.file(path.join(directory.directory, name), directory, null, stat.nlink, true);
      const candidate = JSON.parse(stage.text); this.validate(candidate, candidate.id);
      if (name !== `${candidate.publication}.pending` || stat.nlink !== 1 && !(marker && candidate.publication === marker.publication && stat.nlink === 2)) throw Error('Unknown conversation control stage remains preserved; access is blocked.');
      if (!marker && candidate.id === id) throw Error('An unpublished conversation control requires explicit recovery. History remains preserved and blocked.');
    }
    return marker || null;
  }
  async check(record) {
    const marker = await this.state(record.id);
    if (!marker) { if (record.generation !== undefined && record.generation !== null) throw Error('Conversation generation has no local authority. Explicit restoration is required.'); return; }
    if (marker.phase !== 'active' || record.generation !== marker.generation) throw Error('Conversation was deleted or its generation changed. Stale history cannot be saved or sent.');
    const scope = record.scope;
    if (!scope || marker.scope.excludedSources.some(key => !scope.excludedSources.includes(key)) || marker.scope.excludedHistory.some(id => !scope.excludedHistory.includes(id))) throw Error('Current conversation exclusions remain authoritative. Preview current scope again.');
  }
  async put(marker, baseline) {
    const directory = this.guard(true), file = path.join(directory.directory, `${marker.id}.json`);
    const value = { ...marker, publication: randomUUID() }, text = JSON.stringify(value, null, 2), stage = path.join(directory.directory, `${value.publication}.pending`);
    this.validate(value, value.id);
    this.guard(false, directory.stat); await fs.writeFile(stage, text, { flag: 'wx', flush: true });
    this.guard(false, directory.stat);
    if (baseline) {
      const current = await this.file(file, directory, null, 1, true);
      if (JSON.stringify(JSON.parse(current.text)) !== JSON.stringify(baseline)) throw Error('Conversation authority changed. Preserve the control stage for review.');
      await fs.rename(stage, file);
    } else {
      await fs.link(stage, file);
      const a = await this.file(stage, directory, null, 2, true), b = await this.file(file, directory, null, 2, true);
      if (!same(a.stat, b.stat) || a.text !== text || b.text !== text) throw Error('Conversation control publication changed. Preserve both peers.');
      this.guard(false, directory.stat); await fs.unlink(stage);
    }
    this.guard(false, directory.stat); this.known.add(marker.id); return value;
  }
  async inventory(id) {
    if (this.store.unsaved.has(id) || this.store.running.has(id)) throw Error('Preserve the unsaved reply or finish the active request before deleting this conversation.');
    const record = await this.store.readStored(id), parent = this.store.safeDirectory();
    if (record.vault.root !== this.store.getVault()?.root) throw Error('Conversation belongs to another vault.');
    const target = await this.file(path.join(this.store.directory, `${id}.json`), parent);
    const targets = [target.owned], pending = [];
    for (const name of await fs.readdir(this.store.directory)) if (name.endsWith('.pending')) {
      if (!/^[a-f0-9-]{36}\.pending$/.test(name) || !uuid(name.slice(0, -8))) throw Error('Unknown pending history requires separate inspection before deletion.');
      const staged = await this.file(path.join(this.store.directory, name), parent);
      let candidate; try { candidate = JSON.parse(staged.text); } catch { throw Error('Unknown pending history remains preserved; deletion is blocked.'); }
      if (candidate.schema !== 1 || !uuid(candidate.id) || !Array.isArray(candidate.requests) || typeof candidate.vault?.root !== 'string') throw Error('Unknown pending history remains preserved; deletion is blocked.');
      if (candidate.id === id) {
        if (candidate.vault.root !== record.vault.root) throw Error('Pending history ownership is ambiguous. Preserve it before deletion.');
        targets.push(staged.owned); pending.push({ name, text: staged.text });
      }
    }
    return { id, marker: await this.state(id), record, targets: targets.sort((a, b) => a.name.localeCompare(b.name)), pending };
  }
  async preview(id) {
    return this.store.lock(async () => {
      const snapshot = await this.inventory(id), token = randomUUID();
      if (this.previews.size >= 32) this.previews.delete(this.previews.keys().next().value);
      this.previews.set(token, snapshot);
      return { token, id, requestCount: snapshot.record.requests.length, targets: snapshot.targets.map(target => target.name), pending: snapshot.pending };
    });
  }
  cancel(token) { this.previews.delete(token); }
  async confirm(token) {
    const reviewed = this.previews.get(token); if (!reviewed) throw Error('Preview the selected conversation deletion again.');
    return this.store.lock(async () => {
      const current = await this.inventory(reviewed.id);
      if (JSON.stringify(current) !== JSON.stringify(reviewed)) throw Error('Conversation or pending ownership changed. Preview deletion again; writing was preserved.');
      const scope = current.record.scope || { excludedSources: [], excludedHistory: current.record.requests.at(-1)?.package?.excludedHistory || [] };
      let marker = await this.put({ schema: 1, id: current.id, generation: randomUUID(), phase: 'deleting', scope: { excludedSources: [...scope.excludedSources], excludedHistory: [...scope.excludedHistory] }, targets: current.targets }, current.marker);
      this.store.tokens.clear(); this.store.durable.delete(current.id);
      await this.store.checkpoint('conversation-delete-after-tombstone');
      const parent = this.store.safeDirectory();
      for (const target of marker.targets) {
        const file = path.join(this.store.directory, target.name);
        await this.file(file, parent, target); this.store.safeDirectory(false, parent); await fs.unlink(file);
        await this.store.checkpoint('conversation-delete-after-unlink');
      }
      marker = await this.put({ ...marker, phase: 'deleted' }, marker);
      this.store.unsaved.delete(current.id); this.previews.delete(token);
      return { id: current.id, generation: marker.generation };
    });
  }
}
module.exports = { ConversationControls };
