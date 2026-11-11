const fs = require('node:fs/promises');
const local = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');

const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const identity = stat => ({ dev: String(stat.dev), ino: String(stat.ino) });
const same = (a, b) => a.dev === b.dev && a.ino === b.ino;
const changed = () => Object.assign(Error('Staging file or publication peer changed. Files were preserved for inspection.'), { code: 'STAGING_CHANGED' });
const validProof = proof => proof && typeof proof.dev === 'string' && typeof proof.ino === 'string' && typeof proof.digest === 'string' &&
  /^[0-9]+$/.test(proof.dev) && /^[0-9]+$/.test(proof.ino) && /^[a-f0-9]{64}$/.test(proof.digest);

function checkFile(stat, before, links, expected) {
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== BigInt(links) || !same(stat, before) ||
      expected && !same(identity(stat), expected)) throw changed();
}

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
  const check = stat => checkFile(stat, before, links, expected);
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

// Final synchronous proof keeps cooperative mutations from yielding between
// verification and the caller's filesystem operation. It is not an OS CAS.
function readExactSync(file, guard, links = 1, expected) {
  guard();
  const options = { bigint: true }, before = local.lstatSync(file, options);
  const check = stat => checkFile(stat, before, links, expected);
  check(before);
  const descriptor = local.openSync(file, local.constants.O_RDONLY | (local.constants.O_NOFOLLOW || 0));
  try {
    const opened = local.fstatSync(descriptor, options);
    check(opened);
    const bytes = local.readFileSync(descriptor), after = local.fstatSync(descriptor, options);
    const leaf = local.lstatSync(file, options);
    guard();
    for (const stat of [before, after, leaf]) {
      check(stat);
      if (stat.size !== BigInt(bytes.length) || stat.mtimeNs !== opened.mtimeNs || stat.ctimeNs !== opened.ctimeNs) throw changed();
    }
    const proof = { ...identity(leaf), digest: digest(bytes) };
    if (expected && proof.digest !== expected.digest) throw changed();
    return { bytes, proof };
  } finally { local.closeSync(descriptor); }
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

function verifyStageSync(file, guard, proof, links = 1) {
  try { return readExactSync(file, guard, links, proof); }
  catch (error) { if (error.code === 'ENOENT') throw changed(); throw error; }
}

async function verifyPeers(stage, destination, guard, proof) {
  await verifyStage(stage, guard, proof, 2);
  await verifyStage(destination, guard, proof, 2);
}

function verifyPeersSync(stage, destination, guard, proof) {
  verifyStageSync(stage, guard, proof, 2);
  verifyStageSync(destination, guard, proof, 2);
}

function verifyAbsentSync(file, guard, error = changed) {
  guard();
  try { local.lstatSync(file); }
  catch (failure) { if (failure.code === 'ENOENT') return; throw failure; }
  throw error();
}

async function removeStage(file, guard, proof, links = 1, verifyRelated = () => {}) {
  await verifyStage(file, guard, proof, links);
  verifyRelated();
  verifyStageSync(file, guard, proof, links);
  local.unlinkSync(file);
}

async function removeLinkedStage(stage, destination, guard, proof, verifyRelated = () => {}) {
  await removeStage(stage, guard, proof, 2, () => {
    verifyRelated();
    verifyStageSync(destination, guard, proof, 2);
  });
}

async function settlePublishedLink(stage, destination, guard, proof, verifyRelated = () => {}) {
  guard();
  const links = (await fs.lstat(destination, { bigint: true })).nlink;
  if (links === 2n) {
    await verifyPeers(stage, destination, guard, proof);
    await removeLinkedStage(stage, destination, guard, proof, verifyRelated);
  }
  await verifyStage(destination, guard, proof);
  verifyRelated();
  verifyAbsentSync(stage, guard);
  verifyStageSync(destination, guard, proof);
}

module.exports = {
  ordinaryDirectories, readExact, readExactSync, writeStage, verifyStage, verifyStageSync, verifyAbsentSync,
  verifyPeers, verifyPeersSync, removeStage, removeLinkedStage, validProof, settlePublishedLink
};
