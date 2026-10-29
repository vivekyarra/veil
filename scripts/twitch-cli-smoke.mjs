import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createServer } from 'node:net';
import assert from 'node:assert/strict';
import { EventSub } from '../app/dist-electron/twitch/eventsub.js';
import { Helix } from '../app/dist-electron/twitch/helix.js';

const root = resolve(import.meta.dirname, '..');
const binary = process.env.TWITCH_CLI ?? resolve(root, 'runtime/twitch-cli/twitch-cli_1.1.24_Windows_x86_64/twitch.exe');
const directory = resolve(root, 'runtime/twitch-cli-smoke');
mkdirSync(directory, { recursive: true });
const probe = createServer();
await new Promise(r => probe.listen(0, '127.0.0.1', r));
const port = probe.address().port;
await new Promise(r => probe.close(r));
const config = resolve(directory, 'synthetic.env');
writeFileSync(config, '');
const child = spawn(binary, ['event', 'websocket', 'start-server', '--ip', '127.0.0.1', '--port', String(port), '--require-subscription', '--config', config], {
  windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'],
  env: { ...process.env, APPDATA: directory, XDG_CONFIG_HOME: directory, TWITCH_DISABLE_UPDATE_CHECKS: 'true' },
});
child.on('error', () => {});
const status = [], subscriptions = [];
const origin = `http://127.0.0.1:${port}`;
const transport = async (url, options) => {
  const response = await fetch(url, options);
  subscriptions.push({ type: JSON.parse(options.body).type, status: response.status });
  return response;
};
const helix = new Helix({ clientId: 'synthetic-client', access: async () => 'synthetic-token' }, '123', origin, transport);
const eventsub = new EventSub(helix, () => {}, value => status.push(value), `ws://127.0.0.1:${port}/ws`);
try {
  let available = false;
  for (let i = 0; i < 80; i++) {
    try { await fetch(origin); available = true; break; } catch {}
    await new Promise(r => setTimeout(r, 100));
  }
  assert.ok(available, 'Official CLI server did not listen');
  eventsub.start();
  for (let i = 0; i < 150 && subscriptions.length < 5; i++) await new Promise(r => setTimeout(r, 100));
  assert.equal(subscriptions.length, 5, 'Production client did not attempt all five subscriptions');
  assert.ok(subscriptions.some(s => s.status === 202), 'No official CLI subscription accepted');
  writeFileSync(resolve(root, 'docs/twitch-cli-smoke.json'), JSON.stringify({
    cli_version: '1.1.24', actual_cli: true, loopback_only: true, subscriptions, connected: eventsub.connected, status,
    live_account: false, helix_device_code_fallback: 'Local Fastify contracts: CLI mock-api binds all interfaces and does not implement device-code flow',
  }, null, 2));
} finally {
  eventsub.stop();
  child.kill();
}
