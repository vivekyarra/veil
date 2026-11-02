import { create } from "zustand";
import type { Check, Scan, State } from "./types";

export const PAGES = [
  "Dashboard",
  "Never Show",
  "Incidents",
  "Pre-flight",
  "Rehearsal",
  "Settings",
  "Onboarding",
] as const;
export type Page = (typeof PAGES)[number];
export interface Ask {
  id: string;
  action: string;
  expires: number;
}
/** A PIN request for a vault action the backend refused without one. */
interface PinRequest {
  title: string;
  operation: string;
  input: Record<string, unknown>;
}

/** Disconnected defaults so the preview renders honestly outside Electron. */
const initial: State = {
  rehearsal: true,
  protectionActive: false,
  protection: { live: false, chatGuard: false, obs: false },
  onboardingComplete: false,
  channel: { login: "", moderating: false },
  settings: {
    profile: "paranoid",
    delay: 750,
    sampleFps: 4,
    theme: "dark",
    hotkey: "Control+Shift+F12",
    obsUrl: "ws://127.0.0.1:4455",
    discord: "",
    retentionDays: 30,
    ignoreZones: [],
    denylist: [],
    modes: {
      cover: "auto",
      mute: "off",
      guard: "auto",
      retroactive: "auto",
      marker: "auto",
      shield: "ask",
      blocked: "off",
      notice: "off",
      discord: "off",
      clips: "auto",
    },
    recognizers: [
      "email",
      "phone",
      "card",
      "ip",
      "address",
      "secret",
      "vault",
      "window",
    ],
    thresholds: {},
    gameId: "default",
    gameZones: {},
    protectedChannel: "",
    rehearsal: true,
    onboardingComplete: false,
  },
  obs: false,
  detector: false,
  twitch: false,
  twitchClientId: "",
  eventsub: false,
  vault: [],
  hasPin: false,
  incidents: [],
  feed: [],
  masks: 0,
  removed: 0,
  tokenFile: "",
  overlayUrl: "",
};

interface Store {
  state: State;
  page: Page;
  message: string;
  busy: boolean;
  ask: Ask | null;
  pinRequest: PinRequest | null;
  incidentId: number | null;
  onboardingStep: number;
  /** Last rehearsal capture; Settings reuses it for ignore zones. */
  scan: Scan | null;
  checks: Check[];
  go: (page: Page, extra?: Partial<Store>) => void;
  set: (patch: Partial<Store>) => void;
}
export const useVeil = create<Store>((set) => ({
  state: initial,
  page: "Dashboard",
  message: "",
  busy: false,
  ask: null,
  pinRequest: null,
  incidentId: null,
  onboardingStep: 0,
  scan: null,
  checks: [],
  go: (page, extra) => set({ page, incidentId: null, ...extra }),
  set: (patch) => set(patch),
}));

interface Outcome {
  ok: boolean;
  value?: unknown;
  error?: string;
}
/** Send one command to the main process; never throws. */
export async function call(operation: string, input?: unknown) {
  const { set } = useVeil.getState();
  if (!window.veil) {
    const error = "Open the Electron desktop app to connect local services.";
    set({ message: error });
    return { ok: false, error } as Outcome;
  }
  set({ busy: true });
  try {
    const response = await window.veil.command(operation, input);
    if (!response.ok) {
      set({ message: response.error ?? "Action failed" });
      return response as Outcome;
    }
    if (
      response.value &&
      typeof response.value === "object" &&
      "rehearsal" in response.value
    )
      set({ state: response.value as State });
    set({ message: operation === "snapshot" ? "" : "Done" });
    return response as Outcome;
  } catch (error) {
    const message = error instanceof Error ? error.message : "Action failed";
    set({ message });
    return { ok: false, error: message } as Outcome;
  } finally {
    set({ busy: false });
  }
}
/** Like {@link call}, resolving to the value or undefined on failure. */
export async function run(
  operation: string,
  input?: unknown,
): Promise<unknown> {
  const result = await call(operation, input);
  return result.ok ? result.value : undefined;
}
export const saveSettings = (patch: Record<string, unknown>) =>
  call("settings", patch);
/**
 * Run a vault action; when the backend asks for the PIN (the vault was not
 * unlocked in the last 30 seconds), open the PIN prompt and retry from there.
 */
export async function withPin(
  title: string,
  operation: string,
  input: Record<string, unknown>,
): Promise<void> {
  const result = await call(operation, input);
  if (!result.ok && /PIN/.test(result.error ?? ""))
    useVeil.getState().set({ pinRequest: { title, operation, input } });
}
