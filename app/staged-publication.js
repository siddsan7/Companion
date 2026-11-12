const fs = require('node:fs/promises');
const local = require('node:fs');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
const { performance } = require('node:perf_hooks');
const { setTimeout: wait } = require('node:timers/promises');

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
  guard();
  const handle = await fs.open(file, 'wx');
  try {
    const stat = await handle.stat({ bigint: true });
    guard();
    const data = typeof content === 'function' ? content(identity(stat)) : content;
    const bytes = Buffer.isBuffer(data) ? data : Buffer.from(data);
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

function removeStageIfPresentSync(file, guard, proof) {
  guard();
  if (!local.lstatSync(file, { throwIfNoEntry: false })) return;
  verifyStageSync(file, guard, proof);
  local.unlinkSync(file);
}

const firstPublicationSuffix = '.first-publication';
const firstReceipt = destination => destination + firstPublicationSuffix;
const receiptStageName = /^\.first-receipt-[a-f0-9-]{36}\.tmp$/;

function initialPublicationPending(destination, guard) {
  guard();
  return !!local.lstatSync(firstReceipt(destination), { throwIfNoEntry: false });
}

function settleReceiptStage(receiptStage, receipt, guard, proof, links) {
  if (links === 2) {
    verifyPeersSync(receiptStage, receipt, guard, proof);
    local.unlinkSync(receiptStage);
  }
  verifyAbsentSync(receiptStage, guard);
  verifyStageSync(receipt, guard, proof);
}

function recoverInitialPublication(destination, guard, stageName, {
  keepUnpublished = false, expectedReceipt, verifyRelated = () => {}
} = {}) {
  const receipt = firstReceipt(destination), directory = path.dirname(destination);
  guard();
  const status = local.lstatSync(receipt, { bigint: true, throwIfNoEntry: false });
  if (!status && !expectedReceipt) return;
  const links = Number(status?.nlink);
  if (links !== 1 && links !== 2) throw changed();
  const exact = readExactSync(receipt, guard, links, expectedReceipt);
  let entry;
  try { entry = JSON.parse(exact.bytes); } catch { throw changed(); }
  if (entry?.schema !== 1 || entry.destination !== path.basename(destination) || typeof entry.stage !== 'string' ||
      !stageName.test(entry.stage) || !validProof(entry.proof) || !entry.directory ||
      !same(entry.directory, identity(local.lstatSync(directory, { bigint: true }))) ||
      !entry.receiptIdentity || !same(entry.receiptIdentity, exact.proof) ||
      typeof entry.receiptStage !== 'string' || !receiptStageName.test(entry.receiptStage)) throw changed();
  settleReceiptStage(path.join(directory, entry.receiptStage), receipt, guard, exact.proof, links);
  const stage = path.join(directory, entry.stage), verifyReceipt = () => verifyStageSync(receipt, guard, exact.proof);
  const current = local.lstatSync(destination, { bigint: true, throwIfNoEntry: false });
  verifyRelated();
  if (current) {
    if (current.nlink === 2n) {
      verifyReceipt();
      verifyPeersSync(stage, destination, guard, entry.proof);
      local.unlinkSync(stage);
    }
    verifyAbsentSync(stage, guard);
    verifyStageSync(destination, guard, entry.proof);
  } else {
    verifyAbsentSync(destination, guard);
    verifyReceipt();
    if (keepUnpublished) {
      if (local.lstatSync(stage, { throwIfNoEntry: false })) verifyStageSync(stage, guard, entry.proof);
    } else removeStageIfPresentSync(stage, guard, entry.proof);
  }
  verifyReceipt();
  local.unlinkSync(receipt);
}

async function publishInitial(stage, destination, guard, proof, { beforeAttempt, verifyRelated, conflict, commit, stageName }) {
  const receipt = firstReceipt(destination), directory = path.dirname(destination);
  const receiptStage = path.join(directory, `.first-receipt-${randomUUID()}.tmp`);
  if (!stageName?.test(path.basename(stage))) throw changed();
  const check = () => {
    verifyStageSync(stage, guard, proof);
    verifyAbsentSync(destination, guard, conflict);
    verifyRelated();
  };
  check();
  const entry = {
    schema: 1, stage: path.basename(stage), destination: path.basename(destination), proof, receiptStage: path.basename(receiptStage),
    directory: identity(local.lstatSync(directory, { bigint: true }))
  };
  const receiptProof = await writeStage(receiptStage, receiptIdentity => JSON.stringify({ ...entry, receiptIdentity }), guard);
  let receiptPublished = false, linked = false;
  try {
    await beforeAttempt();
    check();
    verifyStageSync(receiptStage, guard, receiptProof);
    verifyAbsentSync(receipt, guard);
    local.linkSync(receiptStage, receipt);
    receiptPublished = true;
    settleReceiptStage(receiptStage, receipt, guard, receiptProof, 2);
    await beforeAttempt();
    verifyStageSync(receipt, guard, receiptProof);
    check();
    try { local.linkSync(stage, destination); }
    catch (error) { if (error.code === 'EEXIST') throw conflict(); throw error; }
    linked = true;
    recoverInitialPublication(destination, guard, stageName, { expectedReceipt: receiptProof, verifyRelated });
    commit();
  } catch (error) {
    try {
      if (!receiptPublished) removeStageIfPresentSync(receiptStage, guard, receiptProof);
      else if (!linked) {
        verifyStageSync(stage, guard, proof);
        verifyAbsentSync(receiptStage, guard);
        removeStageIfPresentSync(receipt, guard, receiptProof);
      }
    } catch { /* Preserve an unproved stage and its remaining receipt. */ }
    throw error;
  }
}

async function publishReplacement(stage, destination, guard, proof, expected, {
  beforeAttempt = async () => {}, verifyRelated = () => {}, onRetry = async () => {},
  conflict = changed, commit = () => {}, stageName
} = {}) {
  if (!expected) return publishInitial(stage, destination, guard, proof, { beforeAttempt, verifyRelated, conflict, commit, stageName });
  const deadline = performance.now() + 1000;
  let delay = 15, refusal;
  for (;;) {
    await beforeAttempt();
    if (refusal && performance.now() >= deadline) throw refusal;
    verifyStageSync(stage, guard, proof);
    try {
      verifyStageSync(destination, guard, expected);
    } catch (error) {
      if (error.code === 'STAGING_CHANGED') throw conflict();
      throw error;
    }
    verifyRelated();
    try { local.renameSync(stage, destination); }
    catch (error) {
      const remaining = deadline - performance.now();
      if (process.platform !== 'win32' || !['EPERM', 'EBUSY', 'EACCES'].includes(error.code) || remaining <= 0) throw error;
      refusal = error;
      await onRetry(error);
      await wait(Math.min(delay, remaining));
      delay = Math.min(delay * 2, 100);
      continue;
    }
    verifyAbsentSync(stage, guard);
    verifyStageSync(destination, guard, proof);
    verifyRelated();
    commit();
    return;
  }
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
  verifyPeers, verifyPeersSync, removeStage, removeLinkedStage, validProof, settlePublishedLink,
  removeStageIfPresentSync, publishReplacement, firstPublicationSuffix, initialPublicationPending, recoverInitialPublication
};
