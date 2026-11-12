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
const { validateAnnotationRemovals, activeAnnotationIntent, heldAnnotationIntent, isAnnotationIntent } = require('./annotation-authority');
const { validProof } = require('./staged-publication');
const { removalParentGuard, verifyRemovalTarget } = require('./source-recovery');
const { comparable } = require('./legacy-capture-ownership');
const rel = (vault, file) => path.relative(vault.vault, file).split(path.sep).join('/');
const reservedPath = (vault, reserved, file) => reserved.paths.has(comparable(rel(vault, file)));
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
function readStandaloneIntent(intake, name, value) {
  let intent, note;
  try {
    intent = JSON.parse(value.text);
    note = intake.validateAnnotationIntent(intent);
  } catch { throw changed(); }
  if (name !== activeAnnotationIntent && (name !== heldAnnotationIntent(intent.id) || !intent.annotationProof) ||
      ![1, 2].includes(value.links) || !value.raw.equals(Buffer.from(JSON.stringify(intent), 'utf8')) || intent.intentIdentity &&
      (intent.intentIdentity.dev !== value.dev || intent.intentIdentity.ino !== value.ino)) throw changed();
  return { intent, note };
}
const matchesPublication = (value, proof) => value.dev === proof.dev && value.ino === proof.ino && value.sha256 === proof.digest;
async function raw(vault, reserved) {
  const notes = [], directories = [], unsupported = new Set(), reservedIds = new Set(reserved.annotations);
  async function visit(folder) {
    directories.push(await directory(vault, folder));
    for (const entry of await fs.readdir(folder, { withFileTypes: true })) {
      if (['.git', '.obsidian', '.intake', '.codex', 'managed-home'].includes(entry.name.toLowerCase())) continue;
      const file = path.join(folder, entry.name);
      if (entry.isSymbolicLink()) throw changed();
      if (entry.isDirectory()) await visit(file);
      else if (entry.isFile() && entry.name.toLowerCase().endsWith('.md')) {
        const value = await leaf(vault, file), note = parseAnnotation(value.text);
        const isReserved = reservedPath(vault, reserved, file);
        if (note && isReserved) reservedIds.add(note.id);
        else if (note && entry.name.endsWith('.md')) notes.push({ ...value, ...note });
        else if (note) unsupported.add(note.id);
        else {
          // Unsupported copies still invalidate consent for their declared
          // identity. Only the first metadata block owns that identity; body
          // quotations remain independent writing.
          const header = value.text.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
          const document = header && YAML.parseDocument(header[1]);
          if (YAML.isMap(document?.contents)) {
            // Parser errors cannot erase explicit identity evidence. Read only
            // direct scalar declarations, without resolving aliases or merges;
            // this withholds deletion and never establishes ownership.
            const declarations = document.contents.items.filter(pair => YAML.isScalar(pair.key) && YAML.isScalar(pair.value));
            if (declarations.some(pair => pair.key.value === 'artifact_type' && pair.value.value === 'annotation')) {
              for (const pair of declarations) {
                if (pair.key.value !== 'companion_id' || !uuid(pair.value.value)) continue;
                unsupported.add(pair.value.value);
                if (isReserved) reservedIds.add(pair.value.value);
              }
            }
          }
        }
      }
    }
  }
  await visit(vault.vault);
  reserved.verify();
  return { notes, directories, unsupported, reservedIds };
}
async function inventory(vault, intake, ledger, id, captureId) {
  const reserved = vault.reservedRestorationIdentities(ledger);
  const scanned = await raw(vault, reserved), notes = scanned.notes.filter(note => note.id === id), candidates = [];
  if (scanned.unsupported.has(id) || scanned.reservedIds.has(id)) throw changed();
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
  let publication, publicationRecord, heldPublication;
  for (const [name, value] of entries) {
    if (name !== heldAnnotationIntent(id) && !value.text.includes(id)) continue;
    if (/^repair(?:-intent|-[a-f0-9-]{36})\.json$/.test(name)) throw Error('This annotation remains in mixed source repair data. Preserve and split that repair before selecting annotation removal.');
    if (isAnnotationIntent(name)) {
      const { intent, note } = readStandaloneIntent(intake, name, value);
      bind(note);
      if (publicationRecord && (publicationRecord.dev !== value.dev || publicationRecord.ino !== value.ino || publicationRecord.sha256 !== value.sha256)) throw changed();
      publicationRecord = value;
      publication = intent;
      if (name !== activeAnnotationIntent) heldPublication = true;
      candidates.push({ ...value, kind: 'annotation-intent' }); continue;
    }
    if (name === `annotation-${id}.stage`) {
      const note = parseAnnotation(value.text); if (!note) throw changed(); bind(note); candidates.push({ ...value, kind: 'annotation-stage' }); continue;
    }
    if (name === 'link-intent.json' || /^link-[a-f0-9-]{36}\.json$/.test(name)) {
      let object; try { object = JSON.parse(value.text); } catch {}
      const fields = ['schema', 'id', 'file', 'before', 'content', 'relative'];
      if (object && Object.hasOwn(object, 'stageProof')) fields.push('stageProof');
      if (object && Object.hasOwn(object, 'originalProof')) fields.push('originalProof');
      if (!strict(object, fields) || object.schema !== 1 || !uuid(object.id) || typeof object.before !== 'string' || typeof object.content !== 'string' || typeof object.relative !== 'string' || typeof object.file !== 'string' || /:/.test(object.file)) throw changed();
      if (fields.includes('stageProof') && (!validProof(object.stageProof) || Object.keys(object.stageProof).length !== 3 ||
          object.stageProof.digest !== hash(object.content))) throw changed();
      if (fields.includes('originalProof') && (!validProof(object.originalProof) || Object.keys(object.originalProof).length !== 3 ||
          object.originalProof.digest !== hash(object.before))) throw changed();
      if (!value.raw.equals(Buffer.from(JSON.stringify(object), 'utf8'))) throw changed();
      // Journals retain their native serialized path. Only manifest paths use
      // canonical separators; the normal destination boundary validates both.
      const destination = intake.destination({ relative: object.file });
      if (reservedPath(vault, reserved, destination)) throw changed();
      await vault.contained(path.dirname(destination));
      const before = parseAnnotation(object.before), after = parseAnnotation(object.content); if (!before || !after || after.id !== id || after.captureId !== before.captureId) throw changed(); bind(before);
      if (sourceLink(object.before, object.relative) !== object.content) throw changed();
      if (name !== 'link-intent.json' && name !== `link-${object.id}.json`) throw changed();
      links.set(object.id, object); candidates.push({ ...value, kind: 'relationship-journal' }); continue;
    }
    if (/^link-[a-f0-9-]{36}\.(?:before\.md|stage|held-(?:before|stage)-[a-f0-9]{64}\.md)$/.test(name)) continue;
    throw changed();
  }
  if (publication?.intentIdentity) {
    const staged = candidates.find(candidate => candidate.kind === 'annotation-stage');
    const publishedPath = rel(vault, path.join(vault.root, 'Annotations', `${id}.md`));
    const published = candidates.find(candidate => candidate.kind === 'annotation-note' && comparable(candidate.file) === comparable(publishedPath));
    const proof = publication.annotationProof;
    const matchesAnnotation = candidate => ['annotation-note', 'annotation-stage'].includes(candidate.kind) && matchesPublication(candidate, proof);
    const editedCanonical = heldPublication && !staged && published?.dev === proof?.dev && published?.ino === proof?.ino;
    const removal = ledger.annotationRemovals?.[id];
    // After confirmed removal retires the note and stage, the exact approved
    // targets still prove the intent while its own retirement is pending.
    const recorded = proof && removal?.phase === 'removing' && removal.captureId === captureId && removal.targets.some(matchesAnnotation);
    if (!proof && (staged || published)) throw changed();
    if (proof && (
      staged && !matchesPublication(staged, proof) || published && !matchesPublication(published, proof) && !editedCanonical ||
      !heldPublication && !candidates.some(matchesAnnotation) && !recorded
    )) throw changed();
  }
  for (const [name, value] of entries) {
    const match = name.match(/^link-([a-f0-9-]{36})\.(before\.md|stage|held-(?:before|stage)-[a-f0-9]{64}\.md)$/);
    if (!match || !value.text.includes(id) && !links.has(match[1])) continue;
    const intent = links.get(match[1]), note = parseAnnotation(value.text);
    if (!intent || !note) throw changed(); bind(note);
    if (match[2] === 'before.md' && (!intent.originalProof || !matchesPublication(value, intent.originalProof))) throw changed();
    if (match[2] === 'stage' && (!intent.stageProof || !matchesPublication(value, intent.stageProof))) throw changed();
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
  const root = await fs.realpath(vault.vault);
  reserved.verify();
  const scope = { captureId, root, targets, directories: [...directories.values()].sort((a, b) => a.file < b.file ? -1 : 1) };
  return { scope, verifyReserved: reserved.verify };
}
class AnnotationRemoval {
  constructor({ getVault, clearApprovals }) { Object.assign(this, { getVault, clearApprovals }); this.previews = new Map(); }
  vault() { const vault = this.getVault(); if (!vault) throw Error('Choose a vault first.'); return vault; }
  async list() {
    const vault = this.vault(), intake = new Intake(vault), ledger = await intake.load();
    const reserved = vault.reservedRestorationIdentities(ledger), scanned = await raw(vault, reserved);
    const notes = scanned.notes.filter(note => !ledger.annotationRemovals?.[note.id] && !scanned.reservedIds.has(note.id)).map(note => ({ id: note.id, captureId: note.captureId, file: note.file, text: note.content }));
    const pendingIds = new Set();
    const entries = await fs.readdir(intake.dir).catch(error => { if (error.code === 'ENOENT') return []; throw error; });
    for (const name of entries.filter(isAnnotationIntent)) {
      const intentFile = path.join(intake.dir, name);
      const pending = await leaf(vault, intentFile);
      const { intent } = readStandaloneIntent(intake, name, pending);
      if (ledger.annotationRemovals?.[intent.id] || scanned.reservedIds.has(intent.id) || pendingIds.has(intent.id)) continue;
      if (name === activeAnnotationIntent && !entries.includes(heldAnnotationIntent(intent.id))) {
        const stage = await leaf(vault, path.join(intake.dir, `annotation-${intent.id}.stage`));
        if (stage.text !== intent.annotation || intent.annotationProof && !matchesPublication(stage, intent.annotationProof)) throw changed();
      }
      // Reuse the raw classifier and exact parent/peer rules. Listing never
      // completes the pending writer or materializes its absent note.
      await inventory(vault, intake, ledger, intent.id, intent.captureId);
      pendingIds.add(intent.id);
      notes.push({ id: intent.id, captureId: intent.captureId, file: rel(vault, intentFile), text: intent.annotation, pending: true });
    }
    if (!intake.storage.matches(await intake.storage.view())) throw changed();
    reserved.verify();
    return notes;
  }
  async preview(id) {
    if (!uuid(id)) throw changed();
    const vault = this.vault(), intake = new Intake(vault), ledger = await intake.load();
    if (ledger.annotationRemovals?.[id]) throw Error('Review the existing annotation removal operation.');
    const { scope, verifyReserved } = await inventory(vault, intake, ledger, id);
    if (!scope.targets.length || !intake.storage.matches(await intake.storage.view())) throw changed();
    verifyReserved();
    const token = randomUUID(); this.previews.set(token, { id, scope, ledger: intake.storage.expected });
    return { token, id, targets: scope.targets.map(target => target.file) };
  }
  async confirm(token) {
    const selected = this.previews.get(token); if (!selected) throw Error('Preview annotation removal again.');
    const vault = this.vault();
    return sourceMutation(vault.root, async () => {
      const intake = new Intake(vault), ledger = await intake.load();
      const { scope, verifyReserved } = await inventory(vault, intake, ledger, selected.id);
      if (JSON.stringify(scope) !== JSON.stringify(selected.scope) || !intake.storage.matches(await intake.storage.view(), selected.ledger) || ledger.annotationRemovals?.[selected.id]) throw changed();
      ledger.annotationRemovals ||= {}; ledger.annotationRemovals[selected.id] = { operationId: randomUUID(), phase: 'removing', ...scope };
      await intake.save(ledger, verifyReserved); this.previews.delete(token); this.clearApprovals();
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
    const guard = removalParentGuard(vault, authority.directories);
    const verify = async () => {
      if (await fs.realpath(vault.vault) !== authority.root || !intake.storage.matches(await intake.storage.view())) throw changed();
      for (const expected of authority.directories) if (JSON.stringify(await directory(vault, path.join(vault.vault, expected.file))) !== JSON.stringify(expected)) throw changed();
      const { scope, verifyReserved } = await inventory(vault, intake, ledger, id, authority.captureId);
      for (const target of scope.targets) {
        const expected = authority.targets.find(item => item.file === target.file);
        if (!expected || ['sha256', 'dev', 'ino', 'bytes', 'kind'].some(key => target[key] !== expected[key]) || target.peers.some(peer => !expected.peers.includes(peer))) throw changed();
      }
      for (const target of authority.targets) {
        const actual = scope.targets.find(item => item.file === target.file);
        if (!actual) {
          const present = await fs.lstat(path.join(vault.vault, target.file)).then(() => true, error => { if (error.code === 'ENOENT') return false; throw error; });
          if (present) throw changed();
        }
      }
      for (const expected of authority.directories) if (JSON.stringify(await directory(vault, path.join(vault.vault, expected.file))) !== JSON.stringify(expected)) throw changed();
      if (!intake.storage.matches(await intake.storage.view())) throw changed();
      verifyReserved();
      return { ...scope, verifyReserved };
    };
    // Keep the validating journals until payloads are gone. A held standalone
    // intent also proves its active alias when neither payload survives.
    const order = target => {
      if (target.kind === 'annotation-intent') return path.posix.basename(target.file) === heldAnnotationIntent(id) ? 2 : 1;
      return Number(target.kind === 'relationship-journal');
    };
    const ordered = [...authority.targets].sort((a, b) => order(a) - order(b) || (a.file < b.file ? -1 : 1));
    for (const target of ordered) {
      const fresh = await verify(); if (!fresh.targets.some(item => item.file === target.file)) continue;
      await vault.checkpoint('annotation-removal-before-unlink'); const current = await verify();
      const expected = current.targets.find(item => item.file === target.file), actual = await leaf(vault, path.join(vault.vault, target.file));
      if (!expected || ['sha256', 'dev', 'ino', 'bytes'].some(key => actual[key] !== expected[key]) || actual.links !== expected.peers.length || !intake.storage.matches(await intake.storage.view())) throw changed();
      intake.storage.guardSync();
      current.verifyReserved();
      verifyRemovalTarget(vault, target, expected.peers, guard, changed);
      await fs.unlink(path.join(vault.vault, target.file)); await vault.checkpoint('annotation-removal-unlinked');
    }
    const final = await verify();
    if (final.targets.length) throw changed();
    authority.phase = 'removed'; await intake.save(ledger, final.verifyReserved); return true;
  }
}
function installAnnotationRemoval(options) {
  const store = new AnnotationRemoval(options);
  for (const operation of ['list', 'pending', 'resume', 'preview', 'confirm']) options.ipcMain.handle('annotation-remove-' + operation, (_, input) => store[operation](input));
  options.ipcMain.handle('annotation-remove-cancel', (_, token) => store.previews.delete(token));
  return store;
}
module.exports = { AnnotationRemoval, installAnnotationRemoval };
