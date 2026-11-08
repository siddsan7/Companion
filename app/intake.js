const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { readDraft, hash } = require('./intake-producer');
const { intakeLock } = require('./intake-lock');
const { withTitle, captureHeading } = require('./vault');
const empty = () => ({ schema: 1, sources: [], captures: {}, attempts: {}, blocks: {}, pending: {}, outcomes: {}, suppressed: [] });
const read = file => fs.readFile(file, 'utf8').catch(error => { if (error.code === 'ENOENT') return null; throw error; });
const conflict = message => Object.assign(Error(message), { intakeConflict: true });
const deferred = message => Object.assign(Error(message), { intakeDeferred: true });
function noteText(capture, revision) {
  const fields = { companion_id: capture.id, artifact_type: 'capture', schema_version: 1, capture_type: 'reel_import', captured_at: capture.capturedAt, title: capture.title, source_hash: revision.sourceHash, source_revision: revision.id, source_started_at: revision.run.started_utc, imported_at: revision.importedAt, extraction_status: revision.extraction, human_review: revision.humanReview, provenance: 'Reel to MD validated draft; structural grounding is not factual verification' };
  return `---\n${Object.entries(fields).map(([key, value]) => `${key}: ${JSON.stringify(value)}`).join('\n')}\n---\n\n${captureHeading(capture.title, 'reel_import')}\n\n${revision.text}`;
}
class Intake {
  constructor(vault) { this.vault = vault; this.dir = path.join(vault.root, '.intake'); }
  async setup() {
    await this.vault.writable(); await fs.mkdir(this.dir, { recursive: true }); await this.vault.contained(this.dir); await this.vault.contained(path.join(this.vault.root, 'Revisions'));
  }
  async load() {
    const text = await read(path.join(this.dir, 'ledger.json')); if (text === null) return empty();
    let ledger; try { ledger = JSON.parse(text); } catch { throw Error('Intake ledger is unreadable. Preserve .intake and restore a vault backup before checking sources.'); }
    if (ledger.schema !== 1 || !Array.isArray(ledger.sources) || !ledger.captures || !ledger.attempts || !ledger.blocks || !ledger.pending || !ledger.outcomes || !Array.isArray(ledger.suppressed)) throw Error('Unsupported intake ledger. Preserve it for repair.');
    return ledger;
  }
  async save(ledger) {
    await this.vault.contained(this.dir);
    const temp = path.join(this.dir, `ledger-${randomUUID()}.tmp`); await fs.writeFile(temp, JSON.stringify(ledger, null, 2), { flag: 'wx', flush: true }); await fs.rename(temp, path.join(this.dir, 'ledger.json'));
  }
  async publishJournal(file, value) {
    await this.vault.contained(this.dir);
    const stage = path.join(this.dir, `journal-${randomUUID()}.stage`);
    await fs.writeFile(stage, JSON.stringify(value), { flag: 'wx', flush: true });
    await fs.link(stage, file); await fs.unlink(stage);
  }
  async locked(work) {
    await this.setup(); return intakeLock(this.vault.root, async () => { await this.recover(); return work(); });
  }
  async info() {
    await this.setup();
    try { return await this.locked(() => this.load()); } catch (error) { if (error.message.includes('already running')) return this.load(); throw error; }
  }
  async connect(folder, scan, now) {
    if (typeof folder !== 'string' || !path.isAbsolute(folder)) throw Error('Choose an absolute draft source folder.');
    const source = await fs.realpath(folder); if (!(await fs.stat(source)).isDirectory()) throw Error('Choose a draft source folder.');
    // Scanning the destination would feed imports back into their own intake.
    const relative = path.relative(source, this.vault.root);
    if (relative === '' || !relative.startsWith('..') && !path.isAbsolute(relative)) throw Error('Choose a producer folder that does not contain the Companion destination.');
    await this.locked(async () => { const ledger = await this.load(); if (!ledger.sources.some(x => x.folder === source)) ledger.sources.push({ id: randomUUID(), folder: source, connectedAt: now, firstScan: !!scan }); await this.save(ledger); });
    if (scan) return this.reconcile({ trigger: 'first-scan', now });
  }
  async candidates(folder) {
    const found = [];
    const visit = async (dir, depth) => {
      if (depth > 12) throw Error('Source nesting exceeds the supported depth. Select a narrower producer folder.');
      const entries = await fs.readdir(dir, { withFileTypes: true });
      if (entries.some(x => ['run.json', 'evidence.json', 'first-pass-target.json', 'notes.md'].includes(x.name))) { found.push(dir); return; }
      for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) if (entry.isDirectory() && !entry.isSymbolicLink()) await visit(path.join(dir, entry.name), depth + 1);
    };
    await visit(folder, 0); return found;
  }
  async reconcile({ trigger = 'manual', now = new Date().toISOString() } = {}) {
    return this.locked(async () => {
      await this.retryPending();
      let ledger = await this.load(); const seen = new Map(), ready = [];
      ledger.lastCheck = { at: now, trigger, status: 'running' }; await this.save(ledger);
      for (const source of ledger.sources) {
        let candidates;
        try { candidates = await this.candidates(source.folder); delete source.error; }
        catch { source.error = 'Source folder is missing or unreadable. Reconnect it, then Check now.'; continue; }
        // Validate all candidates before admitting any: conflicting copies of the
        // same producer attempt are held regardless of directory iteration order.
        const present = new Set();
        for (const folder of candidates) {
          const key = `${source.id}:${path.relative(source.folder, folder) || '.'}`;
          present.add(key);
          try { const draft = await readDraft(folder); ready.push({ draft, key }); const prior = seen.get(draft.identity); if (prior && prior !== draft.fingerprint) seen.set(draft.identity, false); else if (prior !== false) seen.set(draft.identity, draft.fingerprint); }
          catch (error) { ledger.outcomes[key] = { status: 'held', reason: error.code ? 'Unreadable artifact. Check source access and complete the producer transfer, then Check now.' : error.message, locator: folder, checkedAt: now }; }
        }
        for (const [key, outcome] of Object.entries(ledger.outcomes)) if (key.startsWith(`${source.id}:`) && outcome.status === 'held' && !present.has(key)) ledger.outcomes[key] = { ...outcome, status: 'absent', checkedAt: now };
      }
      await this.save(ledger);
      for (const { draft, key } of ready) {
          try {
            if (seen.get(draft.identity) === false) throw Error('Ambiguous attempt identity: different artifact bytes claim the same attempt. Keep the intended producer copy, then Check now.');
            await this.admit(ledger, draft, key, now); ledger = await this.load();
          } catch (error) {
            if (error.intakeConflict || error.intakeDeferred) {
              const transaction = JSON.parse(await fs.readFile(path.join(this.dir, 'transaction.json'), 'utf8'));
              if (error.intakeDeferred) await this.defer(transaction, ledger, error.message);
              else await this.archiveConflict(transaction, ledger, error.message);
            }
            ledger.outcomes[key] = { status: 'held', reason: error.code ? 'Publication failed. Preserve the vault and retry Check now after fixing file access.' : error.message, locator: draft.locator, checkedAt: now };
            await this.save(ledger);
          }
      }
      ledger.lastCheck = { at: now, trigger, status: ledger.sources.some(x => x.error) ? 'error' : 'complete' }; await this.save(ledger); return ledger;
    });
  }
  async admit(ledger, draft, key, now) {
    if (ledger.blocks[draft.sourceHash]) throw Error(ledger.blocks[draft.sourceHash].reason);
    if (ledger.pending[draft.sourceHash]) throw Error(ledger.pending[draft.sourceHash].reason);
    const prior = ledger.attempts[draft.identity];
    if (prior) {
      if (prior.fingerprint !== draft.fingerprint) throw Error('Attempt identity changed after import. Original snapshot is retained. Restore the original export or produce a distinct attempt.');
      if (!/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(prior.revision)) throw Error('Invalid retained revision identity. Preserve intake history for repair.');
      const snapshot = await read(path.join(this.vault.root, 'Revisions', `${prior.revision}.json`));
      if (snapshot === null || hash(snapshot) !== prior.snapshotHash) throw Error('Immutable revision snapshot is missing or changed. Restore it from a vault backup before retrying.');
      ledger.outcomes[key] = { ...prior, locator: draft.locator, checkedAt: now }; await this.save(ledger); return;
    }
    if (ledger.suppressed.includes(draft.sourceHash)) throw Error('Automatic re-import is suppressed. Restore this source explicitly before intake.');
    let capture = ledger.captures[draft.sourceHash];
    if (capture?.conflict) throw Error(capture.conflict);
    if (capture?.reviewed) throw Error('A reviewed revision is current. This draft cannot replace it.');
    const id = capture?.id || randomUUID(), revisionId = randomUUID();
    const revision = { schema: 1, id: revisionId, captureId: id, importedAt: now, ...draft };
    const file = capture?.file || `${id}.md`;
    if (path.basename(file) !== file) throw Error('Invalid intake destination identity. Preserve ledger for repair.');
    const destination = path.join(this.vault.root, 'Captures', file), current = await read(destination);
    if (capture && (current === null || hash(current) !== capture.currentHash)) throw Error('Destination changed outside Companion or is missing. Local content and incoming source are preserved; repair the note before retrying.');
    if (!capture && current !== null) throw Error('Destination already exists. Resolve its identity before intake.');
    capture = { ...capture, id, file, capturedAt: capture?.capturedAt || new Date(now).toISOString(), title: capture?.title || draft.target.title.replace(/[\r\n]/g, ' '), currentRevision: revisionId, revisions: [...(capture?.revisions || []), revisionId], updatedAt: now };
    const content = noteText(capture, revision); capture.currentHash = hash(content);
    const transaction = { schema: 1, key, sourceHash: draft.sourceHash, capture, revision, content, previousHash: current === null ? null : hash(current), previous: current, backup: `${id}-${revisionId}.before.md` };
    await this.publishJournal(path.join(this.dir, 'transaction.json'), transaction);
    await this.vault.checkpoint('intake-journaled');
    await this.finish(transaction, ledger);
  }
  validateTransaction(tx) {
    const uuid = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/;
    try {
      if (tx.schema !== 1 || typeof tx.content !== 'string' || !tx.capture || !tx.revision || !uuid.test(tx.capture.id) || !uuid.test(tx.revision.id) || !/^[a-f0-9]{64}$/.test(tx.sourceHash) || typeof tx.key !== 'string' || !uuid.test(tx.key.split(':')[0]) || tx.capture.file !== `${tx.capture.id}.md` || tx.backup !== `${tx.capture.id}-${tx.revision.id}.before.md` || tx.capture.currentHash !== hash(tx.content) || tx.revision.captureId !== tx.capture.id || tx.revision.sourceHash !== tx.sourceHash || tx.content !== noteText(tx.capture, tx.revision) || (tx.previous === null ? tx.previousHash !== null : typeof tx.previous !== 'string' || hash(tx.previous) !== tx.previousHash)) throw Error();
    } catch { throw Error('Invalid intake recovery journal. Files were preserved for repair.'); }
  }
  async ownedFile(file, peers, label) {
    let info; try { info = await fs.lstat(file, { bigint: true }); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
    if (!info.isFile() || info.isSymbolicLink()) throw conflict(`${label}: an ordinary file is required. The unsafe file was preserved.`);
    try { await this.vault.contained(file); } catch { throw conflict(`${label}: the file points outside the selected vault. It was preserved.`); }
    if (info.nlink === 1n) return info;
    // The only legitimate extra link is our exact journal-known publication
    // peer. This permits post-link crash recovery without trusting outside aliases.
    if (info.nlink === 2n) for (const peer of Array.isArray(peers) ? peers : [peers]) {
      let other; try { other = await fs.lstat(peer, { bigint: true }); } catch (error) { if (error.code === 'ENOENT') continue; throw error; }
      if (!other.isFile() || other.isSymbolicLink() || other.nlink !== 2n || other.dev !== info.dev || other.ino !== info.ino) continue;
      try { await this.vault.contained(peer); } catch { continue; }
      return info;
    }
    throw conflict(`${label}: an unexpected hardlink alias was found. All linked files were preserved.`);
  }
  async finish(tx, ledger) {
    this.validateTransaction(tx);
    const destination = path.join(this.vault.root, 'Captures', tx.capture.file), snapshot = path.join(this.vault.root, 'Revisions', `${tx.revision.id}.json`), backup = path.join(this.dir, tx.backup), stage = path.join(this.dir, `${tx.revision.id}.stage`), snapshotStage = path.join(this.dir, `${tx.revision.id}.snapshot.stage`), snapshotBytes = JSON.stringify(tx.revision, null, 2);
    const immutable = async (file, content) => {
      try { await fs.writeFile(file, content, { flag: 'wx', flush: true }); } catch (error) { if (error.code !== 'EEXIST' || await read(file) !== content) throw Error('Immutable import file conflicts. Preserve the vault for repair.'); }
    };
    const staged = async (file, content, peer) => {
      const info = await this.ownedFile(file, peer, 'Unsafe import staging file');
      const existing = await read(file);
      if (existing !== null && existing !== content) {
        if (info.nlink !== 1n) throw conflict('Unsafe import staging file: a linked publication changed. Both versions were preserved.');
        await fs.rename(file, `${file}.damaged-${randomUUID()}`);
      }
      await immutable(file, content);
      await this.ownedFile(file, peer, 'Unsafe import staging file');
    };
    await staged(snapshotStage, snapshotBytes, snapshot); await this.vault.checkpoint('intake-snapshot-staged');
    if (!await this.ownedFile(snapshotStage, snapshot, 'Unsafe import staging file')) throw conflict('Unsafe import staging file disappeared. Its incoming revision was preserved.');
    await this.ownedFile(snapshot, snapshotStage, 'Immutable revision snapshot');
    try { await fs.link(snapshotStage, snapshot); } catch (error) {
      let existing;
      try { existing = await fs.lstat(snapshot); } catch { throw error; }
      if (!existing.isFile() || existing.isSymbolicLink()) throw conflict('Immutable revision snapshot destination is not an ordinary file. The destination and incoming stage were preserved.');
      await this.ownedFile(snapshot, snapshotStage, 'Immutable revision snapshot');
      let bytes; try { bytes = await read(snapshot); } catch { throw conflict('Immutable revision snapshot destination is unreadable. The destination and incoming stage were preserved.'); }
      if (bytes !== snapshotBytes) throw conflict('Immutable revision snapshot conflicts. Existing and incoming bytes were preserved.');
    }
    await this.ownedFile(snapshot, snapshotStage, 'Immutable revision snapshot');
    if (await read(snapshot) !== snapshotBytes) throw conflict('Immutable revision snapshot changed during publication. All versions were preserved.');
    await this.vault.checkpoint('intake-snapshot');
    await this.ownedFile(destination, [stage, backup], 'Capture destination');
    await this.ownedFile(backup, destination, 'Previous capture backup');
    let current = await read(destination), old = await read(backup);
    if (current !== tx.content) {
      if (tx.previousHash !== null) {
        if (old === null) {
          if (current === null || hash(current) !== tx.previousHash) throw conflict('Destination changed outside Companion. Both source revision and local writing were preserved.');
          try { await this.vault.checkpoint('intake-before-move'); await fs.rename(destination, backup); }
          catch (error) { if (['EACCES', 'EPERM', 'EBUSY'].includes(error.code)) throw deferred('Capture destination is locked or inaccessible. Existing content and incoming revision were preserved. Fix file access, then Check now to retry.'); throw error; }
          await this.vault.checkpoint('intake-moved'); old = await read(backup); current = await read(destination);
        }
        if (old === null || hash(old) !== tx.previousHash) { if (current === null && old !== null) await fs.link(backup, destination).catch(() => {}); throw conflict('External edit conflict. Previous and current files were preserved.'); }
      }
      if (current !== null) throw conflict('Destination changed outside Companion. The new destination was preserved.');
      await staged(stage, tx.content, destination);
      await this.vault.checkpoint('intake-capture-staged');
      if (!await this.ownedFile(stage, destination, 'Unsafe import staging file')) throw conflict('Unsafe import staging file disappeared. Its incoming revision was preserved.');
      try { await fs.link(stage, destination); } catch (error) { if (error.code !== 'EEXIST') throw error; await this.ownedFile(destination, [stage, backup], 'Capture destination'); if (await read(destination) !== tx.content) throw conflict('External edit conflict. The new destination was preserved.'); }
    }
    await this.vault.checkpoint('intake-published');
    await this.ownedFile(snapshot, snapshotStage, 'Immutable revision snapshot');
    await this.ownedFile(destination, [stage, backup], 'Capture destination');
    await this.ownedFile(backup, destination, 'Previous capture backup');
    if (await read(snapshot) !== snapshotBytes || await read(destination) !== tx.content || tx.previousHash !== null && hash(await read(backup) || '') !== tx.previousHash) throw conflict('External edit conflict during publication. All versions were preserved.');
    ledger.captures[tx.sourceHash] = tx.capture;
    const outcome = { status: 'imported', identity: tx.revision.identity, fingerprint: tx.revision.fingerprint, revision: tx.revision.id, snapshotHash: hash(snapshotBytes), sourceHash: tx.sourceHash, captureId: tx.capture.id, locator: tx.revision.locator, checkedAt: tx.revision.importedAt };
    ledger.outcomes[tx.key] = outcome; ledger.attempts[tx.revision.identity] = outcome;
    delete ledger.pending[tx.sourceHash];
    await this.save(ledger); await this.vault.checkpoint('intake-ledger');
    this.vault.expected.set(tx.capture.id, tx.capture.currentHash);
    for (const file of [stage, snapshotStage]) await fs.unlink(file).catch(error => { if (error.code !== 'ENOENT') throw error; });
    await fs.unlink(path.join(this.dir, 'transaction.json'));
  }
  async recover() {
    await this.finishTitleIntent();
    const text = await read(path.join(this.dir, 'transaction.json')); if (text === null) return;
    let tx; try { tx = JSON.parse(text); } catch { throw Error('Unreadable intake recovery journal. Preserve .intake for repair before retrying.'); }
    this.validateTransaction(tx);
    const ledger = await this.load();
    if (ledger.blocks[tx.sourceHash]) return this.archiveConflict(tx, ledger, ledger.blocks[tx.sourceHash].reason);
    if (ledger.pending[tx.sourceHash]) return this.defer(tx, ledger, ledger.pending[tx.sourceHash].reason);
    try { await this.finish(tx, ledger); } catch (error) {
      if (error.intakeDeferred) await this.defer(tx, ledger, error.message);
      else if (error.intakeConflict) await this.archiveConflict(tx, ledger, error.message);
      else throw error;
    }
  }
  async defer(tx, ledger, reason) {
    this.validateTransaction(tx);
    const name = `pending-${tx.revision.id}.json`, journal = path.join(this.dir, 'transaction.json');
    ledger.pending[tx.sourceHash] = { journal: name, reason, key: tx.key };
    ledger.outcomes[tx.key] = { status: 'held', reason, locator: tx.revision.locator, sourceHash: tx.sourceHash, pendingRevision: tx.revision.id };
    await this.save(ledger);
    try { await fs.link(journal, path.join(this.dir, name)); } catch (error) { if (error.code !== 'EEXIST' || await read(journal) !== await read(path.join(this.dir, name))) throw Error('Deferred intake journal conflicts. Preserve both files for repair.'); }
    await fs.unlink(journal);
  }
  async retryPending() {
    let ledger = await this.load();
    for (const [sourceHash, pending] of Object.entries(ledger.pending)) {
      if (!/^pending-[a-f0-9-]{36}\.json$/.test(pending.journal)) throw Error('Invalid deferred intake journal identity. Preserve .intake for repair.');
      let tx; try { tx = JSON.parse(await fs.readFile(path.join(this.dir, pending.journal), 'utf8')); } catch { throw Error('Deferred intake journal is unreadable. Preserve .intake for repair.'); }
      this.validateTransaction(tx); if (tx.sourceHash !== sourceHash || pending.journal !== `pending-${tx.revision.id}.json`) throw Error('Deferred intake identity does not match its journal.');
      // Every retry has the same active recovery seam as first publication.
      // A crash while turning a pending item into a conflict remains recoverable.
      await fs.link(path.join(this.dir, pending.journal), path.join(this.dir, 'transaction.json'));
      try {
        await this.finish(tx, ledger);
        await fs.unlink(path.join(this.dir, pending.journal)).catch(error => { if (error.code !== 'ENOENT') this.vault.warnings.push('Import saved; its deferred journal was retained for inspection.'); });
      }
      catch (error) {
        if (error.intakeConflict) await this.archiveConflict(tx, ledger, error.message);
        else if (error.intakeDeferred) await this.defer(tx, ledger, error.message);
        else throw error;
      }
      ledger = await this.load();
    }
  }
  async archiveConflict(tx, ledger, message) {
    this.validateTransaction(tx);
    await this.setup();
    const reason = `${message} Updates to this source are paused for explicit conflict repair.`;
    const archive = `conflict-${tx.revision.id}.json`, journal = path.join(this.dir, 'transaction.json');
    ledger.blocks[tx.sourceHash] = { reason, journal: archive, incomingRevision: tx.revision.id };
    delete ledger.pending[tx.sourceHash];
    if (ledger.captures[tx.sourceHash]) ledger.captures[tx.sourceHash].conflict = reason;
    ledger.outcomes[tx.key] = { status: 'held', reason, locator: tx.revision.locator, sourceHash: tx.sourceHash, pendingRevision: tx.revision.id };
    await this.save(ledger);
    try { await fs.link(journal, path.join(this.dir, archive)); } catch (error) { if (error.code !== 'EEXIST' || await read(journal) !== await read(path.join(this.dir, archive))) throw Error('Conflict archive already exists with different content. All files were preserved for repair.'); }
    await fs.unlink(journal);
    const destination = path.join(this.vault.root, 'Captures', tx.capture.file), backup = path.join(this.dir, tx.backup);
    const present = await fs.lstat(destination).then(() => true, error => { if (error.code === 'ENOENT') return false; throw error; });
    if (tx.previousHash !== null && !present) {
      try {
        if (await this.ownedFile(backup, destination, 'Previous capture backup')) {
          await fs.link(backup, destination).catch(error => { if (error.code !== 'EEXIST') throw error; });
          await this.ownedFile(destination, backup, 'Restored capture destination');
        }
      } catch (error) {
        if (!error.intakeConflict) throw error;
        ledger.blocks[tx.sourceHash].reason += ' The unsafe previous backup was preserved for explicit repair.';
        ledger.outcomes[tx.key].reason = ledger.blocks[tx.sourceHash].reason; await this.save(ledger);
      }
    }
  }
  async title(id, title) {
    return this.locked(async () => {
      const ledger = await this.load(), capture = Object.values(ledger.captures).find(x => x.id === id);
      if (!capture) return this.vault.title(id, title);
      if (typeof title !== 'string' || !title.trim() || /[\r\n]/.test(title)) throw Error('Enter a title on one line.');
      const note = await this.vault.find(id); if (hash(note.content) !== capture.currentHash) throw Error('This imported note changed outside Companion. Inspect it before editing.');
      await this.publishJournal(path.join(this.dir, 'title-intent.json'), { id, before: note.content, previousHash: capture.currentHash, title: title.trim(), content: withTitle(note.content, title.trim()) });
      await this.vault.title(id, title);
      if (!await this.finishTitleIntent()) throw Error('External edit conflict. The title intent and your files were preserved.');
    });
  }
  async finishTitleIntent() {
    const file = path.join(this.dir, 'title-intent.json'), text = await read(file); if (text === null) return true;
    let intent; try { intent = JSON.parse(text); } catch { throw Error('Unreadable imported title intent. Preserve .intake for repair.'); }
    const ledger = await this.load(), capture = Object.values(ledger.captures).find(x => x.id === intent.id);
    if (!capture || typeof intent.before !== 'string' || typeof intent.title !== 'string' || !intent.title.trim() || /[\r\n]/.test(intent.title) || intent.previousHash !== hash(intent.before) || intent.content !== withTitle(intent.before, intent.title) || ![intent.previousHash, hash(intent.content)].includes(capture.currentHash)) throw Error('Invalid imported title recovery intent. Files were preserved for repair.');
    let note = (await this.vault.list()).find(x => x.id === intent.id);
    if (!note || ![intent.before, intent.content].includes(note.content)) {
      const reason = 'External edit conflict during title save. Local writing and title intent were preserved; this source is paused for repair.';
      capture.conflict = reason; ledger.outcomes[`title:${intent.id}`] = { status: 'held', reason, locator: note?.file || capture.file };
      await this.save(ledger); await fs.rename(file, path.join(this.dir, `title-conflict-${intent.id}-${randomUUID()}.json`)); return false;
    }
    if (note.content === intent.before) { await this.vault.title(intent.id, intent.title); note = await this.vault.find(intent.id); }
    capture.title = intent.title; capture.currentHash = hash(note.content); this.vault.expected.set(intent.id, capture.currentHash);
    await this.save(ledger); await fs.unlink(file); return true;
  }
  async inspect(id) {
    const ledger = await this.info(), capture = Object.values(ledger.captures).find(x => x.id === id);
    if (!capture) throw Error('Imported capture is missing from intake history.');
    const revisions = [];
    for (const revision of capture.revisions) {
      if (!/^[a-f0-9-]{36}$/.test(revision)) throw Error('Invalid revision identity.');
      const bytes = await read(path.join(this.vault.root, 'Revisions', `${revision}.json`));
      const known = Object.values(ledger.attempts).find(x => x.revision === revision);
      if (bytes === null || !known || hash(bytes) !== known.snapshotHash) throw Error('Immutable revision snapshot is missing or changed. Restore it from a vault backup before inspecting evidence.');
      revisions.push(JSON.parse(bytes));
    }
    return { capture, revisions };
  }
}
module.exports = { Intake };
