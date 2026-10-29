import type { Incident } from "./engine.js";
const clean = (text: string) => text.replace(/[\r\n|<>`[\]]/g, " ");
/** Reports omit private strings unless the caller explicitly supplies them. */
export function report(
  incident: Incident,
  explicitPrivateText?: string[],
): string {
  return [
    `# VEIL incident #${incident.id}`,
    `Mode: ${incident.rehearsal ? "Rehearsal (simulated actions)" : "Connected services"}`,
    `State: ${incident.state}`,
    `Window: ${incident.started} — ${incident.ended ?? "open"}`,
    incident.marker
      ? `VOD marker offset: ${incident.marker.position_seconds} seconds`
      : "No marker: use wall-clock timestamps for manual VOD review.",
    "\n## Timeline",
    ...incident.actions.map(
      (a) =>
        `- ${a.time}: ${a.action} / ${a.status} (${a.duration_ms.toFixed(1)} ms)${a.reason ? " — " + clean(a.reason) : ""}`,
    ),
    "\n## Posting attempts",
    ...Object.entries(incident.attempts).map(
      ([user, count]) => `- ${clean(user)}: ${count}`,
    ),
    "\n## Clips",
    ...incident.clips.map(
      (c) =>
        `- ${clean(c.id)}: https://clips.twitch.tv/${encodeURIComponent(c.id)}`,
    ),
    "\n## Manual follow-up",
    `Review and trim the incident window in Video Producer. Review ${incident.clips.length} clips in Creator Dashboard. Clip removal is manual.`,
    ...(explicitPrivateText
      ? [
          "\n## Private text (explicitly included)",
          ...explicitPrivateText.map(clean),
        ]
      : ["\nPrivate text omitted."]),
  ].join("\n\n");
}
