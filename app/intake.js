const fs = require('node:fs/promises');
const local = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { isDeepStrictEqual } = require('node:util');
const { readDraft, hash } = require('./intake-producer');
const { readReview } = require('./intake-review');
const { sourceMutation } = require('./source-mutation');
const { withTitle, captureHeading, parseAnnotation } = require('./vault');
const { validateAuthority, assertPublication, revisionAdmission, activeAdmission, uuid } = require('./source-authority');
const { IntakeLedger } = require('./intake-ledger');
const { validateAnnotationLinks, validateAnnotationRemovals } = require('./annotation-authority');
const { pendingParents, isManualHold, requiredDirectories } = require('./source-recovery');
const { ordinaryDirectories, readExactSync, validProof, verifyAbsentSync, verifyStageSync, writeStage } = require('./staged-publication');
const { matchesProducerOutcome, producerCandidate, producerOutcomeKey, producerRootGuard, sameIdentity, samePath, selectProducerRoot, unavailable } = require('./producer-root');
const empty = () => ({ schema: 1, sources: [], captures: {}, attempts: {}, blocks: {}, pending: {}, outcomes: {}, suppressed: [] });
const read = file => fs.readFile(file, 'utf8').catch(error => { if (error.code === 'ENOENT') return null; throw error; });
const conflict = message => Object.assign(Error(message), { intakeConflict: true });
const deferred = message => Object.assign(Error(message), { intakeDeferred: true });
const conflictPause = ' Updates to this source are paused for explicit conflict repair.';
const outputHold = 'Published intake output or recovery evidence changed.';
const precommitConflict = 'precommit-conflict';
const acceptancePreserved = ' The recorded producer acceptance was preserved.';
const acceptedCleanupFailures = new WeakSet();
const sharedRestorationFailures = new WeakSet();
const publishedImportedRestorations = ledger => Object.values(ledger.sourceAuthority || {}).filter(authority =>
  authority.phase === 'restoring' && !authority.manual && authority.restoration.published && authority.restoration.importedPublication);
const heldName = tx => `conflict-${tx.revision.id}${tx.resolution ? `-${tx.resolution}` : ''}.json`;
const pendingName = tx => `pending-${tx.revision.id}${tx.resolution ? `-${tx.resolution}` : ''}.json`;
const exactIdentity = (a, b) => !!a && !!b && a.dev === b.dev && a.ino === b.ino;
const publicationIdentity = (info, nlink = info.nlink) => ({ dev: info.dev, ino: info.ino, nlink });
const fileProof = (info, content) => ({ dev: String(info.dev), ino: String(info.ino), digest: hash(content) });
const sameProofIdentity = (a, b) => a.dev === b.dev && a.ino === b.ino;
const fileAccessRefused = error => ['EACCES', 'EPERM', 'EBUSY'].includes(error?.code);
const validCaptureAccess = proof => validProof(proof) && [1, 2].includes(proof.links) && Array.isArray(proof.directories) &&
  Object.keys(proof).every(key => ['dev', 'ino', 'digest', 'links', 'directories'].includes(key));
