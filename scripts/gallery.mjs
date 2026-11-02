// Devpost gallery builder. Writes to artifacts/gallery/ (gitignored).
//   node scripts/gallery.mjs capture   -> raw app screens via the real Electron app
//   node scripts/gallery.mjs compose   -> framed 1800x1200 cards + contact sheet
// Requires `npm run build` in app/ first. Raw captures go to artifacts/gallery/_raw.
import { _electron as electron, chromium } from "../app/node_modules/playwright/index.mjs";
import { resolve, join } from "node:path";
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { createServer } from "node:net";
import http from "node:http";

const root = resolve(import.meta.dirname, "..");
const appDir = join(root, "app");
const out = join(root, "artifacts/gallery");
const raw = join(out, "_raw");
mkdirSync(raw, { recursive: true });
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function capture() {
  const { obsMock } = await import("../app/tests/mocks.ts");
  const data = join(root, "runtime/gallery-" + Date.now());
  mkdirSync(data, { recursive: true });
  const env = { ...process.env, VEIL_DATA_DIR: data };
  const probe = createServer();
  await new Promise((r) => probe.listen(0, "127.0.0.1", r));
  env.VEIL_PORT = String(probe.address().port);
  await new Promise((r) => probe.close(r));
  env.VEIL_OVERLAY_PORT = "0";
  delete env.ELECTRON_RUN_AS_NODE;
  const obs = await obsMock();
  const desktop = await electron.launch({
    executablePath: join(appDir, "node_modules/electron/dist/electron.exe"),
    args: [appDir],
    cwd: appDir,
    env,
    timeout: 60000,
  });
  try {
    const page = await desktop.firstWindow();
    page.setDefaultTimeout(30000);
    const win = await desktop.browserWindow(page);
    await win.evaluate((w) => {
      w.setContentSize(1440, 900);
      w.center();
    });
    const shot = async (name) => {
      await win.evaluate((w) => {
        if (w.isMinimized()) w.restore();
        w.show();
        w.focus();
      });
      await page.evaluate(() => {
        window.scrollTo(0, 0);
        document.querySelectorAll("*").forEach((e) => {
          if (e.scrollTop) e.scrollTop = 0;
        });
      });
      await wait(500);
      await page.screenshot({ path: join(raw, name + ".png"), timeout: 60000 });
      console.log("captured", name);
    };
    const nav = (name) =>
      page.getByRole("button", { name: new RegExp("^" + name) }).first().click();
    await page
      .getByRole("heading", { name: "Keep your private life off-stream." })
      .waitFor();
    for (let i = 0; i < 720; i++) {
      const r = await page.evaluate(() => window.veil.command("snapshot"));
      if (r.ok && r.value.detector) break;
      await wait(250);
    }
    await page.evaluate(() => window.veil.command("settings", { theme: "dark" }));
    await shot("onboarding-start");
    await nav("Onboarding");
    await page.getByLabel("Local WebSocket URL").fill(obs.url);
    await page.getByLabel("OBS password").fill("practice-password");
    await page.getByRole("button", { name: "Connect & inspect OBS" }).click();
    await page.getByRole("checkbox", { name: "Live", exact: true }).check();
    await page.getByRole("button", { name: "Add filters & sync audio" }).click();
    await page.waitForFunction(
      () => document.querySelector("[role=status]")?.textContent === "Done",
    );
    await shot("onboarding");
    await page.getByText("Done", { exact: true }).waitFor({ state: "hidden", timeout: 20000 }).catch(() => {});
    await nav("Dashboard");
    await shot("dashboard");
    writeFileSync(
      join(raw, "snapshot.json"),
      JSON.stringify(
        await page.evaluate(() => window.veil.command("snapshot")),
        null,
        2,
      ),
    );
    const allow = async () => {
      if (await page.getByRole("alertdialog").isVisible())
        await page.getByRole("button", { name: "Allow action", exact: true }).click();
    };
    await page.getByText("Done", { exact: true }).waitFor({ state: "hidden", timeout: 20000 }).catch(() => {});
    await page.getByRole("button", { name: /PANIC/ }).click();
    for (let i = 0; i < 20; i++) { await allow(); await wait(300); }
    await nav("Incidents");
    await page.getByRole("button", { name: /#1/ }).click();
    await page.getByRole("heading", { name: "Incident #1" }).waitFor();
    await shot("incident-panic");
    await nav("Rehearsal");
    await page.getByRole("button", { name: "Send practice chat attempts" }).click();
    await page.getByText("Practice chat sent.", { exact: false }).waitFor();
    for (let i = 0; i < 10; i++) { await allow(); await wait(300); }
    await page.getByRole("button", { name: "Email inbox ↗" }).click();
    await page.locator(".scan-result").waitFor({ timeout: 90000 });
    await allow();
    await page.locator(".split-grid").scrollIntoViewIfNeeded();
    await wait(400);
    await page.screenshot({ path: join(raw, "rehearsal.png") });
    await nav("Incidents");
    await shot("incidents-chat");
    const ids = await page.getByRole("button", { name: /#d+/ }).allInnerTexts();
    console.log("incident buttons", ids);
    await page.getByRole("button", { name: /#2/ }).click().catch(() => {});
    await wait(600);
    await shot("incident-chat-detail");
    await nav("Dashboard");
    await shot("dashboard-activity");
  } finally {
    await Promise.race([desktop.close(), wait(30000)]);
    await obs.close();
  }
}

// ---------- composition ----------
const BG = "#0b0d14";
const VIOLET = "#7c5cff";
const dataUrl = (p) =>
  "data:image/png;base64," + readFileSync(p).toString("base64");
const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;");

function card(headline, sub, body) {
  return `<!doctype html><html><head><meta charset="utf-8"><style>
  *{box-sizing:border-box}html,body{margin:0;width:1800px;height:1200px;background:${BG};overflow:hidden}
  body{font-family:Inter,"Segoe UI",Arial,sans-serif;color:#f3f5fb;position:relative}
  body::before{content:"";position:absolute;inset:0;background:radial-gradient(1200px 600px at 50% -10%,rgba(124,92,255,.22),transparent 70%)}
  .top{position:absolute;left:0;right:0;top:64px;text-align:center;padding:0 80px}
  h1{margin:0;font-size:72px;line-height:1.08;font-weight:800;letter-spacing:-1.5px}
  h1 em{font-style:normal;color:${VIOLET}}
  .sub{margin-top:18px;font-size:28px;color:#a9b1c6}
  .brand{position:absolute;right:48px;bottom:30px;font-size:20px;letter-spacing:4px;font-weight:700;color:#6d7488}
  .brand b{color:${VIOLET}}
  .stage{position:absolute;left:90px;right:90px;top:${sub ? 270 : 230}px;bottom:76px;display:flex;align-items:center;justify-content:center}
  .frame{max-width:100%;max-height:100%;border-radius:16px;box-shadow:0 30px 80px rgba(0,0,0,.6),0 0 0 1px rgba(182,165,255,.18);display:block}
  </style></head><body><div class="top"><h1>${headline}</h1>${sub ? `<div class="sub">${esc(sub)}</div>` : ""}</div>
  <div class="stage">${body}</div><div class="brand"><b>VEIL</b></div></body></html>`;
}
const framed = (headline, sub, img) =>
  card(headline, sub, `<img class="frame" src="${dataUrl(img)}">`);

async function render(browser, html, path, w = 1800, h = 1200) {
  const page = await browser.newPage({ viewport: { width: w, height: h } });
  await page.setContent(html, { waitUntil: "load" });
  await wait(300);
  await page.screenshot({ path });
  await page.close();
  console.log("wrote", path);
}

async function overlayShot(browser, path) {
  const overlay = readFileSync(join(appDir, "electron/overlay/overlay.html"));
  const clients = [];
  const server = http.createServer((req, res) => {
    if (req.url === "/overlay/events") {
      res.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
      });
      clients.push(res);
      return;
    }
    if (req.url === "/overlay") {
      res.writeHead(200, { "content-type": "text/html" });
      return res.end(overlay);
    }
    res.writeHead(200, { "content-type": "text/html" });
    res.end(`<!doctype html><html><head><style>
      html,body{margin:0;width:1920px;height:1080px;overflow:hidden;background:#0d1020}
      .scene{position:absolute;inset:0;background:
        radial-gradient(900px 500px at 70% 30%,rgba(124,92,255,.35),transparent 70%),
        radial-gradient(700px 400px at 20% 80%,rgba(40,200,180,.25),transparent 70%),
        linear-gradient(160deg,#1b1f3a,#0b0d18 60%,#151a2e)}
      .grid{position:absolute;left:0;right:0;bottom:0;height:520px;background:
        repeating-linear-gradient(90deg,rgba(124,92,255,.25) 0 2px,transparent 2px 120px),
        repeating-linear-gradient(0deg,rgba(124,92,255,.25) 0 2px,transparent 2px 60px);
        transform:perspective(600px) rotateX(60deg);transform-origin:bottom}
      .sun{position:absolute;left:50%;top:180px;width:420px;height:420px;margin-left:-210px;border-radius:50%;
        background:linear-gradient(#ffb36b,#ff5c9a 60%,#7c5cff);box-shadow:0 0 160px rgba(255,92,154,.5)}
      .hud{position:absolute;right:48px;top:40px;font:700 28px "Segoe UI",sans-serif;color:#fff;
        background:rgba(0,0,0,.45);padding:14px 22px;border-radius:12px;letter-spacing:1px}
      .cam{position:absolute;right:48px;bottom:48px;width:420px;height:236px;border-radius:18px;
        background:linear-gradient(135deg,#2a2f4a,#3b3361);border:3px solid rgba(255,255,255,.15);
        display:flex;align-items:center;justify-content:center;color:#cfd3ea;font:600 24px "Segoe UI"}
      iframe{position:absolute;left:24px;bottom:24px;width:520px;height:160px;border:0;
        transform:scale(1.5);transform-origin:bottom left;background:transparent}
    </style></head><body><div class="scene"></div><div class="sun"></div><div class="grid"></div>
    <div class="hud">LAP 3 / 5 &nbsp; 01:42.7</div><div class="cam">Webcam</div>
    <iframe src="/overlay" allowtransparency="true"></iframe></body></html>`);
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const port = server.address().port;
  const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
  await page.goto(`http://127.0.0.1:${port}/`);
  for (let i = 0; i < 50 && clients.length === 0; i++) await wait(100);
  const since = Date.now() - (2 * 3600 + 14 * 60 + 9) * 1000;
  const send = (p) =>
    clients.forEach((c) => c.write(`data: ${JSON.stringify(p)}\n\n`));
  const t0 = Date.now() - 60000;
  send({ armed: true, since, screen: 6, chat: 3, lastCatch: t0, lastKind: 2 });
  await wait(1200);
  send({ armed: true, since, screen: 7, chat: 3, lastCatch: Date.now(), lastKind: 1 });
  await wait(420);
  await page.screenshot({ path });
  await page.evaluate(() => {
    document.querySelectorAll(".scene,.sun,.grid,.hud,.cam").forEach((e) => e.remove());
    document.documentElement.style.background = document.body.style.background = "transparent";
  });
  await page.screenshot({ path: join(raw, "hero-badge.png"), omitBackground: true, clip: { x: 40, y: 850, width: 410, height: 195 } });
  await page.close();
  clients.forEach((c) => c.end());
  server.close();
  console.log("wrote", path);
}

async function compose() {
  const browser = await chromium.launch();
  const g = (n) => join(out, n);
  const r = (n) => join(raw, n);
  const stats = existsSync(r("stats.json"))
    ? JSON.parse(readFileSync(r("stats.json"), "utf8"))
    : null;
  // Full-resolution renders of shipped HTML.
  await render(
    browser,
    readFileSync(join(appDir, "electron/rehearsal/cover.html"), "utf8"),
    r("cover.png"),
    1920,
    1080,
  );
  await overlayShot(browser, r("overlay.png"));
  if (existsSync(join(raw, "practice.html")))
    await render(browser, readFileSync(r("practice.html"), "utf8"), r("practice-raw.png"), 1280, 800);
  if (process.argv[3] === "practice-only") return browser.close();

  await render(browser, hero(r), g("01-hero.png"));
  await render(
    browser,
    card(
      "Masked locally, <em>before</em> Twitch sees a frame.",
      "",
      `<div style="display:flex;gap:40px;align-items:center;width:100%">
       ${["Before", "After VEIL"].map((label, i) => `<figure style="margin:0;flex:1">
       <figcaption style="font-size:26px;font-weight:700;letter-spacing:3px;text-transform:uppercase;color:${i ? VIOLET : "#8a92a8"};margin-bottom:16px">${label}</figcaption>
       <img class="frame" style="width:100%" src="${dataUrl(r(i ? "practice-masked-zoom.png" : "practice-raw-zoom.png"))}"></figure>`).join("")}
       </div>`,
    ),
    g("02-masking.png"),
  );
  await render(browser, framed("Chat <em>can’t</em> repeat it.", "", r("rehearsal-crop.png")), g("03-chat-guard.png"));
  await render(browser, framed("One key. Cover, mute, marker.", "", r("incident-panic-crop.png")), g("04-panic.png"));
  await render(browser, framed("A calm cover scene, instantly.", "", r("cover.png")), g("05-cover.png"));
  await render(browser, framed("Viewers see the shield <em>working</em>.", "", r("overlay.png")), g("06-overlay.png"));
  await render(browser, framed("Set up in four steps.", "", r("onboarding-crop.png")), g("07-onboarding.png"));
  await render(browser, architecture(), g("08-architecture.png"));
  if (stats) await render(browser, codex(stats), g("09-codex.png"));

  const files = [
    "01-hero", "02-masking", "03-chat-guard", "04-panic", "05-cover",
    "06-overlay", "07-onboarding", "08-architecture", "09-codex",
  ].filter((f) => existsSync(g(f + ".png")));
  await render(
    browser,
    `<!doctype html><html><body style="margin:0;background:${BG};padding:40px;display:grid;grid-template-columns:repeat(3,580px);gap:30px;font-family:Segoe UI;color:#aab">
    ${files.map((f) => `<div><img src="${dataUrl(g(f + ".png"))}" style="width:580px;border-radius:8px;display:block"><div style="margin-top:8px;font-size:18px">${f}.png</div></div>`).join("")}</body></html>`,
    g("_contact.png"),
    1880,
    40 + Math.ceil(files.length / 3) * 425 + 40,
  );
  await browser.close();
}

function box(x, y, w, h, title, lines, accent = false) {
  return `<g><rect x="${x}" y="${y}" width="${w}" height="${h}" rx="20" fill="${accent ? "rgba(124,92,255,.16)" : "#141826"}" stroke="${accent ? VIOLET : "#2a3046"}" stroke-width="2"/>
  <text x="${x + 28}" y="${y + 52}" font-size="30" font-weight="800" fill="#fff">${title}</text>
  ${lines.map((l, i) => `<text x="${x + 28}" y="${y + 98 + i * 38}" font-size="23" fill="#aab2c8">${esc(l)}</text>`).join("")}</g>`;
}
function arrow(x1, y1, x2, y2, label) {
  const mx = (x1 + x2) / 2, my = (y1 + y2) / 2;
  return `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="${VIOLET}" stroke-width="4" marker-end="url(#a)"/>
  ${label ? `<text x="${mx}" y="${my - 14}" font-size="19" fill="#b6a5ff" text-anchor="middle">${esc(label)}</text>` : ""}`;
}
function architecture() {
  const svg = `<svg width="1620" height="860" viewBox="0 0 1620 860" xmlns="http://www.w3.org/2000/svg" font-family="Inter,Segoe UI,Arial">
  <defs><marker id="a" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M0 0L10 5L0 10z" fill="${VIOLET}"/></marker></defs>
  <text x="20" y="40" font-size="22" letter-spacing="4" fill="#6d7488" font-weight="700">ON YOUR PC</text>
  <rect x="10" y="60" width="1180" height="780" rx="28" fill="none" stroke="#2a3046" stroke-dasharray="10 10" stroke-width="2"/>
  ${box(50, 100, 500, 300, "OBS plugin", ["Native C/C++ filter", "YUV delay ring holds frames", "Solid masks drawn before encode", "Fail-closed hold on timeout"], true)}
  ${box(650, 100, 500, 300, "Local OCR detector", ["Python, ONNX OCR", "Incremental: reads only", "changed regions", "Returns boxes, never text"])}
  ${box(50, 500, 500, 300, "Encrypted vault", ["Never Show terms", "PIN-locked, encrypted at rest", "Hashes only leave the vault"])}
  ${box(650, 500, 500, 300, "VEIL app", ["Electron + React", "Chat guard: lookalike and split", "message matching", "Panic: cover, mute, marker"], true)}
  ${box(1280, 300, 320, 300, "Twitch", ["EventSub chat", "Helix moderation", "Stream markers"])}
  ${arrow(550, 220, 645, 220, "frames")}
  ${arrow(650, 290, 555, 290, "mask boxes")}
  ${arrow(900, 400, 900, 495, "detections")}
  ${arrow(550, 650, 645, 650, "terms")}
  ${arrow(1150, 600, 1275, 520, "")}
  ${arrow(1275, 400, 1150, 520, "")}
  <text x="1440" y="650" font-size="20" fill="#b6a5ff" text-anchor="middle">delete + marker</text>
  <text x="1440" y="280" font-size="20" fill="#b6a5ff" text-anchor="middle">chat events</text>
  </svg>`;
  return card("Everything sensitive stays <em>local</em>.", "", svg);
}
function hero(r) {
  const msg = (user, color, text, removed) => `<div style="padding:12px 0;font-size:24px;line-height:1.35;border-bottom:1px solid #1f2333">
    <b style="color:${color}">${user}</b>: <span style="${removed ? "text-decoration:line-through;text-decoration-thickness:3px;color:#6f7690" : "color:#e6e8f0"}">${esc(text)}</span>
    ${removed ? `<span style="display:inline-block;margin-left:8px;padding:3px 12px;border-radius:999px;background:${VIOLET};color:#fff;font-size:16px;font-weight:700;letter-spacing:1px;vertical-align:middle;text-decoration:none">REMOVED BY VEIL</span>` : ""}</div>`;
  const chat = `<div style="width:560px;height:100%;background:#18181b;border-radius:16px;box-shadow:0 30px 80px rgba(0,0,0,.6),0 0 0 1px rgba(182,165,255,.18);padding:22px 26px;font-family:Inter,Segoe UI,Arial">
    <div style="font-size:18px;letter-spacing:3px;font-weight:700;color:#adadb8;border-bottom:1px solid #2a2a30;padding-bottom:14px">STREAM CHAT</div>
    ${msg("pixel_fox", "#ff7ab6", "that clutch was insane", false)}
    ${msg("viewer_1", "#7ad7ff", "742 Evergr33n Terr4ce lol", true)}
    ${msg("nightowl", "#b9f391", "gg, what's next?", false)}
    ${msg("viewer_2", "#ffb36b", "742", true)}
    ${msg("viewer_2", "#ffb36b", "evergreen", true)}
    ${msg("viewer_2", "#ffb36b", "terrace", true)}
    ${msg("mod_kai", "#b6a5ff", "keep it friendly, chat", false)}</div>`;
  return card(
    "Private info never reaches your stream <em>— or your chat.</em>",
    "",
    `<div style="display:flex;gap:44px;height:100%;width:100%;align-items:stretch">
      <div style="flex:1;position:relative;display:flex;align-items:center">
        <img class="frame" style="width:100%" src="${dataUrl(r("hero-inbox.png"))}">
        <img style="position:absolute;left:-20px;bottom:-10px;width:420px;filter:drop-shadow(0 20px 40px rgba(0,0,0,.6))" src="${dataUrl(r("hero-badge.png"))}">
      </div>${chat}</div>`,
  ).replace("font-size:72px", "font-size:62px");
}
function codex(s) {
  const tile = (n, label) => `<div style="background:#141826;border:1px solid #2a3046;border-radius:20px;padding:34px 30px">
   <div style="font-size:84px;font-weight:800;color:${VIOLET};line-height:1">${n}</div>
   <div style="margin-top:14px;font-size:26px;color:#c4cadb">${esc(label)}</div></div>`;
  return card(
    "Built with <em>OpenAI Codex</em>.",
    "",
    `<div style="width:100%"><div style="text-align:center;margin-bottom:40px"><div style="font-size:170px;font-weight:800;color:${VIOLET};line-height:1;letter-spacing:-4px">${esc(s.big[0])}</div><div style="font-size:34px;color:#c4cadb;margin-top:10px">${esc(s.big[1])}</div></div><div style="display:grid;grid-template-columns:repeat(3,1fr);gap:28px">
     ${s.tiles.map(([n, l]) => tile(n, l)).join("")}</div>
     <div style="margin-top:44px;text-align:center;font-size:24px;color:#7d859b;font-family:Consolas,monospace">Codex session ${esc(s.session)}</div></div>`,
  );
}

const mode = process.argv[2];
if (mode === "capture") await capture();
else if (mode === "compose") await compose();
else console.log("usage: node scripts/gallery.mjs capture|compose");
