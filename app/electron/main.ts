import {
  app,
  BrowserWindow,
  ipcMain,
  safeStorage,
  globalShortcut,
  Notification,
  shell,
  dialog,
} from "electron";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import WebSocket from "ws";
import { Store } from "./store/store.js";
import {
  defaultSettings,
  patchSettings,
  type Settings,
} from "./store/settings.js";
import { Vault, tokenPersistence, type Category } from "./vault/vault.js";
import { localCredential, Supervisor } from "./supervisor.js";
import { ObsClient } from "./obs/client.js";
import { TwitchAuth, type DeviceCode } from "./twitch/auth.js";
import { Helix } from "./twitch/helix.js";
import { EventSub } from "./twitch/eventsub.js";
import { ChatGuard, type GuardEvent } from "./guard/chat-guard.js";
import {
  IncidentEngine,
  type Action,
  type Incident,
  type IncidentActions,
} from "./incidents/engine.js";
import { report } from "./incidents/report.js";
import { preflight } from "./preflight/preflight.js";
import { scanSources } from "./preflight/source-scan.js";
import { RehearsalActions, SCENARIOS } from "./rehearsal/rehearsal.js";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "../..");
const text = (value: unknown, max = 500): string => {
  if (typeof value !== "string" || value.length > max)
    throw new Error("Invalid input");
  return value;
};
const number = (value: unknown, min: number, max: number): number => {
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    value < min ||
    value > max
  )
    throw new Error("Value outside allowed range");
  return value;
};
const defaults = defaultSettings();
let window: BrowserWindow,
  store: Store,
  vault: Vault,
  detector: Supervisor,
  obs: ObsClient,
  auth: TwitchAuth,
  helix: Helix | undefined,
  eventsub: EventSub | undefined,
  liveGuard: ChatGuard | undefined,
  liveEngine: IncidentEngine | undefined,
  settings: Settings;
let credentialPath = "",
  twitchReady = false,
  detectorReady = false,
  device: DeviceCode | undefined,
  authCancel: AbortController | undefined;
let rehearsal = true;
let detectorEvents: WebSocket | undefined;
let masks = 0;
const feed: { time: string; kind: string; detail: string }[] = [];
const pendingAsks = new Map<string, (yes: boolean) => void>();
let mockActions: RehearsalActions,
  mockGuard: ChatGuard,
  mockEngine: IncidentEngine;
let scanSequence = 0;
let startupStage = "initializing",
  startupFault = "",
  shutdownReason = "";
