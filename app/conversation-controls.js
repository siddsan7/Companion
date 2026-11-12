const fs = require('node:fs/promises');
const local = require('node:fs');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
const { performance } = require('node:perf_hooks');
const { setTimeout: wait } = require('node:timers/promises');
const { conversation } = require('./archive-format');
const { writeStage, verifyStage, verifyStageSync, verifyAbsentSync, removeLinkedStage } = require('./staged-publication');
const hash = text => createHash('sha256').update(text).digest('hex');
const uuid = value => typeof value === 'string' && /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(value);
const same = (a, b) => a.dev === b.dev && a.ino === b.ino;
const fields = (value, allowed) => value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).every(key => allowed.includes(key));
const rawProof = ({ owned, rawDigest }) => ({ dev: owned.dev, ino: owned.ino, digest: rawDigest });

// Local controls are authority, not archived conversation content. Never infer consent from absence.
class ConversationControls {
  constructor(store) { this.store = store; this.previews = new Map(); this.known = new Set(); }
  guard(create = false, expected) {
    const parent = this.store.safeDirectory(), directory = path.join(this.store.directory, '.control');
    if (create) { try { local.mkdirSync(directory); } catch (error) { if (error.code !== 'EEXIST') throw error; } }
    let stat;
    try { stat = local.lstatSync(directory, { bigint: true }); }
    catch (error) { if (error.code === 'ENOENT' && !this.identity && !expected) return null; throw error; }
    if (!stat.isDirectory() || stat.isSymbolicLink() || local.realpathSync(directory) !== directory || this.identity && !same(stat, this.identity) || expected && !same(stat, expected)) throw Error('Conversation controls require the original ordinary contained folder. Preserve local writing for repair.');
    this.store.safeDirectory(false, parent); this.identity = stat;
    return { directory, stat, parent };
  }
  async file(file, directory, expected, links = 1, control = false, exactBytes = false) {
    if (control) this.guard(false, directory.stat); else this.store.safeDirectory(false, directory);
    const before = await fs.lstat(file, { bigint: true });
    if (!before.isFile() || before.isSymbolicLink() || before.nlink !== BigInt(links)) throw Error('Conversation deletion encountered a linked or nonordinary file. Preserve it for review.');
    const handle = await fs.open(file, 'r');
    try {
      if (!same(before, await handle.stat({ bigint: true }))) throw Error('Conversation deletion file identity changed.');
      const bytes = await handle.readFile();
      const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
      if (control) this.guard(false, directory.stat); else this.store.safeDirectory(false, directory);
      const after = await fs.lstat(file, { bigint: true });
      if (!same(before, after) || after.nlink !== BigInt(links)) throw Error('Conversation deletion file identity changed.');
      const owned = { name: path.basename(file), sha256: hash(text), dev: String(after.dev), ino: String(after.ino), bytes: Buffer.byteLength(text, 'utf8') };
      if (expected && JSON.stringify(owned) !== JSON.stringify(expected)) throw Error('Conversation deletion target changed. Preserve it and preview again.');
      return { text, stat: after, owned, rawDigest: exactBytes ? hash(bytes) : undefined };
    } finally { await handle.close(); }
  }
  validate(value, id) {
    const fail = () => { throw Error('Conversation control is unknown or corrupt. Preserve all writing; ordinary history access is blocked.'); };
    if (!fields(value, ['schema', 'id', 'generation', 'phase', 'scope', 'targets', 'publication', 'restoration']) || value.schema !== 1 || value.id !== id || !uuid(id) || !uuid(value.generation) || !uuid(value.publication) || !['deleting', 'deleted', 'restoring', 'active'].includes(value.phase)) fail();
    if (value.restoration !== undefined && (!fields(value.restoration, ['archiveId', 'recordDigest']) || !uuid(value.restoration.archiveId) || typeof value.restoration.recordDigest !== 'string' || !/^[a-f0-9]{64}$/.test(value.restoration.recordDigest))) fail();
    if (value.phase === 'restoring' && !value.restoration) fail();
    if (!fields(value.scope, ['excludedSources', 'excludedHistory']) || !Array.isArray(value.scope.excludedSources) || value.scope.excludedSources.some(key => typeof key !== 'string') || !Array.isArray(value.scope.excludedHistory) || value.scope.excludedHistory.some(key => !uuid(key)) || !Array.isArray(value.targets)) fail();
    const names = new Set();
    for (const target of value.targets) {
      if (!fields(target, ['name', 'sha256', 'dev', 'ino', 'bytes']) || typeof target.name !== 'string' || !/^[a-f0-9-]{36}\.(json|pending)$/.test(target.name) || !uuid(target.name.split('.')[0]) || names.has(target.name) || typeof target.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(target.sha256) || typeof target.dev !== 'string' || typeof target.ino !== 'string' || !Number.isSafeInteger(target.bytes) || target.bytes < 0) fail();
      names.add(target.name);
      if (target.name.endsWith('.json') && target.name !== `${id}.json`) fail();
    }
    if (['deleting', 'deleted'].includes(value.phase) && !names.has(`${id}.json`)) fail();
    if (value.phase === 'restoring') {
      const stage = value.targets.find(target => target.name.endsWith('.pending')), destination = value.targets.find(target => target.name === `${id}.json`);
      if (value.targets.length !== 2 || !stage || !destination || stage.sha256 !== value.restoration.recordDigest || ['sha256', 'dev', 'ino', 'bytes'].some(key => stage[key] !== destination[key])) fail();
    }
    return value;
  }
  async state(id) {
    if (!uuid(id)) throw Error('Conversation identity is invalid.');
    const directory = this.guard(); if (!directory) return null;
    const file = path.join(directory.directory, `${id}.json`);
    let marker;
    try {
      const stat = await fs.lstat(file);
      if (![1, 2].includes(stat.nlink)) throw Error('Conversation control has unknown linked peers.');
      const data = await this.file(file, directory, null, stat.nlink, true);
      marker = this.validate(JSON.parse(data.text), id);
      if (stat.nlink !== 1) {
        if (stat.nlink !== 2) throw Error('Conversation control has unknown linked peers.');
        const stage = await this.file(path.join(directory.directory, `${marker.publication}.pending`), directory, null, 2, true);
        if (!same(data.stat, stage.stat) || data.text !== stage.text) throw Error('Conversation control has unknown linked peers.');
      }
      this.known.add(id);
    } catch (error) { if (error.code !== 'ENOENT' || marker || this.known.has(id)) throw error; }
    for (const name of await fs.readdir(directory.directory)) {
      if (/^[a-f0-9-]{36}\.json$/.test(name)) {
        const otherId = name.slice(0, -5); if (otherId === id && marker) continue;
        const other = await this.file(path.join(directory.directory, name), directory, null, 1, true);
        this.validate(JSON.parse(other.text), otherId); continue;
      }
      if (!/^[a-f0-9-]{36}\.pending$/.test(name)) throw Error('Unknown conversation control file remains preserved; access is blocked.');
      const stat = await fs.lstat(path.join(directory.directory, name));
      if (![1, 2].includes(stat.nlink)) throw Error('Conversation control stage has unknown linked peers.');
      const stage = await this.file(path.join(directory.directory, name), directory, null, stat.nlink, true);
      const candidate = JSON.parse(stage.text); this.validate(candidate, candidate.id);
      if (name !== `${candidate.publication}.pending` || stat.nlink !== 1 && !(marker && candidate.publication === marker.publication && stat.nlink === 2)) throw Error('Unknown conversation control stage remains preserved; access is blocked.');
      if (!marker && candidate.id === id) throw Error('An unpublished conversation control requires explicit recovery. History remains preserved and blocked.');
    }
    return marker || null;
  }
  async check(record) {
    const marker = await this.state(record.id);
    if (!marker) { if (record.generation !== undefined && record.generation !== null) throw Error('Conversation generation has no local authority. Explicit restoration is required.'); return; }
    if (marker.phase !== 'active' || record.generation !== marker.generation) throw Error('Conversation was deleted or its generation changed. Stale history cannot be saved or sent.');
    const scope = record.scope;
    if (!scope || marker.scope.excludedSources.some(key => !scope.excludedSources.includes(key)) || marker.scope.excludedHistory.some(id => !scope.excludedHistory.includes(id))) throw Error('Current conversation exclusions remain authoritative. Preview current scope again.');
  }
  async authority() {
    const directory = this.guard(); if (!directory) return { markers: [], stages: [] };
    const markers = [], stages = [];
    for (const name of (await fs.readdir(directory.directory)).sort()) {
      if (/^[a-f0-9-]{36}\.json$/.test(name)) markers.push(await this.state(name.slice(0, -5)));
      else if (/^[a-f0-9-]{36}\.pending$/.test(name)) {
        const stat = await fs.lstat(path.join(directory.directory, name));
        if (![1, 2].includes(stat.nlink)) throw Error('Unknown control stage peers remain preserved.');
        const file = await this.file(path.join(directory.directory, name), directory, null, stat.nlink, true), value = JSON.parse(file.text);
        this.validate(value, value.id); if (name !== `${value.publication}.pending`) throw Error('Unknown control stage remains preserved.');
        stages.push(file.owned);
      } else throw Error('Unknown local conversation authority remains preserved. Archive review is blocked.');
    }
    return { markers, stages };
  }
  async approveScope(record, scope) {
    const marker = await this.state(record.id); if (!marker) return;
    await this.check(record);
    // Lower only the explicitly restored floor before writing. Newly added exclusions
    // already live in the durable record after write; publish their full floor afterwards.
    const floor = { excludedSources: marker.scope.excludedSources.filter(key => scope.excludedSources.includes(key)), excludedHistory: marker.scope.excludedHistory.filter(id => scope.excludedHistory.includes(id)) };
    if (JSON.stringify(floor) === JSON.stringify(marker.scope)) return;
    await this.settlePublication(marker);
    await this.put({ ...marker, scope: floor }, marker);
  }
  async commitScope(record) {
    const marker = await this.state(record.id); if (!marker) return;
    await this.check(record);
    const scope = { excludedSources: [...record.scope.excludedSources], excludedHistory: [...record.scope.excludedHistory] };
    if (JSON.stringify(scope) === JSON.stringify(marker.scope)) return;
    await this.settlePublication(marker); await this.put({ ...marker, scope }, marker);
  }
  async replace(stage, file, guard, staged, current, revalidate, assertSelection) {
    const retry = process.platform === 'win32' && typeof revalidate === 'function';
    const deadline = performance.now() + 1000;
    let delay = 15, lastRefusal;
    while (true) {
      guard();
      if (lastRefusal && performance.now() >= deadline) throw lastRefusal;
      assertSelection();
      verifyStageSync(file, guard, current);
      verifyStageSync(stage, guard, staged);
      try { await fs.rename(stage, file); }
      catch (error) {
        const remaining = deadline - performance.now();
        if (!retry || error.syscall !== 'rename' || !['EPERM', 'EBUSY', 'EACCES'].includes(error.code) || remaining <= 0) throw error;
        lastRefusal = error;
        await wait(Math.min(delay, remaining));
        if (performance.now() >= deadline) throw error;
        guard();
        await revalidate();
        await verifyStage(stage, guard, staged);
        await verifyStage(file, guard, current);
        delay = Math.min(delay * 2, 100);
        continue;
      }
      // Verify the exact publication. Leave any unexpected files for inspection.
      await verifyStage(file, guard, staged);
      verifyStageSync(file, guard, staged);
      return;
    }
  }
  async put(marker, baseline, revalidate, assertSelection = () => {}, publication) {
    assertSelection();
    const directory = this.guard(true), file = path.join(directory.directory, `${marker.id}.json`);
    const value = { ...marker, publication: randomUUID() }, text = JSON.stringify(value, null, 2), stage = path.join(directory.directory, `${value.publication}.pending`);
    this.validate(value, value.id);
    const guard = () => {
      this.store.safeDirectory(false, directory.parent);
      this.guard(false, directory.stat);
    };
    const staged = await writeStage(stage, text, guard);
    if (baseline) {
      const current = await this.file(file, directory, null, 1, true, true);
      if (JSON.stringify(JSON.parse(current.text)) !== JSON.stringify(baseline)) throw Error('Conversation authority changed. Preserve the control stage for review.');
      await this.replace(stage, file, guard, staged, rawProof(current), revalidate, assertSelection);
    } else {
      assertSelection();
      verifyStageSync(stage, guard, staged);
      local.linkSync(stage, file);
      await removeLinkedStage(stage, file, guard, staged, assertSelection);
    }
    if (publication) await publication.check();
    verifyStageSync(file, guard, staged);
    this.known.add(marker.id);
    publication?.commit();
    return value;
  }
  async inventory(id) {
    if (this.store.unsaved.has(id) || this.store.running.has(id)) throw Error('Preserve the unsaved reply or finish the active request before deleting this conversation.');
    const record = await this.store.readStored(id), parent = this.store.safeDirectory();
    if (record.vault.root !== this.store.getVault()?.root) throw Error('Conversation belongs to another vault.');
    const target = await this.file(path.join(this.store.directory, `${id}.json`), parent);
    const targets = [target.owned], pending = [];
    for (const name of await fs.readdir(this.store.directory)) if (name.endsWith('.pending')) {
      if (!/^[a-f0-9-]{36}\.pending$/.test(name) || !uuid(name.slice(0, -8))) throw Error('Unknown pending history requires separate inspection before deletion.');
      const staged = await this.file(path.join(this.store.directory, name), parent);
      let candidate; try { candidate = JSON.parse(staged.text); } catch { throw Error('Unknown pending history remains preserved; deletion is blocked.'); }
      try { conversation(candidate); }
      catch { throw Error('Unknown or damaged pending history remains preserved; deletion is blocked.'); }
      if (candidate.id === id) {
        if (candidate.vault.root !== record.vault.root) throw Error('Pending history ownership is ambiguous. Preserve it before deletion.');
        targets.push(staged.owned); pending.push({ name, text: staged.text });
      }
    }
    return { id, marker: await this.state(id), record, targets: targets.sort((a, b) => a.name.localeCompare(b.name)), pending };
  }
  async preview(id) {
    return this.store.lock(async () => {
      const snapshot = await this.inventory(id), token = randomUUID();
      if (this.previews.size >= 32) this.previews.delete(this.previews.keys().next().value);
      this.previews.set(token, snapshot);
      return { token, id, requestCount: snapshot.record.requests.length, targets: snapshot.targets.map(target => target.name), pending: snapshot.pending };
    });
  }
  cancel(token) { this.previews.delete(token); }
  async recoverySnapshot(id, expectedParent) {
    const marker = await this.state(id);
    if (!marker || marker.phase !== 'deleting') throw Error('There is no interrupted deletion to resume for this identity.');
    if (this.store.unsaved.has(id) || this.store.running.has(id)) throw Error('Preserve unsaved writing or finish the active request before deletion recovery.');
    const parent = this.store.safeDirectory(false, expectedParent), remaining = [];
    for (const target of marker.targets) {
      try { await this.file(path.join(this.store.directory, target.name), parent, target); remaining.push(target.name); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    // Newly arrived or damaged stages were never covered by the retained deletion consent.
    for (const name of await fs.readdir(this.store.directory)) if (name.endsWith('.pending')) {
      if (!/^[a-f0-9-]{36}\.pending$/.test(name) || !uuid(name.slice(0, -8))) throw Error('Unknown pending history remains preserved; deletion recovery is blocked.');
      const staged = await this.file(path.join(this.store.directory, name), parent);
      let candidate;
      try { candidate = conversation(JSON.parse(staged.text)); }
      catch { throw Error('Unknown or damaged pending history remains preserved; deletion recovery is blocked.'); }
      if (candidate.id === id && (!marker.targets.some(target => target.name === name) || candidate.vault.root !== this.store.getVault()?.root)) throw Error('New or ambiguous pending history remains preserved. It was not part of the confirmed deletion manifest.');
    }
    return { recovery: true, id, marker, remaining };
  }
  async pending() {
    const records = [], issues = []; let directory;
    try { directory = this.guard(); if (!directory) return { records, issues }; }
    catch (error) { return { records, issues: [error.message] }; }
    for (const name of await fs.readdir(directory.directory)) {
      if (!/^[a-f0-9-]{36}\.json$/.test(name)) {
        if (!/^[a-f0-9-]{36}\.pending$/.test(name)) issues.push(`Unknown conversation control ${name} remains preserved; recovery requires review.`);
        else try {
          const stat = await fs.lstat(path.join(directory.directory, name));
          if (![1, 2].includes(stat.nlink)) throw Error('Unknown control stage peers remain preserved.');
          const staged = await this.file(path.join(directory.directory, name), directory, null, stat.nlink, true), value = JSON.parse(staged.text);
          this.validate(value, value.id);
          if (name !== `${value.publication}.pending`) throw Error('Unknown control stage identity remains preserved.');
          const published = await this.state(value.id);
          if (!published || published.publication !== value.publication) issues.push(`Uncommitted control stage ${name} remains preserved for explicit control repair. It is not deletion or restoration consent.`);
        } catch (error) { issues.push(`${name}: ${error.message}`); }
        continue;
      }
      const id = name.slice(0, -5); let marker;
      try {
        marker = await this.state(id);
        if (marker.phase === 'deleting') {
          const snapshot = await this.recoverySnapshot(id);
          records.push({ id, generation: marker.generation, targets: marker.targets.map(target => target.name), remaining: snapshot.remaining, canResume: true, warning: 'Previously confirmed deletion is incomplete. Inspect the exact retained manifest and resume explicitly. Nothing is removed during inspection.' });
        }
      } catch (error) { records.push({ id, generation: marker?.generation || 'unavailable', targets: marker?.targets?.map(target => target.name) || [], canResume: false, warning: error.message }); }
    }
    return { records, issues };
  }
  async resume(id) {
    return this.store.lock(async () => {
      const snapshot = await this.recoverySnapshot(id), token = randomUUID();
      if (this.previews.size >= 32) this.previews.delete(this.previews.keys().next().value);
      this.previews.set(token, snapshot);
      return { token, id, generation: snapshot.marker.generation, requestCount: null, targets: snapshot.marker.targets.map(target => target.name), pending: [], recovery: true };
    });
  }
  async settlePublication(marker, assertSelection = () => {}) {
    const directory = this.guard(), file = path.join(directory.directory, `${marker.id}.json`), stat = await fs.lstat(file);
    const guard = () => {
      assertSelection();
      this.store.safeDirectory(false, directory.parent);
      this.guard(false, directory.stat);
    };
    guard();
    if (stat.nlink === 1) return;
    if (stat.nlink !== 2) throw Error('Conversation control has unknown linked peers. Preserve them before recovery.');
    const stage = path.join(directory.directory, `${marker.publication}.pending`);
    const a = await this.file(file, directory, null, 2, true, true), b = await this.file(stage, directory, null, 2, true, true);
    if (!same(a.stat, b.stat) || a.rawDigest !== b.rawDigest || JSON.stringify(JSON.parse(a.text)) !== JSON.stringify(marker)) throw Error('Conversation control publication changed. Unknown peers remain preserved.');
    const proof = rawProof(a);
    await removeLinkedStage(stage, file, guard, proof);
    verifyAbsentSync(stage, guard);
    verifyStageSync(file, guard, proof);
  }
  async restorationSnapshot(id, { expectedParent, exactBytes = false } = {}) {
    const marker = await this.state(id);
    if (!marker || marker.phase !== 'restoring') throw Error('There is no interrupted history restoration for this identity.');
    if (this.store.unsaved.has(id) || this.store.running.has(id)) throw Error('Preserve unsaved writing or finish the active request before restoration recovery.');
    const parent = this.store.safeDirectory(false, expectedParent), stageTarget = marker.targets.find(target => target.name.endsWith('.pending')), destinationTarget = marker.targets.find(target => target.name.endsWith('.json'));
    const stage = path.join(this.store.directory, stageTarget.name), destination = path.join(this.store.directory, destinationTarget.name);
    const exists = async file => fs.lstat(file).then(() => true, error => { if (error.code === 'ENOENT') return false; throw error; });
    const stageExists = await exists(stage), destinationExists = await exists(destination);
    if (!stageExists && !destinationExists) throw Error('Restoration payload is unavailable. No history will be reconstructed from metadata.');
    const links = stageExists && destinationExists ? 2 : 1;
    const staged = stageExists ? await this.file(stage, parent, stageTarget, links, false, exactBytes) : null;
    const published = destinationExists ? await this.file(destination, parent, destinationTarget, links, false, exactBytes) : null;
    if (staged && published && (!same(staged.stat, published.stat) || staged.text !== published.text)) throw Error('Restoration has unknown or edited publication peers. Preserve both copies.');
    const text = (staged || published).text, record = conversation(JSON.parse(text));
    if (hash(text) !== marker.restoration.recordDigest || record.id !== id || record.generation !== marker.generation || record.vault.root !== this.store.getVault()?.root || JSON.stringify({ excludedSources: record.scope?.excludedSources, excludedHistory: record.scope?.excludedHistory }) !== JSON.stringify(marker.scope)) throw Error('Restoration ownership or retained exclusion authority changed. Preserve the payload for review.');
    if (exactBytes && [staged, published].some(file => file && file.rawDigest !== marker.restoration.recordDigest)) throw Error('Restoration payload bytes changed. Preserve the payload for review.');
    return { restoration: true, id, marker, stageExists, destinationExists, text, vaultRoot: record.vault.root };
  }
  async verifyRestorationComplete(marker, parent) {
    const current = await this.restorationSnapshot(marker.id, { expectedParent: parent, exactBytes: true });
    if (current.stageExists || !current.destinationExists || JSON.stringify(current.marker) !== JSON.stringify(marker)) throw Error('Restoration publication changed. Preserve the payload for review.');
  }
  async pendingRestorations() {
    const records = [], issues = []; let directory;
    try { directory = this.guard(); if (!directory) return { records, issues }; }
    catch (error) { return { records, issues: [error.message] }; }
    for (const name of await fs.readdir(directory.directory)) if (/^[a-f0-9-]{36}\.json$/.test(name)) {
      const id = name.slice(0, -5); let marker;
      try {
        marker = await this.state(id); if (marker.phase !== 'restoring') continue;
        const snapshot = await this.restorationSnapshot(id);
        records.push({ id, generation: marker.generation, archiveId: marker.restoration.archiveId, targets: marker.targets.map(target => target.name), text: snapshot.text, canResume: true });
      } catch (error) { if (marker?.phase === 'restoring') records.push({ id, generation: marker.generation, archiveId: marker.restoration.archiveId, targets: marker.targets.map(target => target.name), text: '', canResume: false, warning: error.message }); else issues.push(error.message); }
    }
    return { records, issues };
  }
  async resumeRestoration(id) {
    return this.store.lock(async () => {
      const snapshot = await this.restorationSnapshot(id), token = randomUUID();
      if (this.previews.size >= 32) this.previews.delete(this.previews.keys().next().value);
      this.previews.set(token, snapshot);
      return { token, id, generation: snapshot.marker.generation, archiveId: snapshot.marker.restoration.archiveId, targets: snapshot.marker.targets.map(target => target.name), text: snapshot.text };
    });
  }
  async restorationMarkerGuard(marker, guard) {
    guard();
    const directory = this.guard(), control = path.join(directory.directory, `${marker.id}.json`);
    const saved = await this.file(control, directory, null, 1, true, true);
    if (JSON.stringify(JSON.parse(saved.text)) !== JSON.stringify(marker)) throw Error('Restoration authority changed. Preserve the exact payload for review.');
    const controlProof = rawProof(saved);
    const controlGuard = () => { guard(); this.guard(false, directory.stat); };
    return () => { verifyStageSync(control, controlGuard, controlProof); };
  }
  async finishRestoration(snapshot) {
    const { marker, vaultRoot } = snapshot;
    const parent = this.store.safeDirectory(), stageTarget = marker.targets.find(target => target.name.endsWith('.pending')), target = marker.targets.find(target => target.name.endsWith('.json'));
    const stage = path.join(this.store.directory, stageTarget.name), destination = path.join(this.store.directory, target.name);
    const guard = () => {
      this.store.safeDirectory(false, parent);
      if (!vaultRoot || this.store.getVault()?.root !== vaultRoot) throw Error('The restoration vault selection changed. Preserve the payload for review.');
    };
    guard();
    await this.settlePublication(marker, guard);
    const verifyMarker = await this.restorationMarkerGuard(marker, guard);
    const proof = { dev: stageTarget.dev, ino: stageTarget.ino, digest: marker.restoration.recordDigest };
    if (!snapshot.destinationExists) {
      await this.file(stage, parent, stageTarget);
      verifyMarker();
      verifyStageSync(stage, guard, proof);
      local.linkSync(stage, destination);
      guard();
      await this.store.checkpoint('archive-restore-after-link');
    }
    const current = await this.restorationSnapshot(marker.id, { expectedParent: parent, exactBytes: true });
    if (JSON.stringify(current.marker) !== JSON.stringify(marker) || current.text !== snapshot.text) throw Error('Restoration authority changed. Preserve the exact payload for review.');
    if (current.stageExists) await removeLinkedStage(stage, destination, guard, proof, verifyMarker);
    await this.store.checkpoint('archive-restore-before-active');
    await this.file(destination, parent, target);
    const verifyPayload = () => {
      verifyAbsentSync(stage, guard);
      verifyStageSync(destination, guard, proof);
    };
    const active = await this.put({ ...marker, phase: 'active', targets: [] }, marker,
      () => this.verifyRestorationComplete(marker, parent), () => {
        verifyMarker();
        verifyPayload();
      });
    verifyPayload();
    this.store.tokens.clear();
    return { id: marker.id, generation: active.generation };
  }
  async finish(marker) {
    await this.settlePublication(marker);
    this.store.tokens.clear();
    await this.store.checkpoint('conversation-delete-after-tombstone');
    const current = await this.recoverySnapshot(marker.id), parent = this.store.safeDirectory();
    if (JSON.stringify(current.marker) !== JSON.stringify(marker)) throw Error('Conversation deletion authority changed. Preserve remaining writing.');
    for (const target of marker.targets) if (current.remaining.includes(target.name)) {
      const file = path.join(this.store.directory, target.name);
      await this.file(file, parent, target); this.store.safeDirectory(false, parent); await fs.unlink(file);
      await this.store.checkpoint('conversation-delete-after-unlink');
    }
    // Verify no unknown or changed target appeared while completing the exact manifest.
    const verifyComplete = async () => {
      const after = await this.recoverySnapshot(marker.id, parent);
      if (after.remaining.length || JSON.stringify(after.marker) !== JSON.stringify(marker)) throw Error('Conversation deletion targets or authority changed. Recovery remains blocked.');
    };
    await verifyComplete();
    const completed = await this.put({ ...marker, phase: 'deleted' }, marker, verifyComplete);
    this.store.unsaved.delete(marker.id); return { id: marker.id, generation: completed.generation };
  }
  async confirm(token, kind = 'deletion') {
    const reviewed = this.previews.get(token); if (!reviewed) throw Error('Review the intended local history action again.');
    if (Boolean(reviewed.restoration) !== (kind === 'restoration')) throw Error('The reviewed action belongs to another history workflow. Review the intended action again.');
    return this.store.lock(async () => {
      if (reviewed.restoration) {
        const current = await this.restorationSnapshot(reviewed.id);
        if (JSON.stringify(current) !== JSON.stringify(reviewed)) throw Error('Restoration publication state changed. Inspect its remaining owned payload again.');
        const result = await this.finishRestoration(current); this.previews.delete(token); return result;
      }
      if (reviewed.recovery) {
        const current = await this.recoverySnapshot(reviewed.id);
        if (JSON.stringify(current) !== JSON.stringify(reviewed)) throw Error('Deletion recovery manifest changed. Inspect it again; remaining writing was preserved.');
        const result = await this.finish(current.marker); this.previews.delete(token); return result;
      }
      const current = await this.inventory(reviewed.id);
      if (JSON.stringify(current) !== JSON.stringify(reviewed)) throw Error('Conversation or pending ownership changed. Preview deletion again; writing was preserved.');
      const scope = current.record.scope || { excludedSources: [], excludedHistory: current.record.requests.at(-1)?.package?.excludedHistory || [] };
      const marker = await this.put({ schema: 1, id: current.id, generation: randomUUID(), phase: 'deleting', scope: { excludedSources: [...scope.excludedSources], excludedHistory: [...scope.excludedHistory] }, targets: current.targets }, current.marker);
      const result = await this.finish(marker); this.previews.delete(token); return result;
    });
  }
}
module.exports = { ConversationControls };
