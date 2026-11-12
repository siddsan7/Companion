const fs = require('node:fs/promises');
const local = require('node:fs');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
const { performance } = require('node:perf_hooks');
const { setTimeout: wait } = require('node:timers/promises');
const { conversation, validRemovedRequests, requestRemovalStageName, canonicalRequestRemovalStage } = require('./archive-format');
const { readExactSync, writeStage, validProof, verifyStage, verifyStageSync, verifyAbsentSync, removeLinkedStage, publishReplacement, firstPublicationSuffix, initialPublicationPending } = require('./staged-publication');
const hash = text => createHash('sha256').update(text).digest('hex');
const uuid = value => typeof value === 'string' && /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(value);
const same = (a, b) => a.dev === b.dev && a.ino === b.ino;
const fields = (value, allowed) => value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).every(key => allowed.includes(key));
const rawProof = ({ owned, rawDigest }) => ({ dev: owned.dev, ino: owned.ino, digest: rawDigest });
const pendingName = name => uuid(name.slice(0, -'.pending'.length));
const deletionChanged = () => Error('Conversation deletion targets or authority changed. Recovery remains blocked.');
const requestChanged = () => Error('Stored request removal changed or is awaiting exact recovery. Preserve local writing and review again.');
const storedScope = record => record.scope || { version: null, excludedSources: [], excludedHistory: record.requests.at(-1)?.package?.excludedHistory || [] };
const scopeFloor = scope => ({ excludedSources: scope.excludedSources, excludedHistory: scope.excludedHistory });
const removalRecord = (record, requestId) => ({ ...record, scope: storedScope(record), requests: record.requests.filter(item => item.id !== requestId), removedRequests: [...(record.removedRequests || []), requestId] });
const requestProof = value => validProof(value) && fields(value, ['dev', 'ino', 'digest']);

