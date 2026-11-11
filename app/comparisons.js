const fs = require('node:fs/promises');
const local = require('node:fs');
const path = require('node:path');
const { createHash, randomUUID, randomInt } = require('node:crypto');
const { performance } = require('node:perf_hooks');
const { Briefs } = require('./briefs');
const { withBriefMutation } = require('./briefs-lock');
const { readExact, readExactSync, writeStage, verifyStageSync, verifyPeersSync } = require('./staged-publication');
const { fixtures, prompts } = require('./comparison-fixtures');
const rubric = require('./comparison-rubric');
const hash = text => createHash('sha256').update(text).digest('hex');
const uuid = value => typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(value);
const sameProof = (a, b) => a && b && a.dev === b.dev && a.ino === b.ino && a.digest === b.digest;
const historyChanged = () => Object.assign(Error('Comparison history changed or is unavailable. Existing history was not replaced. Preserve the retained text.'), { code: 'HISTORY_CONFLICT' });
function makePackage(brief, fixture, method) {
  // Fit labels are inspection metadata, never part of a model request.
  const source = { id: fixture.id, version: fixture.version, synthetic: true, passages: fixture.passages, limitations: fixture.limitations };
  const shared = JSON.stringify({ source, brief }, null, 2).replace(/\r\n?/g, '\n');
  const text = `Synthetic comparison input. Authored source material is not actual reel evidence.\n\n${shared}\n\n${prompts[method].text}`;
  return { text, digest: hash(text), sharedInputDigest: hash(shared), count: [...text].length, limit: 32000 };
}

