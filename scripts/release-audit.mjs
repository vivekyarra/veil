import { createHash } from 'node:crypto';
import { createReadStream, existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import assert from 'node:assert/strict';

const root = resolve(import.meta.dirname, '..');
const require = createRequire(resolve(root, 'app/package.json'));
const { extractFile } = require('@electron/asar');
const { version } = JSON.parse(readFileSync(resolve(root, 'app/package.json'), 'utf8'));
const mac = process.platform === 'darwin';
const installer = readdirSync(resolve(root, 'app/release')).find(file => file.includes(version) && file.endsWith(mac ? '.dmg' : '.exe'));
assert.ok(installer, 'Versioned installer is missing');
const macDirectory = mac ? readdirSync(resolve(root, 'app/release')).find(dir => existsSync(resolve(root, 'app/release', dir, 'VEIL.app/Contents/Resources/app.asar'))) : undefined;
if (mac) assert.ok(macDirectory, 'Packaged macOS application is missing');
const resources = mac ? `app/release/${macDirectory}/VEIL.app/Contents/Resources` : 'app/release/win-unpacked/resources';
const detectorName = mac ? 'veil-detector' : 'veil-detector.exe';
const plugin = mac ? 'plugin/dist/veil-guard.plugin/Contents/MacOS/veil-guard' :
  existsSync(resolve(root, 'plugin/dist/obs-plugins/64bit/veil-guard.dll')) ? 'plugin/dist/obs-plugins/64bit/veil-guard.dll' : 'plugin/dist/veil-guard.dll';
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
async function fingerprint(path) {
  const digest = createHash('sha256');
  for await (const chunk of createReadStream(resolve(root, path))) digest.update(chunk);
  return { path, bytes: statSync(resolve(root, path)).size, sha256: digest.digest('hex') };
}
const files = await Promise.all([
  'app/release/' + installer,
  resources + '/app.asar',
  'detector/dist/veil-detector/' + detectorName,
  plugin,
].map(fingerprint));
const asar = resolve(root, files[1].path);
for (const path of ['dist-electron/main.js', 'dist/index.html'])
  assert.equal(hash(extractFile(asar, path)), hash(readFileSync(resolve(root, 'app', path))), 'Packaged source mismatch: ' + path);
for (const [original, packaged] of [
  ['detector/dist/veil-detector/' + detectorName, resources + '/detector/' + detectorName],
  [plugin, resources + '/plugins/' + plugin.slice('plugin/dist/'.length)],
]) assert.equal((await fingerprint(original)).sha256, (await fingerprint(packaged)).sha256, 'Packaged runtime mismatch');
const e2e = JSON.parse(readFileSync(resolve(root, 'docs/e2e-evidence.json'), 'utf8'));
assert.ok(e2e.passed && e2e.packaged && e2e.clean_exit_audio_restored);
assert.equal(e2e.platform, process.platform, 'Packaged E2E platform mismatch');
writeFileSync(resolve(root, 'docs/release-manifest.json'), JSON.stringify({
  measured_at: new Date().toISOString(),
  platform: process.platform,
  source_reference: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
  files, packaged_code_matches: true, packaged_runtime_matches: true,
  packaged_e2e_passed: true, signed: false,
  installer_installation_on_clean_machine_verified: false,
  native_filter_note: 'Native OBS runtime proof is separate from desktop packaging; see native-obs-smoke.json and live-twitch-smoke.json',
  release_acceptance: 'Hackathon preview; see acceptance.md for measured gates and unresolved hardware limits.',
}, null, 2));
