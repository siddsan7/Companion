const net = require('node:net');
const fs = require('node:fs/promises');
const { createHash } = require('node:crypto');

// Kernel-owned endpoints disappear on process exit. Never reclaim a live lock by PID.
async function withBriefMutation(root, work) {
  const canonical = await fs.realpath(root);
  const identity = createHash('sha256').update(process.platform === 'win32' ? canonical.toLowerCase() : canonical).digest('hex');
  let endpoint;
  if (process.platform === 'win32') endpoint = `\\\\.\\pipe\\companion-briefs-${identity}`;
  else if (process.platform === 'linux') endpoint = `\0companion-briefs-${identity}`;
  else throw Error('Brief mutation coordination requires Windows named pipes or Linux abstract sockets.');
  const server = net.createServer(socket => socket.destroy());
  try {
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen({ path: endpoint, exclusive: true }, resolve);
    });
  } catch (error) {
    if (error.code === 'EADDRINUSE') throw Error('Project Brief store is busy in another Companion window. Keep your edits and retry after that operation finishes.');
    throw error;
  }
  try { return await work(); }
  finally { await new Promise(resolve => server.close(resolve)); }
}
module.exports = { withBriefMutation };
