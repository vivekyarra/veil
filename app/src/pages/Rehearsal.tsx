import { useState } from "react";
import { run, useVeil } from "../store";
import { MaskedImage } from "../components/MaskedImage";
import type { Scan } from "../types";

const SCENARIOS = [
  ["email", "Email inbox"],
  ["dm", "Private DM"],
  ["terminal", "Terminal key"],
  ["form", "Contact form"],
] as const;

export function Rehearsal() {
  const busy = useVeil((s) => s.busy),
    detector = useVeil((s) => s.state.detector),
    scan = useVeil((s) => s.scan),
    set = useVeil((s) => s.set);
  const [running, setRunning] = useState("");
  const [chatSent, setChatSent] = useState(false);
  return (
    <>
      <div className="notice">
        Pick a practice leak below and watch VEIL find and blur it. Everything
        here is practice: it runs on this computer and never touches your real
        stream.
      </div>
      <div className="scenario-buttons">
        {SCENARIOS.map(([kind, label]) => (
          <button
            key={kind}
            className="secondary"
            disabled={busy || !detector}
            aria-busy={running === kind}
            onClick={async () => {
              setRunning(kind);
              const result = await run("scenario", { kind });
              setRunning("");
              if (result) set({ scan: result as Scan });
            }}
          >
            {label} ↗
          </button>
        ))}
        <button
          className="primary"
          disabled={busy}
          aria-busy={running === "chat"}
          onClick={async () => {
            setRunning("chat");
            const result = await run("simulate-chat");
            setRunning("");
            if (result !== undefined) setChatSent(true);
          }}
        >
          Send practice chat attempts
        </button>
      </div>
      <p className="subtle" role="status">
        {!detector
          ? "The screen detector is still starting. Leak scenarios unlock in a few seconds."
          : running === "chat"
            ? "Sending practice leak attempts to chat…"
            : running
              ? "Scanning the practice screen locally…"
              : chatSent
                ? "Practice chat sent. Check Incidents and the activity feed to see what was removed."
                : "Tip: try Private DM, then Send practice chat attempts."}
      </p>
      <div className="split-grid">
        <section className="panel preview">
          <div className="section-title">
            <h2>Your screen</h2>
            <span>LOCAL PRACTICE</span>
          </div>
          {scan ? (
            <MaskedImage scan={scan} masked={false} />
          ) : (
            <div className="preview-empty">
              <span aria-hidden="true">◇</span>
              <p>Choose a leak scenario to begin.</p>
            </div>
          )}
        </section>
        <section className="panel preview">
          <div className="section-title">
            <h2>Rehearsal result</h2>
            <span className={scan?.masked ? "mask-chip" : ""}>
              {scan?.masked ? "MASKED" : scan ? "TOO LATE" : "WAITING"}
            </span>
          </div>
          {scan ? (
            <MaskedImage scan={scan} masked={true} />
          ) : (
            <div className="preview-empty">
              <span aria-hidden="true">V</span>
              <p>The blurred version your viewers would see appears here.</p>
            </div>
          )}
        </section>
      </div>
      {scan && (
        <div className="panel scan-result">
          <span>
            Check took <strong>{scan.processed_ms.toFixed(1)} ms</strong>
          </span>
          <span>
            Leaks found <strong>{scan.detections.length}</strong>
          </span>
          <span>
            Finished in time{" "}
            <strong>{scan.late ? "No, too slow" : "Yes"}</strong>
          </span>
          <span>
            Masked before viewers saw it{" "}
            <strong>{scan.masked ? "Yes" : "No"}</strong>
          </span>
        </div>
      )}
      <div className="warning">
        If a check finishes too late, Balanced shows that frame without a blur,
        while Paranoid freezes the picture until it is safe. On a slow PC a
        check can take longer than the 3-second maximum delay, so run Pre-flight
        before going live.
      </div>
    </>
  );
}
