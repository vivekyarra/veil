import { useEffect, useState, type ComponentType } from "react";
import { call, useVeil, type Ask, type Page } from "./store";
import type { State } from "./types";
import { Sidebar } from "./components/Sidebar";
import { ProtectionBanner } from "./components/ProtectionBanner";
import { AskModal } from "./components/AskModal";
import { PinPrompt } from "./components/PinPrompt";
import { Dashboard } from "./pages/Dashboard";
import { NeverShow } from "./pages/NeverShow";
import { Incidents } from "./pages/Incidents";
import { Preflight } from "./pages/Preflight";
import { Rehearsal } from "./pages/Rehearsal";
import { Settings } from "./pages/Settings";
import { Onboarding } from "./pages/Onboarding";

const PAGE: Record<
  Page,
  { view: ComponentType; eyebrow: string; title: string; lead: string }
> = {
  Dashboard: {
    view: Dashboard,
    eyebrow: "A LITTLE PRIVACY. A BETTER STREAM.",
    title: "Keep your private life off-stream.",
    lead: "Protection, catches and your panic button, at a glance.",
  },
  "Never Show": {
    view: NeverShow,
    eyebrow: "YOUR STREAM. YOUR BOUNDARIES.",
    title: "Your secrets. Your vault.",
    lead: "Private terms are encrypted on this computer. Moderators cannot read this vault.",
  },
  Incidents: {
    view: Incidents,
    eyebrow: "WHAT HAPPENED, STEP BY STEP",
    title: "Incidents",
    lead: "Every automated action, with timing and outcome. No private text.",
  },
  "Pre-flight": {
    view: Preflight,
    eyebrow: "BEFORE YOU GO LIVE",
    title: "Pre-flight",
    lead: "Check scene protection, audio alignment and the measured delay.",
  },
  Rehearsal: {
    view: Rehearsal,
    eyebrow: "SAFE PRACTICE",
    title: "Practice the unexpected.",
    lead: "Practice with local OCR. Rehearsal keeps Twitch actions isolated.",
  },
  Settings: {
    view: Settings,
    eyebrow: "YOUR RULES",
    title: "Settings",
    lead: "Channel, automation, overlay and detection controls.",
  },
  Onboarding: {
    view: Onboarding,
    eyebrow: "GUIDED SETUP",
    title: "Onboarding",
    lead: "Four steps from install to protected: OBS, Twitch, your terms, pre-flight.",
  },
};

export function App() {
  const page = useVeil((s) => s.page),
    state = useVeil((s) => s.state),
    message = useVeil((s) => s.message),
    busy = useVeil((s) => s.busy),
    set = useVeil((s) => s.set);
  useEffect(() => {
    void call("snapshot");
    const off = window.veil?.subscribe((s) => set({ state: s as State })),
      offAsk = window.veil?.onAsk((a) => set({ ask: a as Ask })),
      offExpired = window.veil?.onAskExpired(() => set({ ask: null }));
    return () => {
      off?.();
      offAsk?.();
      offExpired?.();
    };
  }, [set]);
  useEffect(() => {
    document.documentElement.dataset.theme = state.settings.theme;
  }, [state.settings.theme]);
  // The toast fades after a few seconds but keeps its text for assistive tech.
  const [shown, setShown] = useState(false);
  useEffect(() => {
    if (!message && !busy) return;
    setShown(true);
    const timer = setTimeout(() => setShown(false), 5000);
    return () => clearTimeout(timer);
  }, [message, busy]);
  const { view: View, eyebrow, title, lead } = PAGE[page];
  return (
    <div className="shell">
      <Sidebar />
      <main>
        <ProtectionBanner />
        <header className="topbar">
          <span>
            WORKSPACE <span className="slash">/</span> {page}
          </span>
          <div className="top-actions">
            <label className="mode">
              <input
                type="checkbox"
                checked={state.rehearsal}
                onChange={(e) =>
                  void call("rehearsal", { enabled: e.target.checked })
                }
              />
              Rehearsal
            </label>
            <span className="local-pill">⌁ On-device</span>
          </div>
        </header>
        <div className="content">
          <div className="page-heading">
            <div>
              <div className="eyebrow">{eyebrow}</div>
              <h1>{title}</h1>
              <p>{lead}</p>
            </div>
          </div>
          {!window.veil && (
            <div className="notice">
              Desktop preview — local controls require Electron. Connection
              badges show actual disconnected state.
            </div>
          )}
          <div
            role="status"
            className={"toast " + (shown && (message || busy) ? "visible" : "")}
            aria-live="polite"
          >
            {busy ? "Working locally…" : message}
          </div>
          <View />
          <footer>
            <span>VEIL / STREAM WITH BOUNDARIES</span>
            <span>No cloud inference. No private text in this feed.</span>
          </footer>
        </div>
      </main>
      <AskModal />
      <PinPrompt />
    </div>
  );
}
