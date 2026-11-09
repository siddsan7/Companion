const fs = require('node:fs/promises');
const local = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { conversation, canonical, hash, parseArchive, archiveRecord, inactiveIntent, inactiveCoverage, codexHints, inactiveCodexHints } = require('./archive-format');
const { Briefs } = require('./briefs');
const { Context } = require('./context');
const { withBriefMutation } = require('./briefs-lock');
const LIMIT = 128 * 1024 * 1024;
const same = (a, b) => a.dev === b.dev && a.ino === b.ino;
class Archives {
  constructor(options) { Object.assign(this, options); this.review = null; }
  guard() { this.history.safeDirectory(false, this.directory); }
  async json(file, guard = () => this.guard(), optional = false, strict = false, raw = false) {
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
      if (raw) return { value: bytes, digest: hash(bytes) };
      const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
      return { value: strict ? parseArchive(text) : JSON.parse(text), digest: hash(bytes) };
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
  async snapshot({ locked = false, savedOnly = false, recoveryId } = {}) {
    // The store lock fences sends/scope writes/resave and keeps unsaved text out of a false complete backup.
    if (this.history.running.size || this.history.unsaved.size) throw Error('Finish active requests and save retained unsaved replies before exporting history.');
    const collect = async () => {
      this.directory = this.history.safeDirectory();
      if (this.history.running.size || this.history.unsaved.size) throw Error('Finish active requests and save retained unsaved replies before exporting history.');
      const names = (await fs.readdir(this.history.directory)).sort(); this.guard();
      const pending = names.filter(name => name.endsWith('.pending')); let coverage;
      if (pending.length) {
        if (!savedOnly) throw Error('Unresolved local history pending files need preservation and review before a complete archive can be exported.');
        if (!this.recoveryReview || recoveryId !== this.recoveryReview.id) throw Error('Review unresolved history files before choosing a saved-history-only archive.');
        const inventory = await this.pendingInventory(pending), omitted = inventory.map(({ text, ...item }) => item);
        if (canonical(omitted) !== canonical(this.recoveryReview.omitted)) throw Error('Unresolved history files changed. Review their preservation and omission again.');
        coverage = { mode: 'saved-history-only', omitted };
      } else if (savedOnly) throw Error('Unresolved file inventory changed. Choose a complete export or review the current files again.');
      const fingerprints = {}, conversations = [];
      for (const name of names.filter(name => name.endsWith('.json'))) {
        if (!/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}\.json$/.test(name)) throw Error('Unrecognized history file. Preserve it for repair.');
        const file = path.join(this.history.directory, name), read = await this.json(file);
        const record = conversation(read.value); if (`${record.id}.json` !== name) throw Error('History identity differs from its filename.');
        if (record.requests.some(request => request.status === 'inProgress')) throw Error('Interrupted request needs inspection before exporting history.');
        fingerprints[file] = read.digest; conversations.push(record);
      }
      const settingsRead = await this.json(path.join(this.history.dataRoot, 'settings.json'), undefined, true), settings = settingsRead ? { vault: settingsRead.value.vault, parent: settingsRead.value.parent } : null;
      if (settings && (typeof settings.vault !== 'string' || !path.isAbsolute(settings.vault) || typeof settings.parent !== 'string' || path.isAbsolute(settings.parent) || path.relative(settings.vault, path.resolve(settings.vault, settings.parent)).startsWith('..'))) throw Error('Vault settings need repair before archive export.');
      if (settingsRead) fingerprints[path.join(this.history.dataRoot, 'settings.json')] = settingsRead.digest;
      const inactive = await this.inactiveIntents(fingerprints);
      if (settings && inactive.length) settings.inactiveScheduleIntents = inactive;
      const priorCoverage = await this.inactiveCoverages(fingerprints);
      if (priorCoverage.length && !settings) throw Error('Select the current vault configuration before exporting retained archive omission metadata.');
      if (settings && priorCoverage.length) settings.inactiveArchiveCoverage = priorCoverage;
      const localCodexHints = await this.ownCodexHints(fingerprints), priorCodexHints = await this.inactiveCodexHints(fingerprints);
      if (!settings && (localCodexHints || priorCodexHints.length)) throw Error('Select the current vault configuration before exporting retained Codex reconnection preferences.');
      if (settings && localCodexHints) settings.codexReconnectHints = localCodexHints;
      if (settings && priorCodexHints.length) settings.inactiveCodexReconnectHints = priorCodexHints;
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
      return { payload, fingerprints, ...(coverage ? { coverage } : {}) };
    };
    return locked ? collect() : this.history.lock(collect);
  }
  async preview(input) {
    this.review = null;
    const options = { savedOnly: input?.savedOnly === true, recoveryId: input?.recoveryId }, snapshot = await this.snapshot(options), id = randomUUID();
    this.review = { id, snapshot, options };
    return { id, location: this.history.dataRoot, count: snapshot.payload.conversations.length, vaults: snapshot.payload.vaultBindings.length, omitted: snapshot.coverage?.omitted.length || 0 };
  }
  async export(input) {
    const review = this.review; this.review = null;
    if (!review || input?.id !== review.id) throw Error('Preview history archive again before exporting.');
    let destination;
    if (this.testRoot) destination = JSON.parse(await fs.readFile(path.join(this.testRoot, 'archive-dialog.json'), 'utf8')).save;
    else { const selected = await this.dialog.showSaveDialog({ title: 'Export reviewed local history archive', defaultPath: 'companion-history.json', filters: [{ name: 'Local history archive', extensions: ['json'] }] }); if (!selected.canceled) destination = selected.filePath; }
    if (!destination) return { cancelled: true };
    const current = await this.snapshot(review.options);
    if (canonical(current) !== canonical(review.snapshot)) throw Error('Local history or settings changed. Preview the archive again.');
    const archive = { format: 'companion-local-history', version: 1, id: randomUUID(), createdAt: this.clock().now, appVersion: this.appVersion, payload: current.payload, integrity: { algorithm: 'sha256', digest: hash(canonical(current.payload)) } };
    if (current.coverage) { archive.coverage = current.coverage; archive.integrity.digest = hash(canonical({ payload: current.payload, coverage: current.coverage })); }
    const serialized = JSON.stringify(archive, null, 2) + '\n';
    if (Buffer.byteLength(serialized, 'utf8') > LIMIT) throw Error('Final serialized archive exceeds 128 MiB. No archive file was created and retained history was not shortened.');
    await this.publish(destination, serialized);
    return { location: destination, omitted: current.coverage?.omitted.length || 0 };
  }
  restorePlan(archive, current, sourceRoot, targetRoot = sourceRoot) {
    const additions = [], equal = [], conflicts = [];
    for (const original of archive.payload.conversations) {
      if (sourceRoot && original.vault.root !== sourceRoot) continue;
      const record = structuredClone(original);
      if (sourceRoot !== targetRoot) {
        record.vault.root = targetRoot;
        record.archiveBinding = { archiveId: archive.id, originalManagedRoot: sourceRoot, ...(original.archiveBinding ? { previous: original.archiveBinding } : {}) };
      }
      const existing = current.payload.conversations.find(item => item.id === record.id);
      if (!existing) additions.push(record);
      else if (canonical(existing) === canonical(record)) equal.push(record.id);
      else conflicts.push(record.id);
    }
    return { additions, equal, conflicts };
  }
  async inspect() {
    this.restoreReview = null;
    let file;
    if (this.testRoot) file = JSON.parse(await fs.readFile(path.join(this.testRoot, 'archive-dialog.json'), 'utf8')).open;
    else file = (await this.dialog.showOpenDialog({ title: 'Inspect local history archive', properties: ['openFile'], filters: [{ name: 'Local history archive', extensions: ['json'] }] })).filePaths[0];
    if (!file) return { cancelled: true };
    if (!path.isAbsolute(file)) throw Error('Choose an absolute archive file.');
    file = path.resolve(file);
    const parent = path.dirname(file), identity = await fs.lstat(parent, { bigint: true });
    const guard = () => {
      const current = local.lstatSync(parent, { bigint: true });
      if (!identity.isDirectory() || identity.isSymbolicLink() || current.isSymbolicLink() || !same(identity, current) || local.realpathSync(parent) !== parent) throw Error('Archive folder changed or is an alias. Choose an ordinary folder.');
    };
    const read = await this.json(file, guard, false, true), archive = archiveRecord(read.value);
    const current = await this.snapshot(), plan = this.restorePlan(archive, current), id = randomUUID();
    this.restoreReview = { id, archive, inspection: current, input: { file, guard, digest: read.digest } };
    return { id, missing: plan.additions.length, equal: plan.equal.length, conflicts: plan.conflicts.length, roots: archive.payload.vaultBindings.map(binding => binding.managedRoot), currentVault: this.history.getVault()?.root || null, omitted: archive.coverage?.omitted.length || 0, codexHints: this.archiveCodexHints(archive) };
  }
  async match(input) {
    const reviewed = this.restoreReview;
    if (!reviewed || reviewed.id !== input?.id || input.matched !== true) throw Error('Inspect the archive and explicitly match its vault first.');
    await this.revalidateInspectedFile(reviewed);
    const vault = this.history.getVault(), root = vault?.root;
    const sourceRoot = input.sourceRoot || root;
    if (!root || !reviewed.archive.payload.vaultBindings.some(binding => binding.managedRoot === sourceRoot)) throw Error('Choose an archived vault and explicitly match the current vault; nothing was restored.');
    await this.validatePins(reviewed.archive, sourceRoot, vault);
    const current = await this.snapshot(), plan = this.restorePlan(reviewed.archive, current, sourceRoot, root);
    const metadata = await this.metadataPlan(reviewed.archive, sourceRoot, root);
    const settingsMode = input.settingsMode || 'keep-current';
    if (!['keep-current', 'review-note-inclusions'].includes(settingsMode)) throw Error('Choose an explicit settings restoration policy.');
    const noteCandidates = settingsMode === 'review-note-inclusions' ? await this.noteCandidates(reviewed.archive, sourceRoot, vault) : [];
    const token = randomUUID();
    reviewed.matched = { token, root, sourceRoot, snapshot: current, plan, metadata, settingsMode, noteCandidates };
    return { token, missing: plan.additions.length, equal: plan.equal.length, conflicts: plan.conflicts.length, metadataAdditions: metadata.additions.length, metadataConflicts: metadata.conflicts.length, metadataTypes: metadata.types, omitted: reviewed.archive.coverage?.omitted.length || 0, noteCandidates, archivedVault: reviewed.archive.payload.vaultBindings.find(binding => binding.managedRoot === sourceRoot), currentVault: { vault: vault.vault, managedRoot: vault.root }, conflictRecords: plan.conflicts.map(id => {
      const archived = reviewed.archive.payload.conversations.find(record => record.id === id), existing = current.payload.conversations.find(record => record.id === id);
      return { id, archivedRequests: archived.requests.length, currentRequests: existing.requests.length, archivedExclusions: archived.scope?.excludedHistory.length || 0, currentExclusions: existing.scope?.excludedHistory.length || 0 };
    }) };
  }
  async restore(input) {
    const reviewed = this.restoreReview; this.restoreReview = null;
    if (!reviewed?.matched || input?.token !== reviewed.matched.token) throw Error('Preview the matched restore again before confirming additions.');
    const matched = reviewed.matched;
    return this.history.lock(async () => {
      await this.revalidateInspectedFile(reviewed);
      const current = await this.snapshot({ locked: true });
      if (this.history.getVault()?.root !== matched.root || canonical(current) !== canonical(matched.snapshot)) throw Error('Current history or settings changed. Inspect and preview again; nothing was restored.');
      await this.validatePins(reviewed.archive, matched.sourceRoot, this.history.getVault());
      const plan = this.restorePlan(reviewed.archive, current, matched.sourceRoot, matched.root);
      const metadata = await this.metadataPlan(reviewed.archive, matched.sourceRoot, matched.root);
      if (canonical(metadata) !== canonical(matched.metadata)) throw Error('Inert settings changed. Inspect and preview their preservation again.');
      if (metadata.conflicts.length) throw Error('Archived inert settings conflict with existing metadata. Existing records were preserved; nothing was restored.');
      const resolutions = input.resolutions === undefined ? [] : input.resolutions;
      if (!Array.isArray(resolutions) || resolutions.length !== plan.conflicts.length || resolutions.some(choice => !choice || typeof choice !== 'object' || Array.isArray(choice) || Object.keys(choice).some(key => !['id', 'choice'].includes(key)) || !plan.conflicts.includes(choice.id) || choice.choice !== 'keep-current') || new Set(resolutions.map(choice => choice.id)).size !== plan.conflicts.length) throw Error('Every conflicting conversation requires an explicit Keep current choice. Existing history was preserved.');
      const noteFiles = input.noteFiles === undefined ? [] : input.noteFiles;
      if (!Array.isArray(noteFiles) || new Set(noteFiles).size !== noteFiles.length || noteFiles.some(file => typeof file !== 'string' || matched.settingsMode !== 'review-note-inclusions' || !matched.noteCandidates.some(candidate => !candidate.unavailable && candidate.file === file))) throw Error('Select only individually reviewed available note inclusions.');
      for (const file of noteFiles) { const actual = await this.noteSnapshot(file, this.history.getVault()), approved = matched.noteCandidates.find(candidate => candidate.file === file); if (actual.digest !== approved.digest || actual.text !== approved.text) throw Error('A reviewed note changed. Preview its current bytes again; nothing was restored.'); }
      if (!plan.additions.length && !noteFiles.length && !metadata.additions.length) throw Error('There are no new reviewed additions to restore. Existing history and settings were preserved.');
      let restored = 0, restoredNotes = 0, preservedMetadata = 0;
      try {
        preservedMetadata += await this.retainIntents(reviewed.archive, matched.sourceRoot, matched.root);
        preservedMetadata += await this.retainCoverage(reviewed.archive);
        preservedMetadata += await this.retainCodexHints(reviewed.archive);
        for (const original of plan.additions) {
          const record = structuredClone(original);
          for (const request of record.requests) if (request.status === 'inProgress') Object.assign(request, { status: 'interrupted', error: 'Imported active request is incomplete. Retry requires fresh context review; nothing was replayed.' });
          await this.publishAddition(record); restored++;
        }
        if (noteFiles.length) restoredNotes = await this.includeReviewedNotes(noteFiles, matched);
      } catch (error) { throw Error(`Restored ${restored} conversation${restored === 1 ? '' : 's'} before restore stopped. ${error.message} Existing conversations were preserved. Inert metadata may already have been preserved; inspect it before retrying. ${noteFiles.length ? 'Reviewed note settings may have been published; inspect the current inclusions before retrying. ' : ''}Inspect again to review remaining additions; no automatic retry occurs.`); }
      return { restored, restoredNotes, preservedMetadata, equal: plan.equal.length, inactiveIntents: (await this.inactiveIntents()).length };
    });
  }
  async revalidateInspectedFile(reviewed) {
    try {
      const current = await this.json(reviewed.input.file, reviewed.input.guard, false, true);
      if (current.digest !== reviewed.input.digest) throw Error('Changed archive bytes.');
    } catch {
      this.restoreReview = null;
      throw Error('Archive file changed since inspection or is no longer an ordinary available file. Inspect the current file again; nothing was restored.');
    }
  }
  async noteSnapshot(file, vault) {
    const base = path.resolve(vault.vault), relative = path.relative(base, file);
    if (!path.isAbsolute(file) || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw Error('Archived note is outside the matched vault.');
    const directories = [base]; let current = base;
    for (const segment of path.dirname(relative).split(path.sep).filter(segment => segment && segment !== '.')) { current = path.join(current, segment); directories.push(current); }
    const identities = directories.map(directory => local.lstatSync(directory, { bigint: true }));
    const guard = () => {
      this.guard();
      directories.forEach((directory, index) => { const stat = local.lstatSync(directory, { bigint: true }); if (!stat.isDirectory() || stat.isSymbolicLink() || !same(stat, identities[index]) || local.realpathSync(directory) !== directory) throw Error('Reviewed note path changed or contains an alias.'); });
    };
    guard(); const stat = await fs.lstat(file); guard();
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > 2 * 1024 * 1024) throw Error('Choose an ordinary unlinked note no larger than 2 MiB.');
    const context = new Context(vault), note = await context.note(file); guard();
    // Re-open a pinned descriptor and compare the current exact bytes with the eligibility reader.
    let handle;
    try {
      handle = await fs.open(file, local.constants.O_RDONLY | (local.constants.O_NOFOLLOW || 0)); guard();
      const opened = await handle.stat(), bytes = await handle.readFile(); guard();
      const leaf = await fs.lstat(file), after = await handle.stat(); guard();
      if (!same(stat, opened) || !same(opened, leaf) || !leaf.isFile() || leaf.isSymbolicLink() || leaf.nlink !== 1 || opened.size !== after.size || opened.mtimeMs !== after.mtimeMs || bytes.length > 2 * 1024 * 1024) throw Error('Reviewed note changed. Preview again.');
      const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
      if (text !== note.text) throw Error('Reviewed note changed. Preview again.');
      return { file, title: note.title, digest: hash(bytes), text };
    } finally { await handle?.close(); }
  }
  async noteCandidates(archive, sourceRoot, vault) {
    const binding = archive.payload.vaultBindings.find(item => item.managedRoot === sourceRoot), candidates = [];
    const files = archive.payload.contextScopes.find(scope => scope.binding === hash(sourceRoot))?.files || [];
    for (const original of [...new Set(files)]) {
      try {
        if (!binding.vault || !path.isAbsolute(binding.vault)) throw Error('Archived vault directory hint is unavailable.');
        const relative = path.relative(binding.vault, original);
        if (!path.isAbsolute(original) || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw Error('Archived note is outside its declared vault.');
        const file = path.resolve(vault.vault, relative);
        candidates.push({ ...(await this.noteSnapshot(file, vault)), original });
      } catch (error) { candidates.push({ original, unavailable: true, reason: error.message }); }
    }
    return candidates;
  }
  async includeReviewedNotes(files, matched) {
    const vault = this.history.getVault(), directory = path.join(this.history.dataRoot, `context-settings-${hash(vault.root)}`), file = path.join(directory, 'notes.json');
    this.guard(); try { await fs.mkdir(directory); } catch (error) { if (error.code !== 'EEXIST') throw error; } this.guard();
    const guard = this.directoryGuard(directory);
    return withBriefMutation(directory, async () => {
      guard(); const current = await this.json(file, guard, true);
      if ((current?.digest || null) !== (matched.snapshot.fingerprints[file] || null)) throw Error('Current note inclusions changed. Preview settings again.');
      const existing = current?.value.files || [];
      for (const chosen of files) { const actual = await this.noteSnapshot(chosen, vault), approved = matched.noteCandidates.find(candidate => candidate.file === chosen); if (actual.digest !== approved.digest || actual.text !== approved.text) throw Error('Reviewed note changed. Preview settings again.'); }
      const next = [...new Set([...existing, ...files])], stage = path.join(directory, `notes-${randomUUID()}.tmp`); let handle;
      try {
        handle = await fs.open(stage, 'wx'); guard(); await handle.writeFile(JSON.stringify({ schema: 1, files: next }, null, 2), 'utf8'); guard(); await handle.sync(); await handle.close(); handle = null;
        const latest = await this.json(file, guard, true);
        if ((latest?.digest || null) !== (current?.digest || null)) throw Error('Note inclusion settings changed before publication. Existing scope was preserved.');
        guard(); if (current) await fs.rename(stage, file); else await fs.link(stage, file); guard();
        this.history.tokens.clear(); this.invalidateContextApprovals();
        return next.length - existing.length;
      } finally { await handle?.close(); guard(); await fs.unlink(stage).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
    });
  }
  async validatePins(archive, sourceRoot, vault) {
    try {
      for (const record of archive.payload.conversations.filter(record => record.vault.root === sourceRoot)) {
        const pins = await new Briefs(vault).records(record.brief.version);
        if (!pins.some(pin => pin.id === record.brief.id && pin.version === record.brief.version && pin.digest === record.brief.digest)) throw Error('Pin mismatch.');
      }
    } catch { throw Error('Exact archived brief pin is unavailable in the selected vault. Select its separate vault backup; nothing was restored.'); }
  }
  async pendingInventory(names) {
    const records = []; let total = 0;
    for (const name of [...names].sort()) {
      if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,140}\.pending$/.test(name)) throw Error('Unrecognized pending filename. Preserve it and inspect the local history folder separately; export stays blocked.');
      const read = await this.json(path.join(this.history.directory, name), undefined, false, false, true);
      total += read.value.length; if (total > LIMIT) throw Error('Pending recovery files exceed 128 MiB. Preserve and review them separately; export stays blocked.');
      let kind = 'unknown-data', text;
      try { text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(read.value); conversation(parseArchive(text)); kind = 'validated-conversation'; } catch { text = undefined; }
      records.push({ name, sha256: read.digest, bytes: read.value.length, kind, ...(text === undefined ? {} : { text }) });
    }
    return records;
  }
  async reviewPending() {
    this.recoveryReview = null;
    if (this.history.running.size || this.history.unsaved.size) throw Error('Finish active requests and save retained unsaved replies before reviewing recovery files.');
    return this.history.lock(async () => {
      this.directory = this.history.safeDirectory();
      if (this.history.running.size || this.history.unsaved.size) throw Error('Finish active requests and save retained unsaved replies before reviewing recovery files.');
      const names = (await fs.readdir(this.history.directory)).filter(name => name.endsWith('.pending')); this.guard();
      const records = await this.pendingInventory(names), id = randomUUID();
      this.recoveryReview = { id, omitted: records.map(({ text, ...item }) => item) };
      return { id, location: this.history.directory, records };
    });
  }
  async inactiveCoverages(fingerprints) {
    const records = [], names = await fs.readdir(this.history.dataRoot); this.guard();
    for (const name of names.sort().filter(name => /^archive-coverage-[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}\.json$/.test(name))) {
      const file = path.join(this.history.dataRoot, name), read = await this.json(file), record = inactiveCoverage(read.value);
      if (name !== `archive-coverage-${record.archiveId}.json`) throw Error('Retained archive coverage identity needs repair.');
      records.push(record); if (fingerprints) fingerprints[file] = read.digest;
    }
    return records;
  }
  async metadataPlan(archive, sourceRoot, targetRoot) {
    const candidates = [], additions = [], equal = [], conflicts = [], types = { cadence: 0, codexHints: 0, coverage: 0 };
    for (const value of this.matchedIntents(archive, sourceRoot, targetRoot)) {
      const record = inactiveIntent(value); candidates.push({ kind: 'cadence', name: `archive-intent-${record.archiveId}-${hash(record.sourceRoot + '\n' + record.targetRoot)}.json`, record });
    }
    for (const value of [...(archive.payload.settings?.inactiveArchiveCoverage || []), ...(archive.coverage ? [{ schema: 1, archiveId: archive.id, coverage: archive.coverage }] : [])]) {
      const record = inactiveCoverage(value); candidates.push({ kind: 'coverage', name: `archive-coverage-${record.archiveId}.json`, record });
    }
    for (const value of this.archiveCodexHints(archive)) {
      const record = inactiveCodexHints(value); candidates.push({ kind: 'codexHints', name: `archive-codex-hints-${record.archiveId}.json`, record });
    }
    const seen = new Map();
    for (const item of candidates) {
      if (seen.has(item.name)) { if (canonical(seen.get(item.name)) !== canonical(item.record)) throw Error('The archive contains conflicting inert settings identities. Nothing was restored.'); continue; }
      seen.set(item.name, item.record);
      const existing = await this.json(path.join(this.history.dataRoot, item.name), undefined, true);
      if (!existing) { additions.push(item.name); types[item.kind]++; }
      else if (canonical(existing.value) === canonical(item.record)) equal.push(item.name);
      else conflicts.push(item.name);
    }
    return { additions, equal, conflicts, types };
  }
  async ownCodexHints(fingerprints) {
    const directory = path.join(this.history.dataRoot, 'codex'); this.guard();
    let guard;
    try { guard = this.directoryGuard(directory); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
    const file = path.join(directory, 'setup.json'), read = await this.json(file, guard, true);
    if (!read) return null;
    // Only this Companion-owned preference file is read. Never traverse managed-home or other Codex data.
    const preferences = codexHints({ executable: read.value.executable, project: read.value.project, vault: read.value.vault, sandbox: read.value.sandbox, reapprovalRequired: true });
    if (fingerprints) fingerprints[file] = read.digest;
    return preferences;
  }
  archiveCodexHints(archive) {
    return [...(archive.payload.settings?.inactiveCodexReconnectHints || []), ...(archive.payload.settings?.codexReconnectHints ? [{ schema: 1, archiveId: archive.id, preferences: archive.payload.settings.codexReconnectHints }] : [])];
  }
  async inactiveCodexHints(fingerprints) {
    const records = [], names = await fs.readdir(this.history.dataRoot); this.guard();
    for (const name of names.sort().filter(name => /^archive-codex-hints-[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}\.json$/.test(name))) {
      const file = path.join(this.history.dataRoot, name), read = await this.json(file), record = inactiveCodexHints(read.value);
      if (name !== `archive-codex-hints-${record.archiveId}.json`) throw Error('Retained Codex hint identity needs repair.');
      records.push(record); if (fingerprints) fingerprints[file] = read.digest;
    }
    return records;
  }
  async retainCodexHints(archive) {
    let preserved = 0;
    for (const original of this.archiveCodexHints(archive)) {
      const record = inactiveCodexHints(original), destination = path.join(this.history.dataRoot, `archive-codex-hints-${record.archiveId}.json`), existing = await this.json(destination, undefined, true);
      if (existing) { if (canonical(existing.value) !== canonical(record)) throw Error('Retained Codex hints differ. Existing hints were preserved.'); continue; }
      const directory = this.history.safeDirectory(), stage = path.join(this.history.dataRoot, `.archive-codex-hints-${randomUUID()}.pending`); let handle;
      try {
        this.history.safeDirectory(false, directory); handle = await fs.open(stage, 'wx'); this.history.safeDirectory(false, directory);
        await handle.writeFile(JSON.stringify(record, null, 2), 'utf8'); await handle.sync(); await handle.close(); handle = null;
        this.history.safeDirectory(false, directory); await fs.link(stage, destination); this.history.safeDirectory(false, directory); preserved++;
      } finally { await handle?.close(); this.history.safeDirectory(false, directory); await fs.unlink(stage).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
    }
    return preserved;
  }
  async retainCoverage(archive) {
    let preserved = 0;
    const records = [...(archive.payload.settings?.inactiveArchiveCoverage || []), ...(archive.coverage ? [{ schema: 1, archiveId: archive.id, coverage: archive.coverage }] : [])];
    for (const original of records) {
      const record = inactiveCoverage(original), destination = path.join(this.history.dataRoot, `archive-coverage-${record.archiveId}.json`), existing = await this.json(destination, undefined, true);
      if (existing) { if (canonical(existing.value) !== canonical(record)) throw Error('Retained omission metadata differs. Existing metadata was preserved.'); continue; }
      const directory = this.history.safeDirectory(), stage = path.join(this.history.dataRoot, `.archive-coverage-${randomUUID()}.pending`); let handle;
      try {
        this.history.safeDirectory(false, directory); handle = await fs.open(stage, 'wx'); this.history.safeDirectory(false, directory);
        await handle.writeFile(JSON.stringify(record, null, 2), 'utf8'); await handle.sync(); await handle.close(); handle = null;
        this.history.safeDirectory(false, directory); await fs.link(stage, destination); this.history.safeDirectory(false, directory); preserved++;
      } finally { await handle?.close(); this.history.safeDirectory(false, directory); await fs.unlink(stage).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
    }
    return preserved;
  }
  async inactiveIntents(fingerprints) {
    const records = [], names = await fs.readdir(this.history.dataRoot); this.guard();
    for (const name of names.sort().filter(name => /^archive-intent-[a-f0-9-]{36}-[a-f0-9]{64}\.json$/.test(name))) {
      const file = path.join(this.history.dataRoot, name), read = await this.json(file);
      const record = inactiveIntent(read.value);
      if (name !== `archive-intent-${record.archiveId}-${hash(record.sourceRoot + '\n' + record.targetRoot)}.json`) throw Error('Imported schedule intent identity needs repair.');
      records.push(record); if (fingerprints) fingerprints[file] = read.digest;
    }
    return records;
  }
  async retainIntents(archive, sourceRoot, targetRoot) {
    let preserved = 0;
    const records = this.matchedIntents(archive, sourceRoot, targetRoot);
    for (const original of records) {
      const record = inactiveIntent(original), destination = path.join(this.history.dataRoot, `archive-intent-${record.archiveId}-${hash(record.sourceRoot + '\n' + record.targetRoot)}.json`);
      const existing = await this.json(destination, undefined, true);
      if (existing) { if (canonical(existing.value) !== canonical(record)) throw Error('Imported cadence intent differs. Existing intent was preserved.'); continue; }
      const directory = this.history.safeDirectory(), stage = path.join(this.history.dataRoot, `.archive-intent-${randomUUID()}.pending`); let handle;
      try {
        this.history.safeDirectory(false, directory); handle = await fs.open(stage, 'wx'); this.history.safeDirectory(false, directory);
        await handle.writeFile(JSON.stringify(record, null, 2), 'utf8'); await handle.sync(); await handle.close(); handle = null;
        this.history.safeDirectory(false, directory); await fs.link(stage, destination); this.history.safeDirectory(false, directory); preserved++;
      } finally { await handle?.close(); this.history.safeDirectory(false, directory); await fs.unlink(stage).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
    }
    return preserved;
  }
  matchedIntents(archive, sourceRoot, targetRoot) {
    const inherited = (archive.payload.settings?.inactiveScheduleIntents || []).map(original => {
      const record = structuredClone(inactiveIntent(original));
      // Only this explicitly matched former destination may become usable in the new installation.
      if (record.targetRoot === sourceRoot) record.targetRoot = targetRoot;
      return record;
    });
    return [...inherited, ...(archive.payload.scheduleIntent ? [{ schema: 1, archiveId: archive.id, sourceRoot, targetRoot, intent: archive.payload.scheduleIntent }] : [])];
  }
  async state() { return this.history.lock(async () => { this.directory = this.history.safeDirectory(); return { inactiveIntents: await this.inactiveIntents(), codexHints: await this.inactiveCodexHints() }; }); }
  async reconnectPreview(input) {
    this.reconnectReview = null;
    return this.history.lock(async () => {
      this.directory = this.history.safeDirectory();
      const vault = this.history.getVault(); if (!vault) throw Error('Select the matched vault before reconnecting imported cadence.');
      const intents = (await this.inactiveIntents()).filter(record => record.archiveId === input?.archiveId && record.targetRoot === vault.root);
      if (intents.length !== 1) throw Error('Select exactly one imported cadence matched to the current vault.');
      const imported = intents[0], schedule = this.getSchedule(), file = path.join(this.history.dataRoot, 'schedule.json');
      const prior = await this.json(file, undefined, true), existing = prior?.value || null;
      if (existing && (existing.schema !== 1 || !/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(existing.id) || !Number.isFinite(Date.parse(existing.anchor)) || typeof existing.vault !== 'string' || !path.isAbsolute(existing.vault) || typeof existing.parent !== 'string' || !['enabled', 'paused', 'disabled'].includes(existing.mode) || !Number.isSafeInteger(existing.handledSlot) || existing.handledSlot < 0 || !['pending', 'connected'].includes(existing.archiveReconnect?.status))) throw Error('Current daily intake settings need repair. They were preserved.');
      if (existing && (!existing.archiveReconnect || existing.archiveReconnect.archiveId !== imported.archiveId || existing.archiveReconnect.sourceRoot !== imported.sourceRoot || existing.archiveReconnect.targetRoot !== imported.targetRoot || existing.archiveReconnect.intentId !== imported.intent.id || path.resolve(existing.vault, existing.parent) !== vault.root)) throw Error('Current daily intake settings belong to another schedule. Preserve them and resolve that schedule explicitly before reconnection.');
      const state = existing || { schema: 1, id: randomUUID(), anchor: imported.intent.anchor, vault: vault.vault, parent: path.relative(vault.vault, vault.root), mode: 'disabled', handledSlot: Math.max(0, Math.floor((Date.parse(this.clock().now) - Date.parse(imported.intent.anchor)) / 86400000)), archiveReconnect: { archiveId: imported.archiveId, sourceRoot: imported.sourceRoot, targetRoot: imported.targetRoot, intentId: imported.intent.id, status: 'pending' } };
      if (state.id === imported.intent.id || state.anchor !== imported.intent.anchor) throw Error('Imported cadence connection identity needs repair. Preserve current settings.');
      const effective = await schedule.tasks.apply('inspect', state, file); this.guard();
      if (effective && !schedule.tasks.matchesSchedule(effective, state, file)) throw Error('Current owned task policy differs. Use the explicit daily intake repair workflow before reconnecting.');
      const alreadyConnected = state.archiveReconnect.status === 'connected' && state.mode === imported.intent.mode && (state.mode === 'disabled' ? !effective : effective && effective.enabled === (state.mode === 'enabled'));
      const token = randomUUID();
      this.reconnectReview = { token, imported, state, priorDigest: prior?.digest || null, root: vault.root, alreadyConnected };
      return { token, anchor: state.anchor, mode: imported.intent.mode, alreadyConnected, pending: !!existing && state.archiveReconnect.status !== 'connected' };
    });
  }
  async reconnect(input) {
    const review = this.reconnectReview; this.reconnectReview = null;
    if (!review || input?.token !== review.token || review.alreadyConnected) throw Error('Preview imported cadence and confirm its reconnection explicitly.');
    return this.history.lock(async () => {
      this.directory = this.history.safeDirectory();
      const schedule = this.getSchedule();
      return schedule.change(async () => {
        if (this.history.getVault()?.root !== review.root) throw Error('Current vault changed. Preview reconnection again.');
        const intents = await this.inactiveIntents();
        if (!intents.some(record => canonical(record) === canonical(review.imported))) throw Error('Imported intent changed. Preview reconnection again.');
        const file = path.join(this.history.dataRoot, 'schedule.json'), current = await this.json(file, undefined, true);
        if ((current?.digest || null) !== review.priorDigest) throw Error('Daily intake settings changed. Preview reconnection again; existing settings were preserved.');
        const state = structuredClone(review.state), requested = review.imported.intent.mode;
        // Persist the same fresh local ID disabled before registration. Failed/crashed attempts cannot catch up.
        state.mode = 'disabled'; state.archiveReconnect.status = 'pending';
        state.handledSlot = Math.max(state.handledSlot || 0, Math.max(0, Math.floor((Date.parse(this.clock().now) - Date.parse(state.anchor)) / 86400000)));
        const effective = await schedule.tasks.apply('inspect', state, file); this.guard();
        if (effective && !schedule.tasks.matchesSchedule(effective, state, file)) throw Error('Owned task policy changed. Preserve it and repair explicitly.');
        let digest = await this.saveReconnectSchedule(state, review.priorDigest);
        try {
          const action = requested === 'disabled' ? 'disable' : requested === 'paused' ? 'repair' : 'enable';
          state.task = await schedule.tasks.apply(action, { ...state, mode: requested }, file); this.guard();
          state.mode = requested; state.archiveReconnect.status = 'connected'; delete state.taskError;
          await this.saveReconnectSchedule(state, digest);
        } catch (error) {
          // The persisted pending/disabled record owns the attempted ID. Retry reuses it, even if task creation succeeded.
          throw Error(`Imported cadence reconnection did not finish. A pending disabled local record was saved before registration; the task or final connection write may have succeeded. Preview again to inspect the same local identity before an explicit retry. ${error.message}`);
        }
        return { connected: true, id: state.id, anchor: state.anchor };
      });
    });
  }
  async saveReconnectSchedule(state, expectedDigest) {
    const directory = this.history.safeDirectory(), destination = path.join(this.history.dataRoot, 'schedule.json');
    const stage = path.join(this.history.dataRoot, `.archive-reconnect-${randomUUID()}.pending`), text = JSON.stringify(state, null, 2); let handle;
    try {
      handle = await fs.open(stage, 'wx'); this.history.safeDirectory(false, directory);
      await handle.writeFile(text, 'utf8'); this.history.safeDirectory(false, directory); await handle.sync(); await handle.close(); handle = null;
      const current = await this.json(destination, undefined, true);
      if ((current?.digest || null) !== expectedDigest) throw Error('Daily intake settings changed. Existing settings were preserved.');
      this.history.safeDirectory(false, directory);
      if (expectedDigest === null) await fs.link(stage, destination);
      else await this.history.publishStage(stage, destination, directory);
      this.history.safeDirectory(false, directory); return hash(text);
    } finally { await handle?.close(); this.history.safeDirectory(false, directory); await fs.unlink(stage).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
  }
  async publishAddition(record) {
    const directory = this.history.safeDirectory(), destination = path.join(this.history.directory, `${record.id}.json`);
    const stage = path.join(this.history.directory, `archive-${randomUUID()}.pending`); let handle;
    try {
      this.history.safeDirectory(false, directory);
      handle = await fs.open(stage, 'wx'); this.history.safeDirectory(false, directory);
      await handle.writeFile(JSON.stringify(record, null, 2), 'utf8'); await handle.sync(); await handle.close(); handle = null;
      this.history.safeDirectory(false, directory);
      await fs.link(stage, destination); this.history.safeDirectory(false, directory);
      // Imported capacity bindings and provider IDs are historical bytes, never dispatch approval.
      for (const [token, approval] of this.history.tokens) if (approval.input.conversationId === record.id) this.history.tokens.delete(token);
    } catch (error) { if (error.code === 'EEXIST') throw Error('A conversation appeared during restore. It was not replaced.'); throw error; }
    finally {
      await handle?.close(); this.history.safeDirectory(false, directory);
      await fs.unlink(stage).catch(error => { if (error.code !== 'ENOENT') throw error; });
    }
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
      await this.checkpoint('archive-before-publish');
      await guard();
      // Atomic exclusive publication: an existing destination is never replaced.
      await fs.link(stage, destination); await guard();
    } catch (error) { if (error.code === 'EEXIST') throw Error('Archive destination already exists. Choose a new file; existing content was preserved.'); throw error; }
    finally { await handle?.close(); await guard(); await fs.unlink(stage).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
  }
}
function installArchives({ ipcMain, ...options }) {
  const archives = new Archives(options);
  ipcMain.handle('archive-preview', (_, input) => archives.preview(input));
  ipcMain.handle('archive-export', (_, input) => archives.export(input));
  ipcMain.handle('archive-inspect', () => archives.inspect());
  ipcMain.handle('archive-match', (_, input) => archives.match(input));
  ipcMain.handle('archive-restore', (_, input) => archives.restore(input));
  ipcMain.handle('archive-state', () => archives.state());
  ipcMain.handle('archive-reconnect-preview', (_, input) => archives.reconnectPreview(input));
  ipcMain.handle('archive-reconnect', (_, input) => archives.reconnect(input));
  ipcMain.handle('archive-review-pending', () => archives.reviewPending());
}
module.exports = { installArchives };
