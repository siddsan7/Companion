const fs = require('node:fs/promises');
const path = require('node:path');
const { intakeLock } = require('./intake-lock');
const { uuid } = require('./source-authority');
const { ordinaryDirectories, readExact, writeStage, verifyStage } = require('./staged-publication');

const storeName = '.companion-capture-owners';
const comparable = value => process.platform === 'win32' ? value.toLowerCase() : value;
const parentOf = (vault, root) => path.relative(vault, root).split(path.sep).join('/');
const legacy = note => ['thought', 'link'].includes(note.type) && !Object.hasOwn(note, 'managedParent');
const ownerWarning = 'Legacy capture ownership could not be verified. Preserve the file and inspect its original managed parent.';
const badStore = 'Legacy capture ownership requires ordinary, unchanged folders.';

function validReceipt(receipt, id) {
  return receipt && Object.keys(receipt).sort().join(',') === 'capturedAt,id,owner,schema,type' &&
    receipt.schema === 1 && receipt.id === id && ['thought', 'link'].includes(receipt.type) &&
    typeof receipt.capturedAt === 'string' && Number.isFinite(Date.parse(receipt.capturedAt)) &&
    typeof receipt.owner === 'string' && !/[\\<>:"|?*\x00\r\n]/.test(receipt.owner) &&
    receipt.owner.split('/').every(part => part && part !== '.' && part !== '..');
}

function sameCapture(note, record) {
  return note.type === record.type && note.capturedAt === record.capturedAt;
}

async function captureOwners(vault, notes, managedRoots, importedIds, authority = {}) {
  const groups = new Map();
  for (const note of notes) {
    if (importedIds.has(note.id)) continue;
    if (!groups.has(note.id)) groups.set(note.id, []);
    groups.get(note.id).push(note);
  }
  const legacyGroups = [...groups].filter(([, copies]) => copies.some(legacy));
  const owned = new Set();
  if (!legacyGroups.length) return { owned, held: false };

  const root = path.resolve(vault.vault), directory = path.join(root, storeName);
  const selected = comparable(parentOf(root, vault.root));
  const captureArea = comparable(path.join(vault.root, 'Captures'));
  const here = note => comparable(path.dirname(note.file)) === captureArea;
  let held = false;
  await intakeLock(root, async () => {
    const rootGuard = ordinaryDirectories([root], badStore).guard;
    let guard;
    async function store(create) {
      if (guard) { guard(); return guard; }
      rootGuard();
      try { await fs.lstat(directory); }
      catch (error) {
        if (error.code !== 'ENOENT') throw error;
        if (!create) return null;
        rootGuard();
        await fs.mkdir(directory).catch(error => { if (error.code !== 'EEXIST') throw error; });
      }
      rootGuard();
      guard = ordinaryDirectories([root, directory], badStore).guard;
      return guard;
    }

    for (const [id, copies] of legacyGroups) {
      const candidates = copies.filter(legacy);
      const history = authority[id];
      const prior = history?.phase === 'active' && history.manual?.captureId === id ? history.manual : null;
      if (!uuid(id)) { held ||= candidates.some(here); continue; }
      const file = path.join(directory, `${id}.json`);
      try {
        const reader = await store(false);
        const stored = reader && await readExact(file, reader).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
        if (stored) {
          const receipt = JSON.parse(stored.bytes);
          if (!validReceipt(receipt, id)) throw Error(ownerWarning);
          if (comparable(receipt.owner) === selected) {
            for (const note of candidates) {
              if (sameCapture(note, receipt)) owned.add(note);
              else held = true;
            }
          } else if (prior) held = true;
          continue;
        }

        const eligible = candidates.filter(note => prior ? sameCapture(note, prior) : managedRoots.size === 1 && here(note));
        if (!eligible.length) { held ||= candidates.some(here) || !!prior; continue; }
        if (copies.length > 1) {
          // Reserve every claim for duplicate repair without recording an owner
          // from an ambiguous observation.
          for (const note of eligible) owned.add(note);
          continue;
        }
        const [note] = eligible;
        const receipt = { schema: 1, id, owner: parentOf(root, vault.root), type: note.type, capturedAt: note.capturedAt };
        const writer = await store(true);
        const parentGuard = vault.publicationFolders(path.dirname(note.file)).guard;
        const observation = await readExact(note.file, parentGuard);
        if (!observation.bytes.equals(Buffer.from(note.content))) throw Error(ownerWarning);
        // Readers hold the same native lock. Exclusive creation reserves the
        // identity without replacing an existing receipt. A partial file stays
        // in place and fails validation after an interrupted write.
        const proof = await writeStage(file, JSON.stringify(receipt), writer);
        await verifyStage(file, writer, proof);
        owned.add(note);
      } catch {
        held = true;
      }
    }
  });
  return { owned, held };
}

module.exports = { captureOwners, comparable, ownerWarning, parentOf, storeName };
