const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID, createHash } = require('node:crypto');
const YAML = require('yaml');
const { sourceMutation } = require('./source-mutation');
const { assertPublication } = require('./source-authority');
const { ordinaryDirectories, readExact, writeStage, verifyStage, verifyPeers, removeStage } = require('./staged-publication');
const hash = text => createHash('sha256').update(text).digest('hex');
const missing = error => { if (error.code === 'ENOENT') return null; throw error; };
const stagingHeld = () => Error('Staging ownership could not be verified. Files were preserved for inspection.');
const titleHeld = () => Object.assign(stagingHeld(), { code: 'TITLE_PUBLICATION_HELD' });
const temporaryFileError = error => ['EACCES', 'EPERM', 'EBUSY', 'EMFILE', 'ENFILE', 'ENOSPC'].includes(error.code);
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
function markdown(note) {
  return `---\ncompanion_id: ${JSON.stringify(note.id)}\nartifact_type: "capture"\nschema_version: 1\ncapture_type: ${JSON.stringify(note.type)}\ncaptured_at: ${JSON.stringify(note.capturedAt)}\ntitle: ${JSON.stringify(note.title)}\nsource_url: ${JSON.stringify(note.url || '')}\nprovenance: ${JSON.stringify(note.excerpt ? 'user-supplied excerpt; webpage not verified' : 'user capture')}\n---\n\n# ${note.title.replace(/[\r\n]/g, ' ')}\n\n${note.text}\n${note.excerpt ? `\n## User-supplied excerpt\n\n${note.excerpt}\n\nSource URL (as entered): ${note.url}\n\nThis excerpt was supplied by the user. Companion did not fetch or verify the webpage.\n` : ''}`;
}
function parse(text) {
  const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  if (!match) return null;
  let fields; try { fields = YAML.parse(match[1]); } catch { return null; }
  if (!fields || typeof fields !== 'object' || typeof fields.companion_id !== 'string' || !fields.companion_id.trim() || /[\r\n]/.test(fields.companion_id) || fields.artifact_type !== 'capture' || fields.schema_version !== 1 || !['thought', 'link', 'reel_import'].includes(fields.capture_type) || typeof fields.title !== 'string' || !fields.title.trim() || /[\r\n]/.test(fields.title) || typeof fields.captured_at !== 'string' || !/T.*(?:Z|[+-]\d\d:\d\d)$/.test(fields.captured_at) || !Number.isFinite(Date.parse(fields.captured_at))) return null;
  return { id: fields.companion_id, title: fields.title, type: fields.capture_type, capturedAt: fields.captured_at, content: text };
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
    for (const area of ['Captures', 'Annotations', 'Ideas', 'Briefs', 'Revisions']) { const target = path.join(this.root, area); await fs.mkdir(target).catch(error => { if (error.code !== 'EEXIST') throw error; }); await this.contained(target); }
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
      await verifyStage(owner, guard, proof); guard(); await fs.link(owner, lock); linked = true;
      await verifyPeers(owner, lock, guard, proof);
      await removeStage(owner, guard, proof, 2);
      await verifyStage(lock, guard, proof);
      return proof;
    } finally { if (!linked) await removeStage(owner, guard, proof).catch(() => {}); }
  }
  async release(file, proof, guard) {
    const lock = `${file}.lock`;
    const remove = proof ? removeStage(lock, guard, proof) : fs.unlink(lock);
    await remove.catch(error => { if (error.code !== 'ENOENT') this.warnings.push('A saved-note lock could not be removed. Inspect it before continuing.'); });
  }
  async scan({ annotations = false } = {}) {
    await this.writable();
    const notes = [];
    const visit = async dir => {
      await this.contained(dir);
      for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
        if (['.intake', '.obsidian', '.git', '.codex', 'managed-home'].includes(entry.name.toLowerCase())) continue;
        const file = path.join(dir, entry.name);
        if (entry.isDirectory() && !entry.isSymbolicLink()) await visit(file);
        else if (entry.isFile() && entry.name.endsWith('.md')) {
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
    const notes = await this.scan();
    for (const note of notes) if (!this.expected.has(note.id)) this.expected.set(note.id, hash(note.content));
    const counts = new Map(); for (const note of notes) counts.set(note.id, (counts.get(note.id) || 0) + 1);
    const visible = notes.filter(note => counts.get(note.id) === 1 || this.identityPaths?.get(note.id) === note.file);
    this.warnings = this.warnings.filter(warning => !warning.startsWith('Duplicate capture identity.'));
    if (notes.some(note => counts.get(note.id) > 1 && !this.identityPaths?.get(note.id))) this.warnings.push('Duplicate capture identity. Preserve both notes and use Vault repairs to choose the managed file.');
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
    const file = path.join(this.root, 'Captures', `${slug}--${note.id}.md`), content = markdown(note), stage = `${file}.pending`;
    const { guard, identities } = this.publicationFolders(path.dirname(file));
    const staged = await writeStage(stage, content, guard);
    const publication = { kind: 'capture', staged, identities };
    let lock, linked = false, clean = false;
    try {
      lock = await this.acquire(file, publication, guard);
      await this.checkpoint('capture-staged');
      await this.publication(note.id);
      await verifyStage(stage, guard, staged); guard(); await fs.link(stage, file); linked = true;
      await verifyPeers(stage, file, guard, staged);
      try { await removeStage(stage, guard, staged, 2); clean = true; }
      catch (error) {
        if (!['EACCES', 'EPERM', 'EBUSY'].includes(error.code)) throw error;
        await verifyPeers(stage, file, guard, staged);
        this.warnings.push('Capture saved. Its staging file will be cleaned on restart.');
      }
      if (clean) await verifyStage(file, guard, staged);
    } catch (error) {
      if (!linked) await removeStage(stage, guard, staged).catch(() => {});
      if (lock) await this.release(file, lock, guard);
      throw error;
    }
    if (clean) await this.release(file, lock, guard);
    this.expected.set(note.id, hash(content)); return note.id;
  }
  async title(id, title) {
    return sourceMutation(this.root, () => this.titleOwned(id, title));
  }
  async titleHasStage(file) {
    const exists = await fs.lstat(`${file}.title-transaction.json`).catch(missing) || await fs.lstat(`${file}.pending`).catch(missing);
    if (!exists) return false;
    const recoveryError = this.titleRecoveryErrors.get(file);
    if (recoveryError) throw recoveryError;
    return true;
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
    let lock;
    try {
      const create = (file, bytes) => writeStage(file, bytes, guard).catch(error => { if (error.code === 'EEXIST') throw titleHeld(); throw error; });
      const staged = await create(stage, content);
      const journalProof = await create(journal, JSON.stringify(transaction));
      const publication = { kind: 'title', staged, journal: journalProof, previous: original.proof, identities };
      lock = await this.acquire(note.file, publication, guard);
      await this.checkpoint('title-staged');
      await this.finishTitleOwned(note.file, transaction, publication, guard);
      this.expected.set(id, hash(content));
    } finally { if (lock) await this.release(note.file, lock, guard); }
  }
  async finishTitleOwned(file, transaction, publication, guard, legacyJournal) {
    const backup = path.join(path.dirname(file), transaction.backup), stage = `${file}.pending`, journal = `${file}.title-transaction.json`;
    guard();
    let old = await readExact(backup, guard).catch(missing);
    const source = old || await readExact(file, guard).catch(missing);
    const before = source && parse(source.bytes.toString('utf8')), after = parse(transaction.content);
    if (source && source.proof.digest !== transaction.expectedHash) throw Error('External edit conflict. The note and previous version were preserved.');
    if (!before || !after || before.id !== after.id || before.capturedAt !== after.capturedAt || before.type !== after.type || withTitle(source.bytes.toString('utf8'), after.title) !== transaction.content) throw Error('Invalid title recovery journal. Only a verified capture title can be recovered; all files were preserved.');
    if (!publication && legacyJournal?.digest === hash(JSON.stringify(transaction)) && old) {
      // Older note locks never identified the title stage. Only the verified prior note can be restored.
      await this.restoreTitleBackup(file, backup, after.id, transaction, guard, old, legacyJournal);
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
        guard();
        if (await fs.lstat(backup).catch(missing)) throw Error('Title backup already exists. Files were preserved for inspection.');
        guard(); await fs.rename(file, backup);
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
        guard();
        try { await fs.link(stage, file); }
        catch (error) { if (error.code === 'EEXIST') throw Error('External edit conflict. The new file and previous version were preserved.'); throw error; }
      } else if (!current.isFile() || current.isSymbolicLink() || String(current.ino) !== publication.staged.ino || String(current.dev) !== publication.staged.dev) {
        throw Error('External edit conflict. The current file and previous version were preserved.');
      }
      if (!current || current.nlink === 2n) {
        await verifyPeers(stage, file, guard, publication.staged);
        await removeStage(stage, guard, publication.staged, 2);
      } else {
        guard();
        if (await fs.lstat(stage).catch(missing)) throw stagingHeld();
      }
      await verifyStage(file, guard, publication.staged);
      await verifyStage(backup, guard, publication.previous);
      await removeStage(journal, guard, publication.journal);
    } catch (error) {
      if (error.code !== 'SOURCE_AUTHORITY_DENIED') {
        try {
          const retained = await readExact(backup, guard).catch(missing);
          // An open editor can change the old inode after the move. Keep those bytes, too.
          if (retained && retained.proof.dev === publication.previous.dev && retained.proof.ino === publication.previous.ino) {
            await this.restoreTitleBackup(file, backup, after.id, transaction, guard, retained, publication.journal);
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
    const stage = `${file}.restore-title-${randomUUID()}.pending`;
    const staged = await writeStage(stage, retained.bytes, guard);
    let linked = false;
    try {
      await verifyStage(`${file}.title-transaction.json`, guard, journalProof);
      await verifyStage(backup, guard, retained.proof);
      await verifyStage(stage, guard, staged);
      guard(); await fs.link(stage, file); linked = true;
      await verifyPeers(stage, file, guard, staged);
      await removeStage(stage, guard, staged, 2);
      await verifyStage(file, guard, staged);
    } finally { if (!linked) await removeStage(stage, guard, staged).catch(() => {}); }
  }
  async recover(dir) {
    return sourceMutation(this.root, () => this.recoverOwned(dir));
  }
  async recoverOwned(dir) {
    const { guard } = this.publicationFolders(dir);
    const entries = await fs.readdir(dir);
    const recoveryLocks = new Set();
    this.titleRecoveryErrors.clear();
    for (const entry of entries.filter(name => name.endsWith('.md.title-transaction.json'))) {
      const journal = path.join(dir, entry), file = journal.slice(0, -'.title-transaction.json'.length);
      recoveryLocks.add(file);
      let lock;
      try {
        lock = await noteLock(file, guard);
        if (lock?.live) continue;
        const publication = lock?.publication;
        const pinned = this.publicationFolders(dir, publication?.identities);
        const stored = await readExact(journal, pinned.guard);
        const transaction = JSON.parse(stored.bytes);
        const backupPrefix = path.basename(file) + '.before-title-';
        if (typeof transaction.content !== 'string' || typeof transaction.expectedHash !== 'string' || typeof transaction.backup !== 'string' ||
            !transaction.backup.startsWith(backupPrefix) || !/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}\.bak$/.test(transaction.backup.slice(backupPrefix.length))) throw Error('Invalid title recovery journal; preserve it for repair.');
        await this.finishTitleOwned(file, transaction, publication, pinned.guard, lock?.legacy ? stored.proof : undefined);
        this.warnings.push('Recovered an interrupted title save. The previous version remains in an adjacent backup.');
        await this.release(file, lock.proof, pinned.guard);
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
        if (links === 1n) {
          await verifyStage(stage, pinned, publication.staged); pinned();
          try { await fs.link(stage, file); }
          catch (error) { if (error.code === 'EEXIST') throw Error('Staging conflict. Both versions were preserved for inspection.'); throw error; }
        }
        await verifyPeers(stage, file, pinned, publication.staged);
        await removeStage(stage, pinned, publication.staged, 2);
        await verifyStage(file, pinned, publication.staged);
        this.warnings.push('Recovered an interrupted capture save.');
        await this.release(file, lock.proof, pinned);
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
        else if (lock && !lock.live) await this.release(file, lock.proof, guard);
      } catch (error) { this.warnings.push(error.message); }
    }
  }
}
module.exports = { Vault, withTitle, captureHeading, parseAnnotation, parse };
