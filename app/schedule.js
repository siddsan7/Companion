const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { Intake } = require('./intake');
const { intakeLock } = require('./intake-lock');
const { TaskScheduler } = require('./task-scheduler');
const DAY = 86400000;
const uuid = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/;
class Schedule {
  constructor(file, vault, options = {}) { this.file = file; this.vault = vault; this.tasks = new TaskScheduler(options); }
  async load() {
    let state;
    try { state = JSON.parse(await fs.readFile(this.file, 'utf8')); }
    catch (error) { if (error.code === 'ENOENT') return null; throw Error('Daily intake settings are unreadable. Preserve them for repair.'); }
    if (state.schema !== 1 || !uuid.test(state.id) || !Number.isFinite(Date.parse(state.anchor)) || !path.isAbsolute(state.vault) || typeof state.parent !== 'string' || !['enabled', 'paused', 'disabled'].includes(state.mode) || !Number.isInteger(state.handledSlot || 0) || (state.handledSlot || 0) < 0) throw Error('Unsupported daily intake settings. Preserve them for repair.');
    return state;
  }
  async save(state) {
    const stage = `${this.file}.${randomUUID()}.tmp`;
    await fs.writeFile(stage, JSON.stringify(state, null, 2), { flag: 'wx', flush: true }); await fs.rename(stage, this.file);
  }
  async change(work) { return intakeLock(path.dirname(this.file), work); }
  matches(state) { return this.vault && path.resolve(state.vault, state.parent).toLowerCase() === path.resolve(this.vault.root).toLowerCase(); }
  async control(operation, now) {
    return this.change(async () => {
      let state = await this.load();
      if (!state) {
        if (operation !== 'enable' || !this.vault) throw Error('Choose a vault and enable daily intake first.');
        const intake = await new Intake(this.vault).info();
        if (!intake.sources.length) throw Error('Connect a draft source before enabling daily intake.');
        state = { schema: 1, id: randomUUID(), anchor: new Date(now).toISOString(), vault: this.vault.vault, parent: path.relative(this.vault.vault, this.vault.root), mode: 'enabled', lastSuccess: intake.lastSuccess };
      }
      if (!this.matches(state)) throw Error('Daily intake belongs to another vault. Reconnect its original vault before changing the task.');
      // Persist the requested mode first. A queued launch cannot bypass a failed pause/remove.
      if (operation === 'pause') state.mode = 'paused';
      if (operation === 'disable') state.mode = 'disabled';
      await this.save(state);
      try {
        state.task = await this.tasks.apply(operation, state, this.file);
        if (operation === 'enable' || operation === 'resume') state.mode = 'enabled';
        delete state.taskError; await this.save(state); return state;
      } catch (error) {
        state.taskError = error.message; await this.save(state); throw error;
      }
    });
  }
  async record(result) {
    if (!result?.lastCheck) return result;
    await this.change(async () => {
      const state = await this.load(); if (!state || !this.matches(state)) return;
      state.lastSuccess = result.lastSuccess;
      state.worker = { ...result.lastCheck, finishedAt: new Date().toISOString() };
      if (result.lastCheck.status === 'complete') delete state.workerError;
      else state.workerError = result.sources.find(x => x.error)?.error || 'Some imports are held. Inspect held imports and use Check now after repair.';
      await this.save(state);
    });
    return result;
  }
  async enable(now) { return this.control('enable', now); }
  async run(now, trigger = 'catch-up') {
    const initial = await this.load(); if (!initial || initial.mode !== 'enabled' || !this.matches(initial)) return { skipped: true };
    let admitted = false;
    try {
      const result = await new Intake(this.vault).reconcile({ now, trigger, admit: () => this.change(async () => {
        const state = await this.load(), slot = Math.floor((Date.parse(now) - Date.parse(state.anchor)) / DAY);
        if (state.mode !== 'enabled' || slot < 1 || slot <= (state.handledSlot || 0)) return false;
        state.handledSlot = slot; state.worker = { at: now, trigger, status: 'running' };
        await this.save(state); admitted = true; return true;
      }) });
      if (admitted) await this.change(async () => {
        const state = await this.load();
        state.worker = { at: now, finishedAt: new Date().toISOString(), trigger, status: result.lastCheck.status };
        if (result.lastCheck.status === 'complete') { state.lastSuccess = result.lastSuccess; delete state.workerError; }
        else state.workerError = result.sources.find(x => x.error)?.error || 'Some imports are held. Inspect held imports and use Check now after repair.';
        await this.save(state);
      });
      return result;
    } catch (error) {
      // A busy launch was never admitted and must not consume the due slot.
      if (!error.message.includes('already running')) await this.change(async () => {
        const state = await this.load(); state.workerError = error.message;
        state.worker = { at: now, trigger, status: 'error' }; await this.save(state);
      });
      throw error;
    }
  }
  async info(now = new Date().toISOString()) {
    const state = await this.load(); if (!state) return null;
    const next = new Date(Date.parse(state.anchor) + Math.max(1, Math.floor((Date.parse(now) - Date.parse(state.anchor)) / DAY) + 1) * DAY).toISOString();
    let effective, inspectionError;
    try { effective = await this.tasks.apply('inspect', state, this.file); }
    catch (error) { inspectionError = error.message; }
    const taskMismatch = effective && effective.enabled !== (state.mode === 'enabled');
    const policyMismatch = effective && !this.tasks.matchesSchedule(effective, state, this.file);
    return { ...state, next, effective, inspectionError, taskMismatch, policyMismatch };
  }
}
module.exports = { Schedule };
