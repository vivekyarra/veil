import { createHash } from 'node:crypto';
import { createReadStream, readFileSync, statSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import assert from 'node:assert/strict';

const root = resolve(import.meta.dirname, '..');
const require = createRequire(resolve(root, 'app/package.json'));
const { extractFile } = require('@electron/asar');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
async function fingerprint(path) {
  const digest = createHash('sha256');
  for await (const chunk of createReadStream(resolve(root, path))) digest.update(chunk);
  return { path, bytes: statSync(resolve(root, path)).size, sha256: digest.digest('hex') };
}
const files = await Promise.all([
  'app/release/VEIL Setup 0.1.0.exe',
  'app/release/win-unpacked/resources/app.asar',
  'detector/dist/veil-detector/veil-detector.exe',
  'plugin/dist/veil-guard.dll',
].map(fingerprint));
const asar = resolve(root, files[1].path);
for (const path of ['dist-electron/main.js', 'dist/index.html'])
  assert.equal(hash(extractFile(asar, path)), hash(readFileSync(resolve(root, 'app', path))), 'Packaged source mismatch: ' + path);
for (const [original, packaged] of [
  ['detector/dist/veil-detector/veil-detector.exe', 'app/release/win-unpacked/resources/detector/veil-detector.exe'],
  ['plugin/dist/veil-guard.dll', 'app/release/win-unpacked/resources/plugins/veil-guard.dll'],
]) assert.equal((await fingerprint(original)).sha256, (await fingerprint(packaged)).sha256, 'Packaged runtime mismatch');
const e2e = JSON.parse(readFileSync(resolve(root, 'docs/e2e-evidence.json'), 'utf8'));
assert.ok(e2e.passed && e2e.packaged && e2e.clean_exit_audio_restored);
writeFileSync(resolve(root, 'docs/release-manifest.json'), JSON.stringify({
  measured_at: new Date().toISOString(),
  source_reference: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
  files, packaged_code_matches: true, packaged_runtime_matches: true,
  packaged_e2e_passed: true, signed: false,
  installer_installation_on_clean_machine_verified: false,
  native_dll_note: 'Runtime proof predates formatting-only native source pass; binary hash unchanged',
  release_acceptance: 'Blocked by card recall, reference-GPU timing, live/platform/clean-machine gates; see acceptance.md',
}, null, 2));
