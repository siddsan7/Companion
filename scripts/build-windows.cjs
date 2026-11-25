const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const manifest = require('../package.json');

// The version override builds the previous-version fixture for the MSI upgrade test.
const version = process.argv[2] || manifest.version;
if (!/^\d+\.\d+\.\d+$/.test(version)) throw Error('An MSI version needs three numeric fields.');
if (process.platform !== 'win32' || process.arch !== 'x64') throw Error('Build on x64 Windows using x64 Node.');
const root = path.resolve(__dirname, '..');
const output = path.join(root, 'dist');
fs.mkdirSync(output, { recursive: true });
const build = fs.mkdtempSync(path.join(output, 'msi-'));
const wix = process.env.WIX_BIN || path.join(output, 'wix');
const runtime = path.join(root, 'node_modules/electron/dist');
const exe = path.join(runtime, 'electron.exe');
const locked = require('../package-lock.json').packages;
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
if (execFileSync(exe, ['--version'], { env, encoding: 'utf8' }).trim() !== 'v' + locked['node_modules/electron'].version) {
  throw Error('Prepare the locked Electron runtime before packaging.');
}
if (require('yaml/package.json').version !== locked['node_modules/yaml'].version) throw Error('Run npm ci.');

const dirs = new Map();
const xml = value => value.replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;');
const hash = value => crypto.createHash('sha256').update(value).digest('hex').slice(0, 32);
const guid = value => hash(value).replace(/^(........)(....)(....)(....)(............)$/, '$1-$2-$3-$4-$5');
function directory(relative) {
  if (dirs.has(relative)) return dirs.get(relative);
  const dir = { id: relative ? 'D' + hash(relative) : 'INSTALLFOLDER', files: [], children: [] };
  dirs.set(relative, dir);
  if (relative) directory(path.posix.dirname(relative).replace(/^\.$/, '')).children.push([path.posix.basename(relative), dir]);
  return dir;
}
function add(source, target) {
  if (!fs.lstatSync(source).isFile()) throw Error('Expected a regular payload file: ' + source);
  const id = target === 'Companion.exe' ? 'CompanionExe' : 'F' + hash(target);
  directory(path.posix.dirname(target).replace(/^\.$/, '')).files.push(
    '<File Id="' + id + '" Source="' + xml(source) + '" Name="' + xml(path.posix.basename(target)) + '" />'
  );
}
const runtimeFiles = [
  'electron.exe', 'LICENSE', 'LICENSES.chromium.html', 'icudtl.dat', 'version',
  'chrome_100_percent.pak', 'chrome_200_percent.pak', 'resources.pak', 'd3dcompiler_47.dll',
  'dxcompiler.dll', 'electron_wer.dll', 'ffmpeg.dll', 'snapshot_blob.bin', 'v8_context_snapshot.bin',
  'vk_swiftshader.dll', 'vk_swiftshader_icd.json', 'vulkan-1.dll'
];
for (const name of runtimeFiles) {
  add(path.join(runtime, name), name === 'electron.exe' ? 'Companion.exe' : name);
}
for (const name of fs.readdirSync(path.join(runtime, 'locales'))) {
  if (/^[\w-]+\.pak$/.test(name)) add(path.join(runtime, 'locales', name), 'locales/' + name);
}
const appRoot = 'resources/app/';
const tracked = execFileSync('git', ['ls-files', '-z', '--', 'app', 'scripts/build-codex-probe.ps1'], { cwd: root, encoding: 'utf8' });
for (const file of tracked.split('\0').filter(Boolean)) add(path.join(root, file), appRoot + file);
const yaml = path.join(root, 'node_modules/yaml');
const yamlFiles = fs.readdirSync(path.join(yaml, 'dist'), { recursive: true }).filter(file => file.endsWith('.js'));
for (const file of ['LICENSE', 'package.json', ...yamlFiles.map(file => 'dist/' + file.replaceAll('\\', '/'))]) {
  add(path.join(yaml, file), appRoot + 'node_modules/yaml/' + file);
}
const metadata = path.join(build, 'package.json');
fs.writeFileSync(metadata, JSON.stringify({ name: manifest.name, version, main: manifest.main }));
add(metadata, appRoot + 'package.json');

// HKCU key paths let Windows Installer track per-user components. Stable
// component IDs and the major-upgrade transaction bind versions to one product.
const components = [];
function emit(dir) {
  const id = 'C' + dir.id;
  components.push('<ComponentRef Id="' + id + '" />');
  return '<Component Id="' + id + '" Guid="' + guid('Companion MSI directory/' + dir.id) + '">' + dir.files.join('\n') +
    '<RemoveFolder Id="R' + dir.id + '" On="uninstall" />' +
    '<RegistryValue Root="HKCU" Key="Software\\Companion\\Installer\\Files" Name="' + id +
    '" Type="integer" Value="1" KeyPath="yes" /></Component>\n' +
    dir.children.map(([name, child]) => '<Directory Name="' + xml(name) + '" Id="' + child.id + '">' + emit(child) + '</Directory>').join('\n');
}
const payload = '<Wix xmlns="http://schemas.microsoft.com/wix/2006/wi"><Fragment><DirectoryRef Id="INSTALLFOLDER">' +
  emit(directory('')) + '</DirectoryRef><ComponentGroup Id="Payload">' + components.join('\n') + '</ComponentGroup></Fragment></Wix>';
fs.writeFileSync(path.join(build, 'payload.wxs'), payload);
const msi = path.join(output, 'Companion-' + version + '-windows-x64.msi');
execFileSync(path.join(wix, 'candle.exe'), ['-nologo', '-arch', 'x64', '-dVersion=' + version, '-dProductCode=' + guid('Companion MSI x64/' + version),
  path.join(root, 'packaging/windows.wxs'), 'payload.wxs'], { cwd: build, stdio: 'inherit' });
const candidate = path.join(build, path.basename(msi));
execFileSync(path.join(wix, 'light.exe'), ['-nologo', '-spdb', '-out', candidate, 'windows.wixobj', 'payload.wixobj'], { cwd: build, stdio: 'inherit' });
const sha = crypto.createHash('sha256').update(fs.readFileSync(candidate)).digest('hex');
fs.renameSync(candidate, msi);
fs.writeFileSync(msi + '.sha256', sha + '  ' + path.basename(msi) + '\n');
console.log(sha, msi);
