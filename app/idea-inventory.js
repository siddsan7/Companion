const fs = require('node:fs/promises');
const local = require('node:fs');
const path = require('node:path');
const YAML = require('yaml');
const { uuid } = require('./source-authority');

const decode = new TextDecoder('utf-8', { fatal: true });
const frontMatter = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/;
const same = (before, after) => before.dev === after.dev && before.ino === after.ino && before.mode === after.mode &&
  before.size === after.size && before.nlink === after.nlink && before.mtimeNs === after.mtimeNs && before.ctimeNs === after.ctimeNs;
const privateEntry = name => name.startsWith('.') || name.toLowerCase() === 'managed-home';

async function scanIdeas(vault) {
  const root = path.resolve(vault.vault), claims = new Map(), observed = new Map();
  const relative = file => path.relative(root, file) || '.';
  const unavailable = (file, reason) => Error(`Saved idea identity inspection unavailable at ${relative(file)}. ${reason} Restore access or repair the metadata and retry.`);
  const changed = file => unavailable(file, 'Vault entries changed during inspection.');
  const stable = (file, before, after) => { if (!same(before, after)) throw changed(file); };

  async function read(file, before) {
    if (await fs.realpath(file) !== file) throw changed(file);
    const handle = await fs.open(file, 'r');
    try {
      stable(file, before, await handle.stat({ bigint: true }));
      stable(file, before, await fs.lstat(file, { bigint: true }));
      const bytes = await handle.readFile();
      stable(file, before, await handle.stat({ bigint: true }));
      stable(file, before, await fs.lstat(file, { bigint: true }));
      if (BigInt(bytes.length) !== before.size) throw changed(file);
      return bytes;
    } finally { await handle.close(); }
  }

  async function visit(directory, before) {
    if (!before.isDirectory() || before.isSymbolicLink() || await fs.realpath(directory) !== directory) throw changed(directory);
    const entries = await fs.readdir(directory, { withFileTypes: true });
    stable(directory, before, await fs.lstat(directory, { bigint: true }));
    observed.set(directory, before);
    for (const entry of entries) {
      if (privateEntry(entry.name) || entry.isSymbolicLink() || !entry.isDirectory() && !/\.md$/i.test(entry.name)) continue;
      const file = path.join(directory, entry.name);
      const stat = await fs.lstat(file, { bigint: true });
      if (entry.isDirectory()) { await visit(file, stat); continue; }
      if (!entry.isFile() || !stat.isFile() || stat.isSymbolicLink()) throw changed(file);
      const bytes = await read(file, stat);
      observed.set(file, stat);
      let content, metadata;
      try {
        content = decode.decode(bytes);
        const front = content.match(frontMatter);
        if (front) metadata = YAML.parse(front[1]);
        else if (/^---\r?\n/.test(content) && /\b(?:companion_id|saved_idea)\b/.test(content)) throw Error('Incomplete front matter.');
      } catch { throw unavailable(file, 'Markdown metadata could not be read.'); }
      const id = typeof metadata?.companion_id === 'string' && metadata.companion_id.toLowerCase();
      if (metadata?.artifact_type === 'saved_idea' && !uuid(id)) throw unavailable(file, 'The saved idea identity could not be read.');
      if (!uuid(id)) continue;
      const isIdea = metadata.artifact_type === 'saved_idea';
      const savedIdea = isIdea && metadata.schema_version === 1 && metadata.companion_id === id;
      // Count identity claims before schema, link count and support eligibility.
      const claim = { id, file, stat, isIdea, savedIdea, ...(savedIdea ? { content, metadata } : {}) };
      if (!claims.has(id)) claims.set(id, []);
      claims.get(id).push(claim);
    }
  }

  function check() {
    for (const [file, before] of observed) {
      try { stable(file, before, local.lstatSync(file, { bigint: true })); }
      catch { throw changed(file); }
    }
  }

  try { await visit(root, await fs.lstat(root, { bigint: true })); check(); }
  catch (error) {
    if (error.code) throw unavailable(error.path || root, 'An ordinary vault entry could not be read.');
    throw error;
  }
  return { claims, check, relative };
}

module.exports = { scanIdeas };
