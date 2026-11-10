const uuid = value => typeof value === 'string' && /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(value);
const sha = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const fields = (value, names) => value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).every(key => names.includes(key));
const identity = value => fields(value, ['dev', 'ino', 'bytes']) && ['dev', 'ino', 'bytes'].every(key => typeof value[key] === 'string' && /^[0-9]+$/.test(value[key]));
function retirement(value, id) {
  if (!fields(value, ['captureId', 'operationId', 'generation', 'publication', 'sourceSha256', 'journalSha256', 'slots']) || value.captureId !== id || !uuid(value.operationId) || !uuid(value.generation) || !identity(value.publication) || !sha(value.sourceSha256) || !sha(value.journalSha256) || !Array.isArray(value.slots) || value.slots.length !== 2) throw Error('Restoration retirement authority needs repair.');
  let previous = ''; const kinds = new Set(), parents = new Set();
  for (const slot of value.slots) {
    if (!fields(slot, ['file', 'kind', 'expected']) || typeof slot.file !== 'string' || /[\\:]/.test(slot.file) || slot.file.split('/').some(part => !part || part === '.' || part === '..') || slot.file <= previous || !['manual-restoration-stage', 'restoration-journal'].includes(slot.kind) || kinds.has(slot.kind)) throw Error('Restoration retirement scope needs repair.');
    previous = slot.file; kinds.add(slot.kind); const parts = slot.file.split('/'), name = parts.pop(); parents.add(parts.join('/'));
    if (name !== (slot.kind === 'manual-restoration-stage' ? `manual-${value.operationId}.stage` : `restoration-${value.operationId}.json`) || parts.at(-1) !== '.intake') throw Error('Restoration retirement path needs repair.');
    if (slot.expected !== null) {
      if (!fields(slot.expected, ['sha256', 'dev', 'ino', 'bytes', 'ownership']) || !sha(slot.expected.sha256) || !identity({ dev: slot.expected.dev, ino: slot.expected.ino, bytes: slot.expected.bytes }) || slot.expected.ownership !== (slot.kind === 'manual-restoration-stage' ? 'receipt' : 'reviewed-operation-journal')) throw Error('Restoration retirement file identity needs repair.');
      if (slot.expected.sha256 !== (slot.kind === 'manual-restoration-stage' ? value.sourceSha256 : value.journalSha256) || slot.kind === 'manual-restoration-stage' && ['dev', 'ino', 'bytes'].some(key => slot.expected[key] !== value.publication[key])) throw Error('Restoration retirement disagrees with its publication receipt.');
    }
  }
  if (parents.size !== 1) throw Error('Restoration retirement folder scope needs repair.');
}
function validateAuthority(ledger) {
  if (ledger.sourceAuthority !== undefined && (!ledger.sourceAuthority || typeof ledger.sourceAuthority !== 'object' || Array.isArray(ledger.sourceAuthority))) throw Error('Source authority needs repair.');
  const purgedIdentities = new Map();
  for (const [id, value] of Object.entries(ledger.sourceAuthority || {})) {
    if (!uuid(id) || !fields(value, ['generation', 'phase', 'operationId', 'sourceHash', 'targets', 'root', 'directories', 'history', 'restoration', 'manual', 'retiredRestorations', 'inventoryVersion', 'originGenerations', 'recovery', 'recoveryPointers', 'purgedProducerAttempts']) || !uuid(value.generation) || !uuid(value.operationId) || !['deleting', 'deleted', 'restoring', 'active'].includes(value.phase) || !(value.sourceHash === null ? validManual(value.manual, id) : sha(value.sourceHash) && value.manual === undefined) || !Array.isArray(value.targets) || !Array.isArray(value.directories) || typeof value.root !== 'string') throw Error('Source authority needs repair. Nothing can be published.');
    const paths = new Set();
    for (const target of value.targets) {
      if (!fields(target, ['file', 'sha256', 'dev', 'ino', 'bytes', 'kind', 'peers']) || typeof target.file !== 'string' || !target.file || /[\\]/.test(target.file) || target.file.split('/').some(part => !part || part === '.' || part === '..' || part.includes(':')) || paths.has(target.file) || !sha(target.sha256) || !['capture', 'snapshot', 'source-backup', 'source-recovery'].includes(target.kind) || ![target.dev, target.ino, target.bytes].every(item => typeof item === 'string' && /^[0-9]+$/.test(item))) throw Error('Source deletion manifest needs repair. All files were preserved.');
      paths.add(target.file);
    }
    require('./source-inventory').validateInventory(value, id);
    for (const item of value.purgedProducerAttempts || []) {
      const accepted = ledger.attempts?.[item.identity];
      if (accepted && (accepted.captureId !== item.captureId || accepted.sourceHash !== item.sourceHash || accepted.fingerprint !== item.fingerprint)) throw Error('Purged producer observation contradicts original acceptance. Preserve source authority for repair.');
      const prior = purgedIdentities.get(item.identity);
      if (prior && (prior.captureId !== item.captureId || prior.sourceHash !== item.sourceHash || prior.fingerprint !== item.fingerprint)) throw Error('Purged producer identity is ambiguous.');
      purgedIdentities.set(item.identity, item);
    }
    for (const directory of value.directories) if (!fields(directory, ['file', 'dev', 'ino']) || typeof directory.file !== 'string' || directory.file !== '' && (/[\\:]/.test(directory.file) || directory.file.split('/').some(part => !part || part === '.' || part === '..')) || ![directory.dev, directory.ino].every(item => typeof item === 'string' && /^[0-9]+$/.test(item))) throw Error('Source deletion directory manifest needs repair.');
    if (value.history !== undefined) {
      if (!Array.isArray(value.history)) throw Error('Source deletion history needs repair.');
      for (const prior of value.history) {
        if (prior?.phase !== 'deleted' || prior.history !== undefined || prior.restoration !== undefined) throw Error('Source deletion history needs repair.');
        validateAuthority({ sourceAuthority: { [id]: prior }, attempts: ledger.attempts });
      }
    }
    if (value.phase === 'restoring') {
      const item = value.restoration;
      if (!fields(item, ['journal', 'revision', 'sha256', 'published', 'publication', 'journalIdentity', 'retirement']) || !(value.manual ? item.revision === null : uuid(item.revision)) || !sha(item.sha256) || item.journal !== `restoration-${value.operationId}.json` || item.published !== undefined && item.published !== true) throw Error('Source restoration authority needs repair.');
      if (value.manual && item.published === true ? !fields(item.publication, ['dev', 'ino', 'bytes']) || ![item.publication.dev, item.publication.ino, item.publication.bytes].every(part => typeof part === 'string' && /^[0-9]+$/.test(part)) : item.publication !== undefined) throw Error('Manual restoration publication needs repair.');
      if (item.journalIdentity !== undefined && (!value.manual || !identity(item.journalIdentity))) throw Error('Manual restoration journal identity needs repair.');
      if (item.retirement !== undefined) {
        retirement(item.retirement, id);
        if (!value.manual || !item.journalIdentity || item.retirement.operationId === value.operationId || item.retirement.generation === value.generation || item.retirement.sourceSha256 !== value.manual.currentHash) throw Error('Manual retry authority needs repair.');
      }
    } else if (value.restoration !== undefined) throw Error('Unexpected source restoration authority.');
    if (value.retiredRestorations !== undefined) {
      if (!value.manual || !Array.isArray(value.retiredRestorations)) throw Error('Completed restoration retirement authority needs repair.');
      const operations = new Set(), generations = new Set();
      for (const item of value.retiredRestorations) {
        retirement(item, id);
        if (operations.has(item.operationId) || generations.has(item.generation) || item.operationId === value.operationId || item.generation === value.generation || item.operationId === value.restoration?.retirement?.operationId) throw Error('Restoration retirement history is ambiguous.');
        operations.add(item.operationId); generations.add(item.generation);
      }
    }
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
function validManual(value, id) {
  const safe = file => typeof file === 'string' && !!file && !/[\\:]/.test(file) && file.split('/').every(part => part && part !== '.' && part !== '..');
  return fields(value, ['captureId', 'type', 'capturedAt', 'currentHash', 'file', 'relative']) && value.captureId === id && ['thought', 'link'].includes(value.type) && typeof value.capturedAt === 'string' && /T.*(?:Z|[+-]\d\d:\d\d)$/.test(value.capturedAt) && Number.isFinite(Date.parse(value.capturedAt)) && sha(value.currentHash) && safe(value.file) && !value.file.includes('/') && value.file.endsWith('.md') && safe(value.relative) && (value.relative === value.file || value.relative.endsWith('/' + value.file));
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
