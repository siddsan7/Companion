const uuid = value => typeof value === 'string' && /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(value);
const sha = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const fields = (value, names) => value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).every(key => names.includes(key));
function validateAuthority(ledger) {
  if (ledger.sourceAuthority !== undefined && (!ledger.sourceAuthority || typeof ledger.sourceAuthority !== 'object' || Array.isArray(ledger.sourceAuthority))) throw Error('Source authority needs repair.');
  for (const [id, value] of Object.entries(ledger.sourceAuthority || {})) {
    if (!uuid(id) || !fields(value, ['generation', 'phase', 'operationId', 'sourceHash', 'targets', 'root', 'directories', 'history', 'restoration']) || !uuid(value.generation) || !uuid(value.operationId) || !['deleting', 'deleted', 'restoring', 'active'].includes(value.phase) || !sha(value.sourceHash) || !Array.isArray(value.targets) || !Array.isArray(value.directories) || typeof value.root !== 'string') throw Error('Source authority needs repair. Nothing can be published.');
    const paths = new Set();
    for (const target of value.targets) {
      if (!fields(target, ['file', 'sha256', 'dev', 'ino', 'bytes', 'kind']) || typeof target.file !== 'string' || !target.file || /[\\]/.test(target.file) || target.file.split('/').some(part => !part || part === '.' || part === '..' || part.includes(':')) || paths.has(target.file) || !sha(target.sha256) || !['capture', 'snapshot', 'source-backup'].includes(target.kind) || ![target.dev, target.ino, target.bytes].every(item => typeof item === 'string' && /^[0-9]+$/.test(item))) throw Error('Source deletion manifest needs repair. All files were preserved.');
      paths.add(target.file);
    }
    for (const directory of value.directories) if (!fields(directory, ['file', 'dev', 'ino']) || typeof directory.file !== 'string' || directory.file !== '' && (/[\\:]/.test(directory.file) || directory.file.split('/').some(part => !part || part === '.' || part === '..')) || ![directory.dev, directory.ino].every(item => typeof item === 'string' && /^[0-9]+$/.test(item))) throw Error('Source deletion directory manifest needs repair.');
    if (value.history !== undefined) {
      if (!Array.isArray(value.history)) throw Error('Source deletion history needs repair.');
      for (const prior of value.history) {
        if (prior?.phase !== 'deleted' || prior.history !== undefined || prior.restoration !== undefined) throw Error('Source deletion history needs repair.');
        validateAuthority({ sourceAuthority: { [id]: prior } });
      }
    }
    if (value.phase === 'restoring') {
      const item = value.restoration;
      if (!fields(item, ['journal', 'revision', 'sha256', 'published']) || !uuid(item.revision) || !sha(item.sha256) || item.journal !== `restoration-${value.operationId}.json` || item.published !== undefined && item.published !== true) throw Error('Source restoration authority needs repair.');
    } else if (value.restoration !== undefined) throw Error('Unexpected source restoration authority.');
  }
  if (ledger.admissions !== undefined) {
    if (!ledger.admissions || typeof ledger.admissions !== 'object' || Array.isArray(ledger.admissions)) throw Error('Revision admissions need repair.');
    for (const [revision, item] of Object.entries(ledger.admissions)) {
      if (!fields(item, ['status', 'identity', 'fingerprint', 'revision', 'snapshotHash', 'sourceHash', 'captureId', 'locator', 'checkedAt', 'sourceGeneration']) || !uuid(revision) || item.revision !== revision || item.status !== 'imported' || typeof item.identity !== 'string' || !item.identity || !sha(item.fingerprint) || !sha(item.snapshotHash) || !sha(item.sourceHash) || !uuid(item.captureId) || !uuid(item.sourceGeneration) || typeof item.locator !== 'string' || typeof item.checkedAt !== 'string') throw Error('Revision admission needs repair.');
      const accepted = ledger.attempts?.[item.identity];
      if (!accepted || accepted.fingerprint !== item.fingerprint || accepted.captureId !== item.captureId || accepted.sourceHash !== item.sourceHash) throw Error('Revision admission disagrees with the original producer acceptance.');
    }
  }
}
function assertPublication(ledger, id, transaction = {}) {
  validateAuthority(ledger);
  const authority = ledger.sourceAuthority?.[id];
  if (!authority && transaction.sourceGeneration === undefined && transaction.restoreOperation === undefined) return;
  if (authority?.phase === 'active' && transaction.sourceGeneration === authority.generation && transaction.restoreOperation === undefined) return;
  if (authority?.phase === 'restoring' && transaction.sourceGeneration === authority.generation && transaction.restoreOperation === authority.operationId && transaction.revision?.id === authority.restoration.revision) return;
  throw Object.assign(Error('This capture has changed source authority. Old recovery files cannot publish it.'), { code: 'SOURCE_AUTHORITY_DENIED' });
}
function revisionAdmission(ledger, revision) {
  validateAuthority(ledger);
  const original = Object.values(ledger.attempts).filter(item => item.revision === revision), added = ledger.admissions?.[revision];
  if (original.length > 1 || added && original.length && JSON.stringify(original[0]) !== JSON.stringify(added)) throw Error('Revision admission is ambiguous.');
  return added || original[0];
}
function activeAdmission(ledger, identity, captureId) {
  validateAuthority(ledger);
  const authority = ledger.sourceAuthority?.[captureId];
  if (!authority) return ledger.attempts[identity];
  if (!['active', 'restoring'].includes(authority.phase)) return undefined;
  const matches = Object.values(ledger.admissions || {}).filter(item => item.identity === identity && item.captureId === captureId && item.sourceGeneration === authority.generation);
  if (matches.length > 1) throw Error('Active revision admission is ambiguous.');
  return matches[0];
}
module.exports = { validateAuthority, assertPublication, revisionAdmission, activeAdmission, uuid };
