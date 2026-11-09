const fs = require('node:fs/promises');
const { AsyncLocalStorage } = require('node:async_hooks');
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
module.exports = { sourceMutation };
