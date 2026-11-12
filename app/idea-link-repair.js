const fs = require('node:fs');
const path = require('node:path');
const { validProof, verifyAbsentSync, verifyStageSync } = require('./staged-publication');
const { sameProof, writeExclusive } = require('./idea-publication');

const changed = () => Error('Saved idea links are held. The reviewed note, link block, or target ownership changed. Existing writing was preserved.');
const identity = (a, b) => a.dev === b.dev && a.ino === b.ino;
const exactProof = value => validProof(value) && Object.keys(value).length === 3;
const markdownPath = (from, to) => path.relative(from, to).split(path.sep)
  .map(segment => encodeURIComponent(segment).replace(/[()]/g, character => character === '(' ? '%28' : '%29')).join('/');
const linkBlock = (vault, bindings) => bindings.map(({ file, label }) => `[${label}](${markdownPath(vault.vault, file)})`).join('\n\n');

function containedMarkdown(vault, file) {
  if (typeof file !== 'string' || !path.isAbsolute(file) || path.resolve(file) !== file || path.extname(file).toLowerCase() !== '.md') return false;
  const relative = path.relative(vault.vault, file);
  return !path.isAbsolute(relative) && !relative.split(path.sep).includes('..');
}

function replaceLinks(vault, note, intent, before, after) {
  const suffix = '\n\nConversation output status:';
  const originalBlock = `\n\n${linkBlock(vault, intent.relationshipBindings)}${suffix}`;
  const prior = `\n\n${linkBlock(vault, before)}${suffix}`;
  const next = `\n\n${linkBlock(vault, after)}${suffix}`;
  const originalStart = intent.text.indexOf(originalBlock), sectionStart = intent.text.lastIndexOf('\n## Supporting references\n', originalStart);
  if (!intent.relationshipBindings.length || sectionStart === -1 || originalStart === -1 || originalStart !== intent.text.lastIndexOf(originalBlock)) throw changed();
  const section = intent.text.slice(sectionStart);
  const blocks = ['\n', '\r\n'].map(newline => ({
    oldBlock: section.replace(originalBlock, prior).replaceAll('\n', newline),
    newBlock: section.replace(originalBlock, next).replaceAll('\n', newline)
  }));
  const matches = blocks.filter(({ oldBlock }) => note.includes(oldBlock));
  if (matches.length !== 1) throw changed();
  const [{ oldBlock, newBlock }] = matches, start = note.indexOf(oldBlock);
  if (start !== note.lastIndexOf(oldBlock)) throw changed();
  return note.slice(0, start) + newBlock + note.slice(start + oldBlock.length);
}

function names(vault, operation, ordinal) {
  const stem = path.join(vault.root, '.ideas', `${operation}.links-${ordinal}`);
  return { stage: `${stem}.stage`, prepared: `${stem}.pending.json`, receipt: `${stem}.json` };
}

function value(intent, ordinal, { destination, before, after, prior, targets, targetProofs }, control) {
  return { schema: 1, id: intent.id, operation: intent.operation, ordinal, destination, before, after, prior, targets, targetProofs, control };
}

function history(vault, intent, initial, filenames, read) {
  const links = intent.relationshipBindings || [], receipts = [];
  const pattern = new RegExp(`^${intent.operation}\\.links-([1-9][0-9]*)\\.(?:json|pending\\.json|stage)$`);
  if (filenames.some(name => name.startsWith(`${intent.operation}.links-`) && !pattern.test(name))) throw changed();
  const ordinals = [...new Set(filenames.map(name => pattern.exec(name)?.[1]).filter(Boolean).map(Number))].sort((a, b) => a - b);
  let note = initial.note, prior = initial.proof, targets = links.map(link => link.file), pending = null;
  for (const [index, ordinal] of ordinals.entries()) {
    if (ordinal !== index + 1 || pending) throw changed();
    const files = names(vault, intent.operation, ordinal);
    const present = key => filenames.includes(path.basename(files[key]));
    const prepared = present('prepared'), committed = present('receipt'), staged = present('stage');
    if (!links.length || !prepared && !committed || committed && staged) throw changed();
    const linksCount = prepared && committed ? 2 : 1;
    const record = read(committed ? files.receipt : files.prepared, linksCount), data = JSON.parse(record.bytes);
    const moved = Array.isArray(data?.targets) ? data.targets.filter((file, offset) => file !== targets[offset]) : [];
    if (!data || !containedMarkdown(vault, data.destination) || !exactProof(data.before) || !identity(data.before, note) ||
        !exactProof(data.after) || identity(data.after, data.before) || !exactProof(data.prior) || !sameProof(data.prior, prior) ||
        !Array.isArray(data.targets) || data.targets.length !== targets.length || !data.targets.every(file => containedMarkdown(vault, file)) ||
        !moved.length || !Array.isArray(data.targetProofs) || data.targetProofs.length !== moved.length ||
        data.targetProofs.some((target, index) => !target || Object.keys(target).length !== 2 || target.file !== moved[index] || !exactProof(target.proof)) ||
        !record.bytes.equals(Buffer.from(JSON.stringify(value(intent, ordinal, data, { dev: record.proof.dev, ino: record.proof.ino }))))) throw changed();
    if (prepared && committed && !sameProof(read(files.prepared, 2).proof, record.proof)) throw changed();
    if (staged && !sameProof(read(files.stage, 1).proof, data.after)) throw changed();
    if (committed) {
      receipts.push({ file: files.receipt, proof: record.proof });
      ({ after: note, targets } = data);
      prior = record.proof;
    }
    if (prepared) pending = { files, record, data, committed, staged };
  }
  return { note, prior, links: links.map((link, index) => ({ ...link, file: targets[index] })), receipts, pending };
}

function prepare(vault, intent, ordinal, plan, guard) {
  const files = names(vault, intent.operation, ordinal);
  for (const file of Object.values(files)) verifyAbsentSync(file, guard);
  const stage = writeExclusive(files.stage, plan.bytes, guard);
  const record = writeExclusive(files.prepared, control => JSON.stringify(value(intent, ordinal, { ...plan, after: stage.proof }, control)), guard);
  return { files, record, data: JSON.parse(record.bytes), staged: true, committed: false };
}

function finish({ files, record, data, committed }, guard, verifyRelated) {
  verifyRelated();
  verifyAbsentSync(files.stage, guard);
  verifyStageSync(data.destination, guard, data.after);
  if (!committed) {
    verifyStageSync(files.prepared, guard, record.proof);
    verifyAbsentSync(files.receipt, guard);
    fs.linkSync(files.prepared, files.receipt);
  }
  verifyStageSync(files.prepared, guard, record.proof, 2);
  verifyStageSync(files.receipt, guard, record.proof, 2);
  verifyStageSync(data.destination, guard, data.after);
  fs.unlinkSync(files.prepared);
  verifyStageSync(files.receipt, guard, record.proof);
  verifyStageSync(data.destination, guard, data.after);
}

module.exports = { changed, identity, linkBlock, replaceLinks, history, prepare, finish };
