const fs = require('node:fs/promises');
const local = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');

const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const identity = stat => ({ dev: String(stat.dev), ino: String(stat.ino) });
const same = (a, b) => a.dev === b.dev && a.ino === b.ino;
const changed = () => Error('Staging file or publication peer changed. Files were preserved for inspection.');

function ordinaryDirectories(directories, message, expected) {
  const comparable = file => process.platform === 'win32' ? file.toLowerCase() : file;
  function directoryIdentity(directory) {
    const stat = local.lstatSync(directory, { bigint: true });
    if (!stat.isDirectory() || stat.isSymbolicLink() || comparable(local.realpathSync(directory)) !== comparable(path.resolve(directory))) throw Error(message);
    return identity(stat);
  }
  const identities = expected || directories.map(directoryIdentity);
  const guard = () => {
    if (!Array.isArray(identities) || identities.length !== directories.length ||
        directories.some((directory, index) => !identities[index] || !same(directoryIdentity(directory), identities[index]))) throw Error(message);
  };
  guard();
  return { guard, identities };
}

async function readExact(file, guard, links = 1, expected) {
  guard();
  const before = await fs.lstat(file, { bigint: true });
  const check = stat => {
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== BigInt(links) || !same(stat, before) ||
        expected && !same(identity(stat), expected)) throw changed();
  };
  check(before);
  const handle = await fs.open(file, local.constants.O_RDONLY | (local.constants.O_NOFOLLOW || 0));
  try {
    const opened = await handle.stat({ bigint: true });
    check(opened);
    const bytes = await handle.readFile(), after = await handle.stat({ bigint: true });
    const leaf = await fs.lstat(file, { bigint: true });
    guard(); check(after); check(leaf);
    const proof = { ...identity(leaf), digest: digest(bytes) };
    if (opened.size !== BigInt(bytes.length) || opened.size !== after.size || opened.size !== leaf.size ||
        opened.mtimeNs !== after.mtimeNs || opened.mtimeNs !== leaf.mtimeNs ||
        expected && proof.digest !== expected.digest) throw changed();
    return { bytes, proof };
  } finally { await handle.close(); }
}

async function writeStage(file, content, guard) {
  const bytes = Buffer.isBuffer(content) ? content : Buffer.from(content);
  guard();
  const handle = await fs.open(file, 'wx');
  try {
    const stat = await handle.stat({ bigint: true });
    guard();
    await handle.writeFile(bytes); await handle.sync(); guard();
    return { ...identity(stat), digest: digest(bytes) };
  } finally { await handle.close(); }
}

async function verifyStage(file, guard, proof, links = 1) {
  try { return await readExact(file, guard, links, proof); }
  catch (error) { if (error.code === 'ENOENT') throw changed(); throw error; }
}

async function verifyPeers(stage, destination, guard, proof) {
  await verifyStage(stage, guard, proof, 2);
  await verifyStage(destination, guard, proof, 2);
}

async function removeStage(file, guard, proof, links = 1) {
  await verifyStage(file, guard, proof, links);
  guard();
  await fs.unlink(file);
}

module.exports = { digest, ordinaryDirectories, readExact, writeStage, verifyStage, verifyPeers, removeStage };