function pendingRecord(text) {
  try { return conversation(JSON.parse(text)); }
  catch { throw Error('Unknown or damaged pending history remains preserved; deletion recovery is blocked.'); }
}

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
      const { rawSha256, ...expectedOwned } = expected || {};
      const rawDigest = exactBytes || rawSha256 !== undefined ? hash(bytes) : undefined;
      if (expected && (JSON.stringify(owned) !== JSON.stringify(expectedOwned) || rawSha256 !== undefined && rawDigest !== rawSha256)) {
        throw Error('Conversation deletion target changed. Preserve it and preview again.');
      }
      return { text, stat: after, owned, rawDigest };
    } finally { await handle.close(); }
  }
  async deletionFile(file, parent, target) {
    // Old manifests hashed decoded text. Only delete when those bytes also
    // match the raw file, since the old proof cannot distinguish a BOM edit.
    const expected = target && { ...target, rawSha256: target.rawSha256 ?? target.sha256 };
    const exact = await this.file(file, parent, expected, 1, false, true);
    return { ...exact, owned: { ...exact.owned, rawSha256: exact.rawDigest } };
  }
  validate(value, id) {
    const fail = () => { throw Error('Conversation control is unknown or corrupt. Preserve all writing; ordinary history access is blocked.'); };
    if (!fields(value, ['schema', 'id', 'generation', 'phase', 'scope', 'targets', 'publication', 'restoration', 'removedRequests', 'requestRemoval']) || value.schema !== 1 || value.id !== id || !uuid(id) || !uuid(value.publication) || !['deleting', 'deleted', 'restoring', 'active'].includes(value.phase)) fail();
    if (value.removedRequests !== undefined && !validRemovedRequests(value.removedRequests)) fail();
    if (!uuid(value.generation) && !(value.generation === null && value.phase === 'active' && value.removedRequests?.length)) fail();
    const removal = value.requestRemoval;
    if (removal !== undefined && (value.phase !== 'active' || !fields(removal, ['requestId', 'before', 'stage', 'control', 'priorControl', 'copies']) || !value.removedRequests?.includes(removal.requestId) ||
      !requestProof(removal.before) || !fields(removal.stage, ['name', 'proof']) || !canonicalRequestRemovalStage(removal.stage.name) || !requestProof(removal.stage.proof) ||
      !Array.isArray(removal.copies) || removal.copies.some(copy => !fields(copy, ['name', 'proof']) || !canonicalRequestRemovalStage(copy.name) || copy.name === removal.stage.name || !requestProof(copy.proof)) ||
      new Set(removal.copies.map(copy => copy.name)).size !== removal.copies.length ||
      !fields(removal.control, ['dev', 'ino']) || ![removal.control.dev, removal.control.ino].every(part => typeof part === 'string' && /^[0-9]+$/.test(part)) ||
      removal.priorControl !== null && !requestProof(removal.priorControl))) fail();
    if (value.restoration !== undefined && (!fields(value.restoration, ['archiveId', 'recordDigest']) || !uuid(value.restoration.archiveId) || typeof value.restoration.recordDigest !== 'string' || !/^[a-f0-9]{64}$/.test(value.restoration.recordDigest))) fail();
    if (value.phase === 'restoring' && !value.restoration) fail();
    if (!fields(value.scope, ['excludedSources', 'excludedHistory']) || !Array.isArray(value.scope.excludedSources) || value.scope.excludedSources.some(key => typeof key !== 'string') || !Array.isArray(value.scope.excludedHistory) || value.scope.excludedHistory.some(key => !uuid(key)) || !Array.isArray(value.targets)) fail();
    const names = new Set(), deletion = ['deleting', 'deleted'].includes(value.phase);
    for (const target of value.targets) {
      if (!fields(target, ['name', 'sha256', 'dev', 'ino', 'bytes', 'rawSha256']) || typeof target.name !== 'string' ||
          !(/^[a-f0-9-]{36}\.(json|pending)$/.test(target.name) && uuid(target.name.split('.')[0]) || deletion && canonicalRequestRemovalStage(target.name)) ||
          names.has(target.name) || typeof target.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(target.sha256) || typeof target.dev !== 'string' || typeof target.ino !== 'string' || !Number.isSafeInteger(target.bytes) || target.bytes < 0) fail();
      if (Object.hasOwn(target, 'rawSha256') && (!deletion || typeof target.rawSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(target.rawSha256))) fail();
      names.add(target.name);
      if (target.name.endsWith('.json') && target.name !== `${id}.json`) fail();
    }
    if (deletion && !names.has(`${id}.json`)) fail();
    if (value.phase === 'restoring') {
      const stage = value.targets.find(target => target.name.endsWith('.pending')), destination = value.targets.find(target => target.name === `${id}.json`);
      if (value.targets.length !== 2 || !stage || !destination || stage.sha256 !== value.restoration.recordDigest || ['sha256', 'dev', 'ino', 'bytes'].some(key => stage[key] !== destination[key])) fail();
    }
    return value;
  }
  checkedFile(data, id) {
    const marker = JSON.parse(data.text);
    this.validate(marker, id || marker.id);
    const control = marker.requestRemoval?.control;
    if (control && (control.dev !== data.owned.dev || control.ino !== data.owned.ino)) throw requestChanged();
    return marker;
  }
  async state(id, reviewedPublication) {
    if (!uuid(id)) throw Error('Conversation identity is invalid.');
    const directory = this.guard(); if (!directory) return null;
    const file = path.join(directory.directory, `${id}.json`);
    let marker;
    try {
      const stat = await fs.lstat(file);
      if (![1, 2].includes(stat.nlink)) throw Error('Conversation control has unknown linked peers.');
      const data = await this.file(file, directory, null, stat.nlink, true);
      marker = this.checkedFile(data, id);
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
        this.checkedFile(other, otherId); continue;
      }
      if (!/^[a-f0-9-]{36}\.pending$/.test(name)) throw Error('Unknown conversation control file remains preserved; access is blocked.');
      const stat = await fs.lstat(path.join(directory.directory, name));
      if (![1, 2].includes(stat.nlink)) throw Error('Conversation control stage has unknown linked peers.');
      const stage = await this.file(path.join(directory.directory, name), directory, null, stat.nlink, true);
      const candidate = this.checkedFile(stage);
      if (name !== `${candidate.publication}.pending` || stat.nlink !== 1 && !(marker && candidate.publication === marker.publication && stat.nlink === 2)) throw Error('Unknown conversation control stage remains preserved; access is blocked.');
      if (!marker && candidate.id === id && candidate.publication !== reviewedPublication) throw Error('An unpublished conversation control requires explicit recovery. History remains preserved and blocked.');
    }
    return marker || null;
  }
  async check(record) {
    const removed = record.removedRequests;
    if (removed !== undefined && (!validRemovedRequests(removed) || record.requests.some(request => removed.includes(request.id)))) throw Error('Removed request authority is invalid. Preserve local history for repair.');
    const marker = await this.state(record.id);
    if (!marker) { if (record.generation !== undefined && record.generation !== null) throw Error('Conversation generation has no local authority. Explicit restoration is required.'); return; }
    const matchesGeneration = (record.generation ?? null) === marker.generation;
    if (marker.requestRemoval && (!matchesGeneration || marker.removedRequests.some(id => !removed?.includes(id)))) {
      throw Object.assign(Error('Stored request removal is awaiting exact recovery. Review the pending removal.'), { code: 'REQUEST_REMOVAL_PENDING' });
    }
    if (marker.phase !== 'active' || !matchesGeneration) throw Error('Conversation was deleted or its generation changed. Stale history cannot be saved or sent.');
    if (marker.removedRequests?.some(id => !removed?.includes(id))) throw Error('Previously removed requests remain unavailable. Preserve local history for repair.');
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
        const file = await this.file(path.join(directory.directory, name), directory, null, stat.nlink, true), value = this.checkedFile(file);
        if (name !== `${value.publication}.pending`) throw Error('Unknown control stage remains preserved.');
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
    const { requestRemoval, ...authority } = marker;
    await this.put({ ...authority, scope: floor }, marker);
  }
  async commitScope(record) {
    const marker = await this.state(record.id); if (!marker) return;
    await this.check(record);
    const scope = { excludedSources: [...record.scope.excludedSources], excludedHistory: [...record.scope.excludedHistory] };
    if (JSON.stringify(scope) === JSON.stringify(marker.scope)) return;
    await this.settlePublication(marker);
    const { requestRemoval, ...authority } = marker;
    await this.put({ ...authority, scope }, marker);
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
      try { local.renameSync(stage, file); }
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
      verifyStageSync(file, guard, staged);
      return;
    }
  }
  async put(marker, baseline, revalidate, assertSelection = () => {}, publication) {
    assertSelection();
    const directory = this.guard(true), file = path.join(directory.directory, `${marker.id}.json`);
    const value = { ...marker, publication: randomUUID() }, stage = path.join(directory.directory, `${value.publication}.pending`);
    const guard = () => {
      this.store.safeDirectory(false, directory.parent);
      this.guard(false, directory.stat);
    };
    const prior = marker.requestRemoval && baseline ? await this.file(file, directory, null, 1, true, true) : null;
    if (prior && JSON.stringify(this.checkedFile(prior, marker.id)) !== JSON.stringify(baseline)) throw requestChanged();
    const staged = await writeStage(stage, control => {
      if (marker.requestRemoval) value.requestRemoval = { ...marker.requestRemoval, control, priorControl: prior ? rawProof(prior) : null };
      this.validate(value, value.id);
      return JSON.stringify(value, null, 2);
    }, guard);
    if (marker.requestRemoval) await this.store.checkpoint('conversation-request-removal-before-control-publication');
    if (baseline) {
      const current = await this.file(file, directory, null, 1, true, true);
      if (JSON.stringify(JSON.parse(current.text)) !== JSON.stringify(baseline)) throw Error('Conversation authority changed. Preserve the control stage for review.');
      if (prior && JSON.stringify(rawProof(prior)) !== JSON.stringify(rawProof(current))) throw requestChanged();
      await this.replace(stage, file, guard, staged, rawProof(current), revalidate, assertSelection);
    } else {
      assertSelection();
      verifyStageSync(stage, guard, staged);
      local.linkSync(stage, file);
      await removeLinkedStage(stage, file, guard, staged, assertSelection);
    }
    if (publication?.check) await publication.check();
    verifyStageSync(file, guard, staged);
    this.known.add(marker.id);
    publication?.commit();
    return value;
  }
  async inventory(id, parent = this.store.safeDirectory(), ignoredStage, check, reviewedPublication, selectedRequest = false) {
    if (this.store.unsaved.has(id) || this.store.running.has(id)) throw Error('Preserve the unsaved reply or finish the active request before deleting this conversation.');
    const { record, proof } = await this.store.readStored(id, true, parent, check);
    if (record.vault.root !== this.store.getVault()?.root) throw Error('Conversation belongs to another vault.');
    const target = await this.deletionFile(path.join(this.store.directory, `${id}.json`), parent);
    const targets = [target.owned], pending = [];
    for (const name of await fs.readdir(this.store.directory)) {
      const requestStage = requestRemovalStageName(name);
      if (name === ignoredStage || (requestStage ? selectedRequest : !name.endsWith('.pending'))) continue;
      if (!requestStage && !pendingName(name)) throw Error('Unknown pending history requires separate inspection before deletion.');
      const staged = await this.deletionFile(path.join(this.store.directory, name), parent);
      let candidate; try { candidate = JSON.parse(staged.text); } catch { throw Error('Unknown pending history remains preserved; deletion is blocked.'); }
      try { conversation(candidate); }
      catch { throw Error('Unknown or damaged pending history remains preserved; deletion is blocked.'); }
      if (candidate.id === id) {
        if (candidate.vault.root !== record.vault.root || requestStage && !canonicalRequestRemovalStage(name)) throw Error('Pending history ownership or spelling is ambiguous. Preserve it before deletion.');
        targets.push(staged.owned); pending.push({ name, text: staged.text });
      }
    }
    return { id, marker: await this.state(id, reviewedPublication), record, proof, targets: targets.sort((a, b) => a.name.localeCompare(b.name)), pending };
  }
  async preview(id) {
    return this.store.lock(async () => {
      const snapshot = await this.inventory(id), token = randomUUID();
      if (this.previews.size >= 32) this.previews.delete(this.previews.keys().next().value);
      this.previews.set(token, snapshot);
      return { token, id, requestCount: snapshot.record.requests.length, targets: snapshot.targets.map(target => target.name), pending: snapshot.pending };
    });
  }
  pendingHistoryProof(parent, ignoredStage, copiedNames = new Set()) {
    const guard = () => this.store.safeDirectory(false, parent);
    guard();
    const names = local.readdirSync(this.store.directory).filter(name => name !== ignoredStage && !copiedNames.has(name) && (name.endsWith('.pending') || name.endsWith(firstPublicationSuffix) || requestRemovalStageName(name))).sort();
    return names.map(name => [name, readExactSync(path.join(this.store.directory, name), guard).proof]);
  }
  requestCopies(record, requestId, observations, parent, marker) {
    const copies = [], expected = new Map((marker?.requestRemoval.copies || []).map(copy => [copy.name, copy.proof]));
    const current = new Map(record.requests.map(item => [item.id, JSON.stringify(item)]));
    const replacement = Buffer.from(JSON.stringify(removalRecord(record, requestId), null, 2));
    const guard = () => this.store.safeDirectory(false, parent);
    for (const [name, proof] of observations) {
      if (!requestRemovalStageName(name)) continue;
      const { bytes } = verifyStageSync(path.join(this.store.directory, name), guard, proof), text = bytes.toString('utf8');
      const recorded = expected.get(name);
      if (recorded && JSON.stringify(recorded) !== JSON.stringify(proof)) throw requestChanged();
      let candidate;
      try { candidate = conversation(JSON.parse(text)); }
      catch {
        if (recorded || text.includes(requestId)) throw Error(`Unrecognized request staging file ${name} may contain selected writing. Preserve it for separate review.`);
        continue;
      }
      const eligible = candidate.id === record.id && (bytes.equals(replacement) || candidate.requests.some(item => item.id === requestId));
      if (!eligible && !recorded) continue;
      if (!eligible || marker && !recorded || !canonicalRequestRemovalStage(name) || candidate.vault.root !== record.vault.root || candidate.requests.some(item => current.get(item.id) !== JSON.stringify(item))) {
        throw Error(`Request staging file ${name} contains selected writing or its replacement with unverified ownership. Preserve it for separate review.`);
      }
      copies.push({ name, proof, text });
    }
    return copies;
  }
  async requestSnapshot(id, requestId, parent, ignoredStage, marker, unpublished) {
    if (!uuid(id) || !uuid(requestId)) throw Error('Choose a stored request to review for local removal.');
    const observations = this.pendingHistoryProof(parent, ignoredStage);
    const check = marker && ((record, proof) => {
      if (marker.phase !== 'active' || marker.requestRemoval?.requestId !== requestId || JSON.stringify(marker.requestRemoval.before) !== JSON.stringify(proof) ||
          marker.removedRequests.some(id => id !== requestId && !record.removedRequests?.includes(id))) throw requestChanged();
    });
    const snapshot = await this.inventory(id, parent, ignoredStage, check || undefined, unpublished && marker.publication, true);
    const { record, proof } = snapshot;
    const reviewed = snapshot.targets.find(target => target.name === `${id}.json`);
    if (snapshot.pending.length) throw Error('Unresolved pending history belongs to this conversation. Preserve it for separate review before removing a request.');
    if (reviewed.dev !== proof.dev || reviewed.ino !== proof.ino || reviewed.rawSha256 !== proof.digest || marker && (JSON.stringify(unpublished ? unpublished.baseline : marker) !== JSON.stringify(snapshot.marker) ||
      marker.generation !== (record.generation ?? null) || JSON.stringify(marker.scope) !== JSON.stringify(scopeFloor(storedScope(record)))) || JSON.stringify(this.pendingHistoryProof(parent, ignoredStage)) !== JSON.stringify(observations)) throw requestChanged();
    conversation(record);
    if (record.requests.some(item => item.status === 'inProgress')) throw Error('Finish or recover the active request before removing stored history.');
    const request = record.requests.find(item => item.id === requestId);
    if (!request) throw Error('Selected request is unavailable. Inspect retained history again.');
    const copies = this.requestCopies(record, requestId, observations, parent, marker), copiedNames = new Set(copies.map(copy => copy.name));
    return { ...snapshot, pendingProof: observations.filter(([name]) => !copiedNames.has(name)), request, copies };
  }
  async unpublishedRequest(id, publication, parent) {
    if (!uuid(id) || !uuid(publication)) throw requestChanged();
    const directory = this.guard(), guard = () => { this.store.safeDirectory(false, parent); this.guard(false, directory.stat); };
    const stage = path.join(directory.directory, `${publication}.pending`), destination = path.join(directory.directory, `${id}.json`);
    const { bytes, proof } = readExactSync(stage, guard);
    const marker = this.checkedFile({ text: bytes.toString('utf8'), owned: proof }, id);
    if (marker.publication !== publication || !marker.requestRemoval || !bytes.equals(Buffer.from(JSON.stringify(marker, null, 2)))) throw requestChanged();
    const baseline = await this.state(id, publication), prior = marker.requestRemoval.priorControl;
    if (prior && baseline?.phase === 'active' && baseline.generation === marker.generation) verifyStageSync(destination, guard, prior);
    else if (!prior && !baseline) verifyAbsentSync(destination, guard, requestChanged);
    else throw requestChanged();
    verifyStageSync(stage, guard, proof);
    return { marker, baseline, proof };
  }
  async previewRequest(id, requestId, resume = false, publication) {
    return this.store.lock(async parent => {
      const vault = this.store.getVault();
      const unpublished = resume && publication ? await this.unpublishedRequest(id, publication, parent) : null;
      const marker = unpublished?.marker || (resume ? await this.state(id) : null);
      if (resume && !marker?.requestRemoval) throw requestChanged();
      if (resume) this.verifyRequestStage(marker, parent);
      const snapshot = await this.requestSnapshot(id, requestId, parent, marker?.requestRemoval.stage.name, marker, unpublished);
      if (vault !== this.store.getVault()) throw requestChanged();
      const token = randomUUID();
      if (this.previews.size >= 32) this.previews.delete(this.previews.keys().next().value);
      this.previews.set(token, { selectedRequest: true, vault, parent, snapshot, resume, unpublished });
      const retainedCopies = snapshot.record.requests.filter(item => item.id !== requestId && item.package.historyIds.includes(requestId)).map(item => item.id);
      return { token, id, request: snapshot.request, retainedCopies, copies: snapshot.copies.map(({ name, text }) => ({ name, text })), resume, unpublished: Boolean(unpublished) };
    });
  }
  async pendingRequests() {
    this.store.safeDirectory(true);
    const { markers, stages } = await this.authority(), records = [];
    for (const marker of markers) {
      if (!marker.requestRemoval) continue;
      const { id, requestRemoval: { requestId } } = marker;
      try { await this.store.readStored(id); }
      catch (error) {
        if (error.code === 'ENOENT') continue;
        try {
          const parent = this.store.safeDirectory();
          this.verifyRequestStage(marker, parent);
          await this.requestSnapshot(id, requestId, parent, marker.requestRemoval.stage.name, marker);
          records.push({ id, requestId, canResume: true });
        } catch (error) { records.push({ id, requestId, canResume: false, warning: error.message }); }
      }
    }
    const directory = this.guard();
    for (const stage of stages) {
      if (markers.some(marker => stage.name === `${marker.publication}.pending`)) continue;
      const data = await this.file(path.join(directory.directory, stage.name), directory, stage, 1, true);
      const candidate = this.checkedFile(data);
      if (!candidate.requestRemoval) continue;
      const { id, publication, requestRemoval: { requestId } } = candidate;
      try {
        const parent = this.store.safeDirectory();
        const unpublished = await this.unpublishedRequest(id, publication, parent);
        this.verifyRequestStage(candidate, parent);
        await this.requestSnapshot(id, requestId, parent, candidate.requestRemoval.stage.name, candidate, unpublished);
        records.push({ id, requestId, publication, canResume: true });
      } catch (error) { records.push({ id, requestId, publication, canResume: false, warning: error.message }); }
    }
    return records;
  }
  verifyRequestStage(marker, parent) {
    const { name, proof } = marker.requestRemoval.stage;
    verifyStageSync(path.join(this.store.directory, name), () => this.store.safeDirectory(false, parent), proof);
  }
  async removeRequest(reviewed, parent) {
    const { id, request, record, proof, pendingProof, marker: baseline, copies } = reviewed.snapshot;
    const file = path.join(this.store.directory, `${id}.json`), guard = () => this.store.safeDirectory(false, parent);
    let unpublished = reviewed.unpublished;
    let marker = unpublished?.marker || (reviewed.resume ? baseline : null);
    const copyTargets = marker?.requestRemoval.copies || copies.map(({ name, proof }) => ({ name, proof }));
    const copiedNames = new Set(copyTargets.map(copy => copy.name));
    const ownStage = marker?.requestRemoval.stage.name || `.request-removal-${randomUUID()}.tmp`;
    const stage = path.join(this.store.directory, ownStage);
    const verifySelection = () => {
      if (this.store.getVault() !== reviewed.vault || !same(parent, reviewed.parent) || this.store.unsaved.has(id) || this.store.running.has(id)) throw requestChanged();
      if (JSON.stringify(this.pendingHistoryProof(parent, ownStage, copiedNames)) !== JSON.stringify(pendingProof)) throw Error('Pending local history changed. Preserve it and review request removal again.');
    };
    const recheck = async () => {
      verifySelection();
      if (unpublished && JSON.stringify(await this.unpublishedRequest(id, marker.publication, parent)) !== JSON.stringify(unpublished)) throw requestChanged();
      const current = await this.requestSnapshot(id, request.id, parent, ownStage, marker, unpublished);
      if (JSON.stringify(current) !== JSON.stringify({ ...reviewed.snapshot, marker: unpublished ? baseline : marker || baseline, copies: marker ? current.copies : copies })) throw requestChanged();
      verifySelection();
    };
    await recheck();
    const scope = scopeFloor(storedScope(record));
    const generation = record.generation ?? null;
    const next = removalRecord(record, request.id), { removedRequests } = next;
    const nextText = JSON.stringify(next, null, 2);
    let staged = marker?.requestRemoval.stage.proof;
    const survivingCopies = () => copyTargets.filter(copy => {
      const file = path.join(this.store.directory, copy.name);
      guard();
      if (!local.lstatSync(file, { throwIfNoEntry: false })) return false;
      verifyStageSync(file, guard, copy.proof);
      return true;
    });
    const verifyBefore = () => { verifySelection(); survivingCopies(); verifyStageSync(file, guard, proof); if (staged) verifyStageSync(stage, guard, staged); };
    if (baseline) await this.settlePublication(baseline, verifyBefore);
    if (!marker) {
      staged = await writeStage(stage, nextText, guard);
      await this.store.checkpoint('conversation-request-removal-payload-staged');
      marker = await this.put({ schema: 1, id, phase: 'active', generation, scope, targets: [], removedRequests,
        requestRemoval: { requestId: request.id, before: proof, stage: { name: ownStage, proof: staged }, copies: copyTargets } }, baseline, recheck, verifyBefore);
      await this.store.checkpoint('conversation-request-removal-authorized');
    }
    if (staged.digest !== hash(nextText) || marker.generation !== generation || JSON.stringify(marker.scope) !== JSON.stringify(scope) || JSON.stringify(marker.removedRequests) !== JSON.stringify(removedRequests)) throw requestChanged();
    if (unpublished) {
      const directory = this.guard(), control = path.join(directory.directory, `${id}.json`), controlStage = path.join(directory.directory, `${marker.publication}.pending`);
      const controlGuard = () => { guard(); this.guard(false, directory.stat); };
      await recheck();
      if (baseline) {
        await this.replace(controlStage, control, controlGuard, unpublished.proof, marker.requestRemoval.priorControl, recheck, verifyBefore);
      } else {
        verifyBefore();
        verifyAbsentSync(control, controlGuard, requestChanged);
        verifyStageSync(controlStage, controlGuard, unpublished.proof);
        local.linkSync(controlStage, control);
        await removeLinkedStage(controlStage, control, controlGuard, unpublished.proof, verifyBefore);
      }
      this.known.add(id);
      unpublished = null;
      await this.store.checkpoint('conversation-request-removal-authorized');
    }
    const verifyMarker = await this.markerGuard(marker, guard, requestChanged);
    await recheck();
    verifyMarker();
    verifyStageSync(stage, guard, staged);
    for (const copy of survivingCopies()) {
      const copyFile = path.join(this.store.directory, copy.name);
      verifyMarker();
      verifyStageSync(stage, guard, staged);
      verifyStageSync(file, guard, proof);
      verifyStageSync(copyFile, guard, copy.proof);
      local.unlinkSync(copyFile);
    }
    if (copyTargets.length) await this.store.checkpoint('conversation-request-removal-copies-retired');
    const verifyCopiesAbsent = () => {
      for (const copy of copyTargets) verifyAbsentSync(path.join(this.store.directory, copy.name), guard, requestChanged);
    };
    await publishReplacement(stage, file, guard, staged, proof, {
      beforeAttempt: recheck, conflict: requestChanged,
      verifyRelated: () => { verifySelection(); verifyMarker(); verifyCopiesAbsent(); }
    });
    for (const [token, approved] of this.store.tokens) if (approved.input.conversationId === id) this.store.tokens.delete(token);
    return next;
  }
  cancel(token) { this.previews.delete(token); }
  async recoverySnapshot(id, expectedParent) {
    const marker = await this.state(id);
    if (!marker || marker.phase !== 'deleting') throw Error('There is no interrupted deletion to resume for this identity.');
    if (this.store.unsaved.has(id) || this.store.running.has(id)) throw Error('Preserve unsaved writing or finish the active request before deletion recovery.');
    const parent = this.store.safeDirectory(false, expectedParent), remaining = [];
    for (const target of marker.targets) {
      try { await this.deletionFile(path.join(this.store.directory, target.name), parent, target); remaining.push(target.name); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    // Newly arrived or damaged stages were never covered by the retained deletion consent.
    for (const name of await fs.readdir(this.store.directory)) if (name.endsWith('.pending') || requestRemovalStageName(name)) {
      if (!pendingName(name) && !requestRemovalStageName(name)) throw Error('Unknown pending history remains preserved; deletion recovery is blocked.');
      const staged = await this.file(path.join(this.store.directory, name), parent);
      const candidate = pendingRecord(staged.text);
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
    if (hash(text) !== marker.restoration.recordDigest || record.id !== id || record.generation !== marker.generation || record.vault.root !== this.store.getVault()?.root || JSON.stringify({ excludedSources: record.scope?.excludedSources, excludedHistory: record.scope?.excludedHistory }) !== JSON.stringify(marker.scope) || JSON.stringify(record.removedRequests) !== JSON.stringify(marker.removedRequests)) throw Error('Restoration ownership or retained exclusion authority changed. Preserve the payload for review.');
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
  async markerGuard(marker, guard, changed) {
    guard();
    const directory = this.guard(), control = path.join(directory.directory, `${marker.id}.json`);
    const saved = await this.file(control, directory, null, 1, true, true);
    if (JSON.stringify(JSON.parse(saved.text)) !== JSON.stringify(marker)) throw changed();
    const controlProof = rawProof(saved);
    const controlGuard = () => { guard(); this.guard(false, directory.stat); };
    return () => { verifyStageSync(control, controlGuard, controlProof); };
  }
  async restorationMarkerGuard(marker, guard) {
    return this.markerGuard(marker, guard, () => Error('Restoration authority changed. Preserve the exact payload for review.'));
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
  verifyDeletionComplete(marker, guard) {
    if (this.store.unsaved.has(marker.id) || this.store.running.has(marker.id)) throw deletionChanged();
    for (const target of marker.targets) {
      verifyAbsentSync(path.join(this.store.directory, target.name), guard, deletionChanged);
    }
    if (initialPublicationPending(path.join(this.store.directory, `${marker.id}.json`), guard)) throw deletionChanged();
    for (const name of local.readdirSync(this.store.directory)) if (name.endsWith('.pending') || requestRemovalStageName(name)) {
      if (!pendingName(name) && !requestRemovalStageName(name)) throw deletionChanged();
      const { bytes } = readExactSync(path.join(this.store.directory, name), guard);
      const candidate = pendingRecord(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
      if (candidate.id === marker.id) throw deletionChanged();
    }
    guard();
  }
  async finish(marker) {
    const parent = this.store.safeDirectory(), vaultRoot = this.store.getVault()?.root;
    const guard = () => {
      this.store.safeDirectory(false, parent);
      if (this.store.getVault()?.root !== vaultRoot) throw deletionChanged();
    };
    await this.settlePublication(marker, guard);
    const verifyMarker = await this.markerGuard(marker, guard, deletionChanged);
    this.store.tokens.clear();
    await this.store.checkpoint('conversation-delete-after-tombstone');
    const current = await this.recoverySnapshot(marker.id, parent);
    if (JSON.stringify(current.marker) !== JSON.stringify(marker)) throw deletionChanged();
    for (const target of marker.targets) if (current.remaining.includes(target.name)) {
      const file = path.join(this.store.directory, target.name);
      const exact = await this.deletionFile(file, parent, target);
      verifyMarker();
      verifyStageSync(file, guard, rawProof(exact));
      local.unlinkSync(file);
      await this.store.checkpoint('conversation-delete-after-unlink');
    }
    const verifyComplete = () => this.verifyDeletionComplete(marker, guard);
    const beforeReplace = () => { verifyMarker(); verifyComplete(); };
    const revalidate = async () => {
      const after = await this.recoverySnapshot(marker.id, parent);
      if (after.remaining.length || JSON.stringify(after.marker) !== JSON.stringify(marker)) throw deletionChanged();
    };
    await revalidate();
    const completed = await this.put({ ...marker, phase: 'deleted' }, marker, revalidate, beforeReplace, { commit: verifyComplete });
    this.store.unsaved.delete(marker.id); return { id: marker.id, generation: completed.generation };
  }
  async confirm(token, kind = 'deletion') {
    const reviewed = this.previews.get(token); if (!reviewed) throw Error('Review the intended local history action again.');
    const reviewedKind = reviewed.restoration ? 'restoration' : reviewed.selectedRequest ? 'request' : 'deletion';
    if (reviewedKind !== kind) throw Error('The reviewed action belongs to another history workflow. Review the intended action again.');
    return this.store.lock(async parent => {
      if (reviewed.selectedRequest) {
        const result = await this.removeRequest(reviewed, parent); this.previews.delete(token); return result;
      }
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
      const scope = scopeFloor(storedScope(current.record));
      const marker = await this.put({ schema: 1, id: current.id, generation: randomUUID(), phase: 'deleting', scope, targets: current.targets,
        ...(current.record.removedRequests ? { removedRequests: current.record.removedRequests } : {}) }, current.marker);
      const result = await this.finish(marker); this.previews.delete(token); return result;
    });
  }
}
module.exports = { ConversationControls };
