import { call, useVeil } from "../store";
import { feedMeta, hotkeyLabel } from "../format";

export function Connections() {
  const state = useVeil((s) => s.state);
  const items: [string, boolean][] = [
    ["OBS Studio", state.obs],
    ["Detector", state.detector],
    ["Twitch", state.twitch],
    ["Chat guard", state.eventsub],
  ];
  return (
    <ul className="connections" aria-label="Connections">
      {items.map(([label, connected]) => (
        <li key={label} className={"status " + (connected ? "good" : "muted")}>
          <i aria-hidden="true" />
          {label}
          <b>{connected ? "Connected" : "Offline"}</b>
        </li>
      ))}
    </ul>
  );
}

export function ActivityFeed({ limit = 8 }: { limit?: number }) {
  const feed = useVeil((s) => s.state.feed);
  return (
    <section className="panel activity">
      <div className="section-title">
        <h2>Recent activity</h2>
        <span>METADATA ONLY</span>
      </div>
      {feed.length === 0 ? (
        <div className="empty-state">
          <span aria-hidden="true">⌁</span>
          <h3>A quiet feed is a good feed.</h3>
          <p>Connection updates and protection events appear here.</p>
        </div>
      ) : (
        <ol className="events">
          {feed.slice(0, limit).map((e, i) => {
            const meta = feedMeta(e.kind);
            return (
              <li key={e.time + i}>
                <span className={"event-dot " + meta.tone} aria-hidden="true" />
                <div>
                  <strong>{meta.label}</strong>
                  <p>{e.detail}</p>
                </div>
                <time dateTime={e.time}>
                  {new Date(e.time).toLocaleTimeString()}
                </time>
              </li>
            );
          })}
        </ol>
      )}
    </section>
  );
}

export function PanicCard() {
  const busy = useVeil((s) => s.busy),
    state = useVeil((s) => s.state);
  return (
    <section className="panel panic-card">
      <div className="section-title">
        <h2>Need a clean break?</h2>
        <span className="red-dot" aria-hidden="true">
          ●
        </span>
      </div>
      <button
        className="panic"
        onClick={() => void call("panic")}
        disabled={busy}
        aria-keyshortcuts={state.settings.hotkey}
      >
        <span aria-hidden="true">▣</span>
        PANIC
      </button>
      <p className="hotkey">
        or press <kbd>{hotkeyLabel(state.settings.hotkey)}</kbd> anywhere
      </p>
      <small>
        Covers your stream
        {state.settings.modes.mute === "off" ? "" : ", mutes audio"} and opens
        an incident.{" "}
        {state.rehearsal
          ? "Rehearsal: Twitch actions stay in local practice mode."
          : "Twitch actions need authorization."}
      </small>
    </section>
  );
}
