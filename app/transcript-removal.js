const fs = require('node:fs/promises');
const local = require('node:fs');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
const { withBriefMutation } = require('./briefs-lock');
const { readExactSync } = require('./staged-publication');
const sha = text => createHash('sha256').update(text).digest('hex');
const uuid = value => typeof value === 'string' && /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(value);
const digest = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const number = value => typeof value === 'string' && /^\d+$/.test(value);
const same = (a, b) => String(a.dev) === String(b.dev) && String(a.ino) === String(b.ino);
const exact = (value, keys) => value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).sort().join('|') === [...keys].sort().join('|');
const exists = file => fs.lstat(file).then(() => true, error => { if (error.code === 'ENOENT') return false; throw error; });
const held = () => Error('Transcript removal scope or identity changed. Preserve all remaining files and review the exact copies again.');
const removed = () => Error('This transcript identity has an observed removal record. Old export confirmations and recovery cannot recreate or acknowledge it, even if that control is later missing.');

// This store owns only explicitly selected transcript exports, never their origins.
class TranscriptRemoval {
  constructor(store) { this.store = store; this.previews = new Map(); this.refused = new Map(); }
  refusals(vault) {
    const key = JSON.stringify([vault.vault, vault.root]);
    if (!this.refused.has(key)) this.refused.set(key, new Set());
    return this.refused.get(key);
  }
  rememberRefusal(vault, id) {
    if (!uuid(id)) throw held();
    // Refusal only: this memory never supplies removal authority or recreates controls.
    // Across restart, external loss of all durable authority cannot be inferred from memory.
    this.refusals(vault).add(id);
  }
  location(vault, id) {
    if (!uuid(id)) throw held();
    const marker = path.join(vault.root, '.transcripts', `${id}.removed.json`);
    return { marker, stage: `${marker}.pending` };
  }
  async fence(intent, vault) {
    const { marker, stage } = this.location(vault, intent.id);
    if (this.refusals(vault).has(intent.id) || await exists(marker) || await exists(stage)) {
      this.rememberRefusal(vault, intent.id);
      throw removed();
    }
  }
  fenceSync(intent, vault) {
    const { marker, stage } = this.location(vault, intent.id);
    if (this.refusals(vault).has(intent.id) || local.lstatSync(marker, { throwIfNoEntry: false }) || local.lstatSync(stage, { throwIfNoEntry: false })) {
      this.rememberRefusal(vault, intent.id);
      throw removed();
    }
  }
  relative(vault, file) {
    const relative = path.relative(vault.vault, file);
    if (!relative || path.isAbsolute(relative) || relative.split(path.sep).includes('..') || path.resolve(vault.vault, relative) !== file) throw held();
    return relative;
  }
  absolute(vault, file) {
    if (typeof file !== 'string' || this.relative(vault, path.resolve(vault.vault, file)) !== file) throw held();
    return path.resolve(vault.vault, file);
  }
  vault() { const vault = this.store.getVault(); if (!vault) throw Error('Choose a vault first.'); return vault; }
  placeholder(vault) { return path.join(vault.vault, 'Transcript inspection.md'); }
  scopeFiles({ destination, exportOperation }, vault) {
    const base = path.join(vault.root, '.transcripts', exportOperation);
    return new Map([
      [destination, 'output'], [`${base}.intent.json`, 'intent'], [`${base}.md.pending`, 'stage'],
      [`${base}.published.json`, 'receipt'], [`${base}.link.json`, 'attempt']
    ]);
  }
  checkNames(scope, names, files) {
    const allowed = new Set(files.map(file => path.basename(file)));
    const prefix = `${scope.exportOperation}.`;
    if (names.some(name => name.toLowerCase().startsWith(prefix) && !allowed.has(name))) throw held();
  }
  async inventory(operation) {
    if (!uuid(operation)) throw held();
    const vault = this.vault(), directory = path.join(vault.root, '.transcripts');
    const initial = this.store.guard(vault, this.placeholder(vault));
    const journal = path.join(directory, `${operation}.intent.json`);
    const raw = await this.store.read(vault, this.placeholder(vault), journal, initial);
    const intent = this.store.validateIntent(JSON.parse(raw.text), operation, vault);
    await this.fence(intent, vault);
    const parents = this.store.guard(vault, intent.destination, initial);
    const scope = { destination: intent.destination, exportOperation: operation };
    const candidates = this.scopeFiles(scope, vault);
    this.checkNames(scope, await fs.readdir(directory), [...candidates.keys()].filter(file => file !== intent.destination));
    const present = [];
    for (const [file, kind] of candidates) {
      if (!await exists(file)) continue;
      const stat = await fs.lstat(file, { bigint: true });
      if (!stat.isFile() || stat.isSymbolicLink()) throw held();
      present.push({ file, kind, stat });
    }
    const targets = [], texts = new Map();
    for (const item of present) {
      const peers = present.filter(peer => same(peer.stat, item.stat)).map(peer => this.relative(vault, peer.file)).sort((a, b) => a.localeCompare(b));
      const read = await this.store.read(vault, intent.destination, item.file, parents, peers.length);
      if (!same(read.stat, item.stat)) throw held();
      if (['output', 'stage'].includes(item.kind) && read.text !== intent.text) throw held();
      if (item.kind === 'attempt') {
        if (read.stat.nlink !== 1n) throw held();
        this.store.validateAttempt(intent, read.text, read.stat);
      }
      texts.set(item.kind, read.text);
      targets.push({ file: this.relative(vault, item.file), kind: item.kind, sha256: sha(read.text), dev: String(read.stat.dev), ino: String(read.stat.ino), bytes: String(read.stat.size), peers });
    }
    const output = present.find(item => item.kind === 'output'), stage = present.find(item => item.kind === 'stage');
    if (output && stage && !same(output.stat, stage.stat)) throw held();
    let receipt;
    if (texts.has('receipt')) {
      receipt = JSON.parse(texts.get('receipt'));
      const target = output || stage;
      if (!exact(receipt, ['schema', 'operation', 'id', 'digest', 'dev', 'ino']) || receipt.schema !== 1 || receipt.operation !== operation || receipt.id !== intent.id || receipt.digest !== intent.digest || !number(receipt.dev) || !number(receipt.ino) || target && !same(receipt, target.stat)) throw held();
    } else if (output && (!stage || !texts.has('attempt'))) throw held();
    if (stage) this.store.checkStage(intent, stage.stat, receipt);
    return {
      vault, intent,
      scope: {
        id: intent.id, exportOperation: operation, vault: { vault: vault.vault, root: vault.root }, destination: intent.destination,
        parents: [...parents].map(([file, stat]) => ({ file: file === path.resolve(vault.vault) ? '.' : this.relative(vault, file), dev: String(stat.dev), ino: String(stat.ino) })).sort((a, b) => a.file.localeCompare(b.file)),
        targets: targets.sort((a, b) => a.file.localeCompare(b.file))
      }
    };
  }
  async list() {
    const vault = this.store.getVault(); if (!vault) return { records: [], pending: [], issues: [] };
    const records = [], pending = [], issues = [], directory = path.join(vault.root, '.transcripts');
    let names;
    try { this.store.guard(vault, this.placeholder(vault)); names = await fs.readdir(directory); }
    catch (error) { if (error.code !== 'ENOENT') issues.push(error.message); return { records, pending, issues }; }
    const removed = new Set(names.map(name => name.match(/^([a-f0-9-]{36})\.removed\.json(?:\.pending)?$/)?.[1]).filter(uuid));
    for (const id of removed) this.rememberRefusal(vault, id);
    for (const id of removed) {
      try {
        const record = await this.load(vault, id);
        const remaining = await this.remaining(record.marker, vault);
        if (remaining.length || record.hasStage || !record.hasMarker) pending.push({ id, operation: record.marker.operation, canResume: true, warning: 'Explicit review is required to finish this exact transcript removal.' });
      } catch (error) { pending.push({ id, canResume: false, warning: error.message }); }
    }
    for (const name of names) {
      const operation = name.match(/^([a-f0-9-]{36})\.intent\.json$/)?.[1]; if (!uuid(operation)) continue;
      try {
        const parents = this.store.guard(vault, this.placeholder(vault));
        const raw = await this.store.read(vault, this.placeholder(vault), path.join(directory, name), parents);
        const intent = this.store.validateIntent(JSON.parse(raw.text), operation, vault);
        if (!removed.has(intent.id)) records.push({ operation, id: intent.id, destination: intent.destination });
      } catch (error) { issues.push(`Transcript ${operation}: ${error.message}`); }
    }
    return { records, pending, issues };
  }
  remember(value) {
    const token = randomUUID(); if (this.previews.size >= 32) this.previews.delete(this.previews.keys().next().value);
    this.previews.set(token, value);
    const marker = value.marker || value.scope;
    const missingOutput = !marker.targets.some(item => item.kind === 'output');
    return { token, id: marker.id, destination: marker.destination, files: marker.targets.map(item => this.absolute(value.vault, item.file)), warning: missingOutput ? `The transcript output is missing and will not be recreated. Only the displayed retained files are selected.${marker.targets.some(item => item.kind === 'receipt') ? ' The retained publication receipt records historical identity facts; it does not prove a current output exists.' : ''}` : '' };
  }
  async preview(operation) { return this.remember(await this.inventory(operation)); }
  cancel(token) { this.previews.delete(token); }
  validate(marker, vault, id) {
    if (!exact(marker, ['schema', 'kind', 'id', 'exportOperation', 'operation', 'vault', 'destination', 'parents', 'targets', 'control']) || marker.schema !== 1 || marker.kind !== 'transcript-removal' || marker.id !== id || !uuid(id) || !uuid(marker.exportOperation) || !uuid(marker.operation) || marker.operation === marker.exportOperation) throw held();
    if (!exact(marker.vault, ['vault', 'root']) || marker.vault.vault !== vault.vault || marker.vault.root !== vault.root || typeof marker.destination !== 'string' || path.resolve(marker.destination) !== marker.destination) throw held();
    this.store.guard(vault, marker.destination);
    if (!exact(marker.control, ['dev', 'ino']) || !number(marker.control.dev) || !number(marker.control.ino) || !Array.isArray(marker.parents) || !Array.isArray(marker.targets) || !marker.targets.length) throw held();
    const sortedUnique = values => values.every((value, index) => index === 0 || values[index - 1].localeCompare(value) < 0);
    if (!sortedUnique(marker.parents.map(item => item.file)) || !sortedUnique(marker.targets.map(item => item.file))) throw held();
    const required = this.store.guard(vault, marker.destination);
    if (marker.parents.length !== required.size) throw held();
    for (const parent of marker.parents) {
      if (!exact(parent, ['file', 'dev', 'ino']) || !number(parent.dev) || !number(parent.ino)) throw held();
      const file = parent.file === '.' ? path.resolve(vault.vault) : this.absolute(vault, parent.file);
      if (!required.has(file) || !same(parent, required.get(file))) throw held();
    }
    const allowed = this.scopeFiles(marker, vault);
    for (const target of marker.targets) {
      if (!exact(target, ['file', 'kind', 'sha256', 'dev', 'ino', 'bytes', 'peers']) || !digest(target.sha256) || !number(target.dev) || !number(target.ino) || !number(target.bytes) || allowed.get(this.absolute(vault, target.file)) !== target.kind || !Array.isArray(target.peers) || !sortedUnique(target.peers) || !target.peers.includes(target.file)) throw held();
      const peers = marker.targets.filter(item => same(item, target)).map(item => item.file).sort((a, b) => a.localeCompare(b));
      if (JSON.stringify(peers) !== JSON.stringify(target.peers)) throw held();
    }
    if (!marker.targets.some(item => item.kind === 'intent')) throw held();
    return marker;
  }
  async load(vault, id) {
    const { marker: file, stage } = this.location(vault, id), parents = this.store.guard(vault, this.placeholder(vault));
    const hasMarker = await exists(file), hasStage = await exists(stage), links = hasMarker && hasStage ? 2 : 1;
    if (!hasMarker && !hasStage) throw held();
    this.rememberRefusal(vault, id);
    const controlFile = hasMarker ? file : stage;
    const raw = await this.store.read(vault, this.placeholder(vault), controlFile, parents, links);
    const marker = this.validate(JSON.parse(raw.text), vault, id);
    if (!same(marker.control, raw.stat)) throw held();
    const controls = new Map([[file, null], [stage, null]]);
    controls.set(controlFile, raw.stat);
    if (hasMarker && hasStage) {
      const peer = await this.store.read(vault, marker.destination, stage, parents, 2);
      if (!same(raw.stat, peer.stat) || peer.text !== raw.text) throw held();
      controls.set(stage, peer.stat);
    }
    return { vault, marker, bytes: raw.text, hasMarker, hasStage, controls };
  }
  async verifyAuthority(expected) {
    const current = await this.load(expected.vault, expected.marker.id);
    if (current.bytes !== expected.bytes || current.hasMarker !== expected.hasMarker || current.hasStage !== expected.hasStage || !same(current.marker.control, expected.marker.control)) throw held();
    return current;
  }
  scopeParents(marker, vault) {
    return new Map(marker.parents.map(item => [item.file === '.' ? path.resolve(vault.vault) : this.absolute(vault, item.file), { dev: BigInt(item.dev), ino: BigInt(item.ino) }]));
  }
  checkAuthority({ vault, marker, controls, bytes }) {
    const parents = this.scopeParents(marker, vault);
    const guard = () => this.store.guard(vault, marker.destination, parents);
    guard();
    const digest = sha(bytes);
    for (const [file, stat] of controls) {
      if (stat) {
        readExactSync(file, guard, Number(stat.nlink), { ...marker.control, digest });
        this.store.checkLeaf(file, stat);
      }
      else if (local.lstatSync(file, { throwIfNoEntry: false })) throw held();
    }
  }
  checkScope(scope, vault, remaining) {
    const parents = this.scopeParents(scope, vault);
    const guard = () => this.store.guard(vault, scope.destination, parents);
    guard();
    const files = new Map(remaining.map(target => [this.absolute(vault, target.file), target]));
    this.checkNames(scope, local.readdirSync(path.join(vault.root, '.transcripts')), [...files.keys()].filter(file => file !== scope.destination));
    for (const file of this.scopeFiles(scope, vault).keys()) {
      const target = files.get(file);
      if (!target) {
        if (local.lstatSync(file, { throwIfNoEntry: false })) throw held();
        continue;
      }
      const links = remaining.filter(peer => target.peers.includes(peer.file)).length;
      const { bytes } = readExactSync(file, guard, links, { dev: target.dev, ino: target.ino, digest: target.sha256 });
      if (String(bytes.length) !== target.bytes) throw held();
    }
  }
  async remaining(marker, vault) {
    this.validate(marker, vault, marker.id);
    const remaining = [];
    for (const target of marker.targets) if (await exists(this.absolute(vault, target.file))) remaining.push(target);
    const names = await fs.readdir(path.join(vault.root, '.transcripts'));
    this.checkNames(marker, names, marker.targets.filter(item => item.kind !== 'output').map(item => item.file));
    // A committed scope cannot silently accept an output that was absent at review.
    const expected = new Set(marker.targets.map(item => this.absolute(vault, item.file)));
    for (const file of this.scopeFiles(marker, vault).keys()) if (!expected.has(file) && await exists(file)) throw held();
    for (const target of remaining) await this.checkTarget(marker, vault, target, remaining);
    return remaining;
  }
  async checkTarget(marker, vault, target, remaining) {
    const parents = this.scopeParents(marker, vault);
    const file = this.absolute(vault, target.file);
    const peers = remaining.filter(item => target.peers.includes(item.file));
    const read = await this.store.read(vault, marker.destination, file, parents, peers.length);
    if (!same(read.stat, target) || String(read.stat.size) !== target.bytes || sha(read.text) !== target.sha256) throw held();
    return file;
  }
  async resume(id) {
    const record = await this.load(this.vault(), id);
    await this.remaining(record.marker, record.vault);
    return this.remember(record);
  }
  async confirm(token) {
    const preview = this.previews.get(token); if (!preview) throw Error('Preview the transcript removal again.');
    const vault = this.vault(), scope = preview.marker || preview.scope;
    if (vault.vault !== scope.vault.vault || vault.root !== scope.vault.root) throw held();
    return this.store.conversations.lock(async () => withBriefMutation(path.join(vault.root, '.transcripts'), async () => {
      let record, remaining = scope.targets;
      if (preview.marker) {
        record = await this.load(vault, scope.id);
        if (record.bytes !== preview.bytes || record.hasMarker !== preview.hasMarker || record.hasStage !== preview.hasStage) throw held();
        remaining = await this.remaining(record.marker, vault);
      } else {
        const fresh = await this.inventory(scope.exportOperation);
        if (JSON.stringify(fresh.scope) !== JSON.stringify(scope)) throw held();
        const { stage } = this.location(vault, scope.id);
        this.checkScope(scope, vault, remaining);
        this.fenceSync(fresh.intent, vault);
        let marker;
        this.store.writeControl(stage, stat => {
          marker = { schema: 1, kind: 'transcript-removal', ...scope, operation: randomUUID(), control: { dev: String(stat.dev), ino: String(stat.ino) } };
          this.rememberRefusal(vault, scope.id);
          return marker;
        });
        record = { vault, marker, bytes: JSON.stringify(marker, null, 2), hasMarker: false, hasStage: true };
        await this.store.checkpoint('transcript-remove-after-stage');
        await this.verifyAuthority(record);
      }
      const { marker: file, stage } = this.location(vault, scope.id);
      await this.verifyAuthority(record);
      await this.remaining(record.marker, vault);
      if (!record.hasMarker) {
        const authority = await this.verifyAuthority(record);
        this.checkScope(scope, vault, remaining);
        this.checkAuthority(authority);
        local.linkSync(stage, file);
        record.hasMarker = true;
        await this.verifyAuthority(record);
      }
      await this.store.checkpoint('transcript-remove-after-tombstone');
      await this.verifyAuthority(record);
      if (record.hasStage) {
        const authority = await this.verifyAuthority(record);
        this.checkScope(scope, vault, remaining);
        this.checkAuthority(authority);
        local.unlinkSync(stage);
        record.hasStage = false;
        await this.verifyAuthority(record);
      }
      await this.remaining(record.marker, vault);
      for (const target of [...remaining]) {
        await this.verifyAuthority(record);
        await this.remaining(record.marker, vault);
        const authority = await this.verifyAuthority(record);
        const file = await this.checkTarget(record.marker, vault, target, remaining);
        // Recheck the full selected scope after the last yielded read.
        this.checkScope(scope, vault, remaining);
        this.checkAuthority(authority);
        local.unlinkSync(file);
        remaining = remaining.filter(item => item !== target);
        await this.store.checkpoint('transcript-remove-after-unlink');
        await this.verifyAuthority(record);
      }
      await this.verifyAuthority(record);
      if ((await this.remaining(record.marker, vault)).length) throw held();
      const authority = await this.verifyAuthority(record);
      this.checkScope(scope, vault, remaining);
      this.checkAuthority(authority);
      this.previews.delete(token);
      return { id: scope.id, destination: scope.destination, completed: true };
    }));
  }
}
module.exports = { TranscriptRemoval };
