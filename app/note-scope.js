const fs = require('node:fs/promises');
const local = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { withBriefMutation } = require('./briefs-lock');
const {
  ordinaryDirectories, readExact, writeStage, verifyStage, verifyStageSync, verifyAbsentSync,
  verifyPeers, verifyPeersSync, removeStage, validProof, settlePublishedLink
} = require('./staged-publication');

const receiptName = '.archive-note-scope-publication.json';
const folderChanged = 'The reviewed note settings folder changed or is an alias. Files were preserved for inspection.';
const scopeChanged = 'Note inclusion settings changed before publication. Existing scope was preserved.';
const limit = 128 * 1024 * 1024;
const missing = error => { if (error.code === 'ENOENT') return null; throw error; };
const exists = async file => !!await fs.lstat(file).catch(missing);

async function read(file, guard) {
  guard();
  const stat = await fs.lstat(file).catch(missing);
  if (!stat) { guard(); return null; }
  if (stat.size > limit) throw Error('Explicit note settings exceed the size limit. Preserve them for repair.');
  const { bytes, proof } = await readExact(file, guard);
  if (bytes.length > limit) throw Error('Explicit note settings exceed the size limit. Preserve them for repair.');
  const value = JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes));
  if (value?.schema !== 1 || !Array.isArray(value.files) || value.files.some(file => typeof file !== 'string' || !path.isAbsolute(file))) {
    throw Error('Invalid explicit note scope. Preserve settings for repair.');
  }
  return { value, digest: proof.digest, proof };
}

function absent(file, guard, message) {
  verifyAbsentSync(file, guard, () => Error(message));
}

async function settlePublishedScope(file, stage, receipt, guard, staged, recorded) {
  const verifyReceipt = () => { verifyStageSync(receipt, guard, recorded); };
  const verifySettlement = () => {
    verifyAbsentSync(stage, guard);
    verifyStageSync(file, guard, staged);
  };
  await settlePublishedLink(stage, file, guard, staged, verifyReceipt);
  await removeStage(receipt, guard, recorded, 1, verifySettlement);
  verifySettlement();
}

async function settleUnpublishedScope(file, stage, receipt, guard, staged, recorded) {
  const stillUnpublished = () => absent(file, guard, 'Note scope appeared while retiring an unpublished archive stage. Files were preserved for inspection.');
  if (await exists(stage)) await removeStage(stage, stillUnpublished, staged, 1, () => {
    verifyStageSync(receipt, guard, recorded);
  });
  await removeStage(receipt, stillUnpublished, recorded, 1, () => {
    verifyAbsentSync(stage, guard);
  });
}

async function settle(file, guard) {
  const directory = path.dirname(file), receipt = path.join(directory, receiptName);
  const stored = await readExact(receipt, guard).catch(missing);
  if (!stored) return;
  const proof = JSON.parse(stored.bytes);
  if (proof?.schema !== 1 || !stored.bytes.equals(Buffer.from(JSON.stringify(proof))) ||
      typeof proof.stage !== 'string' || !/^notes-[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}\.tmp$/.test(proof.stage) ||
      !validProof(proof.staged) || !Array.isArray(proof.identities)) throw Error('Archive note scope receipt is invalid. Files were preserved for inspection.');
  // Version 1 receipts identify the scope directory alone. The live guard also pins its parent.
  const folder = ordinaryDirectories([directory], folderChanged, proof.identities);
  const pinned = () => { guard(); folder.guard(); };
  await verifyStage(receipt, pinned, stored.proof);
  const stage = path.join(directory, proof.stage);
  if (await exists(file)) {
    await settlePublishedScope(file, stage, receipt, pinned, proof.staged, stored.proof);
  } else {
    await settleUnpublishedScope(file, stage, receipt, pinned, proof.staged, stored.proof);
  }
}

async function readNoteScope(file, { guard = () => {}, assertSelection = () => {} } = {}) {
  const directory = path.dirname(file);
  assertSelection(); guard();
  if (!await exists(directory)) { assertSelection(); guard(); return null; }
  const folders = ordinaryDirectories([path.dirname(directory), directory], folderChanged);
  const pinned = () => { assertSelection(); guard(); folders.guard(); };
  pinned();
  if (!await exists(path.join(directory, receiptName))) return read(file, pinned);
  return withBriefMutation(directory, async () => {
    await settle(file, pinned);
    return read(file, pinned);
  });
}

async function changeNoteScope(file, { update, guard = () => {}, assertSelection = () => {}, beforePublish = async () => {}, beforeFirstLink = async () => {}, committed = () => {} }) {
  const directory = path.dirname(file);
  assertSelection(); guard();
  const parent = ordinaryDirectories([path.dirname(directory)], folderChanged);
  await fs.mkdir(directory).catch(error => { if (error.code !== 'EEXIST') throw error; });
  parent.guard();
  const folder = ordinaryDirectories([directory], folderChanged);
  const pinned = () => { guard(); parent.guard(); folder.guard(); };
  const selected = () => { assertSelection(); pinned(); };
  selected();
  return withBriefMutation(directory, async () => {
    await settle(file, selected);
    const current = await read(file, selected), previous = current?.value.files || [];
    const next = await update(previous, current?.digest || null);
    const stage = path.join(directory, `notes-${randomUUID()}.tmp`), receipt = path.join(directory, receiptName);
    let staged, recorded, published = false, verified = false;
    try {
      staged = await writeStage(stage, JSON.stringify({ schema: 1, files: next }, null, 2), selected);
      await beforePublish();
      if (current) {
        await verifyStage(file, selected, current.proof);
        await verifyStage(stage, selected, staged);
        verifyStageSync(file, selected, current.proof);
        verifyStageSync(stage, selected, staged);
        selected();
        local.renameSync(stage, file);
        published = true;
        await verifyStage(file, pinned, staged);
        verifyStageSync(file, pinned, staged);
      } else {
        await verifyStage(stage, selected, staged);
        absent(file, selected, scopeChanged);
        recorded = await writeStage(receipt, JSON.stringify({ schema: 1, stage: path.basename(stage), staged, identities: folder.identities }), selected);
        await verifyStage(receipt, selected, recorded);
        await verifyStage(stage, selected, staged);
        await beforeFirstLink();
        verifyStageSync(receipt, selected, recorded);
        verifyStageSync(stage, selected, staged);
        absent(file, selected, scopeChanged);
        local.linkSync(stage, file);
        published = true;
        await verifyPeers(stage, file, pinned, staged);
        verifyPeersSync(stage, file, pinned, staged);
      }
      verified = true;
      committed(next.length - previous.length);
      if (recorded) await settlePublishedScope(file, stage, receipt, selected, staged, recorded);
    } catch (error) {
      if (!published) throw error;
      if (!verified) throw Error(`Note inclusion publication could not be verified. Inspect the current scope and any staging file before retrying. ${error.message}`);
      throw Error(`The reviewed note scope was published, but cleanup could not be verified. Inspect the current scope and any retained staging file before retrying. ${error.message}`);
    } finally {
      if (staged && !published) {
        if (recorded) await settleUnpublishedScope(file, stage, receipt, selected, staged, recorded).catch(() => {});
        else await removeStage(stage, selected, staged).catch(() => {});
      }
    }
  });
}

module.exports = { readNoteScope, changeNoteScope };
