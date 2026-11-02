import { call, useVeil, type Page } from "../store";
import type { State } from "../types";
import { ShieldMark } from "./Icon";

interface Gap {
  id: string;
  text: string;
  fix: string;
  action: () => void;
}
type Go = (page: Page, extra?: { onboardingStep?: number }) => void;

/** Everything standing between the streamer and real protection. */
export function gaps(state: State, go: Go): Gap[] {
  const list: Gap[] = [];
  const signIn = () => {
    go("Onboarding", { onboardingStep: 1 });
    void call("auth-begin");
  };
  if (!state.protection.live)
    list.push({
      id: "rehearsal",
      text: "Rehearsal is on: your real chat and stream are not guarded",
      fix: "Turn off rehearsal",
      action: () => void call("rehearsal", { enabled: false }),
    });
  if (!state.twitch)
    list.push({
      id: "twitch",
      text: "Twitch is not signed in",
      fix: "Sign in to Twitch",
      action: signIn,
    });
  else if (!state.protection.chatGuard)
    list.push({
      id: "chat",
      text: "Chat guard is disconnected",
      fix: "Reconnect chat guard",
      action: signIn,
    });
  if (!state.protection.obs)
    list.push({
      id: "obs",
      text: "OBS is not connected, so panic cannot cover the stream",
      fix: "Connect OBS",
      action: () => go("Onboarding", { onboardingStep: 0 }),
    });
  if (state.settings.profile === "off")
    list.push({
      id: "profile",
      text: "Screen masking is switched off",
      fix: "Turn masking on",
      action: () => void call("settings", { profile: "balanced" }),
    });
  if (!state.detector)
    list.push({
      id: "detector",
      text: "Screen detector is offline or still starting",
      fix: "Check pre-flight",
      action: () => go("Pre-flight"),
    });
  if (!state.protectionActive && list.length === 0)
    list.push({
      id: "armed",
      text: "Protection has not armed yet",
      fix: "Check pre-flight",
      action: () => go("Pre-flight"),
    });
  return list;
}

/**
 * Persistent top banner. Green only when every layer is armed; otherwise it
 * names each missing piece with a one-click fix.
 */
export function ProtectionBanner() {
  const state = useVeil((s) => s.state),
    go = useVeil((s) => s.go),
    busy = useVeil((s) => s.busy);
  const missing = gaps(state, go);
  const channel = state.channel.login ? "#" + state.channel.login : "";
  const tone = missing.length === 0 ? "ok" : state.rehearsal ? "warn" : "bad";
  const title =
    tone === "ok"
      ? `PROTECTED — live on ${channel || "your channel"}`
      : tone === "warn"
        ? "NOT PROTECTED — rehearsal mode"
        : "NOT PROTECTED — your live stream is exposed";
  const detail =
    tone === "ok"
      ? state.channel.moderating
        ? `Moderating for ${channel}. Chat guard, cover scene and screen masking are armed.`
        : "Chat guard, cover scene and screen masking are armed."
      : tone === "warn"
        ? "Practice only. Fix the items below to protect your real stream."
        : `${missing.length} ${missing.length === 1 ? "layer is" : "layers are"} missing. Fix before you go live.`;
  return (
    <section
      className={"banner " + tone}
      aria-labelledby="protection-title"
      data-protected={tone === "ok"}
    >
      <ShieldMark state={tone} size={34} />
      <div className="banner-copy" aria-live="polite" aria-atomic="true">
        <strong id="protection-title">{title}</strong>
        <span>{detail}</span>
      </div>
      {missing.length > 0 && (
        <ul className="banner-gaps" aria-label="Missing protection">
          {missing.map((gap) => (
            <li key={gap.id}>
              <span>{gap.text}</span>
              <button
                className="banner-fix"
                disabled={busy}
                onClick={gap.action}
              >
                {gap.fix}
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
