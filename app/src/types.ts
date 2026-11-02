import type { Action, Incident, Mode } from "../electron/incidents/engine";
import type { Category } from "../electron/vault/vault";
import type { Settings } from "../electron/store/settings";

export type { Action, Incident, Mode };
export interface State {
  rehearsal: boolean;
  /** Live chat moderation and OBS cover are both armed for real. */
  protectionActive: boolean;
  /** What protection is missing, item by item. */
  protection: { live: boolean; chatGuard: boolean; obs: boolean };
  onboardingComplete: boolean;
  channel: { login: string; moderating: boolean };
  settings: Settings;
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
  /** Loopback URL of the on-stream overlay; "" when unavailable. */
  overlayUrl: string;
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
export interface Check {
  id: string;
  title: string;
  status: string;
  detail: string;
  recommendedDelay?: number;
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
