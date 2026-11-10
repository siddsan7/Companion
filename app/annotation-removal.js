const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const YAML = require('yaml');
const { Intake } = require('./intake');
const { parseAnnotation } = require('./vault');
const { sourceMutation } = require('./source-mutation');
const { hash } = require('./intake-producer');
const { uuid } = require('./source-authority');
const { sourceLink } = require('./repairs');
const { validateAnnotationRemovals } = require('./annotation-authority');
const rel = (vault, file) => path.relative(vault.vault, file).split(path.sep).join('/');
const changed = () => Error('Annotation removal scope changed or contains an unknown copy. Preserve the writing and review again.');
const strict = (value, keys) => value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
async function directory(vault, file) {
  const stat = await fs.lstat(file, { bigint: true });
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw changed();
  await vault.contained(file); return { file: rel(vault, file), dev: String(stat.dev), ino: String(stat.ino) };
}
async function leaf(vault, file) {
  const before = await fs.lstat(file, { bigint: true });
  if (!before.isFile() || before.isSymbolicLink()) throw changed();
  await vault.contained(file);
  const handle = await fs.open(file, 'r'); let bytes;
  try {
    const opened = await handle.stat({ bigint: true }); if (opened.dev !== before.dev || opened.ino !== before.ino) throw changed();
    bytes = await handle.readFile();
    const after = await handle.stat({ bigint: true }), final = await fs.lstat(file, { bigint: true });
    if ([after, final].some(stat => stat.dev !== before.dev || stat.ino !== before.ino || stat.nlink !== before.nlink || stat.size !== before.size || stat.mtimeNs !== before.mtimeNs) || BigInt(bytes.length) !== before.size) throw changed();
  } finally { await handle.close(); }
  return { file: rel(vault, file), sha256: hash(bytes), dev: String(before.dev), ino: String(before.ino), bytes: String(bytes.length), links: Number(before.nlink), raw: bytes, text: new TextDecoder('utf-8', { fatal: true }).decode(bytes) };
}
async function raw(vault) {
  const notes = [], directories = [], unsupported = new Set();
  async function visit(folder) {
    directories.push(await directory(vault, folder));
    for (const entry of await fs.readdir(folder, { withFileTypes: true })) {
      if (['.git', '.obsidian', '.intake', '.codex', 'managed-home'].includes(entry.name.toLowerCase())) continue;
      const file = path.join(folder, entry.name);
      if (entry.isSymbolicLink()) throw changed();
      if (entry.isDirectory()) await visit(file);
      else if (entry.isFile() && entry.name.toLowerCase().endsWith('.md')) {
        const value = await leaf(vault, file), note = parseAnnotation(value.text);
        if (note && entry.name.endsWith('.md')) notes.push({ ...value, ...note });
        else if (note) unsupported.add(note.id);
        else {
          // Unsupported copies still invalidate consent for their declared
          // identity. Only the first metadata block owns that identity; body
          // quotations remain independent writing.
          const header = value.text.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
          let fields; try { fields = header && YAML.parse(header[1]); } catch {}
          if (fields?.artifact_type === 'annotation' && uuid(fields.companion_id)) unsupported.add(fields.companion_id);
        }
      }
    }
  }
  await visit(vault.vault); return { notes, directories, unsupported };
}
async function inventory(vault, intake, id, captureId) {
  const scanned = await raw(vault), notes = scanned.notes.filter(note => note.id === id), candidates = [];
  if (scanned.unsupported.has(id)) throw changed();
  const bind = note => { if (note.id !== id || captureId && note.captureId !== captureId) throw changed(); captureId ||= note.captureId; };
  for (const note of notes) { bind(note); candidates.push({ ...note, kind: 'annotation-note' }); }
  const entries = new Map();
  for (const entry of await fs.readdir(intake.dir, { withFileTypes: true })) {
    if (entry.name === 'ledger.json') continue;
    const file = path.join(intake.dir, entry.name);
    if (!entry.isFile() || entry.isSymbolicLink()) throw changed();
    const value = await leaf(vault, file); entries.set(entry.name, value);
  }
  const links = new Map();
  for (const [name, value] of entries) {
    if (!value.text.includes(id)) continue;
    let object; try { object = JSON.parse(value.text); } catch {}
    if (/^repair(?:-intent|-[a-f0-9-]{36})\.json$/.test(name)) throw Error('This annotation remains in mixed source repair data. Preserve and split that repair before selecting annotation removal.');
    if (name === 'annotation-intent.json') {
      if (!strict(object, ['schema', 'id', 'captureId', 'annotation']) || object.schema !== 1 || object.id !== id || typeof object.annotation !== 'string') throw changed();
      if (!value.raw.equals(Buffer.from(JSON.stringify(object), 'utf8'))) throw changed();
      const note = parseAnnotation(object.annotation); if (!note || note.captureId !== object.captureId) throw changed(); bind(note);
      candidates.push({ ...value, kind: 'annotation-intent' }); continue;
    }
    if (name === `annotation-${id}.stage`) {
      const note = parseAnnotation(value.text); if (!note) throw changed(); bind(note); candidates.push({ ...value, kind: 'annotation-stage' }); continue;
    }
    if (name === 'link-intent.json' || /^link-[a-f0-9-]{36}\.json$/.test(name)) {
      if (!strict(object, ['schema', 'id', 'file', 'before', 'content', 'relative']) || object.schema !== 1 || !uuid(object.id) || typeof object.before !== 'string' || typeof object.content !== 'string' || typeof object.relative !== 'string' || typeof object.file !== 'string' || /:/.test(object.file)) throw changed();
      if (!value.raw.equals(Buffer.from(JSON.stringify(object), 'utf8'))) throw changed();
      // Journals retain their native serialized path. Only manifest paths use
      // canonical separators; the normal destination boundary validates both.
      const destination = intake.destination({ relative: object.file });
      await vault.contained(path.dirname(destination));
      const before = parseAnnotation(object.before), after = parseAnnotation(object.content); if (!before || !after || after.id !== id || after.captureId !== before.captureId) throw changed(); bind(before);
      if (sourceLink(object.before, object.relative) !== object.content) throw changed();
      if (name !== 'link-intent.json' && name !== `link-${object.id}.json`) throw changed();
      links.set(object.id, object); candidates.push({ ...value, kind: 'relationship-journal' }); continue;
    }
    if (/^link-[a-f0-9-]{36}\.(?:before\.md|stage|held-(?:before|stage)-[a-f0-9]{64}\.md)$/.test(name)) continue;
    throw changed();
  }
  for (const [name, value] of entries) {
    const match = name.match(/^link-([a-f0-9-]{36})\.(before\.md|stage|held-(?:before|stage)-[a-f0-9]{64}\.md)$/);
    if (!match || !value.text.includes(id) && !links.has(match[1])) continue;
    const intent = links.get(match[1]), note = parseAnnotation(value.text);
    if (!intent || !note) throw changed(); bind(note);
    candidates.push({ ...value, kind: match[2] === 'before.md' ? 'relationship-before' : match[2] === 'stage' ? 'relationship-stage' : 'relationship-held' });
  }
  if (!uuid(captureId)) throw changed();
  const targets = candidates.map(value => {
    const peers = candidates.filter(peer => peer.dev === value.dev && peer.ino === value.ino).map(peer => peer.file).sort();
    if (value.links !== peers.length || peers.some(file => candidates.find(peer => peer.file === file).sha256 !== value.sha256)) throw changed();
    return { file: value.file, sha256: value.sha256, dev: value.dev, ino: value.ino, bytes: value.bytes, kind: value.kind, peers };
  }).sort((a, b) => a.file < b.file ? -1 : 1);
  const directories = new Map();
  for (const file of [intake.dir, ...targets.map(target => path.dirname(path.join(vault.vault, target.file)))]) {
    let current = file;
    while (true) {
      const value = await directory(vault, current); directories.set(value.file, value);
      if (current === vault.vault) break;
      current = path.dirname(current);
      const parent = path.relative(vault.vault, current); if (parent === '..' || parent.startsWith('..' + path.sep) || path.isAbsolute(parent)) throw changed();
    }
  }
  return { captureId, root: await fs.realpath(vault.vault), targets, directories: [...directories.values()].sort((a, b) => a.file < b.file ? -1 : 1) };
}
class AnnotationRemoval {
  constructor({ getVault, clearApprovals }) { Object.assign(this, { getVault, clearApprovals }); this.previews = new Map(); }
  vault() { const vault = this.getVault(); if (!vault) throw Error('Choose a vault first.'); return vault; }
  async list() {
    const vault = this.vault(), intake = new Intake(vault), ledger = await intake.load(), scanned = await raw(vault);
    const notes = scanned.notes.filter(note => !ledger.annotationRemovals?.[note.id]).map(note => ({ id: note.id, captureId: note.captureId, file: note.file, text: note.content }));
    const intentFile = path.join(intake.dir, 'annotation-intent.json');
    const pending = await leaf(vault, intentFile).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
    if (pending) {
      const intent = JSON.parse(pending.text);
      if (!strict(intent, ['schema', 'id', 'captureId', 'annotation']) || intent.schema !== 1 || !uuid(intent.id) || !uuid(intent.captureId) || typeof intent.annotation !== 'string') throw changed();
      if (!pending.raw.equals(Buffer.from(JSON.stringify(intent), 'utf8'))) throw changed();
      const annotation = parseAnnotation(intent.annotation);
      if (!annotation || annotation.id !== intent.id || annotation.captureId !== intent.captureId) throw changed();
      if (!ledger.annotationRemovals?.[intent.id]) {
        const stage = await leaf(vault, path.join(intake.dir, `annotation-${intent.id}.stage`));
        if (stage.text !== intent.annotation) throw changed();
        // Reuse the raw classifier and exact parent/peer rules. Listing never
        // completes the pending writer or materializes its absent note.
        await inventory(vault, intake, intent.id, intent.captureId);
        notes.push({ id: intent.id, captureId: intent.captureId, file: rel(vault, intentFile), text: intent.annotation, pending: true });
      }
    }
    if (!intake.storage.matches(await intake.storage.view())) throw changed();
    return notes;
  }
  async preview(id) {
    if (!uuid(id)) throw changed();
    const vault = this.vault(), intake = new Intake(vault), ledger = await intake.load();
    if (ledger.annotationRemovals?.[id]) throw Error('Review the existing annotation removal operation.');
    const scope = await inventory(vault, intake, id); if (!scope.targets.length || !intake.storage.matches(await intake.storage.view())) throw changed();
    const token = randomUUID(); this.previews.set(token, { id, scope, ledger: intake.storage.expected });
    return { token, id, targets: scope.targets.map(target => target.file) };
  }
  async confirm(token) {
    const selected = this.previews.get(token); if (!selected) throw Error('Preview annotation removal again.');
    const vault = this.vault();
    return sourceMutation(vault.root, async () => {
      const intake = new Intake(vault), ledger = await intake.load(), scope = await inventory(vault, intake, selected.id);
      if (JSON.stringify(scope) !== JSON.stringify(selected.scope) || !intake.storage.matches(await intake.storage.view(), selected.ledger) || ledger.annotationRemovals?.[selected.id]) throw changed();
      ledger.annotationRemovals ||= {}; ledger.annotationRemovals[selected.id] = { operationId: randomUUID(), phase: 'removing', ...scope };
      await intake.save(ledger); this.previews.delete(token); this.clearApprovals();
      await vault.checkpoint('annotation-removal-authorized');
      return this.finish(vault, intake, ledger, selected.id);
    });
  }
  async pending() {
    const ledger = await new Intake(this.vault()).load();
    return Object.entries(ledger.annotationRemovals || {}).filter(([, value]) => value.phase === 'removing').map(([id, value]) => ({ id, operationId: value.operationId, targets: value.targets.map(target => target.file) }));
  }
  async resume({ id, operationId }) {
    const vault = this.vault(); return sourceMutation(vault.root, async () => {
      const intake = new Intake(vault), ledger = await intake.load();
      if (!uuid(id) || ledger.annotationRemovals?.[id]?.phase !== 'removing' || ledger.annotationRemovals[id].operationId !== operationId) throw changed();
      return this.finish(vault, intake, ledger, id);
    });
  }
  async finish(vault, intake, ledger, id) {
    const authority = ledger.annotationRemovals[id]; validateAnnotationRemovals(ledger);
    const verify = async () => {
      if (await fs.realpath(vault.vault) !== authority.root || !intake.storage.matches(await intake.storage.view())) throw changed();
      for (const expected of authority.directories) if (JSON.stringify(await directory(vault, path.join(vault.vault, expected.file))) !== JSON.stringify(expected)) throw changed();
      const fresh = await inventory(vault, intake, id, authority.captureId);
      for (const target of fresh.targets) {
        const expected = authority.targets.find(item => item.file === target.file);
        if (!expected || ['sha256', 'dev', 'ino', 'bytes', 'kind'].some(key => target[key] !== expected[key]) || target.peers.some(peer => !expected.peers.includes(peer))) throw changed();
      }
      for (const target of authority.targets) {
        const actual = fresh.targets.find(item => item.file === target.file);
        if (!actual) {
          const present = await fs.lstat(path.join(vault.vault, target.file)).then(() => true, error => { if (error.code === 'ENOENT') return false; throw error; });
          if (present) throw changed();
        }
      }
      for (const expected of authority.directories) if (JSON.stringify(await directory(vault, path.join(vault.vault, expected.file))) !== JSON.stringify(expected)) throw changed();
      if (!intake.storage.matches(await intake.storage.view())) throw changed();
      return fresh;
    };
    // Relationship payloads must go before their validating journals. A crash
    // must leave enough reviewed association to classify every remaining copy.
    const ordered = [...authority.targets].sort((a, b) => Number(a.kind === 'relationship-journal' || a.kind === 'annotation-intent') - Number(b.kind === 'relationship-journal' || b.kind === 'annotation-intent') || (a.file < b.file ? -1 : 1));
    for (const target of ordered) {
      const fresh = await verify(); if (!fresh.targets.some(item => item.file === target.file)) continue;
      await vault.checkpoint('annotation-removal-before-unlink'); const current = await verify();
      const expected = current.targets.find(item => item.file === target.file), actual = await leaf(vault, path.join(vault.vault, target.file));
      if (!expected || ['sha256', 'dev', 'ino', 'bytes'].some(key => actual[key] !== expected[key]) || actual.links !== expected.peers.length || !intake.storage.matches(await intake.storage.view())) throw changed();
      await fs.unlink(path.join(vault.vault, target.file)); await vault.checkpoint('annotation-removal-unlinked');
    }
    if ((await verify()).targets.length) throw changed();
    authority.phase = 'removed'; await intake.save(ledger); return true;
  }
}
function installAnnotationRemoval(options) {
  const store = new AnnotationRemoval(options);
  for (const operation of ['list', 'pending', 'resume', 'preview', 'confirm']) options.ipcMain.handle('annotation-remove-' + operation, (_, input) => store[operation](input));
  options.ipcMain.handle('annotation-remove-cancel', (_, token) => store.previews.delete(token));
  return store;
}
module.exports = { AnnotationRemoval, installAnnotationRemoval };
