const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { PROFILE, canonical, samePath } = require('./codex-policy');
const { auditProbe } = require('./codex-probe');
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
async function audit(setup) {
  if (hash(await fs.readFile(setup.executable)) !== setup.executableDigest) throw Error('Codex executable changed. Check setup again.');
  if (await fs.readFile(path.join(setup.home, 'config.toml'), 'utf8') !== setup.configText) throw Error('Companion Codex configuration changed. Check setup again.');
  const result = await setup.rpc.request('config/read', { cwd: setup.work, includeLayers: true });
  if (!Array.isArray(result.layers) || !result.layers.length) throw Error('Codex did not expose its effective configuration layers.');
  let user = false;
  for (const layer of result.layers) {
    if (layer.disabledReason) continue;
    const knownSystemFile = path.join(process.env.ProgramData || 'C:\\ProgramData', 'OpenAI', 'Codex', 'config.toml');
    if (layer.name.type === 'system' && samePath(layer.name.file, knownSystemFile) && canonical(layer.config) === '{}') continue;
    if (layer.name.type !== 'user' || !samePath(layer.name.file, path.join(setup.home, 'config.toml'))) throw Error('An unexpected inherited Codex configuration layer prevents isolation verification.');
    if (canonical(layer.config) !== canonical(setup.policy)) throw Error('Effective Codex configuration differs from the controlled profile.');
    user = true;
  }
  if (!user) throw Error('The dedicated Companion configuration was not loaded.');
  const skills = await setup.rpc.request('skills/list', { cwds: [setup.work], forceReload: true });
  if (!Array.isArray(skills.data) || skills.data.length !== 1 || !samePath(skills.data[0].cwd, setup.work) || skills.data.some(entry => !Array.isArray(entry.skills) || entry.skills.some(skill => skill.enabled !== false) || entry.errors?.length)) throw Error('Enabled unselected skills or skill discovery errors prevent isolation verification.');
  const mcp = await setup.rpc.request('mcpServerStatus/list', {});
  if (!Array.isArray(mcp.data) || mcp.data.length || mcp.nextCursor) throw Error('Unselected connectors prevent isolation verification.');
  return hash(canonical({ layers: result.layers, origins: result.origins, executable: setup.executableDigest, probe: await auditProbe(setup), roots: await Promise.all([...setup.roots, setup.work, setup.home].map(async root => { const real = await fs.realpath(root), stat = await fs.stat(real); return { real, dev: stat.dev, ino: stat.ino, birthtimeMs: stat.birthtimeMs }; })), account: setup.accountDigest }));
}
async function readProbe(setup, target, expected, nested = false) {
  const command = nested ? [setup.probe.executable, '--child', target] : [setup.probe.executable, target];
  const result = await setup.rpc.request('command/exec', { command, cwd: setup.work, permissionProfile: PROFILE, timeoutMs: 15000, outputBytesCap: 4096 }, 20000);
  if (expected) {
    if (result.exitCode !== 0 || result.stdout !== expected) throw Error('The positive canary was not readable through the actual sandbox.');
  } else if (result.exitCode !== 73 || result.stdout !== 'COMPANION_OS_DENIED') throw Error('A protected canary did not produce an OS read denial. Chat remains unavailable.');
}
async function probeIsolation(setup) {
  const readiness = await setup.rpc.request('windowsSandbox/readiness', {});
  if (readiness.status !== 'ready') throw Error('Windows sandbox setup is incomplete. Configure MXC or the elevated sandbox, then retry.');
  const owned = [], links = [];
  try {
    const positive = path.join(setup.work, `positive-${crypto.randomUUID()}.txt`), marker = `COMPANION_${crypto.randomUUID()}`;
    await fs.writeFile(positive, marker, { flag: 'wx' }); owned.push(positive);
    await readProbe(setup, positive, marker); await readProbe(setup, positive, marker, true);
    setup.checks.push({ check: 'positive-canary-direct-and-child', status: 'passed', probeSha256: setup.probe.digest });
    for (let index = 0; index < setup.roots.length; index++) {
      const root = setup.roots[index]; const name = `.companion-isolation-${crypto.randomUUID()}.txt`;
      const target = path.join(root, name), secret = `COMPANION_OUTSIDE_${crypto.randomUUID()}`;
      await fs.writeFile(target, secret, { flag: 'wx' }); owned.push(target);
      if (await fs.readFile(target, 'utf8') !== secret) throw Error('Cannot establish the host canary.');
      await readProbe(setup, target); await readProbe(setup, target, null, true);
      await readProbe(setup, target.toUpperCase());
      await readProbe(setup, path.toNamespacedPath(target));
      const link = path.join(setup.work, `denied-link-${crypto.randomUUID()}`);
      await fs.symlink(root, link, 'junction'); links.push(link);
      await readProbe(setup, path.join(link, name));
      setup.checks.push({ check: `protected-root-${index + 1}-direct-child-case-extended-junction`, status: 'passed' });
    }
  } finally {
    // Remove only this invocation's files and junctions. No recursive directory removal.
    await Promise.allSettled(links.map(link => fs.unlink(link)));
    await Promise.allSettled(owned.map(file => fs.unlink(file)));
  }
}
module.exports = { audit, probeIsolation };
