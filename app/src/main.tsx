import React, { useEffect, useState, useRef, useCallback } from "react";
import { createRoot } from "react-dom/client";
import { create } from "zustand";
import type { State, Scan } from "./types";
import "./style.css";
const sections = [
  "Dashboard",
  "Never Show",
  "Incidents",
  "Pre-flight",
  "Rehearsal",
  "Settings",
  "Onboarding",
] as const;
type Page = (typeof sections)[number];
const initial: State = {
  rehearsal: true,
  settings: {
    profile: "paranoid",
    delay: 750,
    sampleFps: 4,
    theme: "dark",
    hotkey: "Control+Shift+F12",
    obsUrl: "ws://127.0.0.1:4455",
    discord: "",
    retentionDays: 30,
    ignoreZones: [],
    denylist: [],
    modes: {},
    recognizers: [
      "email",
      "phone",
      "card",
      "ip",
      "address",
      "secret",
      "vault",
      "window",
    ],
    thresholds: {},
    gameId: "default",
    gameZones: {},
  },
  obs: false,
  detector: false,
  twitch: false,
  twitchClientId: "",
  eventsub: false,
  vault: [],
  hasPin: false,
  incidents: [],
  feed: [],
  masks: 0,
  removed: 0,
  tokenFile: "",
};
function Icon({ kind }: { kind: string }) {
  return (
    <span className={"icon " + kind} aria-hidden="true">
      {(
        {
          Dashboard: "◈",
          "Never Show": "◇",
          Incidents: "⚑",
          "Pre-flight": "✓",
          Rehearsal: "▷",
          Settings: "⚙",
          Onboarding: "↗",
        } as Record<string, string>
      )[kind] ?? "·"}
    </span>
  );
}
function MaskedImage({ scan, masked }: { scan: Scan; masked: boolean }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const image = new Image();
    image.onload = () => {
      const c = ref.current;
      if (!c) return;
      c.width = image.width;
      c.height = image.height;
      const ctx = c.getContext("2d")!;
      ctx.drawImage(image, 0, 0);
      if (masked) {
        ctx.fillStyle = "#171c29";
        if (scan.fullHold) {
          ctx.fillRect(0, 0, c.width, c.height);
          ctx.fillStyle = "#c0f69e";
          ctx.font = "28px Arial";
          ctx.fillText("Hold on — VEIL is checking", 70, 110);
        } else if (scan.masked)
          for (const d of scan.detections)
            ctx.fillRect(
              d.box.x * c.width,
              d.box.y * c.height,
              d.box.w * c.width,
              d.box.h * c.height,
            );
      }
    };
    image.src = scan.image;
  }, [scan, masked]);
  return (
    <canvas
      ref={ref}
      aria-label={masked ? "Rehearsal result" : "Original practice capture"}
    />
  );
}
const useVeilStore = create<{ state: State; setState: (state: State) => void }>(
  (set) => ({ state: initial, setState: (state) => set({ state }) }),
);
function App() {
  const { state, setState } = useVeilStore();
  const [page, setPage] = useState<Page>("Dashboard"),
    [message, setMessage] = useState(""),
    [busy, setBusy] = useState(false),
    [ask, setAsk] = useState<{
      id: string;
      action: string;
      expires: number;
    } | null>(null),
    [remaining, setRemaining] = useState(10);
  const [term, setTerm] = useState(""),
    [editingId, setEditingId] = useState<string | null>(null),
    [importText, setImportText] = useState(""),
    [category, setCategory] = useState("name"),
    [pin, setPin] = useState(""),
    [revealed, setRevealed] = useState<Record<string, string>>({}),
    [obsUrl, setObsUrl] = useState(initial.settings.obsUrl),
    [obsPassword, setObsPassword] = useState(""),
    [scenes, setScenes] = useState<string[]>([]),
    [selected, setSelected] = useState<string[]>([]),
    [checks, setChecks] = useState<
      {
        id: string;
        title: string;
        status: string;
        detail: string;
        recommendedDelay?: number;
      }[]
    >([]),
    [sourceScans, setSourceScans] = useState<
      { source: string; image: string; kinds: string[] }[]
    >([]),
    [scan, setScan] = useState<Scan | null>(null),
    [incidentId, setIncidentId] = useState<number | null>(null),
    [webhook, setWebhook] = useState(""),
    [denylist, setDenylist] = useState(""),
    [hotkey, setHotkey] = useState(""),
    [zoneStart, setZoneStart] = useState<{ x: number; y: number } | null>(null),
    [includePrivate, setIncludePrivate] = useState(false);
  const run = useCallback(
    async (operation: string, input?: unknown): Promise<unknown> => {
      if (!window.veil) {
        setMessage("Open the Electron desktop app to connect local services.");
        return undefined;
      }
      setBusy(true);
      try {
        const response = await window.veil.command(operation, input);
        if (!response.ok) throw new Error(response.error);
        if (
          response.value &&
          typeof response.value === "object" &&
          "rehearsal" in response.value
        )
          setState(response.value as State);
        setMessage(operation === "snapshot" ? "" : "Done");
        return response.value;
      } catch (error) {
        setMessage(error instanceof Error ? error.message : "Action failed");
        return undefined;
      } finally {
        setBusy(false);
      }
    },
    [setState],
  );
  useEffect(() => {
    void run("snapshot");
    const off = window.veil?.subscribe((s) => setState(s as State)),
      offAsk = window.veil?.onAsk((a) => {
        setAsk(a as typeof ask);
        setRemaining(10);
      }),
      offExpired = window.veil?.onAskExpired(() => setAsk(null));
    return () => {
      off?.();
      offAsk?.();
      offExpired?.();
    };
  }, [run, setState]);
  useEffect(() => {
    document.documentElement.dataset.theme = state.settings.theme;
  }, [state.settings.theme]);
  useEffect(() => {
    if (!ask) return;
    const timer = setInterval(
      () =>
        setRemaining(Math.max(0, Math.ceil((ask.expires - Date.now()) / 1000))),
      200,
    );
    return () => clearInterval(timer);
  }, [ask]);
  useEffect(() => {
    const timer = setTimeout(() => setRevealed({}), 30000);
    return () => clearTimeout(timer);
  }, [revealed]);
  const incident = state.incidents.find((i) => i.id === incidentId);
  const status = (label: string, connected: boolean) => (
    <span className={"status " + (connected ? "good" : "muted")}>
      <i />
      {label}
      <b>{connected ? "Connected" : "Offline"}</b>
    </span>
  );
  const settings = (input: unknown) => void run("settings", input);
  const panic = () => void run("panic");
  return (
    <div className="shell">
      <aside className="sidebar">
        <a
          href="#"
          className="brand"
          onClick={(e) => {
            e.preventDefault();
            setPage("Dashboard");
          }}
          aria-label="VEIL home"
        >
          <span className="brand-mark">V</span>VEIL
          <span className="version">LOCAL / 01</span>
        </a>
        <div className="nav-label">YOUR PRIVATE SIDE</div>
        <nav aria-label="Main">
          {sections.map((section) => (
            <button
              key={section}
              className={page === section ? "active" : ""}
              onClick={() => {
                setPage(section);
                setIncidentId(null);
              }}
            >
              <Icon kind={section} />
              {section}
              {section === "Incidents" && state.incidents.length > 0 && (
                <small>{state.incidents.length}</small>
              )}
            </button>
          ))}
        </nav>
        <div className="privacy-note">
          <span className="tiny-shield">◇</span>
          <strong>What’s yours stays yours.</strong>
          <p>Detection runs on this computer. Your vault stays private.</p>
          <span className="local-label">● LOCAL INFERENCE</span>
        </div>
        <button className="profile" onClick={() => setPage("Onboarding")}>
          <span className="avatar">V</span>
          <span>
            Streamer workspace
            <small>
              {state.rehearsal ? "Rehearsal mode" : "Connected mode"}
            </small>
          </span>
          <span>↗</span>
        </button>
      </aside>
      <main>
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
                  void run("rehearsal", { enabled: e.target.checked })
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
              <div className="eyebrow">
                {page === "Dashboard"
                  ? "A LITTLE PRIVACY. A BETTER STREAM."
                  : "YOUR STREAM. YOUR BOUNDARIES."}
              </div>
              <h1>
                {page === "Dashboard"
                  ? "Keep your private life off-stream."
                  : page === "Never Show"
                    ? "Your secrets. Your vault."
                    : page === "Rehearsal"
                      ? "Practice the unexpected."
                      : page}
              </h1>
              <p>
                {page === "Dashboard"
                  ? "A clear view of your protection, before you go live."
                  : page === "Never Show"
                    ? "Private terms are encrypted on this computer. Moderators cannot read this vault."
                    : page === "Rehearsal"
                      ? "Practice with local OCR. Rehearsal keeps Twitch actions isolated."
                      : "Local controls, clear results, no private details in the feed."}
              </p>
            </div>
            <span className="workspace-badge">
              {state.rehearsal ? "● REHEARSAL" : "● CONNECTED MODE"}
            </span>
          </div>
          {!window.veil && (
            <div className="notice">
              Desktop preview — local controls require Electron. Connection
              badges show actual disconnected state.
            </div>
          )}
          <div
            role="status"
            className={"toast " + (message ? "visible" : "")}
            aria-live="polite"
          >
            {busy ? "Working locally…" : message}
          </div>
          {page === "Dashboard" && (
            <>
              <section className="hero panel">
                <div className="hero-visual" aria-hidden="true">
                  <div className="shield-outline">V</div>
                  <span className="orbit o1" />
                  <span className="orbit o2" />
                  <span className="orbit-dot" />
                </div>
                <div className="hero-copy">
                  <span className="tag">
                    {state.obs && state.detector
                      ? "CHECK YOUR LOOKAHEAD BUDGET"
                      : "READY WHEN YOU ARE"}
                  </span>
                  <h2>
                    {state.obs && state.detector
                      ? "Local services connected."
                      : "Your next stream starts here."}
                  </h2>
                  <p>
                    {state.rehearsal
                      ? "Practice common leak scenarios, then check your setup before going live."
                      : "Verify your scenes, audio and detector budget before going live."}
                  </p>
                  <div className="hero-buttons">
                    <button
                      className="primary"
                      onClick={() => setPage("Pre-flight")}
                    >
                      Run pre-flight <span>↗</span>
                    </button>
                    <button
                      className="secondary"
                      onClick={() => setPage("Rehearsal")}
                    >
                      Try a rehearsal
                    </button>
                  </div>
                </div>
                <div className="hero-spec">
                  <span>PROTECTION PROFILE</span>
                  <select
                    aria-label="Protection profile"
                    value={state.settings.profile}
                    onChange={(e) => settings({ profile: e.target.value })}
                  >
                    <option value="balanced">Balanced</option>
                    <option value="paranoid">Paranoid</option>
                    <option value="off">Off</option>
                  </select>
                  <div className="delay-display">
                    {state.settings.delay}
                    <small>ms</small>
                  </div>
                  <p>Lookahead delay</p>
                  <span className="fine-print">
                    Paranoid waits for confirmed frames. Balanced permits late
                    output.
                    <br />
                    Pre-flight checks the measured budget.
                  </span>
                </div>
              </section>
              <section className="connections" aria-label="Connections">
                {status("OBS Studio", state.obs)}
                {status("Detector", state.detector)}
                {status("Twitch", state.twitch)}
                {status("Chat guard", state.eventsub)}
              </section>
              <div className="stats-grid">
                <div className="panel stat">
                  <span>
                    PRIVATE REGIONS FOUND <span>◇</span>
                  </span>
                  <strong>{state.masks.toString().padStart(2, "0")}</strong>
                  <small>Detector events this app session</small>
                </div>
                <div className="panel stat">
                  <span>
                    CHAT MESSAGES REMOVED <span>≋</span>
                  </span>
                  <strong>{state.removed.toString().padStart(2, "0")}</strong>
                  <small>
                    {state.rehearsal
                      ? "Practice moderation"
                      : "EventSub → Helix deletion"}
                  </small>
                </div>
                <div className="panel stat">
                  <span>
                    INCIDENTS <span>⚑</span>
                  </span>
                  <strong>
                    {state.incidents.length.toString().padStart(2, "0")}
                  </strong>
                  <small>
                    {state.incidents.filter((i) => i.state !== "closed").length}{" "}
                    currently open
                  </small>
                </div>
              </div>
              <div className="bottom-grid">
                <section className="panel activity">
                  <div className="section-title">
                    <h2>Recent activity</h2>
                    <span>METADATA ONLY</span>
                  </div>
                  {state.feed.length === 0 ? (
                    <div className="empty-state">
                      <span>⌁</span>
                      <h3>A quiet feed is a good feed.</h3>
                      <p>
                        Connection updates and protection events appear here.
                      </p>
                    </div>
                  ) : (
                    <ol className="events">
                      {state.feed.slice(0, 8).map((e, i) => (
                        <li key={i}>
                          <span className="event-dot" />
                          <div>
                            <strong>{e.kind}</strong>
                            <p>{e.detail}</p>
                          </div>
                          <time>{new Date(e.time).toLocaleTimeString()}</time>
                        </li>
                      ))}
                    </ol>
                  )}
                </section>
                <section className="panel panic-card">
                  <div className="section-title">
                    <h2>Need a clean break?</h2>
                    <span className="red-dot">●</span>
                  </div>
                  <p>
                    Cover your stream and open an incident.
                    <br />
                    Your microphone remains live in the cover scene.
                  </p>
                  <button className="panic" onClick={panic} disabled={busy}>
                    ▣ <span>PANIC</span> ↗
                  </button>
                  <kbd>
                    {state.settings.hotkey
                      .replace("Control", "Ctrl")
                      .replaceAll("+", " + ")}
                  </kbd>
                  <small>
                    {state.rehearsal
                      ? "Rehearsal: cover and Twitch actions stay in local practice mode."
                      : "Requires OBS for scene switching. Twitch actions need authorization."}
                  </small>
                </section>
              </div>
            </>
          )}
          {page === "Never Show" && (
            <div className="two-columns">
              <section className="panel pad">
                <h2>Never Show vault</h2>
                <p className="subtle">
                  Entries are masked until you unlock them with your app PIN.
                </p>
                {state.vault.length === 0 && (
                  <div className="empty-state">
                    <span>◇</span>
                    <h3>Keep your boundaries close.</h3>
                    <p>Add a name, address or another private term.</p>
                  </div>
                )}
                {state.vault.map((entry) => (
                  <div className="vault-row" key={entry.id}>
                    <span className="vault-category">{entry.category}</span>
                    <strong>{revealed[entry.id] ?? "•••• •••• ••••"}</strong>
                    <button
                      aria-label={"Reveal " + entry.category}
                      onClick={async () => {
                        const value = await run("vault-reveal", {
                          id: entry.id,
                        });
                        if (typeof value === "string")
                          setRevealed((v) => ({ ...v, [entry.id]: value }));
                      }}
                    >
                      Reveal
                    </button>
                    <button
                      aria-label={"Edit " + entry.category}
                      onClick={async () => {
                        const value = await run("vault-reveal", {
                          id: entry.id,
                        });
                        if (typeof value === "string") {
                          setTerm(value);
                          setCategory(entry.category);
                          setEditingId(entry.id);
                        }
                      }}
                    >
                      Edit
                    </button>
                    <button
                      aria-label={"Delete " + entry.category}
                      onClick={() => void run("vault-delete", { id: entry.id })}
                    >
                      Delete
                    </button>
                    <label className="check">
                      <input
                        type="checkbox"
                        checked={entry.optedIn}
                        onChange={() => {
                          if (
                            confirm(
                              "Twitch moderators can read this term in blocked terms. Continue?",
                            )
                          )
                            void run("vault-optin", {
                              id: entry.id,
                              confirm: true,
                            });
                        }}
                      />
                      Share as blocked term
                    </label>
                  </div>
                ))}
                <div className="warning">
                  Blocked terms are separate: opting in sends the term to
                  Twitch, where moderators can read it.
                </div>
                <button
                  className="danger-text"
                  onClick={() => {
                    if (
                      confirm("Wipe your local vault? This cannot be undone.")
                    )
                      void run("vault-wipe", { confirm: true });
                  }}
                >
                  Wipe local vault
                </button>
              </section>
              <section className="panel pad">
                <h2>
                  {editingId ? "Edit private term" : "Add a private term"}
                </h2>
                <form
                  onSubmit={(e) => {
                    e.preventDefault();
                    void run(editingId ? "vault-edit" : "vault-add", {
                      id: editingId,
                      text: term,
                      category,
                    }).then(() => {
                      setTerm("");
                      setEditingId(null);
                    });
                  }}
                >
                  <label>
                    Category
                    <select
                      value={category}
                      onChange={(e) => setCategory(e.target.value)}
                    >
                      {[
                        "name",
                        "address",
                        "city",
                        "phone",
                        "email",
                        "family",
                        "school",
                        "plate",
                        "custom",
                      ].map((c) => (
                        <option key={c}>{c}</option>
                      ))}
                    </select>
                  </label>
                  <label>
                    Private term
                    <input
                      type="password"
                      autoComplete="off"
                      value={term}
                      onChange={(e) => setTerm(e.target.value)}
                      maxLength={500}
                      required
                    />
                  </label>
                  <button className="primary" disabled={busy}>
                    {editingId ? "Save private term" : "Add to vault"}
                  </button>
                </form>
                {editingId && (
                  <button
                    onClick={() => {
                      setEditingId(null);
                      setTerm("");
                    }}
                  >
                    Cancel edit
                  </button>
                )}
                <label>
                  Import terms (one per line; concealed while typing)
                  <textarea
                    className="private-input"
                    value={importText}
                    onChange={(e) => setImportText(e.target.value)}
                    autoComplete="off"
                    maxLength={20000}
                  />
                </label>
                <button
                  onClick={() =>
                    void run("vault-import", {
                      text: importText,
                      category,
                    }).then(() => setImportText(""))
                  }
                >
                  Import to selected category
                </button>
                <hr />
                <h3>
                  {state.hasPin ? "Unlock for 30 seconds" : "Set your app PIN"}
                </h3>
                <label>
                  6–12 digit PIN
                  <input
                    type="password"
                    inputMode="numeric"
                    value={pin}
                    onChange={(e) => setPin(e.target.value)}
                    maxLength={12}
                    autoComplete="off"
                  />
                </label>
                <button
                  className="secondary"
                  onClick={() =>
                    void run(state.hasPin ? "vault-unlock" : "vault-pin", {
                      pin,
                    }).then(() => setPin(""))
                  }
                >
                  {state.hasPin ? "Unlock vault" : "Set PIN"}
                </button>
              </section>
            </div>
          )}
          {page === "Incidents" && (
            <section className="panel pad">
              {incident ? (
                <>
                  <button className="back" onClick={() => setIncidentId(null)}>
                    ← All incidents
                  </button>
                  <div className="section-title">
                    <h2>Incident #{incident.id}</h2>
                    <span className="tag">{incident.state}</span>
                  </div>
                  <p>
                    {incident.rehearsal ? "Rehearsal • " : ""}
                    {incident.started} → {incident.ended ?? "open"}
                  </p>
                  {incident.marker ? (
                    <p>Marker at {incident.marker.position_seconds} seconds</p>
                  ) : (
                    <div className="notice">
                      No VOD marker available. Use the wall-clock window for
                      manual review.
                    </div>
                  )}
                  <ol className="timeline">
                    {incident.actions.map((a, i) => (
                      <li key={i}>
                        <strong>{a.action}</strong>
                        <span className={"result " + a.status}>{a.status}</span>
                        <small>
                          {a.duration_ms.toFixed(1)} ms {a.reason}
                        </small>
                      </li>
                    ))}
                  </ol>
                  <h3>Posting attempts</h3>
                  {Object.entries(incident.attempts).map(([name, count]) => (
                    <p key={name}>
                      {name}: {count}
                    </p>
                  ))}
                  <h3>{incident.clips.length} clips to review</h3>
                  <button
                    onClick={() =>
                      void run("incident-clips", { id: incident.id })
                    }
                  >
                    Refresh clip list
                  </button>
                  <button
                    onClick={() => void run("external", { target: "clips" })}
                  >
                    Open clips manager ↗
                  </button>
                  <button
                    onClick={() => void run("external", { target: "videos" })}
                  >
                    Video Producer ↗
                  </button>
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
                    <button
                      onClick={() =>
                        void run("export", {
                          id: incident.id,
                          format: "md",
                          includePrivate,
                          pin,
                        })
                      }
                    >
                      Export Markdown
                    </button>
                    <button
                      onClick={() =>
                        void run("export", {
                          id: incident.id,
                          format: "pdf",
                          includePrivate,
                          pin,
                        })
                      }
                    >
                      Export PDF
                    </button>
                    {incident.state !== "closed" && (
                      <button
                        className="primary"
                        onClick={() =>
                          void run("incident-close", { id: incident.id })
                        }
                      >
                        Close incident
                      </button>
                    )}
                  </div>
                </>
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
                  {state.incidents.length === 0 ? (
                    <div className="empty-state">
                      <span>⚑</span>
                      <h3>Nothing to contain.</h3>
                      <p>
                        Try panic in rehearsal to explore the incident timeline.
                      </p>
                    </div>
                  ) : (
                    state.incidents.map((i) => (
                      <button
                        key={i.id}
                        className="incident-row"
                        onClick={() => setIncidentId(i.id)}
                      >
                        <strong>
                          #{i.id} <span>{i.trigger}</span>
                        </strong>
                        <span>{i.rehearsal ? "Rehearsal" : "Connected"}</span>
                        <time>{new Date(i.started).toLocaleString()}</time>
                        <span className="tag">{i.state}</span>
                        <span>↗</span>
                      </button>
                    ))
                  )}
                </>
              )}
            </section>
          )}
          {page === "Pre-flight" && (
            <section className="panel pad">
              <div className="section-title">
                <h2>Before the live light</h2>
                <button
                  className="primary"
                  disabled={busy}
                  onClick={async () => {
                    const value = await run("preflight");
                    if (Array.isArray(value)) setChecks(value as typeof checks);
                  }}
                >
                  Run checks ↗
                </button>
              </div>
              <p className="subtle">
                Check scene protection, audio alignment, and the measured delay
                before going live.
              </p>
              <button
                className="secondary"
                disabled={busy || !state.obs || !state.detector}
                onClick={async () => {
                  const value = await run("source-scan");
                  if (Array.isArray(value))
                    setSourceScans(value as typeof sourceScans);
                }}
              >
                Scan every visible source
              </button>
              {sourceScans.map((s) => (
                <div className="panel pad" key={s.source}>
                  <h3>{s.source}</h3>
                  <p>
                    {s.kinds.length
                      ? s.kinds.join(", ")
                      : "No configured recognizers triggered"}
                  </p>
                  <img
                    src={s.image}
                    style={{ width: "100%", maxWidth: 520 }}
                    alt={"Masked pre-flight capture of " + s.source}
                  />
                </div>
              ))}
              {checks.length === 0 ? (
                <div className="empty-state">
                  <span>✓</span>
                  <h3>Take a breath. Check your setup.</h3>
                  <p>
                    Review scenes, audio timing, inference latency, chat,
                    notifications and vault.
                  </p>
                </div>
              ) : (
                checks.map((c) => (
                  <div className="check-row" key={c.id}>
                    <span className={"check-status " + c.status}>
                      {c.status === "pass"
                        ? "✓"
                        : c.status === "fail"
                          ? "×"
                          : "!"}
                    </span>
                    <div>
                      <h3>{c.title}</h3>
                      <p>{c.detail}</p>
                      {c.recommendedDelay !== undefined && (
                        <button
                          className="secondary"
                          disabled={busy || !state.obs}
                          onClick={async () => {
                            const value = await run("settings", {
                              delay: c.recommendedDelay,
                            });
                            if (value !== undefined) {
                              const updated = await run("preflight");
                              if (Array.isArray(updated))
                                setChecks(updated as typeof checks);
                            }
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
            </section>
          )}
          {page === "Rehearsal" && (
            <>
              <div className="notice">
                Practice captures → local OCR → measured delay check. Rehearsal
                runs locally and does not change your broadcast.
              </div>
              <div className="scenario-buttons">
                {[
                  ["email", "Email inbox"],
                  ["dm", "Private DM"],
                  ["terminal", "Terminal key"],
                  ["form", "Contact form"],
                ].map(([kind, label]) => (
                  <button
                    key={kind}
                    className="secondary"
                    disabled={busy || !state.detector}
                    onClick={async () => {
                      const result = await run("scenario", { kind });
                      if (result) setScan(result as Scan);
                    }}
                  >
                    {label} ↗
                  </button>
                ))}
                <button
                  className="primary"
                  onClick={() => void run("simulate-chat")}
                >
                  Simulate chat attempts
                </button>
              </div>
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
                      <span>◇</span>
                      <p>Choose a leak scenario to begin.</p>
                    </div>
                  )}
                </section>
                <section className="panel preview">
                  <div className="section-title">
                    <h2>Rehearsal result</h2>
                    <span>
                      {scan?.masked
                        ? "MASKED"
                        : scan
                          ? "LATE / REVIEW"
                          : "WAITING"}
                    </span>
                  </div>
                  {scan ? (
                    <MaskedImage scan={scan} masked={true} />
                  ) : (
                    <div className="preview-empty">
                      <span>V</span>
                      <p>Measured protection appears here.</p>
                    </div>
                  )}
                </section>
              </div>
              {scan && (
                <div className="panel scan-result">
                  <span>
                    Detector <strong>{scan.processed_ms.toFixed(1)} ms</strong>
                  </span>
                  <span>
                    Regions <strong>{scan.detections.length}</strong>
                  </span>
                  <span>
                    Deadline{" "}
                    <strong>{scan.late ? "Missed" : "Within budget"}</strong>
                  </span>
                  <span>
                    Mask before output{" "}
                    <strong>{scan.masked ? "Yes" : "No"}</strong>
                  </span>
                </div>
              )}
              <div className="warning">
                Balanced emits a late frame without a mask. Paranoid holds the
                entire frame while results are late. CPU latency can exceed the
                maximum 3-second delay.
              </div>
            </>
          )}
          {page === "Settings" && (
            <div className="two-columns">
              <section className="panel pad">
                <h2>Protection & timing</h2>
                <button onClick={() => void run("logs-export")}>
                  Export metadata diagnostics
                </button>
                <label>
                  Profile
                  <select
                    value={state.settings.profile}
                    onChange={(e) => settings({ profile: e.target.value })}
                  >
                    {["balanced", "paranoid", "off"].map((v) => (
                      <option key={v}>{v}</option>
                    ))}
                  </select>
                </label>
                <label>
                  Lookahead delay (300–3000 ms)
                  <input
                    type="number"
                    min={300}
                    max={3000}
                    step={50}
                    value={state.settings.delay}
                    onChange={(e) =>
                      settings({ delay: Number(e.target.value) })
                    }
                  />
                </label>
                <label>
                  Sample FPS
                  <input
                    type="number"
                    min={1}
                    max={10}
                    value={state.settings.sampleFps}
                    onChange={(e) =>
                      settings({ sampleFps: Number(e.target.value) })
                    }
                  />
                </label>
                <label>
                  Theme
                  <select
                    value={state.settings.theme}
                    onChange={(e) => settings({ theme: e.target.value })}
                  >
                    <option>dark</option>
                    <option>light</option>
                  </select>
                </label>
                <label>
                  Panic shortcut
                  <input
                    value={hotkey || state.settings.hotkey}
                    onChange={(e) => setHotkey(e.target.value)}
                  />
                </label>
                <button onClick={() => settings({ hotkey })}>
                  Register shortcut
                </button>
                <label>
                  Data retention (days)
                  <input
                    type="number"
                    min={1}
                    max={365}
                    value={state.settings.retentionDays}
                    onChange={(e) =>
                      settings({ retentionDays: Number(e.target.value) })
                    }
                  />
                </label>
                <hr />
                <h3>Ignore zones</h3>
                <label>
                  Twitch category ID for ignore zones
                  <input
                    defaultValue={state.settings.gameId}
                    onBlur={(e) => settings({ gameId: e.target.value })}
                  />
                </label>
                <p className="subtle">
                  Draw a rectangle on the last practice capture. Zones never
                  exclude vault, secret or window detections.
                </p>
                {scan ? (
                  <div
                    className="zone-editor"
                    onPointerDown={(e) => {
                      const b = e.currentTarget.getBoundingClientRect();
                      setZoneStart({
                        x: (e.clientX - b.left) / b.width,
                        y: (e.clientY - b.top) / b.height,
                      });
                      e.currentTarget.setPointerCapture(e.pointerId);
                    }}
                    onPointerUp={(e) => {
                      if (!zoneStart) return;
                      const b = e.currentTarget.getBoundingClientRect(),
                        x = (e.clientX - b.left) / b.width,
                        y = (e.clientY - b.top) / b.height;
                      settings({
                        ignoreZones: [
                          ...state.settings.ignoreZones,
                          {
                            x: Math.min(zoneStart.x, x),
                            y: Math.min(zoneStart.y, y),
                            w: Math.abs(x - zoneStart.x),
                            h: Math.abs(y - zoneStart.y),
                          },
                        ],
                      });
                      setZoneStart(null);
                    }}
                  >
                    <img
                      src={scan.image}
                      alt="Practice capture for ignore-zone editing"
                    />
                    {state.settings.ignoreZones.map((b, i) => (
                      <span
                        key={i}
                        style={{
                          left: b.x * 100 + "%",
                          top: b.y * 100 + "%",
                          width: b.w * 100 + "%",
                          height: b.h * 100 + "%",
                        }}
                      />
                    ))}
                  </div>
                ) : (
                  <p>Run a rehearsal capture first.</p>
                )}
                <button onClick={() => settings({ ignoreZones: [] })}>
                  Clear zones
                </button>
              </section>
              <section className="panel pad">
                <h2>Incident automation</h2>
                <h3>Recognizers & confidence</h3>
                {[
                  "email",
                  "phone",
                  "card",
                  "ip",
                  "address",
                  "secret",
                  "vault",
                  "window",
                ].map((kind) => (
                  <div className="setting-row" key={kind}>
                    <label className="check">
                      <input
                        type="checkbox"
                        checked={state.settings.recognizers.includes(kind)}
                        onChange={(e) =>
                          settings({
                            recognizers: e.target.checked
                              ? [...state.settings.recognizers, kind]
                              : state.settings.recognizers.filter(
                                  (v) => v !== kind,
                                ),
                          })
                        }
                      />
                      {kind}
                    </label>
                    <input
                      type="number"
                      aria-label={kind + " confidence threshold"}
                      min={0}
                      max={1}
                      step={0.05}
                      value={state.settings.thresholds[kind] ?? 0}
                      onChange={(e) =>
                        settings({
                          thresholds: { [kind]: Number(e.target.value) },
                        })
                      }
                    />
                  </div>
                ))}
                <p className="subtle">
                  Ask expires to No after 10 seconds. Twitch blocked terms
                  expose text to moderators.
                </p>
                {Object.entries(state.settings.modes).map(([key, value]) => (
                  <label className="setting-row" key={key}>
                    {key}
                    <select
                      value={value}
                      onChange={(e) =>
                        settings({ modes: { [key]: e.target.value } })
                      }
                    >
                      {["auto", "ask", "off"].map((v) => (
                        <option key={v}>{v}</option>
                      ))}
                    </select>
                  </label>
                ))}
                <hr />
                <label>
                  Discord webhook (metadata only)
                  <input
                    type="password"
                    value={webhook}
                    onChange={(e) => setWebhook(e.target.value)}
                    autoComplete="off"
                  />
                </label>
                <button
                  onClick={() => {
                    settings({ discord: webhook });
                    setWebhook("");
                  }}
                >
                  Save webhook
                </button>
                <label>
                  Window guard denylist (one term per line)
                  <textarea
                    value={denylist || state.settings.denylist.join("\n")}
                    onChange={(e) => setDenylist(e.target.value)}
                  />
                </label>
                <button
                  onClick={() =>
                    settings({ denylist: denylist.split("\n").filter(Boolean) })
                  }
                >
                  Save denylist
                </button>
              </section>
            </div>
          )}
          {page === "Onboarding" && (
            <div className="two-columns">
              <section className="panel pad">
                <span className="step-label">01 / PRIVACY FIRST</span>
                <h2>Welcome to your private side.</h2>
                <p>
                  Screen pixels and vault terms stay on this computer. Twitch
                  receives moderation requests. A configured Discord webhook
                  receives incident metadata only.
                </p>
                <hr />
                <span className="step-label">02 / TWITCH</span>
                <h3>Connect your channel</h3>
                <p className="subtle">
                  Sign in to connect your channel. VEIL’s public app is ready.
                  Advanced users can change the Client ID below. VEIL never asks
                  for a client secret.
                </p>
                <label>
                  Public Twitch Client ID
                  <input
                    key={state.twitchClientId}
                    defaultValue={state.twitchClientId}
                    onBlur={(event) => {
                      if (event.target.value.trim() !== state.twitchClientId)
                        void run("twitch-client", {
                          id: event.target.value.trim(),
                        });
                    }}
                    autoComplete="off"
                  />
                </label>
                <button
                  className="primary"
                  onClick={() => void run("auth-begin")}
                >
                  Sign in with Twitch ↗
                </button>
                {state.device && (
                  <div className="device-code">
                    <strong>{state.device.user_code}</strong>
                    <button onClick={() => void run("open-twitch")}>
                      Open Twitch activation ↗
                    </button>
                  </div>
                )}
                <hr />
                <span className="step-label">03 / OBS</span>
                <h3>Bring OBS into the loop.</h3>
                <p className="subtle">
                  OBS → Tools → WebSocket Server Settings. Enable the server and
                  copy its password.
                </p>
                <label>
                  Local WebSocket URL
                  <input
                    value={obsUrl}
                    onChange={(e) => setObsUrl(e.target.value)}
                  />
                </label>
                <label>
                  OBS password
                  <input
                    type="password"
                    value={obsPassword}
                    onChange={(e) => setObsPassword(e.target.value)}
                    autoComplete="off"
                  />
                </label>
                <button
                  className="primary"
                  onClick={async () => {
                    await run("obs-connect", {
                      url: obsUrl,
                      password: obsPassword,
                    });
                    setObsPassword("");
                    const value = await run("obs-scenes");
                    if (Array.isArray(value)) {
                      const available = value as string[];
                      setScenes(available);
                      setSelected((current) =>
                        current.filter((scene) => available.includes(scene)),
                      );
                    }
                  }}
                >
                  Connect & inspect OBS
                </button>
              </section>
              <section className="panel pad">
                <span className="step-label">04 / SCENES & AUDIO</span>
                <h2>Protect the whole picture.</h2>
                <p>
                  Install the native VEIL Guard plugin, restart OBS, then select
                  every scene you stream.
                </p>
                {scenes.map((scene) => (
                  <label className="check" key={scene}>
                    <input
                      type="checkbox"
                      checked={selected.includes(scene)}
                      onChange={(e) =>
                        setSelected((v) =>
                          e.target.checked
                            ? [...v, scene]
                            : v.filter((s) => s !== scene),
                        )
                      }
                    />
                    {scene}
                  </label>
                ))}
                <button
                  className="secondary"
                  disabled={busy || !state.obs || selected.length === 0}
                  onClick={() => void run("obs-install", { scenes: selected })}
                >
                  Add filters & sync audio
                </button>
                <p className="fine-print">
                  Audio receives the video delay in addition to its original
                  offset. VEIL saves original values before writing and restores
                  them on exit or reconnect after a crash.
                </p>
                <hr />
                <span className="step-label">05 / YOUR BOUNDARIES</span>
                <h3>Add your Never Show terms.</h3>
                <button onClick={() => setPage("Never Show")}>
                  Open vault ↗
                </button>
                <hr />
                <span className="step-label">06 / READY CHECK</span>
                <h3>Permissions & pre-flight</h3>
                <p className="subtle">
                  macOS: grant Screen Recording to VEIL in System Settings.
                  Enable Focus / Do Not Disturb. Run pre-flight and resolve
                  every timing failure.
                </p>
                <button
                  className="primary"
                  onClick={() => setPage("Pre-flight")}
                >
                  Go to pre-flight ↗
                </button>
              </section>
            </div>
          )}
          <footer>
            <span>VEIL / STREAM WITH BOUNDARIES</span>
            <span>No cloud inference. No private text in this feed.</span>
          </footer>
        </div>
      </main>
      {ask && (
        <div className="modal-backdrop">
          <section
            className="modal panel"
            role="alertdialog"
            aria-modal="true"
            aria-labelledby="ask-title"
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                event.preventDefault();
                void run("ask", { id: ask.id, yes: false });
                setAsk(null);
              } else if (event.key === "Tab") {
                const buttons =
                  event.currentTarget.querySelectorAll<HTMLButtonElement>(
                    "button",
                  );
                const index = Array.from(buttons).indexOf(
                  document.activeElement as HTMLButtonElement,
                );
                event.preventDefault();
                buttons[
                  (index + (event.shiftKey ? -1 : 1) + buttons.length) %
                    buttons.length
                ]?.focus();
              }
            }}
          >
            <span className="eyebrow">YOUR CALL</span>
            <h2 id="ask-title">Allow {ask.action}?</h2>
            <p>
              {ask.action === "blocked"
                ? "This sends private text to Twitch blocked terms, readable by moderators."
                : "This action will run on your connected services."}
            </p>
            <p>Defaults to No in {remaining} seconds.</p>
            <button
              autoFocus
              className="secondary"
              onClick={() => {
                void run("ask", { id: ask.id, yes: false });
                setAsk(null);
              }}
            >
              No, keep it off
            </button>
            <button
              className="primary"
              onClick={() => {
                void run("ask", { id: ask.id, yes: true });
                setAsk(null);
              }}
            >
              Allow action
            </button>
          </section>
        </div>
      )}
    </div>
  );
}
createRoot(document.getElementById("root")!).render(<App />);