function persistSettings(): void {
  const { discord, ...publicSettings } = settings;
  store.set("settings", publicSettings);
  if (discord)
    store.set(
      "discordWebhook",
      safeStorage.encryptString(discord).toString("base64"),
    );
  else store.remove("discordWebhook");
}
const notify = () => {
  if (quitting) return;
  if (window && !window.isDestroyed())
    window.webContents.send("veil:state", snapshot());
};
const event = (kind: string, detail: string) => {
  if (quitting) return;
  feed.unshift({ time: new Date().toISOString(), kind, detail });
  feed.splice(150);
  notify();
};
const activeGuard = () => (rehearsal ? mockGuard : liveGuard);
const activeEngine = () => (rehearsal ? mockEngine : liveEngine);
function snapshot() {
  return {
    rehearsal,
    settings: { ...settings, discord: settings.discord ? "configured" : "" },
    obs: obs?.connected ?? false,
    detector: detectorReady,
    detectorProcess: detector?.diagnostic(),
    lifecycle: { startupStage, startupFault, quitting, shutdownReason },
    twitch: twitchReady,
    eventsub: eventsub?.connected ?? false,
    vault: vault?.list() ?? [],
    hasPin: vault?.hasPin() ?? false,
    incidents: activeEngine()?.incidents ?? [],
    feed,
    masks,
    removed: activeGuard()?.removed ?? 0,
    device: device
      ? {
          user_code: device.user_code,
          verification_uri: device.verification_uri,
        }
      : undefined,
    tokenFile: credentialPath,
  };
}
function onGuard(value: GuardEvent): void {
  event(
    value.kind,
    `${value.user} / ${value.category} / ${value.duration_ms.toFixed(1)} ms`,
  );
  if (value.kind === "deleted") activeEngine()?.attempt(value.user);
}
async function ask(action: Action): Promise<boolean> {
  if (!window || window.isDestroyed()) return false;
  const id = randomUUID();
  if (Notification.isSupported())
    new Notification({
      title: "VEIL action approval",
      body: `Allow ${action}? Defaults to No in 10 seconds.`,
    }).show();
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      pendingAsks.delete(id);
      window.webContents.send("veil:ask-expired", id);
      resolve(false);
    }, 10000);
    pendingAsks.set(id, (yes) => {
      clearTimeout(timer);
      pendingAsks.delete(id);
      resolve(yes);
    });
    window.webContents.send("veil:ask", {
      id,
      action,
      expires: Date.now() + 10000,
    });
  });
}
async function syncVault(force = false): Promise<void> {
  const terms = vault
    .terms()
    .map((e) => ({ text: e.text, category: e.category }));
  liveGuard?.setTerms(terms);
  mockGuard.setTerms([
    { text: "123 Main St", category: "address" },
    { text: "Synthetic Maple Academy", category: "school" },
  ]);
  if (detectorReady || force)
    await detector.request("/v1/vault", "PUT", {
      terms: terms.map((t) => t.text),
    });
  notify();
}
async function setPolicy(force = false): Promise<void> {
  if (detectorReady || force)
    await detector.request("/v1/policy", "PUT", {
      profile: settings.profile,
      ignore_zones: settings.ignoreZones,
      denylist: settings.denylist,
      enabled: settings.recognizers,
      thresholds: settings.thresholds,
    });
}
async function setupTwitch(): Promise<void> {
  const valid = await auth.validate();
  twitchReady = true;
  helix = new Helix(auth, valid.user_id);
  liveGuard = new ChatGuard(helix, onGuard, () => {
    void liveEngine?.open("spike");
  });
  const actions: IncidentActions = {
    cover: () => obs.cover(),
    guard: async (terms) => {
      liveGuard!.addSessionTerms(terms);
    },
    retroactive: () => liveGuard!.retroactive(),
    marker: async (id) => (await helix!.marker(id)).data[0],
    shield: async () => {
      await helix!.shield(true);
    },
    blocked: async (terms) => {
      for (const term of terms) await helix!.blockedTerm(term);
    },
    notice: async () => {
      await helix!.notice();
    },
    discord: async (incident) => {
      if (!settings.discord) throw new Error("Discord webhook not configured");
      const response = await fetch(settings.discord, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          content: `VEIL incident #${incident.id} at ${incident.started}. ${incident.actions.filter((a) => a.status === "success").length} actions completed. Review VEIL locally.`,
        }),
        redirect: "error",
        signal: AbortSignal.timeout(10000),
      });
      if (!response.ok) throw new Error("Discord notification failed");
    },
    clips: (start, end) => helix!.clips(start, end),
  };
  liveEngine?.dispose();
  liveEngine = new IncidentEngine(
    actions,
    ask,
    (incidents) => store.set("incidents", incidents),
    notify,
  );
  const cutoff = Date.now() - settings.retentionDays * 86400000;
  liveEngine.incidents = store
    .get<Incident[]>("incidents", [])
    .filter((i) => Date.parse(i.started) >= cutoff);
  liveEngine.modes = { ...settings.modes };
  eventsub?.stop();
  eventsub = new EventSub(
    helix,
    (message) => {
      void liveGuard!.receive(message);
    },
    (status) => event("Twitch", status),
  );
  eventsub.start();
  await syncVault();
  notify();
}
async function panic(
  trigger: Incident["trigger"] = "panic",
  terms: string[] = [],
): Promise<void> {
  const engine = activeEngine();
  if (!engine)
    throw new Error(
      "Connect Twitch or enable rehearsal before opening an incident",
    );
  const incident = await engine.open(trigger, terms);
  if (
    trigger === "panic" &&
    engine.modes.cover === "auto" &&
    incident.actions.filter((a) => a.action === "cover").at(-1)?.status ===
      "error"
  )
    throw new Error(
      "Incident opened, but OBS cover failed. Check OBS immediately.",
    );
  notify();
}
async function detectImage(
  png: Buffer,
  stream: string,
): Promise<{
  processed_ms: number;
  detections: {
    kind: string;
    box: { x: number; y: number; w: number; h: number };
  }[];
}> {
  const response = await fetch(detector.url + "/v1/frames", {
    method: "POST",
    headers: {
      Authorization: "Bearer " + detector.token,
      "X-Veil-Frame": JSON.stringify({
        frame_id: ++scanSequence,
        timestamp_ns: Math.round(performance.now() * 1e6),
        stream_id: stream,
      }),
    },
    body: new Uint8Array(png),
    signal: AbortSignal.timeout(60000),
  });
  if (!response.ok) throw new Error("Could not scan frame");
  return (await response.json()) as {
    processed_ms: number;
    detections: {
      kind: string;
      box: { x: number; y: number; w: number; h: number };
    }[];
  };
}
async function scenario(kind: keyof typeof SCENARIOS) {
  if (!detectorReady)
    throw new Error(
      "Local detector is starting or unavailable. Wait for the connection badge before rehearsing.",
    );
  const entry = SCENARIOS[kind];
  if (!entry) throw new Error("Unknown rehearsal scenario");
  const preview = new BrowserWindow({
    show: false,
    width: 1280,
    height: 720,
    webPreferences: {
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  try {
    const html = `<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'"><style>body{margin:0;background:#111827;color:#e8eef9;font:24px Arial}header{padding:40px;background:#202b40}main{margin:80px;padding:44px;background:#263246;border:1px solid #67758b;border-radius:16px}small{color:#a5b4c8}</style><header>VEIL / SYNTHETIC REHEARSAL</header><main><small>${entry.title}</small><h2>${entry.label}</h2><p>${entry.value}</p></main>`;
    await preview.loadURL(
      "data:text/html;charset=utf-8," + encodeURIComponent(html),
    );
    await new Promise((r) => setTimeout(r, 100));
    const image = await preview.webContents.capturePage(),
      png = image.toPNG();
    const result = await detectImage(png, "rehearsal-" + kind);
    const late =
      result.processed_ms + 1000 / settings.sampleFps + 100 > settings.delay;
    const masked = settings.profile === "paranoid" || !late;
    event(
      "rehearsal",
      `${kind}: ${result.processed_ms.toFixed(1)} ms / ${late ? "late; Balanced cannot guarantee masking" : "within budget"}`,
    );
    return {
      kind,
      image: image.toDataURL(),
      ...result,
      late,
      masked: masked && result.detections.length > 0,
      fullHold: late && settings.profile === "paranoid",
      mode: "synthetic capture; detector measured; native OBS output unverified",
    };
  } finally {
    preview.destroy();
  }
}
function installHandlers(): void {
  ipcMain.handle(
    "veil:command",
    async (event_, command: unknown, input: unknown) => {
      if (
        event_.sender !== window.webContents ||
        event_.senderFrame !== window.webContents.mainFrame
      )
        throw new Error("Untrusted caller");
      const op = text(command, 40),
        data = (input && typeof input === "object" ? input : {}) as Record<
          string,
          unknown
        >;
      try {
        if (op === "snapshot") return { ok: true, value: snapshot() };
        if (op === "obs-connect") {
          settings.obsUrl = text(data.url, 200);
          await obs.connect(settings.obsUrl, text(data.password, 200));
          await obs.createCover(join(here, "rehearsal/cover.html"));
          persistSettings();
        } else if (op === "obs-scenes")
          return { ok: true, value: await obs.scenes() };
        else if (op === "obs-install") {
          if (!Array.isArray(data.scenes)) throw new Error("Select scenes");
          await obs.install(
            data.scenes.map((s) => text(s, 200)),
            credentialPath,
            settings.delay,
            settings.profile === "paranoid"
              ? 2
              : settings.profile === "off"
                ? 0
                : 1,
          );
        } else if (op === "auth-begin") {
          device = await auth.begin();
          authCancel?.abort();
          authCancel = new AbortController();
          void auth
            .poll(device, authCancel.signal)
            .then(async () => {
              device = undefined;
              await setupTwitch();
              event("Twitch", "Sign-in complete");
            })
            .catch(() =>
              event("Twitch", "Sign-in did not complete; start again"),
            );
        } else if (op === "open-twitch") {
          if (!device) throw new Error("Start sign-in first");
          const url = new URL(device.verification_uri);
          if (url.protocol !== "https:" || url.hostname !== "www.twitch.tv")
            throw new Error("Unexpected sign-in URL");
          await shell.openExternal(url.href);
        } else if (op === "vault-add") {
          vault.add(text(data.text), text(data.category, 20) as Category);
          await syncVault();
        } else if (op === "vault-edit") {
          vault.edit(
            text(data.id, 50),
            text(data.text),
            text(data.category, 20) as Category,
          );
          await syncVault();
        } else if (op === "vault-import") {
          const terms = text(data.text, 20000)
            .split(/\r?\n/)
            .map((t) => t.trim())
            .filter(Boolean);
          if (
            terms.some((t) => t.length > 500) ||
            terms.length + vault.list().length > 1000
          )
            throw new Error("Import exceeds vault limits");
          for (const term of terms)
            vault.add(term, text(data.category, 20) as Category);
          await syncVault();
        } else if (op === "vault-pin") vault.setPin(text(data.pin, 12));
        else if (op === "vault-unlock") vault.unlock(text(data.pin, 12));
        else if (op === "vault-reveal")
          return { ok: true, value: vault.reveal(text(data.id, 50)) };
        else if (op === "vault-delete") {
          const id = text(data.id, 50),
            entry = vault.terms().find((e) => e.id === id);
          if (entry?.blockedTermId) {
            if (!helix)
              throw new Error(
                "Reconnect Twitch before removing an opted-in term",
              );
            await helix.removeBlockedTerm(entry.blockedTermId);
          }
          vault.remove(id);
          await syncVault();
        } else if (op === "vault-optin") {
          if (!helix) throw new Error("Connect Twitch first");
          const id = text(data.id, 50),
            entry = vault.terms().find((e) => e.id === id);
          if (!entry) throw new Error("Entry missing");
          if (data.confirm !== true)
            throw new Error(
              "Explicit confirmation required: moderators can read Twitch blocked terms",
            );
          if (entry.blockedTermId) {
            await helix.removeBlockedTerm(entry.blockedTermId);
            vault.markOptIn(id, undefined);
          } else {
            const result = await helix.blockedTerm(entry.text);
            vault.markOptIn(id, result.data[0].id);
          }
          notify();
        } else if (op === "vault-wipe") {
          if (data.confirm !== true) throw new Error("Confirm vault wipe");
          if (vault.terms().some((e) => e.blockedTermId))
            throw new Error(
              "Remove opted-in Twitch blocked terms before wiping",
            );
          vault.wipe();
          await syncVault();
        } else if (op === "panic") await panic();
        else if (op === "incident-open")
          await panic(
            "manual",
            typeof data.text === "string" && data.text ? [text(data.text)] : [],
          );
        else if (op === "incident-close")
          activeEngine()?.close(number(data.id, 1, 1000000));
        else if (op === "incident-clips") {
          const incident = activeEngine()?.incidents.find(
            (i) => i.id === data.id,
          );
          if (incident) await activeEngine()?.collectClips(incident);
        } else if (op === "ask") {
          pendingAsks.get(text(data.id, 50))?.(data.yes === true);
        } else if (op === "source-scan") {
          if (!detectorReady)
            throw new Error("Local detector is starting or unavailable");
          return { ok: true, value: await scanSources(obs, detector) };
        } else if (op === "preflight")
          return {
            ok: true,
            value: await preflight(
              obs,
              detector,
              settings.delay,
              settings.sampleFps,
              new Set(vault.list().map((e) => e.category)).size,
              twitchReady,
              eventsub?.connected ?? false,
            ),
          };
        else if (op === "rehearsal") {
          rehearsal = data.enabled === true;
          notify();
        } else if (op === "scenario")
          return {
            ok: true,
            value: await scenario(
              text(data.kind, 20) as keyof typeof SCENARIOS,
            ),
          };
        else if (op === "simulate-chat") {
          if (!rehearsal) throw new Error("Switch to rehearsal first");
          for (let i = 0; i < 5; i++)
            await mockGuard.receive({
              id: randomUUID(),
              userId: "synthetic-" + (i % 3),
              login: "viewer_" + (i % 3),
              text: i === 0 ? "hello everyone" : "1 2 3 m4in st",
              timestamp: Date.now(),
              privileged: false,
            });
        } else if (op === "export") {
          const incident = activeEngine()?.incidents.find(
            (i) => i.id === data.id,
          );
          if (!incident) throw new Error("Incident missing");
          const include = data.includePrivate === true;
          if (include) {
            vault.unlock(text(data.pin, 12));
          }
          const content = report(
            incident,
            include ? vault.terms().map((t) => t.text) : undefined,
          );
          const pdf = data.format === "pdf";
          const destination = await dialog.showSaveDialog(window, {
            defaultPath: `veil-incident-${incident.id}.${pdf ? "pdf" : "md"}`,
            filters: [
              {
                name: pdf ? "PDF" : "Markdown",
                extensions: [pdf ? "pdf" : "md"],
              },
            ],
          });
          if (destination.canceled || !destination.filePath)
            return { ok: true, value: "Export cancelled" };
          if (pdf) {
            const page = new BrowserWindow({
              show: false,
              webPreferences: { sandbox: true, nodeIntegration: false },
            });
            try {
              const escaped = content
                .replace(/&/g, "&amp;")
                .replace(/</g, "&lt;")
                .replace(/>/g, "&gt;");
              await page.loadURL(
                "data:text/html;charset=utf-8," +
                  encodeURIComponent(
                    '<meta charset="utf-8"><pre style="white-space:pre-wrap;font:12px Arial;line-height:1.6">' +
                      escaped +
                      "</pre>",
                  ),
              );
              writeFileSync(
                destination.filePath,
                await page.webContents.printToPDF({ printBackground: true }),
              );
            } finally {
              page.destroy();
            }
          } else writeFileSync(destination.filePath, content, { mode: 0o600 });
          return { ok: true, value: "Report exported" };
        } else if (op === "logs-export") {
          const destination = await dialog.showSaveDialog(window, {
            defaultPath: "veil-diagnostics.json",
            filters: [{ name: "JSON", extensions: ["json"] }],
          });
          if (!destination.canceled && destination.filePath)
            writeFileSync(
              destination.filePath,
              JSON.stringify(
                {
                  version: app.getVersion(),
                  platform: process.platform,
                  created: new Date().toISOString(),
                  connections: {
                    obs: obs.connected,
                    detector: detectorReady,
                    twitch: twitchReady,
                    eventsub: eventsub?.connected ?? false,
                  },
                  detectorProcess: detector.diagnostic(),
                  configuration: {
                    profile: settings.profile,
                    delay: settings.delay,
                    sampleFps: settings.sampleFps,
                  },
                  counts: {
                    masks,
                    removed: activeGuard()?.removed ?? 0,
                    incidents: activeEngine()?.incidents.length ?? 0,
                  },
                },
                null,
                2,
              ),
              { mode: 0o600 },
            );
          return {
            ok: true,
            value: destination.canceled
              ? "Export cancelled"
              : "Metadata diagnostics exported",
          };
        } else if (op === "settings") {
          const previous = settings,
            next = patchSettings(settings, data);
          const hotkeyChanged = next.hotkey !== previous.hotkey;
          if (
            hotkeyChanged &&
            !globalShortcut.register(next.hotkey, () => {
              void panic().catch(() =>
                event("panic", "Panic failed; check OBS connection"),
              );
            })
          )
            throw new Error("Hotkey unavailable");
          settings = next;
          try {
            await setPolicy();
            if (
              obs.connected &&
              (next.delay !== previous.delay ||
                next.profile !== previous.profile ||
                next.sampleFps !== previous.sampleFps)
            ) {
              await obs.install(
                (await obs.scenes()).filter((s) => s !== "VEIL Cover"),
                credentialPath,
                next.delay,
                next.profile === "off"
                  ? 0
                  : next.profile === "paranoid"
                    ? 2
                    : 1,
                next.sampleFps,
              );
              if (next.profile === "off") await obs.restoreAudio();
            }
            persistSettings();
            if (liveEngine) liveEngine.modes = { ...next.modes };
            if (hotkeyChanged) globalShortcut.unregister(previous.hotkey);
          } catch (error) {
            settings = previous;
            if (hotkeyChanged) globalShortcut.unregister(next.hotkey);
            await setPolicy().catch(() =>
              event("detector", "Policy rollback pending connection"),
            );
            throw error;
          }
        } else if (op === "external") {
          const target = text(data.target, 30);
          if (!["clips", "videos"].includes(target))
            throw new Error("Unknown destination");
          await shell.openExternal(
            target === "clips"
              ? "https://dashboard.twitch.tv/content/clips"
              : "https://dashboard.twitch.tv/content/video-producer",
          );
        } else throw new Error("Unknown operation");
        notify();
        return { ok: true, value: snapshot() };
      } catch (error) {
        return {
          ok: false,
          error: error instanceof Error ? error.message : "Operation failed",
        };
      }
    },
  );
}
async function start(): Promise<void> {
  app.setName("VEIL");
  if (process.env.VEIL_DATA_DIR)
    app.setPath("userData", resolve(process.env.VEIL_DATA_DIR));
  const config = app.getPath("userData");
  store = new Store(join(config, "veil.sqlite"));
  settings = { ...defaults, ...store.get<Partial<Settings>>("settings", {}) };
  const encryptedWebhook = store.get<string | undefined>(
    "discordWebhook",
    undefined,
  );
  if (encryptedWebhook)
    settings.discord = safeStorage.decryptString(
      Buffer.from(encryptedWebhook, "base64"),
    );
  const credential = localCredential(config);
  credentialPath = credential.path;
  const localPort = Number(process.env.VEIL_PORT ?? 47321);
  if (!Number.isInteger(localPort) || localPort < 1024 || localPort > 65535)
    throw new Error("Invalid local detector port");
  detector = new Supervisor(credential.token, `http://127.0.0.1:${localPort}`);
  vault = new Vault(store, safeStorage);
  obs = new ObsClient(store);
  let clientId = process.env.TWITCH_CLIENT_ID ?? "";
  const envPath = join(root, ".env");
  if (!clientId && existsSync(envPath)) {
    const source = readFileSync(envPath, "utf8");
    clientId =
      source.match(/^TWITCH_CLIENT_ID\s*=\s*["']?([^\r\n"']*)/m)?.[1]?.trim() ??
      "";
  }
  auth = new TwitchAuth(clientId, tokenPersistence(store, safeStorage));
  mockActions = new RehearsalActions();
  mockGuard = new ChatGuard(mockActions, onGuard, () => {
    void mockEngine.open("spike");
  });
  mockEngine = new IncidentEngine(
    mockActions.incidentActions(mockGuard),
    ask,
    () => {},
    notify,
    true,
  );
  const unavailable = async (): Promise<never> => {
    throw new Error("Twitch authorization required");
  };
  liveGuard = new ChatGuard(
    { deleteMessage: unavailable, timeout: unavailable },
    onGuard,
    () => {
      void liveEngine?.open("spike");
    },
  );
  liveEngine = new IncidentEngine(
    {
      cover: () => obs.cover(),
      guard: async (terms) => {
        liveGuard!.addSessionTerms(terms);
      },
      retroactive: () => liveGuard!.retroactive(),
      marker: unavailable,
      shield: unavailable,
      blocked: unavailable,
      notice: unavailable,
      discord: unavailable,
      clips: unavailable,
    },
    ask,
    (incidents) => store.set("incidents", incidents),
    notify,
  );
  liveEngine.incidents = store.get<Incident[]>("incidents", []);
  liveEngine.modes = { ...settings.modes };
  window = new BrowserWindow({
    width: 1440,
    height: 960,
    minWidth: 980,
    minHeight: 700,
    backgroundColor: "#0c1018",
    title: "VEIL — local stream privacy",
    webPreferences: {
      preload: join(here, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  window.webContents.on("will-navigate", (e) => e.preventDefault());
  installHandlers();
  if (
    !globalShortcut.register(settings.hotkey, () => {
      void panic().catch(() =>
        event("panic", "Could not cover stream; check connections"),
      );
    })
  )
    event("hotkey", "Could not register panic shortcut; use the panic button");
  await window.loadFile(join(here, "../dist/index.html"));
  const executable = app.isPackaged
    ? join(
        process.resourcesPath,
        "detector",
        process.platform === "win32" ? "veil-detector.exe" : "veil-detector",
      )
    : join(
        root,
        "detector/.venv",
        process.platform === "win32" ? "Scripts/python.exe" : "bin/python",
      );
  try {
    await detector.start(
      executable,
      app.isPackaged ? [] : ["-m", "veil_detector.server"],
      app.isPackaged ? undefined : join(root, "detector"),
    );
    startupStage = "synchronizing vault";
    await syncVault(true);
    startupStage = "configuring detector";
    await setPolicy(true);
    detectorReady = true;
    startupStage = "connecting detector events";
    detectorEvents = new WebSocket(
      detector.url.replace("http:", "ws:") + "/v1/events",
      { headers: { Authorization: "Bearer " + detector.token } },
    );
    detectorEvents.on("message", (raw) => {
      try {
        const frame = JSON.parse(raw.toString()) as {
          type: string;
          stream_id?: string;
          result?: { detections: unknown[] };
        };
        if (frame.type === "late_result") {
          event("late result", "Balanced output missed a detector deadline");
          if (!rehearsal && frame.stream_id)
            void detector
              .request("/v1/incident-text", "POST", {
                stream_id: frame.stream_id,
              })
              .then((value) =>
                liveEngine?.open(
                  "late",
                  Array.isArray(value.texts)
                    ? value.texts.filter(
                        (v): v is string => typeof v === "string",
                      )
                    : [],
                ),
              )
              .catch(() =>
                event("incident", "Could not open late-result incident"),
              );
        }
        if (frame.result?.detections.length) {
          masks += frame.result.detections.length;
          event(
            "detection",
            `${frame.result.detections.length} private regions found`,
          );
        }
      } catch {
        event("detector", "Invalid detector event");
      }
    });
    detectorEvents.on("error", () =>
      event("detector", "Detector event connection unavailable"),
    );
    detectorEvents.on("close", (code) => {
      if (quitting) return;
      event(
        "detector",
        `Event connection closed (${code}); checking HTTP health`,
      );
      void detector
        .request("/v1/health")
        .then(() => {
          detectorReady = true;
          notify();
        })
        .catch(() => {
          detectorReady = false;
          notify();
        });
    });
  } catch {
    event(
      "detector",
      "Detector failed to start. Local protection is not verified.",
    );
  }
  try {
    await setupTwitch();
  } catch {
    event("Twitch", "Sign in to enable live chat protection");
  }
  const hourly = setInterval(() => {
    if (twitchReady)
      void auth.validate().catch(() => {
        twitchReady = false;
        eventsub?.stop();
        event("Twitch", "Authorization expired or revoked; sign in again");
      });
  }, 3600000);
  hourly.unref();
  startupStage = "ready";
  notify();
}
let quitting = false;
app.on("before-quit", (event_) => {
  if (quitting) return;
  event_.preventDefault();
  quitting = true;
  const recordShutdown = (stage: string) =>
    writeFileSync(
      join(app.getPath("userData"), "shutdown.json"),
      JSON.stringify({ stage, time: new Date().toISOString() }),
    );
  recordShutdown("requested");
  authCancel?.abort();
  eventsub?.stop();
  detectorEvents?.close();
  globalShortcut.unregisterAll();
  mockEngine?.dispose();
  liveEngine?.dispose();
  void (async () => {
    try {
      if (obs?.connected) await obs.disconnect();
      recordShutdown("audio-restored");
    } catch {
      store?.set("audioRestorePending", true);
    } finally {
      detector?.stop();
      recordShutdown("detector-stopped");
      vault?.dispose();
      store?.close();
      recordShutdown("clean");
      app.exit(0);
    }
  })();
});
app.on("window-all-closed", () => {
  shutdownReason = "window-all-closed";
  app.quit();
});
app.commandLine.appendSwitch("disable-background-networking");
app.commandLine.appendSwitch("disable-component-update");
void app
  .whenReady()
  .then(start)
  .catch((error: unknown) => {
    startupFault = error instanceof Error ? error.message : "Startup failed";
    shutdownReason = "startup error";
    dialog.showErrorBox(
      "VEIL could not start",
      "Secure storage or local configuration is unavailable. Review installation and restart VEIL.",
    );
    app.quit();
  });
