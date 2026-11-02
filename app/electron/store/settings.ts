import type { Action, Mode } from "../incidents/engine.js";
import { DEFAULT_MODES } from "../incidents/engine.js";
interface Zone {
  x: number;
  y: number;
  w: number;
  h: number;
}
export interface Settings {
  profile: "off" | "balanced" | "paranoid";
  delay: number;
  sampleFps: number;
  theme: "dark" | "light";
  hotkey: string;
  obsUrl: string;
  discord: string;
  retentionDays: number;
  ignoreZones: Zone[];
  denylist: string[];
  modes: Record<Action, Mode>;
  recognizers: string[];
  thresholds: Record<string, number>;
  gameId: string;
  gameZones: Record<string, Zone[]>;
  /** Twitch login of the channel to protect; "" means the signed-in user. */
  protectedChannel: string;
  /** Saved rehearsal choice; only honored once onboarding is complete. */
  rehearsal: boolean;
  onboardingComplete: boolean;
}
const kinds = [
  "email",
  "phone",
  "card",
  "ip",
  "address",
  "secret",
  "vault",
  "window",
];
export function defaultSettings(): Settings {
  return {
    profile: "paranoid",
    delay: 2500,
    sampleFps: 4,
    theme: "dark",
    hotkey:
      process.platform === "darwin" ? "Command+Shift+F12" : "Control+Shift+F12",
    obsUrl: "ws://127.0.0.1:4455",
    discord: "",
    retentionDays: 30,
    ignoreZones: [],
    denylist: [
      "1password",
      "bitwarden",
      "keepass",
      "lastpass",
      "outlook",
      "gmail",
      "proton mail",
    ],
    modes: { ...DEFAULT_MODES },
    recognizers: [...kinds],
    thresholds: {},
    gameId: "default",
    gameZones: {},
    protectedChannel: "",
    rehearsal: true,
    onboardingComplete: false,
  };
}
/**
 * Merge stored settings over defaults, including newly added modes. Fields of
 * the wrong type (an older or hand-edited file) fall back to the default, so a
 * damaged settings row can never brick startup.
 */
