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
  loadSettings,
  patchSettings,
  startupRehearsal,
  type Settings,
} from "./store/settings.js";
import { Vault, tokenPersistence } from "./vault/vault.js";
import { localCredential, Supervisor } from "./supervisor.js";
import { ObsClient } from "./obs/client.js";
import {
  AuthUnavailableError,
  TwitchAuth,
  type DeviceCode,
} from "./twitch/auth.js";
import { Helix } from "./twitch/helix.js";
import { EventSub } from "./twitch/eventsub.js";
import {
  ChatGuard,
  type GuardActions,
  type GuardEvent,
} from "./guard/chat-guard.js";
import { liveChatHandler } from "./guard/live-chat.js";
import {
  IncidentEngine,
  type Action,
  type Answer,
  type Incident,
  type IncidentActions,
} from "./incidents/engine.js";
import { report } from "./incidents/report.js";
import { scanSources } from "./preflight/source-scan.js";
import {
  PRACTICE_TERMS,
  practiceChat,
  RehearsalActions,
  SCENARIOS,
} from "./rehearsal/rehearsal.js";
import { dispatch, reply, text, type Commands } from "./ipc/dispatch.js";
import { vaultCommands } from "./ipc/vault-commands.js";
import { incidentCommands } from "./ipc/incident-commands.js";
import { COVER_SCENE, obsCommands, profileLevel } from "./ipc/obs-commands.js";
import { OverlayServer } from "./overlay/server.js";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "../..");
const ASK_TIMEOUT_MS = 10000;
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
  settings: Settings,
  overlay: OverlayServer | undefined;
