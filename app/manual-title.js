const fs = require('node:fs/promises');
const path = require('node:path');
const { hash } = require('./intake-producer');
const { parse, withTitle } = require('./vault');
const uuid = value => typeof value === 'string' && /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(value);
const fail = () => { throw Object.assign(Error('Manual title copies contain changed or unsupported writing. Preserve them for explicit review.'), { code: 'SOURCE_FILE_CHANGED' }); };
const relative = (intake, file) => path.relative(intake.vault.vault, file).split(path.sep).join('/');
const exactKeys = (value, keys) => value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).sort().join(',') === [...keys].sort().join(',');
const explicit = value => value.inventoryVersion === 1 && value.manual && value.sourceHash === null;
function backupName(before, terminal) {
  const prefix = path.posix.basename(terminal) + '.before-title-', name = path.posix.basename(before);
  return path.posix.dirname(before) === path.posix.dirname(terminal) && name.startsWith(prefix) && name.endsWith('.bak') && uuid(name.slice(prefix.length, -4));
}
function validate(value, id) {
  if (!explicit(value) || value.manual.captureId !== id || ['recovery', 'recoveryPointers', 'purgedProducerAttempts', 'titleRecovery'].some(key => value[key] !== undefined) || !Array.isArray(value.originGenerations) || value.originGenerations.length > 1 || value.originGenerations.some(item => !exactKeys(item, ['captureId', 'generation']) || item.captureId !== id || !uuid(item.generation)) || !Array.isArray(value.titleProofs) || !value.titleProofs.length) fail();
  const captures = value.targets.filter(item => item.kind === 'capture'), backups = value.targets.filter(item => item.kind === 'source-title-backup');
  if (captures.length !== 1 || value.targets.length !== backups.length + 1 || value.titleProofs.length !== backups.length) fail();
  const terminal = captures[0], targets = new Map(), identities = new Set(); let previous;
  for (const target of value.targets) {
    const identity = `${target.dev}:${target.ino}`;
    if (target.peers !== undefined || identities.has(identity) || targets.has(target.file) || previous !== undefined && previous.localeCompare(target.file) >= 0) fail();
    identities.add(identity); targets.set(target.file, target); previous = target.file;
  }
  if (terminal.file !== value.manual.relative || terminal.sha256 !== value.manual.currentHash || path.posix.basename(terminal.file) !== value.manual.file) fail();
  const next = new Map(), incoming = new Set(); previous = '';
  for (const edge of value.titleProofs) {
    if (!exactKeys(edge, ['before', 'after', 'sourceGeneration']) || typeof edge.before !== 'string' || typeof edge.after !== 'string' || edge.before <= previous || edge.before === edge.after || edge.sourceGeneration !== (value.originGenerations[0]?.generation ?? null) || !(edge.sourceGeneration === null || uuid(edge.sourceGeneration)) || targets.get(edge.before)?.kind !== 'source-title-backup' || !targets.has(edge.after) || !backupName(edge.before, terminal.file) || incoming.has(edge.after)) fail();
    previous = edge.before; next.set(edge.before, edge.after); incoming.add(edge.after);
  }
  const roots = backups.filter(item => !incoming.has(item.file));
  if (roots.length !== 1 || backups.some(item => !next.has(item.file))) fail();
  const visited = new Set(); let node = roots[0].file;
  while (node !== terminal.file) {
    if (visited.has(node) || !next.has(node)) fail();
    visited.add(node); node = next.get(node);
  }
  if (visited.size !== backups.length) fail();
  return terminal;
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
function note(value, manual) {
  const parsed = parse(value.text);
  if (!parsed || parsed.id !== manual.captureId || parsed.type !== manual.type || parsed.capturedAt !== manual.capturedAt) fail();
  return parsed;
}
async function names(intake, terminal) {
  const file = path.join(intake.vault.vault, terminal), directory = path.dirname(file);
  await intake.vault.contained(directory);
  return (await fs.readdir(directory)).filter(name => name.startsWith(path.basename(file) + '.before-title-')).sort().map(name => relative(intake, path.join(directory, name)));
}
async function inventory(intake, ledger, manual, initial) {
  const owner = ledger.sourceAuthority?.[manual.captureId];
  if (owner && (owner.phase !== 'active' || !owner.manual || owner.sourceHash !== null || owner.manual.captureId !== manual.captureId)) fail();
  const candidates = await names(intake, manual.relative);
  if (!candidates.length) return { targets: initial };
  if (initial.length !== 1 || initial[0].kind !== 'capture' || initial[0].file !== manual.relative) fail();
  const current = await leaf(intake, path.join(intake.vault.vault, manual.relative), 'capture');
  if (Object.keys(current.target).some(key => current.target[key] !== initial[0][key]) || current.target.sha256 !== manual.currentHash) fail();
  current.note = note(current, manual);
  const backups = [];
  for (const file of candidates) {
    if (!backupName(file, manual.relative)) fail();
    const value = await leaf(intake, path.join(intake.vault.vault, file), 'source-title-backup');
    value.note = note(value, manual); backups.push(value);
  }
  // This deterministic witness proves actual bytes, not historical order.
  const nonFixed = backups.filter(value => !value.bytes.equals(Buffer.from(withTitle(value.text, value.note.title), 'utf8')));
  if (nonFixed.length > 1) fail();
  const baseline = nonFixed[0] || backups[0], chain = [baseline, ...backups.filter(value => value !== baseline), current];
  const sourceGeneration = owner?.generation ?? null, titleProofs = [];
  for (let index = 0; index < chain.length - 1; index++) {
    const before = chain[index], after = chain[index + 1];
    if (!after.bytes.equals(Buffer.from(withTitle(before.text, after.note.title), 'utf8'))) fail();
    titleProofs.push({ before: before.target.file, after: after.target.file, sourceGeneration });
  }
  titleProofs.sort((a, b) => a.before < b.before ? -1 : a.before > b.before ? 1 : 0);
  const result = { inventoryVersion: 1, originGenerations: owner ? [{ captureId: manual.captureId, generation: owner.generation }] : [], titleProofs, targets: [current.target, ...backups.map(value => value.target)].sort((a, b) => a.file.localeCompare(b.file)) };
  await inspect(intake, { ...result, sourceHash: null, manual });
  return result;
}
async function inspect(intake, authority) {
  const terminal = validate(authority, authority.manual.captureId), known = new Set(authority.targets.map(item => item.file));
  // Check the entire adjacent prefix, including malformed names without an id.
  for (const file of await names(intake, terminal.file)) if (!known.has(file)) fail();
  const remaining = [];
  for (const target of authority.targets) {
    let value;
    try { value = await leaf(intake, path.join(intake.vault.vault, target.file), target.kind); }
    catch (error) { if (error.code === 'ENOENT') continue; throw error; }
    if (Object.keys(value.target).some(key => value.target[key] !== target[key])) fail();
    note(value, authority.manual); remaining.push(target);
  }
  // Committed edges attest removed leaves; never replay or reconstruct them.
  return remaining;
}
module.exports = { explicit, validate, inventory, inspect };
