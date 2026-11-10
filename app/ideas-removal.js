const fs = require('node:fs');
const path = require('node:path');
const YAML = require('yaml');
const { createHash, randomUUID } = require('node:crypto');
const { withBriefMutation } = require('./briefs-lock');
const { generations } = require('./source-generations');
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const uuid = value => typeof value === 'string' && /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(value);
const same = (a, b) => a.dev === b.dev && a.ino === b.ino;
const keys = (value, fields) => value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).sort().join('|') === [...fields].sort().join('|');
const sorted = values => values.every((value, index) => !index || values[index - 1] < value);
const metadata = text => YAML.parse(text.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/)?.[1] || 'null');
const held = () => { throw Error('Saved idea removal is held. The exact managed scope or ownership changed; preserve the files and inspect a fresh scope.'); };

// Removal recognizes only the writer's known envelopes. Unknown nested fields
// may be independent writing and cannot inherit the selected note's consent.
function checkEnvelopes(value) {
  const shape = (item, required, optional = []) => item && typeof item === 'object' && !Array.isArray(item) && required.every(key => Object.hasOwn(item, key)) && Object.keys(item).every(key => required.includes(key) || optional.includes(key));
  const text = item => typeof item === 'string';
  const texts = item => Array.isArray(item) && item.every(text);
  const sha = item => text(item) && /^[a-f0-9]{64}$/.test(item);
  const copies = item => Array.isArray(item) && item.every(copy => keys(copy, ['file', 'hash']) && text(copy.file) && sha(copy.hash));
  const identity = item => text(item) && (uuid(item) || /^annotation:[a-f0-9-]{36}$/.test(item) && uuid(item.slice(11)));
  const choice = item => item === null || keys(item, ['file', 'copies']) && text(item.file) && copies(item.copies);
  const issue = item => item === null || item && (
    item.kind === 'duplicate' && keys(item, ['kind', 'id', 'reason', 'files', 'token']) && copies(item.files) ||
    item.kind === 'missing' && keys(item, ['kind', 'id', 'sourceHash', 'reason', 'token']) && sha(item.sourceHash)
  ) && identity(item.id) && text(item.reason) && sha(item.token);
  const input = value.input, experimentFields = ['hypothesis', 'borrowed_mechanism', 'project_application', 'smallest_test', 'observable_result'];
  if (!shape(input, ['conversationId', 'requestId', 'title', 'explanation', 'limitations'], ['kind', 'experiment', 'referenceIds']) || !uuid(input.conversationId) || !uuid(input.requestId) || !['title', 'explanation', 'limitations'].every(key => text(input[key])) || Object.hasOwn(input, 'kind') && !['observation', 'failed_analogy', 'experiment_proposal'].includes(input.kind) || Object.hasOwn(input, 'experiment') && (!keys(input.experiment, experimentFields) || !experimentFields.every(key => text(input.experiment[key]))) || Object.hasOwn(input, 'referenceIds') && (!Array.isArray(input.referenceIds) || !input.referenceIds.every(uuid))) held();
  if (!texts(value.warnings) || !Array.isArray(value.referenceBindings) || !Array.isArray(value.supportState)) held();
  for (const binding of value.referenceBindings) {
    if (!keys(binding, ['referenceId', 'conversationId', 'requestId', 'anchor', 'label']) || ![binding.referenceId, binding.conversationId, binding.requestId].every(uuid) || !text(binding.label)) held();
    const anchor = binding.anchor;
    if (!keys(anchor, ['kind', 'capture_id', 'revision_id', 'snapshot_sha256', 'evidence_id', 'evidence_kind', 'start_seconds', 'end_seconds', 'excerpt', 'excerpt_sha256']) || anchor.kind !== 'imported_evidence' || !uuid(anchor.capture_id) || !uuid(anchor.revision_id) || !sha(anchor.snapshot_sha256) || !text(anchor.evidence_id) || !text(anchor.evidence_kind) || !text(anchor.excerpt) || !sha(anchor.excerpt_sha256) || ![anchor.start_seconds, anchor.end_seconds].every(time => time === null || typeof time === 'number' && Number.isFinite(time))) held();
  }
  for (const state of value.supportState) {
    if (!shape(state, ['key', 'originalDigest', 'currentDigest', 'excluded', 'authority', 'warnings'], ['originalSourceGenerations', 'currentSourceGenerations']) || !text(state.key) || !sha(state.originalDigest) || state.currentDigest !== null && !sha(state.currentDigest) || typeof state.excluded !== 'boolean' || !texts(state.warnings)) held();
    // Legacy six-field records retain their absence; inspecting removal never
    // supplies a generation or repairs historical attribution.
    try {
      if (Object.hasOwn(state, 'originalSourceGenerations')) generations(state.originalSourceGenerations);
      if (Object.hasOwn(state, 'currentSourceGenerations') && state.currentSourceGenerations !== null) generations(state.currentSourceGenerations);
    } catch { held(); }
    const authority = state.authority, captured = ['sourceHash', 'file', 'currentRevision', 'currentHash', 'removed', 'rejected', 'supportEligible', 'conflict', 'pending', 'blocked', 'suppressed'];
    if (!shape(authority, ['identityChoice', 'identityIssue'], captured) || !choice(authority.identityChoice) || !issue(authority.identityIssue)) held();
    if (captured.some(key => Object.hasOwn(authority, key)) && (!keys(authority, ['identityChoice', 'identityIssue', ...captured]) || !sha(authority.sourceHash) || !text(authority.file) || !uuid(authority.currentRevision) || !sha(authority.currentHash) || !captured.slice(4).every(key => typeof authority[key] === 'boolean'))) held();
  }
}

