const fs = require('node:fs/promises');
const path = require('node:path');
const YAML = require('yaml');
const { isDeepStrictEqual } = require('node:util');
const { hash } = require('./intake-producer');
const fail = () => { throw Object.assign(Error('Title recovery contains changed or unsupported writing. Preserve it for explicit review.'), { code: 'SOURCE_FILE_CHANGED' }); };
const uuid = value => typeof value === 'string' && /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(value);
const fields = (value, names) => value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === names.length && names.every(key => Object.hasOwn(value, key));
const safe = value => typeof value === 'string' && !!value && !/[\\:]/.test(value) && value.split('/').every(part => part && part !== '.' && part !== '..');
const relative = (intake, file) => path.relative(intake.vault.vault, file).split(path.sep).join('/');
function backupName(before, after) {
  const prefix = path.posix.basename(after) + '.before-title-', name = path.posix.basename(before);
  return path.posix.dirname(before) === path.posix.dirname(after) && name.startsWith(prefix) && name.endsWith('.bak') && uuid(name.slice(prefix.length, -4));
}
function backupRevision(file, directory, captureId) {
  const match = /^([a-f0-9-]{36})-([a-f0-9-]{36})\.before(?:-([a-f0-9-]{36}))?\.md$/.exec(path.posix.basename(file));
  if (path.posix.dirname(file) !== directory || !match || match[1] !== captureId || !uuid(match[1]) || !uuid(match[2]) || match[3] !== undefined && !uuid(match[3])) fail();
  return match[2];
}
function validateProofs(authority, captureId) {
  const proofs = authority.titleProofs;
  if (proofs === undefined) { if (authority.targets.some(item => item.kind === 'source-title-backup')) fail(); return []; }
  if (authority.inventoryVersion !== 2 || authority.manual || !Array.isArray(proofs)) fail();
  const targets = new Map(authority.targets.map(item => [item.file, item])), backups = authority.targets.filter(item => item.kind === 'source-title-backup'), captures = authority.targets.filter(item => item.kind === 'capture');
  if (!proofs.length) { if (backups.length) fail(); return []; }
  if (!uuid(captureId) || captures.length !== 1 || targets.size !== authority.targets.length) fail();
  const current = captures[0].file, groups = new Map(), owners = new Map(), physical = new Map(), recoveryFiles = new Set((authority.recovery || []).map(item => item.file)); let previous = '';
  for (const proof of proofs) {
    if (!fields(proof, ['before', 'after', 'snapshot', 'revisionId', 'sourceGeneration']) || ![proof.before, proof.after, proof.snapshot].every(safe) || new Set([proof.before, proof.after, proof.snapshot]).size !== 3 || !uuid(proof.revisionId) || !(proof.sourceGeneration === null || uuid(proof.sourceGeneration)) || proof.before <= previous) fail();
    const snapshot = targets.get(proof.snapshot), root = path.posix.dirname(path.posix.dirname(proof.snapshot));
    if (snapshot?.kind !== 'snapshot' || snapshot.peers !== undefined || path.posix.basename(proof.snapshot) !== proof.revisionId + '.json' || path.posix.basename(path.posix.dirname(proof.snapshot)) !== 'Revisions' || proof.sourceGeneration !== (authority.originGenerations[0]?.generation ?? null)) fail();
    const key = JSON.stringify([proof.snapshot, proof.revisionId, proof.sourceGeneration]);
    if (!groups.has(key)) groups.set(key, { snapshot: proof.snapshot, revisionId: proof.revisionId, sourceGeneration: proof.sourceGeneration, next: new Map(), incoming: new Set(), nodes: new Set() });
    const group = groups.get(key);
    if (group.incoming.has(proof.after) || !['source-title-backup', 'source-backup'].includes(targets.get(proof.before)?.kind) || !['source-title-backup', 'source-backup', 'capture'].includes(targets.get(proof.after)?.kind)) fail();
    for (const file of [proof.before, proof.after]) {
      const target = targets.get(file);
      if (owners.has(file) && owners.get(file) !== key || target.peers !== undefined || recoveryFiles.has(file) || recoveryFiles.has(proof.snapshot)) fail();
      owners.set(file, key); group.nodes.add(file);
      if (target.kind === 'source-title-backup' && !backupName(file, current)) fail();
      if (target.kind === 'source-backup') backupRevision(file, `${root}/.intake`, captureId);
      if (target.kind === 'capture' && file !== current) fail();
      const identity = `${target.dev}:${target.ino}`;
      if (physical.has(identity) && physical.get(identity) !== file) fail();
      physical.set(identity, file);
    }
    previous = proof.before; group.next.set(proof.before, proof.after); group.incoming.add(proof.after);
  }
  for (const target of backups) if (!owners.has(target.file)) fail();
  const result = [];
  for (const group of groups.values()) {
    const nodes = [...group.nodes], roots = nodes.filter(file => !group.incoming.has(file)), terminals = nodes.filter(file => !group.next.has(file));
    if (roots.length !== 1 || terminals.length !== 1 || targets.get(roots[0]).kind !== 'source-title-backup' || !['source-backup', 'capture'].includes(targets.get(terminals[0]).kind)) fail();
    const visited = new Set(); let node = roots[0];
    while (true) {
      if (visited.has(node)) fail(); visited.add(node);
      if (node === terminals[0]) break;
      if (!group.next.has(node)) fail(); node = group.next.get(node);
    }
    if (visited.size !== group.nodes.size || !nodes.some(file => targets.get(file).kind === 'source-title-backup')) fail();
    result.push({ snapshot: group.snapshot, revisionId: group.revisionId, sourceGeneration: group.sourceGeneration, root: roots[0], terminal: terminals[0], nodes });
  }
  return result;
}
function inspectProofs(intake, ledger, authority) {
  const capture = ledger.captures[authority.sourceHash], groups = validateProofs(authority, capture?.id), targets = new Map(authority.targets.map(item => [item.file, item]));
  if (groups.length) {
    const current = authority.targets.find(item => item.kind === 'capture');
    if (current.file !== relative(intake, intake.destination(capture)) || current.sha256 !== capture.currentHash) fail();
  }
  for (const proof of groups) {
    const known = admitted(ledger, capture, authority.sourceHash, proof.revisionId, proof.sourceGeneration), snapshot = targets.get(proof.snapshot);
    if (known.snapshotHash !== snapshot.sha256 || proof.snapshot !== relative(intake, path.join(intake.vault.root, 'Revisions', proof.revisionId + '.json'))) fail();
    const terminal = targets.get(proof.terminal);
    if (proof.revisionId === capture.currentRevision ? terminal.kind !== 'capture' || proof.terminal !== relative(intake, intake.destination(capture)) : terminal.kind !== 'source-backup') fail();
    for (const file of proof.nodes) if (targets.get(file).kind === 'source-backup') admitted(ledger, capture, authority.sourceHash, backupRevision(file, relative(intake, intake.dir), capture.id), proof.sourceGeneration);
  }
  // Proof edges bind the original reviewed bytes in the committed manifest.
  // A consented baseline/snapshot may be gone; do not replay or reconstruct it.
}
function admitted(ledger, capture, sourceHash, revisionId, generation) {
  const known = require('./source-authority').revisionAdmission(ledger, revisionId), accepted = known && ledger.attempts[known.identity];
  if (!capture || !capture.revisions.includes(revisionId) || !known || known.revision !== revisionId || known.captureId !== capture.id || known.sourceHash !== sourceHash || known.status !== 'imported' || !/^[a-f0-9]{64}$/.test(known.snapshotHash) || !/^[a-f0-9]{64}$/.test(known.fingerprint) || (generation === null ? known.sourceGeneration !== undefined : known.sourceGeneration !== generation) || !accepted || accepted.status !== 'imported' || accepted.captureId !== capture.id || accepted.sourceHash !== sourceHash || accepted.fingerprint !== known.fingerprint || accepted.identity !== known.identity) fail();
  return known;
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
async function inventory(intake, ledger, capture, revisions, initial, matchesCompletedBackup) {
  const currentTarget = initial.find(item => item.kind === 'capture');
  if (!currentTarget) fail();
  const currentFile = path.join(intake.vault.vault, currentTarget.file), prefix = path.basename(currentFile) + '.before-title-';
  const names = (await fs.readdir(path.dirname(currentFile))).filter(name => name.startsWith(prefix)).sort();
  if (!names.length) return { targets: initial, titleProofs: [], sourceBackups: new Map(), proofFiles: new Set(), verifiedCurrent: false };
  if (currentTarget.file !== relative(intake, intake.destination(capture))) fail();
  const authority = ledger.sourceAuthority?.[capture.id], generation = authority?.phase === 'active' ? authority.generation : undefined;
  const after = await leaf(intake, currentFile, 'capture');
  if (Object.keys(after.target).some(key => after.target[key] !== currentTarget[key]) || after.target.sha256 !== capture.currentHash) fail();
  const { parse, withTitle } = require('./vault'), { noteText } = require('./intake');
  const validNote = text => {
    const note = parse(text), match = text.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
    let metadata; try { metadata = match && YAML.parse(match[1]); } catch { fail(); }
    if (!note || note.id !== capture.id || note.type !== 'reel_import' || note.capturedAt !== capture.capturedAt || metadata.source_hash !== afterSource || !uuid(metadata.source_revision) || !revisions.has(metadata.source_revision)) fail();
    return { ...note, revisionId: metadata.source_revision };
  };
  const afterSource = revisions.get(capture.currentRevision)?.sourceHash;
  if (!afterSource) fail();
  after.note = validNote(after.text); if (after.note.title !== capture.title) fail();
  if (after.note.revisionId !== capture.currentRevision) fail();
  const backups = [], groups = new Map();
  for (const name of names) {
    const file = path.join(path.dirname(currentFile), name);
    if (!backupName(relative(intake, file), currentTarget.file)) fail();
    const value = await leaf(intake, file, 'source-title-backup'); value.note = validNote(value.text); backups.push(value);
    if (!groups.has(value.note.revisionId)) groups.set(value.note.revisionId, { backups: [], sourceBackups: [] });
    groups.get(value.note.revisionId).backups.push(value);
  }
  // Offer actual completed before-files even when canonical rendering also
  // succeeds. Their incoming filename is a separate admitted writer identity.
  for (const name of (await fs.readdir(intake.dir)).sort()) {
    if (!name.startsWith(capture.id + '-') || !name.includes('.before')) continue;
    const file = path.join(intake.dir, name), incoming = backupRevision(relative(intake, file), relative(intake, intake.dir), capture.id);
    const value = await leaf(intake, file, 'source-backup');
    if (!matchesCompletedBackup(name, { ...value, nlink: 1 })) fail();
    value.note = validNote(value.text);
    const group = groups.get(value.note.revisionId);
    if (group) {
      admitted(ledger, capture, afterSource, incoming, generation ?? null);
      group.sourceBackups.push(value);
    }
  }
  const titleProofs = [], sourceBackups = new Map(), proofFiles = new Set(), physical = new Map(), snapshots = new Map(initial.map(item => [item.file, item]));
  let verifiedCurrent = false;
  for (const [revisionId, group] of groups) {
    const revision = revisions.get(revisionId), known = admitted(ledger, capture, afterSource, revisionId, generation ?? null);
    const snapshotFile = path.join(intake.vault.root, 'Revisions', revisionId + '.json'), snapshotPath = relative(intake, snapshotFile), snapshot = snapshots.get(snapshotPath);
    if (!revision || revision.id !== revisionId || revision.captureId !== capture.id || revision.sourceHash !== afterSource || revision.identity !== known.identity || revision.fingerprint !== known.fingerprint || snapshot?.kind !== 'snapshot' || snapshot.sha256 !== known.snapshotHash) fail();
    const observedSnapshot = await leaf(intake, snapshotFile, 'snapshot');
    if (Object.keys(observedSnapshot.target).some(key => observedSnapshot.target[key] !== snapshot[key]) || !isDeepStrictEqual(JSON.parse(observedSnapshot.text), revision)) fail();
    // Select one deterministic full-byte witness per immutable admission.
    // The physical canonical root must exist; there is no permutation search.
    const baseline = group.backups.find(value => value.bytes.equals(Buffer.from(noteText({ ...capture, title: value.note.title }, revision), 'utf8')));
    if (!baseline || revisionId !== capture.currentRevision && !group.sourceBackups.length) fail();
    const chain = [baseline, ...group.backups.filter(value => value !== baseline), ...group.sourceBackups, ...(revisionId === capture.currentRevision ? [after] : [])];
    for (const value of chain) {
      const identity = `${value.target.dev}:${value.target.ino}`;
      if (physical.has(identity)) fail(); physical.set(identity, value.target.file);
      proofFiles.add(value.target.file);
      if (value.target.kind === 'source-backup') sourceBackups.set(value.target.file, value);
    }
    proofFiles.add(snapshotPath);
    for (let index = 0; index < chain.length - 1; index++) {
      const before = chain[index], next = chain[index + 1];
      if (!next.bytes.equals(Buffer.from(withTitle(before.text, next.note.title), 'utf8'))) fail();
      titleProofs.push({ before: before.target.file, after: next.target.file, snapshot: snapshotPath, revisionId, sourceGeneration: known.sourceGeneration ?? null });
    }
    if (revisionId === capture.currentRevision) verifiedCurrent = true;
  }
  titleProofs.sort((left, right) => left.before < right.before ? -1 : left.before > right.before ? 1 : 0);
  const targets = [...initial, ...backups.map(value => value.target), ...[...sourceBackups.values()].map(value => value.target)];
  validateProofs({ inventoryVersion: 2, targets, titleProofs, originGenerations: generation ? [{ captureId: capture.id, generation }] : [], recovery: [] }, capture.id);
  return { targets, titleProofs, sourceBackups, proofFiles, verifiedCurrent };
}
module.exports = { validateProofs, inspectProofs, inventory, leaf };
