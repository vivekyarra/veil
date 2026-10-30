// Local control of the real Electron app for repeatable demo recording.
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { mkdirSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
const root = resolve(import.meta.dirname, '..');
const require = createRequire(resolve(root, 'app/package.json'));
const { _electron } = require('playwright');
const dir = resolve(root, 'runtime/demo');
mkdirSync(resolve(dir, 'raw'), { recursive: true });
const env = { ...process.env, VEIL_DATA_DIR: resolve(dir, 'data'), VEIL_PORT: '47321' };
delete env.ELECTRON_RUN_AS_NODE;
const desktop = await _electron.launch({
  executablePath: resolve(root, 'app/node_modules/electron/dist/electron.exe'),
  args: [resolve(root, 'app')], cwd: resolve(root, 'app'), env, timeout: 60000,
  recordVideo: { dir: resolve(dir, 'raw'), size: { width: 1440, height: 810 } },
});
const started = Date.now();
const markers = [];
const page = await desktop.firstWindow();
await (await desktop.browserWindow(page)).evaluate(w => w.setContentSize(1440, 810));
const token = randomBytes(32).toString('hex');
const server = createServer(async (req, res) => {
  if (req.headers.authorization !== `Bearer ${token}`) { res.writeHead(403).end(); return; }
  try {
    let body = '';
    for await (const chunk of req) { body += chunk; if (body.length > 1048576) throw Error('Request too large'); }
    const action = JSON.parse(body || '{}');
    let result;
    if (action.op === 'command') result = await page.evaluate(({ command, data }) => window.veil.command(command, data), action);
    else if (action.op === 'text') result = await page.locator('body').innerText();
    else if (action.op === 'click') { await page.getByRole('button', { name: action.name, exact: true }).click(); result = true; }
    else if (action.op === 'fill') { await page.getByLabel(action.label, { exact: true }).fill(action.value); result = true; }
    else if (action.op === 'mark') { markers.push({ name: action.name, seconds: (Date.now() - started) / 1000 }); writeFileSync(resolve(dir, 'markers.json'), JSON.stringify(markers, null, 2)); result = markers.at(-1); }
    else if (action.op === 'screenshot') { await page.screenshot({ path: resolve(dir, 'current.png') }); result = true; }
    else if (action.op === 'finish') {
      const video = page.video();
      await desktop.close();
      const videoPath = await video.path();
      writeFileSync(resolve(dir, 'recording.json'), JSON.stringify({ videoPath, started, markers }, null, 2));
      res.end(JSON.stringify({ finished: true, videoPath })); server.close(); return;
    }
    else throw Error('Unknown operation');
    res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(result));
  } catch (error) { res.writeHead(400).end(JSON.stringify({ error: String(error) })); }
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
writeFileSync(resolve(dir, 'control.json'), JSON.stringify({ port: server.address().port, token }));
console.log('Real VEIL demo app ready; private control saved locally.');
