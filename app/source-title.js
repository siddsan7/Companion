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
  if (authority.inventoryVersion !== 2 || authority.manual || !Array.isArray(proofs)) fail();
  const targets = new Map(authority.targets.map(item => [item.file, item])), backups = authority.targets.filter(item => item.kind === 'source-title-backup'), captures = authority.targets.filter(item => item.kind === 'capture');
  if (proofs.length !== backups.length) fail();
  if (!proofs.length) return;
  if (captures.length !== 1) fail();
  const terminal = captures[0].file, anchor = proofs[0], next = new Map(), incoming = new Set(); let previous = '';
  for (const proof of proofs) {
    if (!fields(proof, ['before', 'after', 'snapshot', 'revisionId', 'sourceGeneration']) || ![proof.before, proof.after, proof.snapshot].every(safe) || new Set([proof.before, proof.after, proof.snapshot]).size !== 3 || !uuid(proof.revisionId) || !(proof.sourceGeneration === null || uuid(proof.sourceGeneration)) || proof.before <= previous || incoming.has(proof.after)) fail();
    if (targets.get(proof.before)?.kind !== 'source-title-backup' || !(proof.after === terminal || targets.get(proof.after)?.kind === 'source-title-backup') || targets.get(proof.snapshot)?.kind !== 'snapshot' || !backupName(proof.before, terminal) || path.posix.basename(proof.snapshot) !== proof.revisionId + '.json' || path.posix.basename(path.posix.dirname(proof.snapshot)) !== 'Revisions' || proof.sourceGeneration !== (authority.originGenerations[0]?.generation ?? null) || proof.snapshot !== anchor.snapshot || proof.revisionId !== anchor.revisionId || proof.sourceGeneration !== anchor.sourceGeneration) fail();
    previous = proof.before; next.set(proof.before, proof.after); incoming.add(proof.after);
  }
  for (const target of backups) if (!next.has(target.file)) fail();
  const roots = backups.filter(item => !incoming.has(item.file));
  if (roots.length !== 1) fail();
  const visited = new Set(); let node = roots[0].file;
  while (true) {
    if (visited.has(node)) fail(); visited.add(node);
    if (node === terminal) break;
    if (!next.has(node)) fail(); node = next.get(node);
  }
  if (visited.size !== backups.length + 1) fail();
  return { ...anchor, terminal };
}
function inspectProofs(intake, ledger, authority) {
  const proof = validateProofs(authority); if (!proof) return;
  const capture = ledger.captures[authority.sourceHash], known = require('./source-authority').revisionAdmission(ledger, proof.revisionId);
  const snapshot = authority.targets.find(item => item.file === proof.snapshot);
  if (!capture || known?.captureId !== capture.id || known.sourceHash !== authority.sourceHash || known.status !== 'imported' || known.snapshotHash !== snapshot.sha256 || (known.sourceGeneration === undefined ? null : known.sourceGeneration) !== proof.sourceGeneration || proof.snapshot !== relative(intake, path.join(intake.vault.root, 'Revisions', proof.revisionId + '.json')) || proof.terminal !== relative(intake, intake.destination(capture))) fail();
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
  const names = (await fs.readdir(path.dirname(currentFile))).filter(name => name.startsWith(prefix)).sort();
  if (!names.length) return { targets: initial, titleProofs: [] };
  if (currentTarget.file !== relative(intake, intake.destination(capture))) fail();
  const current = revisions.get(capture.currentRevision), known = require('./source-authority').revisionAdmission(ledger, capture.currentRevision);
  const snapshotPath = relative(intake, path.join(intake.vault.root, 'Revisions', capture.currentRevision + '.json')), snapshot = initial.find(item => item.file === snapshotPath);
  const authority = ledger.sourceAuthority?.[capture.id], generation = authority?.phase === 'active' ? authority.generation : undefined;
  if (!current || !known || known.status !== 'imported' || known.captureId !== capture.id || known.sourceHash !== current.sourceHash || snapshot?.kind !== 'snapshot' || known.snapshotHash !== snapshot.sha256 || known.sourceGeneration !== generation) fail();
  const after = await leaf(intake, currentFile, 'capture');
  if (Object.keys(after.target).some(key => after.target[key] !== currentTarget[key]) || after.target.sha256 !== capture.currentHash) fail();
  const { parse, withTitle } = require('./vault'), { noteText } = require('./intake');
  const validNote = text => { const note = parse(text); if (!note || note.id !== capture.id || note.type !== 'reel_import' || note.capturedAt !== capture.capturedAt) fail(); return note; };
  after.note = validNote(after.text); if (after.note.title !== capture.title) fail();
  const backups = [];
  for (const name of names) {
    const file = path.join(path.dirname(currentFile), name);
    if (!backupName(relative(intake, file), currentTarget.file)) fail();
    const value = await leaf(intake, file, 'source-title-backup'); value.note = validNote(value.text); backups.push(value);
  }
  // Select one deterministic witness, never a guessed historical order or a
  // permutation search. Every physical backup must pass its exact pairwise edge.
  const baseline = backups.find(value => value.bytes.equals(Buffer.from(noteText({ ...capture, title: value.note.title }, current), 'utf8')));
  if (!baseline) fail();
  const chain = [baseline, ...backups.filter(value => value !== baseline), after], titleProofs = [];
  for (let index = 0; index < chain.length - 1; index++) {
    const before = chain[index], next = chain[index + 1];
    if (!next.bytes.equals(Buffer.from(withTitle(before.text, next.note.title), 'utf8'))) fail();
    titleProofs.push({ before: before.target.file, after: next.target.file, snapshot: snapshotPath, revisionId: current.id, sourceGeneration: known.sourceGeneration === undefined ? null : known.sourceGeneration });
  }
  titleProofs.sort((left, right) => left.before < right.before ? -1 : left.before > right.before ? 1 : 0);
  return { targets: [...initial, ...backups.map(value => value.target)], titleProofs };
}
module.exports = { validateProofs, inspectProofs, inventory };
