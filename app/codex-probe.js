const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { samePath } = require('./codex-policy');
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const textHash = bytes => hash(bytes.toString('utf8').replace(/^\uFEFF/, '').replace(/\r\n/g, '\n'));
const native = path.join(__dirname, 'native');
const files = {
  binary: path.join(native, 'codex-read-probe.exe'),
  source: path.join(native, 'codex-read-probe.c'),
  manifest: path.join(native, 'codex-read-probe.json'),
  build: path.join(__dirname, '../scripts/build-codex-probe.ps1')
};
async function artifact() {
  if (process.platform !== 'win32' || process.arch !== 'x64') throw Error('The reviewed Windows x64 read probe is unavailable on this platform.');
  let binary, source, build, manifestBytes;
  try { [binary, source, build, manifestBytes] = await Promise.all([fs.readFile(files.binary), fs.readFile(files.source), fs.readFile(files.build), fs.readFile(files.manifest)]); }
  catch { throw Error('Build the reviewed native Windows probe before verifying isolation.'); }
  let manifest;
  try { manifest = JSON.parse(manifestBytes.toString('utf8').replace(/^\uFEFF/, '')); }
  catch { throw Error('The native probe build manifest is invalid.'); }
  if (manifest.schema !== 1 || manifest.platform !== 'win32' || manifest.arch !== 'x64' || manifest.textNormalization !== 'LF' || manifest.binarySha256 !== hash(binary) || manifest.sourceSha256 !== textHash(source) || manifest.buildScriptSha256 !== textHash(build)) throw Error('The native probe binary, reviewed source or build manifest changed. Rebuild and review the artifact.');
  return { binary, digest: hash(binary), manifestDigest: hash(manifestBytes), sourceDigest: textHash(source) };
}
async function prepareProbe(setup) {
  const built = await artifact();
  const executable = path.join(setup.work, `companion-read-probe-${crypto.randomUUID()}.exe`);
  await fs.writeFile(executable, built.binary, { flag: 'wx' });
  setup.probe = { executable, digest: built.digest, manifestDigest: built.manifestDigest, sourceDigest: built.sourceDigest };
}
async function auditProbe(setup) {
  if (!setup.probe) throw Error('The trusted native read probe is not prepared. Check Codex setup again.');
  const built = await artifact(), copied = await fs.lstat(setup.probe.executable);
  if (!copied.isFile() || copied.isSymbolicLink() || !samePath(await fs.realpath(setup.probe.executable), setup.probe.executable) || built.digest !== setup.probe.digest || built.manifestDigest !== setup.probe.manifestDigest || hash(await fs.readFile(setup.probe.executable)) !== built.digest) throw Error('The native read probe changed. Check setup and verify isolation again.');
  return { binarySha256: built.digest, sourceSha256: built.sourceDigest, manifestSha256: built.manifestDigest };
}
module.exports = { prepareProbe, auditProbe };
