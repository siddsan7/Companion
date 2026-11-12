const fs = require('node:fs');
const path = require('node:path');
const { readExactSync, validProof, verifyStageSync } = require('./staged-publication');

const changed = () => Error('Saved idea publication ownership changed. Preserve the retained writing for inspection.');
const sameProof = (a, b) => a.dev === b.dev && a.ino === b.ino && a.digest === b.digest;
const exactProof = value => validProof(value) && Object.keys(value).length === 3;
const hasFile = file => !!fs.lstatSync(file, { throwIfNoEntry: false });

function locations(vault, operation) {
  const stem = path.join(vault.root, '.ideas', operation);
  return {
    intent: `${stem}.intent.json`, stage: `${stem}.md.pending`, receipt: `${stem}.published.json`,
    prepared: `${stem}.prepared.json`, attempt: `${stem}.attempt.json`
  };
}

function writeExclusive(file, content, guard) {
  guard();
  const handle = fs.openSync(file, 'wx');
  try {
    const stat = fs.fstatSync(handle, { bigint: true }), identity = { dev: String(stat.dev), ino: String(stat.ino) };
    const bytes = Buffer.from(typeof content === 'function' ? content(identity) : content);
    fs.writeFileSync(handle, bytes);
    fs.fsyncSync(handle);
    const exact = readExactSync(file, guard);
    if (identity.dev !== exact.proof.dev || identity.ino !== exact.proof.ino || !exact.bytes.equals(bytes)) throw changed();
    return exact;
  } finally { fs.closeSync(handle); }
}

function readOptional(file, guard) {
  try { return readExactSync(file, guard); }
  catch (error) { if (error.code !== 'ENOENT') throw error; return null; }
}

function record(file, preview, stage, intent, control) {
  const name = path.basename(file);
  const phase = ['prepared', 'attempt'].find(role => name === `${preview.operation}.${role}.json`);
  if (!phase) throw changed();
  return { schema: 1, operation: preview.operation, id: preview.id, phase, stage, intent, control };
}

function readControl(file, guard, preview, intent) {
  const read = readOptional(file, guard);
  if (!read) return null;
  const value = JSON.parse(read.bytes);
  if (!value || !exactProof(value.stage) || value.stage.digest !== preview.digest || !exactProof(value.intent) || !sameProof(value.intent, intent) ||
      !read.bytes.equals(Buffer.from(JSON.stringify(record(file, preview, value.stage, intent, { dev: read.proof.dev, ino: read.proof.ino }))))) throw changed();
  return { ...read, stage: value.stage };
}

function writeControl(file, guard, preview, stage, intent) {
  const read = writeExclusive(file, identity => JSON.stringify(record(file, preview, stage, intent, identity)), guard);
  return { ...read, stage };
}

function verifyControl(file, guard, read) {
  if (read) verifyStageSync(file, guard, read.proof);
  else if (hasFile(file)) throw changed();
}

module.exports = { changed, sameProof, hasFile, locations, readOptional, writeExclusive, readControl, writeControl, verifyControl };
