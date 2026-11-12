const fs = require('node:fs/promises');
const local = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { performance } = require('node:perf_hooks');
const { setTimeout: wait } = require('node:timers/promises');
const { Intake } = require('./intake');
const { intakeLock } = require('./intake-lock');
const { sourceMutation } = require('./source-mutation');
const { TaskScheduler } = require('./task-scheduler');
const { Vault } = require('./vault');
const { ordinaryDirectories, readExact, readExactSync, writeStage, verifyStage, verifyStageSync, validProof, verifyAbsentSync, removeStageIfPresentSync, publishReplacement, initialPublicationPending, recoverInitialPublication } = require('./staged-publication');
const DAY = 86400000;
const uuid = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/;
const stagingName = /^\.archive-reconnect-[a-f0-9-]{36}\.pending$|^schedule-[a-f0-9-]{36}\.tmp$/;
const scheduleChanged = () => Error('Daily intake settings changed. Existing files were preserved for inspection.');
const settingsChanged = () => Error('Current vault changed. Select it again before changing daily intake.');
const equalProof = (a, b) => a === b || a && b && a.dev === b.dev && a.ino === b.ino && a.digest === b.digest;
const samePath = (a, b) => process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
const noSelectionCheck = async () => {};
const sameCheck = (a, b) => !!a && !!b && a.at === b.at && a.trigger === b.trigger;
const scheduledRunning = worker => worker?.status === 'running' && typeof worker.at === 'string' && ['scheduled', 'catch-up'].includes(worker.trigger);

function retainWorkerResult(state, result) {
  state.worker = { ...result.lastCheck, finishedAt: new Date().toISOString() };
  if (result.lastCheck.status === 'complete') {
    state.lastSuccess = result.lastSuccess;
    delete state.workerError;
  } else {
    state.workerError = result.sources.find(x => x.error)?.error || 'Some imports are held. Inspect held imports and use Check now after repair.';
  }
}

async function optionalExact(file, guard) {
  try { return await readExact(file, guard); }
  catch (error) {
    if (error.code !== 'ENOENT') throw error;
    guard(); return null;
  }
}

function statIfPresent(file, guard) {
  guard();
  try { return local.lstatSync(file, { bigint: true }); }
  catch (error) {
    if (error.code !== 'ENOENT') throw error;
    guard(); return null;
  }
}

async function removeOwned(file, guard, proof, links = 1) {
  await verifyStage(file, guard, proof, links);
  verifyStageSync(file, guard, proof, links);
  local.unlinkSync(file);
}

