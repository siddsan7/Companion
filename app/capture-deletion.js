const fs = require('node:fs/promises');
const path = require('node:path');
const YAML = require('yaml');
const { randomUUID } = require('node:crypto');
const { Intake, noteText } = require('./intake');
const { hash, readDraft } = require('./intake-producer');
const { readReview } = require('./intake-review');
const { intakeLock } = require('./intake-lock');
const { validateAuthority, revisionAdmission, uuid } = require('./source-authority');
const { parse } = require('./vault');
const relative = (vault, file) => path.relative(vault.vault, file).split(path.sep).join('/');
const changed = () => Error('Capture deletion files changed or contain unreviewed writing. Preserve them and preview the scope again.');

class CaptureDeletion {
  constructor({ getVault, conversations, clearApprovals, clock }) { Object.assign(this, { getVault, conversations, clearApprovals, clock }); this.previews = new Map(); this.restorations = new Map(); }
  async directory(vault, file) {
    const stat = await fs.lstat(file, { bigint: true }); await vault.contained(file);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw changed();
    return { file: relative(vault, file), dev: String(stat.dev), ino: String(stat.ino) };
  }
  async target(vault, file, kind) {
    await vault.contained(file);
    const stat = await fs.lstat(file, { bigint: true });
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1n) throw changed();
    const bytes = await fs.readFile(file), after = await fs.lstat(file, { bigint: true });
    if (after.dev !== stat.dev || after.ino !== stat.ino || after.size !== stat.size || after.mtimeNs !== stat.mtimeNs) throw changed();
    return { file: relative(vault, file), sha256: hash(bytes), dev: String(stat.dev), ino: String(stat.ino), bytes: String(bytes.length), kind };
  }
  async inventory(id) {
    if (!uuid(id)) throw Error('Choose a capture to delete.');
    const vault = this.getVault(); if (!vault) throw Error('Choose a vault first.');
    const intake = new Intake(vault), ledger = await intake.load(); validateAuthority(ledger);
    if (ledger.sourceAuthority?.[id] && ledger.sourceAuthority[id].phase !== 'active') throw Error('This capture already has a deletion operation.');
    const entry = Object.entries(ledger.captures).find(([, capture]) => capture.id === id);
    if (!entry) throw Error('Choose an imported capture to delete.');
    const [sourceHash, capture] = entry, notes = (await vault.scan()).filter(note => note.id === id);
    if (notes.length !== 1 || hash(notes[0].content) !== capture.currentHash) throw changed();
    const targets = [await this.target(vault, notes[0].file, 'capture')], revisions = new Map();
    for (const revisionId of capture.revisions) {
      if (!uuid(revisionId)) throw changed();
      const file = path.join(vault.root, 'Revisions', revisionId + '.json'), target = await this.target(vault, file, 'snapshot');
      const admission = revisionAdmission(ledger, revisionId);
      if (!admission || admission.snapshotHash !== target.sha256) throw changed();
      const revision = JSON.parse(await fs.readFile(file, 'utf8'));
      if (revision.id !== revisionId || revision.captureId !== id || revision.sourceHash !== sourceHash) throw changed();
      targets.push(target); revisions.set(revisionId, revision);
    }
    for (const name of (await fs.readdir(intake.dir)).sort()) {
      if (name === 'ledger.json') continue;
      const file = path.join(intake.dir, name), stat = await fs.lstat(file);
      if (!stat.isFile() || stat.isSymbolicLink()) throw changed();
      const text = await fs.readFile(file, 'utf8');
      if (!text.includes(id) && !text.includes(sourceHash)) continue;
      const note = parse(text);
      if (!note || note.id !== id || !new RegExp(`^${id}-[a-f0-9-]{36}\\.before(?:-[a-f0-9-]{36})?\\.md$`).test(name)) throw changed();
      const metadata = YAML.parse(text.match(/^---\r?\n([\s\S]*?)\r?\n---/)[1]), revision = revisions.get(metadata.source_revision);
      if (!revision || noteText({ ...capture, title: note.title, capturedAt: note.capturedAt, currentRevision: revision.id }, revision) !== text) throw changed();
      targets.push(await this.target(vault, file, 'source-backup'));
    }
    const directories = new Map();
    const intakeDirectory = await this.directory(vault, intake.dir); directories.set(intakeDirectory.file, intakeDirectory);
    for (const target of targets) {
      let directory = path.dirname(path.join(vault.vault, target.file));
      while (true) {
        const value = await this.directory(vault, directory); directories.set(value.file, value);
        if (directory === vault.vault) break;
        const parent = path.dirname(directory); if (parent === directory) throw changed(); directory = parent;
      }
    }
    const annotations = (await vault.scan({ annotations: true })).filter(note => note.captureId === id).map(note => ({ id: note.id, file: relative(vault, note.file), text: note.content }));
    return { id, root: await fs.realpath(vault.vault), sourceHash, capture, targets: targets.sort((a, b) => a.file.localeCompare(b.file)), directories: [...directories.values()].sort((a, b) => a.file.localeCompare(b.file)), annotations };
  }
  async preview(id) {
    const inventory = await this.inventory(id), token = randomUUID(); this.previews.set(token, inventory);
    return { token, title: inventory.capture.title, revisions: inventory.capture.revisions.length, targets: inventory.targets.map(target => target.file), annotations: inventory.annotations };
  }
  cancel(token) { this.previews.delete(token); }
  async suppressed() {
    const vault = this.getVault(); if (!vault) return [];
    const ledger = await new Intake(vault).load();
    return Object.entries(ledger.sourceAuthority || {}).filter(([, authority]) => authority.phase === 'deleted').map(([id, authority]) => ({ id, title: ledger.captures[authority.sourceHash]?.title || id }));
  }
  async restorationInput(input) {
    const vault = this.getVault();
    if (!vault || !uuid(input?.id) || typeof input.folder !== 'string' || !path.isAbsolute(input.folder) || !['draft', 'review'].includes(input.kind)) throw Error('Choose one complete producer artifact folder and its kind.');
    const intake = new Intake(vault), ledger = await intake.load(), authority = ledger.sourceAuthority?.[input.id];
    if (authority?.phase !== 'deleted' || !ledger.suppressed.includes(authority.sourceHash)) throw Error('Choose a deliberately deleted source.');
    const folder = await fs.lstat(input.folder, { bigint: true });
    if (!folder.isDirectory() || folder.isSymbolicLink()) throw Error('Choose an ordinary producer artifact folder.');
    const draft = await (input.kind === 'review' ? readReview(input.folder) : readDraft(input.folder));
    const accepted = ledger.attempts[draft.identity];
    if (draft.sourceHash !== authority.sourceHash || accepted && (accepted.fingerprint !== draft.fingerprint || accepted.captureId !== input.id || accepted.sourceHash !== authority.sourceHash)) throw Error('The selected artifact does not match this source or its immutable producer identity.');
    const capture = ledger.captures[authority.sourceHash];
    if (!capture || capture.id !== input.id || !capture.removed || await fs.access(intake.destination(capture)).then(() => true, error => { if (error.code === 'ENOENT') return false; throw error; })) throw changed();
    return { input: { id: input.id, folder: input.folder, kind: input.kind }, vault: vault.root, directory: { realpath: await fs.realpath(input.folder), dev: String(folder.dev), ino: String(folder.ino) }, authority, capture, draft };
  }
  async previewRestoration(input) {
    const selected = await this.restorationInput(input), token = randomUUID(); this.restorations.set(token, selected);
    return { token, id: input.id, title: selected.capture.title, identity: selected.draft.identity, fingerprint: selected.draft.fingerprint, text: selected.draft.text, review: selected.draft.humanReview };
  }
  async confirmRestoration(token) {
    const selected = this.restorations.get(token); if (!selected) throw Error('Preview the selected source restoration again.');
    const vault = this.getVault();
    return this.conversations.lock(() => intakeLock(vault.root, async () => {
      const fresh = await this.restorationInput(selected.input);
      if (JSON.stringify(fresh) !== JSON.stringify(selected)) throw Error('Selected restoration material changed. Preview it again.');
      const intake = new Intake(vault), ledger = await intake.load(), operationId = randomUUID(), generation = randomUUID(), revisionId = randomUUID(), now = this.clock().now;
      const revision = { schema: 1, id: revisionId, captureId: selected.input.id, importedAt: now, ...selected.draft };
      const capture = { id: selected.capture.id, file: selected.capture.file, ...(selected.capture.relative ? { relative: selected.capture.relative } : {}), capturedAt: selected.capture.capturedAt, title: selected.capture.title, currentRevision: revisionId, currentHash: '', reviewed: !!revision.review, rejected: revision.humanReview === 'reject', supportEligible: revision.supportEligible !== false, revisions: [revisionId], updatedAt: now };
      const content = noteText(capture, revision); capture.currentHash = hash(content);
      const tx = { schema: 1, restore: true, restoreOperation: operationId, sourceGeneration: generation, key: `${ledger.sources[0]?.id || randomUUID()}:restoration-${operationId}`, sourceHash: selected.authority.sourceHash, capture, revision, content, previousHash: null, previous: null, backup: `${capture.id}-${revisionId}.before.md` };
      intake.validateTransaction(tx);
      const journal = `restoration-${operationId}.json`, bytes = JSON.stringify(tx);
      await intake.publishJournal(path.join(intake.dir, journal), tx);
      const { history, ...prior } = selected.authority;
      ledger.sourceAuthority[capture.id] = { ...selected.authority, phase: 'restoring', operationId, generation, history: [...(history || []), prior], restoration: { journal, revision: revisionId, sha256: hash(bytes) } };
      await intake.save(ledger); this.restorations.delete(token); this.clearApprovals();
      await vault.checkpoint('capture-restoration-authorized');
      await finishRestoration(intake, ledger, capture.id); return true;
    }));
  }
  async pending() {
    const vault = this.getVault(); if (!vault) return [];
    const intake = new Intake(vault), ledger = await intake.load(), result = [];
    for (const [id, authority] of Object.entries(ledger.sourceAuthority || {})) if (authority.phase === 'deleting') {
      let reason = 'Confirmed scope is ready to resume.';
      try { await inspectDeletion(intake, ledger, id); } catch (error) { reason = error.message; }
      result.push({ id, operationId: authority.operationId, targets: authority.targets.map(target => target.file), reason });
    }
    return result;
  }
  async resume(input) {
    if (!uuid(input?.id) || !uuid(input?.operationId)) throw Error('Review the confirmed deletion operation again.');
    const vault = this.getVault(); if (!vault) throw Error('Choose a vault first.');
    return this.conversations.lock(() => intakeLock(vault.root, async () => {
      const intake = new Intake(vault), ledger = await intake.load(), authority = ledger.sourceAuthority?.[input.id];
      if (!authority || authority.operationId !== input.operationId || authority.phase !== 'deleting') throw Error('The confirmed deletion operation changed. Review recovery again.');
      await finishDeletion(intake, ledger, input.id); return true;
    }));
  }
  async confirm(token) {
    const selected = this.previews.get(token); if (!selected) throw Error('Preview capture deletion again.');
    const vault = this.getVault();
    return this.conversations.lock(() => intakeLock(vault.root, async () => {
      const fresh = await this.inventory(selected.id);
      if (JSON.stringify(fresh) !== JSON.stringify(selected)) throw changed();
      const acquired = [];
      try {
        for (const target of fresh.targets.filter(target => target.kind === 'capture')) { const file = path.join(vault.vault, target.file); await vault.acquire(file); acquired.push(file); }
        if (JSON.stringify(await this.inventory(selected.id)) !== JSON.stringify(selected)) throw changed();
        const intake = new Intake(vault), ledger = await intake.load();
        ledger.sourceAuthority ||= {};
        ledger.sourceAuthority[selected.id] = { generation: randomUUID(), phase: 'deleting', operationId: randomUUID(), sourceHash: fresh.sourceHash, root: fresh.root, targets: fresh.targets, directories: fresh.directories, ...(ledger.sourceAuthority[selected.id]?.history ? { history: ledger.sourceAuthority[selected.id].history } : {}) };
        ledger.suppressed = [...new Set([...ledger.suppressed, fresh.sourceHash])];
        ledger.captures[fresh.sourceHash].removed = true;
        await intake.save(ledger); this.clearApprovals(); this.previews.delete(token);
        await vault.checkpoint('capture-deletion-authorized');
        await finishDeletion(intake, ledger, selected.id);
      } finally { for (const file of acquired.reverse()) await vault.release(file); }
      return true;
    }));
  }
}
async function inspectDeletion(intake, ledger, id) {
  validateAuthority(ledger);
  const authority = ledger.sourceAuthority[id], vault = intake.vault;
  if (authority.phase !== 'deleting') return [];
  if (await fs.realpath(vault.vault) !== authority.root) throw changed();
  const deletion = new CaptureDeletion({ getVault: () => vault });
  const requiredDirectories = new Set([relative(vault, intake.dir)]);
  for (const target of authority.targets) {
    let directory = path.dirname(path.join(vault.vault, target.file));
    while (true) {
      requiredDirectories.add(relative(vault, directory)); if (directory === vault.vault) break;
      const parent = path.dirname(directory); if (parent === directory) throw changed(); directory = parent;
    }
  }
  if (new Set(authority.directories.map(item => item.file)).size !== authority.directories.length || authority.directories.length !== requiredDirectories.size || authority.directories.some(item => !requiredDirectories.has(item.file))) throw changed();
  for (const directory of authority.directories) if (JSON.stringify(await deletion.directory(vault, path.join(vault.vault, directory.file))) !== JSON.stringify(directory)) throw changed();
  const capture = ledger.captures[authority.sourceHash];
  if (!capture || capture.id !== id || !capture.removed || !ledger.suppressed.includes(authority.sourceHash)) throw changed();
  const knownPaths = new Set(authority.targets.map(target => target.file));
  for (const note of (await vault.scan()).filter(note => note.id === id)) if (!knownPaths.has(relative(vault, note.file))) throw changed();
  for (const folder of [intake.dir, path.join(vault.root, 'Revisions')]) for (const name of await fs.readdir(folder)) {
    if (folder === intake.dir && name === 'ledger.json') continue;
    const file = path.join(folder, name), info = await fs.lstat(file);
    if (!info.isFile() || info.isSymbolicLink()) throw changed();
    const text = await fs.readFile(file, 'utf8');
    if ((text.includes(id) || text.includes(authority.sourceHash)) && !knownPaths.has(relative(vault, file))) throw changed();
  }
  // Validate the entire remaining manifest before the first unlink, and each file again at unlink.
  const remaining = [];
  for (const target of authority.targets) {
    const file = path.join(vault.vault, target.file);
    try {
      if (JSON.stringify(await deletion.target(vault, file, target.kind)) !== JSON.stringify(target)) throw changed();
      const text = await fs.readFile(file, 'utf8');
      if (target.kind === 'snapshot') {
        const revision = JSON.parse(text), known = revisionAdmission(ledger, revision.id);
        if (!uuid(revision.id) || revision.captureId !== id || revision.sourceHash !== authority.sourceHash || !capture.revisions.includes(revision.id) || !known || known.captureId !== id || known.sourceHash !== authority.sourceHash || known.snapshotHash !== target.sha256 || file !== path.join(vault.root, 'Revisions', revision.id + '.json')) throw changed();
      } else {
        const note = parse(text), metadata = YAML.parse(text.match(/^---\r?\n([\s\S]*?)\r?\n---/)?.[1] || '');
        if (!note || note.id !== id || note.type !== 'reel_import' || metadata.source_hash !== authority.sourceHash || !capture.revisions.includes(metadata.source_revision)) throw changed();
        if (target.kind === 'capture' && target.sha256 !== capture.currentHash || target.kind === 'source-backup' && (path.dirname(file) !== intake.dir || !new RegExp(`^${id}-[a-f0-9-]{36}\\.before(?:-[a-f0-9-]{36})?\\.md$`).test(path.basename(file)))) throw changed();
      }
      remaining.push(target);
    }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  return remaining;
}
async function finishDeletion(intake, ledger, id) {
  const authority = ledger.sourceAuthority[id], vault = intake.vault;
  const remaining = await inspectDeletion(intake, ledger, id);
  const deletion = new CaptureDeletion({ getVault: () => vault });
  for (const target of remaining) {
    const file = path.join(vault.vault, target.file);
    if (JSON.stringify(await deletion.target(vault, file, target.kind)) !== JSON.stringify(target)) throw changed();
    await fs.unlink(file); await vault.checkpoint('capture-deletion-unlinked');
  }
  authority.phase = 'deleted'; await intake.save(ledger);
}
function installCaptureDeletion({ ipcMain, ...options }) {
  const store = new CaptureDeletion(options);
  ipcMain.handle('capture-delete-preview', (_, input) => store.preview(input?.id));
  ipcMain.handle('capture-delete-cancel', (_, input) => store.cancel(input?.token));
  ipcMain.handle('capture-delete-confirm', (_, input) => store.confirm(input?.token));
  ipcMain.handle('capture-delete-pending', () => store.pending());
  ipcMain.handle('capture-delete-resume', (_, input) => store.resume(input));
  ipcMain.handle('capture-delete-suppressed', () => store.suppressed());
  ipcMain.handle('capture-delete-restoration-preview', (_, input) => store.previewRestoration(input));
  ipcMain.handle('capture-delete-restoration-confirm', (_, input) => store.confirmRestoration(input?.token));
}
async function finishRestoration(intake, ledger, id) {
  validateAuthority(ledger);
  const authority = ledger.sourceAuthority[id], vault = intake.vault;
  if (authority?.phase !== 'restoring') return;
  if (await fs.realpath(vault.vault) !== authority.root || !ledger.suppressed.includes(authority.sourceHash)) throw Error('Restoration authority changed. Suppression remains.');
  const journal = path.join(intake.dir, authority.restoration.journal), transaction = path.join(intake.dir, 'transaction.json');
  if (!authority.restoration.published) {
    await intake.ownedFile(journal, transaction, 'Selected restoration journal');
    const bytes = await fs.readFile(journal, 'utf8'); if (hash(bytes) !== authority.restoration.sha256) throw Error('Selected restoration journal changed. Suppression remains.');
    const tx = JSON.parse(bytes); intake.validateTransaction(tx);
    if (tx.restoreOperation !== authority.operationId || tx.sourceGeneration !== authority.generation || tx.revision.id !== authority.restoration.revision || tx.capture.id !== id || tx.sourceHash !== authority.sourceHash) throw Error('Selected restoration identity changed.');
    await intake.ownedFile(transaction, journal, 'Active restoration journal');
    try { await fs.link(journal, transaction); } catch (error) { if (error.code !== 'EEXIST' || await fs.readFile(transaction, 'utf8') !== bytes) throw Error('Another source journal needs explicit recovery.'); }
    await intake.finish(tx, ledger);
    authority.restoration.published = true; await intake.save(ledger);
  }
  const capture = ledger.captures[authority.sourceHash], admission = revisionAdmission(ledger, authority.restoration.revision);
  const snapshot = path.join(vault.root, 'Revisions', authority.restoration.revision + '.json');
  await intake.ownedFile(snapshot, [], 'Restored revision'); await intake.ownedFile(intake.destination(capture), [], 'Restored capture');
  const snapshotBytes = await fs.readFile(snapshot, 'utf8'), revision = JSON.parse(snapshotBytes), content = await fs.readFile(intake.destination(capture), 'utf8');
  if (!admission || admission.sourceGeneration !== authority.generation || admission.captureId !== id || hash(snapshotBytes) !== admission.snapshotHash || capture.currentRevision !== revision.id || revision.captureId !== id || revision.sourceHash !== authority.sourceHash || hash(content) !== capture.currentHash || content !== noteText(capture, revision)) throw Error('Restored publication changed. Suppression remains.');
  const remaining = await intake.ownedFile(journal, [], 'Selected restoration journal');
  if (remaining) { if (hash(await fs.readFile(journal)) !== authority.restoration.sha256) throw Error('Selected restoration journal changed.'); await fs.unlink(journal); }
  await vault.checkpoint('capture-restoration-published');
  authority.phase = 'active'; delete authority.restoration;
  ledger.suppressed = ledger.suppressed.filter(item => item !== authority.sourceHash);
  await intake.save(ledger);
}
module.exports = { CaptureDeletion, finishDeletion, finishRestoration, installCaptureDeletion };
