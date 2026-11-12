const fs = require('node:fs/promises');
const local = require('node:fs');
const path = require('node:path');
const YAML = require('yaml');
const { createHash } = require('node:crypto');
const { uuid } = require('./source-authority');
const { comparable, storeName } = require('./legacy-capture-ownership');
const { ordinaryDirectories, readExactSync, verifyAbsentSync } = require('./staged-publication');
const { checkIdeaEnvelope } = require('./idea-envelope');
const linkRepair = require('./idea-link-repair');
const { parse: parseCapture } = require('./vault');

const decode = new TextDecoder('utf-8', { fatal: true });
const frontMatter = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/;
const same = (before, after) => before.dev === after.dev && before.ino === after.ino && before.mode === after.mode &&
  before.size === after.size && before.nlink === after.nlink && before.mtimeNs === after.mtimeNs && before.ctimeNs === after.ctimeNs;
const privateStores = new Set(['.codex', '.git', '.ideas', '.intake', '.obsidian', '.transcripts', 'managed-home']);
const capturePrivateStores = new Set(['.intake', '.obsidian', '.git', '.codex', 'managed-home', storeName]);
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

async function scanIdeas(vault, { captureIds = new Set(), watchCaptureNamespace = false } = {}) {
  const root = path.resolve(vault.vault), managed = path.resolve(vault.root), ideas = path.join(managed, 'Ideas');
  const claims = new Map(), captureClaims = new Map(), observed = new Map(), publications = new Map();
  const intake = new (require('./intake').Intake)(vault);
  const reserved = vault.reservedRestorationIdentities(await intake.load());
  const relative = file => path.relative(root, file) || '.';
  const unavailable = (file, reason) => Error(`Saved idea identity inspection unavailable at ${relative(file)}. ${reason} Restore access or repair the metadata and retry.`);
  const changed = file => unavailable(file, 'Vault entries changed during inspection.');
  const stable = (file, before, after) => { if (!same(before, after)) throw changed(file); };
  const observe = (file, stat) => {
    if (observed.has(file)) stable(file, observed.get(file), stat);
    else observed.set(file, stat);
  };
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
      observe(file, before);
      return result;
    } finally { await handle.close(); }
  }

  async function entries(directory, before) {
    if (!before.isDirectory() || before.isSymbolicLink() || await fs.realpath(directory) !== directory) throw changed(directory);
    const children = await fs.readdir(directory, { withFileTypes: true });
    stable(directory, before, await fs.lstat(directory, { bigint: true }));
    observe(directory, before);
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
    try { return { value: JSON.parse(decode.decode(bytes)), proof: { dev: String(stat.dev), ino: String(stat.ino), digest: sha256(bytes) } }; } catch { return null; }
  }

  async function publishedIdeas() {
    const directory = path.join(managed, '.ideas');
    let stat;
    try { stat = await fs.lstat(directory, { bigint: true }); }
    catch (error) { if (error.code === 'ENOENT') return; throw error; }
    const children = await entries(directory, stat), names = children.map(entry => entry.name);
    const files = new Set(children.filter(entry => entry.isFile()).map(entry => entry.name));
    const guard = ordinaryDirectories([root, managed, directory], changed(directory).message).guard;
    const readRepair = (file, links) => {
      const before = local.lstatSync(file, { bigint: true });
      const exact = readExactSync(file, guard, links);
      stable(file, before, local.lstatSync(file, { bigint: true }));
      observe(file, before);
      return exact;
    };
    for (const name of files) {
      if (!name.endsWith('.published.json')) continue;
      const operation = name.slice(0, -'.published.json'.length);
      if (!uuid(operation)) continue;
      const saved = await journal(path.join(directory, name)), receipt = saved?.value;
      if (!uuid(receipt?.id)) continue;
      const duplicate = publications.has(receipt.id);
      publications.set(receipt.id, null);
      if (duplicate || receipt.schema !== 1 || receipt.operation !== operation || typeof receipt.digest !== 'string' || !/^[a-f0-9]{64}$/.test(receipt.digest) ||
        ![receipt.dev, receipt.ino].every(value => typeof value === 'string' && /^(0|[1-9][0-9]*)$/.test(value))) continue;
      const intentName = `${operation}.intent.json`;
      if (!files.has(intentName)) continue;
      const loaded = await journal(path.join(directory, intentName)), intent = loaded?.value;
      if (!intent || intent.schema !== 1 || intent.operation !== operation || intent.id !== receipt.id || intent.vault !== vault.root ||
        typeof intent.destination !== 'string' || path.dirname(intent.destination) !== ideas || !path.basename(intent.destination).endsWith(`--${receipt.id}.md`) ||
        typeof intent.text !== 'string' || intent.digest !== receipt.digest || sha256(intent.text) !== receipt.digest) continue;
      const front = frontMatter.exec(intent.text);
      const metadata = front && parseHeader(front[1]);
      if (metadata?.artifact_type !== 'saved_idea' || metadata.schema_version !== 1 || metadata.companion_id !== receipt.id ||
        !uuid(metadata.origin?.conversation_id) || !uuid(metadata.origin?.request_id) || metadata.origin.conversation_id !== intent.input?.conversationId || metadata.origin.request_id !== intent.input?.requestId) continue;
      const base = { dev: receipt.dev, ino: receipt.ino, digest: receipt.digest };
      let repair, repairIssue, pendingOutput;
      if (Object.hasOwn(intent, 'relationshipBindings')) {
        try {
          checkIdeaEnvelope(intent, vault, () => { throw linkRepair.changed(); });
          repair = linkRepair.history(vault, intent, { note: base, proof: saved.proof }, names, readRepair);
        } catch (error) { repairIssue = error.message; }
      }
      if (repair?.pending && !repair.pending.staged && !repair.pending.committed) {
        const { destination, after } = repair.pending.data;
        try {
          const folders = [root];
          for (const segment of path.relative(root, path.dirname(destination)).split(path.sep).filter(Boolean)) folders.push(path.join(folders.at(-1), segment));
          const outputGuard = ordinaryDirectories(folders, changed(destination).message).guard;
          const before = local.lstatSync(destination, { bigint: true });
          readExactSync(destination, outputGuard, 1, after);
          stable(destination, before, local.lstatSync(destination, { bigint: true }));
          observe(destination, before);
          pendingOutput = { destination, identity: `${after.dev}:${after.ino}` };
        } catch { /* An absent or changed candidate does not grant ownership. */ }
      }
      const note = repair?.note || base;
      publications.set(receipt.id, { identity: `${note.dev}:${note.ino}`, destination: intent.destination, intent, intentProof: loaded.proof, receiptProof: saved.proof, repair, repairIssue, pendingOutput });
    }
  }

  function record(id, claim) {
    if (!claims.has(id)) claims.set(id, []);
    claims.get(id).push({ id, ...claim });
  }

  async function markdown(file, stat, publishedIds, scanIdea, scanCapture) {
    const localIdea = inside(ideas, file), retainedIds = publishedIds.get(inode(stat)) || [];
    const isReserved = reserved.paths.has(comparable(relative(file).split(path.sep).join('/')));
    await inspect(file, stat, async handle => {
      const captureBytes = scanCapture ? await readBytes(file, stat, handle) : null;
      if (captureBytes) {
        const capture = parseCapture(captureBytes.toString('utf8'));
        if (captureIds.has(capture?.id)) {
          if (!captureClaims.has(capture.id)) captureClaims.set(capture.id, []);
          captureClaims.get(capture.id).push(file);
        }
      }
      if (!scanIdea) return;
      const front = await readHeader(handle, stat.size);
      const header = front?.complete && Buffer.from(front.header, 'latin1');
      let metadata;
      if (header) {
        try { metadata = parseHeader(decode.decode(header)); }
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
      const pending = publications.get(id)?.pendingOutput;
      const repairPending = !!pending && pending.destination === file && pending.identity === inode(stat);
      const owned = !isReserved && (retainedIds.includes(id) || recordedDestination || repairPending || localIdea && isIdea && !publications.has(id));
      const savedIdea = owned && isIdea && metadata.schema_version === 1 && rawId === id;
      const content = savedIdea ? decode.decode(captureBytes ?? await readBytes(file, stat, handle)) : undefined;
      record(id, { file, stat, relevant: owned || localIdea && isReserved && isIdea || publications.has(id), savedIdea, repairPending, ...(savedIdea ? { content, metadata } : {}) });
    });
  }

  async function visit(directory, before, publishedIds, ideaNamespace, captureNamespace) {
    for (const entry of await entries(directory, before)) {
      const file = path.join(directory, entry.name);
      const name = entry.name.toLowerCase();
      const scanIdea = ideaNamespace && !privateStores.has(name);
      const scanCapture = captureNamespace && !capturePrivateStores.has(name);
      if (entry.isSymbolicLink() || !scanIdea && !scanCapture) continue;
      const ideaMarkdown = scanIdea && /\.md$/i.test(entry.name);
      const captureMarkdown = scanCapture && entry.name.endsWith('.md');
      if (!entry.isDirectory() && !ideaMarkdown && !captureMarkdown) continue;
      const stat = await fs.lstat(file, { bigint: true });
      if (entry.isDirectory()) await visit(file, stat, publishedIds, scanIdea, scanCapture);
      else if (entry.isFile() && stat.isFile() && !stat.isSymbolicLink()) {
        const readCapture = captureMarkdown && captureIds.size > 0;
        if (ideaMarkdown || readCapture) await markdown(file, stat, publishedIds, ideaMarkdown, readCapture);
        else observe(file, stat);
      }
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
    await visit(root, anchor, publishedIds, true, captureIds.size > 0 || watchCaptureNamespace);
    check();
  }
  catch (error) {
    if (error.code) throw unavailable(error.path || root, 'An ordinary vault entry could not be read.');
    throw error;
  }
  return { claims, captureClaims, publications, check, relative };
}

module.exports = { scanIdeas };
