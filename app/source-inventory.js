const fs = require('node:fs/promises');
const path = require('node:path');
const { isDeepStrictEqual } = require('node:util');
const { hash, validate, render, bound } = require('./intake-producer');
const { matchesProducerOutcome } = require('./producer-root');
const { validateNormalizedReview, knownRun } = require('./source-review');
const sourceTitle = require('./source-title');
const pendingTitle = require('./pending-title');
const { activeAnnotationIntent, heldAnnotationIntent, isAnnotationIntent } = require('./annotation-authority');
const { requiredDirectories } = require('./source-recovery');
const { ordinaryDirectories } = require('./staged-publication');
const { stageRecord, matchesProof, retireStageRecords } = require('./intake-publication');
const uuid = value => typeof value === 'string' && /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(value);
const sha = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const fields = (value, names) => value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).every(key => names.includes(key));
const safe = value => typeof value === 'string' && !!value && !/[\\:]/.test(value) && value.split('/').every(part => part && part !== '.' && part !== '..');
const relative = (intake, file) => path.relative(intake.vault.vault, file).split(path.sep).join('/');
const fail = () => { throw Object.assign(Error('Source recovery inventory contains changed or unsupported writing. Preserve it for explicit review.'), { code: 'SOURCE_FILE_CHANGED' }); };
const equal = (left, right) => JSON.stringify(left) === JSON.stringify(right);
const date = value => typeof value === 'string' && /T.*(?:Z|[+-]\d\d:\d\d)$/.test(value) && Number.isFinite(Date.parse(value));
const fileProof = target => ({ dev: target.dev, ino: target.ino, digest: target.sha256 });
const formats = ['transaction', 'capture-stage', 'snapshot-stage', 'incoming-snapshot', 'source-backup'];
const mentions = (bytes, id, sourceHash) => bytes.includes(Buffer.from(id, 'utf8')) || bytes.includes(Buffer.from(sourceHash, 'utf8'));
function text(bytes) {
  try { return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes); }
  catch { fail(); }
}

