const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID, createHash } = require('node:crypto');
const YAML = require('yaml');
const hash = text => createHash('sha256').update(text).digest('hex');
async function liveOwner(file) {
  try { const owner = JSON.parse(await fs.readFile(`${file}.lock`, 'utf8')); if (!Number.isInteger(owner.pid) || owner.pid < 1) return false; process.kill(owner.pid, 0); return true; } catch { return false; }
}
function markdown(note) {
  return `---\ncompanion_id: ${JSON.stringify(note.id)}\nartifact_type: "capture"\nschema_version: 1\ncapture_type: ${JSON.stringify(note.type)}\ncaptured_at: ${JSON.stringify(note.capturedAt)}\ntitle: ${JSON.stringify(note.title)}\nsource_url: ${JSON.stringify(note.url || '')}\nprovenance: ${JSON.stringify(note.excerpt ? 'user-supplied excerpt; webpage not verified' : 'user capture')}\n---\n\n# ${note.title.replace(/[\r\n]/g, ' ')}\n\n${note.text}\n${note.excerpt ? `\n## User-supplied excerpt\n\n${note.excerpt}\n\nSource URL (as entered): ${note.url}\n\nThis excerpt was supplied by the user. Companion did not fetch or verify the webpage.\n` : ''}`;
}
function parse(text) {
  const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  if (!match) return null;
  let fields; try { fields = YAML.parse(match[1]); } catch { return null; }
  if (!fields || typeof fields !== 'object' || typeof fields.companion_id !== 'string' || !fields.companion_id.trim() || /[\r\n]/.test(fields.companion_id) || fields.artifact_type !== 'capture' || fields.schema_version !== 1 || !['thought', 'link', 'reel_import'].includes(fields.capture_type) || typeof fields.title !== 'string' || !fields.title.trim() || /[\r\n]/.test(fields.title) || typeof fields.captured_at !== 'string' || !/T.*(?:Z|[+-]\d\d:\d\d)$/.test(fields.captured_at) || !Number.isFinite(Date.parse(fields.captured_at))) return null;
  return { id: fields.companion_id, title: fields.title, type: fields.capture_type, capturedAt: fields.captured_at, content: text };
}
function parseAnnotation(text) {
  const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  let fields; try { fields = match && YAML.parse(match[1]); } catch { return null; }
  const uuid = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/;
  if (!fields || fields.artifact_type !== 'annotation' || fields.schema_version !== 1 || !uuid.test(fields.companion_id) || !uuid.test(fields.capture_id)) return null;
  return { id: fields.companion_id, captureId: fields.capture_id, content: text };
}
function captureHeading(title, type) {
  // Imported titles are source text. Escape punctuation so Markdown images,
  // HTML and vault links cannot become active in the generated display heading.
  const literal = type === 'reel_import' ? title.replace(/[\x21-\x2f\x3a-\x40\x5b-\x60\x7b-\x7e]/g, character => `\\${character}`) : title;
  return `# ${literal}`;
}
function withTitle(content, title) {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  const metadata = YAML.parseDocument(match[1]), previous = metadata.get('title'); metadata.set('title', title);
  let body = content.slice(match[0].length);
  // Only the exact generated heading at its original position belongs to the display title.
  for (const newline of ['\n', '\r\n']) {
    const generated = `${newline}${captureHeading(previous, metadata.get('capture_type'))}${newline}`;
    if (body.startsWith(generated)) { body = `${newline}${captureHeading(title, metadata.get('capture_type'))}${newline}${body.slice(generated.length)}`; break; }
  }
  return `---\n${metadata.toString()}---\n${body}`;
}
class Vault {
  constructor(vault, parent, { checkpoint = async () => {} } = {}) {
    if (typeof vault !== 'string' || !path.isAbsolute(vault)) throw Error('Choose an absolute vault folder.');
    if (typeof parent !== 'string' || !parent.trim() || /[<>:"|?*]/.test(parent) || parent.split(/[\\/]/).some(part => !part || part === '.' || part === '..')) throw Error('Use a relative parent folder without reserved characters.');
    this.vault = vault; this.root = path.join(vault, parent); this.expected = new Map(); this.checkpoint = checkpoint; this.warnings = [];
  }
  async contained(target) {
    const anchor = await fs.realpath(this.vault), actual = await fs.realpath(target), relative = path.relative(anchor, actual);
    if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw Error('A folder points outside the selected vault. Choose an ordinary folder inside the vault.');
  }
  async setup() {
    await fs.mkdir(this.vault, { recursive: true });
    const relative = path.relative(this.vault, this.root).split(path.sep); let current = this.vault;
    for (const segment of relative) { current = path.join(current, segment); await fs.mkdir(current).catch(error => { if (error.code !== 'EEXIST') throw error; }); await this.contained(current); }
    for (const area of ['Captures', 'Annotations', 'Ideas', 'Briefs', 'Revisions']) { const target = path.join(this.root, area); await fs.mkdir(target).catch(error => { if (error.code !== 'EEXIST') throw error; }); await this.contained(target); }
  }
  async writable() { await this.contained(this.root); await this.contained(path.join(this.root, 'Captures')); }
  async acquire(file) {
    const owner = `${file}.lock-owner-${randomUUID()}`;
    try { await fs.writeFile(owner, JSON.stringify({ pid: process.pid }), { flag: 'wx', flush: true }); await fs.link(owner, `${file}.lock`); }
    finally { await fs.unlink(owner).catch(() => {}); }
  }
  async release(file) { await fs.unlink(`${file}.lock`).catch(error => { if (error.code !== 'ENOENT') this.warnings.push('A saved-note lock could not be removed. Restart Companion to recover it.'); }); }
  async scan({ annotations = false } = {}) {
    await this.writable();
    const notes = [];
    const visit = async dir => {
      await this.contained(dir);
      for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
        if (entry.name === '.intake' || entry.name === '.obsidian' || entry.name === '.git') continue;
        const file = path.join(dir, entry.name);
        if (entry.isDirectory() && !entry.isSymbolicLink()) await visit(file);
        else if (entry.isFile() && entry.name.endsWith('.md')) {
          await this.contained(file); const content = await fs.readFile(file, 'utf8'), note = annotations ? parseAnnotation(content) : parse(content);
          if (note) notes.push({ ...note, file });
          else if (!annotations && /^(?:companion_id|artifact_type):/m.test(content) && path.dirname(file) === path.join(this.root, 'Captures')) this.warnings.push('Invalid capture metadata in ' + entry.name + '. The file was preserved; repair its identity, type, schema, title and absolute captured_at timestamp.');
        }
      }
    };
    try { await visit(this.vault); } catch (error) { throw Error('Vault access failure. Restore access to all vault folders before identity reconciliation. Notes and history were preserved; no missing-note removal was inferred.', { cause: error }); }
    return notes;
  }
  async list() {
    const dir = path.join(this.root, 'Captures');
    await this.writable();
    this.warnings = this.warnings.filter(warning => !warning.startsWith('Invalid capture metadata in '));
    await this.recover(dir);
    const notes = await this.scan();
    for (const note of notes) if (!this.expected.has(note.id)) this.expected.set(note.id, hash(note.content));
    const counts = new Map(); for (const note of notes) counts.set(note.id, (counts.get(note.id) || 0) + 1);
    const visible = notes.filter(note => counts.get(note.id) === 1 || this.identityPaths?.get(note.id) === note.file);
    this.warnings = this.warnings.filter(warning => !warning.startsWith('Duplicate capture identity.'));
    if (notes.some(note => counts.get(note.id) > 1 && !this.identityPaths?.get(note.id))) this.warnings.push('Duplicate capture identity. Preserve both notes and use Vault repairs to choose the managed file.');
    return visible.sort((a, b) => b.capturedAt.localeCompare(a.capturedAt));
  }
  async find(id) { const note = (await this.list()).find(note => note.id === id); if (!note) throw Error('Capture is missing. Restore it before editing.'); return note; }
  async capture(input, now) {
    await this.writable();
    if (typeof input.text !== 'string' || !input.text.trim()) throw Error('Enter a thought or link before saving.');
    const text = input.text; const type = /^https?:\/\/\S+$/i.test(text.trim()) ? 'link' : 'thought';
    if (input.excerpt && type !== 'link') throw Error('An excerpt requires a source URL in Thought or link.');
    const note = { id: randomUUID(), type, capturedAt: new Date(now).toISOString(), title: text.trim().split(/\r?\n/)[0].slice(0, 90), text, excerpt: input.excerpt || '', url: type === 'link' ? text : null };
    const slug = note.title.replace(/[^a-zA-Z0-9 -]/g, '').trim().slice(0, 55) || 'Capture';
    const file = path.join(this.root, 'Captures', `${slug}--${note.id}.md`), content = markdown(note), stage = `${file}.pending`;
    await this.acquire(file);
    try {
      await fs.writeFile(stage, content, { flag: 'wx', flush: true }); await this.checkpoint('capture-staged'); await fs.link(stage, file);
      // Publication is successful even if cleanup fails. A retry must not duplicate a saved note.
      await fs.unlink(stage).catch(() => this.warnings.push('Capture saved. Its staging file will be cleaned on restart.'));
    } catch (error) { await fs.unlink(stage).catch(() => {}); throw error; }
    finally { await this.release(file); }
    this.expected.set(note.id, hash(content)); return note.id;
  }
  async title(id, title) {
    if (typeof title !== 'string' || !title.trim() || /[\r\n]/.test(title)) throw Error('Enter a title on one line.');
    const note = await this.find(id);
    if (hash(note.content) !== this.expected.get(id)) throw Error('This note changed outside Companion. Reopen Companion to inspect it before editing.');
    const content = withTitle(note.content, title.trim());
    // Fully write ownership before publishing the exclusive lock. A crash cannot leave a partial lock.
    await this.acquire(note.file);
    const transaction = { expectedHash: hash(note.content), content, backup: `${path.basename(note.file)}.before-title-${randomUUID()}.bak` };
    try {
      const current = await fs.readFile(note.file, 'utf8'); if (hash(current) !== hash(note.content)) throw Error('The note changed. Your file was preserved.');
      await fs.writeFile(`${note.file}.title-transaction.json`, JSON.stringify(transaction), { flag: 'wx', flush: true });
      await fs.writeFile(`${note.file}.pending`, content, { flag: 'wx', flush: true });
      await this.checkpoint('title-staged');
      await this.finishTitle(note.file, transaction);
      this.expected.set(id, hash(content));
    } finally { await this.release(note.file); }
  }
  async finishTitle(file, transaction) {
    const backup = path.join(path.dirname(file), transaction.backup);
    const read = file => fs.readFile(file, 'utf8').catch(error => { if (error.code === 'ENOENT') return null; throw error; });
    let verified = false;
    try {
      let old = await read(backup);
      const source = old === null ? await read(file) : old;
      const before = source === null ? null : parse(source), after = parse(transaction.content);
      if (source !== null && hash(source) !== transaction.expectedHash) throw Error('External edit conflict. The note and previous version were preserved.');
      if (!before || !after || before.id !== after.id || before.capturedAt !== after.capturedAt || before.type !== after.type || withTitle(source, after.title) !== transaction.content || !/^[a-f0-9]{64}$/.test(transaction.expectedHash)) throw Error('Invalid title recovery journal. Only a verified capture title can be recovered; all files were preserved.');
      verified = true;
      const staged = await read(`${file}.pending`);
      if (staged !== null && staged !== transaction.content) throw Error('Unexpected staging file. It was preserved; inspect it before retrying the title save.');
      if (old === null) {
        // The backup name is unique and must not exist before the atomic move.
        await fs.rename(file, backup);
        await this.checkpoint('title-moved');
        old = await read(backup);
      }
      let current = await read(file);
      if (hash(old) !== transaction.expectedHash) {
        if (current === null) await fs.link(backup, file);
        throw Error('External edit conflict. Your content was preserved; inspect the note and its adjacent backup before retrying.');
      }
      if (current === null) {
        // Exclusive publication cannot replace a file another editor recreated after the move.
        if (staged === null) await fs.writeFile(`${file}.pending`, transaction.content, { flag: 'wx', flush: true });
        try { await fs.link(`${file}.pending`, file); } catch (error) { if (error.code === 'EEXIST') throw Error('External edit conflict. The new file and previous version were preserved.'); throw error; }
        current = transaction.content;
      }
      if (current !== transaction.content) throw Error('External edit conflict. The current file and previous version were preserved.');
      if (hash(await read(backup)) !== transaction.expectedHash) throw Error('External edit conflict. Changes through an open editor were retained in the adjacent backup.');
    } catch (error) {
      // A failed publication restores the previous file without replacing a concurrent edit.
      if (verified && await read(file) === null && await read(backup) !== null) await fs.link(backup, file).catch(() => {});
      throw error;
    } finally {
      // Keep the durable journal if filesystem failure prevented restoration.
      if (verified && await read(file) !== null && await read(`${file}.pending`) === transaction.content) {
        await fs.unlink(`${file}.pending`).catch(error => { if (error.code !== 'ENOENT') throw error; });
        await fs.unlink(`${file}.title-transaction.json`).catch(error => { if (error.code !== 'ENOENT') throw error; });
      }
    }
  }
  async recover(dir) {
    for (const entry of await fs.readdir(dir)) {
      if (!entry.endsWith('.md.title-transaction.json')) continue;
      const file = path.join(dir, entry.slice(0, -'.title-transaction.json'.length));
      if (await liveOwner(file)) continue;
      try {
        const transaction = JSON.parse(await fs.readFile(path.join(dir, entry), 'utf8'));
        if (typeof transaction.content !== 'string' || typeof transaction.expectedHash !== 'string' || typeof transaction.backup !== 'string' || path.basename(transaction.backup) !== transaction.backup || !transaction.backup.startsWith(path.basename(file) + '.before-title-')) throw Error('Invalid title recovery journal; preserve it for repair.');
        await this.finishTitle(file, transaction);
        this.warnings.push('Recovered an interrupted title save. The previous version remains in an adjacent backup.');
      } catch (error) { this.warnings.push(error.message); }
      finally { await fs.unlink(`${file}.lock`).catch(() => {}); }
    }
    // A crash before journal creation can leave only the ownership lock.
    for (const entry of await fs.readdir(dir)) if (entry.endsWith('.md.lock')) {
      const lockPath = path.join(dir, entry);
      try {
        const owner = JSON.parse(await fs.readFile(lockPath, 'utf8'));
        if (!Number.isInteger(owner.pid) || owner.pid < 1) throw Error('Invalid owner');
        try { process.kill(owner.pid, 0); } catch { await fs.unlink(lockPath); }
      } catch {
        // Preserve legacy partial locks for inspection, but do not strand an otherwise valid capture.
        const file = lockPath.slice(0, -'.lock'.length);
        if (parse(await fs.readFile(file, 'utf8').catch(() => ''))) {
          await fs.rename(lockPath, `${lockPath}.unreadable-${randomUUID()}.bak`);
          this.warnings.push('Recovered an incomplete title lock. Its bytes were preserved beside the capture.');
        }
      }
    }
    // Only quick-capture stages are eligible here. Imported revisions require their own transaction contract.
    for (const entry of await fs.readdir(dir)) if (entry.endsWith('.md.pending')) {
      const stage = path.join(dir, entry), file = stage.slice(0, -'.pending'.length);
      if (await liveOwner(file)) continue;
      try { await fs.access(`${file}.title-transaction.json`); continue; } catch (error) { if (error.code !== 'ENOENT') throw error; }
      const content = await fs.readFile(stage, 'utf8'), note = parse(content);
      if (!note || note.type === 'reel_import' || !/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i.test(note.id) || !path.basename(file).endsWith(`--${note.id}.md`)) {
        this.warnings.push(`Unrecognized staging file ${entry}. It was preserved for inspection.`); continue;
      }
      try {
        await fs.link(stage, file);
        this.warnings.push('Recovered an interrupted capture save.');
      } catch (error) {
        if (error.code !== 'EEXIST') throw error;
        if (await fs.readFile(file, 'utf8') !== content) { this.warnings.push(`Staging conflict for ${path.basename(file)}. Both versions were preserved.`); continue; }
      }
      await fs.unlink(stage); await this.release(file);
    }
  }
}
module.exports = { Vault, withTitle, captureHeading, parseAnnotation };
