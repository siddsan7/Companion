const fs = require('node:fs/promises');
const { AsyncLocalStorage } = require('node:async_hooks');
const { performance } = require('node:perf_hooks');
const { intakeLock } = require('./intake-lock');
const ownership = new AsyncLocalStorage();
async function sourceMutation(root, work) {
  const canonical = await fs.realpath(root), key = process.platform === 'win32' ? canonical.toLowerCase() : canonical;
  const current = ownership.getStore();
  if (current?.active && current.root === key) return work();
  try {
    return await intakeLock(root, async () => {
      const token = { root: key, active: true };
      try { return await ownership.run(token, work); }
      finally { token.active = false; }
    });
  } catch (error) {
    if (error.message.includes('already running')) error.code = 'INTAKE_BUSY';
    throw error;
  }
}
async function sourceInspection(root, work) {
  const deadline = performance.now() + 2000;
  let callbackStarted = false, lastBusy;
  const expired = () => lastBusy || Object.assign(Error('An intake check is already running. Wait for it to finish.'), { code: 'INTAKE_BUSY' });
  while (true) {
    if (performance.now() >= deadline) throw expired();
    try {
      return await sourceMutation(root, () => {
        // Once admitted, no body or nested failure can replay this inspection.
        callbackStarted = true;
        if (performance.now() >= deadline) throw expired();
        return work();
      });
    } catch (error) {
      if (callbackStarted || error.code !== 'INTAKE_BUSY') throw error;
      lastBusy = error;
      const remaining = deadline - performance.now();
      if (remaining <= 0) throw error;
      await new Promise(resolve => setTimeout(resolve, Math.min(25, remaining)));
    }
  }
}
module.exports = { sourceMutation, sourceInspection };
