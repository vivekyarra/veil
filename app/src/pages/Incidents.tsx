import { useState } from "react";
import { run, useVeil } from "../store";
import { ACTIONS, resultLabel } from "../format";
import type { Incident } from "../types";

const timeouts = (incident: Incident) =>
  incident.actions.filter((a) => a.reason === "timeout").length;

function Detail({ incident }: { incident: Incident }) {
  const set = useVeil((s) => s.set);
  const [includePrivate, setIncludePrivate] = useState(false),
    [pin, setPin] = useState("");
  const exportAs = (format: "md" | "pdf") =>
    void run("export", { id: incident.id, format, includePrivate, pin });
  const declined = timeouts(incident);
  return (
    <>
      <button className="back" onClick={() => set({ incidentId: null })}>
        ← All incidents
      </button>
      <div className="section-title">
        <h2>Incident #{incident.id}</h2>
        <span className="tag">{incident.state}</span>
      </div>
      <p>
        {incident.rehearsal ? "Rehearsal • " : ""}
        {incident.trigger} • {new Date(incident.started).toLocaleString()} →{" "}
        {incident.ended ? new Date(incident.ended).toLocaleString() : "open"}
      </p>
      {declined > 0 && (
        <div className="warning">
          {declined} approval{declined === 1 ? "" : "s"} expired with no answer
          and {declined === 1 ? "was" : "were"} declined automatically. Switch
          {declined === 1 ? " that action" : " those actions"} to auto in
          Settings if you want it to run without asking.
        </div>
      )}
      {incident.marker ? (
        <p>Marker at {incident.marker.position_seconds} seconds</p>
      ) : (
        <div className="notice">
          No VOD marker available. Use the wall-clock window for manual review.
        </div>
      )}
      <ol className="timeline">
        {incident.actions.map((a, i) => {
          const result = resultLabel(a);
          return (
            <li key={i} className={result.tone}>
              <span className="timeline-dot" aria-hidden="true" />
              <strong>{ACTIONS[a.action]?.label ?? a.action}</strong>
              <span className={"result " + result.tone}>{result.text}</span>
              <small>
                {new Date(a.time).toLocaleTimeString()} ·{" "}
                {a.duration_ms.toFixed(1)} ms
                {a.reason && a.reason !== "timeout" ? " · " + a.reason : ""}
              </small>
            </li>
          );
        })}
      </ol>
      <h3>Posting attempts</h3>
      {Object.keys(incident.attempts).length === 0 && (
        <p className="subtle">No repeated chat attempts recorded.</p>
      )}
      {Object.entries(incident.attempts).map(([name, count]) => (
        <p key={name}>
          {name}: {count}
        </p>
      ))}
      <h3>{incident.clips.length} clips to review</h3>
      <div className="button-row">
        <button onClick={() => void run("incident-clips", { id: incident.id })}>
          Refresh clip list
        </button>
        <button onClick={() => void run("external", { target: "clips" })}>
          Open clips manager ↗
        </button>
        <button onClick={() => void run("external", { target: "videos" })}>
          Video Producer ↗
        </button>
      </div>
      <div className="export-bar">
        <label className="check">
          <input
            type="checkbox"
            checked={includePrivate}
            onChange={(e) => setIncludePrivate(e.target.checked)}
          />
          Include private text (requires PIN)
        </label>
        {includePrivate && (
          <input
            type="password"
            aria-label="Vault PIN for private report"
            value={pin}
            onChange={(e) => setPin(e.target.value)}
          />
        )}
        <button onClick={() => exportAs("md")}>Export Markdown</button>
        <button onClick={() => exportAs("pdf")}>Export PDF</button>
        {incident.state !== "closed" && (
          <button
            className="primary"
            onClick={() => void run("incident-close", { id: incident.id })}
          >
            Close incident
          </button>
        )}
      </div>
    </>
  );
}

export function Incidents() {
  const incidents = useVeil((s) => s.state.incidents),
    incidentId = useVeil((s) => s.incidentId),
    set = useVeil((s) => s.set);
  const incident = incidents.find((i) => i.id === incidentId);
  return (
    <section className="panel pad">
      {incident ? (
        <Detail incident={incident} />
      ) : (
        <>
          <div className="section-title">
            <h2>Incident history</h2>
            <button
              className="secondary"
              onClick={() => void run("incident-open")}
            >
              Open an incident
            </button>
          </div>
          {incidents.length === 0 ? (
            <div className="empty-state">
              <span aria-hidden="true">⚑</span>
              <h3>Nothing to contain.</h3>
              <p>Try panic in rehearsal to explore the incident timeline.</p>
            </div>
          ) : (
            incidents.map((i) => (
              <button
                key={i.id}
                className="incident-row"
                onClick={() => set({ incidentId: i.id })}
              >
                <strong>
                  #{i.id} <span>{i.trigger}</span>
                </strong>
                {timeouts(i) > 0 && (
                  <span className="result timeout">
                    {timeouts(i)} timed out
                  </span>
                )}
                <span>{i.rehearsal ? "Rehearsal" : "Connected"}</span>
                <time dateTime={i.started}>
                  {new Date(i.started).toLocaleString()}
                </time>
                <span className="tag">{i.state}</span>
                <span aria-hidden="true">↗</span>
              </button>
            ))
          )}
        </>
      )}
    </section>
  );
}
