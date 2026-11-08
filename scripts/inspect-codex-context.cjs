// Read-only installed-CLI diagnostic. Does not start/resume a thread or rewrite CODEX_HOME.
// Run after any interactive sign-in finishes; it is not itself an isolation certificate.
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { inside } = require('../app/codex-policy');
const execute = promisify(execFile);
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const args = process.argv.slice(2);
const options = Object.fromEntries(args.flatMap((value, index) => value.startsWith('--') ? [[value.slice(2), args[index + 1]]] : []));
async function main() {
  if (!options['data-root'] || !options.executable || !/^[0-9a-f]{64}$/i.test(options['config-sha256'] || '') || !options.output) throw Error('Supply --data-root, --executable, --config-sha256 and a new absolute --output path.');
  if (!path.isAbsolute(options.output)) throw Error('The inspection output path must be absolute.');
  const dataRoot = await fs.realpath(options['data-root']);
  const home = await fs.realpath(path.join(dataRoot, 'managed-home'));
  const work = await fs.realpath(path.join(dataRoot, 'empty-work'));
  const output = path.resolve(options.output);
  if (inside(home, output) || inside(work, output)) throw Error('Store inspection evidence outside the managed home and working directory.');
  const configFile = path.join(home, 'config.toml');
  const configDigest = hash(await fs.readFile(configFile));
  if (configDigest !== options['config-sha256'].toLowerCase()) throw Error('The controlled configuration changed. Re-audit before inspecting context.');
  const executable = await fs.realpath(options.executable);
  const executableDigest = hash(await fs.readFile(executable));
  const env = { CODEX_HOME: home };
  for (const name of ['SystemRoot', 'SYSTEMROOT', 'WINDIR', 'TEMP', 'TMP', 'USERPROFILE', 'LOCALAPPDATA', 'APPDATA', 'ProgramFiles', 'ProgramFiles(x86)', 'ComSpec', 'COMSPEC', 'PATH', 'PATHEXT']) if (process.env[name]) env[name] = process.env[name];
  const marker = `COMPANION_CONTEXT_INSPECTION_${crypto.randomUUID()}`;
  let result;
  try { result = await execute(executable, ['debug', 'prompt-input', marker], { cwd: work, env, windowsHide: true, timeout: 30000, maxBuffer: 8 * 1024 * 1024 }); }
  catch { throw Error('Installed CLI context inspection failed. No model inference was requested.'); }
  let parsed;
  try { parsed = JSON.parse(result.stdout); }
  catch { throw Error('The installed CLI did not provide a JSON context inspection.'); }
  if (hash(await fs.readFile(configFile)) !== configDigest || hash(await fs.readFile(executable)) !== executableDigest) throw Error('Executable or configuration changed during inspection.');
  const tools = [], toolSurfaces = [];
  function walk(value, location = '$') {
    if (!value || typeof value !== 'object') return;
    for (const [key, item] of Object.entries(value)) {
      const next = `${location}.${key}`;
      if (['tools', 'tool_definitions', 'toolSpecifications'].includes(key) && Array.isArray(item)) {
        toolSurfaces.push({ path: next, count: item.length });
        for (const tool of item) tools.push(tool?.name || tool?.function?.name || tool?.type || 'unnamed');
      }
      walk(item, next);
    }
  }
  walk(parsed);
  const messages = Array.isArray(parsed) ? parsed : Array.isArray(parsed.input) ? parsed.input : [];
  const summary = {
    diagnostic: 'debug-prompt-input-not-an-App-Server-request', inferenceRequested: false,
    executableSha256: executableDigest, configSha256: configDigest, contextSha256: hash(JSON.stringify(parsed)),
    shape: Array.isArray(parsed) ? 'array' : typeof parsed,
    topLevelKeys: Array.isArray(parsed) ? [] : Object.keys(parsed),
    messages: messages.map(message => ({ role: message.role || null, type: message.type || null, bytes: Buffer.byteLength(JSON.stringify(message)), sha256: hash(JSON.stringify(message)) })),
    toolInventoryExposed: toolSurfaces.length > 0, toolSurfaces, toolNames: tools,
    limitation: 'Message inspection does not imply a complete tool inventory or exact App Server thread request. Never import this report as ready.'
  };
  await fs.writeFile(output, JSON.stringify({ summary, marker, context: parsed }, null, 2), { flag: 'wx' });
  console.log(JSON.stringify(summary));
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
