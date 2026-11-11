const fs = require('node:fs/promises');
const local = require('node:fs');
const path = require('node:path');
const { ordinaryDirectories, verifyStageSync } = require('./staged-publication');
const relative = (vault, file) => path.relative(vault.vault, file).split(path.sep).join('/');
function requiredDirectories(intake, targets, preservedWriting = []) {
  const vault = intake.vault, result = new Set();
  for (const start of [intake.dir, path.join(vault.root, 'Captures'), path.join(vault.root, 'Revisions'), ...targets.map(target => path.dirname(path.join(vault.vault, target.file))), ...preservedWriting.flatMap(plan => [plan.file, plan.stage]).map(file => path.dirname(path.join(vault.vault, file)))]) {
    let directory = start;
    while (true) {
      const name = relative(vault, directory);
      if (name === '..' || name.startsWith('../') || path.isAbsolute(name)) throw Error('Source recovery folder scope is invalid.');
      result.add(name); if (directory === vault.vault) break;
      const parent = path.dirname(directory); if (parent === directory) throw Error('Source recovery folder scope is invalid.'); directory = parent;
    }
  }
  return result;
}
async function directory(intake, name) {
  const file = path.join(intake.vault.vault, name), stat = await fs.lstat(file, { bigint: true });
  await intake.vault.contained(file);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw Error('Source recovery requires ordinary unchanged shared folders.');
  return { file: name, dev: String(stat.dev), ino: String(stat.ino) };
}
async function sourceParents(intake, authority, reviewMissing = false) {
  if (await fs.realpath(intake.vault.vault) !== authority.root) throw Error('Source recovery vault identity changed. All files were preserved.');
  const required = requiredDirectories(intake, authority.targets, authority.preservedWriting), found = new Set();
  for (const item of authority.directories) {
    if (!required.has(item.file) || found.has(item.file) || JSON.stringify(await directory(intake, item.file)) !== JSON.stringify(item)) throw Error('Source recovery parent identity changed. All files were preserved.');
    found.add(item.file);
  }
  const missing = [...required].filter(name => !found.has(name));
  if (missing.length) {
    const added = new Set(['Captures', 'Revisions'].map(name => relative(intake.vault, path.join(intake.vault.root, name))));
    if (missing.some(name => !added.has(name))) throw Error('Source recovery directory authority is incomplete. Preserve it for repair.');
    if (!reviewMissing) throw Object.assign(Error('Recovery folders need a fresh explicit review. Use Review recovery folders before resuming this operation.'), { code: 'SOURCE_SCOPE_REVIEW_REQUIRED' });
  }
  const result = [];
  for (const name of [...required].sort()) result.push(await directory(intake, name));
  return result;
}
function removalParentGuard(vault, directories) {
  const message = 'Removal folder identity changed. All remaining files were preserved.';
  return ordinaryDirectories(directories.map(item => path.join(vault.vault, item.file)), message, directories).guard;
}
function verifyRemovalTarget(vault, target, survivingPeers, guard, changed) {
  guard();
  if (!survivingPeers.includes(target.file)) throw changed();
  const proof = { dev: target.dev, ino: target.ino, digest: target.sha256 };
  for (const name of target.peers || [target.file]) {
    const file = path.join(vault.vault, name);
    if (survivingPeers.includes(name)) {
      try { verifyStageSync(file, guard, proof, survivingPeers.length); }
      catch (error) { if (error.code === 'STAGING_CHANGED') throw changed(); throw error; }
    } else if (local.lstatSync(file, { throwIfNoEntry: false })) throw changed();
  }
}
async function pendingParents(intake, ledger) {
  const pending = Object.values(ledger.sourceAuthority || {}).filter(authority => ['deleting', 'restoring'].includes(authority.phase));
  for (const authority of pending) await sourceParents(intake, authority);
  if (pending.length) await globalRecovery(intake, ledger);
}
async function globalRecovery(intake, ledger) {
  const file = path.join(intake.dir, 'transaction.json');
  for (const authority of Object.values(ledger.sourceAuthority || {})) if (authority.phase === 'deleting' && authority.inventoryVersion === 2 && authority.recovery.some(item => item.format === 'transaction' && item.file === relative(intake.vault, file))) {
    const inventory = require('./source-inventory');
    inventory.inspectPointers(ledger, authority);
    await inventory.inspectTargets(intake, authority);
    // The already-consented journal may have been unlinked. Its content-free
    // committed proof still binds every surviving publication peer.
    return;
  }
  const peers = Object.values(ledger.sourceAuthority || {}).filter(authority => authority.phase === 'restoring' && !authority.manual).map(authority => path.join(intake.dir, authority.restoration.journal));
  for (const item of [...Object.values(ledger.pending), ...Object.values(ledger.blocks)]) if (typeof item?.journal === 'string' && /^(?:pending|conflict)-[a-f0-9-]{36}(?:-[a-f0-9-]{36})?\.json$/.test(item.journal)) peers.push(path.join(intake.dir, item.journal));
  if (local.lstatSync(file, { bigint: true, throwIfNoEntry: false })?.nlink === 3n) {
    const exact = intake.ordinaryRecoveryJournal(ledger);
    if (exact?.links === 3) return;
  }
  const info = await intake.ownedFile(file, peers, 'Global intake recovery journal');
  if (info) intake.validateTransaction(JSON.parse(await fs.readFile(file, 'utf8')));
}
function held(id, authority, message) {
  return Object.assign(Error(message), { code: 'SOURCE_OPERATION_HELD', captureId: id, operationId: authority.operationId, family: 'manual-restoration' });
}
function isManualHold(error, id, authority) {
  return authority?.manual && authority.phase === 'restoring' && error.code === 'SOURCE_OPERATION_HELD' && error.family === 'manual-restoration' && error.captureId === id && error.operationId === authority.operationId;
}
async function manualLeaf(intake, ledger, id, file, work) {
  const authority = ledger.sourceAuthority[id], names = [path.join(intake.vault.vault, authority.manual.relative), path.join(intake.dir, authority.restoration.journal), path.join(intake.dir, `manual-${authority.operationId}.stage`), ...(authority.restoration.retirement?.slots || []).map(item => path.join(intake.vault.vault, item.file))];
  if (!names.includes(file)) throw Error('Unknown manual recovery file cannot receive a source-specific hold.');
  try { return await work(); }
  catch (error) {
    if (!(error.intakeConflict || ['ENOENT', 'EEXIST', 'SOURCE_FILE_CHANGED'].includes(error.code) || error instanceof SyntaxError)) throw error;
    // A file-local failure never hides changed global authority or shared roots.
    await pendingParents(intake, ledger);
    if (!intake.storage.matches(await intake.storage.view())) throw Error('Intake ledger changed during source recovery. Refresh before retrying.');
    throw held(id, authority, `Manual restoration held: ${error.message}`);
  }
}
module.exports = { requiredDirectories, directory, sourceParents, pendingParents, globalRecovery, held, isManualHold, manualLeaf, removalParentGuard, verifyRemovalTarget };