class Schedule {
  constructor(file, vault, options = {}) {
    this.file = file;
    this.vault = vault;
    this.tasks = new TaskScheduler(options);
    this.assertSelected = options.assertSelected || noSelectionCheck;
  }
  directoryGuard() {
    return ordinaryDirectories([path.dirname(this.file)], 'Daily intake settings folder changed or is an alias. Files were preserved.').guard;
  }
  async snapshot(guard = this.directoryGuard()) {
    const file = await optionalExact(this.file, guard);
    if (!file) return null;
    let state;
    try { state = JSON.parse(file.bytes); }
    catch { throw Error('Daily intake settings are unreadable. Preserve them for repair.'); }
    if (!state || state.schema !== 1 || !uuid.test(state.id) || !Number.isFinite(Date.parse(state.anchor)) || typeof state.vault !== 'string' || !path.isAbsolute(state.vault) || typeof state.parent !== 'string' || !['enabled', 'paused', 'disabled'].includes(state.mode) || !Number.isInteger(state.handledSlot || 0) || (state.handledSlot || 0) < 0 || state.launchBinding !== undefined && state.launchBinding !== 1) throw Error('Unsupported daily intake settings. Preserve them for repair.');
    return { state, proof: file.proof };
  }
  async load() {
    const guard = this.directoryGuard();
    if (initialPublicationPending(this.file, guard) || statIfPresent(this.legacyReceipt, guard)) {
      return this.change(async locked => (await this.snapshot(locked))?.state || null);
    }
    return (await this.snapshot(guard))?.state || null;
  }
  async assertConfiguration(settingsPath) {
    const file = await optionalExact(settingsPath, this.directoryGuard());
    let selected;
    try {
      const settings = JSON.parse(file?.bytes);
      selected = new Vault(settings.vault, settings.parent);
    } catch { throw settingsChanged(); }
    if (!this.vault || !samePath(selected.root, this.vault.root)) throw settingsChanged();
  }
  get legacyReceipt() { return `${this.file}.initial-publication.json`; }
  async settleLegacyReceipt(guard) {
    const receipt = await optionalExact(this.legacyReceipt, guard);
    if (!receipt) return;
    let intent;
    try { intent = JSON.parse(receipt.bytes); } catch { throw scheduleChanged(); }
    if (!intent || intent.schema !== 1 || typeof intent.stage !== 'string' || !stagingName.test(intent.stage) || !validProof(intent.proof)) throw scheduleChanged();
    const stage = path.join(path.dirname(this.file), intent.stage);
    const receiptGuard = () => { verifyStageSync(this.legacyReceipt, guard, receipt.proof); };
    const destination = statIfPresent(this.file, receiptGuard);
    if (destination?.nlink === 2n) {
      const linked = () => { verifyStageSync(this.file, receiptGuard, intent.proof, 2); };
      await removeOwned(stage, linked, intent.proof, 2);
    } else if (!destination) {
      const unpublished = () => { this.requireCurrent(null, receiptGuard); };
      if (statIfPresent(stage, unpublished)) await removeOwned(stage, unpublished, intent.proof);
    }
    const settled = () => {
      this.requireCurrent(destination ? intent.proof : null, guard);
      if (statIfPresent(stage, guard)) throw scheduleChanged();
    };
    await removeOwned(this.legacyReceipt, settled, receipt.proof);
  }
  async change(work, { onBusy, duringIntake = false } = {}) {
    // The data directory can be the managed vault root. In that case an
    // admitted Intake check already owns this exact canonical native lock.
    const lock = duringIntake ? sourceMutation : intakeLock;
    let entered = false, delay = 25;
    for (;;) {
      try {
        return await lock(path.dirname(this.file), async () => {
          entered = true;
          const guard = this.directoryGuard();
          if (initialPublicationPending(this.file, guard)) {
            verifyAbsentSync(this.legacyReceipt, guard, scheduleChanged);
            recoverInitialPublication(this.file, guard, stagingName);
          } else await this.settleLegacyReceipt(guard);
          return work(guard);
        });
      } catch (error) {
        if (entered || error.code !== 'INTAKE_BUSY' || !onBusy) throw error;
        onBusy();
        await wait(delay);
        delay = Math.min(delay * 2, 250);
      }
    }
  }
  requireCurrent(expected, guard) {
    let current = null;
    try { current = readExactSync(this.file, guard).proof; }
    catch (error) {
      if (error.code !== 'ENOENT') throw error;
      guard();
    }
    if (!equalProof(current, expected)) throw scheduleChanged();
  }
  async save(state, expected, { guard = this.directoryGuard(), archive = false, assertSelected = noSelectionCheck, verifyRelated = () => {} } = {}) {
    const name = archive ? `.archive-reconnect-${randomUUID()}.pending` : `schedule-${randomUUID()}.tmp`;
    const stage = path.join(path.dirname(this.file), name);
    const proof = await writeStage(stage, JSON.stringify(state, null, 2), guard);
    const lastLook = () => {
      verifyStageSync(stage, guard, proof);
      this.requireCurrent(expected, guard);
      guard();
      verifyRelated();
    };
    try {
      if (!expected) {
        await publishReplacement(stage, this.file, guard, proof, null, {
          beforeAttempt: assertSelected,
          conflict: scheduleChanged,
          stageName: stagingName,
          verifyRelated: () => { verifyAbsentSync(this.legacyReceipt, guard, scheduleChanged); verifyRelated(); }
        });
      } else {
        const deadline = performance.now() + 1000;
        let delay = 15;
        for (;;) {
          await assertSelected();
          lastLook();
          try { local.renameSync(stage, this.file); break; }
          catch (error) {
            const remaining = deadline - performance.now();
            if (process.platform !== 'win32' || !['EPERM', 'EBUSY', 'EACCES'].includes(error.code) || remaining <= 0) throw error;
            await wait(Math.min(delay, remaining));
            delay = Math.min(delay * 2, 100);
          }
        }
        await verifyStage(this.file, guard, proof);
      }
    } finally {
      try {
        if (expected || !initialPublicationPending(this.file, guard)) removeStageIfPresentSync(stage, guard, proof);
      } catch { /* Preserve a stage whose ownership cannot be proved. */ }
    }
    verifyStageSync(this.file, guard, proof);
    return proof;
  }
  matches(state) { return !!(state && this.vault && samePath(path.resolve(state.vault, state.parent), path.resolve(this.vault.root))); }
  async requireDisabled(state) {
    if (state.mode !== 'disabled' || state.archiveReconnect?.status === 'pending') throw Error('Disable daily intake in its current vault before changing its vault.');
    if (await this.tasks.apply('inspect', state, this.file)) throw Error('The previous daily intake task still exists. Disable it in its original vault before continuing.');
  }
  async control(operation, now, view) {
    return this.change(async guard => {
      await this.assertSelected();
      const current = await this.snapshot(guard);
      if (view && (view.location !== this.vault?.root || view.scheduleId !== (current?.state.id || null))) throw Error('The displayed daily intake settings changed. Refresh the selected vault and try again.');
      let state = current?.state;
      if (state && !this.matches(state)) {
        if (operation !== 'enable' || !this.vault) throw Error('Daily intake belongs to another vault. Reconnect its original vault before changing the task.');
        await this.requireDisabled(state);
        state = null;
      }
      if (!state) {
        if (operation !== 'enable' || !this.vault) throw Error('Choose a vault and enable daily intake first.');
        const intake = await new Intake(this.vault).info();
        if (!intake.sources.length) throw Error('Connect a draft source before enabling daily intake.');
        state = { schema: 1, id: randomUUID(), launchBinding: 1, anchor: new Date(now).toISOString(), vault: this.vault.vault, parent: path.relative(this.vault.vault, this.vault.root), mode: 'enabled', lastSuccess: intake.lastSuccess };
      }
      if (state.archiveReconnect?.status === 'pending' && operation !== 'disable') throw Error('Preview and explicitly reconnect the pending imported cadence before changing its task.');
      // Persist the requested mode first. A queued launch cannot bypass a failed pause/remove.
      if (operation === 'pause') state.mode = 'paused';
      if (operation === 'disable') state.mode = 'disabled';
      const options = { guard, assertSelected: this.assertSelected };
      const proof = await this.save(state, current?.proof || null, options);
      try {
        await this.assertSelected();
        this.requireCurrent(proof, guard);
        state.task = await this.tasks.apply(operation, state, this.file);
        if (operation === 'disable' && await this.tasks.apply('inspect', state, this.file)) throw Error('The daily intake task is still registered. Retry Disable explicitly.');
      } catch (error) {
        state.taskError = error.message;
        await this.save(state, proof, options);
        throw error;
      }
      if (operation === 'enable' || operation === 'resume') state.mode = 'enabled';
      if (operation === 'disable' && state.archiveReconnect?.status === 'pending') state.archiveReconnect.status = 'cancelled';
      delete state.taskError;
      await this.save(state, proof, options);
      return state;
    });
  }
  async record(result, verifyLatest, ownsAttempt) {
    // Intake still owns the check. Wait for a concurrent task control to
    // release the data lock before binding the result to the current cadence.
    return this.change(async guard => {
      const current = await this.snapshot(guard), state = current?.state;
      if (!this.matches(state) || ownsAttempt && !ownsAttempt(state)) return;
      if (!ownsAttempt) state.lastSuccess = result.lastSuccess;
      retainWorkerResult(state, result);
      await this.save(state, current.proof, { guard, assertSelected: this.assertSelected, verifyRelated: verifyLatest });
    }, { onBusy: verifyLatest, duringIntake: true });
  }
  async enable(now) { return this.control('enable', now); }
  async run(now, trigger = 'catch-up', expectedId) {
    const initial = await this.load(); if (!initial || initial.mode !== 'enabled' || !this.matches(initial)) return { skipped: true };
    if (expectedId !== undefined && initial.id !== expectedId) return { skipped: true };
    await this.assertSelected();
    const currentOwner = state => state?.id === initial.id && this.matches(state);
    const check = { at: now, trigger };
    let admittedSlot;
    const currentAttempt = state => state.handledSlot === admittedSlot && sameCheck(state.worker, check);
    try {
      return await new Intake(this.vault).reconcile({
        now, trigger,
        admit: () => this.change(async guard => {
          const current = await this.snapshot(guard), state = current?.state;
          if (!currentOwner(state)) return false;
          const slot = Math.floor((Date.parse(now) - Date.parse(state.anchor)) / DAY);
          if (state.mode !== 'enabled' || slot < 1 || slot <= (state.handledSlot || 0)) return false;
          state.handledSlot = slot; state.worker = { ...check, status: 'running' };
          await this.save(state, current.proof, { guard, assertSelected: this.assertSelected }); admittedSlot = slot; return true;
        }, { duringIntake: true }),
        onComplete: (result, verifyLatest) => this.record(result, verifyLatest,
          state => currentOwner(state) && currentAttempt(state) && scheduledRunning(state.worker))
      });
    } catch (error) {
      // A busy launch was never admitted and must not consume the due slot.
      if (!error.message.includes('already running')) await this.change(async guard => {
        const current = await this.snapshot(guard), state = current?.state;
        if (!currentOwner(state)) return;
        if (admittedSlot) {
          // The status reader may have closed this exact reservation after the Intake lock released.
          if (!currentAttempt(state) || !['running', 'interrupted'].includes(state.worker.status)) return;
        } else if (state.mode !== 'enabled' || state.handledSlot !== initial.handledSlot || scheduledRunning(state.worker)) return;
        state.workerError = error.message;
        state.worker = { at: now, trigger, status: 'error' }; await this.save(state, current.proof, { guard });
      });
      throw error;
    }
  }
  async settleExitedWorker(observed) {
    if (!this.matches(observed) || !scheduledRunning(observed.worker)) return observed;
    try {
      return await sourceMutation(this.vault.root, () => this.change(async guard => {
        const current = await this.snapshot(guard), state = current?.state;
        if (state?.id !== observed.id || !this.matches(state) || state.handledSlot !== observed.handledSlot ||
            !scheduledRunning(state.worker) || !sameCheck(state.worker, observed.worker)) return state || null;
        await this.assertSelected();
        const intake = new Intake(this.vault), result = await intake.load(), terminal = result.lastCheck;
        if (sameCheck(terminal, state.worker) && ['complete', 'held', 'error'].includes(terminal.status)) {
          retainWorkerResult(state, result);
        } else {
          state.worker = { ...state.worker, status: 'interrupted' };
          state.workerError = 'The daily intake worker exited before recording a result. Use Check now to retry explicitly.';
        }
        await this.save(state, current.proof, { guard, assertSelected: this.assertSelected, verifyRelated: () => intake.storage.guardSync() });
        return state;
      }, { duringIntake: true }));
    } catch (error) {
      if (error.message.includes('already running')) return observed;
      throw error;
    }
  }
  async info(now = new Date().toISOString()) {
    let state = await this.load(), workerInspectionError;
    try { state = await this.settleExitedWorker(state); }
    catch (error) { workerInspectionError = error.message; }
    if (!state) return null;
    const next = new Date(Date.parse(state.anchor) + Math.max(1, Math.floor((Date.parse(now) - Date.parse(state.anchor)) / DAY) + 1) * DAY).toISOString();
    let effective, inspectionError;
    try { effective = await this.tasks.apply('inspect', state, this.file); }
    catch (error) { inspectionError = error.message; }
    const taskMismatch = effective && effective.enabled !== (state.mode === 'enabled');
    const policyMismatch = effective && !this.tasks.matchesSchedule(effective, state, this.file);
    return { ...state, next, effective, inspectionError: workerInspectionError || inspectionError, taskMismatch, policyMismatch };
  }
}
module.exports = { Schedule };
