import { run, useVeil } from "../store";
import type { Check } from "../types";

const refresh = async () => {
  const value = await run("preflight");
  if (Array.isArray(value))
    useVeil.getState().set({ checks: value as Check[] });
};

/** Pre-flight checklist with the one-click measured-delay fix. */
export function PreflightChecks() {
  const checks = useVeil((s) => s.checks),
    busy = useVeil((s) => s.busy),
    obs = useVeil((s) => s.state.obs);
  const failed = checks.filter((c) => c.status === "fail").length;
  return (
    <div className="preflight">
      <div className="section-title">
        <h2>Before the live light</h2>
        <button className="primary" disabled={busy} onClick={refresh}>
          Run checks ↗
        </button>
      </div>
      {checks.length > 0 && (
        <p className={"check-summary " + (failed ? "bad" : "ok")}>
          {failed
            ? `${failed} check${failed === 1 ? "" : "s"} failing`
            : "Every required check passes"}
        </p>
      )}
      {checks.length === 0 ? (
        <div className="empty-state">
          <span aria-hidden="true">✓</span>
          <h3>Take a breath. Check your setup.</h3>
          <p>
            Review scenes, audio timing, inference latency, chat, notifications
            and vault.
          </p>
        </div>
      ) : (
        checks.map((c) => (
          <div className="check-row" key={c.id}>
            <span className={"check-status " + c.status} aria-hidden="true">
              {c.status === "pass" ? "✓" : c.status === "fail" ? "×" : "!"}
            </span>
            <div>
              <h3>{c.title}</h3>
              <p>{c.detail}</p>
              {c.recommendedDelay !== undefined && (
                <button
                  className="secondary"
                  disabled={busy || !obs}
                  onClick={async () => {
                    const value = await run("settings", {
                      delay: c.recommendedDelay,
                    });
                    if (value !== undefined) await refresh();
                  }}
                >
                  Apply measured delay ({c.recommendedDelay} ms)
                </button>
              )}
            </div>
            <span className={"result " + c.status}>{c.status}</span>
          </div>
        ))
      )}
    </div>
  );
}
