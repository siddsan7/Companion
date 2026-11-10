const fs = require('node:fs/promises');
const path = require('node:path');
const { hash } = require('./intake-producer');
const fail = () => { throw Object.assign(Error('Title recovery contains changed or unsupported writing. Preserve it for explicit review.'), { code: 'SOURCE_FILE_CHANGED' }); };
const uuid = value => typeof value === 'string' && /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(value);
const fields = (value, names) => value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).every(key => names.includes(key));
const safe = value => typeof value === 'string' && !!value && !/[\\:]/.test(value) && value.split('/').every(part => part && part !== '.' && part !== '..');
const relative = (intake, file) => path.relative(intake.vault.vault, file).split(path.sep).join('/');
function backupName(before, after) {
  const prefix = path.posix.basename(after) + '.before-title-', name = path.posix.basename(before);
  return path.posix.dirname(before) === path.posix.dirname(after) && name.startsWith(prefix) && name.endsWith('.bak') && uuid(name.slice(prefix.length, -4));
}
function validateProofs(authority) {
  const proofs = authority.titleProofs;
  if (proofs === undefined) { if (authority.targets.some(item => item.kind === 'source-title-backup')) fail(); return; }
  if (authority.inventoryVersion !== 2 || authority.manual || !Array.isArray(proofs) || proofs.length > 1) fail();
  const targets = new Map(authority.targets.map(item => [item.file, item])), beforeFiles = new Set();
  for (const proof of proofs) {
    if (!fields(proof, ['before', 'after', 'snapshot', 'revisionId', 'sourceGeneration']) || ![proof.before, proof.after, proof.snapshot].every(safe) || new Set([proof.before, proof.after, proof.snapshot]).size !== 3 || !uuid(proof.revisionId) || !(proof.sourceGeneration === null || uuid(proof.sourceGeneration)) || beforeFiles.has(proof.before)) fail();
    if (targets.get(proof.before)?.kind !== 'source-title-backup' || targets.get(proof.after)?.kind !== 'capture' || targets.get(proof.snapshot)?.kind !== 'snapshot' || authority.targets.filter(item => item.kind === 'capture').length !== 1 || !backupName(proof.before, proof.after) || path.posix.basename(proof.snapshot) !== proof.revisionId + '.json' || path.posix.basename(path.posix.dirname(proof.snapshot)) !== 'Revisions' || proof.sourceGeneration !== (authority.originGenerations[0]?.generation ?? null)) fail();
    beforeFiles.add(proof.before);
  }
  for (const target of authority.targets) if (target.kind === 'source-title-backup' && !beforeFiles.has(target.file)) fail();
}
function inspectProofs(intake, ledger, authority) {
  validateProofs(authority);
  for (const proof of authority.titleProofs || []) {
    const capture = ledger.captures[authority.sourceHash], known = require('./source-authority').revisionAdmission(ledger, proof.revisionId);
    const snapshot = authority.targets.find(item => item.file === proof.snapshot);
    if (!capture || known?.captureId !== capture.id || known.sourceHash !== authority.sourceHash || known.status !== 'imported' || known.snapshotHash !== snapshot.sha256 || (known.sourceGeneration === undefined ? null : known.sourceGeneration) !== proof.sourceGeneration || proof.snapshot !== relative(intake, path.join(intake.vault.root, 'Revisions', proof.revisionId + '.json')) || proof.after !== relative(intake, intake.destination(capture))) fail();
  }
  // Proof edges bind the original reviewed bytes in the committed manifest.
  // A consented baseline/snapshot may be gone; do not replay or reconstruct it.
}
async function leaf(intake, file, kind) {
  await intake.vault.contained(file);
  const before = await fs.lstat(file, { bigint: true });
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n) fail();
  const handle = await fs.open(file, 'r'); let bytes;
  try {
    const opened = await handle.stat({ bigint: true });
    if (opened.dev !== before.dev || opened.ino !== before.ino || opened.nlink !== 1n) fail();
    bytes = await handle.readFile();
    const after = await handle.stat({ bigint: true }), current = await fs.lstat(file, { bigint: true });
    if (!current.isFile() || current.isSymbolicLink() || [after, current].some(item => item.dev !== before.dev || item.ino !== before.ino || item.nlink !== 1n || item.size !== before.size || item.mtimeNs !== before.mtimeNs) || BigInt(bytes.length) !== before.size) fail();
  } finally { await handle.close(); }
  let text; try { text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes); } catch { fail(); }
  return { bytes, text, target: { file: relative(intake, file), sha256: hash(bytes), dev: String(before.dev), ino: String(before.ino), bytes: String(bytes.length), kind } };
}
async function inventory(intake, ledger, capture, revisions, initial) {
  const currentTarget = initial.find(item => item.kind === 'capture');
  if (!currentTarget) fail();
  const currentFile = path.join(intake.vault.vault, currentTarget.file), prefix = path.basename(currentFile) + '.before-title-';
  const names = (await fs.readdir(path.dirname(currentFile))).filter(name => name.startsWith(prefix));
  if (!names.length) return { targets: initial, titleProofs: [] };
  if (names.length !== 1) fail();
  const beforeFile = path.join(path.dirname(currentFile), names[0]), beforePath = relative(intake, beforeFile);
  if (!backupName(beforePath, currentTarget.file) || currentTarget.file !== relative(intake, intake.destination(capture))) fail();
  const current = revisions.get(capture.currentRevision), known = require('./source-authority').revisionAdmission(ledger, capture.currentRevision);
  const snapshotPath = relative(intake, path.join(intake.vault.root, 'Revisions', capture.currentRevision + '.json')), snapshot = initial.find(item => item.file === snapshotPath);
  const authority = ledger.sourceAuthority?.[capture.id], generation = authority?.phase === 'active' ? authority.generation : undefined;
  if (!current || !known || known.status !== 'imported' || known.captureId !== capture.id || known.sourceHash !== current.sourceHash || snapshot?.kind !== 'snapshot' || known.snapshotHash !== snapshot.sha256 || known.sourceGeneration !== generation) fail();
  const before = await leaf(intake, beforeFile, 'source-title-backup'), after = await leaf(intake, currentFile, 'capture');
  if (Object.keys(after.target).some(key => after.target[key] !== currentTarget[key]) || after.target.sha256 !== capture.currentHash) fail();
  const { parse, withTitle } = require('./vault'), { noteText } = require('./intake'), beforeNote = parse(before.text), afterNote = parse(after.text);
  if (!beforeNote || !afterNote || [beforeNote, afterNote].some(note => note.id !== capture.id || note.type !== 'reel_import' || note.capturedAt !== capture.capturedAt) || afterNote.title !== capture.title || !before.bytes.equals(Buffer.from(noteText({ ...capture, title: beforeNote.title }, current), 'utf8')) || !after.bytes.equals(Buffer.from(withTitle(before.text, afterNote.title), 'utf8'))) fail();
  return { targets: [...initial, before.target], titleProofs: [{ before: beforePath, after: currentTarget.file, snapshot: snapshotPath, revisionId: current.id, sourceGeneration: known.sourceGeneration === undefined ? null : known.sourceGeneration }] };
}
module.exports = { validateProofs, inspectProofs, inventory };
