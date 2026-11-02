import type { Action, Incident } from "./types";

export const hotkeyLabel = (hotkey: string) =>
  hotkey
    .replace("Control", "Ctrl")
    .replace("Command", "Cmd")
    .replaceAll("+", " + ");

export const pad2 = (n: number) => n.toString().padStart(2, "0");

/** Human names and one-line explanations for each automated action. */
export const ACTIONS: Record<
  Action | "unmute",
  { label: string; detail: string }
> = {
  cover: {
    label: "Cover scene",
    detail: "Switch OBS to the VEIL privacy-break card.",
  },
  mute: {
    label: "Mute on panic",
    detail: "Mute every OBS audio input; restored when the incident closes.",
  },
  unmute: { label: "Restore audio", detail: "Unmute inputs VEIL muted." },
  guard: {
    label: "Chat guard",
    detail: "Delete chat messages that repeat a leaked term.",
  },
  retroactive: {
    label: "Retroactive cleanup",
    detail: "Re-scan recent chat and delete leaks already posted.",
  },
  marker: {
    label: "VOD marker",
    detail: "Drop a stream marker so you can review the moment later.",
  },
  shield: {
    label: "Shield mode",
    detail: "Turn on Twitch Shield Mode to slow down raids and spam.",
  },
  blocked: {
    label: "Blocked terms",
    detail: "Send terms to Twitch blocked terms. Moderators can read them.",
  },
  notice: {
    label: "Chat notice",
    detail: "Post a short, generic notice in chat.",
  },
  discord: {
    label: "Discord alert",
    detail: "Post incident metadata to your webhook.",
  },
  clips: {
    label: "Clip review",
    detail: "List clips made during the incident window.",
  },
};

type Result = Incident["actions"][number];
/** Readable status; a timeout decline is called out explicitly. */
export function resultLabel(a: Result): { text: string; tone: string } {
  if (a.status === "declined" && a.reason === "timeout")
    return { text: "Declined — no answer in 10 s", tone: "timeout" };
  if (a.status === "declined") return { text: "Declined by you", tone: "warn" };
  if (a.status === "off") return { text: "Off", tone: "off" };
  if (a.status === "error") return { text: "Failed", tone: "bad" };
  return { text: "Done", tone: "ok" };
}

/** Feed kinds to a short label and colour tone. Feed text is metadata only. */
export function feedMeta(kind: string): { label: string; tone: string } {
  const known: Record<string, { label: string; tone: string }> = {
    detection: { label: "Masked on screen", tone: "brand" },
    deleted: { label: "Chat leak removed", tone: "ok" },
    retroactive: { label: "Retroactive cleanup", tone: "ok" },
    warning: { label: "Chat warning", tone: "warn" },
    timeout: { label: "Chatter timed out", tone: "warn" },
    review: { label: "Needs review", tone: "warn" },
    error: { label: "Chat action failed", tone: "bad" },
    approval: { label: "Approval", tone: "warn" },
    OBS: { label: "OBS", tone: "info" },
    Twitch: { label: "Twitch", tone: "info" },
    overlay: { label: "Overlay", tone: "info" },
    "late result": { label: "Late result", tone: "bad" },
    panic: { label: "Panic", tone: "bad" },
    incident: { label: "Incident", tone: "bad" },
    rehearsal: { label: "Rehearsal", tone: "info" },
  };
  return known[kind] ?? { label: kind, tone: "info" };
}
