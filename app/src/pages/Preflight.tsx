import { useState } from "react";
import { run, useVeil } from "../store";
import { PreflightChecks } from "../components/PreflightChecks";

export function Preflight() {
  const busy = useVeil((s) => s.busy),
    obs = useVeil((s) => s.state.obs),
    detector = useVeil((s) => s.state.detector);
  const [scans, setScans] = useState<
    { source: string; image: string; kinds: string[] }[]
  >([]);
  const [scanning, setScanning] = useState(false);
  const [scanned, setScanned] = useState(false);
  return (
    <section className="panel pad">
      <PreflightChecks />
      <hr />
      <h2>Scan every visible source</h2>
      <p className="subtle">
        Captures each visible OBS source, runs local OCR and shows the masked
        result. Nothing leaves this computer.
      </p>
      <button
        className="secondary"
        disabled={busy || !obs || !detector}
        aria-busy={scanning}
        onClick={async () => {
          setScanning(true);
          const value = await run("source-scan");
          setScanning(false);
          if (Array.isArray(value)) {
            setScans(value as typeof scans);
            setScanned(true);
          }
        }}
      >
        {scanning ? "Scanning sources…" : "Scan every visible source"}
      </button>
      {(!obs || !detector) && (
        <p className="subtle" role="status">
          {!obs
            ? "Connect OBS in Onboarding first, then come back to scan."
            : "The screen detector is still starting. Try again in a few seconds."}
        </p>
      )}
      {scanned && scans.length === 0 && (
        <div className="empty-state compact">
          <h3>No visible sources found.</h3>
          <p>Show a scene with at least one source in OBS, then scan again.</p>
        </div>
      )}
      <div className="scan-grid">
        {scans.map((s) => (
          <figure className="panel" key={s.source}>
            <img
              src={s.image}
              alt={"Masked pre-flight capture of " + s.source}
            />
            <figcaption>
              <strong>{s.source}</strong>
              {s.kinds.length
                ? s.kinds.join(", ")
                : "No configured recognizers triggered"}
            </figcaption>
          </figure>
        ))}
      </div>
    </section>
  );
}
