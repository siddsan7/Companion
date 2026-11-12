const { uuid } = require('./source-authority');
const path = require('node:path');
const fields = (value, names) => value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).every(key => names.includes(key));
const safe = value => typeof value === 'string' && !/[\\:]/.test(value) && value.split('/').every(part => part && part !== '.' && part !== '..');
const number = value => typeof value === 'string' && /^[0-9]+$/.test(value);
const kinds = ['annotation-note', 'annotation-intent', 'annotation-stage', 'relationship-journal', 'relationship-before', 'relationship-stage', 'relationship-held'];
const activeAnnotationIntent = 'annotation-intent.json';
const heldAnnotationIntent = id => `annotation-${id}.held.json`;
const isAnnotationIntent = name => name === activeAnnotationIntent || /^annotation-[a-f0-9-]{36}\.held\.json$/.test(name);
function validateAnnotationRemovals(ledger) {
  if (ledger.annotationRemovals !== undefined && !fields(ledger.annotationRemovals, Object.keys(ledger.annotationRemovals || {}))) throw Error('Annotation removal authority needs repair.');
  for (const [id, value] of Object.entries(ledger.annotationRemovals || {})) {
    if (!uuid(id) || !fields(value, ['operationId', 'phase', 'captureId', 'root', 'directories', 'targets']) || !uuid(value.operationId) || !uuid(value.captureId) || !['removing', 'removed'].includes(value.phase) || typeof value.root !== 'string' || !path.isAbsolute(value.root) || !Array.isArray(value.directories) || !value.directories.length || !Array.isArray(value.targets) || !value.targets.length) throw Error('Annotation removal authority needs repair.');
    let previous = null;
    for (const directory of value.directories) {
      if (!fields(directory, ['file', 'dev', 'ino']) || directory.file !== '' && !safe(directory.file) || !number(directory.dev) || !number(directory.ino) || previous !== null && directory.file <= previous) throw Error('Annotation removal folder authority needs repair.');
      previous = directory.file;
    }
    const targets = new Map(); previous = '';
    for (const target of value.targets) {
      if (!fields(target, ['file', 'sha256', 'dev', 'ino', 'bytes', 'kind', 'peers']) || !safe(target.file) || target.file <= previous || !/^[a-f0-9]{64}$/.test(target.sha256) || ![target.dev, target.ino, target.bytes].every(number) || !kinds.includes(target.kind) || !Array.isArray(target.peers) || !target.peers.includes(target.file) || target.peers.some((peer, index) => !safe(peer) || index && peer <= target.peers[index - 1])) throw Error('Annotation removal file authority needs repair.');
      previous = target.file; targets.set(target.file, target);
      const parts = target.file.split('/'); parts.pop();
      while (parts.length) { if (!value.directories.some(dir => dir.file === parts.join('/'))) throw Error('Annotation removal parent authority needs repair.'); parts.pop(); }
    }
    if (!value.directories.some(dir => dir.file === '')) throw Error('Annotation removal root authority needs repair.');
    const stores = value.directories.filter(dir => dir.file === '.intake' || dir.file.endsWith('/.intake'));
    if (stores.length !== 1) throw Error('Annotation removal store authority needs repair.');
    const store = stores[0].file + '/';
    for (const target of targets.values()) {
      const name = target.file.slice(store.length), relationship = name.match(/^link-([a-f0-9-]{36})\.(json|before\.md|stage|held-(?:before|stage)-[a-f0-9]{64}\.md)$/);
      const namespace = target.kind === 'annotation-note' ? !target.file.startsWith(store) && target.file.endsWith('.md')
        : target.file.startsWith(store) && (target.kind === 'annotation-intent' ? name === activeAnnotationIntent || name === heldAnnotationIntent(id)
          : target.kind === 'annotation-stage' ? name === `annotation-${id}.stage`
            : target.kind === 'relationship-journal' ? name === 'link-intent.json' || !!relationship && uuid(relationship[1]) && relationship[2] === 'json'
              : !!relationship && uuid(relationship[1]) && (target.kind === 'relationship-before' ? relationship[2] === 'before.md' : target.kind === 'relationship-stage' ? relationship[2] === 'stage' : relationship[2].startsWith('held-')));
      if (!namespace) throw Error('Annotation removal namespace needs repair.');
    }
    for (const target of targets.values()) for (const peer of target.peers) {
      const other = targets.get(peer);
      if (!other || ['sha256', 'dev', 'ino', 'bytes'].some(key => target[key] !== other[key]) || JSON.stringify(target.peers) !== JSON.stringify(other.peers)) throw Error('Annotation removal peer authority needs repair.');
    }
  }
}
function annotationRemoved(ledger, id) { validateAnnotationRemovals(ledger); return !!ledger.annotationRemovals?.[id]; }
function assertAnnotationPublication(ledger, id) {
  if (!uuid(id) || annotationRemoved(ledger, id)) throw Object.assign(Error('This annotation identity was removed. Old writing cannot be published again; author new writing with a new identity.'), { code: 'ANNOTATION_REMOVED' });
}
module.exports = { validateAnnotationRemovals, assertAnnotationPublication, annotationRemoved, activeAnnotationIntent, heldAnnotationIntent, isAnnotationIntent };