// Main owns packages and the private display mapping. Listing never generates.
class Comparisons {
  constructor({ dataRoot, getVault, clock, checkpoint, provider, getEvidence }) {
    Object.assign(this, { dataRoot: path.resolve(dataRoot), getVault, clock, checkpoint, provider, getEvidence });
    this.tokens = new Map(); this.running = new Set(); this.unsaved = new Map(); this.durable = new Map();
    this.directory = path.join(this.dataRoot, 'comparisons');
    try { this.anchor(); } catch { /* Storage failure must not block capture startup. */ }
  }
  anchor() {
    if (this.rootIdentity) return;
    this.dataRoot = local.realpathSync(this.dataRoot);
    this.rootIdentity = local.statSync(this.dataRoot, { bigint: true });
    this.directory = path.join(this.dataRoot, 'comparisons');
  }
  safeDirectory(create = false, expected) {
    this.anchor();
    const same = (a, b) => a.dev === b.dev && a.ino === b.ino;
    const reject = () => { throw Error('Comparison directory is not an ordinary contained local history folder. Restore the folder before continuing.'); };
    const root = local.lstatSync(this.dataRoot, { bigint: true });
    if (!root.isDirectory() || root.isSymbolicLink() || !same(root, this.rootIdentity) || local.realpathSync(this.dataRoot) !== this.dataRoot) reject();
    if (create) { try { local.mkdirSync(this.directory); } catch (error) { if (error.code !== 'EEXIST') throw error; } }
    const directory = local.lstatSync(this.directory, { bigint: true });
    if (!directory.isDirectory() || directory.isSymbolicLink() || local.realpathSync(this.directory) !== this.directory || expected && !same(directory, expected)) reject();
    return directory;
  }
  async lock(work) {
    const directory = this.safeDirectory(true);
    return withBriefMutation(this.directory, () => { this.safeDirectory(false, directory); return work(); });
  }
  async read(id, forMutation = false) {
    if (this.unsaved.has(id)) return structuredClone(this.unsaved.get(id));
    return this.readStored(id, forMutation);
  }
  async readStored(id, forMutation = false, withProof = false) {
    if (!uuid(id)) throw Error('Comparison identity is invalid.');
    const directory = this.safeDirectory(), file = path.join(this.directory, `${id}.json`);
    const guard = () => this.safeDirectory(false, directory);
    let exact;
    try { exact = await readExact(file, guard); }
    catch (error) {
      if (error.code === 'STAGING_CHANGED') throw Error('Comparison is not an ordinary local history file or changed during the read.');
      throw error;
    }
    const { bytes, proof } = exact;
    const record = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    if (record.schema !== 1 || record.id !== id || !Array.isArray(record.fixtures) || record.fixtures.length !== 3 || !Array.isArray(record.slots) || record.slots.length !== 6 || !Array.isArray(record.displayOrder) || record.displayOrder.length !== 6 || new Set(record.displayOrder).size !== 6 || record.displayOrder.some(slotId => !record.slots.some(slot => slot.id === slotId)) || record.slots.some(slot => !uuid(slot.id) || !['direct', 'analogy'].includes(slot.method) || slot.package?.digest !== hash(slot.package.text))) throw Error('Comparison history needs repair. Preserve the file.');
    const pairs = record.slots.map(slot => `${slot.fixtureId}:${slot.method}`);
    if (new Set(pairs).size !== 6 || fixtures.some(fixture => ['direct', 'analogy'].some(method => !pairs.includes(`${fixture.id}:${method}`))) || record.slots.some(slot => !['pending', 'inProgress', 'completed', 'failed', 'interrupted'].includes(slot.status))) throw Error('Comparison outcome slots need repair. Preserve the file.');
    if (record.blindOrder !== undefined && (!Array.isArray(record.blindOrder) || record.blindOrder.length !== 6 || record.blindOrder.some(entry => !entry || !/^Sample [a-f0-9]{8}$/.test(entry.label) || !record.slots.some(slot => slot.id === entry.slotId)) || new Set(record.blindOrder.map(entry => entry.label)).size !== 6 || new Set(record.blindOrder.map(entry => entry.slotId)).size !== 6)) throw Error('Comparison blind mapping needs repair. Preserve the file; labels were not reassigned.');
    // Only an intentional fresh read under the mutation lock establishes a
    // writer baseline. Background reads must not bless another writer's bytes
    // for an already active request. Its own successful writes advance it.
    if (forMutation) this.durable.set(id, { directory, proof });
    return withProof ? { record, proof } : record;
  }
  async replace(stage, destination, staged, expected, guard) {
    const deadline = performance.now() + 1000;
    let delay = 15, refusal;
    while (true) {
      if (refusal && performance.now() >= deadline) throw refusal;
      try { readExactSync(destination, guard, 1, expected); }
      catch (error) {
        if (['ENOENT', 'STAGING_CHANGED'].includes(error.code)) throw historyChanged();
        throw error;
      }
      verifyStageSync(stage, guard, staged);
      try { local.renameSync(stage, destination); return; }
      catch (error) {
        const remaining = deadline - performance.now();
        if (process.platform !== 'win32' || error.syscall !== 'rename' || !['EPERM', 'EBUSY', 'EACCES'].includes(error.code) || remaining <= 0) throw error;
        refusal = error;
        await this.checkpoint('comparison-after-rename-refusal');
        await new Promise(resolve => setTimeout(resolve, Math.min(delay, remaining)));
        delay = Math.min(delay * 2, 100);
      }
    }
  }
  async write(record, create = false) {
    const expected = this.durable.get(record.id);
    if (!create && !expected) throw historyChanged();
    const directory = this.safeDirectory(false, create ? undefined : expected.directory);
    const guard = () => this.safeDirectory(false, directory);
    await this.checkpoint('comparison-before-store');
    const stage = path.join(this.directory, `${randomUUID()}.pending`);
    const destination = path.join(this.directory, `${record.id}.json`);
    let staged, retired = false;
    try {
      staged = await writeStage(stage, JSON.stringify(record, null, 2), guard);
      if (create) {
        verifyStageSync(stage, guard, staged);
        local.linkSync(stage, destination);
        verifyPeersSync(stage, destination, guard, staged);
        local.unlinkSync(stage);
      } else await this.replace(stage, destination, staged, expected.proof, guard);
      retired = true;
      verifyStageSync(destination, guard, staged);
      this.durable.set(record.id, { directory, proof: staged });
    } finally {
      if (staged && !retired) {
        try {
          readExactSync(stage, guard, 1, staged);
          local.unlinkSync(stage);
        } catch { /* Preserve an unproved stage or parent and surface the original failure. */ }
      }
    }
  }
  view(record) {
    return {
      id: record.id, createdAt: record.createdAt, brief: { id: record.brief.id, version: record.brief.version, digest: record.brief.digest },
      fixtures: record.fixtures, notice: record.slots.some(slot => slot.status !== 'pending') ? record.notice.replace('No generation has run.', 'Every attempt is retained; no slot is rerolled.') : record.notice,
      storageWarning: record.storageWarning || null,
      slots: record.displayOrder.map((id, index) => {
        const slot = record.slots.find(slot => slot.id === id);
        return { displayId: `Output ${index + 1}`, status: slot.status, candidate: slot.candidate || null, error: slot.error || null, elapsedMs: slot.elapsedMs, elapsedBoundary: slot.elapsedBoundary || null, usage: slot.usage, usageEvidence: slot.usageEvidence || 'Usage unavailable: no turn has run.', wordCount: slot.candidate?.wordCount ?? null };
      })
    };
  }
  async list() {
    const vault = this.getVault(); if (!vault) return { comparisons: [] };
    const directory = this.safeDirectory(true), names = new Set([...await fs.readdir(this.directory), ...[...this.unsaved.keys()].map(id => `${id}.json`)]);
    this.safeDirectory(false, directory);
    const records = [];
    for (const name of names) if (name.endsWith('.json')) {
      let record = await this.read(name.slice(0, -5));
      if (!this.unsaved.has(record.id) && !this.running.has(record.id) && record.slots.some(slot => slot.status === 'inProgress')) record = await this.lock(async () => {
        const latest = await this.read(record.id, true);
        for (const slot of latest.slots) if (slot.status === 'inProgress') {
          Object.assign(slot, { status: 'interrupted', completedAt: this.clock().now, elapsedMs: null, error: 'Previous request interrupted. Duration is unavailable after restart. No request was replayed.' });
          this.selectCandidate(slot);
        }
        try { await this.write(latest); }
        catch { latest.storageWarning = 'Comparison storage failed. Retained text is unsaved and may not survive restart. Copy it before closing.'; this.unsaved.set(latest.id, structuredClone(latest)); }
        return latest;
      });
      if (record.vault.root === vault.root) records.push(record);
    }
    return { comparisons: records.sort((a, b) => b.createdAt.localeCompare(a.createdAt) || a.id.localeCompare(b.id)).map(record => this.view(record)) };
  }
  async create(input) {
    return this.lock(async () => {
      const vault = this.getVault(); if (!vault) throw Error('Choose a vault first.');
      const pin = await new Briefs(vault).pinned(input?.briefVersion);
      if (pin.issues.length) throw Error('MyTune brief inputs changed or are unavailable. Review and approve a current brief before creating a comparison.');
      const brief = { id: pin.id, version: pin.version, digest: pin.digest, snapshot: structuredClone(pin) };
      const slots = [];
      for (const fixture of fixtures) {
        for (const method of ['direct', 'analogy']) {
          const packet = makePackage(brief, fixture, method);
          if (packet.count > 32000) throw Error('Comparison package exceeds 32000 Unicode code points. Nothing was shortened. Review a smaller brief explicitly.');
          slots.push({ id: randomUUID(), fixtureId: fixture.id, method, status: 'pending', prompt: structuredClone(prompts[method]), package: packet, reply: '', usage: null, elapsedMs: null });
        }
      }
      const displayOrder = slots.map(slot => slot.id);
      for (let i = displayOrder.length - 1; i > 0; i--) { const j = randomInt(i + 1); [displayOrder[i], displayOrder[j]] = [displayOrder[j], displayOrder[i]]; }
      const record = { schema: 1, id: randomUUID(), createdAt: this.clock().now, vault: { root: vault.root }, brief, fixtures: structuredClone(fixtures), slots, displayOrder,
        notice: 'Synthetic exploratory comparison: three authored cases, six outcome slots. No generation has run. No equal consumption, statistical reliability or numerical release threshold is established.' };
      // Brief and selected input bytes must still be current at publication.
      if (JSON.stringify(await new Briefs(vault).pinned(pin.version)) !== JSON.stringify(pin) || this.getVault()?.root !== vault.root) throw Error('Approved brief or vault changed. Review it and create the comparison again.');
      await this.write(record, true); return this.view(record);
    });
  }
  async build(record, slot) {
    const vault = this.getVault();
    if (!vault || vault.root !== record.vault.root) throw Error('Comparison belongs to another vault.');
    if (this.unsaved.has(record.id)) throw Error('Comparison has unsaved output. Copy retained text and repair storage before continuing.');
    const brief = await new Briefs(vault).pinned(record.brief.version);
    if (JSON.stringify(brief) !== JSON.stringify(record.brief.snapshot) || brief.issues.length) throw Error('Pinned approved brief or its selected inputs changed or are unavailable. No request was sent.');
    if (JSON.stringify(record.fixtures) !== JSON.stringify(fixtures)) throw Error('Versioned comparison fixtures changed. Create and inspect a separate comparison.');
    const fixture = fixtures.find(item => item.id === slot.fixtureId);
    if (!fixture || JSON.stringify(slot.prompt) !== JSON.stringify(prompts[slot.method]) || JSON.stringify(slot.package) !== JSON.stringify(makePackage(record.brief, fixture, slot.method))) throw Error('Comparison package or prompt changed. No request was sent.');
    const evidence = await this.getEvidence(), capacity = evidence.capacity, settings = evidence.comparisonSettings;
    if (!evidence.dispatchEnabled || !capacity || !capacity.harnessAndOutputEvidence || !settings) throw Error('Comparison unavailable: independent model, settings, input capacity and harness/output evidence are required. Production readiness remains closed without proof.');
    const requested = { model: capacity.model, modelProvider: settings.modelProvider, reasoningEffort: settings.reasoningEffort, serviceTier: settings.serviceTier };
    const pin = { requested, capacity, settings, binding: evidence.binding, bindingEvidence: 'Random process-local evidence binding, not portable capacity or authentication proof.' };
    const count = [...slot.package.text].length, limit = Math.min(32000, capacity.maxCodePoints);
    if (count > limit) throw Error('Comparison package exceeds the verified context limit. Nothing was shortened or sent.');
    return { pin, package: slot.package, slotId: slot.id };
  }
  async preview(input) {
    return this.lock(async () => {
      const record = await this.read(input?.id, true), slotId = record.displayOrder[input?.displayIndex], slot = record.slots.find(item => item.id === slotId);
      if (!slot || slot.status !== 'pending') throw Error('This slot already has an attempt or is unavailable. It cannot be rerolled.');
      const snapshot = await this.build(record, slot);
      if (record.generationPin && JSON.stringify(record.generationPin) !== JSON.stringify(snapshot.pin) && record.slots.some(item => item.status !== 'pending')) throw Error('Evidence changed or the process restarted. This run cannot establish matched conditions. Preserve it and create a separate comparison.');
      if (JSON.stringify(record.generationPin) !== JSON.stringify(snapshot.pin)) { record.generationPin = snapshot.pin; await this.write(record); }
      const packageId = randomUUID();
      if (this.tokens.size >= 64) this.tokens.delete(this.tokens.keys().next().value);
      this.tokens.set(packageId, { id: record.id, snapshot });
      return { packageId, text: slot.package.text, count: slot.package.count, requested: snapshot.pin.requested, evidence: snapshot.pin, notice: 'Review the exact synthetic package. One explicit send consumes this slot; failure or restart never rerolls it.' };
    });
  }
  selectCandidate(slot) {
    const finals = (slot.messages || []).filter(message => message.phase === 'final_answer' && message.completed);
    const authoritative = slot.status === 'completed' && finals.length === 1;
    const text = authoritative ? finals[0].text : slot.reply;
    const wordCount = text.trim() ? text.trim().split(/\s+/u).length : 0;
    slot.candidate = { text, wordCount, overRequestedLimit: wordCount > 600,
      warning: authoritative ? null : 'A single authoritative completed final answer is unavailable or ambiguous. Full actual output is retained; it may be partial or include commentary.' };
  }
  async send(input) {
    const approved = this.tokens.get(input?.packageId); this.tokens.delete(input?.packageId);
    if (!approved) throw Error('Preview the comparison slot again before sending.');
    return this.lock(async () => {
      const record = await this.read(approved.id, true), slot = record.slots.find(item => item.id === approved.snapshot.slotId);
      if (!slot || slot.status !== 'pending' || JSON.stringify(record.generationPin) !== JSON.stringify(approved.snapshot.pin) || JSON.stringify(await this.build(record, slot)) !== JSON.stringify(approved.snapshot)) throw Error('Comparison conditions changed. Review the current package again.');
      Object.assign(slot, { status: 'inProgress', startedAt: this.clock().now, completedAt: null, requested: approved.snapshot.pin.requested, effective: null, messages: [], usage: null, usageEvidence: 'Usage unavailable: no valid matching provider update was observed.', elapsedMs: null, elapsedBoundary: 'Monotonic local elapsed time from before preflight to provider terminal handling, including intermediate persistence; excludes initial intent and final publication, not pure generation time.' });
      this.running.add(record.id);
      try { await this.write(record); }
      catch (error) { this.running.delete(record.id); throw error; }
      const started = performance.now();
      try {
        await this.provider.preflight(); await this.checkpoint('comparison-before-dispatch');
        const revalidate = async () => {
          if (JSON.stringify(await this.build(record, slot)) !== JSON.stringify(approved.snapshot)) throw Error('Comparison context, settings or proof changed before dispatch. No request was sent.');
        };
        await revalidate();
        const result = await this.provider.turn(slot.package.text, { comparisonPin: slot.requested, capacityBinding: approved.snapshot.pin.binding,
          beforeStart: async () => { await this.checkpoint('comparison-before-turn-start'); await revalidate(); },
          onState: async snapshot => { Object.assign(slot, snapshot); await this.write(record); }
        });
        Object.assign(slot, result, { status: 'completed' });
      } catch (error) { slot.status = error.terminalStatus || 'failed'; slot.error = error.message; }
      slot.completedAt = this.clock().now; slot.elapsedMs = performance.now() - started; this.selectCandidate(slot);
      try { await this.write(record); }
      catch {
        slot.status = 'interrupted'; this.selectCandidate(slot);
        record.storageWarning = 'Comparison storage failed. Retained text is incomplete and unsaved and may not survive restart. Copy it before closing. No request will be replayed.';
        this.unsaved.set(record.id, structuredClone(record));
      } finally { this.running.delete(record.id); }
      return this.view(record);
    });
  }
  async preserve(input) {
    const retained = this.unsaved.get(input?.id);
    if (!retained) throw Error('There is no unsaved comparison output to save. Refresh the view.');
    try {
      return await this.lock(async () => {
        if (retained.vault.root !== this.getVault()?.root) throw Object.assign(Error(), { code: 'HISTORY_CONFLICT' });
        let stored;
        try { stored = await this.readStored(retained.id, false, true); }
        catch { throw Object.assign(Error(), { code: 'HISTORY_CONFLICT' }); }
        const expected = this.durable.get(retained.id);
        if (!sameProof(stored.proof, expected?.proof)) throw historyChanged();
        const record = structuredClone(retained); delete record.storageWarning;
        // This publication uses the exact last-owned durable baseline. It does
        // not establish a new baseline from the observed conflicting file.
        await this.write(record); this.unsaved.delete(record.id);
        return this.view(record);
      });
    } catch (error) {
      retained.storageWarning = error.code === 'HISTORY_CONFLICT'
        ? 'Local comparison history changed or is unavailable. Retained output is still unsaved and may not survive restart. Restore the exact last durable file or copy the retained output before closing; existing history was not replaced.'
        : 'Local comparison could not be saved. Retained output is still unsaved and may not survive restart. Repair storage and save again, or copy the output before closing.';
      throw Error(retained.storageWarning);
    }
  }
  scoreProjection(record) {
    return { id: record.id, rubric, storageWarning: record.storageWarning || null, canReveal: this.completeFeedback(record), revealedAt: record.revealedAt || null,
      notice: `Blind labels and order are stable. Output wording may suggest a method; blinding does not guarantee secrecy. Review every outcome, including generation failures. Three authored cases do not establish statistical reliability or equal consumption.${record.revealedAt ? ' Methods were already revealed; subsequent judgments are not blinded.' : ''}`,
      outputs: record.blindOrder.map((entry, index) => {
        const slot = record.slots.find(item => item.id === entry.slotId);
        const candidateDigest = hash(JSON.stringify({ status: slot.status, candidate: slot.candidate || null, error: slot.error || null }));
        return { displayIndex: index, displayId: entry.label, status: slot.status, candidate: slot.candidate || null, candidateDigest, error: slot.error || null, rating: slot.rating || null };
      }) };
  }
  completeFeedback(record) {
    return !record.storageWarning && record.slots.every(slot => {
      const rating = slot.rating;
      return ['completed', 'failed', 'interrupted'].includes(slot.status) && slot.candidate && rating && rubric.dimensions.every(dimension => Number.isSafeInteger(rating[dimension.key]) && rating[dimension.key] >= 1 && rating[dimension.key] <= 5) && typeof rating.reason === 'string' && !!rating.reason.trim() && typeof rating.materialError === 'boolean' && rating.rubricVersion === rubric.version && rating.candidateDigest === hash(JSON.stringify({ status: slot.status, candidate: slot.candidate, error: slot.error || null }));
    });
  }
  async scoreView(input) {
    return this.lock(async () => {
      const record = await this.read(input?.id, true);
      if (record.vault.root !== this.getVault()?.root) throw Error('Comparison belongs to another vault.');
      if (record.slots.some(slot => slot.status === 'pending' || slot.status === 'inProgress')) throw Error('Complete all six explicit attempts before blind scoring. Retained failures remain eligible.');
      if (!record.blindOrder) {
        if (this.unsaved.has(record.id)) throw Error('Repair unsaved comparison storage before assigning persistent blind labels.');
        // Independent post-generation shuffle. Never reuse the known preview
        // order or aliases, even if the permutations happen to coincide.
        const order = record.slots.map(slot => slot.id), labels = new Set();
        for (let i = order.length - 1; i > 0; i--) { const j = randomInt(i + 1); [order[i], order[j]] = [order[j], order[i]]; }
        record.blindOrder = order.map(slotId => {
          let label;
          do { label = `Sample ${randomUUID().slice(0, 8)}`; } while (labels.has(label));
          labels.add(label); return { label, slotId };
        });
        await this.write(record);
      }
      return this.scoreProjection(record);
    });
  }
  async rate(input) {
    const fields = rubric.dimensions.map(dimension => dimension.key), rating = input?.rating;
    if (!rating || Object.keys(rating).sort().join(',') !== [...fields, 'reason', 'materialError'].sort().join(',') || fields.some(key => !Number.isSafeInteger(rating[key]) || rating[key] < 1 || rating[key] > 5) || typeof rating.reason !== 'string' || !rating.reason.trim() || rating.reason.length > 2000 || typeof rating.materialError !== 'boolean') throw Error('Enter four separate integer ratings from 1 to 5, a short reason and a material-error choice.');
    return this.lock(async () => {
      const record = await this.read(input.id, true);
      if (record.vault.root !== this.getVault()?.root || this.unsaved.has(record.id)) throw Error('Comparison belongs to another vault or has unsaved output. Repair storage before saving feedback.');
      const entry = record.blindOrder?.find(item => item.label === input.displayId), slot = record.slots.find(item => item.id === entry?.slotId);
      if (!slot || !['completed', 'failed', 'interrupted'].includes(slot.status) || !slot.candidate) throw Error('An attempted terminal outcome is required before rating. A pending slot is not an abstention.');
      const projection = this.scoreProjection(record).outputs.find(item => item.displayId === input.displayId);
      if (projection.candidateDigest !== input.candidateDigest) throw Error('Retained output changed. Inspect it again before saving feedback.');
      const values = { ...rating, reason: rating.reason.trim() };
      if (slot.rating && fields.concat('reason', 'materialError').every(key => slot.rating[key] === values[key]) && slot.rating.candidateDigest === input.candidateDigest) return this.scoreProjection(record);
      if ((slot.rating?.revision || null) !== input.expectedRevision) throw Error('Feedback changed in another view. Inspect the current feedback before confirming an update.');
      slot.rating = { ...values, rubricVersion: rubric.version, candidateDigest: input.candidateDigest, revision: randomUUID(), savedAt: this.clock().now };
      await this.write(record); return this.scoreProjection(record);
    });
  }
  async reveal(input) {
    return this.lock(async () => {
      const record = await this.read(input?.id, true);
      if (record.vault.root !== this.getVault()?.root || this.unsaved.has(record.id)) throw Error('Comparison belongs to another vault or has unsaved output.');
      if (!record.blindOrder || !this.completeFeedback(record)) throw Error('All six outcomes require complete feedback bound to their retained candidates before method reveal.');
      if (!record.revealedAt) { record.revealedAt = this.clock().now; await this.write(record); }
      // Explicit disclosure returns only known comparison-owned fields. No
      // setup certificate, account data or private proof object is stored here.
      return { id: record.id, revealedAt: record.revealedAt,
        notice: 'No equal consumption, statistical reliability or numerical release threshold is established. These are authored synthetic cases and controlled outputs where labeled. Inspect every result and generation-effort difference independently. Revealed methods make subsequent judgments unblinded.',
        brief: record.brief, capacity: record.generationPin?.capacity || null, settingsEvidence: record.generationPin?.settings || null,
        outputs: record.blindOrder.map(entry => {
          const slot = record.slots.find(item => item.id === entry.slotId);
          return { label: entry.label, method: slot.method, fixture: record.fixtures.find(fixture => fixture.id === slot.fixtureId), prompt: slot.prompt, package: slot.package, status: slot.status,
            reply: slot.reply, messages: slot.messages || [], candidate: slot.candidate, requested: slot.requested || null, effective: slot.effective || null, evidence: slot.evidence || 'Provider evidence unavailable: no response metadata retained.',
            error: slot.error || null, elapsedMs: slot.elapsedMs, elapsedBoundary: slot.elapsedBoundary || null, usage: slot.usage, usageEvidence: slot.usageEvidence, rating: slot.rating };
        }) };
    });
  }
}
function installComparisons({ ipcMain, ...options }) {
  const store = new Comparisons(options);
  ipcMain.handle('comparison-list', () => store.list());
  ipcMain.handle('comparison-create', (_, input) => store.create(input));
  ipcMain.handle('comparison-preview', (_, input) => store.preview(input));
  ipcMain.handle('comparison-send', (_, input) => store.send(input));
  ipcMain.handle('comparison-preserve', (_, input) => store.preserve(input));
  ipcMain.handle('comparison-score-view', (_, input) => store.scoreView(input));
  ipcMain.handle('comparison-rate', (_, input) => store.rate(input));
  ipcMain.handle('comparison-reveal', (_, input) => store.reveal(input));
  return store;
}
module.exports = { installComparisons };
