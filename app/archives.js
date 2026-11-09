const fs = require('node:fs/promises');
const local = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { conversation, canonical, hash } = require('./archive-format');
const LIMIT = 128 * 1024 * 1024;
const same = (a, b) => a.dev === b.dev && a.ino === b.ino;
class Archives {
  constructor(options) { Object.assign(this, options); this.review = null; }
  guard() { this.history.safeDirectory(false, this.directory); }
  async json(file, guard = () => this.guard(), optional = false) {
    guard(); let handle;
    try {
      const before = await fs.lstat(file, { bigint: true }); guard();
      if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n || before.size > BigInt(LIMIT)) throw Error('Archive input is not an ordinary bounded local file.');
      handle = await fs.open(file, local.constants.O_RDONLY | (local.constants.O_NOFOLLOW || 0)); guard();
      const opened = await handle.stat({ bigint: true });
      if (!same(before, opened)) throw Error('Archive input changed. Preview again.');
      const bytes = await handle.readFile(); guard();
      const after = await handle.stat({ bigint: true }), leaf = await fs.lstat(file, { bigint: true }); guard();
      if (!same(opened, leaf) || leaf.isSymbolicLink() || leaf.nlink !== 1n || opened.size !== after.size || opened.mtimeNs !== after.mtimeNs || bytes.length > LIMIT) throw Error('Archive input changed. Preview again.');
      const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
      return { value: JSON.parse(text), digest: hash(bytes) };
    } catch (error) { if (optional && error.code === 'ENOENT') return null; throw error; }
    finally { await handle?.close(); }
  }
  directoryGuard(directory) {
    this.guard(); const identity = local.lstatSync(directory, { bigint: true });
    const guard = () => {
      this.guard(); const current = local.lstatSync(directory, { bigint: true });
      if (!current.isDirectory() || current.isSymbolicLink() || !same(identity, current) || local.realpathSync(directory) !== directory) throw Error('Archive settings directory is not an ordinary contained folder.');
    };
    guard(); return guard;
  }
  async snapshot() {
    // The store lock fences sends/scope writes/resave and keeps unsaved text out of a false complete backup.
    if (this.history.running.size || this.history.unsaved.size) throw Error('Finish active requests and save retained unsaved replies before exporting history.');
    return this.history.lock(async () => {
      this.directory = this.history.safeDirectory();
      if (this.history.running.size || this.history.unsaved.size) throw Error('Finish active requests and save retained unsaved replies before exporting history.');
      const names = (await fs.readdir(this.history.directory)).sort(); this.guard();
      if (names.some(name => name.endsWith('.pending'))) throw Error('Unresolved local history pending files need preservation and review before a complete archive can be exported.');
      const fingerprints = {}, conversations = [];
      for (const name of names.filter(name => name.endsWith('.json'))) {
        if (!/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}\.json$/.test(name)) throw Error('Unrecognized history file. Preserve it for repair.');
        const file = path.join(this.history.directory, name), read = await this.json(file);
        const record = conversation(read.value); if (`${record.id}.json` !== name) throw Error('History identity differs from its filename.');
        if (record.requests.some(request => request.status === 'inProgress')) throw Error('Interrupted request needs inspection before exporting history.');
        fingerprints[file] = read.digest; conversations.push(record);
      }
      const settingsRead = await this.json(this.settingsPath, undefined, true), settings = settingsRead ? { vault: settingsRead.value.vault, parent: settingsRead.value.parent } : null;
      if (settings && (typeof settings.vault !== 'string' || !path.isAbsolute(settings.vault) || typeof settings.parent !== 'string' || path.isAbsolute(settings.parent) || path.relative(settings.vault, path.resolve(settings.vault, settings.parent)).startsWith('..'))) throw Error('Vault settings need repair before archive export.');
      if (settingsRead) fingerprints[this.settingsPath] = settingsRead.digest;
      const contextScopes = [];
      for (const name of (await fs.readdir(this.history.dataRoot)).sort().filter(name => /^context-settings-[a-f0-9]{64}$/.test(name))) {
        const directory = path.join(this.history.dataRoot, name), guard = this.directoryGuard(directory), file = path.join(directory, 'notes.json');
        const read = await this.json(file, guard, true); if (!read) continue;
        if (read.value.schema !== 1 || !Array.isArray(read.value.files) || read.value.files.some(file => typeof file !== 'string' || !path.isAbsolute(file))) throw Error('Explicit note settings need repair.');
        contextScopes.push({ binding: name.slice('context-settings-'.length), schema: 1, files: read.value.files }); fingerprints[file] = read.digest;
      }
      const scheduleFile = path.join(this.history.dataRoot, 'schedule.json'), scheduleRead = await this.json(scheduleFile, undefined, true);
      let scheduleIntent = null;
      if (scheduleRead) {
        const state = scheduleRead.value;
        if (state.schema !== 1 || typeof state.id !== 'string' || !Number.isFinite(Date.parse(state.anchor)) || typeof state.vault !== 'string' || typeof state.parent !== 'string' || !['enabled', 'paused', 'disabled'].includes(state.mode)) throw Error('Daily intake settings need repair.');
        scheduleIntent = { schema: 1, id: state.id, anchor: state.anchor, vault: state.vault, parent: state.parent, mode: state.mode, reconnectRequired: true };
        fingerprints[scheduleFile] = scheduleRead.digest;
      }
      const roots = [...new Set([...conversations.map(record => record.vault.root), ...(settings ? [path.resolve(settings.vault, settings.parent)] : [])])].sort();
      const vaultBindings = roots.map(managedRoot => ({ managedRoot, vault: settings && managedRoot === path.resolve(settings.vault, settings.parent) ? settings.vault : null, parent: settings && managedRoot === path.resolve(settings.vault, settings.parent) ? settings.parent : null, matchingRequired: true, pins: conversations.filter(record => record.vault.root === managedRoot).map(record => record.brief) }));
      const payload = { settings, contextScopes, scheduleIntent, vaultBindings, conversations };
      this.guard();
      if (Buffer.byteLength(canonical(payload)) > LIMIT) throw Error('History archive exceeds the 128 MiB limit.');
      return { payload, fingerprints };
    });
  }
  async preview() {
    this.review = null;
    const snapshot = await this.snapshot(), id = randomUUID();
    this.review = { id, snapshot };
    return { id, location: this.history.dataRoot, count: snapshot.payload.conversations.length, vaults: snapshot.payload.vaultBindings.length };
  }
  async export(input) {
    const review = this.review; this.review = null;
    if (!review || input?.id !== review.id) throw Error('Preview history archive again before exporting.');
    let destination;
    if (this.testRoot) destination = JSON.parse(await fs.readFile(path.join(this.testRoot, 'archive-dialog.json'), 'utf8')).save;
    else { const selected = await this.dialog.showSaveDialog({ title: 'Export reviewed local history archive', defaultPath: 'companion-history.json', filters: [{ name: 'Local history archive', extensions: ['json'] }] }); if (!selected.canceled) destination = selected.filePath; }
    if (!destination) return { cancelled: true };
    const current = await this.snapshot();
    if (canonical(current) !== canonical(review.snapshot)) throw Error('Local history or settings changed. Preview the archive again.');
    const archive = { format: 'companion-local-history', version: 1, id: randomUUID(), createdAt: this.clock().now, appVersion: this.appVersion, payload: current.payload, integrity: { algorithm: 'sha256', digest: hash(canonical(current.payload)) } };
    await this.publish(destination, JSON.stringify(archive, null, 2) + '\n');
    return { location: destination };
  }
  async publish(destination, text) {
    if (!path.isAbsolute(destination)) throw Error('Choose an absolute archive destination.');
    destination = path.resolve(destination);
    // Export creates a separate file. It must never add files to guarded application stores.
    const relative = path.relative(this.history.dataRoot, destination);
    if (!relative.startsWith('..') && !path.isAbsolute(relative) && (relative.includes(path.sep) || ['settings.json', 'schedule.json'].includes(relative))) throw Error('Choose an archive file outside application store folders.');
    const parent = path.dirname(destination), identity = await fs.lstat(parent, { bigint: true });
    const guard = async () => { const current = await fs.lstat(parent, { bigint: true }); if (!identity.isDirectory() || identity.isSymbolicLink() || current.isSymbolicLink() || !same(identity, current) || await fs.realpath(parent) !== parent) throw Error('Archive destination folder changed or is an alias. Choose an ordinary folder.'); };
    await guard(); const stage = path.join(parent, `.companion-archive-${randomUUID()}.pending`); let handle;
    try {
      handle = await fs.open(stage, 'wx'); await guard(); await handle.writeFile(text, 'utf8'); await handle.sync(); await handle.close(); handle = null;
      await guard();
      // Atomic exclusive publication: an existing destination is never replaced.
      await fs.link(stage, destination); await guard();
    } catch (error) { if (error.code === 'EEXIST') throw Error('Archive destination already exists. Choose a new file; existing content was preserved.'); throw error; }
    finally { await handle?.close(); await guard(); await fs.unlink(stage).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
  }
}
function installArchives({ ipcMain, ...options }) {
  const archives = new Archives(options);
  ipcMain.handle('archive-preview', () => archives.preview());
  ipcMain.handle('archive-export', (_, input) => archives.export(input));
}
module.exports = { installArchives };
