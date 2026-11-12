const fs = require('node:fs/promises');
const net = require('node:net');
const { hash } = require('./intake-producer');
// A kernel-owned listener releases on process death. There is no PID-file
// reclamation window in which two recovering workers can both own the vault.
async function intakeLock(root, work) {
  const canonical = await fs.realpath(root), key = hash(process.platform === 'win32' ? canonical.toLowerCase() : canonical);
  const address = process.platform === 'win32' ? `\\\\.\\pipe\\companion-intake-${key}` : process.platform === 'linux' ? `\0companion-intake-${key}` : null;
  if (!address) throw Error('Native intake locking is unavailable on this platform.');
  const server = net.createServer(socket => socket.destroy());
  await new Promise((resolve, reject) => {
    server.once('error', error => reject(error.code === 'EADDRINUSE'
      ? Object.assign(Error('An intake check is already running. Wait for it to finish.'), { code: 'INTAKE_BUSY' })
      : Error(`Native intake lock unavailable (${error.code}).`)));
    server.listen(address, resolve);
  });
  try { return await work(); } finally { await new Promise(resolve => server.close(resolve)); }
}
module.exports = { intakeLock };
