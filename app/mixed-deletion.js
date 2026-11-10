const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { isDeepStrictEqual: equal } = require('node:util');
const { hash } = require('./intake-producer');
const YAML = require('yaml');
const { validateNormalizedReview } = require('./source-review');
const uuid = value => typeof value === 'string' && /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(value);
const sha = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const number = value => typeof value === 'string' && /^[0-9]+$/.test(value);
const date = value => typeof value === 'string' && /T.*(?:Z|[+-]\d\d:\d\d)$/.test(value) && Number.isFinite(Date.parse(value));
const safe = value => typeof value === 'string' && !!value && !/[\\:]/.test(value) && value.split('/').every(part => part && part !== '.' && part !== '..');
const shape = (value, required, optional = []) => value && typeof value === 'object' && !Array.isArray(value) && required.every(key => Object.hasOwn(value, key)) && Object.keys(value).every(key => required.includes(key) || optional.includes(key));
const relative = (intake, file) => path.relative(intake.vault.vault, file).split(path.sep).join('/');
const fail = detail => { throw Object.assign(Error('Retained writing needs explicit review' + (detail ? ': ' + detail : '.') + ' All remaining files were preserved.'), { code: 'SOURCE_FILE_CHANGED' }); };
const title = 'Retained whole local version';
const roles = descriptor => [
  { file: descriptor.current, role: 'current-whole' },
  { file: descriptor.originalConflict, role: 'original-content' },
  { file: descriptor.originalConflict, role: 'original-previous' },
  { file: descriptor.resolutionConflict, role: 'resolution-previous' },
  { file: descriptor.repair, role: 'repair-previous' }
];
function utf8(bytes) {
  let text; try { text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes); } catch { fail('invalid UTF-8'); }
  if (!Buffer.from(text, 'utf8').equals(bytes)) fail('UTF-8 round trip changed'); return text;
}
function receipt(value) { return shape(value, ['sha256', 'dev', 'ino', 'bytes']) && sha(value.sha256) && [value.dev, value.ino, value.bytes].every(number); }
const identity = value => ({ sha256: value.target.sha256, dev: value.target.dev, ino: value.target.ino, bytes: value.target.bytes });
const matches = (value, known) => !!value && ['sha256', 'dev', 'ino', 'bytes'].every(key => value.target[key] === known[key]);
async function leaf(intake, file, kind) {
  await intake.vault.contained(path.dirname(file));
  let before; try { before = await fs.lstat(file, { bigint: true }); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  if (!before.isFile() || before.isSymbolicLink()) fail(relative(intake, file) + ' is not an ordinary file');
  await intake.vault.contained(file);
  const handle = await fs.open(file, 'r'); let bytes;
  try {
    const opened = await handle.stat({ bigint: true });
    if (opened.dev !== before.dev || opened.ino !== before.ino || opened.nlink !== before.nlink) fail(relative(intake, file));
    bytes = await handle.readFile();
    const after = await handle.stat({ bigint: true }), current = await fs.lstat(file, { bigint: true });
    if (!current.isFile() || current.isSymbolicLink() || [after, current].some(item => ['dev', 'ino', 'size', 'mtimeNs', 'nlink'].some(key => item[key] !== before[key])) || BigInt(bytes.length) !== before.size) fail(relative(intake, file));
  } finally { await handle.close(); }
  return { bytes, nlink: Number(before.nlink), target: { file: relative(intake, file), kind, sha256: hash(bytes), dev: String(before.dev), ino: String(before.ino), bytes: String(bytes.length) } };
}
function json(value) {
  const text = utf8(value.bytes); let parsed; try { parsed = JSON.parse(text); } catch { fail(value.target.file); }
  if (JSON.stringify(parsed) !== text) fail(value.target.file + ' is not the exact writer JSON'); return parsed;
}
const descriptorFields = ['format', 'current', 'snapshot', 'originalConflict', 'resolutionConflict', 'repair', 'admittedRevision', 'incomingRevision', 'incomingIdentity', 'incomingFingerprint', 'annotationId', 'sourceGeneration', 'admissionSha256', 'pointerSha256', 'conflictSha256', 'outcomeKey', 'outcomeSha256'];
function validate(value, id) {
  const descriptor = value.mixedRecovery, plans = value.preservedWriting;
  if (descriptor === undefined && plans === undefined) {
    if (value.targets.some(item => item.kind === 'mixed-recovery')) fail('mixed targets have no proof'); return;
  }
  if (value.inventoryVersion !== 2 || value.manual || !shape(descriptor, descriptorFields) || descriptor.format !== 'kept-current-repair-v1' || !Array.isArray(plans) || plans.length !== 2 || value.targets.length !== 5 || value.recovery.length || value.recoveryPointers.length || value.titleProofs?.length) fail('unsupported mixed scope');
  if (![descriptor.admittedRevision, descriptor.incomingRevision, descriptor.annotationId].every(uuid) || descriptor.admittedRevision === descriptor.incomingRevision || !(descriptor.sourceGeneration === null || uuid(descriptor.sourceGeneration)) || ![descriptor.incomingFingerprint, descriptor.admissionSha256, descriptor.pointerSha256, descriptor.conflictSha256, descriptor.outcomeSha256].every(sha) || !/^finalization:[a-f0-9]{32}$/.test(descriptor.incomingIdentity) || typeof descriptor.outcomeKey !== 'string' || !uuid(descriptor.outcomeKey.split(':')[0])) fail('mixed identities');
  if (!['current', 'snapshot', 'originalConflict', 'resolutionConflict', 'repair'].every(key => safe(descriptor[key]))) fail('mixed paths');
  const targets = new Map(value.targets.map(item => [item.file, item]));
  if (targets.size !== 5 || targets.get(descriptor.current)?.kind !== 'capture' || targets.get(descriptor.snapshot)?.kind !== 'snapshot' || [descriptor.originalConflict, descriptor.resolutionConflict, descriptor.repair].some(file => targets.get(file)?.kind !== 'mixed-recovery') || value.targets.some(item => item.peers !== undefined)) fail('mixed target roles');
  const store = path.posix.dirname(descriptor.repair), parent = path.posix.dirname(store);
  if (path.posix.basename(store) !== '.intake' || descriptor.current !== `${parent}/Captures/${id}.md` || descriptor.snapshot !== `${parent}/Revisions/${descriptor.admittedRevision}.json` || descriptor.originalConflict !== `${store}/conflict-${descriptor.incomingRevision}.json` || descriptor.resolutionConflict !== `${store}/conflict-${descriptor.incomingRevision}-${descriptor.annotationId}.json` || descriptor.repair !== `${store}/repair-${descriptor.annotationId}.json`) fail('mixed writer layout');
  if (descriptor.sourceGeneration !== (value.originGenerations[0]?.generation ?? null)) fail('mixed original generation');
  const physical = new Set(value.targets.map(item => item.dev + ':' + item.ino)); if (physical.size !== 5) fail('mixed peers');
  const annotationIds = new Set(), paths = new Set();
  for (const [index, plan] of plans.entries()) {
    if (!shape(plan, ['payloadKind', 'annotationId', 'file', 'stage', 'publicationOperationId', 'payloadSha256', 'outputSha256', 'outputBytes', 'createdAt', 'sourceLink', 'sourceGeneration', 'origins'], ['stageIdentity', 'publication']) || plan.payloadKind !== (index === 0 ? 'repair-annotation' : 'previous-whole-variant') || !uuid(plan.annotationId) || !uuid(plan.publicationOperationId) || ![plan.payloadSha256, plan.outputSha256].every(sha) || !number(plan.outputBytes) || !date(plan.createdAt) || typeof plan.sourceLink !== 'string' || !plan.sourceLink || /[\r\n]/.test(plan.sourceLink) || plan.sourceGeneration !== descriptor.sourceGeneration || !Array.isArray(plan.origins) || plan.origins.some(item => !shape(item, ['file', 'role']))) fail('retention plan');
    if (annotationIds.has(plan.annotationId) || paths.has(plan.file) || plan.annotationId === id || plan.sourceLink !== `../Captures/${id}.md` || plan.file !== `${parent}/Annotations/${plan.annotationId}.md` || plan.stage !== `${store}/deletion-writing-${plan.publicationOperationId}-${plan.annotationId}.stage`) fail('retention destination');
    annotationIds.add(plan.annotationId); paths.add(plan.file);
    if (index === 0 && (plan.annotationId !== descriptor.annotationId || plan.payloadSha256 !== plan.outputSha256) || !equal(plan.origins, index === 0 ? [{ file: descriptor.repair, role: 'repair-annotation' }] : roles(descriptor))) fail('retention payload coverage');
    if (plan.stageIdentity !== undefined && (!receipt(plan.stageIdentity) || plan.stageIdentity.sha256 !== plan.outputSha256 || plan.stageIdentity.bytes !== plan.outputBytes) || plan.publication !== undefined && (!receipt(plan.publication) || !equal(plan.publication, plan.stageIdentity))) fail('retention receipt');
    if (['deleting', 'deleted'].includes(value.phase) && plan.publicationOperationId !== value.operationId || ['deleted', 'restoring', 'active'].includes(value.phase) && !plan.publication) fail('retention publication owner');
  }
  if (plans[0].payloadSha256 === plans[1].payloadSha256 || plans[0].publicationOperationId !== plans[1].publicationOperationId || plans[0].sourceLink !== plans[1].sourceLink) fail('distinct writing variants');
  if (!value.purgedProducerAttempts.some(item => item.identity === descriptor.incomingIdentity && item.fingerprint === descriptor.incomingFingerprint && item.sourceHash === value.sourceHash && item.captureId === id && item.revisionId === descriptor.incomingRevision && item.sourceGeneration === descriptor.sourceGeneration && item.operationId === plans[0].publicationOperationId)) fail('incoming purge observation');
  if (['restoring', 'active'].includes(value.phase)) {
    const prior = (value.history || []).filter(item => item.phase === 'deleted' && item.operationId === plans[0].publicationOperationId && equal(item.mixedRecovery, descriptor) && equal(item.preservedWriting, plans) && equal(item.originGenerations, value.originGenerations));
    if (prior.length !== 1) fail('inherited retention owner');
  }
}
function wholeTemplate(plan, id, payload) {
  const longest = (payload.match(/`+/g) || []).reduce((length, run) => Math.max(length, run.length), 0), fence = '`'.repeat(Math.max(3, longest + 1));
  return `---\ncompanion_id: ${JSON.stringify(plan.annotationId)}\nartifact_type: "annotation"\nschema_version: 1\ncapture_id: ${JSON.stringify(id)}\ncreated_at: ${JSON.stringify(plan.createdAt)}\n${plan.sourceGeneration === null ? '' : 'source_generation: ' + JSON.stringify(plan.sourceGeneration) + '\n'}---\n\n# ${title}\n\nSource: [Capture](${plan.sourceLink})\n\nRetained whole local version. This copy still contains source quotations.\n\n${fence}text\n${payload}${payload.endsWith('\n') ? '' : '\n'}${fence}\n`;
}
function annotationParts(annotation, id, annotationId, sourceLink) {
  const prefix = `---\ncompanion_id: ${JSON.stringify(annotationId)}\nartifact_type: "annotation"\nschema_version: 1\ncapture_id: ${JSON.stringify(id)}\ncreated_at: `;
  if (typeof annotation !== 'string' || !annotation.startsWith(prefix)) fail('repair annotation header');
  const end = annotation.indexOf('\n', prefix.length); let createdAt;
  try { createdAt = JSON.parse(annotation.slice(prefix.length, end)); } catch { fail('repair annotation instant'); }
  const header = prefix + JSON.stringify(createdAt) + `\n---\n\n# Annotation\n\nSource: [Capture](${sourceLink})\n\n`;
  if (!date(createdAt) || !annotation.startsWith(header) || !annotation.endsWith('\n') || !annotation.slice(header.length, -1).trim()) fail('repair annotation shape');
  return { createdAt };
}
async function inventory(intake, ledger, capture, sourceHash, note, seed, now) {
  const candidates = [];
  for (const name of (await fs.readdir(intake.dir)).sort()) {
    if (!/^repair-[a-f0-9-]{36}\.json$/.test(name)) continue;
    const value = await leaf(intake, path.join(intake.dir, name), 'mixed-recovery');
    if (value.bytes.includes(Buffer.from(capture.id)) || value.bytes.includes(Buffer.from(sourceHash))) candidates.push(value);
  }
  if (!candidates.length) return null;
  if (candidates.length !== 1) fail('more than one selected repair');
  const repairLeaf = candidates[0], repair = json(repairLeaf);
  if (!shape(repair, ['schema', 'sourceHash', 'localHash', 'annotationId', 'annotation', 'tx']) || repair.schema !== 1 || repair.sourceHash !== sourceHash || !uuid(repair.annotationId) || !sha(repair.localHash)) fail('repair wrapper');
  const tx = repair.tx, originalFile = path.join(intake.dir, `conflict-${tx?.revision?.id}.json`), resolutionFile = path.join(intake.dir, `conflict-${tx?.revision?.id}-${repair.annotationId}.json`);
  // Read the other selected leaves only after the wrapper identities are proven.
  if (!uuid(tx?.revision?.id) || tx.capture?.id !== capture.id || tx.sourceHash !== sourceHash || tx.resolution !== repair.annotationId) fail('repair source identity');
  const originalLeaf = await leaf(intake, originalFile, 'mixed-recovery'), resolutionLeaf = await leaf(intake, resolutionFile, 'mixed-recovery');
  if (!originalLeaf || !resolutionLeaf) fail('missing conflict evidence');
  const original = json(originalLeaf), resolution = json(resolutionLeaf), currentLeaf = await leaf(intake, note.file, 'capture');
  const snapshotLeaf = await leaf(intake, path.join(intake.vault.root, 'Revisions', capture.currentRevision + '.json'), 'snapshot');
  if (!snapshotLeaf || !currentLeaf) fail('missing current evidence');
  const snapshotText = utf8(snapshotLeaf.bytes), admitted = JSON.parse(snapshotText), current = utf8(currentLeaf.bytes);
  const { revisionAdmission } = require('./source-authority'), { noteText } = require('./intake');
  const known = revisionAdmission(ledger, capture.currentRevision), generation = ledger.sourceAuthority?.[capture.id]?.phase === 'active' ? ledger.sourceAuthority[capture.id].generation : undefined;
  const captureFields = ['id', 'file', 'relative', 'capturedAt', 'title', 'currentRevision', 'reviewed', 'rejected', 'supportEligible', 'revisions', 'updatedAt', 'currentHash'];
  if (!shape(capture, captureFields.filter(key => key !== 'relative'), ['relative', 'conflict', 'reviewChoices']) || !date(capture.capturedAt) || !date(capture.updatedAt) || capture.file !== capture.id + '.md' || capture.reviewed !== true || capture.identityIssue || capture.removed || !equal(capture.revisions, [capture.currentRevision]) || capture.reviewChoices !== undefined && !equal(capture.reviewChoices, []) || typeof capture.title !== 'string' || /[\r\n]/.test(capture.title) || note.id !== capture.id || note.type !== 'reel_import' || note.title !== capture.title || note.capturedAt !== capture.capturedAt || note.file !== intake.destination(capture)) fail('unsupported current capture');
  validateNormalizedReview(admitted, capture.id, sourceHash);
  if (admitted.id !== capture.currentRevision || snapshotText !== JSON.stringify(admitted, null, 2) || !known || known.status !== 'imported' || known.captureId !== capture.id || known.sourceHash !== sourceHash || known.revision !== admitted.id || known.identity !== admitted.identity || known.fingerprint !== admitted.fingerprint || known.snapshotHash !== snapshotLeaf.target.sha256 || known.sourceGeneration !== generation || capture.currentHash !== hash(noteText(capture, admitted)) || capture.rejected !== (admitted.humanReview === 'reject') || capture.supportEligible !== (admitted.supportEligible !== false)) fail('original admission');
  const sourceHeader = noteText(capture, admitted).match(/^---\n([\s\S]*?)\n---\n/)[1], localHeader = current.match(/^(?:\uFEFF)?---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/)?.[1];
  if (!localHeader || !equal(YAML.parse(localHeader), YAML.parse(sourceHeader))) fail('unsupported local metadata or generation claims');
  const txFields = ['schema', 'externalConflict', 'retainOnly', 'key', 'sourceHash', 'capture', 'revision', 'content', 'previousHash', 'previous', 'backup'];
  if (!shape(original, txFields, ['sourceGeneration']) || !shape(tx, [...txFields, 'resolution', 'keptCurrent'], ['sourceGeneration']) || !equal(resolution, tx) || original.sourceGeneration !== generation || tx.sourceGeneration !== generation) fail('transaction fields or original generation');
  intake.validateTransaction(original); intake.validateTransaction(tx);
  validateNormalizedReview(original.revision, capture.id, sourceHash); validateNormalizedReview(tx.revision, capture.id, sourceHash);
  if (!equal(tx.revision, original.revision) || tx.revision.id === admitted.id || ledger.attempts[tx.revision.identity] || ledger.admissions?.[tx.revision.id] || tx.revision.importedAt !== original.capture.updatedAt || !equal(tx.keptCurrent, admitted)) fail('incoming revision is not a distinct unadmitted observation');
  const originalCapture = { ...capture, revisions: [...capture.revisions, tx.revision.id], updatedAt: tx.revision.importedAt, reviewChoices: [...new Set([...(capture.reviewChoices || []), capture.currentRevision, tx.revision.id])], supportEligible: false, currentHash: hash(current) }; delete originalCapture.conflict;
  const resolvedCapture = { ...originalCapture, title: note.title, currentHash: hash(noteText(originalCapture, admitted)) };
  if (!equal(original.capture, originalCapture) || !equal(tx.capture, resolvedCapture) || original.externalConflict !== true || original.retainOnly !== true || tx.externalConflict !== false || tx.retainOnly !== false || original.content !== current || original.previous !== current || original.previousHash !== hash(current) || tx.previous !== current || tx.previousHash !== hash(current) || tx.content !== noteText(resolvedCapture, admitted) || repair.localHash !== hash(current) || original.key !== tx.key || !uuid(tx.key.split(':')[0]) || !ledger.sources.some(source => source.id === tx.key.split(':')[0] && source.kind === 'review')) fail('exact kept-current writer relation');
  const producer = ledger.sources.find(source => source.id === tx.key.split(':')[0]);
  if (!path.isAbsolute(tx.revision.locator) || tx.key !== `${producer.id}:${path.relative(producer.folder, tx.revision.locator) || '.'}`) fail('producer observation key');
  const block = ledger.blocks[sourceHash], outcome = ledger.outcomes[tx.key];
  if (!shape(block, ['reason', 'journal', 'incomingRevision']) || block.journal !== path.basename(resolutionFile) || block.incomingRevision !== tx.revision.id || typeof block.reason !== 'string' || block.reason !== capture.conflict || ledger.pending[sourceHash] || !equal(outcome, { status: 'held', reason: block.reason, locator: tx.revision.locator, sourceHash, pendingRevision: tx.revision.id })) fail('held pointer/outcome');
  const sourceLink = path.relative(path.join(intake.vault.root, 'Annotations'), note.file).split(path.sep).map(encodeURIComponent).join('/');
  const annotation = annotationParts(repair.annotation, capture.id, repair.annotationId, sourceLink);
  const descriptor = { format: 'kept-current-repair-v1', current: currentLeaf.target.file, snapshot: snapshotLeaf.target.file, originalConflict: originalLeaf.target.file, resolutionConflict: resolutionLeaf.target.file, repair: repairLeaf.target.file, admittedRevision: admitted.id, incomingRevision: tx.revision.id, incomingIdentity: tx.revision.identity, incomingFingerprint: tx.revision.fingerprint, annotationId: repair.annotationId, sourceGeneration: generation ?? null, admissionSha256: hash(JSON.stringify(known)), pointerSha256: hash(JSON.stringify(block)), conflictSha256: hash(capture.conflict), outcomeKey: tx.key, outcomeSha256: hash(JSON.stringify(outcome)) };
  const operationId = seed?.preservedWriting?.[0]?.publicationOperationId || randomUUID(), wholeId = seed?.preservedWriting?.[1]?.annotationId || randomUUID(), createdAt = seed?.preservedWriting?.[1]?.createdAt || now;
  const store = relative(intake, intake.dir), annotationDirectory = relative(intake, path.join(intake.vault.root, 'Annotations'));
  const makePlan = (payloadKind, annotationId, instant, payload, origins) => ({ payloadKind, annotationId, file: `${annotationDirectory}/${annotationId}.md`, stage: `${store}/deletion-writing-${operationId}-${annotationId}.stage`, publicationOperationId: operationId, payloadSha256: hash(payload), outputSha256: '', outputBytes: '', createdAt: instant, sourceLink, sourceGeneration: generation ?? null, origins });
  const plans = [makePlan('repair-annotation', repair.annotationId, annotation.createdAt, repair.annotation, [{ file: descriptor.repair, role: 'repair-annotation' }]), makePlan('previous-whole-variant', wholeId, createdAt, current, roles(descriptor))];
  const outputs = [repair.annotation, wholeTemplate(plans[1], capture.id, current)];
  for (const [index, plan] of plans.entries()) { plan.outputSha256 = hash(outputs[index]); plan.outputBytes = String(Buffer.byteLength(outputs[index])); }
  const targets = [currentLeaf, snapshotLeaf, originalLeaf, resolutionLeaf, repairLeaf].map(value => { if (value.nlink !== 1) fail(value.target.file + ' has an alias'); return value.target; }).sort((a, b) => a.file.localeCompare(b.file));
  const observation = { identity: tx.revision.identity, fingerprint: tx.revision.fingerprint, sourceHash, captureId: capture.id, revisionId: tx.revision.id, sourceGeneration: generation ?? null };
  const proof = { inventoryVersion: 2, phase: 'deleting', operationId, sourceHash, targets, originGenerations: generation ? [{ captureId: capture.id, generation }] : [], recovery: [], recoveryPointers: [], mixedRecovery: descriptor, preservedWriting: plans, purgedProducerAttempts: [{ ...observation, operationId }] };
  validate(proof, capture.id);
  const { assertAnnotationPublication } = require('./annotation-authority');
  for (const plan of plans) { assertAnnotationPublication(ledger, plan.annotationId); if (await leaf(intake, path.join(intake.vault.vault, plan.file), 'annotation') || await leaf(intake, path.join(intake.vault.vault, plan.stage), 'stage')) fail(plan.file + ' collides with an unreviewed destination'); }
  await scan(intake, proof, new Set());
  return { targets, mixedRecovery: descriptor, preservedWriting: plans, recovery: [], recoveryPointers: [], titleProofs: [], observations: [observation], retainedWriting: plans.map((plan, index) => ({ id: plan.annotationId, file: plan.file, title: index === 0 ? 'Original repair annotation' : title, text: outputs[index] })) };
}

async function scan(intake, authority, allowedStages) {
  const descriptor = authority.mixedRecovery, id = path.posix.basename(descriptor.current, '.md');
  const known = new Set(authority.targets.map(item => item.file));
  for (const note of (await intake.vault.scan()).filter(note => note.id === id)) if (!known.has(relative(intake, note.file))) fail('extra capture ' + relative(intake, note.file));
  for (const folder of [intake.dir, path.join(intake.vault.root, 'Revisions')]) for (const name of await fs.readdir(folder)) {
    if (folder === intake.dir && name === 'ledger.json') continue;
    const file = path.join(folder, name), value = await leaf(intake, file, 'scan'), relativeFile = relative(intake, file);
    if (known.has(relativeFile) || allowedStages.has(relativeFile)) continue;
    if (value.bytes.includes(Buffer.from(id)) || value.bytes.includes(Buffer.from(authority.sourceHash)) || authority.preservedWriting.some(plan => relativeFile === plan.stage)) fail('unreviewed recovery copy ' + relativeFile);
  }
}
function inspectPointers(ledger, authority) {
  const descriptor = authority.mixedRecovery, capture = ledger.captures[authority.sourceHash];
  if (!capture || capture.currentRevision !== descriptor.admittedRevision || !ledger.blocks[authority.sourceHash] || !ledger.outcomes[descriptor.outcomeKey] || hash(JSON.stringify(ledger.blocks[authority.sourceHash])) !== descriptor.pointerSha256 || typeof capture.conflict !== 'string' || hash(capture.conflict) !== descriptor.conflictSha256 || ledger.pending[authority.sourceHash] || hash(JSON.stringify(ledger.outcomes[descriptor.outcomeKey])) !== descriptor.outcomeSha256) fail('held pointer changed');
  const known = require('./source-authority').revisionAdmission(ledger, descriptor.admittedRevision);
  if (!known || hash(JSON.stringify(known)) !== descriptor.admissionSha256 || ledger.attempts[descriptor.incomingIdentity] || ledger.admissions?.[descriptor.incomingRevision]) fail('original admission changed');
}
async function rawGuard(intake, ledger, id) {
  const view = await intake.storage.view();
  if (!intake.storage.matches(view) || view.text === null) fail('Intake authority changed');
  const fresh = JSON.parse(view.text);
  require('./source-authority').validateAuthority(fresh);
  const { validateAnnotationRemovals, assertAnnotationPublication } = require('./annotation-authority'); validateAnnotationRemovals(fresh);
  if (!equal(fresh, ledger) || fresh.sourceAuthority?.[id]?.phase !== 'deleting') fail('deletion operation changed');
  for (const plan of fresh.sourceAuthority[id].preservedWriting) {
    try { assertAnnotationPublication(fresh, plan.annotationId); } catch { fail(plan.annotationId + ' at ' + plan.file + ' was separately removed'); }
  }
}
async function writingState(intake, plan) {
  const stage = await leaf(intake, path.join(intake.vault.vault, plan.stage), 'stage'), output = await leaf(intake, path.join(intake.vault.vault, plan.file), 'annotation');
  if (!plan.stageIdentity) { if (stage || output) fail(plan.annotationId + ' has unowned stage/output at ' + (stage ? plan.stage : plan.file)); return { stage, output }; }
  if (stage && !matches(stage, plan.stageIdentity) || output && !matches(output, plan.stageIdentity)) fail(plan.annotationId + ' changed at ' + plan.file);
  if (plan.publication) {
    if (!output || !matches(output, plan.publication)) fail(plan.annotationId + ' missing or changed at ' + plan.file + '; publication is verify only');
    if (stage ? stage.nlink !== 2 || output.nlink !== 2 : output.nlink !== 1) fail(plan.annotationId + ' publication aliases at ' + plan.file);
  } else if (!stage || (output ? stage.nlink !== 2 || output.nlink !== 2 : stage.nlink !== 1)) fail(plan.annotationId + ' recorded staging identity at ' + plan.stage);
  return { stage, output };
}
async function inspect(intake, ledger, id, requirePublished = false) {
  const authority = ledger.sourceAuthority[id];
  if (authority.phase !== 'deleting') return [];
  await require('./source-recovery').sourceParents(intake, authority); inspectPointers(ledger, authority);
  await require('./capture-deletion').inspectManualPeers(intake.vault, { captureId: id });
  const allowedStages = new Set();
  for (const plan of authority.preservedWriting) {
    const state = await writingState(intake, plan); if (state.stage) allowedStages.add(plan.stage);
    if (requirePublished && (!plan.publication || !state.output || state.stage)) fail(plan.annotationId + ' has no complete verified publication at ' + plan.file);
  }
  const remaining = await require('./source-inventory').inspectTargets(intake, authority);
  if (remaining.length !== authority.targets.length && authority.preservedWriting.some(plan => !plan.publication)) fail('source origin missing before both retention receipts');
  await scan(intake, authority, allowedStages); await rawGuard(intake, ledger, id); return remaining;
}
async function payload(intake, authority, plan) {
  const origin = plan.origins[0], target = authority.targets.find(item => item.file === origin.file), value = await leaf(intake, path.join(intake.vault.vault, origin.file), target.kind);
  if (!matches(value, target) || value.nlink !== 1) fail('retention origin ' + origin.file);
  const result = plan.payloadKind === 'repair-annotation' ? json(value).annotation : utf8(value.bytes);
  if (typeof result !== 'string' || hash(result) !== plan.payloadSha256) fail('retention payload ' + plan.annotationId);
  const output = plan.payloadKind === 'repair-annotation' ? result : wholeTemplate(plan, path.posix.basename(authority.mixedRecovery.current, '.md'), result);
  if (hash(output) !== plan.outputSha256 || String(Buffer.byteLength(output)) !== plan.outputBytes) fail('retention template ' + plan.annotationId); return output;
}
async function publish(intake, ledger, id) {
  const authority = ledger.sourceAuthority[id];
  if (authority.phase !== 'deleting') return;
  for (const plan of authority.preservedWriting) {
    await inspect(intake, ledger, id);
    let state = await writingState(intake, plan);
    if (!plan.publication) {
      if (!plan.stageIdentity) {
        const output = await payload(intake, authority, plan);
        await inspect(intake, ledger, id);
        // Exclusive creation: a pre-receipt stage cannot be adopted by byte equality.
        try { await fs.writeFile(path.join(intake.vault.vault, plan.stage), output, { flag: 'wx', flush: true }); } catch (error) { if (error.code === 'EEXIST') fail(plan.stage + ' already exists without a receipt'); throw error; }
        const stage = await leaf(intake, path.join(intake.vault.vault, plan.stage), 'stage');
        if (!stage || stage.nlink !== 1 || stage.target.sha256 !== plan.outputSha256 || stage.target.bytes !== plan.outputBytes) fail(plan.stage);
        if ((await require('./source-inventory').inspectTargets(intake, authority)).length !== authority.targets.length) fail('source origin changed before stage receipt');
        await scan(intake, authority, new Set([plan.stage]));
        await require('./source-recovery').sourceParents(intake, authority); await rawGuard(intake, ledger, id);
        plan.stageIdentity = identity(stage); await intake.save(ledger);
      }
      await inspect(intake, ledger, id); state = await writingState(intake, plan);
      if (!state.output) {
        await inspect(intake, ledger, id);
        try { await fs.link(path.join(intake.vault.vault, plan.stage), path.join(intake.vault.vault, plan.file)); } catch (error) { if (error.code === 'EEXIST') fail(plan.file + ' appeared before publication'); throw error; }
      }
      await inspect(intake, ledger, id); state = await writingState(intake, plan);
      if (!state.output || state.stage.nlink !== 2 || state.output.nlink !== 2) fail(plan.file + ' publication pair');
      await rawGuard(intake, ledger, id); plan.publication = identity(state.output); await intake.save(ledger);
    }
    await inspect(intake, ledger, id); state = await writingState(intake, plan);
    if (state.stage) {
      await inspect(intake, ledger, id);
      await fs.unlink(path.join(intake.vault.vault, plan.stage));
    }
    await inspect(intake, ledger, id);
  }
  await inspect(intake, ledger, id, true);
}
function retirePointers(ledger, authority) {
  inspectPointers(ledger, authority); delete ledger.blocks[authority.sourceHash]; delete ledger.captures[authority.sourceHash].conflict;
}
module.exports = { validate, inventory, inspect, publish, inspectPointers, retirePointers };
