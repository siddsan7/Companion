const uuid = value => typeof value === 'string' && /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(value);
const sha = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const fields = (value, names) => value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).every(key => names.includes(key));
function validateAuthority(ledger) {
  if (ledger.sourceAuthority === undefined) return;
  if (!fields(ledger.sourceAuthority, Object.keys(ledger.sourceAuthority))) throw Error('Source authority needs repair. Nothing can be published.');
  for (const [id, value] of Object.entries(ledger.sourceAuthority)) {
    if (!uuid(id) || !fields(value, ['generation', 'phase', 'operationId', 'sourceHash', 'targets', 'root', 'directories']) || !uuid(value.generation) || !uuid(value.operationId) || !['deleting', 'deleted'].includes(value.phase) || !sha(value.sourceHash) || !Array.isArray(value.targets) || !Array.isArray(value.directories) || typeof value.root !== 'string') throw Error('Source authority needs repair. Nothing can be published.');
    const paths = new Set();
    for (const target of value.targets) {
      if (!fields(target, ['file', 'sha256', 'dev', 'ino', 'bytes', 'kind']) || typeof target.file !== 'string' || !target.file || /[\\]/.test(target.file) || target.file.split('/').some(part => !part || part === '.' || part === '..' || part.includes(':')) || paths.has(target.file) || !sha(target.sha256) || !['capture', 'snapshot', 'source-backup'].includes(target.kind) || ![target.dev, target.ino, target.bytes].every(item => typeof item === 'string' && /^[0-9]+$/.test(item))) throw Error('Source deletion manifest needs repair. All files were preserved.');
      paths.add(target.file);
    }
    for (const directory of value.directories) if (!fields(directory, ['file', 'dev', 'ino']) || typeof directory.file !== 'string' || directory.file !== '' && (/[\\:]/.test(directory.file) || directory.file.split('/').some(part => !part || part === '.' || part === '..')) || ![directory.dev, directory.ino].every(item => typeof item === 'string' && /^[0-9]+$/.test(item))) throw Error('Source deletion directory manifest needs repair.');
  }
}
function assertPublication(ledger, id) {
  validateAuthority(ledger);
  if (ledger.sourceAuthority?.[id]) throw Error('This capture was deliberately deleted. Its old recovery files cannot publish it.');
}
module.exports = { validateAuthority, assertPublication, uuid };
