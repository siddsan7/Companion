const fs = require('node:fs/promises');
const local = require('node:fs');
const path = require('node:path');
const YAML = require('yaml');
const { createHash } = require('node:crypto');
const { uuid } = require('./source-authority');
const { comparable } = require('./legacy-capture-ownership');
const { ordinaryDirectories, verifyAbsentSync } = require('./staged-publication');

const decode = new TextDecoder('utf-8', { fatal: true });
const frontMatter = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/;
const same = (before, after) => before.dev === after.dev && before.ino === after.ino && before.mode === after.mode &&
  before.size === after.size && before.nlink === after.nlink && before.mtimeNs === after.mtimeNs && before.ctimeNs === after.ctimeNs;
const privateStores = new Set(['.codex', '.git', '.ideas', '.intake', '.obsidian', '.transcripts', 'managed-home']);
const inode = stat => `${stat.dev}:${stat.ino}`;
const sha256 = text => createHash('sha256').update(text).digest('hex');
const idPattern = '[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}';
const possibleClaim = /\b(?:companion_id|saved_idea)\b/i;
const inside = (parent, file) => {
  const relative = path.relative(parent, file);
  return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
};
function parseHeader(header) {
  try {
    const document = YAML.parseDocument(header);
    if (!document.errors.length && !document.warnings.length) return document.toJS();
  } catch { /* The caller can still reserve a recognizable identity. */ }
  return null;
}

// Scan only through front matter. Unrelated Markdown bodies are not decoded or
// retained. Positional reads leave the file position at the start for owned notes.
async function readHeader(handle, size) {
  const buffer = Buffer.alloc(4096), close = /(?:^|\n)---(?:\r?\n|$)/g;
  let header = '', offset = 0, searchFrom = 0;
  while (BigInt(offset) < size) {
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, offset);
    if (!bytesRead) break;
    let fragment = buffer.toString('latin1', 0, bytesRead);
    if (!offset) {
      const opening = /^(?:\xef\xbb\xbf)?---\r?\n/.exec(fragment);
      if (!opening) return null;
      fragment = fragment.slice(opening[0].length);
    }
    offset += bytesRead;
    header += fragment;
    close.lastIndex = searchFrom;
    const closing = close.exec(header);
    if (closing && (closing[0].endsWith('\n') || BigInt(offset) >= size)) return { header: header.slice(0, closing.index), complete: true };
    searchFrom = Math.max(0, header.length - 6);
  }
  return { header, complete: false };
}