function matchesCaptureAccess(file, peers, proof, guard) {
  guard();
  const matches = name => {
    const stat = local.lstatSync(name, { bigint: true, throwIfNoEntry: false });
    return stat?.isFile() && !stat.isSymbolicLink() && stat.nlink === BigInt(proof.links) &&
      sameProofIdentity({ dev: String(stat.dev), ino: String(stat.ino) }, proof);
  };
  try { return matches(file) && peers.filter(matches).length + 1 === proof.links; }
  catch (error) { if (fileAccessRefused(error)) return false; throw error; }
}
const acceptedOutcome = (tx, snapshotBytes = JSON.stringify(tx.revision, null, 2)) => ({
  status: 'imported', identity: tx.revision.identity, fingerprint: tx.revision.fingerprint, revision: tx.revision.id,
  snapshotHash: hash(snapshotBytes), sourceHash: tx.sourceHash, captureId: tx.capture.id, locator: tx.revision.locator,
  checkedAt: tx.revision.importedAt, ...(tx.sourceGeneration ? { sourceGeneration: tx.sourceGeneration } : {})
});
const heldArtifact = (folder, error, now) => ({
  status: 'held', locator: folder, checkedAt: now,
  reason: error.code ? 'Unreadable artifact. Check source access and complete the producer transfer, then Check now.' : error.message
});
function noteText(capture, revision) {
  const fields = { companion_id: capture.id, artifact_type: 'capture', schema_version: 1, capture_type: 'reel_import', captured_at: capture.capturedAt, title: capture.title, source_hash: revision.sourceHash, source_revision: revision.id, source_started_at: revision.run.started_utc, imported_at: revision.importedAt, extraction_status: revision.extraction, human_review: revision.humanReview, ...(revision.review ? { processing_status: revision.processing || revision.run.state || 'unknown', support_eligible: revision.supportEligible !== false } : {}), provenance: revision.review ? 'Reel to MD finalized human decision; acceptance does not verify every claim' : 'Reel to MD validated draft; structural grounding is not factual verification' };
  return `---\n${Object.entries(fields).map(([key, value]) => `${key}: ${JSON.stringify(value)}`).join('\n')}\n---\n\n${captureHeading(capture.title, 'reel_import')}\n\n${revision.text}`;
}
function selectedCapture(previous, revision, now) {
  const capture = {
    ...previous, currentRevision: revision.id, reviewed: true, rejected: revision.humanReview === 'reject',
    supportEligible: revision.supportEligible !== false, reviewChoices: [], updatedAt: now,
    selectionHistory: [...(previous.selectionHistory || []), { revision: revision.id, selectedAt: now }]
  };
  capture.currentHash = hash(noteText(capture, revision));
  return capture;
}
class Intake {
  constructor(vault) { this.vault = vault; this.dir = path.join(vault.root, '.intake'); this.storage = new IntakeLedger(vault); }
  async setup() {
    try { await this.vault.writable(); await fs.mkdir(this.dir, { recursive: true }); await this.vault.contained(this.dir); await this.vault.contained(path.join(this.vault.root, 'Revisions')); }
    catch (error) { throw Error('Vault access failure. Restore access to the configured vault and Companion folders, then Refresh. Existing notes and intake history were preserved; no missing-note removal was inferred.', { cause: error }); }
  }
  async load() {
    const text = await this.storage.read(); if (text === null) return empty();
    let ledger; try { ledger = JSON.parse(text); } catch { throw Error('Intake ledger is unreadable. Preserve .intake and restore a vault backup before checking sources.'); }
    if (ledger.schema !== 1 || !Array.isArray(ledger.sources) || !ledger.captures || !ledger.attempts || !ledger.blocks || !ledger.pending || !ledger.outcomes || !Array.isArray(ledger.suppressed)) throw Error('Unsupported intake ledger. Preserve it for repair.');
    validateAuthority(ledger); validateAnnotationRemovals(ledger); validateAnnotationLinks(ledger); return ledger;
  }
  async save(ledger, verifyRelated) {
    validateAuthority(ledger);
    validateAnnotationRemovals(ledger);
    validateAnnotationLinks(ledger);
    await this.storage.replace(JSON.stringify(ledger, null, 2), verifyRelated);
  }
  async publishJournal(file, value) {
    await this.vault.contained(this.dir);
    const stage = path.join(this.dir, `journal-${randomUUID()}.stage`);
    const guard = this.vault.publicationFolders(this.dir).guard;
    const proof = await writeStage(stage, JSON.stringify(value), guard);
    verifyAbsentSync(file, guard);
    verifyStageSync(stage, guard, proof);
    local.linkSync(stage, file);
    verifyStageSync(stage, guard, proof, 2);
    verifyStageSync(file, guard, proof, 2);
    local.unlinkSync(stage);
    verifyStageSync(file, guard, proof);
    return proof;
  }
  async locked(work, admit) {
    if (!admit) await this.setup();
    return sourceMutation(this.vault.root, async () => {
      if (admit) {
        // A scheduled worker must still own its slot before touching recovery.
        if (!await admit()) return { skipped: true };
        await this.setup();
      }
      await this.recover();
      return work();
    });
  }
  async info() {
    await this.setup();
    try { return await this.locked(async () => { await this.syncMoves(); return this.load(); }); } catch (error) { if (error.message.includes('already running')) return this.load(); throw error; }
  }
  async connect(folder, scan, now, kind = 'draft') {
    await this.locked(async () => {
      const ledger = await this.load();
      const selected = await selectProducerRoot(folder, this.vault.root);
      const existing = ledger.sources.find(source => (source.kind || 'draft') === kind && samePath(source.folder, selected.folder));
      if (existing) return producerRootGuard(existing)();
      ledger.sources.push({ id: randomUUID(), ...selected, kind, connectedAt: now, firstScan: !!scan });
      await this.save(ledger);
    });
    if (scan) return this.reconcile({ trigger: 'first-scan', now });
  }
  async reconnect({ id, folder, kind, identity, epoch, replacement }) {
    await this.locked(async () => {
      const ledger = await this.load();
      const source = ledger.sources.find(item => item.id === id);
      if (!source || source.folder !== folder || (source.kind || 'draft') !== kind || source.epoch !== epoch ||
          (source.identity || identity) && !sameIdentity(source.identity, identity)) throw Error('Producer source selection changed. Refresh and select the source again.');
      const selected = await selectProducerRoot(replacement, this.vault.root);
      if (ledger.sources.some(item => item.id !== id && (item.kind || 'draft') === kind && samePath(item.folder, selected.folder))) throw Error('This folder is already connected for this kind of producer output.');
      if (source.folder !== selected.folder || !sameIdentity(source.identity, selected.identity)) {
        // Older journals retain their original locator and outcome key.
        source.previousLocations = [...(source.previousLocations || []), { folder: source.folder, epoch: source.epoch }];
        source.epoch = randomUUID();
      }
      Object.assign(source, selected);
      delete source.error;
      await this.save(ledger);
    });
  }
  async candidates(source, guardRoot) {
    const found = [];
    const markers = source.kind === 'review' ? ['manifest.json', 'source.json', 'review.json'] : ['run.json', 'evidence.json', 'first-pass-target.json', 'notes.md'];
    const visit = async (folder, guard, depth) => {
      if (depth > 12) throw Error('Source nesting exceeds the supported depth. Select a narrower producer folder.');
      await guard();
      const entries = await fs.readdir(folder, { withFileTypes: true });
      await guard();
      if (entries.some(entry => markers.includes(entry.name))) { found.push({ folder, guard }); return; }
      for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
        if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
        const child = path.join(folder, entry.name);
        try { await visit(child, await producerCandidate(child, guard), depth + 1); }
        catch (error) {
          if (error.producerRoot) throw error;
          await guardRoot();
          found.push({ folder: child, error });
        }
      }
    };
    await visit(source.folder, guardRoot, 0);
    return found;
  }
  async scanSource(source, now, retained) {
    const guardRoot = producerRootGuard(source);
    const ready = [], outcomes = new Map();
    for (const candidate of await this.candidates(source, guardRoot)) {
      const { folder, guard } = candidate;
      const key = producerOutcomeKey(source, folder);
      // A local recovery journal owns this slot until its resolution.
      if (retained.has(key)) continue;
      try {
        if (candidate.error) throw candidate.error;
        const draft = await (source.kind === 'review' ? readReview(folder, guard) : readDraft(folder, guard));
        await guard();
        ready.push({ draft, key, sourceId: source.id, guard });
        outcomes.set(key, null);
      } catch (error) {
        if (error.producerRoot) throw error;
        await guardRoot();
        outcomes.set(key, heldArtifact(folder, error, now));
      }
    }
    await guardRoot();
    return { ready, outcomes };
  }
  async retainedOutcomes(ledger) {
    const keys = new Set(Object.values(ledger.pending).map(item => item.key));
    for (const [sourceHash, block] of Object.entries(ledger.blocks)) {
      const matches = outcome => outcome?.status === 'held' && (outcome.sourceHash === sourceHash ||
        (outcome.pendingRevision && outcome.pendingRevision === block.incomingRevision) ||
        outcome.reason === block.reason || outcome.reason + conflictPause === block.reason);
      try {
        if (!/^conflict-[a-f0-9-]{36}(?:-[a-f0-9-]{36})?\.json$/.test(block.journal)) throw Error();
        const journal = path.join(this.dir, block.journal);
        const before = await this.ownedFile(journal, [], 'Held import journal');
        if (!before) throw Error();
        const tx = JSON.parse(await read(journal));
        const after = await this.ownedFile(journal, [], 'Held import journal');
        this.validateTransaction(tx);
        this.verifyHeldTransaction(ledger, tx);
        const outcome = ledger.outcomes[tx.key];
        if (tx.sourceHash !== sourceHash || tx.revision.id !== block.incomingRevision ||
            block.journal !== `conflict-${tx.revision.id}${tx.resolution ? `-${tx.resolution}` : ''}.json` ||
            !after || after.dev !== before.dev || after.ino !== before.ino || after.mtimeNs !== before.mtimeNs ||
            !matches(outcome) || outcome.locator !== tx.revision.locator) throw Error();
        keys.add(tx.key);
      } catch {
        // A damaged journal cannot authorize retirement of its possible outcome.
        for (const [key, outcome] of Object.entries(ledger.outcomes)) if (matches(outcome)) keys.add(key);
      }
    }
    return keys;
  }
  async reconcile({ trigger = 'manual', now = new Date().toISOString(), admit } = {}) {
    return this.locked(async () => {
      let identityScanComplete = true;
      try { await this.syncMoves(); }
      catch (error) {
        if (!await this.heldCaptureReadRefusal(error)) throw error;
        identityScanComplete = false;
      }
      if (identityScanComplete) await this.retryPending();
      let ledger = await this.load(); const seen = new Map(), ready = [];
      const retained = await this.retainedOutcomes(ledger);
      ledger.lastCheck = { at: now, trigger, status: 'running' }; await this.save(ledger);
      for (const source of ledger.sources) {
        let scan;
        try { scan = await this.scanSource(source, now, retained); delete source.error; }
        catch (error) { source.error = error.producerRoot ? error.message : unavailable().message; continue; }
        // Validate all candidates before admitting any: conflicting copies of the
        // same producer attempt are held regardless of directory iteration order.
        for (const item of scan.ready) {
          const { identity, fingerprint } = item.draft;
          const prior = seen.get(identity);
          if (prior && prior !== fingerprint) seen.set(identity, false);
          else if (prior !== false) seen.set(identity, fingerprint);
          ready.push(item);
        }
        for (const [key, outcome] of scan.outcomes) if (outcome) ledger.outcomes[key] = outcome;
        for (const [key, outcome] of Object.entries(ledger.outcomes)) {
          if (outcome.status === 'held' && !retained.has(key) && !scan.outcomes.has(key) && matchesProducerOutcome(source, key, outcome.locator)) {
            ledger.outcomes[key] = { ...outcome, status: 'absent', checkedAt: now };
          }
        }
      }
      await this.save(ledger);
      for (const { draft, key, sourceId, guard } of ready) {
        const source = ledger.sources.find(item => item.id === sourceId);
        if (source.error) continue;
        // The unreadable capture could claim a different existing identity.
        // Only new source identities can proceed without a full vault scan.
        if (!identityScanComplete && (ledger.captures[draft.sourceHash] || ledger.attempts[draft.identity] ||
            ledger.pending[draft.sourceHash] || ledger.blocks[draft.sourceHash])) continue;
        if (ledger.blocks[draft.sourceHash]?.outputHold && retained.has(key)) continue;
        try {
          await guard();
          if (seen.get(draft.identity) === false) throw Error('Ambiguous attempt identity: different artifact bytes claim the same attempt. Keep the intended producer copy, then Check now.');
          await this.admit(ledger, draft, key, now, guard);
          ledger = await this.load();
        } catch (error) {
          if (acceptedCleanupFailures.has(error) || sharedRestorationFailures.has(error)) throw error;
          if (error.intakeOutputHeld) continue;
          if (error.producerRoot) {
            source.error = error.message;
            await this.save(ledger);
            continue;
          }
          if (error.intakeConflict || error.intakeDeferred) {
            const transaction = JSON.parse(await fs.readFile(path.join(this.dir, 'transaction.json'), 'utf8'));
            if (error.intakeDeferred) await this.defer(transaction, ledger, error.message, error.intakeJournalProof);
            else await this.archiveConflict(transaction, ledger, error.message, { ...error.intakeConflictProof, expectedJournal: error.intakeJournalProof });
          }
          ledger.outcomes[key] = { status: 'held', reason: error.code ? 'Publication failed. Preserve the vault and retry Check now after fixing file access.' : error.message, locator: draft.locator, checkedAt: now };
          await this.save(ledger);
        }
      }
      ledger.lastCheck = { at: now, trigger, status: ledger.sources.some(x => x.error) ? 'error' : Object.values(ledger.outcomes).some(x => x.status === 'held') ? 'held' : 'complete' };
      if (ledger.lastCheck.status === 'complete') ledger.lastSuccess = { at: now, trigger };
      await this.save(ledger); return ledger;
    }, admit);
  }
  async admit(ledger, draft, key, now, guard) {
    const purged = require('./source-inventory').purgedAttempt(ledger, draft);
    if (ledger.suppressed.includes(draft.sourceHash)) throw Error('Automatic re-import is suppressed. Restore this source explicitly before intake.');
    if (ledger.captures[draft.sourceHash]?.identityIssue) throw Error(ledger.captures[draft.sourceHash].identityIssue);
    if (ledger.blocks[draft.sourceHash]) throw Error(ledger.blocks[draft.sourceHash].reason);
    if (ledger.pending[draft.sourceHash]) throw Error(ledger.pending[draft.sourceHash].reason);
    const accepted = ledger.attempts[draft.identity];
    if (accepted && accepted.fingerprint !== draft.fingerprint) throw Error('Attempt identity changed after import. Original acceptance is immutable. Restore the original export or produce a distinct attempt.');
    const prior = accepted && activeAdmission(ledger, draft.identity, accepted.captureId);
    if (accepted && !prior || purged && !activeAdmission(ledger, draft.identity, purged.captureId)) {
      await guard();
      ledger.outcomes[key] = { status: 'suppressed', sourceHash: draft.sourceHash, locator: draft.locator, checkedAt: now, reason: 'This earlier producer attempt was deleted. Only an explicitly selected restoration may admit it again.' };
      await this.save(ledger); return;
    }
    if (prior) {
      if (!/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(prior.revision)) throw Error('Invalid retained revision identity. Preserve intake history for repair.');
      const snapshot = await read(path.join(this.vault.root, 'Revisions', `${prior.revision}.json`));
      if (snapshot === null || hash(snapshot) !== prior.snapshotHash) throw Error('Immutable revision snapshot is missing or changed. Restore it from a vault backup before retrying.');
      await guard();
      ledger.outcomes[key] = { ...prior, locator: draft.locator, checkedAt: now }; await this.save(ledger); return;
    }
    let capture = ledger.captures[draft.sourceHash];
    if (capture && capture.id === this.pendingTitleCapture) throw Error('An interrupted title is still being recovered. Its source revision was held for the next intake check.');
    if (capture?.conflict) throw Error(capture.conflict);
    const retainOnly = !!capture?.reviewed;
    const id = capture?.id || randomUUID(), revisionId = randomUUID();
    const revision = { schema: 1, id: revisionId, captureId: id, importedAt: now, ...draft };
    const file = capture?.file || `${id}.md`;
    if (path.basename(file) !== file) throw Error('Invalid intake destination identity. Preserve ledger for repair.');
    const destination = this.destination(capture || { file }), current = await read(destination);
    const externalConflict = !!capture && (current === null || hash(current) !== capture.currentHash);
    if (!capture && current !== null) throw Error('Destination already exists. Resolve its identity before intake.');
    const previousCapture = capture;
    capture = { ...capture, id, file, capturedAt: capture?.capturedAt || new Date(now).toISOString(), title: capture?.title || (draft.target?.title || 'Rejected source').replace(/[\r\n]/g, ' '), currentRevision: revisionId, reviewed: !!draft.review, rejected: draft.humanReview === 'reject', supportEligible: draft.supportEligible !== false, revisions: [...(capture?.revisions || []), revisionId], updatedAt: now };
    if (retainOnly) {
      capture = { ...previousCapture, revisions: capture.revisions, updatedAt: now };
      if (draft.review) { capture.reviewChoices = [...new Set([...(capture.reviewChoices || []), capture.currentRevision, revisionId])]; capture.supportEligible = false; }
    }
    const content = retainOnly ? current : noteText(capture, revision); capture.currentHash = hash(content);
    const transaction = { schema: 1, externalConflict, retainOnly, key, sourceHash: draft.sourceHash, capture, revision, content, previousHash: current === null ? null : hash(current), previous: current, backup: `${id}-${revisionId}.before.md`, ...(ledger.sourceAuthority?.[id]?.phase === 'active' ? { sourceGeneration: ledger.sourceAuthority[id].generation } : {}) };
    // The durable journal owns these verified bytes after this check. Recovery
    // uses that local copy without reopening the producer.
    await guard();
    const journal = path.join(this.dir, 'transaction.json');
    const proof = await this.publishJournal(journal, transaction);
    await this.vault.checkpoint('intake-journaled');
    try {
      if (externalConflict) {
        this.ordinaryPublicationControls(transaction, ledger, proof)?.();
        throw conflict('Destination changed outside Companion. Local writing and incoming source were preserved.');
      }
      await this.finish(transaction, ledger, proof);
    } catch (error) {
      if (error.intakeDeferred || error.intakeConflict) error.intakeJournalProof = proof;
      throw error;
    }
  }
  destination(capture) {
    if (!capture.relative) return path.join(this.vault.root, 'Captures', capture.file);
    if (typeof capture.relative !== 'string' || path.isAbsolute(capture.relative) || capture.relative.split(/[\\/]/).some(part => !part || part === '.' || part === '..') || !capture.relative.endsWith('.md')) throw Error('Invalid moved capture path. Preserve intake history for repair.');
    return path.join(this.vault.vault, capture.relative);
  }
  validateTransaction(tx) {
    const uuid = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/;
    try {
      this.destination(tx.capture);
      if (tx.sourceGeneration !== undefined && !uuid.test(tx.sourceGeneration) || tx.restoreOperation !== undefined && !uuid.test(tx.restoreOperation)) throw Error();
      if (tx.keptCurrent !== undefined && (!tx.resolution || tx.retainOnly || !tx.keptCurrent.review || !uuid.test(tx.keptCurrent.id) || tx.keptCurrent.id !== tx.capture.currentRevision || tx.keptCurrent.captureId !== tx.capture.id || tx.keptCurrent.sourceHash !== tx.sourceHash || !tx.capture.revisions.includes(tx.keptCurrent.id))) throw Error();
      if (tx.schema !== 1 || typeof tx.content !== 'string' || !tx.capture || !tx.revision || !uuid.test(tx.capture.id) || !uuid.test(tx.revision.id) || !/^[a-f0-9]{64}$/.test(tx.sourceHash) || typeof tx.key !== 'string' || !uuid.test(tx.key.split(':')[0]) || tx.capture.file !== `${tx.capture.id}.md` || (tx.resolution !== undefined && !uuid.test(tx.resolution) || tx.backup !== `${tx.capture.id}-${tx.revision.id}.before${tx.resolution ? `-${tx.resolution}` : ''}.md`) || tx.capture.currentHash !== hash(tx.content) || tx.revision.captureId !== tx.capture.id || tx.revision.sourceHash !== tx.sourceHash || (tx.retainOnly ? tx.content !== tx.previous || !tx.resolution && tx.capture.currentRevision === tx.revision.id || !tx.capture.revisions.includes(tx.revision.id) : tx.content !== noteText(tx.capture, tx.keptCurrent || tx.revision)) || (tx.previous === null ? tx.previousHash !== null : typeof tx.previous !== 'string' || hash(tx.previous) !== tx.previousHash)) throw Error();
    } catch { throw Error('Invalid intake recovery journal. Files were preserved for repair.'); }
  }
  async verifiedKeptCurrent(tx, ledger) {
    const revisionId = tx.capture.currentRevision, current = ledger.captures[tx.sourceHash];
    if (!/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(revisionId) || !current || current.id !== tx.capture.id || current.currentRevision !== revisionId) throw Error('Invalid current reviewed revision. Files were preserved for repair.');
    const known = revisionAdmission(ledger, revisionId);
    if (!known || known.captureId !== tx.capture.id || known.sourceHash !== tx.sourceHash || !/^[a-f0-9]{64}$/.test(known.snapshotHash)) throw Error('Current reviewed revision has no valid retained intake identity. Preserve the ledger for repair.');
    const file = path.join(this.vault.root, 'Revisions', `${revisionId}.json`);
    // Global storage failure is not a per-source held import.
    await this.vault.writable(); await this.vault.contained(path.dirname(file));
    const failed = (message, access = false) => Object.assign(access ? deferred(message) : conflict(message), { keptCurrentFailure: true });
    let bytes;
    try { await this.vault.checkpoint('kept-current-read'); await this.ownedFile(file, [], 'Current reviewed revision snapshot'); bytes = await read(file); }
    catch (error) {
      if (error.intakeConflict) throw failed(error.message);
      if (['EACCES', 'EPERM', 'EBUSY'].includes(error.code)) throw failed('Current reviewed revision snapshot is inaccessible. Restore source-file access before retrying repair.', true);
      throw error;
    }
    if (bytes === null || hash(bytes) !== known.snapshotHash) throw failed('Current reviewed revision is missing or changed. Restore its verified snapshot before resolving local writing.');
    const revision = JSON.parse(bytes);
    if (!revision.review || revision.id !== revisionId || revision.captureId !== tx.capture.id || revision.sourceHash !== tx.sourceHash || tx.keptCurrent && bytes !== JSON.stringify(tx.keptCurrent, null, 2)) throw Error('Current reviewed revision does not match retained intake history. Files were preserved for repair.');
    return revision;
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
  async detachRestoredBackup(note, sourceHash, capture, ledger) {
    const file = note.file, initial = await fs.lstat(file, { bigint: true }), block = ledger.blocks[sourceHash];
    if (!block || !/^conflict-[a-f0-9-]{36}(?:-[a-f0-9-]{36})?\.json$/.test(block.journal)) return;
    const journal = path.join(this.dir, block.journal);
    await this.ownedFile(journal, [], 'Restored capture conflict journal');
    const journalBytes = await read(journal), tx = JSON.parse(journalBytes); this.validateTransaction(tx);
    const backup = path.join(this.dir, tx.backup), stage = backup + '.independent', intentFile = backup + '.detach.json';
    await this.ownedFile(intentFile, [], 'Restored capture detach intent');
    let intentBytes = await read(intentFile);
    if (initial.nlink === 1n && intentBytes === null) return;
    const valid = block.journal === `conflict-${tx.revision.id}${tx.resolution ? `-${tx.resolution}` : ''}.json` && block.incomingRevision === tx.revision.id && tx.sourceHash === sourceHash && tx.capture.id === capture.id && tx.capture.file === capture.file && note.id === capture.id && note.type === 'reel_import' && this.destination(capture) === file && tx.previous !== null && tx.previousHash === capture.currentHash && note.content === tx.previous;
    if (!valid) { if (intentBytes !== null) throw Error('Invalid restored capture detach authority. All files were preserved.'); return; }
    const bytes = Buffer.from(tx.previous, 'utf8'), same = async target => (await fs.readFile(target)).equals(bytes);
    let intent;
    if (intentBytes === null) {
      const source = await this.ownedFile(file, backup, 'Restored capture destination');
      const previous = await this.ownedFile(backup, file, 'Restored capture backup');
      if (!source || !previous || source.nlink !== 2n || previous.nlink !== 2n || source.dev !== previous.dev || source.ino !== previous.ino) return;
      if (!await same(file) || !await same(backup)) throw conflict('Restored capture bytes changed. All files were preserved.');
      await this.ownedFile(stage, [], 'Independent restored capture backup');
      try { await fs.writeFile(stage, bytes, { flag: 'wx', flush: true }); } catch (error) { if (error.code !== 'EEXIST') throw error; }
      await this.vault.checkpoint('intake-restored-backup-independent');
      const independent = await this.ownedFile(stage, [], 'Independent restored capture backup');
      if (!independent || !await same(stage)) throw conflict('Independent restored capture backup changed. All files were preserved.');
      intent = { schema: 1, id: randomUUID(), sourceHash, captureId: capture.id, file: capture.relative, journal: block.journal, journalHash: hash(journalBytes), backup: tx.backup, previousHash: tx.previousHash, dev: String(source.dev), ino: String(source.ino), stageDev: String(independent.dev), stageIno: String(independent.ino) };
      intentBytes = JSON.stringify(intent);
      await fs.writeFile(intentFile, intentBytes, { flag: 'wx', flush: true });
    } else intent = JSON.parse(intentBytes);
    const uuid = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/;
    if (intent.schema !== 1 || !uuid.test(intent.id) || intent.sourceHash !== sourceHash || intent.captureId !== capture.id || intent.file !== capture.relative || intent.journal !== block.journal || intent.journalHash !== hash(journalBytes) || intent.backup !== tx.backup || intent.previousHash !== tx.previousHash || ![intent.dev, intent.ino, intent.stageDev, intent.stageIno].every(value => typeof value === 'string' && /^[0-9]+$/.test(value))) throw Error('Invalid restored capture detach intent. All files were preserved.');
    const retained = backup + '.detached-' + intent.id;
    const identity = (info, dev, ino) => info && String(info.dev) === dev && String(info.ino) === ino;
    const authority = async () => {
      await this.ownedFile(journal, [], 'Restored capture conflict journal'); await this.ownedFile(intentFile, [], 'Restored capture detach intent');
      if (await read(journal) !== journalBytes || await read(intentFile) !== intentBytes) throw Error('Restored capture detach authority changed. All files were preserved.');
      const current = await this.ownedFile(file, [backup, retained], 'Restored capture destination');
      if (!identity(current, intent.dev, intent.ino) || !await same(file)) throw conflict('Restored capture destination changed. All files were preserved.');
      return current;
    };
    const independent = async () => {
      const info = await this.ownedFile(stage, backup, 'Independent restored capture backup');
      if (!identity(info, intent.stageDev, intent.stageIno) || !await same(stage)) throw conflict('Independent restored capture backup changed. All files were preserved.');
      return info;
    };
    const hold = async () => {
      // Ordinary recreated editor files are source-specific evidence. Unknown
      // aliases, changed authority and storage failures remain global errors.
      await authority(); await independent();
      const evidence = [];
      for (const target of [backup, retained]) {
        const info = await this.ownedFile(target, [file, stage], 'Restored capture backup');
        if (!info) continue;
        if (identity(info, intent.dev, intent.ino)) {
          if (!await same(target)) throw conflict('Restored capture backup bytes changed. All files were preserved.');
          continue;
        }
        if (info.nlink !== 1n) throw conflict('Restored capture backup has an unexpected alias. All files were preserved.');
        evidence.push({ role: 'independent-editor-writing', file: path.basename(target), hash: hash(await fs.readFile(target)) });
      }
      if (!evidence.length) throw conflict('Restored capture backup disappeared. All remaining files were preserved.');
      evidence.push({ role: 'original-source-copy', file: path.basename(stage), hash: tx.previousHash });
      const archive = intentFile + '.held-' + intent.id;
      const archivedBytes = JSON.stringify({ schema: 1, intentBytes, evidence });
      await this.ownedFile(archive, [], 'Restored capture detach hold');
      try { await fs.writeFile(archive, archivedBytes, { flag: 'wx', flush: true }); } catch (error) { if (error.code !== 'EEXIST') throw error; }
      if (await read(archive) !== archivedBytes) throw Error('Restored capture detach hold conflicts. All files were preserved.');
      const reason = 'Restored capture backup changed. Independent editor writing was preserved; this source remains paused for explicit conflict repair.';
      block.detachHold = { journal: path.basename(archive), reason, evidence };
      block.reason = reason; capture.conflict = reason;
      if (ledger.outcomes[tx.key]) ledger.outcomes[tx.key].reason = reason;
      await this.save(ledger);
      await authority(); await independent();
      for (const item of evidence) {
        const target = path.join(this.dir, item.file); await this.ownedFile(target, [], 'Restored capture held evidence');
        if (hash(await fs.readFile(target)) !== item.hash) throw Error('Restored capture held evidence changed. All files were preserved.');
      }
      const peer = await this.ownedFile(retained, file, 'Restored capture retained peer');
      if (identity(peer, intent.dev, intent.ino)) {
        if (!await same(retained)) throw conflict('Restored capture retained peer changed. All files were preserved.');
        await authority(); await fs.unlink(retained);
      }
      await this.ownedFile(file, [], 'Restored capture destination');
      await authority(); await this.ownedFile(archive, [], 'Restored capture detach hold');
      if (await read(archive) !== archivedBytes) throw Error('Restored capture detach hold changed. All files were preserved.');
      await fs.unlink(intentFile);
      this.vault.warnings.push(reason);
    };
    await authority();
    let peer = await this.ownedFile(retained, file, 'Restored capture retained peer');
    let previous = await this.ownedFile(backup, [file, stage], 'Restored capture backup');
    if (!peer && identity(previous, intent.dev, intent.ino)) {
      await independent(); await authority();
      await this.vault.checkpoint('intake-restored-backup-publish');
      // Move the current path aside before inspecting it. An editor recreation
      // is retained, never replaced by the independent publication.
      if (await this.ownedFile(retained, file, 'Restored capture retained peer')) throw conflict('Restored capture retained path already exists. All files were preserved.');
      await fs.rename(backup, retained);
      await this.vault.checkpoint('intake-restored-backup-moved');
      peer = await this.ownedFile(retained, file, 'Restored capture retained peer'); previous = await this.ownedFile(backup, [file, stage], 'Restored capture backup');
    }
    if (peer && !identity(peer, intent.dev, intent.ino) || previous && !identity(previous, intent.stageDev, intent.stageIno)) return hold();
    if (peer && !await same(retained)) throw conflict('Restored capture retained peer changed. All files were preserved.');
    if (!previous) {
      if (!peer) throw conflict('Restored capture backup disappeared. All remaining files were preserved.');
      await authority(); await independent();
      try { await fs.link(stage, backup); } catch (error) { if (error.code !== 'EEXIST') throw error; }
      previous = await this.ownedFile(backup, stage, 'Independent restored capture backup');
      if (!identity(previous, intent.stageDev, intent.stageIno)) return hold();
      await this.vault.checkpoint('intake-restored-backup-published');
    }
    if (!await same(backup)) throw conflict('Independent restored capture backup changed. All files were preserved.');
    await authority();
    const staged = await this.ownedFile(stage, backup, 'Independent restored capture backup');
    if (staged) { await independent(); await fs.unlink(stage); }
    await this.ownedFile(backup, [], 'Independent restored capture backup');
    peer = await this.ownedFile(retained, file, 'Restored capture retained peer');
    if (peer) {
      if (!identity(peer, intent.dev, intent.ino) || !await same(retained)) throw conflict('Restored capture retained peer changed. All files were preserved.');
      await authority(); await fs.unlink(retained);
    }
    await this.ownedFile(file, [], 'Restored capture destination');
    await this.vault.checkpoint('intake-restored-backup-cleaned');
    await authority(); await this.ownedFile(backup, [], 'Independent restored capture backup');
    if (!await same(backup)) throw conflict('Independent restored capture backup changed. All files were preserved.');
    await fs.unlink(intentFile);
  }
  async publicationAuthority(tx, ledger, { verifyOnly = false, verifyRestorationControls, verifyIndependentJournal } = {}) {
    if (!this.storage.matches(await this.storage.view())) throw Error('Intake ledger changed before publication. Refresh before retrying; changed authority was preserved.');
    assertPublication(ledger, tx.capture.id, tx);
    if (ledger.sourceAuthority?.[tx.capture.id]?.phase === 'restoring') await require('./capture-deletion').guardRestorationParents(this, ledger.sourceAuthority[tx.capture.id]);
    if (!verifyOnly || tx.restoreOperation) {
      verifyRestorationControls?.();
      this.verifyReservedCaptureIdentity(ledger, tx.capture.id, verifyIndependentJournal);
    }
  }
  verifyReservedCaptureIdentity(ledger, id, verifyIndependentJournal) {
    const reserved = this.vault.reservedRestorationIdentities(ledger, { verifyIndependentJournal });
    if (reserved.captures.has(id)) {
      throw Object.assign(Error('A preserved file at a held restoration path claims this capture identity. Both files were preserved.'),
        { intakeReservedIdentity: true });
    }
    if (verifyIndependentJournal) reserved.verify();
  }
  isIndependentNewSource(tx, ledger) {
    return tx.previousHash === null && !tx.restore && !tx.restoreOperation && !tx.sourceGeneration &&
      !tx.resolution && !tx.retainOnly && !ledger.captures[tx.sourceHash] &&
      !ledger.attempts[tx.revision.identity] && !ledger.suppressed.includes(tx.sourceHash) &&
      !ledger.blocks[tx.sourceHash] && !ledger.pending[tx.sourceHash] &&
      !Object.values(ledger.captures).some(capture => capture.id === tx.capture.id);
  }
  publishedRestorationControlGuard(ledger) {
    const authorities = publishedImportedRestorations(ledger);
    if (!authorities.length) return () => {};
    const { verifyPublishedRestorationControls } = require('./capture-deletion');
    return () => {
      for (const authority of authorities) verifyPublishedRestorationControls(this, authority);
    };
  }
  ordinaryPublicationControls(tx, ledger, expectedJournal) {
    const restorations = publishedImportedRestorations(ledger);
    if (!restorations.length || tx.restoreOperation) return undefined;
    const { verifyImportedRestorationHold } = require('./capture-deletion');
    const guarded = work => {
      try { return work(); }
      catch (error) {
        const failure = error instanceof Error ? error : Error('Shared restoration or intake journal proof failed.', { cause: error });
        sharedRestorationFailures.add(failure);
        throw failure;
      }
    };
    const journal = guarded(() => {
      const observed = this.ordinaryRecoveryJournal(ledger, tx);
      if (!observed || expectedJournal && (!sameProofIdentity(observed, expectedJournal) || observed.digest !== expectedJournal.digest)) {
        throw Error('The exact active intake journal changed. Shared restoration controls were preserved.');
      }
      return observed;
    });
    return () => guarded(() => {
      for (const authority of restorations) verifyImportedRestorationHold(this, authority, journal.verify);
    });
  }
  async finish(tx, ledger, journalProof, transfer) {
    const publication = {};
    try { return await this.publishTransaction(tx, ledger, journalProof, publication, transfer); }
    catch (error) {
      if (!publication.committed && publication.transferFailure === error) {
        if (transfer?.previous) throw Object.assign(Error(error.message, { cause: error }), { intakeTransferFailed: true });
        try { publication.restoreTransfer?.(); }
        catch (cause) { this.vault.warnings.push(`Prior capture recovery files were preserved: ${cause.message}`); }
        throw error;
      }
      if (error.intakeConflict && publication.rollback && !publication.committed && !tx.restoreOperation) {
        error.intakeConflictProof = { mode: precommitConflict, journalProof: publication.journalProof, rollback: publication.rollback };
      }
      if (!error.intakeReservedIdentity || publication.committed || acceptedCleanupFailures.has(error) || tx.restoreOperation || !journalProof) throw error;
      const reason = `${outputHold} ${error.message}`, guard = this.vault.publicationFolders(this.dir).guard;
      this.storage.guardSync();
      await this.archiveConflict(tx, ledger, reason, { journalProof, guard, committed: false });
      throw Object.assign(Error(reason, { cause: error }), { intakeOutputHeld: true });
    }
  }
  restoreOrdinaryTransfer(tx, previous, output, verifyAuthority) {
    if (!previous) return;
    const destination = this.destination(tx.capture), backup = path.join(this.dir, tx.backup);
    const stage = path.join(this.dir, `${tx.revision.id}.stage`);
    const parents = [...requiredDirectories(this, [{ file: path.relative(this.vault.vault, destination) }])]
      .map(directory => path.join(this.vault.vault, directory));
    const { guard } = ordinaryDirectories(parents, 'A transfer recovery folder changed. All files were preserved.');
    verifyAuthority();
    guard();
    const current = local.lstatSync(destination, { bigint: true, throwIfNoEntry: false });
    if (current && String(current.dev) === previous.dev && String(current.ino) === previous.ino) {
      const paired = current.nlink === 2n;
      verifyStageSync(destination, guard, previous, paired ? 2 : 1);
      if (paired) {
        verifyStageSync(backup, guard, previous, 2);
        local.unlinkSync(backup);
        verifyStageSync(destination, guard, previous);
      }
      return;
    }
    verifyStageSync(backup, guard, previous);
    if (current) {
      if (!output) throw Error('The incoming capture has no exact output proof. All files were preserved.');
      verifyStageSync(stage, guard, output, 2);
      verifyStageSync(destination, guard, output, 2);
      local.unlinkSync(destination);
      verifyStageSync(stage, guard, output);
    }
    verifyAbsentSync(destination, guard);
    local.linkSync(backup, destination);
    verifyStageSync(backup, guard, previous, 2);
    verifyStageSync(destination, guard, previous, 2);
    local.unlinkSync(backup);
    verifyStageSync(destination, guard, previous);
  }
  async publishTransaction(tx, ledger, journalProof, publication, transfer) {
    this.validateTransaction(tx);
    const verifyRestorationControls = this.ordinaryPublicationControls(tx, ledger, journalProof);
    const verifyIndependentJournal = validProof(journalProof) && this.isIndependentNewSource(tx, ledger) ? verifyRestorationControls : undefined;
    const verifyTransfer = () => {
      try { transfer?.verify(); }
      catch (error) { publication.transferFailure = error; throw error; }
    };
    const checkPublication = async () => {
      await this.publicationAuthority(tx, ledger, { verifyRestorationControls, verifyIndependentJournal });
      verifyTransfer();
    };
    await checkPublication();
    if (tx.keptCurrent) await this.verifiedKeptCurrent(tx, ledger);
    await this.vault.contained(path.dirname(this.destination(tx.capture)));
    const destination = this.destination(tx.capture), snapshot = path.join(this.vault.root, 'Revisions', `${tx.revision.id}.json`), backup = path.join(this.dir, tx.backup), stage = path.join(this.dir, `${tx.revision.id}.stage`), snapshotStage = path.join(this.dir, `${tx.revision.id}.snapshot.stage`), snapshotBytes = JSON.stringify(tx.revision, null, 2);
    const parents = [...requiredDirectories(this, [{ file: path.relative(this.vault.vault, destination) }])]
      .map(directory => path.join(this.vault.vault, directory));
    const { guard, identities: directories } = ordinaryDirectories(parents, 'An intake publication folder changed or is an alias. All files were preserved.');
    const exact = (file, info, content, label, peers = []) => {
      const changed = () => conflict(`${label} changed. Independent files and the incoming revision were preserved.`);
      if (!info) throw changed();
      const proof = { dev: String(info.dev), ino: String(info.ino), digest: hash(content) };
      try {
        verifyStageSync(file, guard, proof, Number(info.nlink));
        if (info.nlink === 2n) {
          const peer = peers.find(candidate => {
            try {
              const stat = local.lstatSync(candidate, { bigint: true });
              return stat.dev === info.dev && stat.ino === info.ino;
            } catch (error) { if (error.code === 'ENOENT') return false; throw error; }
          });
          if (!peer) throw changed();
          verifyStageSync(peer, guard, proof, 2);
        }
      } catch (error) {
        if (error.code === 'STAGING_CHANGED') throw changed();
        throw error;
      }
    };
    // Keep exact existing peers before successful admission clears pending state.
    const journal = path.join(this.dir, 'transaction.json'), journalBytes = JSON.stringify(tx);
    const journalPeers = [];
    if (tx.restoreOperation) journalPeers.push(path.join(this.dir, `restoration-${tx.restoreOperation}.json`));
    for (const item of [ledger.pending[tx.sourceHash], ledger.blocks[tx.sourceHash]]) if (item?.journal && /^(?:pending|conflict)-[a-f0-9-]{36}(?:-[a-f0-9-]{36})?\.json$/.test(item.journal)) journalPeers.push(path.join(this.dir, item.journal));
    const journalInfo = await this.ownedFile(journal, journalPeers, 'Intake transaction');
    exact(journal, journalInfo, journalBytes, 'Intake transaction', journalPeers);
    if (journalProof) verifyStageSync(journal, guard, journalProof, Number(journalInfo.nlink));
    publication.journalProof = journalProof || fileProof(journalInfo, journalBytes);
    const verifySelectedJournal = () => {
      if (!tx.restoreOperation) return;
      if (!journalProof) throw Error('Selected restoration journal identity is unavailable. Suppression remains.');
      verifyStageSync(journal, guard, journalProof, 2);
      verifyStageSync(journalPeers[0], guard, journalProof, 2);
    };
    verifySelectedJournal();
    const immutable = async (file, content) => {
      try { await fs.writeFile(file, content, { flag: 'wx', flush: true }); } catch (error) { if (error.code !== 'EEXIST' || await read(file) !== content) throw Error('Immutable import file conflicts. Preserve the vault for repair.'); }
    };
    const staged = async (file, content, peer) => {
      await checkPublication();
      const info = await this.ownedFile(file, peer, 'Unsafe import staging file');
      const existing = await read(file);
      verifySelectedJournal();
      if (existing !== null && existing !== content) {
        if (info.nlink !== 1n) throw conflict('Unsafe import staging file: a linked publication changed. Both versions were preserved.');
        await fs.rename(file, `${file}.damaged-${randomUUID()}`);
      }
      verifySelectedJournal();
      await immutable(file, content);
      return this.ownedFile(file, peer, 'Unsafe import staging file');
    };
    const snapshotProof = await staged(snapshotStage, snapshotBytes, snapshot);
    await this.vault.checkpoint('intake-snapshot-staged');
    await checkPublication();
    if (!await this.ownedFile(snapshotStage, snapshot, 'Unsafe import staging file')) throw conflict('Unsafe import staging file disappeared. Its incoming revision was preserved.');
    await this.ownedFile(snapshot, snapshotStage, 'Immutable revision snapshot');
    this.storage.guardSync();
    verifySelectedJournal();
    exact(snapshotStage, snapshotProof, snapshotBytes, 'Revision snapshot stage', [snapshot]);
    let snapshotOutput;
    try {
      local.linkSync(snapshotStage, snapshot);
      snapshotOutput = publicationIdentity(snapshotProof, 2n);
    } catch (error) {
      let existing;
      try { existing = await fs.lstat(snapshot); } catch { throw error; }
      if (!existing.isFile() || existing.isSymbolicLink()) throw conflict('Immutable revision snapshot destination is not an ordinary file. The destination and incoming stage were preserved.');
      snapshotOutput = await this.ownedFile(snapshot, snapshotStage, 'Immutable revision snapshot');
      let bytes; try { bytes = await read(snapshot); } catch { throw conflict('Immutable revision snapshot destination is unreadable. The destination and incoming stage were preserved.'); }
      if (bytes !== snapshotBytes) throw conflict('Immutable revision snapshot conflicts. Existing and incoming bytes were preserved.');
    }
    await this.ownedFile(snapshot, snapshotStage, 'Immutable revision snapshot');
    if (await read(snapshot) !== snapshotBytes) throw conflict('Immutable revision snapshot changed during publication. All versions were preserved.');
    await this.vault.checkpoint('intake-snapshot');
    const currentProof = await this.ownedFile(destination, [stage, backup], 'Capture destination');
    const backupInfo = await this.ownedFile(backup, destination, 'Previous capture backup');
    let captureOutput = currentProof, captureStageProof;
    let current = await read(destination), old = await read(backup);
    if (transfer) publication.restoreTransfer = () => this.restoreOrdinaryTransfer(tx,
      transfer.previous || publication.rollback?.proof, transfer.output?.(), () => {
        this.storage.guardSync();
        verifyRestorationControls?.();
        exact(journal, journalInfo, journalBytes, 'Intake transaction', journalPeers);
      });
    const pairedBackup = transfer?.previous && backupInfo?.nlink === 2n && current === tx.previous;
    if (transfer?.previous && old !== null && !pairedBackup) verifyStageSync(backup, guard, transfer.previous);
    if (current !== tx.content) {
      if (tx.previousHash !== null) {
        if (old === null || pairedBackup) {
          if (current === null || hash(current) !== tx.previousHash) throw conflict('Destination changed outside Companion. Both source revision and local writing were preserved.');
          try {
            await this.vault.checkpoint('intake-before-move');
            await checkPublication();
            this.storage.guardSync();
            const occupied = () => conflict('Previous capture backup appeared during publication. Both files were preserved.');
            if (transfer?.previous) {
              exact(destination, captureOutput, tx.previous, 'Capture destination', pairedBackup ? [backup] : []);
              const previous = transfer.previous;
              if (!pairedBackup) {
                verifyStageSync(destination, guard, previous);
                verifyAbsentSync(backup, guard, occupied);
                try { local.linkSync(destination, backup); }
                catch (error) { if (error.code === 'EEXIST') throw occupied(); throw error; }
              }
              verifyStageSync(backup, guard, previous, 2);
              verifyStageSync(destination, guard, previous, 2);
              local.unlinkSync(destination);
              verifyStageSync(backup, guard, previous);
              verifyAbsentSync(destination, guard);
            } else {
              verifyAbsentSync(backup, guard, occupied);
              exact(destination, captureOutput, tx.previous, 'Capture destination');
              local.renameSync(destination, backup);
              publication.rollback = { proof: fileProof(captureOutput, tx.previous), directories };
            }
          }
          catch (error) { if (['EACCES', 'EPERM', 'EBUSY'].includes(error.code)) throw deferred('Capture destination is locked or inaccessible. Existing content and incoming revision were preserved. Fix file access, then Check now to retry.'); throw error; }
          await this.vault.checkpoint('intake-moved'); old = await read(backup); current = await read(destination);
        }
        if (old === null || hash(old) !== tx.previousHash) throw conflict('External edit conflict. Previous and current files were preserved.');
      }
      if (current !== null) throw conflict('Destination changed outside Companion. The new destination was preserved.');
      if (transfer?.recordOutput) {
        try {
          let recorded = transfer.output();
          if (!recorded) {
            recorded = await writeStage(stage, tx.content, guard);
            await transfer.recordOutput(recorded, () => verifyStageSync(stage, guard, recorded));
          }
          verifyStageSync(stage, guard, recorded);
          captureStageProof = await this.ownedFile(stage, destination, 'Ordinary transfer capture stage');
        } catch (error) {
          publication.transferFailure = error;
          throw error;
        }
      } else captureStageProof = await staged(stage, tx.content, destination);
      await this.vault.checkpoint('intake-capture-staged');
      await checkPublication();
      if (!await this.ownedFile(stage, destination, 'Unsafe import staging file')) throw conflict('Unsafe import staging file disappeared. Its incoming revision was preserved.');
      this.storage.guardSync();
      verifySelectedJournal();
      exact(stage, captureStageProof, tx.content, 'Imported capture stage', [destination]);
      if (transfer?.recordOutput) verifyStageSync(stage, guard, transfer.output());
      try {
        local.linkSync(stage, destination);
        captureOutput = publicationIdentity(captureStageProof, 2n);
      } catch (error) {
        if (error.code !== 'EEXIST') throw error;
        captureOutput = await this.ownedFile(destination, [stage, backup], 'Capture destination');
        if (await read(destination) !== tx.content) throw conflict('External edit conflict. The new destination was preserved.');
      }
    }
    const outputs = [
      { file: snapshot, info: snapshotOutput, content: snapshotBytes, label: 'Immutable revision snapshot', peers: [snapshotStage] },
      { file: destination, info: captureOutput, content: tx.content, label: 'Imported capture', peers: [stage, backup] }
    ];
    if (transfer?.recordOutput) {
      const output = transfer.output();
      if (!output) throw Error('The ordinary transfer has no recorded capture output. Recovery files were preserved.');
      verifyStageSync(stage, guard, output, 2);
      verifyStageSync(destination, guard, output, 2);
    }
    if (!tx.retainOnly && tx.previousHash !== null) {
      outputs.push({ file: backup, info: await this.ownedFile(backup, destination, 'Previous capture backup'), content: tx.previous, label: 'Previous capture backup', peers: [destination] });
    }
    const cleanup = [];
    const rememberStage = async (file, initial, content, peer) => {
      const info = await this.ownedFile(file, peer, 'Intake publication stage');
      if (initial && !exactIdentity(initial, info)) throw conflict('Intake publication stage identity changed. All files were preserved.');
      if (info) cleanup.push({ file, info, content, label: 'Intake publication stage', peers: [peer] });
    };
    await rememberStage(stage, captureStageProof, tx.content, destination);
    await rememberStage(snapshotStage, snapshotProof, snapshotBytes, snapshot);
    cleanup.push({ file: journal, info: journalInfo, content: journalBytes, label: 'Intake transaction', peers: journalPeers });
    const verify = item => exact(item.file, item.info, item.content, item.label, item.peers);
    let committed = false;
    const verifyPublished = () => {
      if (!committed) verifyTransfer();
      if (!committed && journalProof?.freshRepair) journalProof.verify();
      if (!committed || tx.restoreOperation) {
        verifyRestorationControls?.();
        verifySelectedJournal();
        this.verifyReservedCaptureIdentity(ledger, tx.capture.id, verifyIndependentJournal);
      }
      try {
        for (const item of [...outputs, ...cleanup]) verify(item);
      } catch (cause) {
        if (!cause.intakeConflict && !['ENOENT', 'EACCES', 'EPERM', 'EBUSY'].includes(cause.code)) throw cause;
        throw Object.assign(Error(`${outputHold} ${cause.message}`, { cause }), { intakeOutputChanged: true });
      }
    };
    try {
      await this.vault.checkpoint('intake-published');
      await checkPublication();
      verifyPublished();
      const next = {
        captures: { ...ledger.captures, [tx.sourceHash]: structuredClone(tx.capture) },
        outcomes: { ...ledger.outcomes }, attempts: { ...ledger.attempts }, pending: { ...ledger.pending },
        ...(ledger.admissions || tx.sourceGeneration ? { admissions: { ...ledger.admissions } } : {})
      };
      if (journalProof?.freshRepair || transfer) {
        next.blocks = { ...ledger.blocks };
        delete next.blocks[tx.sourceHash];
      }
      const outcome = acceptedOutcome(tx, snapshotBytes);
      const accepted = ledger.attempts[tx.revision.identity];
      if (accepted && (accepted.fingerprint !== outcome.fingerprint || accepted.captureId !== outcome.captureId || accepted.sourceHash !== outcome.sourceHash)) throw Error('Producer acceptance facts changed. All files were preserved.');
      next.outcomes[tx.key] = outcome;
      next.attempts[tx.revision.identity] ||= outcome;
      if (tx.sourceGeneration) {
        const existing = next.admissions[tx.revision.id];
        if (existing && JSON.stringify(existing) !== JSON.stringify(outcome)) throw Error('Revision admission changed.');
        next.admissions[tx.revision.id] = outcome;
      }
      const pending = next.pending[tx.sourceHash];
      const proofAt = file => {
        const item = [...outputs, ...cleanup].find(candidate => candidate.file === file);
        return item ? fileProof(item.info, item.content) : null;
      };
      if (tx.restoreOperation) {
        next.sourceAuthority = require('./capture-deletion').recordRestorationAdmission(ledger, tx, {
          capture: proofAt(destination), snapshot: proofAt(snapshot), journal: proofAt(journal)
        });
      } else {
        if (Object.hasOwn(ledger, 'acceptedCleanup') || journalInfo.nlink !== (pending ? 2n : 1n) ||
            pending && (pending.journal !== pendingName(tx) || pending.key !== tx.key || pending.acceptedCleanup !== undefined)) {
          throw Error('Intake journal authority changed. All files were preserved.');
        }
        next.acceptedCleanup = {
          sourceHash: tx.sourceHash, key: tx.key, revision: tx.revision.id, resolution: tx.resolution || null, pending: pending?.journal || null,
          journal: fileProof(journalInfo, journalBytes), capture: proofAt(destination), snapshot: proofAt(snapshot),
          captureStage: proofAt(stage), snapshotStage: proofAt(snapshotStage), backup: proofAt(backup), directories
        };
      }
      await this.save({ ...ledger, ...next }, verifyPublished);
      Object.assign(ledger, next);
      committed = true;
      publication.committed = true;
      if (tx.restoreOperation) verifyPublished();
      await this.vault.checkpoint('intake-ledger');
      // An accepted ordinary transaction can only settle its exact owned
      // outputs and journal. Later identity claims cannot undo its admission.
      await this.publicationAuthority(tx, ledger, { verifyOnly: true });
      if (tx.restoreOperation) return;
      return await this.acknowledgeAccepted(ledger);
    } catch (error) {
      if (committed && !tx.restoreOperation && !error?.intakeOutputHeld) {
        // The durable receipt owns the remaining work. Preserve the exact
        // accepted outcome when journal or ledger authority cannot be proved.
        const failure = error instanceof Error ? error : Error('Accepted intake cleanup was interrupted.', { cause: error });
        acceptedCleanupFailures.add(failure);
        throw failure;
      }
      if (error.intakeReservedIdentity && !tx.restoreOperation) {
        error = Object.assign(Error(`${outputHold} ${error.message}`, { cause: error }), { intakeOutputChanged: true });
      }
      if (!error.intakeOutputChanged || tx.restoreOperation || !cleanup.some(item => item.file === journal)) throw error;
      const reason = error.message + (committed ? acceptancePreserved : '');
      await this.archiveConflict(tx, ledger, reason, { journalInfo, guard, committed });
      throw Object.assign(Error(reason, { cause: error }), { intakeOutputHeld: true });
    }
  }
  async acknowledgeAccepted(ledger, legacySource) {
    const top = Object.hasOwn(ledger, 'acceptedCleanup');
    const receipt = top ? ledger.acceptedCleanup : ledger.pending[legacySource]?.acceptedCleanup;
    const sourceHash = top ? receipt?.sourceHash : legacySource, pending = ledger.pending[sourceHash];
    const changed = () => Error('Accepted intake files or their exact journal peers changed. All files were preserved.');
    const names = ['journal', 'capture', 'snapshot', 'captureStage', 'snapshotStage', 'backup'];
    const allowed = [...names, 'directories', 'retiring'];
    if (top) allowed.push('sourceHash', 'key', 'revision', 'resolution', 'pending');
    const match = /^pending-([a-f0-9-]{36})(?:-([a-f0-9-]{36}))?\.json$/.exec(pending?.journal);
    const key = top ? receipt?.key : pending?.key, revision = top ? receipt?.revision : match?.[1];
    const resolution = top ? receipt?.resolution : (match?.[2] || null);
    const alias = top ? receipt?.pending : pending?.journal;
    const outcome = ledger.outcomes[key], capture = ledger.captures[sourceHash];
    if (!receipt || Object.keys(receipt).some(name => !allowed.includes(name)) || !/^[a-f0-9]{64}$/.test(sourceHash) ||
        typeof key !== 'string' || !key || !uuid(revision) || resolution !== null && !uuid(resolution) ||
        (alias !== null && alias !== `pending-${revision}${resolution ? `-${resolution}` : ''}.json`) ||
        (alias ? pending?.journal !== alias || pending.key !== key : pending !== undefined) ||
        !names.every((name, index) => (index >= 3 && receipt[name] === null) || validProof(receipt[name])) ||
        (top || receipt.directories !== undefined) && !Array.isArray(receipt.directories) ||
        receipt.retiring !== undefined && receipt.retiring !== true ||
        !capture || !outcome || outcome.status !== 'imported' || outcome.captureId !== capture.id || outcome.sourceHash !== sourceHash || outcome.revision !== revision ||
        receipt.capture.digest !== capture.currentHash || receipt.snapshot.digest !== outcome.snapshotHash ||
        receipt.captureStage && receipt.captureStage.digest !== receipt.capture.digest ||
        receipt.snapshotStage && receipt.snapshotStage.digest !== receipt.snapshot.digest ||
        revisionAdmission(ledger, revision)?.snapshotHash !== outcome.snapshotHash) throw changed();
    const destination = this.destination(capture);
    const parents = [...requiredDirectories(this, [{ file: path.relative(this.vault.vault, destination) }])]
      .map(directory => path.join(this.vault.vault, directory));
    const { guard, identities: directories } = ordinaryDirectories(parents, changed().message, receipt.directories);
    const removable = (file, proof) => {
      guard();
      return { file, proof, present: !!local.lstatSync(file, { throwIfNoEntry: false }) };
    };
    const journals = [removable(path.join(this.dir, 'transaction.json'), receipt.journal)];
    if (alias) journals.push(removable(path.join(this.dir, alias), receipt.journal));
    if (top && !receipt.retiring && journals.some(item => !item.present)) throw changed();
    const verify = (files, mismatch) => {
      for (const item of files) {
        if (!item.present) { verifyAbsentSync(item.file, guard, mismatch); continue; }
        if (!item.proof) throw mismatch();
        const links = files.filter(peer => peer.present && peer.proof && sameProofIdentity(peer.proof, item.proof)).length;
        verifyStageSync(item.file, guard, item.proof, links);
      }
    };
    const verifyJournals = () => {
      this.storage.guardSync();
      verify(journals, changed);
    };
    const verifyTransaction = () => {
      verifyJournals();
      const original = journals.find(item => item.present);
      if (!original) return null;
      const { bytes } = verifyStageSync(original.file, guard, receipt.journal, journals.filter(item => item.present).length);
      const tx = JSON.parse(bytes.toString('utf8'));
      this.validateTransaction(tx);
      if (tx.sourceHash !== sourceHash || tx.key !== key || tx.revision.id !== revision || (tx.resolution || null) !== resolution ||
          tx.capture.id !== capture.id || this.destination(tx.capture) !== destination || tx.restoreOperation ||
          tx.capture.currentRevision !== capture.currentRevision || tx.capture.currentHash !== receipt.capture.digest ||
          hash(JSON.stringify(tx.revision, null, 2)) !== receipt.snapshot.digest ||
          receipt.backup && receipt.backup.digest !== tx.previousHash) throw changed();
      assertPublication(ledger, tx.capture.id, tx);
      return { original, tx };
    };
    const retire = (items, verifyOwned) => {
      verifyOwned();
      for (const item of items) if (item.present) {
        local.unlinkSync(item.file);
        item.present = false;
        verifyOwned();
      }
    };
    const transaction = verifyTransaction();
    if (!receipt.retiring) {
      const output = (file, proof) => ({ file, proof, present: true });
      const outputs = [
        output(destination, receipt.capture),
        output(path.join(this.vault.root, 'Revisions', revision + '.json'), receipt.snapshot)
      ];
      if (receipt.backup) outputs.push(output(path.join(this.dir, `${capture.id}-${revision}.before${resolution ? `-${resolution}` : ''}.md`), receipt.backup));
      const stages = [
        removable(path.join(this.dir, revision + '.stage'), receipt.captureStage),
        removable(path.join(this.dir, revision + '.snapshot.stage'), receipt.snapshotStage)
      ];
      const published = [...outputs, ...stages], files = [...published, ...journals];
      if (new Set(files.map(item => process.platform === 'win32' ? item.file.toLowerCase() : item.file)).size !== files.length) throw changed();
      const outputChanged = () => Object.assign(changed(), { code: 'STAGING_CHANGED' });
      const verifyPublished = () => {
        verifyJournals();
        try { verify(published, outputChanged); }
        catch (cause) {
          verifyJournals();
          if (cause.code !== 'STAGING_CHANGED' && !fileAccessRefused(cause)) throw cause;
          const held = Object.assign(Error(`${outputHold} ${cause.message}${acceptancePreserved}`, { cause }), { intakeOutputChanged: true });
          if (transaction && fileAccessRefused(cause) && typeof cause.path === 'string' && samePath(cause.path, destination)) {
            const links = published.filter(item => item.present && item.proof && sameProofIdentity(item.proof, receipt.capture)).length;
            const proof = { ...receipt.capture, links, directories };
            const peers = this.captureAccessPeers(transaction.tx);
            if (validCaptureAccess(proof) && matchesCaptureAccess(destination, peers, proof, guard)) held.captureAccess = proof;
          }
          throw held;
        }
      };
      const retired = { ...receipt, retiring: true };
      const next = top ? { acceptedCleanup: retired } : { pending: { ...ledger.pending, [sourceHash]: { ...pending, acceptedCleanup: retired } } };
      try {
        retire(stages, verifyPublished);
        // Retain the exact journal until the ledger records that publication
        // cleanup is complete. Later edits cannot block journal retirement.
        await this.save({ ...ledger, ...next }, verifyPublished);
        Object.assign(ledger, next);
      } catch (error) {
        if (!error.intakeOutputChanged || !transaction) throw error;
        verifyJournals();
        const { original, tx } = transaction;
        const [active] = journals;
        if (!active.present) {
          // An older interrupted cleanup may retain only the pending alias.
          // Keep an exact active name for restart of the hold transition.
          verifyJournals();
          local.linkSync(original.file, active.file);
          active.present = true;
          verifyJournals();
        }
        await this.archiveConflict(tx, ledger, error.message, {
          journalProof: receipt.journal, guard, committed: true, captureAccess: error.captureAccess, ...(top ? { acceptedCleanup: receipt } : {})
        });
        throw Object.assign(Error(error.message, { cause: error }), { intakeOutputHeld: true });
      }
    }
    retire(journals, verifyJournals);
    const next = { ...ledger, pending: { ...ledger.pending } };
    delete next.pending[sourceHash];
    delete next.acceptedCleanup;
    await this.save(next, verifyJournals);
    ledger.pending = next.pending;
    delete ledger.acceptedCleanup;
    verifyJournals();
    this.vault.expected.set(capture.id, capture.currentHash);
  }
  async recover() {
    let controlled = await this.load();
    await pendingParents(this, controlled);
    const { finishDeletion, finishRestoration, finishRestorationCleanup, isImportedRestorationHold,
      verifyImportedRestorationHold, verifyPublishedRestorationControls } = require('./capture-deletion');
    const publishedRestorations = publishedImportedRestorations(controlled);
    if (publishedRestorations.length) {
      this.storage.guardSync();
      for (const authority of publishedRestorations) verifyPublishedRestorationControls(this, authority);
    }
    if (Object.hasOwn(controlled, 'acceptedCleanup') || Object.values(controlled.pending).some(item => item?.acceptedCleanup !== undefined)) {
      const expected = this.storage.expected;
      const accepted = await this.load();
      if (!this.storage.matches(this.storage.expected, expected)) throw Error('Intake ledger changed before accepted cleanup. All files were preserved.');
      const legacy = Object.entries(accepted.pending).filter(([, item]) => item?.acceptedCleanup !== undefined);
      const top = Object.hasOwn(accepted, 'acceptedCleanup');
      if (legacy.length + Number(top) > 1) throw Error('Accepted intake authority is ambiguous. All files were preserved.');
      try { await this.acknowledgeAccepted(accepted, legacy[0]?.[0]); }
      catch (error) { if (!error.intakeOutputHeld) throw error; }
      controlled = await this.load();
      await pendingParents(this, controlled);
    }
    this.vault.warnings = this.vault.warnings.filter(warning => !warning.startsWith('Source restoration held:'));
    const recoverRestoration = async (ledger, id, work) => {
      try { await work(this, ledger, id); }
      catch (error) {
        const authority = ledger.sourceAuthority[id], imported = isImportedRestorationHold(error, id, authority);
        if (!imported && !isManualHold(error, id, authority)) throw error;
        await pendingParents(this, ledger);
        if (!this.storage.matches(await this.storage.view())) throw Error('Intake ledger changed during source recovery. Refresh before retrying.');
        if (imported) verifyImportedRestorationHold(this, authority);
        this.vault.warnings.push(`Source restoration held: ${id}. ${error.message}`);
      }
    };
    const delayed = [];
    let ordinaryJournal;
    const finishLaterPhase = async (id, work) => {
      const candidate = this.independentRecoveryJournal(controlled, id);
      if (!candidate) return recoverRestoration(controlled, id, work);
      if (ordinaryJournal && (!sameProofIdentity(candidate, ordinaryJournal) || candidate.digest !== ordinaryJournal.digest)) {
        throw Error('The independent intake journal changed. Recovery files were preserved.');
      }
      ordinaryJournal = candidate;
      delayed.push({ id, work });
    };
    for (const [id, authority] of Object.entries(controlled.sourceAuthority || {})) {
      if (authority.restorationCleanup) await finishLaterPhase(id, finishRestorationCleanup);
    }
    for (const [id, authority] of Object.entries(controlled.sourceAuthority || {})) {
      if (authority.phase === 'deleting') await finishDeletion(this, controlled, id);
    }
    for (const [id, authority] of Object.entries(controlled.sourceAuthority || {})) {
      if (authority.phase !== 'restoring') continue;
      if (!authority.manual && authority.restoration.published && authority.restoration.importedPublication) {
        await finishLaterPhase(id, finishRestoration);
      } else await recoverRestoration(controlled, id, finishRestoration);
    }
    if (ordinaryJournal) {
      const verifyShared = ordinaryJournal.verify;
      ordinaryJournal = {
        ...ordinaryJournal,
        verify: () => {
          verifyShared();
          for (const { id } of delayed) {
            const authority = controlled.sourceAuthority[id];
            if (authority.phase === 'restoring') verifyImportedRestorationHold(this, authority, verifyShared);
          }
        }
      };
    }
    await this.recoverOrdinaryIntake(ordinaryJournal);
    if (delayed.length) {
      const ledger = await this.load();
      await pendingParents(this, ledger);
      this.storage.guardSync();
      verifyAbsentSync(path.join(this.dir, 'transaction.json'), this.vault.publicationFolders(this.dir).guard);
      this.verifyIndependentRecoveryDisposition(ledger, ordinaryJournal);
      for (const { id, work } of delayed) await recoverRestoration(ledger, id, work);
    }
  }
  independentRecoveryJournal(ledger, id) {
    const candidate = this.ordinaryRecoveryJournal(ledger);
    if (!candidate) return null;
    const authority = ledger.sourceAuthority[id], { tx } = candidate;
    if (tx.sourceHash === authority.sourceHash || tx.capture.id === id) return null;
    return candidate;
  }
  ordinaryRecoveryJournal(ledger, knownPublication) {
    const journal = path.join(this.dir, 'transaction.json');
    const guard = this.vault.publicationFolders(this.dir).guard;
    this.storage.guardSync();
    guard();
    const info = local.lstatSync(journal, { bigint: true, throwIfNoEntry: false });
    if (!info) { verifyAbsentSync(journal, guard); return null; }
    if (Object.values(ledger.sourceAuthority || {}).some(value =>
      value.phase === 'deleting' && value.recovery?.some(item => item.format === 'transaction' &&
        samePath(path.join(this.vault.vault, item.file), journal)))) return null;
    const links = Number(info.nlink), changed = () => Error('The independent intake journal or its known aliases changed. Recovery files were preserved.');
    if (links < 1 || links > 3) throw changed();
    const { bytes, proof } = readExactSync(journal, guard, links);
    if (knownPublication && !bytes.equals(Buffer.from(JSON.stringify(knownPublication)))) throw changed();
    const tx = JSON.parse(bytes);
    this.validateTransaction(tx);
    if (tx.restoreOperation) return null;
    assertPublication(ledger, tx.capture.id, tx);
    if (!bytes.equals(Buffer.from(JSON.stringify(tx)))) throw Error('The independent intake journal is not canonical. Recovery files were preserved.');
    const pending = ledger.pending[tx.sourceHash], held = ledger.blocks[tx.sourceHash];
    const names = [journal];
    let repair;
    if (pending) {
      if (pending.journal !== pendingName(tx) || pending.key !== tx.key) return null;
      names.push(path.join(this.dir, pending.journal));
    }
    if (held) {
      const isPeer = held.journal === heldName(tx) && held.incomingRevision === tx.revision.id;
      if (!isPeer && !knownPublication) {
        if (links > 2 || pending) return null;
        repair = this.distinctRepairRecovery(ledger, tx, { bytes, proof }, guard);
        if (!repair) return null;
        names.push(repair.sourceStage);
      } else if (isPeer) {
        names.push(path.join(this.dir, held.journal));
        if (held.outputHold) {
          const witness = held.outputHold;
          if (!this.validOutputHold(witness, pendingName(tx), tx.previousHash) || !sameProofIdentity(witness.journal, proof) ||
              witness.journal.digest !== proof.digest) throw changed();
          if (witness.pending && !pending) names.push(path.join(this.dir, witness.pending));
        }
      }
    }
    const present = new Set(names.filter(file => local.lstatSync(file, { throwIfNoEntry: false })));
    if (present.size !== links || !present.has(journal) || links === 3 && !held?.outputHold) throw changed();
    const verify = () => {
      repair?.verifyRepair?.();
      repair?.freshRepair?.verify();
      repair?.ordinaryRepair?.();
      for (const file of names) {
        if (present.has(file)) verifyStageSync(file, guard, proof, present.size);
        else verifyAbsentSync(file, guard, changed);
      }
    };
    verify();
    return { ...proof, tx, links, verify, guard, ...repair };
  }
  repairConflictWitness(ledger, tx, held, guard, pinned) {
    if (!held) return null;
    const witness = held.outputHold, capture = ledger.captures[tx.sourceHash];
    // Any repairable prior hold can prove this handoff; committed output holds cannot.
    if (witness === null || witness?.committed === true || this.isCommittedOutputHold(held) || held.incomingRevision !== tx.revision.id ||
        !/^conflict-[a-f0-9-]{36}(?:-[a-f0-9-]{36})?\.json$/.test(held.journal) ||
        !tx.resolution || !tx.keptCurrent || capture?.id !== tx.capture.id || capture.conflict !== held.reason ||
        capture.currentRevision !== tx.keptCurrent.id) return null;
    const previous = path.join(this.dir, held.journal);
    const previousJournal = readExactSync(previous, guard, 1, pinned || witness?.journal);
    if (witness && (!validProof(witness.journal) || !sameProofIdentity(witness.journal, previousJournal.proof) ||
        witness.journal.digest !== previousJournal.proof.digest)) {
      throw Error('The older held source journal changed. Recovery files were preserved.');
    }
    const old = JSON.parse(previousJournal.bytes);
    this.validateTransaction(old);
    if (old.sourceHash !== tx.sourceHash || old.capture.id !== tx.capture.id || old.revision.id !== tx.revision.id ||
        old.resolution === tx.resolution || old.key !== tx.key || !isDeepStrictEqual(old.revision, tx.revision) ||
        held.journal !== heldName(old) || !previousJournal.bytes.equals(Buffer.from(JSON.stringify(old)))) {
      throw Error('The older held source journal changed. Recovery files were preserved.');
    }
    const validPrevious = witness
      ? this.hasHeldJournal(ledger, old) && this.validOutputHold(witness, pendingName(old), old.previousHash)
      : this.matchesOrdinaryHeldRepair(ledger, tx, old, held, capture);
    if (!validPrevious) {
      throw Error('The older held source journal changed. Recovery files were preserved.');
    }
    return { proof: previousJournal.proof, verify: () => verifyStageSync(previous, guard, previousJournal.proof) };
  }
  boundRepairConflict(ledger, tx, binding, guard) {
    const held = ledger.blocks[tx.sourceHash];
    const capture = ledger.captures[tx.sourceHash];
    if (!binding || !isDeepStrictEqual(held, binding.block) || !capture || capture.identityIssue || capture.removed ||
        ledger.suppressed.includes(tx.sourceHash) || ledger.pending[tx.sourceHash]) {
      throw Error('The original repair conflict changed. Recovery files were preserved.');
    }
    assertPublication(ledger, tx.capture.id, tx);
    if (!tx.keptCurrent) {
      const previous = path.join(this.dir, held.journal), record = readExactSync(previous, guard, 1, binding.journalProof);
      const old = JSON.parse(record.bytes);
      this.validateTransaction(old);
      if (!record.bytes.equals(Buffer.from(JSON.stringify(old))) || old.sourceHash !== tx.sourceHash ||
          old.capture.id !== tx.capture.id || old.key !== tx.key || !isDeepStrictEqual(old.revision, tx.revision) ||
          capture.conflict !== held.reason || heldName(old) !== held.journal) throw Error('The original repair conflict changed. Recovery files were preserved.');
      return () => verifyStageSync(previous, guard, binding.journalProof);
    }
    const previous = this.repairConflictWitness(ledger, tx, held, guard, binding.journalProof);
    if (!previous) throw Error('The original repair conflict has no exact journal proof. Recovery files were preserved.');
    return previous.verify;
  }
  distinctRepairRecovery(ledger, tx, journal, guard) {
    if (!tx.resolution) return null;
    const intentFile = path.join(this.dir, 'repair-intent.json');
    const archivedIntent = path.join(this.dir, `repair-${tx.resolution}.json`);
    guard();
    const intentInfo = local.lstatSync(intentFile, { bigint: true, throwIfNoEntry: false });
    if (!intentInfo) return null;
    const intentLinks = intentInfo.nlink === 1n ? 1 : 2;
    const intentRecord = readExactSync(intentFile, guard, intentLinks), intent = JSON.parse(intentRecord.bytes);
    this.validateRepairIntent(intent);
    if (intent.intentIdentity && !sameProofIdentity(intent.intentIdentity, intentRecord.proof)) {
      throw Error('The repair intent identity changed. Recovery files were preserved.');
    }
    if (!intentRecord.bytes.equals(Buffer.from(JSON.stringify(intent))) ||
        !journal.bytes.equals(Buffer.from(JSON.stringify(intent.tx)))) {
      throw Error('The active source journal does not match its repair intent. Recovery files were preserved.');
    }
    const previous = this.boundRepairConflict(ledger, tx, intent.priorConflict, guard);
    const verifyIntent = links => {
      previous();
      if (intent.intentIdentity) verifyAbsentSync(path.join(this.dir, `repair-intent-${tx.resolution}.stage`), guard);
      verifyStageSync(intentFile, guard, intentRecord.proof, links);
      if (links === 2) verifyStageSync(archivedIntent, guard, intentRecord.proof, 2);
      else verifyAbsentSync(archivedIntent, guard);
    };
    if (!isDeepStrictEqual(journal.proof, intent.sourceProof)) throw Error('The active repair source journal changed. Recovery files were preserved.');
    const sourceStage = path.join(this.dir, `journal-${tx.resolution}.stage`);
    if (intentLinks === 2) {
      verifyIntent(2);
      return { sourceStage, verifyRepair: () => verifyIntent(2) };
    }
    if (!tx.keptCurrent) {
      if (!intent.localProof || !intent.annotationProof || !intent.intentIdentity) throw Error('The ordinary repair has no exact handoff proof. Recovery files were preserved.');
      verifyIntent(1);
      return { sourceStage, ordinaryRepair: () => verifyIntent(1) };
    }

    // A fresh repair publishes its annotation before creating the source journal.
    // Require both names of that exact publication in addition to the old conflict.
    const annotation = parseAnnotation(intent.annotation);
    if (annotation?.id !== tx.resolution || annotation.captureId !== tx.capture.id ||
        tx.retainOnly !== false || tx.externalConflict !== false) return null;
    const proof = intent.annotationProof;
    if (!proof) throw Error('The active repair has no recorded annotation identity. Recovery files were preserved.');
    const stage = path.join(this.dir, `annotation-${tx.resolution}.stage`);
    const directory = path.join(this.vault.root, 'Annotations');
    const file = path.join(directory, `${tx.resolution}.md`);
    const annotationGuard = this.vault.publicationFolders(directory).guard;
    const guardAnnotation = () => { guard(); annotationGuard(); };
    const verifyAnnotation = () => {
      verifyStageSync(stage, guardAnnotation, proof, 2);
      verifyStageSync(file, guardAnnotation, proof, 2);
    };
    const freshRepair = {
      intentProof: intentRecord.proof,
      verify: (links = 1) => { verifyIntent(links); verifyAnnotation(); },
      retireAnnotation: () => {
        verifyAnnotation();
        local.unlinkSync(stage);
        verifyStageSync(file, guardAnnotation, proof);
      }
    };
    freshRepair.verify();
    return { sourceStage, freshRepair };
  }
  matchesOrdinaryHeldRepair(ledger, tx, old, held, capture) {
    if (Object.keys(held).length !== 3 || typeof held.reason !== 'string' || held.reason.startsWith(outputHold) ||
        !held.reason.endsWith(conflictPause) || !capture.reviewed || !old.capture.reviewed ||
        old.capture.currentRevision !== capture.currentRevision ||
        old.retainOnly !== true && old.keptCurrent?.id !== capture.currentRevision) return false;
    const accepted = revisionAdmission(ledger, capture.currentRevision);
    if (accepted?.status !== 'imported' || accepted.captureId !== capture.id || accepted.sourceHash !== tx.sourceHash ||
        accepted.snapshotHash !== hash(JSON.stringify(tx.keptCurrent, null, 2))) return false;
    const outcome = ledger.outcomes[old.key], locator = old.revision.locator;
    const archived = { status: 'held', reason: held.reason, locator, sourceHash: old.sourceHash, pendingRevision: old.revision.id };
    const scanned = { status: 'held', reason: held.reason.slice(0, -conflictPause.length), locator, checkedAt: old.revision.importedAt };
    return isDeepStrictEqual(outcome, archived) || isDeepStrictEqual(outcome, scanned);
  }
  verifyIndependentRecoveryDisposition(ledger, journal) {
    const { tx } = journal, outcome = ledger.outcomes[tx.key];
    if (outcome?.status === 'imported' && outcome.sourceHash === tx.sourceHash &&
        outcome.captureId === tx.capture.id && outcome.revision === tx.revision.id &&
        isDeepStrictEqual(ledger.captures[tx.sourceHash], tx.capture)) return;
    const held = ledger.blocks[tx.sourceHash], pending = ledger.pending[tx.sourceHash];
    const remaining = held?.journal === heldName(tx) && held.incomingRevision === tx.revision.id ? held.journal :
      pending?.journal === pendingName(tx) && pending.key === tx.key ? pending.journal : null;
    if (remaining) {
      verifyStageSync(path.join(this.dir, remaining), journal.guard, journal);
      return;
    }
    throw Error('The independent intake journal has no settled disposition. Restoration recovery files were preserved.');
  }
  async recoverOrdinaryIntake(expectedJournal) {
    const journal = path.join(this.dir, 'transaction.json');
    expectedJournal?.verify();
    await this.holdLegacyAccepted();
    await this.finishLink();
    await this.finishAnnotation();
    try { await this.finishRepair(expectedJournal?.verifyRepair || expectedJournal?.freshRepair || expectedJournal?.ordinaryRepair ? expectedJournal : undefined); }
    catch (error) { if (!error.intakeRepairHeld) throw error; }
    await this.finishTitleIntent();
    const guard = this.vault.publicationFolders(this.dir).guard;
    guard();
    const info = local.lstatSync(journal, { bigint: true, throwIfNoEntry: false });
    if (!info) {
      if (expectedJournal) this.verifyIndependentRecoveryDisposition(await this.load(), expectedJournal);
      return;
    }
    if (expectedJournal?.verifyRepair || expectedJournal?.freshRepair || expectedJournal?.ordinaryRepair) throw Error('The exact repair journal remains active. Recovery files were preserved.');
    const changed = () => Error('The intake recovery journal changed. Recovery files were preserved.');
    const links = Number(info.nlink);
    if (![1, 2, 3].includes(links)) throw changed();
    const { bytes, proof } = readExactSync(journal, guard, links);
    if (String(info.dev) !== proof.dev || String(info.ino) !== proof.ino) throw changed();
    const text = bytes.toString('utf8');
    let tx; try { tx = JSON.parse(text); } catch { throw Error('Unreadable intake recovery journal. Preserve .intake for repair before retrying.'); }
    this.validateTransaction(tx);
    const ledger = await this.load();
    try { verifyStageSync(journal, guard, proof, links); }
    catch (error) { if (error.code === 'STAGING_CHANGED') throw changed(); throw error; }
    expectedJournal ||= this.ordinaryRecoveryJournal(ledger, tx);
    if (!expectedJournal || !sameProofIdentity(expectedJournal, proof) || expectedJournal.digest !== proof.digest) throw changed();
    expectedJournal.verify();
    assertPublication(ledger, tx.capture.id, tx);
    if (this.hasHeldJournal(ledger, tx)) return this.archiveConflict(tx, ledger, ledger.blocks[tx.sourceHash].reason, { expectedJournal });
    if (tx.externalConflict && !ledger.blocks[tx.sourceHash]) return this.archiveConflict(tx, ledger, 'Destination changed outside Companion. Both versions were preserved.', { expectedJournal });
    if (ledger.blocks[tx.sourceHash] && !tx.restore) return this.archiveConflict(tx, ledger, ledger.blocks[tx.sourceHash].reason, { expectedJournal });
    if (ledger.pending[tx.sourceHash]) return this.defer(tx, ledger, ledger.pending[tx.sourceHash].reason, expectedJournal);
    try { await this.finish(tx, ledger, expectedJournal); } catch (error) {
      if (error.intakeOutputHeld) return;
      if (error.intakeDeferred) await this.defer(tx, ledger, error.message, expectedJournal);
      else if (error.intakeConflict) await this.archiveConflict(tx, ledger, error.message, { expectedJournal, ...error.intakeConflictProof });
      else throw error;
    }
  }
  async holdLegacyAccepted() {
    const file = path.join(this.dir, 'transaction.json');
    const guard = this.vault.publicationFolders(this.dir).guard;
    guard();
    const observed = local.lstatSync(file, { bigint: true, throwIfNoEntry: false });
    if (!observed) return;
    const expected = this.storage.expected, ledger = await this.load();
    const changed = () => Error('Older intake publication authority is ambiguous. All files were preserved.');
    if (!this.storage.matches(this.storage.expected, expected)) throw changed();
    this.storage.guardSync();
    const { bytes, proof } = readExactSync(file, guard, Number(observed.nlink));
    if (proof.dev !== String(observed.dev) || proof.ino !== String(observed.ino)) throw changed();
    const tx = JSON.parse(bytes.toString('utf8'));
    this.validateTransaction(tx);
    if (tx.restoreOperation || this.hasHeldJournal(ledger, tx) || ledger.pending[tx.sourceHash]) return;
    const priorBlock = ledger.blocks[tx.sourceHash];
    if (priorBlock && priorBlock.journal !== heldName(tx) && observed.nlink <= 2n &&
        this.distinctRepairRecovery(ledger, tx, { bytes, proof }, guard)) return;
    const current = ledger.captures[tx.sourceHash], outcome = ledger.outcomes[tx.key];
    const sameCapture = isDeepStrictEqual(current, tx.capture);
    const referencesOutcome = outcome?.status === 'imported' && outcome.sourceHash === tx.sourceHash &&
      outcome.revision === tx.revision.id && outcome.identity === tx.revision.identity;
    if (!sameCapture && !referencesOutcome) return;
    if (!sameCapture && current?.id === tx.capture.id) {
      const selection = tx.resolution && tx.externalConflict === undefined && tx.revision.review &&
        tx.previousHash === current.currentHash && isDeepStrictEqual(selectedCapture(current, tx.revision, tx.capture.updatedAt), tx.capture);
      const missingNote = tx.restore && current.identityIssue && tx.previous === null && current.currentRevision === tx.revision.id &&
        current.currentHash === tx.capture.currentHash;
      if (selection || missingNote) return;
    }
    const acceptance = acceptedOutcome(tx);
    if (!sameCapture || !isDeepStrictEqual(outcome, acceptance) || !isDeepStrictEqual(revisionAdmission(ledger, tx.revision.id), acceptance) ||
        observed.nlink !== 1n || proof.digest !== hash(JSON.stringify(tx))) throw changed();
    assertPublication(ledger, tx.capture.id, tx);
    // The previous ledger has no publication inode proofs. The newly observed
    // exact journal only authorizes preserving that journal in a hold.
    const reason = `${outputHold} The original publication file identities were not recorded.${acceptancePreserved}`;
    await this.archiveConflict(tx, ledger, reason, { journalProof: proof, guard, committed: true });
  }
  async defer(tx, ledger, reason, expectedJournal) {
    this.validateTransaction(tx);
    const name = pendingName(tx), journal = path.join(this.dir, 'transaction.json'), remaining = path.join(this.dir, name);
    const alias = this.ordinaryJournalAlias(ledger, tx, remaining, expectedJournal);
    ledger.pending[tx.sourceHash] = { journal: name, reason, key: tx.key };
    ledger.outcomes[tx.key] = { status: 'held', reason, locator: tx.revision.locator, sourceHash: tx.sourceHash, pendingRevision: tx.revision.id };
    await this.save(ledger, alias.verify);
    this.retireOrdinaryJournalAlias(journal, remaining, alias);
  }
  ordinaryJournalAlias(ledger, tx, remaining, expected) {
    const observed = expected?.verify ? expected : this.ordinaryRecoveryJournal(ledger, tx);
    const changed = () => Error('The intake journal or its known alias changed. Recovery files were preserved.');
    if (!observed || observed.digest !== hash(JSON.stringify(tx)) || ![1, 2].includes(observed.links)) throw changed();
    if (expected && (!sameProofIdentity(expected, observed) || expected.digest !== observed.digest)) throw changed();
    const verify = () => {
      observed.verify();
      if (observed.links === 2) verifyStageSync(remaining, observed.guard, observed, 2);
      else verifyAbsentSync(remaining, observed.guard, changed);
    };
    verify();
    return { ...observed, verify };
  }
  retireOrdinaryJournalAlias(journal, remaining, expected) {
    const { guard, links } = expected;
    this.storage.guardSync();
    expected.verify();
    if (local.lstatSync(remaining, { throwIfNoEntry: false })) {
      if (links !== 2) throw Error('The known intake journal alias changed. Recovery files were preserved.');
      verifyStageSync(remaining, guard, expected, 2);
    } else {
      if (links !== 1) throw Error('The known intake journal alias is missing. Recovery files were preserved.');
      verifyAbsentSync(remaining, guard);
      local.linkSync(journal, remaining);
    }
    verifyStageSync(journal, guard, expected, 2);
    verifyStageSync(remaining, guard, expected, 2);
    local.unlinkSync(journal);
    verifyAbsentSync(journal, guard);
    verifyStageSync(remaining, guard, expected);
  }
  async retryPending() {
    let ledger = await this.load();
    for (const [sourceHash, pending] of Object.entries(ledger.pending)) {
      if (ledger.suppressed.includes(sourceHash)) continue;
      if (!/^pending-[a-f0-9-]{36}(?:-[a-f0-9-]{36})?\.json$/.test(pending.journal)) throw Error('Invalid deferred intake journal identity. Preserve .intake for repair.');
      const file = path.join(this.dir, pending.journal), guard = this.vault.publicationFolders(this.dir).guard;
      let tx, proof;
      try {
        const observed = readExactSync(file, guard);
        tx = JSON.parse(observed.bytes);
        proof = observed.proof;
      } catch { throw Error('Deferred intake journal is unreadable. Preserve .intake for repair.'); }
      this.validateTransaction(tx); if (tx.sourceHash !== sourceHash || pending.journal !== pendingName(tx)) throw Error('Deferred intake identity does not match its journal.');
      // Every retry has the same active recovery seam as first publication.
      // A crash while turning a pending item into a conflict remains recoverable.
      const active = path.join(this.dir, 'transaction.json');
      verifyAbsentSync(active, guard);
      verifyStageSync(file, guard, proof);
      local.linkSync(file, active);
      verifyStageSync(file, guard, proof, 2);
      verifyStageSync(active, guard, proof, 2);
      try {
        await this.finish(tx, ledger, proof);
      }
      catch (error) {
        if (!error.intakeOutputHeld) {
          if (error.intakeConflict && !ledger.pending[sourceHash]?.acceptedCleanup && !ledger.acceptedCleanup) {
            // The hold ledger must retain the exact pending alias identity
            // before replacing the pending pointer, even before its new link.
            await this.archiveConflict(tx, ledger, error.message, { mode: precommitConflict, journalProof: proof, guard, rollback: error.intakeConflictProof?.rollback });
          }
          else if (error.intakeDeferred) await this.defer(tx, ledger, error.message, proof);
          else throw error;
        }
      }
      ledger = await this.load();
    }
  }
  hasOutputHold(ledger, tx) {
    const block = ledger.blocks?.[tx.sourceHash];
    return !!block?.reason?.startsWith(outputHold) && block.outputHold?.mode !== precommitConflict &&
      block.incomingRevision === tx.revision.id && block.journal === heldName(tx);
  }
  hasHeldJournal(ledger, tx) {
    const block = ledger.blocks?.[tx.sourceHash];
    return this.hasOutputHold(ledger, tx) || block?.outputHold?.mode === precommitConflict &&
      block.incomingRevision === tx.revision.id && block.journal === heldName(tx);
  }
  heldRepairSourceVerifier(ledger, tx, recorded, guard) {
    const block = ledger.blocks[tx.sourceHash], witness = block?.outputHold;
    const pending = pendingName(tx);
    const changed = () => Error('The held repair source journal or its known aliases changed. Recovery files were preserved.');
    if (!this.hasHeldJournal(ledger, tx) || !this.validOutputHold(witness, pending, tx.previousHash) ||
        witness.journal.digest !== hash(JSON.stringify(tx)) || recorded &&
        (!sameProofIdentity(witness.journal, recorded) || witness.journal.digest !== recorded.digest)) throw changed();
    assertPublication(ledger, tx.capture.id, tx);
    const active = path.join(this.dir, 'transaction.json'), archive = path.join(this.dir, block.journal);
    const pendingFile = path.join(this.dir, pending), names = [active, archive, pendingFile];
    return () => {
      guard();
      const present = names.filter(file => local.lstatSync(file, { throwIfNoEntry: false }));
      if ((!present.includes(active) && !present.includes(archive)) || present.includes(pendingFile) && !witness.pending) throw changed();
      for (const file of names) {
        if (present.includes(file)) verifyStageSync(file, guard, witness.journal, present.length);
        else verifyAbsentSync(file, guard, changed);
      }
    };
  }
  validOutputHold(witness, pending, previousHash) {
    if (!witness || !Object.hasOwn(witness, 'journal') || !Object.hasOwn(witness, 'pending') || !validProof(witness.journal) ||
        witness.pending !== null && witness.pending !== pending) return false;
    const base = ['journal', 'pending', 'committed'];
    if (witness.mode === undefined) {
      return Object.keys(witness).every(key => [...base, 'captureAccess'].includes(key)) &&
        (!Object.hasOwn(witness, 'committed') || typeof witness.committed === 'boolean') &&
        (!Object.hasOwn(witness, 'captureAccess') || witness.committed === true && validCaptureAccess(witness.captureAccess));
    }
    if (witness.mode !== precommitConflict || witness.committed !== false ||
        Object.keys(witness).some(key => ![...base, 'mode', 'rollback'].includes(key))) return false;
    const rollback = witness.rollback;
    return rollback === undefined || rollback && Object.keys(rollback).length === 2 &&
      validProof(rollback.proof) && rollback.proof.digest === previousHash &&
      Array.isArray(rollback.directories) && rollback.directories.length > 0 && rollback.directories.every(directory =>
        directory && Object.keys(directory).length === 2 &&
        ['dev', 'ino'].every(key => typeof directory[key] === 'string' && /^[0-9]+$/.test(directory[key])));
  }
  isCommittedOutputHold(block) {
    const witness = block?.outputHold;
    if (!witness || !block.reason?.startsWith(outputHold)) return false;
    if (Object.hasOwn(witness, 'committed')) return witness.committed === true;
    // Earlier holds recorded this distinction only in the exact fixed reason.
    // Use it for repair presentation and refusal, never for publication proof.
    return block.reason.endsWith(acceptancePreserved + conflictPause);
  }
  isPublicationOutputHold(block) {
    return !!block?.outputHold && block.outputHold.mode !== precommitConflict;
  }
  verifyHeldTransaction(ledger, tx) {
    const block = ledger.blocks?.[tx.sourceHash];
    if (!block?.reason?.startsWith(outputHold) && !block?.outputHold) return;
    const witness = block.outputHold;
    if (!this.hasHeldJournal(ledger, tx) || !this.validOutputHold(witness, pendingName(tx), tx.previousHash) ||
        witness.journal.digest !== hash(JSON.stringify(tx))) {
      throw Error('The exact held intake journal proof changed. All files were preserved.');
    }
    const guard = this.vault.publicationFolders(this.dir).guard;
    verifyStageSync(path.join(this.dir, block.journal), guard, witness.journal);
  }
  captureAccessPeers(tx) {
    return [path.join(this.dir, tx.revision.id + '.stage'), path.join(this.dir, tx.backup)];
  }
  async heldCaptureReadRefusal(error) {
    const cause = error?.cause;
    if (!fileAccessRefused(cause) || typeof cause.path !== 'string') return false;
    const expected = this.storage.expected, ledger = await this.load();
    if (!this.storage.matches(this.storage.expected, expected)) return false;
    this.storage.guardSync();
    if (this.vault.heldRestorationCaptureReadRefusal(ledger, cause)) {
      this.storage.guardSync();
      return true;
    }
    const entry = Object.entries(ledger.blocks).find(([sourceHash, block]) =>
      block?.outputHold?.captureAccess && ledger.captures[sourceHash] && samePath(this.destination(ledger.captures[sourceHash]), cause.path));
    if (!entry) return false;
    const [sourceHash, block] = entry, capture = ledger.captures[sourceHash], witness = block.outputHold;
    const proof = witness.captureAccess, file = this.destination(capture);
    if (!this.isCommittedOutputHold(block) || !validCaptureAccess(proof) || proof.digest !== capture.currentHash ||
        !/^conflict-[a-f0-9-]{36}(?:-[a-f0-9-]{36})?\.json$/.test(block.journal)) return false;
    const parents = [...requiredDirectories(this, [{ file: path.relative(this.vault.vault, file) }])]
      .map(directory => path.join(this.vault.vault, directory));
    const { guard } = ordinaryDirectories(parents, 'Held capture folders changed. All files were preserved.', proof.directories);
    this.storage.guardSync();
    const { bytes } = verifyStageSync(path.join(this.dir, block.journal), guard, witness.journal);
    const tx = JSON.parse(bytes.toString('utf8'));
    this.validateTransaction(tx);
    if (!this.hasOutputHold(ledger, tx) || !this.validOutputHold(witness, pendingName(tx)) || tx.sourceHash !== sourceHash ||
        tx.capture.id !== capture.id || tx.capture.currentHash !== proof.digest || !samePath(this.destination(tx.capture), file) ||
        witness.journal.digest !== hash(JSON.stringify(tx))) return false;
    assertPublication(ledger, tx.capture.id, tx);
    return matchesCaptureAccess(file, this.captureAccessPeers(tx), proof, guard);
  }
  async archiveConflict(tx, ledger, message, retained) {
    this.validateTransaction(tx);
    await this.setup();
    const preservePublication = message.startsWith(outputHold);
    const priorWitness = this.hasHeldJournal(ledger, tx) ? ledger.blocks[tx.sourceHash].outputHold : undefined;
    const exactJournal = preservePublication || retained?.mode === precommitConflict || priorWitness?.mode === precommitConflict;
    const reason = exactJournal && message.endsWith(conflictPause) ? message : message + conflictPause;
    const archive = heldName(tx), journal = path.join(this.dir, 'transaction.json');
    const held = path.join(this.dir, archive);
    const ordinaryAlias = exactJournal ? null : this.ordinaryJournalAlias(ledger, tx, held, retained?.expectedJournal);
    let holdJournal, witness;
    if (exactJournal) {
      const guard = retained?.guard || this.vault.publicationFolders(this.dir).guard;
      const changed = () => Error('Held intake transaction or its known peers changed. All files were preserved.');
      const newProof = retained?.journalProof || retained?.journalInfo;
      if (!newProof && !this.hasHeldJournal(ledger, tx)) throw changed();
      const pending = path.join(this.dir, pendingName(tx)), names = [journal, pending, held];
      guard();
      const current = local.lstatSync(journal, { bigint: true, throwIfNoEntry: false });
      if (!current || retained?.journalInfo && !exactIdentity(current, retained.journalInfo)) throw changed();
      if (newProof) {
        const association = ledger.pending[tx.sourceHash];
        if (association && (association.journal !== pendingName(tx) || association.key !== tx.key)) throw changed();
        witness = { journal: retained.journalProof || fileProof(retained.journalInfo, JSON.stringify(tx)), pending: association?.journal || null,
          committed: retained.mode === precommitConflict ? false : retained.committed,
          ...(retained.captureAccess ? { captureAccess: retained.captureAccess } : {}),
          ...(retained.mode === precommitConflict ? { mode: precommitConflict, ...(retained.rollback ? { rollback: retained.rollback } : {}) } : {}) };
      } else witness = priorWitness;
      if (!this.validOutputHold(witness, pendingName(tx), tx.previousHash) ||
          witness.journal.digest !== hash(JSON.stringify(tx))) throw changed();
      const proof = witness.journal;
      const present = new Set(names.filter(file => {
        guard();
        const stat = local.lstatSync(file, { bigint: true, throwIfNoEntry: false });
        if (stat && (String(stat.dev) !== proof.dev || String(stat.ino) !== proof.ino || file === pending && witness.pending === null)) throw changed();
        return !!stat;
      }));
      if (Number(current.nlink) !== present.size) throw changed();
      const verify = () => {
        for (const file of names) {
          if (present.has(file)) verifyStageSync(file, guard, proof, present.size);
          else verifyAbsentSync(file, guard, changed);
        }
      };
      holdJournal = {
        verify,
        publish: () => {
          if (!present.has(held)) {
            local.linkSync(journal, held);
            present.add(held);
          }
          verify();
          // Keep the active name until the pending alias is retired. Any
          // interrupted transition still has an exact transaction to inspect.
          if (present.has(pending)) {
            local.unlinkSync(pending);
            present.delete(pending);
          }
          verify();
          local.unlinkSync(journal);
          present.delete(journal);
          verify();
        }
      };
    }
    if (retained?.acceptedCleanup) {
      if (ledger.acceptedCleanup !== retained.acceptedCleanup) throw Error('Accepted intake authority changed. All files were preserved.');
      delete ledger.acceptedCleanup;
    }
    ledger.blocks[tx.sourceHash] = { reason, journal: archive, incomingRevision: tx.revision.id, ...(witness ? { outputHold: witness } : {}) };
    delete ledger.pending[tx.sourceHash];
    if (ledger.captures[tx.sourceHash]) ledger.captures[tx.sourceHash].conflict = reason;
    ledger.outcomes[tx.key] = { status: 'held', reason, locator: tx.revision.locator, sourceHash: tx.sourceHash, pendingRevision: tx.revision.id };
    await this.save(ledger, holdJournal?.verify || ordinaryAlias.verify);
    if (holdJournal) {
      this.storage.guardSync();
      holdJournal.verify();
      if (witness.rollback) this.restoreConflictBackup(tx, ledger, witness.rollback, holdJournal.verify);
      holdJournal.publish();
      return;
    }
    this.retireOrdinaryJournalAlias(journal, held, ordinaryAlias);
  }
  async archivePrecommitConflict(tx, ledger, message, journalProof, guard) {
    await this.archiveConflict(tx, ledger, message, { mode: precommitConflict, journalProof, guard });
  }
  restoreConflictBackup(tx, ledger, rollback, verifyJournal) {
    const destination = this.destination(tx.capture), backup = path.join(this.dir, tx.backup);
    const parents = [...requiredDirectories(this, [{ file: path.relative(this.vault.vault, destination) }])]
      .map(directory => path.join(this.vault.vault, directory));
    const { guard } = ordinaryDirectories(parents, 'Conflict rollback folder identity changed. All files were preserved.', rollback.directories);
    this.storage.guardSync();
    verifyJournal();
    if (local.lstatSync(destination, { throwIfNoEntry: false })) return;
    try { this.verifyReservedCaptureIdentity(ledger, tx.capture.id); }
    catch (error) { if (error.intakeReservedIdentity) return; throw error; }
    try { verifyStageSync(backup, guard, rollback.proof); }
    catch (error) { if (error.code === 'STAGING_CHANGED') return; throw error; }
    verifyAbsentSync(destination, guard);
    try { local.linkSync(backup, destination); }
    catch (error) { if (error.code === 'EEXIST') return; throw error; }
    verifyStageSync(backup, guard, rollback.proof, 2);
    verifyStageSync(destination, guard, rollback.proof, 2);
  }
  async linkSources(id, relatedId, now) {
    return this.locked(async () => {
      const ledger = await this.load(), entries = Object.entries(ledger.captures);
      const left = entries.find(([, item]) => item.id === id), right = entries.find(([, item]) => item.id === relatedId);
      if (!left || !right || id === relatedId || left[0] === right[0]) throw Error('Choose two existing captures with different source bytes.');
      const captureIds = [id, relatedId].sort();
      ledger.links ||= [];
      if (!ledger.links.some(link => link.captureIds[0] === captureIds[0] && link.captureIds[1] === captureIds[1])) ledger.links.push({ captureIds, sourceHashes: [left[0], right[0]].sort(), linkedAt: now });
      await this.save(ledger);
    });
  }
  async selectCurrent(id, revisionId, now) {
    return this.locked(async () => {
      await this.syncMoves();
      const ledger = await this.load(), entry = Object.entries(ledger.captures).find(([, item]) => item.id === id);
      if (!entry) throw Error('Choose an imported capture.');
      const [sourceHash, previous] = entry;
      if (previous.identityIssue || previous.removed || previous.conflict || ledger.blocks[sourceHash] || ledger.pending[sourceHash]) throw Error('Resolve the source conflict before choosing current evidence.');
      if (!previous.revisions.includes(revisionId) || !/^[a-f0-9-]{36}$/.test(revisionId)) throw Error('Choose a retained reviewed revision for this capture.');
      const known = revisionAdmission(ledger, revisionId);
      const bytes = await read(path.join(this.vault.root, 'Revisions', `${revisionId}.json`));
      if (!known || bytes === null || hash(bytes) !== known.snapshotHash) throw Error('Immutable revision is missing or changed. Restore it before choosing current evidence.');
      const revision = JSON.parse(bytes);
      if (!revision.review || revision.captureId !== id || revision.sourceHash !== sourceHash) throw Error('Only a finalized reviewed revision from this capture can be chosen.');
      const current = await read(this.destination(previous));
      if (current === null || hash(current) !== previous.currentHash) throw Error('Destination changed outside Companion. Resolve the local edit before choosing current evidence.');
      const capture = selectedCapture(previous, revision, now);
      const content = noteText(capture, revision), resolution = randomUUID();
      const key = Object.entries(ledger.outcomes).find(([, item]) => item.revision === revisionId)?.[0] || `${randomUUID()}:selection`;
      const tx = { schema: 1, resolution, retainOnly: content === current, key, sourceHash, capture, revision, content, previous: current, previousHash: hash(current), backup: `${id}-${revisionId}.before-${resolution}.md`, ...(ledger.sourceAuthority?.[id]?.phase === 'active' ? { sourceGeneration: ledger.sourceAuthority[id].generation } : {}) };
      const journal = path.join(this.dir, 'transaction.json');
      const proof = await this.publishJournal(journal, tx);
      await this.vault.checkpoint('intake-journaled');
      try { await this.finish(tx, ledger, proof); }
      catch (error) {
        if (error.intakeDeferred) await this.defer(tx, ledger, error.message, proof);
        else if (error.intakeConflict) await this.archiveConflict(tx, ledger, error.message, { ...error.intakeConflictProof, expectedJournal: proof });
        throw error;
      }
    });
  }
  async title(id, title) {
    return this.locked(async () => {
      const ledger = await this.load(), capture = Object.values(ledger.captures).find(x => x.id === id);
      if (!capture) return this.vault.title(id, title);
      if (typeof title !== 'string' || !title.trim() || /[\r\n]/.test(title)) throw Error('Enter a title on one line.');
      const note = await this.vault.find(id); if (hash(note.content) !== capture.currentHash) throw Error('This imported note changed outside Companion. Inspect it before editing.');
      const file = path.join(this.dir, 'title-intent.json'), guard = this.vault.publicationFolders(this.dir).guard;
      const intent = { id, before: note.content, previousHash: capture.currentHash, title: title.trim(), content: withTitle(note.content, title.trim()), ...(ledger.sourceAuthority?.[id]?.phase === 'active' ? { sourceGeneration: ledger.sourceAuthority[id].generation } : {}) };
      await this.publishJournal(file, intent);
      const original = readExactSync(file, guard);
      if (!original.bytes.equals(Buffer.from(JSON.stringify(intent)))) throw Error('The imported title intent changed. Files were preserved for repair.');
      let publication;
      await this.vault.title(id, title, proof => { publication = proof; });
      const finished = await this.finishTitleIntent(publication, { guard, proof: original.proof });
      if (finished === 'pending') throw Error('The exact title save still awaits recovery. Restart Companion to continue.');
      if (!finished) throw Error('External edit conflict. The title intent and your files were preserved.');
    });
  }
  async finishTitleIntent(publication, selected) {
    this.pendingTitleCapture = undefined;
    const file = path.join(this.dir, 'title-intent.json');
    if (!selected && !local.lstatSync(file, { throwIfNoEntry: false })) return true;
    const intentGuard = selected?.guard || this.vault.publicationFolders(this.dir).guard;
    const original = readExactSync(file, intentGuard, 1, selected?.proof);
    const verifyIntent = () => verifyStageSync(file, intentGuard, original.proof);
    let intent; try { intent = JSON.parse(original.bytes); } catch { throw Error('Unreadable imported title intent. Preserve .intake for repair.'); }
    let ledger = await this.load();
    const [sourceHash, capture] = Object.entries(ledger.captures).find(([, item]) => item.id === intent.id) || [];
    assertPublication(ledger, intent.id, { sourceGeneration: intent.sourceGeneration });
    const invalidIntent = () => Error('Invalid imported title recovery intent. Files were preserved for repair.');
    if (!capture || typeof intent.before !== 'string' || typeof intent.title !== 'string' || !intent.title.trim() ||
        /[\r\n]/.test(intent.title) || intent.previousHash !== hash(intent.before) || intent.content !== withTitle(intent.before, intent.title)) throw invalidIntent();
    const intended = Buffer.from(intent.content), digest = hash(intended);
    if (![intent.previousHash, digest].includes(capture.currentHash)) throw invalidIntent();
    const hold = async (reason, locator) => {
      ledger.captures[sourceHash].conflict = reason;
      ledger.outcomes[`title:${intent.id}`] = { status: 'held', reason, locator };
      await this.save(ledger, verifyIntent);
      const archive = path.join(this.dir, `title-conflict-${intent.id}-${randomUUID()}.json`);
      this.storage.guardSync();
      verifyAbsentSync(archive, intentGuard);
      verifyIntent();
      local.renameSync(file, archive);
      return false;
    };
    const holdExternal = locator => hold('External edit conflict during title save. Local writing and title intent were preserved; this source is paused for repair.', locator);
    const note = (await this.vault.list()).find(x => x.id === intent.id);
    const destination = this.destination(capture);
    if ((!note || note.file === destination) && await this.vault.hasExactTitleIntent(destination, intent)) {
      verifyIntent();
      this.pendingTitleCapture = intent.id;
      return 'pending';
    }
    if (!note || ![intent.before, intent.content].includes(note.content)) {
      return holdExternal(note?.file || capture.file);
    }
    const holdPublication = () => hold('Title publication is held. The prior note, staging files and title intent were preserved for inspection; this source is paused for repair.', note.file);
    if (await this.vault.titleHasStage(note.file)) return holdPublication();
    if (note.content === intent.before) {
      verifyIntent();
      try { await this.vault.title(intent.id, intent.title, proof => { publication = proof; }); }
      catch (error) {
        if (error.code !== 'TITLE_PUBLICATION_HELD') throw error;
        return holdPublication();
      }
    }
    publication?.guard();
    if (publication && publication.file !== note.file) return holdExternal(note.file);
    const guard = publication?.guard || this.vault.publicationFolders(path.dirname(note.file)).guard;
    const changedTitle = Error('The published title changed.');
    const verifyTitle = proof => {
      try {
        const exact = verifyStageSync(note.file, guard, proof);
        if (!exact.bytes.equals(intended)) throw changedTitle;
        return exact.proof;
      } catch (error) {
        if (error.code !== 'STAGING_CHANGED') throw error;
        guard();
        throw changedTitle;
      }
    };
    try {
      const proof = verifyTitle(publication?.proof);
      const verifyRelated = () => { verifyIntent(); verifyTitle(proof); };
      const next = { ...ledger, captures: { ...ledger.captures, [sourceHash]: { ...capture, title: intent.title, currentHash: digest } } };
      await this.save(next, verifyRelated);
      ledger = next;
      this.storage.guardSync();
      verifyTitle(proof);
      verifyIntent();
      local.unlinkSync(file);
    } catch (error) {
      if (error !== changedTitle) throw error;
      return holdExternal(note.file);
    }
    this.vault.expected.set(intent.id, digest);
    return true;
  }
  async inspect(id, { verifyCurrentNote = false } = {}) {
    const ledger = await this.info(), entry = Object.entries(ledger.captures).find(([, item]) => item.id === id);
    if (!entry) throw Error('Imported capture is missing from intake history.');
    const [sourceHash, capture] = entry;
    this.verifyReservedCaptureIdentity(ledger, id);
    const revisions = [];
    for (const revision of capture.revisions) {
      if (!/^[a-f0-9-]{36}$/.test(revision)) throw Error('Invalid revision identity.');
      const bytes = await read(path.join(this.vault.root, 'Revisions', `${revision}.json`));
      const known = revisionAdmission(ledger, revision);
      if (bytes === null || !known || hash(bytes) !== known.snapshotHash) throw Error('Immutable revision snapshot is missing or changed. Restore it from a vault backup before inspecting evidence.');
      revisions.push(JSON.parse(bytes));
    }
    const related = Object.entries(ledger.captures).filter(([, item]) => item.id !== id).map(([sourceHash, item]) => ({ id: item.id, title: item.title, sourceHash }));
    const links = (ledger.links || []).filter(link => link.captureIds.includes(id)).map(link => ({ ...link, related: related.find(item => link.captureIds.includes(item.id)) }));
    let supportReason = capture.rejected ? 'excluded by rejection. Historical material remains inspectable.'
      : capture.removed || ledger.suppressed.includes(sourceHash) ? 'unavailable because this source is removed or suppressed.'
      : capture.conflict || ledger.blocks[sourceHash] ? 'paused because the imported source has an unresolved conflict or publication hold.'
      : capture.reviewChoices?.length ? 'paused pending an explicit current reviewed revision choice.'
      : capture.identityIssue || ledger.identityIssues?.[id] ? 'paused until the capture identity is resolved.'
      : ledger.pending[sourceHash] || ledger.acceptedCleanup?.sourceHash === sourceHash ? 'paused while intake recovery is pending.'
      : capture.supportEligible === false ? 'excluded by the recorded source eligibility.' : null;
    if (verifyCurrentNote && !supportReason) {
      const observed = this.storage.expected;
      let note;
      try { note = await this.vault.find(id); }
      catch { supportReason = 'unavailable because the current capture cannot be verified.'; }
      if (!this.storage.matches(await this.storage.view(), observed)) throw Error('Intake authority changed. Inspect the source again.');
      if (note && hash(note.content) !== capture.currentHash) supportReason = 'paused because local changes do not match the retained imported revision.';
    }
    return { capture, revisions, related, links, supportReason };
  }
}
require('./repairs').install(Intake, { hash, read, noteText, acceptedOutcome });
module.exports = { Intake, noteText };
