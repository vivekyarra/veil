import { saveSettings, useVeil } from "../store";
import { pad2, resultLabel } from "../format";
import { ShieldMark } from "../components/Icon";
import { gaps } from "../components/ProtectionBanner";
import { ActivityFeed, Connections, PanicCard } from "../components/Widgets";

function ago(iso: string): string {
  const minutes = Math.round((Date.now() - Date.parse(iso)) / 60000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  return hours < 48 ? `${hours} h ago` : new Date(iso).toLocaleDateString();
}

function StateCard() {
  const state = useVeil((s) => s.state),
    go = useVeil((s) => s.go);
  const safe = gaps(state, go).length === 0;
  const tone = safe ? "ok" : state.rehearsal ? "warn" : "bad";
  return (
    <section className={"panel state-card " + tone}>
      <div className="state-visual" aria-hidden="true">
        <ShieldMark state={tone} size={72} />
        <span className="halo" />
      </div>
      <div>
        <span className="tag">
          {safe ? "ARMED" : state.rehearsal ? "PRACTICE" : "ACTION NEEDED"}
        </span>
        <h2>
          {safe
            ? "You’re covered."
            : state.rehearsal
              ? "Rehearsing. Nothing live is guarded."
              : "Protection is incomplete."}
        </h2>
        <p>
          {safe
            ? "Screen masking, chat guard and the cover scene are watching."
            : !state.onboardingComplete
              ? "Four short steps: OBS, Twitch, your Never Show terms, then a pre-flight."
              : "The banner above lists exactly what is missing."}
        </p>
        <div className="button-row">
          {!state.onboardingComplete ? (
            <button
              className="primary"
              onClick={() => go("Onboarding", { onboardingStep: 0 })}
            >
              Start guided setup <span aria-hidden="true">↗</span>
            </button>
          ) : (
            <button className="primary" onClick={() => go("Pre-flight")}>
              Run pre-flight <span aria-hidden="true">↗</span>
            </button>
          )}
          <button className="secondary" onClick={() => go("Rehearsal")}>
            Try a rehearsal
          </button>
        </div>
      </div>
    </section>
  );
}

function CatchesCard() {
  const masks = useVeil((s) => s.state.masks),
    removed = useVeil((s) => s.state.removed),
    rehearsal = useVeil((s) => s.state.rehearsal);
  return (
    <section className="panel catches-card" aria-labelledby="catches-title">
      <span className="label" id="catches-title">
        LIVE CATCHES
      </span>
      <strong className="big-number">{pad2(masks + removed)}</strong>
      <dl>
        <div>
          <dt>Masked on screen</dt>
          <dd>{masks}</dd>
        </div>
        <div>
          <dt>{rehearsal ? "Practice chat removed" : "Chat leaks removed"}</dt>
          <dd>{removed}</dd>
        </div>
      </dl>
      <small>This app session. Counts only, never content.</small>
    </section>
  );
}

function LastIncident() {
  const incident = useVeil((s) => s.state.incidents[0]),
    total = useVeil((s) => s.state.incidents.length),
    go = useVeil((s) => s.go);
  return (
    <section className="panel last-incident">
      <div className="section-title">
        <h2>Last incident</h2>
        <span>{total} TOTAL</span>
      </div>
      {!incident ? (
        <div className="empty-state compact">
          <h3>Nothing to contain.</h3>
          <p>Press panic in rehearsal to see the timeline.</p>
        </div>
      ) : (
        <>
          <p className="incident-line">
            <strong>#{incident.id}</strong>
            <span className="tag">{incident.state}</span>
            <span>
              {incident.trigger} · {ago(incident.started)}
              {incident.rehearsal ? " · rehearsal" : ""}
            </span>
          </p>
          <ul className="action-chips" aria-label="Actions taken">
            {incident.actions.slice(0, 6).map((a, i) => (
              <li key={i} className={resultLabel(a).tone}>
                {a.action}
                {a.reason === "timeout" ? " · timed out" : ""}
              </li>
            ))}
          </ul>
          <button
            className="secondary"
            onClick={() => go("Incidents", { incidentId: incident.id })}
          >
            Open incident #{incident.id}
          </button>
        </>
      )}
    </section>
  );
}

export function Dashboard() {
  const state = useVeil((s) => s.state);
  return (
    <>
      <div className="dash-hero">
        <StateCard />
        <CatchesCard />
        <PanicCard />
      </div>
      <div className="dash-row">
        <LastIncident />
        <section className="panel setup-card">
          <div className="section-title">
            <h2>Connections</h2>
            <span>LOCAL</span>
          </div>
          <Connections />
          <div className="profile-row">
            <label>
              Protection profile
              <select
                value={state.settings.profile}
                onChange={(e) => void saveSettings({ profile: e.target.value })}
              >
                <option value="balanced">Balanced: smooth video</option>
                <option value="paranoid">Paranoid: never risk a leak</option>
                <option value="off">Off: no screen masking</option>
              </select>
            </label>
            <div className="delay-display">
              {state.settings.delay}
              <small>ms safety delay</small>
            </div>
          </div>
          <p className="fine-print">
            VEIL delays your stream slightly so it can blur private text before
            viewers see it. Paranoid freezes the picture if a check runs late;
            Balanced keeps video moving and may let a late frame through.
            Pre-flight tells you if your PC is fast enough.
          </p>
        </section>
      </div>
      <ActivityFeed />
    </>
  );
}