let credentialPath = "",
  twitchReady = false,
  twitchLogin = "",
  detectorReady = false,
  device: DeviceCode | undefined,
  authCancel: AbortController | undefined,
  twitchRetry: ReturnType<typeof setTimeout> | undefined,
  twitchRetryDelay = 60000;
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
  const state = snapshot();
  // Counts and timestamps only; the overlay server never sees text.
  overlay?.update({
    armed: state.protectionActive,
    masks: state.masks,
    removed: state.removed,
  });
  if (window && !window.isDestroyed())
    window.webContents.send("veil:state", state);
};
const event = (kind: string, detail: string) => {
  if (quitting) return;
  feed.unshift({ time: new Date().toISOString(), kind, detail });
  feed.splice(150);
  notify();
};
const activeGuard = () => (rehearsal ? mockGuard : liveGuard);
const activeEngine = () => (rehearsal ? mockEngine : liveEngine);
const eventsubConnected = () => eventsub?.connected ?? false;
function snapshot() {
  const chatGuard = twitchReady && eventsubConnected();
  return {
    rehearsal,
    /** Live chat moderation and OBS cover are both armed for real. */
    protectionActive: !rehearsal && chatGuard && (obs?.connected ?? false),
    protection: {
      live: !rehearsal,
      chatGuard,
      obs: obs?.connected ?? false,
    },
    onboardingComplete: settings?.onboardingComplete ?? false,
    channel: {
      login: helix?.broadcasterLogin || settings?.protectedChannel || "",
      moderating: Boolean(helix && helix.broadcasterId !== helix.userId),
    },
    settings: { ...settings, discord: settings.discord ? "configured" : "" },
    obs: obs?.connected ?? false,
    detector: detectorReady,
    detectorProcess: detector?.diagnostic(),
    lifecycle: { startupStage, startupFault, quitting, shutdownReason },
    twitch: twitchReady,
    twitchClientId: auth?.clientId ?? "",
    eventsub: eventsubConnected(),
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
    overlayUrl: overlay?.url ?? "",
  };
}
function onGuard(value: GuardEvent, engine = activeEngine()): void {
  event(
    value.kind,
    `${value.user} / ${value.category} / ${value.duration_ms.toFixed(1)} ms`,
  );
  if (value.kind === "deleted") engine?.attempt(value.user);
}
async function ask(action: Action): Promise<Answer> {
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
      event("approval", `${action} declined (timeout)`);
      resolve("timeout");
    }, ASK_TIMEOUT_MS);
    pendingAsks.set(id, (yes) => {
      clearTimeout(timer);
      pendingAsks.delete(id);
      resolve(yes);
    });
    window.webContents.send("veil:ask", {
      id,
      action,
      expires: Date.now() + ASK_TIMEOUT_MS,
    });
  });
}
async function syncVault(force = false): Promise<void> {
  const terms = vault
    .terms()
    .map((e) => ({ text: e.text, category: e.category }));
  liveGuard?.setTerms(terms);
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
async function postDiscord(incident: Incident): Promise<void> {
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
}
// No connected guards: ObsClient queues a cover while a reconnect is pending
// and throws when OBS is gone, so the engine records the failure instead of
// a silent skip.
const localObs = {
  cover: () => obs.cover(),
  mute: () => obs.muteInputs(),
  unmute: () => obs.unmuteInputs(),
};
function liveEngineFor(actions: IncidentActions): IncidentEngine {
  const previous = liveEngine;
  previous?.dispose();
  const engine = new IncidentEngine(
    actions,
    ask,
    (incidents) => store.set("incidents", incidents),
    notify,
  );
  engine.incidents =
    previous?.incidents ?? store.get<Incident[]>("incidents", []);
  engine.retain(settings.retentionDays);
  engine.modes = { ...settings.modes };
  return engine;
}
function newLiveGuard(actions: GuardActions): ChatGuard {
  return new ChatGuard(
    actions,
    (value) => onGuard(value, liveEngine),
    () => {
      void liveEngine?.open("spike");
    },
  );
}
async function setupTwitch(): Promise<void> {
  const valid = await auth.validate();
  const client = new Helix(auth, valid.user_id);
  await client.useChannel(settings.protectedChannel, valid.login);
  helix = client;
  twitchLogin = valid.login;
  twitchReady = true;
  clearTimeout(twitchRetry);
  twitchRetryDelay = 60000;
  liveGuard = newLiveGuard(client);
  liveEngine = liveEngineFor({
    cover: () => obs.cover(),
    mute: () => obs.muteInputs(),
    unmute: () => obs.unmuteInputs(),
    guard: async (terms) => {
      liveGuard!.addSessionTerms(terms);
    },
    retroactive: () => liveGuard!.retroactive(),
    marker: async (id) => (await client.marker(id)).data[0],
    shield: async () => {
      await client.shield(true);
    },
    blocked: async (terms) => {
      for (const term of terms) await client.blockedTerm(term);
    },
    notice: async () => {
      await client.notice();
    },
    discord: postDiscord,
    clips: (start, end) => client.clips(start, end),
  });
  eventsub?.stop();
  eventsub = new EventSub(
    client,
    liveChatHandler(() => !rehearsal, liveGuard),
    (status) => event("Twitch", status),
  );
  eventsub.start();
  await syncVault();
  notify();
}
/** Transient Twitch outages retry with backoff and keep stored tokens. */
function connectTwitch(): void {
  void setupTwitch().catch((error: unknown) => {
    if (error instanceof AuthUnavailableError) {
      event("Twitch", "Twitch unavailable; retrying sign-in check");
      clearTimeout(twitchRetry);
      twitchRetry = setTimeout(connectTwitch, twitchRetryDelay);
      twitchRetry.unref();
      twitchRetryDelay = Math.min(15 * 60000, twitchRetryDelay * 2);
    } else
      event(
        "Twitch",
        error instanceof Error && error.message.includes("moderator")
          ? error.message
          : "Sign in to enable live chat protection",
      );
  });
}
async function panic(
  trigger: Incident["trigger"] = "panic",
  terms: string[] = [],
): Promise<void> {
  const engine = activeEngine();
  // The cover scene is local and safe: switch it first, in every mode.
  // Never skipped while OBS reconnects: the client queues or throws.
  let coverFailed = false,
    coverError = "";
  const coverStart = performance.now();
  if (trigger === "panic")
    await obs.cover().catch((error: unknown) => {
      coverFailed = true;
      coverError = error instanceof Error ? error.message : String(error);
    });
  if (!engine)
    throw new Error(
      "Connect Twitch or enable rehearsal before opening an incident",
    );
  const incident = await engine.open(trigger, terms);
  const engineCover = incident.actions
    .filter((a) => a.action === "cover")
    .at(-1)?.status;
  // The pre-engine cover failure is an incident action error, not swallowed.
  if (coverFailed && engineCover !== "error") {
    incident.actions.push({
      action: "cover",
      time: new Date().toISOString(),
      status: "error",
      duration_ms: performance.now() - coverStart,
      reason: coverError || "OBS cover failed",
    });
    if (engine === liveEngine) store.set("incidents", engine.incidents);
  }
  if (
    trigger === "panic" &&
    (coverFailed || (engine.modes.cover === "auto" && engineCover === "error"))
  )
    throw new Error(
      "Incident opened, but OBS cover failed. Check OBS immediately.",
    );
  notify();
}
function registerHotkey(hotkey: string): boolean {
  return globalShortcut.register(hotkey, () => {
    void panic().catch(() =>
      event("panic", "Could not cover stream; check connections"),
    );
  });
}
function setRehearsal(enabled: boolean): void {
  rehearsal = enabled;
  settings.rehearsal = enabled;
  // Choosing connected mode is the user's statement that setup is done.
  if (!enabled) settings.onboardingComplete = true;
  persistSettings();
  notify();
}
/** OBS cannot read inside app.asar; copy a bundled page to a real file. */
function assetFile(asset: string): string {
  const target = join(app.getPath("userData"), asset.split("/").at(-1)!);
  writeFileSync(target, readFileSync(join(here, asset)));
  return target;
}
const coverFile = () => assetFile("rehearsal/cover.html");
async function startOverlay(): Promise<void> {
  // Refresh the userData copies on every launch, so an upgrade replaces
  // pages that OBS scenes created by an older version still point at.
  try {
    coverFile();
  } catch {
    event("overlay", "Could not refresh the cover page");
  }
  try {
    const page = assetFile("overlay/overlay.html");
    const server = new OverlayServer(() => readFileSync(page, "utf8"));
    await server.start(Number(process.env.VEIL_OVERLAY_PORT ?? 47322));
    overlay = server;
  } catch {
    event("overlay", "On-stream overlay unavailable");
  }
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
    const html = `<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'"><style>body{margin:0;background:#111827;color:#e8eef9;font:24px Arial}header{padding:40px;background:#202b40}main{margin:80px;padding:44px;background:#263246;border:1px solid #67758b;border-radius:16px}small{color:#a5b4c8}</style><header>VEIL / LOCAL PRACTICE</header><main><small>${entry.title}</small><h2>${entry.label}</h2><p>${entry.value}</p></main>`;
    await preview.loadURL(
      "data:text/html;charset=utf-8," + encodeURIComponent(html),
    );
    await new Promise((r) => setTimeout(r, 100));
    const image = await preview.webContents.capturePage(),
      png = image.toPNG();
    const result = await detectImage(png, "rehearsal-" + kind);
    const late =
      result.processed_ms + 1000 / settings.sampleFps + 100 > settings.delay;
    const masked =
      settings.profile !== "off" && (settings.profile === "paranoid" || !late);
    event(
      "rehearsal",
      `${kind}: ${result.processed_ms.toFixed(1)} ms / ${late ? "increase delay or use Paranoid" : "within budget"}`,
    );
    return {
      kind,
      image: image.toDataURL(),
      ...result,
      late,
      masked: masked && result.detections.length > 0,
      fullHold: late && settings.profile === "paranoid",
      mode: "practice capture; local OCR measured; broadcast output checked in OBS",
    };
  } finally {
    preview.destroy();
  }
}
async function exportReport(data: Record<string, unknown>) {
  const incident = activeEngine()?.incidents.find((i) => i.id === data.id);
  if (!incident) throw new Error("Incident missing");
  const include = data.includePrivate === true;
  if (include) vault.unlock(text(data.pin, 12));
  const content = report(
    incident,
    include ? vault.terms().map((t) => t.text) : undefined,
  );
  const pdf = data.format === "pdf";
  const destination = await dialog.showSaveDialog(window, {
    defaultPath: `veil-incident-${incident.id}.${pdf ? "pdf" : "md"}`,
    filters: [
      { name: pdf ? "PDF" : "Markdown", extensions: [pdf ? "pdf" : "md"] },
    ],
  });
  if (destination.canceled || !destination.filePath)
    return reply("Export cancelled");
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
  return reply("Report exported");
}
async function exportDiagnostics() {
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
            eventsub: eventsubConnected(),
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
  return reply(
    destination.canceled ? "Export cancelled" : "Metadata diagnostics exported",
  );
}
async function updateSettings(data: Record<string, unknown>): Promise<void> {
  const previous = settings,
    next = patchSettings(settings, data);
  const hotkeyChanged = next.hotkey !== previous.hotkey;
  const channelChanged = next.protectedChannel !== previous.protectedChannel;
  // Verify moderator access before committing a new protected channel.
  if (channelChanged && helix)
    await new Helix(auth, helix.userId).useChannel(
      next.protectedChannel,
      twitchLogin,
    );
  if (hotkeyChanged && !registerHotkey(next.hotkey))
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
        (await obs.scenes()).filter((s) => s !== COVER_SCENE),
        credentialPath,
        next.delay,
        profileLevel(next.profile),
        next.sampleFps,
      );
      if (next.profile === "off") await obs.restoreAudio();
    }
    persistSettings();
    if (liveEngine) liveEngine.modes = { ...next.modes };
    mockEngine.modes = { ...next.modes };
    if (next.retentionDays !== previous.retentionDays)
      liveEngine?.retain(next.retentionDays);
    if (hotkeyChanged) globalShortcut.unregister(previous.hotkey);
  } catch (error) {
    settings = previous;
    if (hotkeyChanged) globalShortcut.unregister(next.hotkey);
    await setPolicy().catch(() =>
      event("detector", "Policy rollback pending connection"),
    );
    throw error;
  }
  if (channelChanged && twitchReady) await setupTwitch();
}
/** Commands that need Electron APIs stay here; the rest live in ./ipc. */
function electronCommands(): Commands {
  return {
    snapshot: () => reply(snapshot()),
    "twitch-client": (data) => {
      const clientId = text(data.id, 128).trim();
      if (!/^[a-zA-Z0-9]{5,128}$/.test(clientId))
        throw new Error(
          "Enter the public Client ID from Twitch application settings",
        );
      authCancel?.abort();
      eventsub?.stop();
      twitchReady = false;
      device = undefined;
      const persistence = tokenPersistence(store, safeStorage);
      persistence.clear();
      store.set("twitchClientId", clientId);
      auth = new TwitchAuth(clientId, persistence);
      notify();
    },
    "auth-begin": async () => {
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
        .catch((error: unknown) =>
          event(
            "Twitch",
            error instanceof Error && error.message.includes("moderator")
              ? error.message
              : "Sign-in did not complete; start again",
          ),
        );
    },
    "open-twitch": async () => {
      if (!device) throw new Error("Start sign-in first");
      const url = new URL(device.verification_uri);
      if (url.protocol !== "https:" || url.hostname !== "www.twitch.tv")
        throw new Error("Unexpected sign-in URL");
      await shell.openExternal(url.href);
    },
    "source-scan": async () => {
      if (!detectorReady)
        throw new Error("Local detector is starting or unavailable");
      return reply(await scanSources(obs, detector));
    },
    scenario: async (data) =>
      reply(await scenario(text(data.kind, 20) as keyof typeof SCENARIOS)),
    export: exportReport,
    "logs-export": exportDiagnostics,
    settings: updateSettings,
    "overlay-add": async () => {
      if (!overlay?.url) throw new Error("Overlay feed is not running");
      if (!obs.connected) throw new Error("Connect OBS first");
      const scene = await obs.addOverlay(overlay.url);
      event("overlay", `Overlay added to ${scene}`);
    },
    external: async (data) => {
      const target = text(data.target, 30);
      if (!["clips", "videos"].includes(target))
        throw new Error("Unknown destination");
      await shell.openExternal(
        target === "clips"
          ? "https://dashboard.twitch.tv/content/clips"
          : "https://dashboard.twitch.tv/content/video-producer",
      );
    },
  };
}
function installHandlers(): void {
  const commands: Commands = {
    ...electronCommands(),
    ...vaultCommands({
      vault,
      helix: () => helix,
      sync: () => syncVault(),
      notify,
    }),
    ...incidentCommands({
      engine: activeEngine,
      panic,
      answer: (id, yes) => pendingAsks.get(id)?.(yes),
      setRehearsal,
      completeOnboarding: () => {
        settings.onboardingComplete = true;
        persistSettings();
      },
      simulateChat: async () => {
        if (!rehearsal) throw new Error("Switch to rehearsal first");
        await practiceChat(mockGuard);
      },
    }),
    ...obsCommands({
      obs,
      detector,
      settings: () => settings,
      persist: persistSettings,
      coverFile,
      credentialPath: () => credentialPath,
      detectorReady: () => detectorReady,
      vaultCategories: () => new Set(vault.list().map((e) => e.category)).size,
      twitchReady: () => twitchReady,
      eventsubConnected,
    }),
  };
  ipcMain.handle("veil:command", (event_, command: unknown, input: unknown) => {
    if (
      event_.sender !== window.webContents ||
      event_.senderFrame !== window.webContents.mainFrame
    )
      throw new Error("Untrusted caller");
    return dispatch(commands, command, input, snapshot, notify);
  });
}
function setupRehearsal(): void {
  mockActions = new RehearsalActions();
  mockGuard = new ChatGuard(
    mockActions,
    (value) => onGuard(value, mockEngine),
    () => {
      void mockEngine.open("spike");
    },
  );
  mockGuard.setTerms(PRACTICE_TERMS);
  mockEngine = new IncidentEngine(
    mockActions.incidentActions(mockGuard, localObs),
    ask,
    () => {},
    notify,
    true,
  );
  mockEngine.modes = { ...settings.modes };
}
function setupOfflineLive(): void {
  const unavailable = async (): Promise<never> => {
    throw new Error("Twitch authorization required");
  };
  liveGuard = newLiveGuard({
    deleteMessage: unavailable,
    timeout: unavailable,
  });
  liveEngine = liveEngineFor({
    cover: () => obs.cover(),
    mute: () => obs.muteInputs(),
    unmute: () => obs.unmuteInputs(),
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
  });
}
function startHourlyValidation(): void {
  const hourly = setInterval(() => {
    if (twitchReady)
      void auth.validate().catch((error: unknown) => {
        if (error instanceof AuthUnavailableError) {
          // Transient: keep tokens and EventSub running.
          event("Twitch", "Hourly check could not reach Twitch; will retry");
          return;
        }
        twitchReady = false;
        eventsub?.stop();
        event("Twitch", "Authorization expired or revoked; sign in again");
      });
  }, 3600000);
  hourly.unref();
}
async function startDetector(): Promise<void> {
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
              // Raw text is needed only for local retroactive matching. It
              // goes to the in-memory chat guard, never to the engine (which
              // could export it as Twitch blocked terms) or to disk.
              .request("/v1/incident-text", "POST", {
                stream_id: frame.stream_id,
                include_text: true,
              })
              .then(async (value) => {
                const texts = Array.isArray(value.texts)
                    ? value.texts
                        .filter(
                          (v): v is string =>
                            typeof v === "string" && v.length <= 500,
                        )
                        .slice(0, 50)
                    : [],
                  engine = liveEngine,
                  active = engine?.incidents.some((i) => i.state !== "closed");
                if (texts.length && engine?.modes.guard !== "off")
                  liveGuard?.addSessionTerms(texts);
                await engine?.open("late", []);
                if (
                  active &&
                  texts.length &&
                  engine?.modes.retroactive === "auto"
                )
                  await liveGuard?.retroactive();
              })
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
}
async function start(): Promise<void> {
  app.setName("VEIL");
  if (process.env.VEIL_DATA_DIR)
    app.setPath("userData", resolve(process.env.VEIL_DATA_DIR));
  const config = app.getPath("userData");
  store = new Store(join(config, "veil.sqlite"));
  settings = loadSettings(store.get<Partial<Settings>>("settings", {}));
  rehearsal = startupRehearsal(settings);
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
  obs.onStatus = (status) => event("OBS", status);
  let clientId =
    store.get<string>("twitchClientId", "") ||
    process.env.TWITCH_CLIENT_ID ||
    "";
  const envPath = join(root, ".env");
  if (!clientId && existsSync(envPath)) {
    const source = readFileSync(envPath, "utf8");
    clientId =
      source.match(/^TWITCH_CLIENT_ID\s*=\s*["']?([^\r\n"']*)/m)?.[1]?.trim() ??
      "";
  }
  // Public OAuth identifier, never a client secret. Users may override it.
  clientId ||= "dsjph13im3cr1e2n9mg4igm0mwehx6";
  auth = new TwitchAuth(clientId, tokenPersistence(store, safeStorage));
  setupRehearsal();
  setupOfflineLive();
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
  await startOverlay();
  if (!registerHotkey(settings.hotkey))
    event("hotkey", "Could not register panic shortcut; use the panic button");
  await window.loadFile(join(here, "../dist/index.html"));
  await startDetector();
  try {
    await setupTwitch();
  } catch (error) {
    if (error instanceof AuthUnavailableError) connectTwitch();
    else
      event(
        "Twitch",
        error instanceof Error && error.message.includes("moderator")
          ? error.message
          : "Sign in to enable live chat protection",
      );
  }
  startHourlyValidation();
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
  clearTimeout(twitchRetry);
  eventsub?.stop();
  detectorEvents?.close();
  globalShortcut.unregisterAll();
  mockEngine?.dispose();
  liveEngine?.dispose();
  void (async () => {
    await overlay?.close();
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
      `Secure storage or local configuration is unavailable. Review installation and restart VEIL.

${startupFault}`,
    );
    app.quit();
  });
