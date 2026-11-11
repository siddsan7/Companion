const fs = require('node:fs/promises');
const local = require('node:fs');
const path = require('node:path');
const { randomUUID, createHash } = require('node:crypto');
const YAML = require('yaml');
const { sourceMutation } = require('./source-mutation');
const { assertPublication } = require('./source-authority');
const {
  ordinaryDirectories, readExact, readExactSync, writeStage, verifyStage, verifyStageSync, verifyAbsentSync,
  verifyPeers, verifyPeersSync, removeStage, removeLinkedStage, validProof, settlePublishedLink
} = require('./staged-publication');
const { captureOwners, comparable, ownerWarning, parentOf, storeName } = require('./legacy-capture-ownership');
const hash = text => createHash('sha256').update(text).digest('hex');
const missing = error => { if (error.code === 'ENOENT') return null; throw error; };
const artifactAreas = ['Captures', 'Annotations', 'Ideas', 'Briefs', 'Revisions'];
const comparableRelative = value => comparable(process.platform === 'win32' ? value.replace(/\\/g, '/') : value);
const stagingHeld = () => Error('Staging ownership could not be verified. Files were preserved for inspection.');
const titleHeld = () => Object.assign(stagingHeld(), { code: 'TITLE_PUBLICATION_HELD' });
const temporaryFileError = error => ['EACCES', 'EPERM', 'EBUSY', 'EMFILE', 'ENFILE', 'ENOSPC'].includes(error.code);
function restorationReadRefused(error, file) {
  return process.platform === 'win32' && ['EACCES', 'EPERM', 'EBUSY'].includes(error?.code) &&
    typeof error.path === 'string' && comparable(path.resolve(error.path)) === comparable(path.resolve(file));
}
function matchesRestorationFile(file, proof, guard) {
  guard();
  const stat = local.lstatSync(file, { bigint: true, throwIfNoEntry: false });
  return validProof(proof) && stat?.isFile() && !stat.isSymbolicLink() && stat.nlink === 1n &&
    String(stat.dev) === proof.dev && String(stat.ino) === proof.ino;
}
const titleRollbackSuffix = '.title-rollback.json';
const transactionSuffix = '.title-transaction.json';
const transactionBackup = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}\.bak$/;
const rollbackStage = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}\.pending$/;
async function noteLock(file, guard) {
  const lock = await readExact(`${file}.lock`, guard).catch(missing);
  if (!lock) return null;
  let owner;
  try { owner = JSON.parse(lock.bytes); } catch { return { ...lock, unknown: true }; }
  if (!Number.isInteger(owner?.pid) || owner.pid < 1) return { ...lock, unknown: true };
  let live = true;
  try { process.kill(owner.pid, 0); } catch (error) { if (error.code === 'ESRCH') live = false; }
  return { ...lock, live, legacy: Object.keys(owner).length === 1, publication: owner.publication };
}
function markdown(note, parent) {
  return `---\ncompanion_id: ${JSON.stringify(note.id)}\nartifact_type: "capture"\nschema_version: 1\nmanaged_parent: ${JSON.stringify(parent)}\ncapture_type: ${JSON.stringify(note.type)}\ncaptured_at: ${JSON.stringify(note.capturedAt)}\ntitle: ${JSON.stringify(note.title)}\nsource_url: ${JSON.stringify(note.url || '')}\nprovenance: ${JSON.stringify(note.excerpt ? 'user-supplied excerpt; webpage not verified' : 'user capture')}\n---\n\n# ${note.title.replace(/[\r\n]/g, ' ')}\n\n${note.text}\n${note.excerpt ? `\n## User-supplied excerpt\n\n${note.excerpt}\n\nSource URL (as entered): ${note.url}\n\nThis excerpt was supplied by the user. Companion did not fetch or verify the webpage.\n` : ''}`;
}
function parse(text) {
  const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  if (!match) return null;
  let fields; try { fields = YAML.parse(match[1]); } catch { return null; }
  if (!fields || typeof fields !== 'object' || typeof fields.companion_id !== 'string' || !fields.companion_id.trim() || /[\r\n]/.test(fields.companion_id) || fields.artifact_type !== 'capture' || fields.schema_version !== 1 || !['thought', 'link', 'reel_import'].includes(fields.capture_type) || typeof fields.title !== 'string' || !fields.title.trim() || /[\r\n]/.test(fields.title) || typeof fields.captured_at !== 'string' || !/T.*(?:Z|[+-]\d\d:\d\d)$/.test(fields.captured_at) || !Number.isFinite(Date.parse(fields.captured_at))) return null;
  const note = { id: fields.companion_id, title: fields.title, type: fields.capture_type, capturedAt: fields.captured_at, content: text };
  if (Object.hasOwn(fields, 'managed_parent')) note.managedParent = fields.managed_parent;
  return note;
}
function parseAnnotation(text) {
  const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  let fields; try { fields = match && YAML.parse(match[1]); } catch { return null; }
  const uuid = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/;
  if (!fields || fields.artifact_type !== 'annotation' || fields.schema_version !== 1 || !uuid.test(fields.companion_id) || !uuid.test(fields.capture_id)) return null;
  return { id: fields.companion_id, captureId: fields.capture_id, content: text };
}
function captureHeading(title, type) {
  // Imported titles are source text. Escape punctuation so Markdown images,
  // HTML and vault links cannot become active in the generated display heading.
  const literal = type === 'reel_import' ? title.replace(/[\x21-\x2f\x3a-\x40\x5b-\x60\x7b-\x7e]/g, character => `\\${character}`) : title;
  return `# ${literal}`;
}
function withTitle(content, title) {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  const metadata = YAML.parseDocument(match[1]), previous = metadata.get('title'); metadata.set('title', title);
  let body = content.slice(match[0].length);
  // Only the exact generated heading at its original position belongs to the display title.
  for (const newline of ['\n', '\r\n']) {
    const generated = `${newline}${captureHeading(previous, metadata.get('capture_type'))}${newline}`;
    if (body.startsWith(generated)) { body = `${newline}${captureHeading(title, metadata.get('capture_type'))}${newline}${body.slice(generated.length)}`; break; }
  }
  return `---\n${metadata.toString()}---\n${body}`;
}
class Vault {
  constructor(vault, parent, { checkpoint = async () => {} } = {}) {
    if (typeof vault !== 'string' || !path.isAbsolute(vault)) throw Error('Choose an absolute vault folder.');
    if (typeof parent !== 'string' || !parent.trim() || /[<>:"|?*]/.test(parent) || parent.split(/[\\/]/).some(part => !part || part === '.' || part === '..')) throw Error('Use a relative parent folder without reserved characters.');
    this.vault = vault; this.root = path.join(vault, parent); this.expected = new Map(); this.checkpoint = checkpoint; this.warnings = []; this.titleRecoveryErrors = new Map();
  }
  async contained(target) {
    const anchor = await fs.realpath(this.vault), actual = await fs.realpath(target), relative = path.relative(anchor, actual);
    if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw Error('A folder points outside the selected vault. Choose an ordinary folder inside the vault.');
  }
  async setup() {
    await fs.mkdir(this.vault, { recursive: true });
    const relative = path.relative(this.vault, this.root).split(path.sep); let current = this.vault;
    for (const segment of relative) { current = path.join(current, segment); await fs.mkdir(current).catch(error => { if (error.code !== 'EEXIST') throw error; }); await this.contained(current); }
    for (const area of artifactAreas) { const target = path.join(this.root, area); await fs.mkdir(target).catch(error => { if (error.code !== 'EEXIST') throw error; }); await this.contained(target); }
  }
  async writable() { await this.contained(this.root); await this.contained(path.join(this.root, 'Captures')); }
  publicationFolders(directory, expected) {
    const folders = new Set([this.vault]);
    for (const leaf of [path.join(this.root, 'Captures'), directory]) {
      let current = this.vault;
      const relative = path.relative(current, leaf);
      if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw Error('Publication folder is outside the selected vault.');
      for (const part of relative.split(path.sep).filter(Boolean)) { current = path.join(current, part); folders.add(current); }
    }
    return ordinaryDirectories([...folders], 'A publication folder changed or is an alias. Files were preserved for inspection.', expected);
  }
  async acquire(file, publication, guard = () => {}) {
    const owner = `${file}.lock-owner-${randomUUID()}`;
    const lock = `${file}.lock`;
    const proof = await writeStage(owner, JSON.stringify({ pid: process.pid, ...(publication ? { publication } : {}) }), guard);
    let linked = false;
    try {
      await verifyStage(owner, guard, proof);
      verifyStageSync(owner, guard, proof);
      local.linkSync(owner, lock);
      linked = true;
      await verifyPeers(owner, lock, guard, proof);
      await removeLinkedStage(owner, lock, guard, proof);
      verifyStageSync(lock, guard, proof);
      return proof;
    } finally { if (!linked) await removeStage(owner, guard, proof).catch(() => {}); }
  }
  async release(file, proof, guard) {
    const lock = `${file}.lock`;
    const remove = proof ? removeStage(lock, guard, proof) : fs.unlink(lock);
    await remove.catch(error => { if (error.code !== 'ENOENT') this.warnings.push('A saved-note lock could not be removed. Inspect it before continuing.'); });
  }
  async releaseCaptureLock(file, stage, guard, owner, published) {
    const lock = `${file}.lock`;
    const verifySettlement = () => {
      verifyAbsentSync(stage, guard);
      verifyStageSync(file, guard, published);
    };
    try { await removeStage(lock, guard, owner, 1, verifySettlement); }
    catch (error) {
      if (!temporaryFileError(error)) throw error;
      verifySettlement();
      verifyStageSync(lock, guard, owner);
      this.warnings.push('A saved-note lock could not be removed. Inspect it before continuing.');
    }
    verifySettlement();
  }
  async scan({ annotations = false, excludedCapturePaths } = {}) {
    await this.writable();
    const notes = [];
    const visit = async dir => {
      await this.contained(dir);
      for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
        if (['.intake', '.obsidian', '.git', '.codex', 'managed-home', storeName].includes(entry.name.toLowerCase())) continue;
        const file = path.join(dir, entry.name);
        if (entry.isDirectory() && !entry.isSymbolicLink()) await visit(file);
        else if (entry.isFile() && entry.name.endsWith('.md')) {
          if (excludedCapturePaths?.has(comparableRelative(path.relative(this.vault, file)))) continue;
          await this.contained(file); const content = await fs.readFile(file, 'utf8'), note = annotations ? parseAnnotation(content) : parse(content);
          if (note) notes.push({ ...note, file });
          else if (!annotations && /^(?:companion_id|artifact_type):/m.test(content) && path.dirname(file) === path.join(this.root, 'Captures')) this.warnings.push('Invalid capture metadata in ' + entry.name + '. The file was preserved; repair its identity, type, schema, title and absolute captured_at timestamp.');
        }
      }
    };
    try { await visit(this.vault); } catch (error) { throw Error('Vault access failure. Restore access to all vault folders before identity reconciliation. Notes and history were preserved; no missing-note removal was inferred.', { cause: error }); }
    return notes;
  }
  async list() {
    return sourceMutation(this.root, () => this.listOwned());
  }
  matchesManualParent(note) {
    return note.type !== 'reel_import' && typeof note.managedParent === 'string' &&
      comparable(note.managedParent) === comparable(parentOf(this.vault, this.root));
  }
  reservedRestorationPaths(ledger) {
    const heldRestorations = new Map(), paths = new Set(), slots = [];
    const intake = new (require('./intake').Intake)(this);
    const { requiredDirectories, removalParentGuard } = require('./source-recovery');
    for (const [id, authority] of Object.entries(ledger.sourceAuthority || {})) {
      if (authority.phase !== 'restoring' || authority.manual) continue;
      const capture = ledger.captures[authority.sourceHash];
      if (capture?.id !== id || !ledger.suppressed.includes(authority.sourceHash) ||
          comparable(path.resolve(this.vault)) !== comparable(authority.root)) {
        throw Error('The recorded restoration path or vault identity changed. Files were preserved.');
      }
      const file = intake.destination(capture), relative = comparableRelative(path.relative(this.vault, file));
      if (!authority.targets.some(target => target.kind === 'capture' && comparableRelative(target.file) === relative) || paths.has(relative)) {
        throw Error('The selected capture path disagrees with the recorded restoration target. Files were preserved.');
      }
      const recorded = new Set(authority.directories.map(item => comparableRelative(item.file)));
      const required = requiredDirectories(intake, [{ file: path.relative(this.vault, file) }]);
      if ([...required].some(parent => !recorded.has(comparableRelative(parent)))) {
        throw Error('The recorded restoration folder scope is incomplete. Files were preserved.');
      }
      const guard = removalParentGuard(this, authority.directories);
      slots.push({ id, file, guard, authority, capture });
      heldRestorations.set(id, file);
      paths.add(relative);
    }
    const guard = () => { for (const slot of slots) slot.guard(); };
    return { heldRestorations, paths, guard, slots };
  }
  reservedRestorationIdentities(ledger, { verifyIndependentJournal } = {}) {
    const reservation = this.reservedRestorationPaths(ledger);
    const captures = new Set(), annotations = new Set(), observations = [];
    for (const slot of reservation.slots) {
      const { id, file, guard, authority } = slot;
      guard();
      const stat = local.lstatSync(file, { bigint: true, throwIfNoEntry: false });
      if (!stat) {
        verifyAbsentSync(file, guard);
        observations.push(() => verifyAbsentSync(file, guard));
        continue;
      }
      if (stat.nlink === 2n && !authority.restoration.published) {
        observations.push(this.verifyActiveRestorationPair(id, file, guard, authority));
        continue;
      }
      // Observe only identity claims. A reserved slot can never confer ownership.
      const links = authority.restoration.published ? Number(stat.nlink) : 1;
      let observed;
      try { observed = readExactSync(file, guard, links); }
      catch (error) {
        if (!restorationReadRefused(error, file)) throw error;
        if (!verifyIndependentJournal) throw Error('A reserved restoration capture cannot be read. Identity inspection is paused.', { cause: error });
        const verify = this.restorationCaptureReadProof(slot, error, verifyIndependentJournal);
        if (!verify) throw error;
        observations.push(verify);
        continue;
      }
      const { bytes, proof } = observed, text = bytes.toString('utf8');
      observations.push(() => verifyStageSync(file, guard, proof, links));
      const capture = parse(text), annotation = parseAnnotation(text);
      if (capture && capture.id !== id) captures.add(capture.id);
      if (annotation) annotations.add(annotation.id);
    }
    const verify = () => {
      reservation.guard();
      for (const observe of observations) observe();
    };
    return { heldRestorations: reservation.heldRestorations, paths: reservation.paths, captures, annotations, verify };
  }
  restorationCaptureReadProof({ file, guard, authority, capture }, error, verifyIndependentJournal) {
    const { published, importedPublication, journal, revision } = authority.restoration;
    if (!published || !importedPublication || importedPublication.capture.digest !== capture.currentHash ||
        capture.currentRevision !== revision || !restorationReadRefused(error, file) ||
        !matchesRestorationFile(file, importedPublication.capture, guard)) return null;
    const dir = path.join(this.root, '.intake');
    const verify = () => {
      if (verifyIndependentJournal) verifyIndependentJournal();
      else verifyAbsentSync(path.join(dir, 'transaction.json'), guard);
      verifyStageSync(path.join(dir, journal), guard, importedPublication.journal);
      verifyAbsentSync(path.join(dir, revision + '.stage'), guard);
      verifyAbsentSync(path.join(dir, revision + '.snapshot.stage'), guard);
      if (!matchesRestorationFile(file, importedPublication.capture, guard)) {
        throw Error('The exact unreadable restoration capture changed. Files were preserved.');
      }
    };
    verify();
    return verify;
  }
  heldRestorationCaptureReadRefusal(ledger, error) {
    const { slots } = this.reservedRestorationPaths(ledger);
    const slot = slots.find(item => restorationReadRefused(error, item.file));
    return !!slot && !!this.restorationCaptureReadProof(slot, error);
  }
  verifyActiveRestorationPair(id, file, guard, authority) {
    const intake = new (require('./intake').Intake)(this);
    const { revision, journal, sha256, importedPublication } = authority.restoration;
    const selected = path.join(intake.dir, journal), active = path.join(intake.dir, 'transaction.json');
    const stage = path.join(intake.dir, revision + '.stage');
    const { bytes, proof: journalProof } = readExactSync(selected, guard, 2, importedPublication?.journal);
    const tx = JSON.parse(bytes);
    intake.validateTransaction(tx);
    if (journalProof.digest !== sha256 || tx.capture.id !== id || tx.revision.id !== revision ||
        tx.sourceHash !== authority.sourceHash || tx.sourceGeneration !== authority.generation ||
        tx.restoreOperation !== authority.operationId || comparable(intake.destination(tx.capture)) !== comparable(file)) {
      throw Error('The active restoration pair disagrees with its recorded identity. Files were preserved.');
    }
    const { proof } = readExactSync(file, guard, 2, importedPublication?.capture);
    if (proof.digest !== tx.capture.currentHash) throw Error('The active restoration capture changed. Files were preserved.');
    const verify = () => {
      verifyStageSync(selected, guard, journalProof, 2);
      verifyStageSync(active, guard, journalProof, 2);
      verifyStageSync(stage, guard, proof, 2);
      verifyStageSync(file, guard, proof, 2);
    };
    verify();
    return verify;
  }
  async captureInventory({ ledger, guardLedger, id } = {}) {
    if (!ledger) {
      const intake = new (require('./intake').Intake)(this);
      ledger = await intake.load();
      guardLedger = () => intake.storage.guard();
    }
    const reserved = this.reservedRestorationIdentities(ledger), { heldRestorations } = reserved;
    const all = await this.scan({ excludedCapturePaths: reserved.paths });
    reserved.verify();
    const notes = all.filter(note => !heldRestorations.has(note.id) && (!id || note.id === id));
    const unclaimed = notes.filter(note => !reserved.captures.has(note.id));
    const imported = new Set(Object.values(ledger.captures).map(capture => capture.id));
    const excluded = new Set(notes.filter(note => {
      const relative = comparableRelative(path.relative(this.vault, note.file));
      return ledger.identityChoices?.[note.id]?.copies.some(copy => typeof copy.file === 'string' && comparableRelative(copy.file) === relative);
    }));
    const { owned: legacy, held } = await captureOwners(this, unclaimed, imported, excluded, ledger.sourceAuthority, async () => {
      await guardLedger();
      reserved.verify();
    });
    reserved.verify();
    if (!id) this.warnings = this.warnings.filter(warning => warning !== ownerWarning);
    if (held && !this.warnings.includes(ownerWarning)) this.warnings.push(ownerWarning);
    const repairable = new Set(unclaimed.filter(note => imported.has(note.id) || note.type === 'reel_import' || this.matchesManualParent(note) || legacy.has(note)));
    const owned = new Set([...repairable].filter(note => !excluded.has(note)));
    return { notes, owned, repairable, excluded, heldRestorations, reserved };
  }
  async publication(id, transaction = {}) {
    const intake = new (require('./intake').Intake)(this), ledger = await intake.load();
    await require('./source-recovery').pendingParents(intake, ledger);
    assertPublication(ledger, id, transaction); return ledger.sourceAuthority?.[id]?.generation;
  }
  async listOwned() {
    const dir = path.join(this.root, 'Captures');
    await this.writable();
    this.warnings = this.warnings.filter(warning => !warning.startsWith('Invalid capture metadata in '));
    await this.recover(dir);
    const { notes, owned } = await this.captureInventory();
    const counts = new Map(); for (const note of notes) counts.set(note.id, (counts.get(note.id) || 0) + 1);
    const eligible = notes.filter(note => owned.has(note));
    for (const note of eligible) if (!this.expected.has(note.id)) this.expected.set(note.id, hash(note.content));
    const visible = eligible.filter(note => counts.get(note.id) === 1 || this.identityPaths?.get(note.id) === note.file);
    this.warnings = this.warnings.filter(warning => !warning.startsWith('Duplicate capture identity.'));
    if (eligible.some(note => counts.get(note.id) > 1 && !this.identityPaths?.get(note.id))) this.warnings.push('Duplicate capture identity. Preserve both notes and use Vault repairs to choose the managed file.');
    return visible.sort((a, b) => b.capturedAt.localeCompare(a.capturedAt));
  }
  async find(id) { const note = (await this.list()).find(note => note.id === id); if (!note) throw Error('Capture is missing. Restore it before editing.'); return note; }
  async capture(input, now) {
    return sourceMutation(this.root, () => this.captureOwned(input, now));
  }
  async captureOwned(input, now) {
    await this.writable();
    if (typeof input.text !== 'string' || !input.text.trim()) throw Error('Enter a thought or link before saving.');
    const text = input.text; const type = /^https?:\/\/\S+$/i.test(text.trim()) ? 'link' : 'thought';
    if (input.excerpt && type !== 'link') throw Error('An excerpt requires a source URL in Thought or link.');
    const note = { id: randomUUID(), type, capturedAt: new Date(now).toISOString(), title: text.trim().split(/\r?\n/)[0].slice(0, 90), text, excerpt: input.excerpt || '', url: type === 'link' ? text : null };
    const slug = note.title.replace(/[^a-zA-Z0-9 -]/g, '').trim().slice(0, 55) || 'Capture';
    const file = path.join(this.root, 'Captures', `${slug}--${note.id}.md`), content = markdown(note, parentOf(this.vault, this.root)), stage = `${file}.pending`;
    const { guard, identities } = this.publicationFolders(path.dirname(file));
    const staged = await writeStage(stage, content, guard);
    const publication = { kind: 'capture', staged, identities };
    let lock, linked = false, clean = false;
    const verifyOwner = () => { verifyStageSync(`${file}.lock`, guard, lock); };
    try {
      lock = await this.acquire(file, publication, guard);
      await this.checkpoint('capture-staged');
      await this.publication(note.id);
      await verifyStage(stage, guard, staged);
      verifyOwner();
      verifyStageSync(stage, guard, staged);
      local.linkSync(stage, file);
      linked = true;
      await verifyPeers(stage, file, guard, staged);
      try { await removeLinkedStage(stage, file, guard, staged, verifyOwner); clean = true; }
      catch (error) {
        if (!['EACCES', 'EPERM', 'EBUSY'].includes(error.code)) throw error;
        await verifyPeers(stage, file, guard, staged);
      }
    } catch (error) {
      if (!linked) await removeStage(stage, guard, staged).catch(() => {});
      if (lock && !linked) await this.release(file, lock, guard);
      throw error;
    }
    if (clean) await this.releaseCaptureLock(file, stage, guard, lock, staged);
    else {
      verifyPeersSync(stage, file, guard, staged);
      verifyOwner();
      this.warnings.push('Capture saved. Its staging file will be cleaned on restart.');
    }
    this.expected.set(note.id, hash(content)); return note.id;
  }
  async title(id, title) {
    return sourceMutation(this.root, () => this.titleOwned(id, title));
  }
  async titleHasStage(file) {
    const exists = await fs.lstat(file + transactionSuffix).catch(missing) || await fs.lstat(`${file}.pending`).catch(missing) ||
      await fs.lstat(file + titleRollbackSuffix).catch(missing);
    if (!exists) return false;
    const recoveryError = this.titleRecoveryErrors.get(file);
    if (recoveryError) throw recoveryError;
    return true;
  }
  async hasExactTitleIntent(file, intent) {
    const directory = path.dirname(file), { guard } = this.publicationFolders(directory);
    try {
      const owner = await noteLock(file, guard), publication = owner?.publication;
      if (publication?.kind !== 'title' || !Array.isArray(publication.identities) ||
          !validProof(publication.previous) || !validProof(publication.staged) || !validProof(publication.journal) ||
          publication.previous.digest !== intent.previousHash || publication.staged.digest !== hash(intent.content) ||
          parse(intent.content)?.id !== intent.id) return false;
      const pinned = this.publicationFolders(directory, publication.identities).guard;
      const journal = await verifyStage(file + transactionSuffix, pinned, publication.journal);
      const transaction = JSON.parse(journal.bytes), backupPrefix = path.basename(file) + '.before-title-';
      if (transaction.expectedHash !== intent.previousHash || transaction.content !== intent.content ||
          transaction.sourceGeneration !== intent.sourceGeneration || typeof transaction.backup !== 'string' ||
          !transaction.backup.startsWith(backupPrefix) || !transactionBackup.test(transaction.backup.slice(backupPrefix.length))) return false;
      const backup = path.join(directory, transaction.backup), stage = file + '.pending';
      const previous = await readExact(backup, pinned, 1, publication.previous).catch(missing);
      const current = await fs.lstat(file, { bigint: true }).catch(missing);
      if (!previous) {
        if (!current) return false;
        await verifyStage(file, pinned, publication.previous);
        await verifyStage(stage, pinned, publication.staged);
      } else {
        if (!current) await verifyStage(stage, pinned, publication.staged);
        else if (current.nlink === 2n) await verifyPeers(stage, file, pinned, publication.staged);
        else {
          await verifyStage(file, pinned, publication.staged);
          if (await fs.lstat(stage).catch(missing)) return false;
        }
      }
      await verifyStage(file + '.lock', pinned, owner.proof);
      return true;
    } catch (error) { if (error.code === 'STAGING_CHANGED' || error instanceof SyntaxError) return false; throw error; }
  }
  async titleOwned(id, title) {
    if (typeof title !== 'string' || !title.trim() || /[\r\n]/.test(title)) throw Error('Enter a title on one line.');
    const note = await this.find(id);
    if (hash(note.content) !== this.expected.get(id)) throw Error('This note changed outside Companion. Reopen Companion to inspect it before editing.');
    const content = withTitle(note.content, title.trim());
    const authority = (await new (require('./intake').Intake)(this).load()).sourceAuthority?.[id];
    const { guard, identities } = this.publicationFolders(path.dirname(note.file));
    const stage = `${note.file}.pending`, journal = `${note.file}.title-transaction.json`;
    if (await this.titleHasStage(note.file)) throw titleHeld();
    if (await fs.lstat(`${note.file}.lock`).catch(missing)) throw Error('A save or recovery still holds this note. Inspect the note lock before retrying.');
    const original = await readExact(note.file, guard);
    if (!original.bytes.equals(Buffer.from(note.content))) throw Error('The note changed. Your file was preserved.');
    const transaction = { expectedHash: hash(note.content), content, backup: `${path.basename(note.file)}.before-title-${randomUUID()}.bak`, ...(authority?.phase === 'active' ? { sourceGeneration: authority.generation } : {}) };
    let lock, staged, retainLock = false;
    try {
      const create = (file, bytes) => writeStage(file, bytes, guard).catch(error => { if (error.code === 'EEXIST') throw titleHeld(); throw error; });
      staged = await create(stage, content);
      const journalProof = await create(journal, JSON.stringify(transaction));
      const publication = { kind: 'title', staged, journal: journalProof, previous: original.proof, identities };
      lock = await this.acquire(note.file, publication, guard);
      await this.checkpoint('title-staged');
      await this.finishTitleOwned(note.file, transaction, publication, guard, { owner: lock });
    } catch (error) {
      retainLock = temporaryFileError(error);
      throw error;
    } finally { if (lock && !retainLock) await this.release(note.file, lock, guard); }
    verifyStageSync(note.file, guard, staged);
    this.expected.set(id, hash(content));
  }
  async finishTitleOwned(file, transaction, publication, guard, { owner, legacyJournal } = {}) {
    const backup = path.join(path.dirname(file), transaction.backup), stage = `${file}.pending`, journal = `${file}.title-transaction.json`;
    const verifyOwner = () => { if (owner) verifyStageSync(`${file}.lock`, guard, owner); };
    const guardedOwner = () => { guard(); verifyOwner(); };
    guard();
    let old = await readExact(backup, guard).catch(missing);
    const source = old || await readExact(file, guard).catch(missing);
    const before = source && parse(source.bytes.toString('utf8')), after = parse(transaction.content);
    if (source && source.proof.digest !== transaction.expectedHash) throw Error('External edit conflict. The note and previous version were preserved.');
    if (!before || !after || before.id !== after.id || before.capturedAt !== after.capturedAt || before.type !== after.type || withTitle(source.bytes.toString('utf8'), after.title) !== transaction.content) throw Error('Invalid title recovery journal. Only a verified capture title can be recovered; all files were preserved.');
    if (!publication && legacyJournal?.digest === hash(JSON.stringify(transaction)) && old) {
      // Older note locks never identified the title stage. Only the verified prior note can be restored.
      await this.restoreTitleBackup(file, backup, after.id, transaction, guardedOwner, old, legacyJournal);
    }
    if (publication?.kind !== 'title' || publication.previous?.digest !== source.proof.digest ||
        publication.previous.dev !== source.proof.dev || publication.previous.ino !== source.proof.ino ||
        publication.staged?.digest !== hash(transaction.content) || !publication.journal) throw titleHeld();
    await verifyStage(journal, guard, publication.journal);
    await this.publication(after.id, transaction);
    try {
      if (!old) {
        await verifyStage(stage, guard, publication.staged);
        await verifyStage(file, guard, publication.previous);
        verifyOwner();
        verifyStageSync(journal, guard, publication.journal);
        verifyStageSync(stage, guard, publication.staged);
        verifyAbsentSync(backup, guard, () => Error('Title backup already exists. Files were preserved for inspection.'));
        verifyStageSync(file, guard, publication.previous);
        local.renameSync(file, backup);
        await this.checkpoint('title-moved');
      }
      old = await readExact(backup, guard);
      if (old.proof.digest !== transaction.expectedHash) throw Error('External edit conflict. Your content was preserved; inspect the note and its adjacent backup before retrying.');
      await verifyStage(backup, guard, publication.previous);
      const current = await fs.lstat(file, { bigint: true }).catch(missing);
      if (!current) {
        await this.publication(after.id, transaction);
        await verifyStage(journal, guard, publication.journal);
        await verifyStage(stage, guard, publication.staged);
        verifyOwner();
        verifyStageSync(journal, guard, publication.journal);
        verifyStageSync(backup, guard, publication.previous);
        verifyStageSync(stage, guard, publication.staged);
        try { local.linkSync(stage, file); }
        catch (error) { if (error.code === 'EEXIST') throw Error('External edit conflict. The new file and previous version were preserved.'); throw error; }
      } else if (!current.isFile() || current.isSymbolicLink() || String(current.ino) !== publication.staged.ino || String(current.dev) !== publication.staged.dev) {
        throw Error('External edit conflict. The current file and previous version were preserved.');
      }
      const verifyBackup = () => { verifyStageSync(backup, guard, publication.previous); };
      await settlePublishedLink(stage, file, guard, publication.staged, () => {
        verifyOwner();
        verifyBackup();
        verifyStageSync(journal, guard, publication.journal);
      });
      await verifyStage(backup, guard, publication.previous);
      await removeStage(journal, guard, publication.journal, 1, () => {
        verifyOwner();
        verifyBackup();
        verifyAbsentSync(stage, guard);
        verifyStageSync(file, guard, publication.staged);
      });
      verifyBackup();
      verifyStageSync(file, guard, publication.staged);
    } catch (error) {
      if (error.code !== 'SOURCE_AUTHORITY_DENIED' && !temporaryFileError(error)) {
        try {
          const retained = await readExact(backup, guard).catch(missing);
          // An open editor can change the old inode after the move. Keep those bytes, too.
          if (retained && retained.proof.dev === publication.previous.dev && retained.proof.ino === publication.previous.ino) {
            await this.restoreTitleBackup(file, backup, after.id, transaction, guardedOwner, retained, publication.journal);
          }
        } catch (recoveryError) { this.warnings.push(`Prior title recovery held: ${recoveryError.message}`); }
      }
      throw error;
    }
  }
  async restoreTitleBackup(file, backup, id, transaction, guard, retained, journalProof) {
    guard();
    if (await fs.lstat(file).catch(missing)) return;
    await this.publication(id, transaction);
    const receipt = file + titleRollbackSuffix, stage = `${file}.restore-title-${randomUUID()}.pending`;
    const folders = this.publicationFolders(path.dirname(file));
    const pinned = () => { guard(); folders.guard(); };
    const staged = await writeStage(stage, retained.bytes, pinned);
    let recorded;
    try {
      const proof = { schema: 1, stage: path.basename(stage), staged, backup: path.basename(backup), previous: retained.proof, journal: journalProof, identities: folders.identities };
      recorded = await writeStage(receipt, JSON.stringify(proof), pinned);
      await verifyStage(receipt, pinned, recorded);
      await verifyStage(file + transactionSuffix, pinned, journalProof);
      await verifyStage(backup, pinned, retained.proof);
      await verifyStage(stage, pinned, staged);
      const verifyOriginal = () => {
        verifyStageSync(file + transactionSuffix, pinned, journalProof);
        verifyStageSync(backup, pinned, retained.proof);
      };
      const verifyRollback = () => {
        verifyOriginal();
        verifyStageSync(receipt, pinned, recorded);
      };
      verifyRollback();
      verifyStageSync(stage, pinned, staged);
      local.linkSync(stage, file);
      await settlePublishedLink(stage, file, pinned, staged, verifyRollback);
      await removeStage(receipt, pinned, recorded, 1, () => {
        verifyOriginal();
        verifyAbsentSync(stage, pinned);
        verifyStageSync(file, pinned, staged);
      });
      verifyStageSync(file, pinned, staged);
    } finally { if (!recorded) await removeStage(stage, pinned, staged).catch(() => {}); }
  }
  async settleTitleRollback(file, guard) {
    const receipt = file + titleRollbackSuffix, stored = await readExact(receipt, guard);
    const proof = JSON.parse(stored.bytes), filename = path.basename(file);
    const stagePrefix = filename + '.restore-title-', backupPrefix = filename + '.before-title-';
    if (proof?.schema !== 1 || !stored.bytes.equals(Buffer.from(JSON.stringify(proof))) ||
        typeof proof.stage !== 'string' || !proof.stage.startsWith(stagePrefix) || !rollbackStage.test(proof.stage.slice(stagePrefix.length)) ||
        typeof proof.backup !== 'string' || !proof.backup.startsWith(backupPrefix) || !transactionBackup.test(proof.backup.slice(backupPrefix.length)) ||
        !validProof(proof.staged) || !validProof(proof.previous) || !validProof(proof.journal) || proof.staged.digest !== proof.previous.digest || !Array.isArray(proof.identities)) {
      throw Error('Title rollback receipt is invalid. Files were preserved for inspection.');
    }
    const directory = path.dirname(file), pinned = this.publicationFolders(directory, proof.identities).guard;
    await verifyStage(receipt, pinned, stored.proof);
    const journal = await verifyStage(file + transactionSuffix, pinned, proof.journal);
    const backup = path.join(directory, proof.backup);
    await verifyStage(backup, pinned, proof.previous);
    const verifyOriginal = () => {
      verifyStageSync(file + transactionSuffix, pinned, proof.journal);
      verifyStageSync(backup, pinned, proof.previous);
    };
    const verifyRollback = () => {
      verifyOriginal();
      verifyStageSync(receipt, pinned, stored.proof);
    };
    const stage = path.join(directory, proof.stage);
    if (!await fs.lstat(file).catch(missing)) {
      const transaction = JSON.parse(journal.bytes), proposed = parse(transaction.content);
      const previous = await verifyStage(stage, pinned, proof.staged);
      if (transaction.backup !== proof.backup || !proposed || parse(previous.bytes.toString('utf8'))?.id !== proposed.id) {
        throw Error('Title rollback receipt does not match the retained title. Files were preserved for inspection.');
      }
      await this.publication(proposed.id, transaction);
      await verifyStage(receipt, pinned, stored.proof);
      await verifyStage(file + transactionSuffix, pinned, proof.journal);
      await verifyStage(backup, pinned, proof.previous);
      await verifyStage(stage, pinned, proof.staged);
      verifyRollback();
      verifyStageSync(stage, pinned, proof.staged);
      local.linkSync(stage, file);
    }
    await settlePublishedLink(stage, file, pinned, proof.staged, verifyRollback);
    await removeStage(receipt, pinned, stored.proof, 1, () => {
      verifyOriginal();
      verifyAbsentSync(stage, pinned);
      verifyStageSync(file, pinned, proof.staged);
    });
    verifyStageSync(file, pinned, proof.staged);
  }
  async recover(dir) {
    return sourceMutation(this.root, () => this.recoverOwned(dir));
  }
  async recoverOwned(dir) {
    const { guard } = this.publicationFolders(dir);
    const entries = await fs.readdir(dir);
    const recoveryLocks = new Set();
    this.titleRecoveryErrors.clear();
    const unsettledRollbacks = new Set();
    for (const entry of entries.filter(name => name.endsWith('.md' + titleRollbackSuffix))) {
      const file = path.join(dir, entry.slice(0, -titleRollbackSuffix.length));
      try { await this.settleTitleRollback(file, guard); }
      catch (error) {
        unsettledRollbacks.add(file);
        this.warnings.push(`Prior title recovery held: ${error.message}`);
        if (temporaryFileError(error)) this.titleRecoveryErrors.set(file, error);
      }
    }
    for (const entry of entries.filter(name => name.endsWith('.md' + transactionSuffix))) {
      const journal = path.join(dir, entry), file = journal.slice(0, -transactionSuffix.length);
      recoveryLocks.add(file);
      if (unsettledRollbacks.has(file)) continue;
      let lock;
      try {
        lock = await noteLock(file, guard);
        if (lock?.live) {
          if (lock.publication?.kind === 'title') this.titleRecoveryErrors.set(file, Error('An interrupted title save awaits exact recovery. Restart Companion to continue.'));
          continue;
        }
        const publication = lock?.publication;
        const pinned = this.publicationFolders(dir, publication?.identities);
        const stored = await readExact(journal, pinned.guard);
        const transaction = JSON.parse(stored.bytes);
        const backupPrefix = path.basename(file) + '.before-title-';
        if (typeof transaction.content !== 'string' || typeof transaction.expectedHash !== 'string' || typeof transaction.backup !== 'string' ||
            !transaction.backup.startsWith(backupPrefix) || !transactionBackup.test(transaction.backup.slice(backupPrefix.length))) throw Error('Invalid title recovery journal; preserve it for repair.');
        await this.finishTitleOwned(file, transaction, publication, pinned.guard, {
          owner: lock?.proof, legacyJournal: lock?.legacy ? stored.proof : undefined
        });
        await this.release(file, lock.proof, pinned.guard);
        verifyStageSync(file, pinned.guard, publication.staged);
        this.warnings.push('Recovered an interrupted title save. The previous version remains in an adjacent backup.');
      } catch (error) {
        this.warnings.push(error.message);
        if (temporaryFileError(error) || error.code === 'SOURCE_AUTHORITY_DENIED') this.titleRecoveryErrors.set(file, error);
        if (lock?.legacy && !lock.live && !temporaryFileError(error)) await this.release(file, lock.proof, guard);
      }
    }
    // Only exact quick-capture stages can finish here. Other writers keep their own recovery records.
    for (const entry of entries.filter(name => name.endsWith('.md.pending'))) {
      const stage = path.join(dir, entry), file = stage.slice(0, -'.pending'.length);
      let lock;
      try {
        if (!await fs.lstat(stage).catch(missing)) continue;
        if (await fs.lstat(`${file}.title-transaction.json`).catch(missing)) continue;
        recoveryLocks.add(file);
        lock = await noteLock(file, guard);
        if (lock?.live) continue;
        const publication = lock?.publication;
        if (publication?.kind !== 'capture' || !publication.staged || !publication.identities) throw stagingHeld();
        const pinned = this.publicationFolders(dir, publication.identities).guard;
        const links = (await fs.lstat(stage, { bigint: true }).catch(missing))?.nlink;
        const content = await verifyStage(stage, pinned, publication.staged, links === 2n ? 2 : 1);
        const note = parse(content.bytes.toString('utf8'));
        if (!note || note.type === 'reel_import' || !/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i.test(note.id) || !path.basename(file).endsWith(`--${note.id}.md`)) throw stagingHeld();
        await this.publication(note.id);
        const verifyOwner = () => { verifyStageSync(`${file}.lock`, pinned, lock.proof); };
        if (links === 1n) {
          await verifyStage(stage, pinned, publication.staged);
          verifyOwner();
          verifyStageSync(stage, pinned, publication.staged);
          try { local.linkSync(stage, file); }
          catch (error) { if (error.code === 'EEXIST') throw Error('Staging conflict. Both versions were preserved for inspection.'); throw error; }
        }
        await verifyPeers(stage, file, pinned, publication.staged);
        await removeLinkedStage(stage, file, pinned, publication.staged, verifyOwner);
        await this.releaseCaptureLock(file, stage, pinned, lock.proof, publication.staged);
        this.warnings.push('Recovered an interrupted capture save.');
      } catch (error) {
        this.warnings.push(`${entry}: ${error.message}`);
        if (lock?.legacy && !lock.live && !temporaryFileError(error)) await this.release(file, lock.proof, guard);
      }
    }
    for (const entry of entries.filter(name => name.endsWith('.md.lock'))) {
      const file = path.join(dir, entry.slice(0, -'.lock'.length));
      if (recoveryLocks.has(file)) continue;
      try {
        const lock = await noteLock(file, guard);
        if (lock?.unknown) this.warnings.push(`Unrecognized lock ${entry}. Its bytes were preserved for inspection.`);
        else if (lock && !lock.live) {
          if (lock.publication?.kind === 'capture') {
            const { staged, identities } = lock.publication;
            if (!validProof(staged) || !Array.isArray(identities)) throw stagingHeld();
            const pinned = this.publicationFolders(dir, identities).guard;
            await this.releaseCaptureLock(file, `${file}.pending`, pinned, lock.proof, staged);
          } else await this.release(file, lock.proof, guard);
        }
      } catch (error) { this.warnings.push(error.message); }
    }
  }
}
module.exports = { Vault, withTitle, captureHeading, parseAnnotation, parse, restorationReadRefused, matchesRestorationFile };
