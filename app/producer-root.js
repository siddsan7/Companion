const fs = require('node:fs/promises');
const path = require('node:path');

const samePath = (a, b) => process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
const sameFile = (a, b) => a.dev === b.dev && a.ino === b.ino;
const identity = stat => ({ dev: String(stat.dev), ino: String(stat.ino), birth: String(stat.birthtimeNs) });
const sameIdentity = (a, b) => !!a && !!b && a.dev === b.dev && a.ino === b.ino && a.birth === b.birth;
const rootError = message => Object.assign(Error(message), { producerRoot: true });
const unavailable = () => rootError('Source folder is missing or unreadable, or its identity changed. Reconnect it, then Check now.');

async function ordinaryDirectory(folder) {
  const before = await fs.lstat(folder, { bigint: true });
  if (!before.isDirectory() || before.isSymbolicLink()) throw unavailable();
  const canonical = await fs.realpath(folder);
  const after = await fs.lstat(folder, { bigint: true });
  if (!samePath(folder, canonical) || !after.isDirectory() || after.isSymbolicLink() || !sameIdentity(identity(before), identity(after))) throw unavailable();
  return { folder: canonical, identity: identity(after) };
}

async function selectProducerRoot(folder, destination) {
  if (typeof folder !== 'string' || !path.isAbsolute(folder)) throw Error('Choose an absolute producer source folder.');
  let selected;
  try { selected = await ordinaryDirectory(path.resolve(folder)); }
  catch { throw Error('Choose an accessible ordinary producer folder without links or junctions.'); }
  if (inside(selected.folder, await fs.realpath(destination))) throw Error('Choose a producer folder that does not contain the Companion destination.');
  return selected;
}

function inside(root, file) {
  const relative = path.relative(root, file);
  return relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative);
}

function matchesProducerOutcome(source, key, locator) {
  if (!source || typeof locator !== 'string' || !path.isAbsolute(locator)) return false;
  const previous = Array.isArray(source.previousFolders) ? source.previousFolders : [];
  return [source.folder, ...previous].some(folder =>
    typeof folder === 'string' && path.isAbsolute(folder) && inside(folder, locator) &&
    key === `${source.id}:${path.relative(folder, locator) || '.'}`);
}

function producerRootGuard(source) {
  return async () => {
    if (!source.identity) throw rootError('This producer folder was connected before folder identity was recorded. Reconnect it, then Check now.');
    try {
      const current = await ordinaryDirectory(source.folder);
      if (current.folder !== source.folder || !sameIdentity(source.identity, current.identity)) throw unavailable();
    } catch { throw unavailable(); }
  };
}

async function producerCandidate(folder, guardRoot) {
  await guardRoot();
  const selected = await ordinaryDirectory(folder);
  return async () => {
    await guardRoot();
    try {
      const current = await ordinaryDirectory(folder);
      if (current.folder !== selected.folder || !sameIdentity(selected.identity, current.identity)) throw unavailable();
    } catch { throw unavailable(); }
  };
}

async function readProducerFile(file, limit, guard, message) {
  await guard?.();
  const before = await fs.lstat(file, { bigint: true });
  if (!before.isFile() || before.isSymbolicLink() || before.size > BigInt(limit)) throw Error(message);
  const handle = await fs.open(file, 'r');
  try {
    const unchanged = stat => stat.isFile() && sameFile(before, stat) && stat.size === before.size && stat.mtimeNs === before.mtimeNs;
    if (!unchanged(await handle.stat({ bigint: true }))) throw Error(message);
    await guard?.();
    const bytes = await handle.readFile();
    const current = await fs.lstat(file, { bigint: true });
    if (!unchanged(await handle.stat({ bigint: true })) || !unchanged(current) || current.isSymbolicLink() || BigInt(bytes.length) !== before.size) throw Error(message);
    await guard?.();
    return bytes;
  } finally { await handle.close(); }
}

module.exports = { matchesProducerOutcome, producerCandidate, producerRootGuard, readProducerFile, sameIdentity, samePath, selectProducerRoot, unavailable };
