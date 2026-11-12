const { spawnSync } = require('node:child_process');
const { existsSync, readFileSync } = require('node:fs');
const path = require('node:path');

function prepare() {
  if (process.platform !== 'win32') throw new Error('Run Electron preparation on Windows.');
  if (process.env.ELECTRON_OVERRIDE_DIST_PATH) {
    throw new Error('Unset ELECTRON_OVERRIDE_DIST_PATH to prepare the pinned local Electron runtime.');
  }
  const directory = path.resolve(__dirname, '../node_modules/electron');
  const locked = require('../package-lock.json').packages['node_modules/electron'].version;
  const manifest = path.join(directory, 'package.json');
  if (!existsSync(manifest)) throw new Error(`Run npm ci to install Electron ${locked}.`);
  const installed = require(manifest);
  if (installed.version !== locked) throw new Error(`Run npm ci to install Electron ${locked}.`);

  const install = spawnSync(process.execPath, [path.join(directory, installed.bin['install-electron'])], { stdio: 'inherit' });
  if (install.error) throw install.error;
  if (install.status !== 0) throw new Error(`The Electron installer exited with ${install.status ?? install.signal}.`);

  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const runtime = readFileSync(path.join(directory, 'path.txt'), 'utf8');
  if (runtime !== 'electron.exe') throw new Error('The Electron installer did not select electron.exe.');
  const executable = path.join(directory, 'dist', runtime);
  const result = spawnSync(executable, ['--version'], { env, encoding: 'utf8', windowsHide: true });
  if (result.error) throw result.error;
  const reported = result.stdout.trim();
  if (result.status !== 0 || reported !== `v${locked}`) {
    const expected = `Expected Electron v${locked} from ${executable}.`;
    const actual = `Received ${JSON.stringify(reported)} (exit ${result.status ?? result.signal}).`;
    throw new Error(`${expected} ${actual} ${result.stderr.trim()}`.trim());
  }
  console.log(`Electron v${locked} is ready.`);
}

try {
  prepare();
} catch (error) {
  console.error(`Electron preparation failed. ${error.message}`);
  process.exitCode = 1;
}
