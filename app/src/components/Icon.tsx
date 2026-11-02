const GLYPHS: Record<string, string> = {
  Dashboard: "◈",
  "Never Show": "◇",
  Incidents: "⚑",
  "Pre-flight": "✓",
  Rehearsal: "▷",
  Settings: "⚙",
  Onboarding: "↗",
};
export function Icon({ kind }: { kind: string }) {
  return (
    <span className="icon" aria-hidden="true">
      {GLYPHS[kind] ?? "·"}
    </span>
  );
}
/** The VEIL shield. `state` tints it: ok, warn, bad or brand. */
export function ShieldMark({
  state = "violet",
  size = 40,
}: {
  state?: string;
  size?: number;
}) {
  return (
    <svg
      className={"shield-mark " + state}
      width={size}
      height={size * 1.14}
      viewBox="0 0 44 50"
      aria-hidden="true"
    >
      <path d="M22 2 41 9v15c0 12-8 20-19 24C11 44 3 36 3 24V9z" />
      {state === "ok" || state === "violet" ? (
        <path className="glyph" d="M13 17l9 18 9-18" />
      ) : (
        <path className="glyph" d="M22 14v14M22 35v.5" />
      )}
    </svg>
  );
}