export function loadSettings(stored: unknown): Settings {
  const defaults = defaultSettings();
  if (!stored || typeof stored !== "object" || Array.isArray(stored))
    return defaults;
  const input = stored as Record<string, unknown>;
  const out = { ...defaults } as unknown as Record<string, unknown>;
  for (const [key, fallback] of Object.entries(defaults)) {
    if (key === "modes") continue;
    const value = input[key];
    if (value === undefined || value === null) continue;
    if (Array.isArray(fallback) !== Array.isArray(value)) continue;
    if (typeof value !== typeof fallback) continue;
    if (typeof value === "number" && !Number.isFinite(value)) continue;
    out[key] = value;
  }
  if (!["off", "balanced", "paranoid"].includes(String(out.profile)))
    out.profile = defaults.profile;
  if (!["dark", "light"].includes(String(out.theme)))
    out.theme = defaults.theme;
  const modes = { ...defaults.modes };
  const storedModes = input.modes;
  if (
    storedModes &&
    typeof storedModes === "object" &&
    !Array.isArray(storedModes)
  )
    for (const [action, mode] of Object.entries(storedModes))
      if (action in modes && ["auto", "ask", "off"].includes(String(mode)))
        modes[action as Action] = mode as Mode;
  out.modes = modes;
  return out as unknown as Settings;
}
/** Rehearsal is forced until onboarding completes; then the saved value. */
export function startupRehearsal(settings: Settings): boolean {
  return settings.onboardingComplete ? settings.rehearsal : true;
}
function bounded(value: unknown, min: number, max: number): number {
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    value < min ||
    value > max
  )
    throw new Error("Setting outside supported range");
  return value;
}
function string(value: unknown, max: number): string {
  if (typeof value !== "string" || value.length > max)
    throw new Error("Invalid setting");
  return value;
}
/** Validate the entire patch before changing any persisted or live state. */
export function patchSettings(
  current: Settings,
  patch: Record<string, unknown>,
): Settings {
  const next = structuredClone(current);
  for (const key of Object.keys(patch))
    if (
      ![
        "profile",
        "delay",
        "sampleFps",
        "theme",
        "hotkey",
        "discord",
        "retentionDays",
        "ignoreZones",
        "denylist",
        "modes",
        "recognizers",
        "thresholds",
        "gameId",
        "protectedChannel",
      ].includes(key)
    )
      throw new Error("Unknown setting");
  if (patch.profile !== undefined) {
    if (!["off", "balanced", "paranoid"].includes(String(patch.profile)))
      throw new Error("Invalid profile");
    next.profile = patch.profile as Settings["profile"];
  }
  if (patch.delay !== undefined)
    next.delay = Math.round(bounded(patch.delay, 300, 6000));
  if (patch.sampleFps !== undefined)
    next.sampleFps = Math.round(bounded(patch.sampleFps, 1, 10));
  if (patch.retentionDays !== undefined)
    next.retentionDays = Math.round(bounded(patch.retentionDays, 1, 365));
  if (patch.theme !== undefined) {
    if (!["light", "dark"].includes(String(patch.theme)))
      throw new Error("Invalid theme");
    next.theme = patch.theme as Settings["theme"];
  }
  if (patch.hotkey !== undefined) next.hotkey = string(patch.hotkey, 80);
  if (patch.discord !== undefined) {
    const value = string(patch.discord, 300);
    if (value) {
      const url = new URL(value);
      if (
        url.protocol !== "https:" ||
        url.hostname !== "discord.com" ||
        url.username ||
        url.password ||
        url.search ||
        !/^\/api\/webhooks\/\d+\/[\w-]+$/.test(url.pathname)
      )
        throw new Error("Use an official discord.com webhook URL");
    }
    next.discord = value;
    next.modes.discord = value ? "auto" : "off";
  }
  if (patch.protectedChannel !== undefined) {
    const login = string(patch.protectedChannel, 25).trim().toLowerCase();
    if (!/^[a-z0-9_]{0,25}$/.test(login))
      throw new Error("Enter a Twitch channel login, or leave empty for yours");
    next.protectedChannel = login;
  }
  if (patch.gameId !== undefined) {
    const id = string(patch.gameId, 30);
    if (!/^(default|[0-9]+)$/.test(id))
      throw new Error("Use a numeric Twitch category ID or default");
    next.gameId = id;
    next.ignoreZones = next.gameZones[id] ?? [];
  }
  if (patch.ignoreZones !== undefined) {
    if (!Array.isArray(patch.ignoreZones) || patch.ignoreZones.length > 20)
      throw new Error("Invalid ignore zones");
    next.ignoreZones = patch.ignoreZones.map((value) => {
      const b = value as Record<string, unknown>;
      const zone = {
        x: bounded(b.x, 0, 1),
        y: bounded(b.y, 0, 1),
        w: bounded(b.w, 0.001, 1),
        h: bounded(b.h, 0.001, 1),
      };
      if (zone.x + zone.w > 1 || zone.y + zone.h > 1)
        throw new Error("Ignore zone extends beyond the frame");
      return zone;
    });
    next.gameZones[next.gameId] = next.ignoreZones;
  }
  if (patch.denylist !== undefined) {
    if (!Array.isArray(patch.denylist) || patch.denylist.length > 100)
      throw new Error("Invalid denylist");
    next.denylist = patch.denylist.map((v) => string(v, 100)).filter(Boolean);
  }
  if (patch.recognizers !== undefined) {
    if (
      !Array.isArray(patch.recognizers) ||
      patch.recognizers.some((v) => !kinds.includes(String(v)))
    )
      throw new Error("Invalid recognizer");
    next.recognizers = [...new Set(patch.recognizers.map((v) => String(v)))];
  }
  if (patch.thresholds !== undefined) {
    if (
      !patch.thresholds ||
      typeof patch.thresholds !== "object" ||
      Array.isArray(patch.thresholds)
    )
      throw new Error("Invalid thresholds");
    for (const [kind, value] of Object.entries(patch.thresholds)) {
      if (!kinds.includes(kind)) throw new Error("Invalid recognizer");
      next.thresholds[kind] = bounded(value, 0, 1);
    }
  }
  if (patch.modes !== undefined) {
    if (
      !patch.modes ||
      typeof patch.modes !== "object" ||
      Array.isArray(patch.modes)
    )
      throw new Error("Invalid automation modes");
    for (const [action, mode] of Object.entries(patch.modes)) {
      if (
        !(action in DEFAULT_MODES) ||
        !["auto", "ask", "off"].includes(String(mode))
      )
        throw new Error("Invalid automation mode");
      next.modes[action as Action] = mode as Mode;
    }
  }
  return next;
}