// Pure shape checks for the content-free proof committed before any unlink.
// Recovery verifies its surviving exact leaves; it does not need a removed journal.
function validateInventory(value, id) {
  if (value.mixedRecovery !== undefined || value.preservedWriting !== undefined || value.targets.some(item => item.kind === 'mixed-recovery')) {
    if (value.inventoryVersion !== 2 || value.manual || !Array.isArray(value.originGenerations) || value.originGenerations.length > 1 || value.originGenerations.some(item => !fields(item, ['captureId', 'generation']) || item.captureId !== id || !uuid(item.generation)) || !Array.isArray(value.recovery) || !Array.isArray(value.recoveryPointers) || !Array.isArray(value.purgedProducerAttempts)) fail();
    require('./mixed-deletion').validate(value, id);
    if (value.mixedRecovery?.format === 'restored-backup-editor-hold-v1') validateRecovery(value, id);
    validateObservations(value, id); return;
  }
  if (value.inventoryVersion === 1) return require('./manual-title').validate(value, id);
  if (value.inventoryVersion === undefined) {
    if (['originGenerations', 'recovery', 'recoveryPointers', 'purgedProducerAttempts', 'titleProofs', 'titleRecovery'].some(key => value[key] !== undefined) || value.targets.some(item => item.peers !== undefined || ['source-recovery', 'source-title-backup'].includes(item.kind)) || value.history?.some(item => item.inventoryVersion === 2)) fail();
    return;
  }
  if (value.inventoryVersion !== 2 || value.manual || !Array.isArray(value.originGenerations) || value.originGenerations.length > 1 || value.originGenerations.some(item => !fields(item, ['captureId', 'generation']) || item.captureId !== id || !uuid(item.generation)) || !Array.isArray(value.recovery) || !Array.isArray(value.recoveryPointers) || !Array.isArray(value.purgedProducerAttempts)) fail();
  sourceTitle.validateProofs(value, id);
  const titleRecovery = pendingTitle.validate(value, id);
  validateRecovery(value, id, titleRecovery);
  validateObservations(value, id);
}
function validateRecovery(value, id, titleRecovery) {
  const targets = new Map(value.targets.map(item => [item.file, item])); let previous = '';
  for (const item of value.recovery) {
    if (!fields(item, ['file', 'format', 'transaction', 'captureId', 'sourceHash', 'revisionId', 'sourceGeneration']) || !safe(item.file) || !safe(item.transaction) || item.file <= previous || !formats.includes(item.format) || item.captureId !== id || item.sourceHash !== value.sourceHash || !uuid(item.revisionId) || !(item.sourceGeneration === null || uuid(item.sourceGeneration)) || !targets.has(item.file)) fail();
    previous = item.file;
    const journal = value.recovery.find(peer => peer.file === item.transaction);
    if (!journal || journal.format !== 'transaction' || journal.transaction !== journal.file || journal.revisionId !== item.revisionId || journal.sourceGeneration !== item.sourceGeneration || targets.get(journal.file)?.kind !== 'source-recovery') fail();
    if (item.format === 'source-backup' ? targets.get(item.file).kind !== 'source-backup' : targets.get(item.file).kind !== 'source-recovery' && !(item.format === 'incoming-snapshot' && targets.get(item.file).kind === 'snapshot')) fail();
  }
  for (const item of value.targets) {
    if (item.kind === 'source-recovery' && value.recovery.filter(entry => entry.file === item.file).length + pendingTitle.sidecars(titleRecovery).filter(file => file === item.file).length !== 1) fail();
    if (item.peers !== undefined) {
      if (!Array.isArray(item.peers) || item.peers.length < 2 || item.peers.length > 2 || !item.peers.includes(item.file) || !equal(item.peers, [...new Set(item.peers)].sort())) fail();
      for (const file of item.peers) {
        const peer = targets.get(file);
        if (!peer || !equal(peer.peers, item.peers) || ['dev', 'ino', 'sha256', 'bytes'].some(key => peer[key] !== item[key])) fail();
      }
      if (!knownPair(value, item.peers)) fail();
    }
  }
  const pointerKinds = new Set(); let previousKind = '';
  for (const item of value.recoveryPointers) {
    if (!fields(item, ['kind', 'journal', 'sha256', 'captureConflictSha256']) || !['blocks', 'pending'].includes(item.kind) || pointerKinds.has(item.kind) || item.kind <= previousKind || !sha(item.sha256) || !(item.captureConflictSha256 === null || sha(item.captureConflictSha256)) || !value.recovery.some(entry => entry.file === item.journal && entry.format === 'transaction')) fail();
    pointerKinds.add(item.kind); previousKind = item.kind;
  }
}
function validateObservations(value, id) {
  let previous = '';
  for (const item of value.purgedProducerAttempts) {
    if (!fields(item, ['identity', 'fingerprint', 'sourceHash', 'captureId', 'revisionId', 'sourceGeneration', 'operationId']) || typeof item.identity !== 'string' || !/^(?:[a-f0-9]{64}:[a-f0-9]{32}|finalization:[a-f0-9]{32})$/.test(item.identity) || item.identity <= previous || !sha(item.fingerprint) || item.sourceHash !== value.sourceHash || item.captureId !== id || !uuid(item.revisionId) || !(item.sourceGeneration === null || uuid(item.sourceGeneration)) || !uuid(item.operationId)) fail();
    previous = item.identity;
  }
  for (const prior of value.history || []) for (const item of prior.purgedProducerAttempts || []) if (!value.purgedProducerAttempts.some(current => equal(current, item))) fail();
}
function knownPair(authority, files) {
  const descriptors = files.map(file => authority.recovery.find(item => item.file === file));
  if (descriptors.every(item => item?.format === 'transaction') && descriptors[0].revisionId === descriptors[1].revisionId && descriptors[0].sourceGeneration === descriptors[1].sourceGeneration) return true;
  if (descriptors.every(Boolean) && descriptors[0].transaction === descriptors[1].transaction) {
    const kinds = descriptors.map(item => item.format).sort().join(',');
    if (['incoming-snapshot,snapshot-stage', 'transaction,transaction'].includes(kinds)) return true;
  }
  const capture = files.find(file => authority.targets.find(item => item.file === file)?.kind === 'capture');
  return !!capture && descriptors.some(item => item && ['source-backup', 'capture-stage'].includes(item.format));
}
function layout(intake, authority, item) {
  const directory = relative(intake, intake.dir), suffix = /^(?:conflict|pending)-([a-f0-9-]{36})(?:-([a-f0-9-]{36}))?\.json$/.exec(path.posix.basename(item.transaction));
  const journal = path.posix.basename(item.transaction);
  if (item.transaction !== `${directory}/${journal}` || journal !== 'transaction.json' && (!suffix || suffix[1] !== item.revisionId || !uuid(suffix[1]) || suffix[2] !== undefined && !uuid(suffix[2]))) fail();
  const resolution = suffix?.[2], revision = item.revisionId;
  const expected = {
    transaction: item.transaction,
    'capture-stage': `${directory}/${revision}.stage`,
    'snapshot-stage': `${directory}/${revision}.snapshot.stage`,
    'incoming-snapshot': relative(intake, path.join(intake.vault.root, 'Revisions', revision + '.json')),
    'source-backup': `${directory}/${item.captureId}-${revision}.before${resolution ? `-${resolution}` : ''}.md`
  };
  if (item.file !== expected[item.format] || item.sourceHash !== authority.sourceHash) fail();
}
async function leaf(intake, file, kind) {
  await intake.vault.contained(file);
  const before = await fs.lstat(file, { bigint: true });
  if (!before.isFile() || before.isSymbolicLink()) fail();
  const bytes = await fs.readFile(file), after = await fs.lstat(file, { bigint: true });
  if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size || before.mtimeNs !== after.mtimeNs || before.nlink !== after.nlink || BigInt(bytes.length) !== after.size) fail();
  return { target: { file: relative(intake, file), sha256: hash(bytes), dev: String(before.dev), ino: String(before.ino), bytes: String(bytes.length), kind }, bytes, nlink: Number(after.nlink) };
}
function normalizedDraft(revision, capture, sourceHash) {
  if (!fields(revision, ['schema', 'id', 'captureId', 'importedAt', 'sourceHash', 'identity', 'fingerprint', 'run', 'evidence', 'target', 'text', 'locator', 'humanReview', 'extraction', 'uncertainty']) || revision.schema !== 1 || !uuid(revision.id) || revision.captureId !== capture.id || revision.sourceHash !== sourceHash || !date(revision.importedAt) || !sha(revision.fingerprint) || typeof revision.locator !== 'string' || revision.humanReview !== 'unreviewed') fail();
  const run = revision.run;
  knownRun(run);
  // Finalized provenance permits failed/conservative runs; a ready draft does not.
  if (run.input_sha256 !== sourceHash || revision.identity !== `${run.job_id}:${run.attempt_id}` || revision.evidence?.clip_id !== run.job_id || !['local_video', 'synthetic_fixture'].includes(run.input_kind) || run.result_kind !== (run.input_kind === 'local_video' ? 'local_video_unreviewed' : 'synthetic_video_wiring') || !['complete', 'partial'].includes(run.state) || run.validation !== 'passed' || run.draft_mode !== undefined && run.draft_mode !== 'bound_excerpts_v1') fail();
  validate(revision.evidence, revision.target);
  if (run.draft_mode === 'bound_excerpts_v1') bound(revision.evidence, revision.target);
  if (revision.text !== render(revision.evidence, revision.target) || revision.extraction !== revision.target.status || run.state !== (revision.target.status === 'complete' ? 'complete' : 'partial')) fail();
  const uncertainty = { channels: revision.evidence.channels, truncated: revision.evidence.truncated, uncertainEvidence: revision.evidence.evidence.filter(item => item.review_flag === 'uncertain').map(item => item.id), unknowns: revision.target.unknowns, conflicts: revision.target.conflicts };
  if (!equal(revision.uncertainty, uncertainty)) fail();
}
function selectionTransaction(tx, ledger, capture, sourceHash, revisions) {
  if (!fields(tx, ['schema', 'publicationVersion', 'previousProof', 'journalIdentity', 'resolution', 'retainOnly', 'key', 'sourceHash', 'capture', 'revision', 'content', 'previousHash', 'previous', 'backup', 'sourceGeneration']) || !uuid(tx.resolution) || tx.retainOnly !== false || tx.sourceHash !== sourceHash || tx.revision.id === capture.currentRevision || !fields(tx.capture, ['id', 'file', 'relative', 'capturedAt', 'title', 'currentRevision', 'reviewed', 'rejected', 'supportEligible', 'revisions', 'updatedAt', 'currentHash', 'reviewChoices', 'selectionHistory']) || !date(tx.capture.updatedAt)) fail();
  const block = ledger.blocks[sourceHash], pending = ledger.pending[sourceHash], outcome = ledger.outcomes[tx.key];
  if (block === undefined) {
    // The native destination-to-backup rename failed before capture staging.
    // Bind only that deferred selection; deleting it does not complete it.
    const reason = 'Capture destination is locked or inaccessible. Existing content and incoming revision were preserved. Fix file access, then Check now to retry.';
    if (!fields(pending, ['reason', 'journal', 'key']) || pending.reason !== reason || pending.journal !== `pending-${tx.revision.id}-${tx.resolution}.json` || pending.key !== tx.key || capture.conflict !== undefined || !isDeepStrictEqual(outcome, { status: 'held', reason, locator: tx.revision.locator, sourceHash, pendingRevision: tx.revision.id })) fail();
  } else {
    const journal = `conflict-${tx.revision.id}-${tx.resolution}.json`;
    if (!fields(block, ['reason', 'journal', 'incomingRevision', 'outputHold']) || typeof block.reason !== 'string' || block.journal !== journal || block.incomingRevision !== tx.revision.id || capture.conflict !== block.reason || !isDeepStrictEqual(outcome, { status: 'held', reason: block.reason, locator: tx.revision.locator, sourceHash, pendingRevision: tx.revision.id })) fail();
  }
  const authority = ledger.sourceAuthority?.[capture.id];
  if (tx.sourceGeneration !== (authority?.phase === 'active' ? authority.generation : undefined)) fail();
  const { revisionAdmission } = require('./source-authority'), { noteText } = require('./intake');
  const admitted = revision => {
    if (!revision?.review || !capture.revisions.includes(revision.id)) fail();
    validateNormalizedReview(revision, capture.id, sourceHash);
    const known = revisionAdmission(ledger, revision.id), accepted = ledger.attempts[revision.identity];
    if (!known || known.status !== 'imported' || known.revision !== revision.id || known.captureId !== capture.id || known.sourceHash !== sourceHash || known.identity !== revision.identity || known.fingerprint !== revision.fingerprint || known.snapshotHash !== hash(JSON.stringify(revision, null, 2)) || known.sourceGeneration !== tx.sourceGeneration || !accepted || accepted.status !== 'imported' || accepted.captureId !== capture.id || accepted.sourceHash !== sourceHash || accepted.fingerprint !== revision.fingerprint) fail();
    return known;
  };
  const current = revisions.get(capture.currentRevision), selected = revisions.get(tx.revision.id);
  admitted(current); const admission = admitted(selected);
  if (!isDeepStrictEqual(tx.revision, selected) || capture.reviewed !== true || capture.rejected !== (current.humanReview === 'reject')) fail();
  if (capture.selectionHistory !== undefined && (!Array.isArray(capture.selectionHistory) || capture.selectionHistory.some(item => !fields(item, ['revision', 'selectedAt']) || !uuid(item.revision) || !capture.revisions.includes(item.revision) || !date(item.selectedAt)))) fail();
  const expected = { ...capture, currentRevision: selected.id, reviewed: true, rejected: selected.humanReview === 'reject', supportEligible: selected.supportEligible !== false, reviewChoices: [], updatedAt: tx.capture.updatedAt, currentHash: hash(tx.content), selectionHistory: [...(capture.selectionHistory || []), { revision: selected.id, selectedAt: tx.capture.updatedAt }] };
  // archiveConflict adds this one field after selection was staged; its exact
  // pointer/reason binding above is retired only by the committed deletion.
  delete expected.conflict;
  if (!isDeepStrictEqual(tx.capture, expected) || tx.previous !== noteText(capture, current) || tx.previousHash !== capture.currentHash || tx.content !== noteText(expected, selected)) fail();
  return admission;
}
function transaction(intake, tx, ledger, capture, sourceHash, revisions, journal) {
  intake.validateTransaction(tx, journal);
  if (tx.revision.review !== undefined) validateNormalizedReview(tx.revision, capture.id, sourceHash); else normalizedDraft(tx.revision, capture, sourceHash);
  if (tx.resolution !== undefined) return selectionTransaction(tx, ledger, capture, sourceHash, revisions);
  const retainOnly = tx.retainOnly === true;
  if (!fields(tx, ['schema', 'publicationVersion', 'previousProof', 'journalIdentity', 'externalConflict', 'retainOnly', 'key', 'sourceHash', 'capture', 'revision', 'content', 'previousHash', 'previous', 'backup', 'sourceGeneration']) || tx.sourceHash !== sourceHash || tx.externalConflict !== false || typeof tx.retainOnly !== 'boolean' || !fields(tx.capture, ['id', 'file', 'relative', 'capturedAt', 'title', 'currentRevision', 'reviewed', 'rejected', 'supportEligible', 'revisions', 'updatedAt', 'currentHash', ...(retainOnly ? ['reviewChoices'] : [])]) || tx.capture.id !== capture.id || tx.capture.file !== capture.file || tx.capture.relative !== capture.relative || tx.capture.capturedAt !== capture.capturedAt || tx.capture.title !== capture.title || !date(tx.capture.updatedAt) || tx.capture.currentRevision !== (retainOnly ? capture.currentRevision : tx.revision.id) || !Array.isArray(tx.capture.revisions) || !equal(tx.capture.revisions, [...capture.revisions.filter(id => id !== tx.revision.id), tx.revision.id])) fail();
  const authority = ledger.sourceAuthority?.[capture.id];
  if (tx.sourceGeneration !== (authority?.phase === 'active' ? authority.generation : undefined)) fail();
  const accepted = ledger.attempts[tx.revision.identity];
  if (accepted && (accepted.fingerprint !== tx.revision.fingerprint || accepted.captureId !== capture.id || accepted.sourceHash !== sourceHash)) fail();
  const { noteText } = require('./intake');
  if (retainOnly) {
    const current = revisions.get(capture.currentRevision), known = require('./source-authority').revisionAdmission(ledger, capture.currentRevision);
    if (capture.reviewed !== true || !current?.review || !known || known.status !== 'imported' || known.captureId !== capture.id || known.sourceHash !== sourceHash || known.identity !== current.identity || known.fingerprint !== current.fingerprint || known.snapshotHash !== hash(JSON.stringify(current, null, 2)) || known.sourceGeneration !== tx.sourceGeneration) fail();
    validateNormalizedReview(current, capture.id, sourceHash);
    if (capture.reviewChoices !== undefined && (!Array.isArray(capture.reviewChoices) || new Set(capture.reviewChoices).size !== capture.reviewChoices.length || capture.reviewChoices.some(id => !uuid(id) || !capture.revisions.includes(id)))) fail();
    const choices = tx.revision.review ? [...new Set([...(capture.reviewChoices || []), capture.currentRevision, tx.revision.id])] : capture.reviewChoices;
    if (tx.capture.reviewed !== capture.reviewed || capture.rejected !== (current.humanReview === 'reject') || tx.capture.rejected !== capture.rejected || tx.capture.supportEligible !== (tx.revision.review ? false : capture.supportEligible) || !equal(tx.capture.reviewChoices, choices) || tx.content !== tx.previous || tx.previousHash !== capture.currentHash || tx.capture.currentHash !== capture.currentHash || tx.content !== noteText(capture, current)) fail();
  } else if (tx.capture.reviewed !== !!tx.revision.review || tx.capture.rejected !== (tx.revision.humanReview === 'reject') || tx.capture.supportEligible !== (tx.revision.supportEligible !== false)) fail();
  if (tx.previous !== null && ![...revisions.values()].some(revision => noteText(capture, revision) === tx.previous)) fail();
  const admission = require('./source-authority').revisionAdmission(ledger, tx.revision.id);
  if (admission && (admission.snapshotHash !== hash(JSON.stringify(tx.revision, null, 2)) || admission.captureId !== capture.id || admission.sourceHash !== sourceHash || admission.identity !== tx.revision.identity || admission.fingerprint !== tx.revision.fingerprint)) fail();
  return admission;
}
const exact = (value, names) => fields(value, names) && names.every(key => Object.hasOwn(value, key));
function compact(bytes) {
  const content = text(bytes); let value;
  try { value = JSON.parse(content); } catch { fail(); }
  if (JSON.stringify(value) !== content || !Buffer.from(content, 'utf8').equals(bytes)) fail();
  return value;
}
async function absent(file) {
  try { await fs.lstat(file); fail(); } catch (error) { if (error.code !== 'ENOENT') throw error; }
}
function accountDetachedLeaf(proof, value) {
  const known = proof.special.find(item => item.target.file === value.target.file);
  if (!known) return false;
  if (value.nlink !== 1 || ['file', 'sha256', 'dev', 'ino', 'bytes'].some(key => known.target[key] !== value.target[key])) fail();
  return true;
}
async function readDetachedEditor(intake, ledger, capture, sourceHash, note) {
  const block = ledger.blocks[sourceHash], { noteText } = require('./intake');
  const reason = 'Restored capture backup changed. Independent editor writing was preserved; this source remains paused for explicit conflict repair.';
  const witness = block?.outputHold;
  const keys = ['reason', 'journal', 'incomingRevision', 'detachHold', ...(witness === undefined ? [] : ['outputHold'])];
  if (!exact(block, keys) || !exact(block.detachHold, ['journal', 'reason', 'evidence']) || block.reason !== reason || block.detachHold.reason !== reason || capture.conflict !== reason || ledger.pending[sourceHash]) fail();
  if (!uuid(capture.id) || !uuid(capture.currentRevision) || capture.file !== capture.id + '.md' || note.file !== intake.destination(capture) || note.id !== capture.id || note.type !== 'reel_import' || note.title !== capture.title || note.capturedAt !== capture.capturedAt || capture.reviewed !== false || capture.rejected !== false || capture.supportEligible !== true || !equal(capture.revisions, [capture.currentRevision]) || !fields(capture, ['id', 'file', 'relative', 'capturedAt', 'title', 'currentRevision', 'reviewed', 'rejected', 'supportEligible', 'revisions', 'updatedAt', 'currentHash', 'conflict']) || !date(capture.capturedAt) || !date(capture.updatedAt)) fail();
  const current = await leaf(intake, note.file, 'capture'), snapshot = await leaf(intake, path.join(intake.vault.root, 'Revisions', capture.currentRevision + '.json'), 'snapshot');
  const admitted = JSON.parse(text(snapshot.bytes)); normalizedDraft(admitted, capture, sourceHash);
  const known = require('./source-authority').revisionAdmission(ledger, admitted.id), accepted = ledger.attempts[admitted.identity];
  const generation = ledger.sourceAuthority?.[capture.id]?.phase === 'active' ? ledger.sourceAuthority[capture.id].generation : undefined;
  if (admitted.id !== capture.currentRevision || !snapshot.bytes.equals(Buffer.from(JSON.stringify(admitted, null, 2))) || !known || known.status !== 'imported' || known.revision !== admitted.id || known.captureId !== capture.id || known.sourceHash !== sourceHash || known.identity !== admitted.identity || known.fingerprint !== admitted.fingerprint || known.snapshotHash !== snapshot.target.sha256 || known.sourceGeneration !== generation || !accepted || accepted.status !== 'imported' || accepted.captureId !== capture.id || accepted.sourceHash !== sourceHash || accepted.identity !== admitted.identity || accepted.fingerprint !== admitted.fingerprint) fail();
  const canonical = noteText(capture, admitted);
  if (current.nlink !== 1 || snapshot.nlink !== 1 || current.target.sha256 !== capture.currentHash || !current.bytes.equals(Buffer.from(canonical)) || note.content !== canonical) fail();
  if (!uuid(block.incomingRevision) || block.incomingRevision === admitted.id || block.journal !== `conflict-${block.incomingRevision}.json`) fail();
  const journal = await leaf(intake, path.join(intake.dir, block.journal), 'source-recovery'), tx = compact(journal.bytes);
  const revisions = new Map([[admitted.id, admitted]]);
  transaction(intake, tx, ledger, capture, sourceHash, revisions, journal.target);
  if (journal.nlink !== 1 || tx.revision.id !== block.incomingRevision || tx.revision.review !== undefined || tx.resolution !== undefined || tx.externalConflict !== false || tx.retainOnly !== false || tx.previous !== canonical || tx.previousHash !== capture.currentHash || tx.content !== noteText(tx.capture, tx.revision) || tx.capture.currentHash !== hash(tx.content) || tx.capture.updatedAt !== tx.revision.importedAt || ledger.attempts[tx.revision.identity] || ledger.admissions?.[tx.revision.id]) fail();
  if (witness !== undefined) {
    const matches = (proof, target) => exact(proof, ['dev', 'ino', 'digest']) &&
      proof.dev === target.dev && proof.ino === target.ino && proof.digest === target.sha256;
    if (!exact(witness, ['journal', 'pending', 'committed', 'mode', 'rollback']) || witness.mode !== 'precommit-conflict' ||
        !intake.validOutputHold(witness, `pending-${tx.revision.id}.json`, tx.previousHash) ||
        !matches(witness.journal, journal.target) || !matches(witness.rollback?.proof, current.target)) fail();
    const parents = [...requiredDirectories(intake, [current.target])].map(directory => path.join(intake.vault.vault, directory));
    ordinaryDirectories(parents, 'Source recovery parent identity changed. All files were preserved.', witness.rollback.directories);
  }
  const producer = ledger.sources.find(item => item.id === tx.key.split(':')[0]);
  if (!producer || (producer.kind || 'draft') !== 'draft' || !matchesProducerOutcome(producer, tx.key, tx.revision.locator)) fail();
  const outcome = ledger.outcomes[tx.key];
  if (!exact(outcome, ['status', 'reason', 'locator', 'checkedAt']) || outcome.status !== 'held' || outcome.reason !== reason || outcome.locator !== tx.revision.locator || !date(outcome.checkedAt)) fail();
  const prefix = `${capture.id}-${tx.revision.id}.before.md`, heldPrefix = prefix + '.detach.json.held-';
  if (tx.backup !== prefix || typeof block.detachHold.journal !== 'string' || !block.detachHold.journal.startsWith(heldPrefix) || !uuid(block.detachHold.journal.slice(heldPrefix.length))) fail();
  const hold = await leaf(intake, path.join(intake.dir, block.detachHold.journal), 'mixed-recovery'), wrapper = compact(hold.bytes);
  if (!exact(wrapper, ['schema', 'intentBytes', 'evidence']) || wrapper.schema !== 1 || typeof wrapper.intentBytes !== 'string') fail();
  const intent = compact(Buffer.from(wrapper.intentBytes));
  if (!exact(intent, ['schema', 'id', 'sourceHash', 'captureId', 'file', 'journal', 'journalHash', 'backup', 'previousHash', 'dev', 'ino', 'stageDev', 'stageIno']) || intent.schema !== 1 || !uuid(intent.id) || intent.id !== block.detachHold.journal.slice(heldPrefix.length) || intent.sourceHash !== sourceHash || intent.captureId !== capture.id || intent.file !== capture.relative || intent.journal !== block.journal || intent.journalHash !== journal.target.sha256 || intent.backup !== tx.backup || intent.previousHash !== capture.currentHash || [intent.dev, intent.ino, intent.stageDev, intent.stageIno].some(value => typeof value !== 'string' || !/^[0-9]+$/.test(value)) || intent.dev !== current.target.dev || intent.ino !== current.target.ino) fail();
  const source = await leaf(intake, path.join(intake.dir, prefix + '.independent'), 'mixed-recovery');
  const retained = await leaf(intake, path.join(intake.dir, prefix + '.detached-' + intent.id), 'mixed-recovery');
  if (tx.publicationVersion === 1) {
    const detach = stageRecord(ledger, sourceHash, fileProof(journal.target))?.detach;
    if (detach?.intent.digest !== hash(wrapper.intentBytes) || !matchesProof(detach?.stage, fileProof(source.target))) fail();
  }
  const whole = text(retained.bytes);
  if (![hold, source, retained].every(value => value.nlink === 1) || source.target.dev !== intent.stageDev || source.target.ino !== intent.stageIno || !source.bytes.equals(current.bytes) || !Buffer.from(whole, 'utf8').equals(retained.bytes) || retained.bytes.equals(current.bytes) || new Set([current, snapshot, journal, hold, source, retained].map(value => value.target.dev + ':' + value.target.ino)).size !== 6) fail();
  const evidence = [{ role: 'independent-editor-writing', file: path.basename(retained.target.file), hash: retained.target.sha256 }, { role: 'original-source-copy', file: path.basename(source.target.file), hash: capture.currentHash }];
  if (!isDeepStrictEqual(wrapper.evidence, evidence) || !isDeepStrictEqual(block.detachHold.evidence, evidence)) fail();
  await absent(path.join(intake.dir, prefix)); await absent(path.join(intake.dir, prefix + '.detach.json'));
  return { block, current, snapshot, journal, source, retained, hold, intent, known, outcome, tx, generation, revisions, whole, special: [source, retained, hold] };
}
async function inventoryDetachedEditor(intake, ledger, capture, sourceHash, note) {
  const proof = await readDetachedEditor(intake, ledger, capture, sourceHash, note);
  const result = await inventorySources(intake, ledger, capture, sourceHash, proof.revisions, [proof.current.target, proof.snapshot.target], proof);
  if (result.targets.length !== 9 || result.titleProofs.length || result.recovery.length !== 4 || result.recoveryPointers.length !== 1 || result.observations.length !== 1) fail();
  for (const value of [proof.current, proof.snapshot, proof.journal]) if (!result.targets.some(item => isDeepStrictEqual(item, value.target))) fail();
  for (const value of proof.special) {
    const fresh = await leaf(intake, path.join(intake.vault.vault, value.target.file), 'mixed-recovery');
    if (!accountDetachedLeaf(proof, fresh) || !result.targets.some(item => isDeepStrictEqual(item, fresh.target))) fail();
  }
  return { ...result, detachedEditor: proof };
}
async function inventory(intake, ledger, capture, sourceHash, revisions, initial) {
  return inventorySources(intake, ledger, capture, sourceHash, revisions, initial);
}
async function independentAnnotationHolds(intake, id, sourceHash) {
  const independent = new Map();
  for (const name of (await fs.readdir(intake.dir)).filter(name => isAnnotationIntent(name) && name !== activeAnnotationIntent)) {
    const value = await leaf(intake, path.join(intake.dir, name), 'annotation-intent');
    if (!mentions(value.bytes, id, sourceHash)) continue;
    const intent = compact(value.bytes);
    try { intake.validateAnnotationIntent(intent); } catch { fail(); }
    if (name !== heldAnnotationIntent(intent.id) || !intent.annotationProof || value.nlink !== 1 ||
        intent.intentIdentity.dev !== value.target.dev || intent.intentIdentity.ino !== value.target.ino) fail();
    const stage = `annotation-${intent.id}.stage`;
    const staged = await leaf(intake, path.join(intake.dir, stage), 'annotation-stage').catch(error => {
      if (error.code === 'ENOENT') return null;
      throw error;
    });
    if (staged && (staged.target.dev !== intent.annotationProof.dev || staged.target.ino !== intent.annotationProof.ino ||
        staged.target.sha256 !== intent.annotationProof.digest)) fail();
    independent.set(name, value);
    if (staged) independent.set(stage, staged);
  }
  return independent;
}
async function inventorySources(intake, ledger, capture, sourceHash, revisions, initial, detachedEditor = null) {
  if (ledger.acceptedCleanup?.sourceHash === sourceHash) fail();
  const pending = await pendingTitle.inventory(intake, ledger, capture, sourceHash, revisions, initial);
  if (pending) initial = pending.targets;
  const titles = await sourceTitle.inventory(intake, ledger, capture, revisions, initial); initial = titles.targets;
  const targets = new Map(initial.map(item => [item.file, item])), recovery = [], observations = [], transactions = new Map(), expected = new Map();
  const { noteText } = require('./intake'), current = revisions.get(capture.currentRevision);
  if (!current || !pending && !titles.verifiedCurrent && !initial.some(item => item.kind === 'capture' && item.sha256 === hash(noteText(capture, current)))) fail();
  const entries = [], independent = await independentAnnotationHolds(intake, capture.id, sourceHash);
  for (const name of (await fs.readdir(intake.dir)).sort()) {
    if (name === 'ledger.json') continue;
    if (pending?.titleRecovery.intent === relative(intake, path.join(intake.dir, name))) continue;
    const file = path.join(intake.dir, name), value = await leaf(intake, file, 'source-recovery');
    const held = independent.get(name);
    if (held) {
      if (held.nlink !== value.nlink || ['dev', 'ino', 'sha256'].some(key => held.target[key] !== value.target[key])) fail();
      continue;
    }
    if (detachedEditor && accountDetachedLeaf(detachedEditor, value)) {
      targets.set(value.target.file, { ...value.target, kind: 'mixed-recovery' }); continue;
    }
    if (!mentions(value.bytes, capture.id, sourceHash)) continue;
    entries.push({ name, file, value, text: text(value.bytes) });
  }
  for (const entry of entries.filter(item => item.name === 'transaction.json' || /^(?:conflict|pending)-[a-f0-9-]{36}(?:-[a-f0-9-]{36})?\.json$/.test(item.name))) {
    const tx = JSON.parse(entry.text);
    // publishJournal writes JSON.stringify(tx); conflict/pending archives link
    // those exact bytes. Do not discard duplicate-key or formatting payloads.
    if (!entry.value.bytes.equals(Buffer.from(JSON.stringify(tx), 'utf8'))) fail();
    const admission = transaction(intake, tx, ledger, capture, sourceHash, revisions, entry.value.target), journal = relative(intake, entry.file);
    const deferredSelection = tx.resolution !== undefined && ledger.blocks[sourceHash] === undefined;
    if (deferredSelection && (entry.name !== ledger.pending[sourceHash].journal || !entries.some(item => item.name === tx.revision.id + '.snapshot.stage') || entries.some(item => [tx.revision.id + '.stage', tx.backup].includes(item.name)))) fail();
    const descriptor = { transaction: journal, captureId: capture.id, sourceHash, revisionId: tx.revision.id, sourceGeneration: tx.sourceGeneration || null };
    const owned = tx.publicationVersion === 1 ? stageRecord(ledger, sourceHash, fileProof(entry.value.target)) : undefined;
    const add = (file, format, content, kind = 'source-recovery', role) => {
      const item = { file: relative(intake, file), format, ...descriptor }; layout(intake, { sourceHash }, item);
      if (titles.proofFiles.has(item.file)) fail();
      const prior = expected.get(item.file);
      if (prior && (prior.content !== content || prior.item.revisionId !== item.revisionId || prior.item.sourceGeneration !== item.sourceGeneration)) fail();
      // A live transaction/archive pair shares one canonical transaction descriptor.
      const claim = prior || { item, content, kind, proofs: [] };
      if (role && tx.publicationVersion === 1) claim.proofs.push(owned?.[role]);
      if (!prior) expected.set(item.file, claim);
    };
    add(entry.file, 'transaction', entry.text);
    add(path.join(intake.dir, tx.revision.id + '.stage'), 'capture-stage', tx.content, 'source-recovery', 'captureStage');
    add(path.join(intake.dir, tx.revision.id + '.snapshot.stage'), 'snapshot-stage', JSON.stringify(tx.revision, null, 2), 'source-recovery', 'snapshotStage');
    add(path.join(intake.vault.root, 'Revisions', tx.revision.id + '.json'), 'incoming-snapshot', JSON.stringify(tx.revision, null, 2), admission ? 'snapshot' : 'source-recovery', admission ? undefined : 'snapshotStage');
    if (tx.previous !== null) add(path.join(intake.dir, tx.backup), 'source-backup', tx.previous, 'source-backup', 'backup');
    transactions.set(journal, tx);
    if (!admission) observations.push({ identity: tx.revision.identity, fingerprint: tx.revision.fingerprint, sourceHash, captureId: capture.id, revisionId: tx.revision.id, sourceGeneration: tx.sourceGeneration || null });
  }
  // Completed title before-files must match the first guarded observation;
  // other legacy before-files retain the exact admitted-snapshot renderer.
  const observedTitleBackups = new Set();
  for (const entry of entries) if (!expected.has(relative(intake, entry.file))) {
    const proven = titles.sourceBackups.get(relative(intake, entry.file));
    if (proven) {
      // A completed title path grants no filename exemption. The second
      // observation must be the exact bytes and ordinary physical leaf proved.
      if (entry.name !== path.posix.basename(proven.target.file) || !entry.value.bytes.equals(proven.bytes) || entry.value.nlink !== 1 || ['file', 'sha256', 'dev', 'ino', 'bytes'].some(key => entry.value.target[key] !== proven.target[key])) fail();
      observedTitleBackups.add(proven.target.file); targets.set(proven.target.file, proven.target); continue;
    }
    if (!new RegExp(`^${capture.id}-[a-f0-9-]{36}\\.before(?:-[a-f0-9-]{36})?\\.md$`).test(entry.name)) fail();
    const { parse } = require('./vault'), { noteText } = require('./intake'); const note = parse(entry.text);
    if (!note || note.id !== capture.id || ![...revisions.values()].some(revision => entry.value.bytes.equals(Buffer.from(noteText({ ...capture, title: note.title, capturedAt: note.capturedAt }, revision), 'utf8'))) || entry.value.nlink !== 1) fail();
    targets.set(relative(intake, entry.file), { ...entry.value.target, kind: 'source-backup' });
  }
  if (observedTitleBackups.size !== titles.sourceBackups.size) fail();
  for (const { item, content, kind, proofs } of expected.values()) {
    let value; try { value = await leaf(intake, path.join(intake.vault.vault, item.file), kind); } catch (error) { if (error.code === 'ENOENT') continue; throw error; }
    if (!value.bytes.equals(Buffer.from(content, 'utf8'))) fail();
    if (proofs.length && !proofs.some(proof => matchesProof(fileProof(value.target), proof))) fail();
    targets.set(item.file, value.target); recovery.push(item);
  }
  // Every present descriptor must point at a present, strictly classified journal.
  const recoveryPointers = [];
  for (const kind of ['blocks', 'pending']) {
    const pointer = ledger[kind][sourceHash]; if (!pointer) continue;
    const journal = relative(intake, path.join(intake.dir, pointer.journal || ''));
    const tx = transactions.get(journal);
    if (!tx || kind === 'blocks' && (!(detachedEditor ? isDeepStrictEqual(pointer, detachedEditor.block) : fields(pointer, ['reason', 'journal', 'incomingRevision', 'outputHold'])) || pointer.incomingRevision !== tx.revision.id || capture.conflict !== pointer.reason) || kind === 'pending' && (!fields(pointer, ['reason', 'journal', 'key']) || pointer.key !== tx.key) || typeof pointer.reason !== 'string' || capture.conflict !== undefined && typeof capture.conflict !== 'string') fail();
    if (kind === 'blocks' && pointer.outputHold !== undefined) {
      const held = pointer.outputHold, target = targets.get(journal);
      const pending = `pending-${tx.revision.id}${tx.resolution ? `-${tx.resolution}` : ''}.json`;
      if (!target || !intake.validOutputHold(held, pending, tx.previousHash) || held.journal.dev !== target.dev ||
          held.journal.ino !== target.ino || held.journal.digest !== target.sha256) fail();
    }
    recoveryPointers.push({ kind, journal, sha256: hash(JSON.stringify(pointer)), captureConflictSha256: capture.conflict === undefined ? null : hash(capture.conflict) });
  }
  const result = [...targets.values()].sort((a, b) => a.file.localeCompare(b.file)), proof = { targets: result, recovery };
  for (const name of await fs.readdir(path.join(intake.vault.root, 'Revisions'))) {
    const file = path.join(intake.vault.root, 'Revisions', name), value = await leaf(intake, file, 'snapshot');
    if (mentions(value.bytes, capture.id, sourceHash) && !targets.has(relative(intake, file))) fail();
  }
  const groups = new Map();
  for (const item of result) { const key = `${item.dev}:${item.ino}`; if (!groups.has(key)) groups.set(key, []); groups.get(key).push(item); }
  for (const group of groups.values()) if (group.length > 1) {
    const peers = group.map(item => item.file).sort();
    if (group.some(item => titles.proofFiles.has(item.file)) || group.length !== 2 || !knownPair(proof, peers) || group.some(item => item.sha256 !== group[0].sha256 || item.bytes !== group[0].bytes)) fail();
    for (const item of group) item.peers = peers;
  }
  await inspectTargets(intake, { targets: result, recovery, sourceHash });
  if (pending) await pendingTitle.inspect(intake, ledger, { inventoryVersion: 2, sourceHash, targets: result, originGenerations: ledger.sourceAuthority?.[capture.id] ? [{ captureId: capture.id, generation: ledger.sourceAuthority[capture.id].generation }] : [], titleRecovery: pending.titleRecovery });
  return { targets: result, recovery: recovery.sort((a, b) => a.file < b.file ? -1 : a.file > b.file ? 1 : 0), recoveryPointers, observations, titleProofs: titles.titleProofs, ...(pending ? { titleRecovery: pending.titleRecovery } : {}) };
}
async function inspectTargets(intake, authority) {
  for (const item of authority.recovery || []) layout(intake, authority, item);
  const present = new Map();
  for (const target of authority.targets) {
    let value; try { value = await leaf(intake, path.join(intake.vault.vault, target.file), target.kind); } catch (error) { if (error.code === 'ENOENT') continue; throw error; }
    if (['file', 'kind', 'sha256', 'dev', 'ino', 'bytes'].some(key => value.target[key] !== target[key])) fail();
    present.set(target.file, value);
  }
  for (const target of authority.targets) if (present.has(target.file)) {
    const peers = target.peers || [target.file], survivors = peers.filter(file => present.has(file));
    if (present.get(target.file).nlink !== survivors.length) fail();
  }
  return authority.targets.filter(item => present.has(item.file));
}
async function inspectTarget(intake, authority, target) {
  const peers = new Set(target.peers || [target.file]);
  const remaining = await inspectTargets(intake, { ...authority, targets: authority.targets.filter(item => peers.has(item.file)) });
  if (!remaining.some(item => item.file === target.file)) fail();
  return remaining;
}
function inspectPointers(ledger, authority) {
  if (authority.mixedRecovery) return require('./mixed-deletion').inspectPointers(ledger, authority);
  const capture = ledger.captures[authority.sourceHash];
  for (const item of authority.recoveryPointers || []) {
    const pointer = ledger[item.kind][authority.sourceHash];
    if ((capture.conflict === undefined ? null : hash(capture.conflict)) !== item.captureConflictSha256) fail();
    const descriptor = authority.recovery.find(entry => entry.file === item.journal && entry.format === 'transaction');
    if (pointer && (hash(JSON.stringify(pointer)) !== item.sha256 || !fields(pointer, item.kind === 'blocks' ? ['reason', 'journal', 'incomingRevision', 'outputHold'] : ['reason', 'journal', 'key']) || typeof pointer.reason !== 'string' || path.posix.basename(item.journal) !== pointer.journal || (item.kind === 'blocks' ? pointer.incomingRevision !== descriptor.revisionId : typeof pointer.key !== 'string' || !uuid(pointer.key.split(':')[0])))) fail();
  }
  for (const kind of ['blocks', 'pending']) if (ledger[kind][authority.sourceHash] && !authority.recoveryPointers.some(item => item.kind === kind)) fail();
}
function retirePointers(ledger, authority) {
  retireStageRecords(ledger, record => record.sourceHash === authority.sourceHash);
  if (authority.mixedRecovery) return require('./mixed-deletion').retirePointers(ledger, authority);
  inspectPointers(ledger, authority);
  const capture = ledger.captures[authority.sourceHash];
  for (const item of authority.recoveryPointers || []) delete ledger[item.kind][authority.sourceHash];
  if (authority.recoveryPointers?.some(item => item.captureConflictSha256 !== null)) delete capture.conflict;
}
function purgedAttempt(ledger, draft) {
  const matches = Object.values(ledger.sourceAuthority || {}).flatMap(authority => authority.purgedProducerAttempts || []).filter(item => item.identity === draft.identity);
  for (const item of matches) if (item.fingerprint !== draft.fingerprint || item.sourceHash !== draft.sourceHash || ledger.captures[draft.sourceHash]?.id !== item.captureId) throw Error('Purged producer identity changed. Preserve its original fingerprint and source binding.');
  return matches[0];
}
module.exports = { validateInventory, inventory, inventoryDetachedEditor, independentAnnotationHolds, inspectTargets, inspectTarget, inspectPointers, retirePointers, purgedAttempt };
