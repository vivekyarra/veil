import type { Incident } from "../electron/incidents/engine";
import type { Category } from "../electron/vault/vault";
export interface State {
  rehearsal: boolean;
  settings: {
    profile: "off" | "balanced" | "paranoid";
    delay: number;
    sampleFps: number;
    theme: "dark" | "light";
    hotkey: string;
    obsUrl: string;
    discord: string;
    retentionDays: number;
    ignoreZones: { x: number; y: number; w: number; h: number }[];
    denylist: string[];
    modes: Record<string, string>;
    recognizers: string[];
    thresholds: Record<string, number>;
    gameId: string;
    gameZones: Record<string, { x: number; y: number; w: number; h: number }[]>;
  };
  obs: boolean;
  detector: boolean;
  twitch: boolean;
  twitchClientId: string;
  eventsub: boolean;
  vault: { id: string; category: Category; optedIn: boolean }[];
  hasPin: boolean;
  incidents: Incident[];
  feed: { time: string; kind: string; detail: string }[];
  masks: number;
  removed: number;
  device?: { user_code: string; verification_uri: string };
  tokenFile: string;
}
export interface Scan {
  image: string;
  processed_ms: number;
  detections: {
    kind: string;
    box: { x: number; y: number; w: number; h: number };
  }[];
  late: boolean;
  masked: boolean;
  fullHold: boolean;
  mode: string;
}
interface Bridge {
  command: (
    operation: string,
    input?: unknown,
  ) => Promise<{ ok: boolean; value?: unknown; error?: string }>;
  subscribe: (handler: (state: unknown) => void) => () => void;
  onAsk: (handler: (value: unknown) => void) => () => void;
  onAskExpired: (handler: (value: unknown) => void) => () => void;
}
declare global {
  interface Window {
    veil?: Bridge;
  }
}