async function scanIdeas(vault) {
  const root = path.resolve(vault.vault), managed = path.resolve(vault.root), ideas = path.join(managed, 'Ideas');
  const claims = new Map(), observed = new Map(), publications = new Map();
  const intake = new (require('./intake').Intake)(vault);
  const reserved = vault.reservedRestorationIdentities(await intake.load());
  const relative = file => path.relative(root, file) || '.';
  const unavailable = (file, reason) => Error(`Saved idea identity inspection unavailable at ${relative(file)}. ${reason} Restore access or repair the metadata and retry.`);
  const changed = file => unavailable(file, 'Vault entries changed during inspection.');
  const stable = (file, before, after) => { if (!same(before, after)) throw changed(file); };
  const { directories, missing } = intake.storage.expected.parents;
  const missingLedgerGuard = missing
    ? ordinaryDirectories(directories.map(directory => directory.file), changed(intake.dir).message, directories).guard
    : null;

  async function inspect(file, before, work) {
    if (!before.isFile() || before.isSymbolicLink()) throw changed(file);
    if (await fs.realpath(file) !== file) throw changed(file);
    const handle = await fs.open(file, 'r');
    try {
      stable(file, before, await handle.stat({ bigint: true }));
      stable(file, before, await fs.lstat(file, { bigint: true }));
      const result = await work(handle);
      stable(file, before, await handle.stat({ bigint: true }));
      stable(file, before, await fs.lstat(file, { bigint: true }));
      observed.set(file, before);
      return result;
    } finally { await handle.close(); }
  }

  async function entries(directory, before) {
    if (!before.isDirectory() || before.isSymbolicLink() || await fs.realpath(directory) !== directory) throw changed(directory);
    const children = await fs.readdir(directory, { withFileTypes: true });
    stable(directory, before, await fs.lstat(directory, { bigint: true }));
    observed.set(directory, before);
    return children;
  }

  async function readBytes(file, stat, handle) {
    const bytes = await handle.readFile();
    if (BigInt(bytes.length) !== stat.size) throw changed(file);
    return bytes;
  }

  async function journal(file) {
    const stat = await fs.lstat(file, { bigint: true });
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1n) return null;
    const bytes = await inspect(file, stat, handle => readBytes(file, stat, handle));
    try { return JSON.parse(decode.decode(bytes)); } catch { return null; }
  }

  async function publishedIdeas() {
    const directory = path.join(managed, '.ideas');
    let stat;
    try { stat = await fs.lstat(directory, { bigint: true }); }
    catch (error) { if (error.code === 'ENOENT') return; throw error; }
    const files = new Set((await entries(directory, stat)).filter(entry => entry.isFile()).map(entry => entry.name));
    for (const name of files) {
      if (!name.endsWith('.published.json')) continue;
      const operation = name.slice(0, -'.published.json'.length);
      if (!uuid(operation)) continue;
      const receipt = await journal(path.join(directory, name));
      if (!uuid(receipt?.id)) continue;
      const duplicate = publications.has(receipt.id);
      publications.set(receipt.id, null);
      if (duplicate || receipt.schema !== 1 || receipt.operation !== operation || typeof receipt.digest !== 'string' || !/^[a-f0-9]{64}$/.test(receipt.digest) ||
        ![receipt.dev, receipt.ino].every(value => typeof value === 'string' && /^(0|[1-9][0-9]*)$/.test(value))) continue;
      const intentName = `${operation}.intent.json`;
      if (!files.has(intentName)) continue;
      const intent = await journal(path.join(directory, intentName));
      if (!intent || intent.schema !== 1 || intent.operation !== operation || intent.id !== receipt.id || intent.vault !== vault.root ||
        typeof intent.destination !== 'string' || path.dirname(intent.destination) !== ideas || !path.basename(intent.destination).endsWith(`--${receipt.id}.md`) ||
        typeof intent.text !== 'string' || intent.digest !== receipt.digest || sha256(intent.text) !== receipt.digest) continue;
      const front = frontMatter.exec(intent.text);
      const metadata = front && parseHeader(front[1]);
      if (metadata?.artifact_type !== 'saved_idea' || metadata.schema_version !== 1 || metadata.companion_id !== receipt.id ||
        !uuid(metadata.origin?.conversation_id) || !uuid(metadata.origin?.request_id) || metadata.origin.conversation_id !== intent.input?.conversationId || metadata.origin.request_id !== intent.input?.requestId) continue;
      publications.set(receipt.id, { identity: `${receipt.dev}:${receipt.ino}`, destination: intent.destination });
    }
  }

  function record(id, claim) {
    if (!claims.has(id)) claims.set(id, []);
    claims.get(id).push({ id, ...claim });
  }

  async function markdown(file, stat, publishedIds) {
    const localIdea = inside(ideas, file), retainedIds = publishedIds.get(inode(stat)) || [];
    const isReserved = reserved.paths.has(comparable(relative(file).split(path.sep).join('/')));
    await inspect(file, stat, async handle => {
      const front = await readHeader(handle, stat.size);
      let metadata;
      if (front?.complete) {
        try { metadata = parseHeader(decode.decode(Buffer.from(front.header, 'latin1'))); }
        catch { /* An invalid UTF-8 header can still contain an ASCII identity. */ }
      }
      const rawId = metadata?.companion_id, id = typeof rawId === 'string' && rawId.toLowerCase();
      const isIdea = metadata?.artifact_type === 'saved_idea';
      if (!uuid(id)) {
        const claimIds = new Set(retainedIds);
        if (possibleClaim.test(front?.header || '')) {
          const suffix = localIdea && new RegExp(`--(${idPattern})\\.md$`, 'i').exec(file)?.[1];
          if (suffix) claimIds.add(suffix.toLowerCase());
          for (const match of front.header.matchAll(new RegExp(`\\b${idPattern}\\b`, 'gi'))) claimIds.add(match[0].toLowerCase());
          if (!claimIds.size && localIdea) throw unavailable(file, 'Saved idea metadata could not be read.');
        }
        for (const claimId of claimIds) record(claimId, { file, stat, relevant: localIdea || publications.has(claimId) });
        return;
      }
      for (const retainedId of retainedIds) if (retainedId !== id) record(retainedId, { file, stat, relevant: true });
      // Reserve ordinary identity claims before ownership, schema, link count,
      // or support eligibility. Only current-parent owners supply note content.
      // Editors may replace the file at its recorded destination. This grants
      // read access only. Removal verifies the original publication identity.
      const recordedDestination = publications.get(id)?.destination === file;
      const owned = !isReserved && (retainedIds.includes(id) || recordedDestination || localIdea && isIdea && !publications.has(id));
      const savedIdea = owned && isIdea && metadata.schema_version === 1 && rawId === id;
      const content = savedIdea ? decode.decode(await readBytes(file, stat, handle)) : undefined;
      record(id, { file, stat, relevant: owned || localIdea && isReserved && isIdea || publications.has(id), savedIdea, ...(savedIdea ? { content, metadata } : {}) });
    });
  }

  async function visit(directory, before, publishedIds) {
    for (const entry of await entries(directory, before)) {
      const file = path.join(directory, entry.name);
      if (privateStores.has(entry.name.toLowerCase()) || entry.isSymbolicLink() || !entry.isDirectory() && !/\.md$/i.test(entry.name)) continue;
      const stat = await fs.lstat(file, { bigint: true });
      if (entry.isDirectory()) await visit(file, stat, publishedIds);
      else if (entry.isFile()) await markdown(file, stat, publishedIds);
      else throw changed(file);
    }
  }

  function check() {
    for (const [file, before] of observed) {
      try { stable(file, before, local.lstatSync(file, { bigint: true })); }
      catch { throw changed(file); }
    }
    if (missingLedgerGuard) verifyAbsentSync(intake.dir, missingLedgerGuard);
    else intake.storage.guardSync();
    reserved.verify();
  }

  try {
    const anchor = await fs.lstat(root, { bigint: true });
    if (!anchor.isDirectory() || anchor.isSymbolicLink() || await fs.realpath(root) !== root || !inside(root, managed) || relative(managed).split(path.sep).some(part => privateStores.has(part.toLowerCase()))) throw changed(managed);
    await publishedIdeas();
    const publishedIds = new Map();
    for (const [id, publication] of publications) if (publication) {
      const { identity } = publication;
      if (!publishedIds.has(identity)) publishedIds.set(identity, []);
      publishedIds.get(identity).push(id);
    }
    await visit(root, anchor, publishedIds);
    check();
  }
  catch (error) {
    if (error.code) throw unavailable(error.path || root, 'An ordinary vault entry could not be read.');
    throw error;
  }
  return { claims, check, relative };
}

module.exports = { scanIdeas };
