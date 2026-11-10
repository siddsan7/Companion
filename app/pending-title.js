const fs = require('node:fs/promises');
const path = require('node:path');
const { hash } = require('./intake-producer');
const fail = () => { throw Object.assign(Error('Pending title recovery contains changed or unsupported writing. Preserve it for explicit review.'), { code: 'SOURCE_FILE_CHANGED' }); };
const uuid = value => typeof value === 'string' && /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(value);
const relative = (intake, file) => path.relative(intake.vault.vault, file).split(path.sep).join('/');
const roles = ['current', 'pending', 'intent', 'transaction', 'snapshot'];
const keys = ['format', ...roles, 'revisionId', 'sourceGeneration'];
const exact = (value, names) => value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === names.length && names.every(key => Object.hasOwn(value, key));
const safe = value => typeof value === 'string' && !!value && !/[\\:]/.test(value) && value.split('/').every(part => part && part !== '.' && part !== '..');
function validate(authority, id) {
  const proof = authority.titleRecovery; if (proof === undefined) return;
  if (authority.inventoryVersion !== 2 || authority.manual || !exact(proof, keys) || proof.format !== 'imported-title-staged-v1' || !roles.every(role => safe(proof[role])) || new Set(roles.map(role => proof[role])).size !== 5 || !uuid(proof.revisionId) || !(proof.sourceGeneration === null || uuid(proof.sourceGeneration)) || !Array.isArray(authority.originGenerations) || authority.originGenerations.length !== (proof.sourceGeneration === null ? 0 : 1) || authority.originGenerations.some(item => item.captureId !== id || item.generation !== proof.sourceGeneration) || (authority.titleProofs || []).length || authority.targets.some(item => item.kind === 'source-title-backup')) fail();
  const targets = roles.map(role => authority.targets.filter(item => item.file === proof[role]));
  if (targets.some(items => items.length !== 1)) fail();
  const values = targets.map(items => items[0]);
  if (values.some((item, index) => item.kind !== (index === 0 ? 'capture' : index === 4 ? 'snapshot' : 'source-recovery') || item.peers !== undefined) || new Set(values.map(item => item.dev + ':' + item.ino)).size !== 5 || authority.targets.filter(item => item.kind === 'capture').length !== 1) fail();
  for (const value of values) if (authority.targets.some(item => item.file !== value.file && item.dev === value.dev && item.ino === value.ino)) fail();
  const parent = path.posix.dirname(proof.current), root = path.posix.dirname(path.posix.dirname(proof.snapshot));
  if (proof.pending !== proof.current + '.pending' || proof.transaction !== proof.current + '.title-transaction.json' || proof.snapshot !== root + '/Revisions/' + proof.revisionId + '.json' || proof.intent !== root + '/.intake/title-intent.json' || !(parent === root + '/Captures' || parent.startsWith(root + '/Captures/'))) fail();
  return proof;
}
function sidecars(proof) { return proof ? [proof.pending, proof.intent, proof.transaction] : []; }
async function noBackup(intake, proof) {
  const file = path.join(intake.vault.vault, proof.current), directory = path.dirname(file);
  await intake.vault.contained(directory);
  if ((await fs.readdir(directory)).some(name => name.startsWith(path.basename(file) + '.before-title-'))) fail();
}
async function inspect(intake, ledger, authority) {
  const capture = ledger.captures[authority.sourceHash], proof = validate(authority, capture?.id); if (!proof) return;
  const known = require('./source-authority').revisionAdmission(ledger, proof.revisionId), snapshot = authority.targets.find(item => item.file === proof.snapshot);
  if (!capture || capture.currentRevision !== proof.revisionId || known?.status !== 'imported' || known.captureId !== capture.id || known.sourceHash !== authority.sourceHash || known.snapshotHash !== snapshot.sha256 || (known.sourceGeneration ?? null) !== proof.sourceGeneration || proof.current !== relative(intake, intake.destination(capture)) || proof.snapshot !== relative(intake, path.join(intake.vault.root, 'Revisions', proof.revisionId + '.json')) || proof.intent !== relative(intake, path.join(intake.dir, 'title-intent.json'))) fail();
  await noBackup(intake, proof);
}
async function inventory(intake, ledger, capture, sourceHash, revisions, initial) {
  const intentFile = path.join(intake.dir, 'title-intent.json');
  const { leaf } = require('./source-title');
  let intent; try { intent = await leaf(intake, intentFile, 'source-recovery'); } catch (error) { if (error.code === 'ENOENT') return; throw error; }
  let a; try { a = JSON.parse(intent.text); } catch { fail(); }
  if (!a || !exact(a, ['id', 'before', 'previousHash', 'title', 'content', ...(Object.hasOwn(a, 'sourceGeneration') ? ['sourceGeneration'] : [])]) || !intent.bytes.equals(Buffer.from(JSON.stringify(a)))) fail();
  // The global intent can belong to a different admitted capture. Its bytes still
  // pass the selected-source scanner; ownership alone exempts no selected copy.
  if (a.id !== capture.id && Object.values(ledger.captures).some(owner => owner.id === a.id)) return;
  const currentFile = intake.destination(capture), snapshotFile = path.join(intake.vault.root, 'Revisions', capture.currentRevision + '.json');
  const current = await leaf(intake, currentFile, 'capture'), pending = await leaf(intake, currentFile + '.pending', 'source-recovery'), transaction = await leaf(intake, currentFile + '.title-transaction.json', 'source-recovery'), snapshot = await leaf(intake, snapshotFile, 'snapshot');
  for (const value of [current, snapshot]) {
    const prior = initial.find(item => item.file === value.target.file);
    if (!prior || Object.keys(value.target).some(key => prior[key] !== value.target[key])) fail();
  }
  const known = require('./source-authority').revisionAdmission(ledger, capture.currentRevision), revision = revisions.get(capture.currentRevision), authority = ledger.sourceAuthority?.[capture.id], generation = authority?.phase === 'active' ? authority.generation : undefined;
  if (!revision || !known || known.status !== 'imported' || known.captureId !== capture.id || known.sourceHash !== revision.sourceHash || known.sourceHash !== sourceHash || known.snapshotHash !== snapshot.target.sha256 || known.identity !== revision.identity || known.fingerprint !== revision.fingerprint || known.sourceGeneration !== generation) fail();
  if (!snapshot.bytes.equals(Buffer.from(JSON.stringify(revision, null, 2)))) fail();
  let b; try { b = JSON.parse(transaction.text); } catch { fail(); }
  const generationKeys = generation === undefined ? [] : ['sourceGeneration'];
  if (!exact(a, ['id', 'before', 'previousHash', 'title', 'content', ...generationKeys]) || !exact(b, ['expectedHash', 'content', 'backup', ...generationKeys]) || !intent.bytes.equals(Buffer.from(JSON.stringify(a))) || !transaction.bytes.equals(Buffer.from(JSON.stringify(b))) || a.id !== capture.id || a.sourceGeneration !== generation || b.sourceGeneration !== generation || typeof a.title !== 'string' || !a.title || a.title !== a.title.trim() || /[\r\n]/.test(a.title)) fail();
  const { noteText } = require('./intake'), { parse, withTitle } = require('./vault');
  if (a.before !== noteText(capture, revision) || hash(a.before) !== capture.currentHash || a.previousHash !== capture.currentHash || b.expectedHash !== capture.currentHash || a.content !== withTitle(a.before, a.title) || b.content !== a.content || !pending.bytes.equals(Buffer.from(a.content))) fail();
  const note = parse(current.text), baseline = parse(a.before), proposed = parse(a.content);
  if (![note, baseline, proposed].every(value => value && value.id === capture.id && value.type === 'reel_import' && value.capturedAt === capture.capturedAt) || baseline.title !== capture.title || a.title === baseline.title || note.title === baseline.title || note.title === a.title || !current.bytes.equals(Buffer.from(withTitle(a.before, note.title)))) fail();
  const prefix = path.basename(currentFile) + '.before-title-';
  if (typeof b.backup !== 'string' || !b.backup.startsWith(prefix) || !b.backup.endsWith('.bak') || !uuid(b.backup.slice(prefix.length, -4)) || path.basename(b.backup) !== b.backup) fail();
  const proof = { format: 'imported-title-staged-v1', current: current.target.file, pending: pending.target.file, intent: intent.target.file, transaction: transaction.target.file, snapshot: snapshot.target.file, revisionId: revision.id, sourceGeneration: generation ?? null };
  const targets = [...initial, pending.target, intent.target, transaction.target], checked = { inventoryVersion: 2, sourceHash: known.sourceHash, targets, originGenerations: generation === undefined ? [] : [{ captureId: capture.id, generation }], titleRecovery: proof };
  validate(checked, capture.id); await inspect(intake, ledger, checked);
  return { targets, titleRecovery: proof };
}
module.exports = { validate, sidecars, inspect, inventory };