// This store owns only explicit saved-idea removal. It never reads Conversation
// or Context, and never reconstructs writing from an intent during recovery.
class IdeasRemoval {
  constructor(ideas) { this.ideas = ideas; this.previews = new Map(); this.refused = new Map(); }
  refusals(vault) {
    const key = JSON.stringify([vault.vault, vault.root]);
    if (!this.refused.has(key)) this.refused.set(key, new Set());
    return this.refused.get(key);
  }
  remember(vault, id) {
    if (!uuid(id)) held();
    // Refusal only: observed removal cannot supply unlink authority or recreate
    // missing controls. Cold loss of all durable authority is not inferred.
    this.refusals(vault).add(id);
  }
  files(vault, id) {
    const final = path.join(vault.root, '.ideas', `${id}.removed.json`);
    return { final, stage: `${final}.pending` };
  }
  exists(file) { try { fs.lstatSync(file); return true; } catch (error) { if (error.code === 'ENOENT') return false; throw error; } }
  fenced(vault, id) {
    const files = this.files(vault, id);
    if (this.refusals(vault).has(id) || this.exists(files.final) || this.exists(files.stage)) { this.remember(vault, id); return true; }
    return false;
  }
  allow(vault, id) {
    this.ideas.guard(vault);
    if (this.fenced(vault, id)) throw Error('This saved idea was selected for removal. Old proposals cannot publish or acknowledge it again. Inspect saved idea removal recovery.');
  }
  relative(vault, file) { return path.relative(vault.vault, file).split(path.sep).join('/'); }
  absolute(vault, relative) {
    if (typeof relative !== 'string' || relative.includes('\\') || relative.split('/').some(part => part === '..' || part === '.') || path.isAbsolute(relative)) held();
    const file = path.resolve(vault.vault, ...relative.split('/'));
    if (this.relative(vault, file) !== relative) held();
    return file;
  }
  read(vault, file, parents) {
    this.ideas.guard(vault, parents);
    const leaf = fs.lstatSync(file, { bigint: true });
    if (!leaf.isFile() || leaf.isSymbolicLink()) held();
    const handle = fs.openSync(file, 'r');
    try {
      const stat = fs.fstatSync(handle, { bigint: true });
      if (!same(leaf, stat)) held();
      const bytes = fs.readFileSync(handle), after = fs.lstatSync(file, { bigint: true });
      this.ideas.guard(vault, parents);
      if (!same(stat, after) || stat.size !== BigInt(bytes.length) || after.size !== stat.size || after.nlink !== stat.nlink) held();
      return { bytes, stat, text: new TextDecoder('utf-8', { fatal: true }).decode(bytes) };
    } finally { fs.closeSync(handle); }
  }
  scope(vault, id) {
    if (!uuid(id)) held();
    const parents = this.ideas.guard(vault), directory = path.join(vault.root, '.ideas');
    if (!parents.has(directory)) throw Error('Saved idea removal requires the existing .ideas folder. No folder was created.');
    const found = new Map(), intents = new Map(), receipts = [];
    const add = (file, kind, operation, loaded) => found.set(file, { file, kind, operation, loaded: loaded || this.read(vault, file, parents) });
    for (const name of fs.readdirSync(directory).sort()) {
      const match = name.match(/^([a-f0-9-]{36})\.(intent|published)\.json$/); if (!match) continue;
      const file = path.join(directory, name), loaded = this.read(vault, file, parents);
      let value; try { value = JSON.parse(loaded.text); } catch { held(); }
      if (value.id !== id) continue;
      if (!uuid(match[1]) || value.schema !== 1 || value.operation !== match[1]) held();
      if (match[2] === 'published') {
        if (!keys(value, ['schema', 'operation', 'id', 'digest', 'dev', 'ino'])) held();
        receipts.push({ file, loaded, value }); continue;
      }
      if (!keys(value, ['schema', 'operation', 'id', 'vault', 'destination', 'text', 'digest', 'proposalKey', 'warnings', 'input', 'referenceBindings', 'supportState'])) held();
      checkEnvelopes(value);
      let fields; try { fields = metadata(value.text); } catch { held(); }
      if (value.vault !== vault.root || typeof value.text !== 'string' || digest(value.text) !== value.digest || !fields || fields.artifact_type !== 'saved_idea' || fields.schema_version !== 1 || fields.companion_id !== id || path.dirname(value.destination || '') !== path.join(vault.root, 'Ideas') || !path.basename(value.destination).endsWith(`--${id}.md`) || value.input?.conversationId !== fields.origin?.conversation_id || value.input?.requestId !== fields.origin?.request_id) held();
      intents.set(value.operation, value); add(file, 'intent', value.operation, loaded);
    }
    for (const name of fs.readdirSync(path.join(vault.root, 'Ideas')).sort()) {
      if (!name.endsWith('.md')) continue;
      const file = path.join(vault.root, 'Ideas', name), loaded = this.read(vault, file, parents);
      let data; try { data = metadata(loaded.text); } catch { if (name.includes(id)) held(); continue; }
      if (data?.companion_id !== id && !name.includes(id)) continue;
      if (data?.artifact_type !== 'saved_idea' || data.schema_version !== 1 || data.companion_id !== id || !name.endsWith(`--${id}.md`)) held();
      add(file, 'note', null, loaded);
    }
    for (const value of intents.values()) {
      const stage = path.join(directory, `${value.operation}.md.pending`);
      if (this.exists(stage)) {
        const loaded = this.read(vault, stage, parents); if (loaded.text !== value.text) held();
        add(stage, 'stage', value.operation, loaded);
      }
    }
    for (const name of fs.readdirSync(directory).sort()) {
      if (!name.endsWith('.md.pending')) continue;
      const operation = name.slice(0, -'.md.pending'.length);
      if (intents.has(operation)) continue;
      const loaded = this.read(vault, path.join(directory, name), parents);
      let fields; try { fields = metadata(loaded.text); } catch { continue; }
      // Identity/body similarity cannot authorize an orphan's deletion. Its
      // presence instead holds removal until the unknown writing is resolved.
      if (fields?.companion_id === id) held();
    }
    for (const receipt of receipts) {
      const value = intents.get(receipt.value.operation); if (!value) held();
      this.ideas.checkReceipt(receipt.value, value);
      const note = found.get(value.destination);
      if (note && (note.loaded.stat.dev.toString() !== receipt.value.dev || note.loaded.stat.ino.toString() !== receipt.value.ino)) held();
      add(receipt.file, 'receipt', value.operation, receipt.loaded);
    }
    const files = [...found.values()].map(item => {
      const peers = [...found.values()].filter(peer => same(peer.loaded.stat, item.loaded.stat));
      if (item.loaded.stat.nlink !== BigInt(peers.length) || peers.length > 2) held();
      if (peers.length === 2) {
        const stage = peers.find(peer => peer.kind === 'stage'), note = peers.find(peer => peer.kind === 'note');
        const intent = stage && intents.get(stage.operation);
        if (!stage || !note || !intent || note.file !== intent.destination || note.loaded.text !== intent.text) held();
      }
      return { path: this.relative(vault, item.file), kind: item.kind, operation: item.operation, sha256: digest(item.loaded.bytes), size: item.loaded.stat.size.toString(), dev: item.loaded.stat.dev.toString(), ino: item.loaded.stat.ino.toString(), peers: peers.map(peer => this.relative(vault, peer.file)).sort() };
    });
    files.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
    const parentRecords = [...parents].map(([file, stat]) => ({ path: this.relative(vault, file), dev: stat.dev.toString(), ino: stat.ino.toString() })).sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
    return { parents: parentRecords, files };
  }
  validate(vault, value, id) {
    if (!keys(value, ['schema', 'kind', 'ideaId', 'operation', 'vault', 'parents', 'files']) || value.schema !== 1 || value.kind !== 'saved-idea-removal' || value.ideaId !== id || !uuid(id) || !uuid(value.operation) || value.vault !== vault.root || !Array.isArray(value.parents) || !Array.isArray(value.files) || !value.files.length || !sorted(value.files.map(file => file.path)) || !sorted(value.parents.map(parent => parent.path))) held();
    const decimal = string => typeof string === 'string' && /^(0|[1-9][0-9]*)$/.test(string);
    const parents = this.ideas.guard(vault);
    if (value.parents.length !== parents.size) held();
    for (const parent of value.parents) {
      if (!keys(parent, ['path', 'dev', 'ino']) || !decimal(parent.dev) || !decimal(parent.ino)) held();
      const current = parents.get(this.absolute(vault, parent.path));
      if (!current || current.dev.toString() !== parent.dev || current.ino.toString() !== parent.ino) held();
    }
    for (const file of value.files) {
      if (!keys(file, ['path', 'kind', 'operation', 'sha256', 'size', 'dev', 'ino', 'peers']) || !['note', 'intent', 'stage', 'receipt'].includes(file.kind) || !/^[a-f0-9]{64}$/.test(file.sha256) || ![file.size, file.dev, file.ino].every(decimal) || !Array.isArray(file.peers) || !file.peers.includes(file.path) || !sorted(file.peers) || file.peers.length > 2) held();
      const absolute = this.absolute(vault, file.path);
      if (file.kind === 'note') {
        if (file.operation !== null || path.dirname(absolute) !== path.join(vault.root, 'Ideas') || !path.basename(absolute).endsWith(`--${id}.md`)) held();
      } else {
        const suffix = { intent: 'intent.json', stage: 'md.pending', receipt: 'published.json' }[file.kind];
        if (!uuid(file.operation) || absolute !== path.join(vault.root, '.ideas', `${file.operation}.${suffix}`)) held();
      }
      for (const peer of file.peers) {
        const record = value.files.find(item => item.path === peer);
        if (!record || record.dev !== file.dev || record.ino !== file.ino || record.sha256 !== file.sha256 || record.size !== file.size || JSON.stringify(record.peers) !== JSON.stringify(file.peers)) held();
      }
      if (file.peers.length === 2 && !file.peers.map(peer => value.files.find(item => item.path === peer).kind).sort().every((kind, index) => kind === ['note', 'stage'][index])) held();
    }
    return parents;
  }
  load(vault, id) {
    const locations = this.files(vault, id), parents = this.ideas.guard(vault), copies = [];
    for (const file of [locations.final, locations.stage]) if (this.exists(file)) {
      this.remember(vault, id); copies.push({ file, ...this.read(vault, file, parents) });
    }
    if (!copies.length) held();
    const value = JSON.parse(copies[0].text); this.validate(vault, value, id);
    if (copies.some(copy => copy.text !== copies[0].text || !same(copy.stat, copies[0].stat) || copy.stat.nlink !== BigInt(copies.length))) held();
    return { value, copies, parents, locations };
  }
  checkAuthority(vault, authority) {
    this.validate(vault, authority.value, authority.value.ideaId);
    for (const copy of authority.copies) {
      const current = this.read(vault, copy.file, authority.parents);
      if (!same(current.stat, copy.stat) || current.text !== copy.text || current.stat.nlink !== BigInt(authority.copies.length)) held();
    }
  }
  checkScope(vault, value) {
    this.validate(vault, value, value.ideaId);
    const current = this.scope(vault, value.ideaId);
    if (JSON.stringify(current.parents) !== JSON.stringify(value.parents)) held();
    for (const expected of value.files) if (this.exists(this.absolute(vault, expected.path)) && !current.files.some(file => file.path === expected.path)) held();
    for (const file of current.files) {
      const expected = value.files.find(item => item.path === file.path); if (!expected) held();
      const peers = expected.peers.filter(peer => current.files.some(item => item.path === peer));
      if (JSON.stringify(file) !== JSON.stringify({ ...expected, peers })) held();
    }
    return current;
  }
  describe(vault, value) { return { operation: value.operation, id: value.ideaId, files: value.files.map(file => ({ path: this.absolute(vault, file.path), kind: file.kind })), warnings: ['Only the displayed managed copies are selected. Originating conversations, captures, transcripts and other ideas are retained. External, moved and backup copies are outside this scope; quotations elsewhere are retained.'] }; }
  async preview({ id }) {
    const vault = this.ideas.getVault(); if (!vault) throw Error('Choose a vault first.');
    if (!uuid(id)) held();
    const parents = this.ideas.guard(vault), directory = path.join(vault.root, '.ideas');
    if (!parents.has(directory)) throw Error('Saved idea removal requires the existing .ideas folder. No folder was created.');
    return withBriefMutation(directory, async () => {
      this.ideas.guard(vault, parents); this.allow(vault, id);
      const scope = this.scope(vault, id); if (!scope.files.length) held();
      const value = { schema: 1, kind: 'saved-idea-removal', ideaId: id, operation: randomUUID(), vault: vault.root, ...scope };
      this.validate(vault, value, id); this.previews.set(value.operation, value);
      return this.describe(vault, value);
    });
  }
  cancel({ operation }) { this.previews.delete(operation); }
  commit(vault, value) {
    const locations = this.files(vault, value.ideaId), parents = this.validate(vault, value, value.ideaId);
    const text = JSON.stringify(value), handle = fs.openSync(locations.stage, 'wx');
    let created;
    try {
      created = fs.fstatSync(handle, { bigint: true }); this.remember(vault, value.ideaId); fs.writeFileSync(handle, text); fs.fsyncSync(handle);
      const current = this.read(vault, locations.stage, parents);
      if (!same(created, current.stat) || current.text !== text || current.stat.nlink !== 1n) held();
      this.ideas.guard(vault, parents); fs.linkSync(locations.stage, locations.final);
      const authority = this.load(vault, value.ideaId);
      if (!same(authority.copies[0].stat, created)) held();
      return authority;
    } finally { fs.closeSync(handle); }
  }
  async finish(vault, authority) {
    this.checkAuthority(vault, authority); this.checkScope(vault, authority.value);
    if (!authority.copies.some(copy => copy.file === authority.locations.final)) {
      fs.linkSync(authority.locations.stage, authority.locations.final);
      const next = this.load(vault, authority.value.ideaId);
      if (!same(next.copies[0].stat, authority.copies[0].stat)) held();
      authority = next;
    }
    await this.ideas.checkpoint('idea-removal-after-marker');
    this.checkAuthority(vault, authority); this.checkScope(vault, authority.value);
    const priority = { stage: 0, note: 1, receipt: 2, intent: 3 };
    for (const target of [...authority.value.files].sort((a, b) => priority[a.kind] - priority[b.kind])) {
      this.checkAuthority(vault, authority);
      const remaining = this.checkScope(vault, authority.value);
      if (!remaining.files.some(file => file.path === target.path)) continue;
      const file = this.absolute(vault, target.path), current = this.read(vault, file, authority.parents);
      const peers = target.peers.filter(peer => this.exists(this.absolute(vault, peer)));
      if (current.stat.dev.toString() !== target.dev || current.stat.ino.toString() !== target.ino || current.stat.size.toString() !== target.size || digest(current.bytes) !== target.sha256 || current.stat.nlink !== BigInt(peers.length)) held();
      this.checkAuthority(vault, authority); fs.unlinkSync(file);
      await this.ideas.checkpoint('idea-removal-after-unlink');
    }
    this.checkAuthority(vault, authority);
    if (this.checkScope(vault, authority.value).files.length) held();
    const staged = authority.copies.find(copy => copy.file === authority.locations.stage);
    if (staged) { this.checkAuthority(vault, authority); fs.unlinkSync(staged.file); authority = this.load(vault, authority.value.ideaId); }
    this.checkAuthority(vault, authority);
    if (this.checkScope(vault, authority.value).files.length) held();
    for (const [operation, preview] of this.ideas.previews) if (preview.id === authority.value.ideaId) this.ideas.previews.delete(operation);
    return { id: authority.value.ideaId, complete: true };
  }
  async confirm({ operation }) {
    const value = this.previews.get(operation), vault = this.ideas.getVault();
    if (!value || !vault || value.vault !== vault.root) throw Error('Preview saved idea removal again before confirmation.');
    return withBriefMutation(path.join(vault.root, '.ideas'), async () => {
      this.allow(vault, value.ideaId);
      if (JSON.stringify(this.scope(vault, value.ideaId)) !== JSON.stringify({ parents: value.parents, files: value.files })) held();
      const authority = this.commit(vault, value); this.previews.delete(operation);
      return this.finish(vault, authority);
    });
  }
  async pending() {
    const vault = this.ideas.getVault(); if (!vault) return [];
    const parents = this.ideas.guard(vault), directory = path.join(vault.root, '.ideas'); if (!parents.has(directory)) return [];
    const ids = [...new Set(fs.readdirSync(directory).map(name => name.match(/^([a-f0-9-]{36})\.removed\.json(?:\.pending)?$/)?.[1]).filter(Boolean))].sort(), pending = [];
    for (const id of ids) {
      try {
        const authority = this.load(vault, id), current = this.checkScope(vault, authority.value);
        if (current.files.length || authority.copies.length !== 1 || authority.copies[0].file !== authority.locations.final) pending.push({ ...this.describe(vault, authority.value), held: false });
      } catch (error) { pending.push({ id, held: true, warnings: [`Saved idea removal held: ${error.message}`], files: [] }); }
    }
    return pending;
  }
  async resume({ id }) {
    if (!uuid(id)) held();
    const vault = this.ideas.getVault(); if (!vault) throw Error('Choose a vault first.');
    return withBriefMutation(path.join(vault.root, '.ideas'), async () => this.finish(vault, this.load(vault, id)));
  }
}
module.exports = { IdeasRemoval };
