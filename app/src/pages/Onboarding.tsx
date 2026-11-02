import { useState } from "react";
import { call, run, useVeil } from "../store";
import { ChannelField } from "../components/ChannelField";
import { PreflightChecks } from "../components/PreflightChecks";
import { CATEGORIES } from "./NeverShow";

const STEPS = [
  "Connect OBS",
  "Sign in with Twitch",
  "Add Never Show terms",
  "Run pre-flight",
] as const;

function ObsStep() {
  const state = useVeil((s) => s.state),
    busy = useVeil((s) => s.busy);
  const [obsUrl, setObsUrl] = useState(state.settings.obsUrl),
    [password, setPassword] = useState(""),
    [scenes, setScenes] = useState<string[]>([]),
    [selected, setSelected] = useState<string[]>([]);
  return (
    <>
      <p>
        Screen pixels and vault terms stay on this computer. In OBS open{" "}
        <b>Tools → WebSocket Server Settings</b>, enable the server and copy its
        password.
      </p>
      <div className="field-pair">
        <label>
          Local WebSocket URL
          <input value={obsUrl} onChange={(e) => setObsUrl(e.target.value)} />
        </label>
        <label>
          OBS password
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="off"
          />
        </label>
      </div>
      <button
        className="primary"
        disabled={busy}
        onClick={async () => {
          const connected = await run("obs-connect", {
            url: obsUrl,
            password,
          });
          if (connected === undefined) return;
          setPassword("");
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
      <h3>Protect the whole picture</h3>
      <p className="subtle">
        Install the native VEIL Guard plugin, restart OBS, then select every
        scene you stream. VEIL also adds a “VEIL Cover” scene for panics.
      </p>
      {scenes.length === 0 && (
        <p className="fine-print">Connect to list your scenes.</p>
      )}
      <div className="scene-list">
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
      </div>
      <button
        className="secondary"
        disabled={busy || !state.obs || selected.length === 0}
        onClick={() => void run("obs-install", { scenes: selected })}
      >
        Add filters & sync audio
      </button>
      <p className="fine-print">
        Audio receives the video delay in addition to its original offset. VEIL
        saves original values before writing and restores them on exit or after
        a crash.
      </p>
    </>
  );
}

function TwitchStep() {
  const state = useVeil((s) => s.state);
  return (
    <>
      <p>
        VEIL deletes leaked chat messages through Twitch. Sign in with the
        account that streams, or with a moderator account for someone else’s
        channel. VEIL never asks for a client secret.
      </p>
      <button className="primary" onClick={() => void run("auth-begin")}>
        Sign in with Twitch ↗
      </button>
      {state.device && (
        <div className="device-code">
          <span className="fine-print">Enter this code on Twitch</span>
          <strong>{state.device.user_code}</strong>
          <button onClick={() => void run("open-twitch")}>
            Open Twitch activation ↗
          </button>
        </div>
      )}
      <hr />
      <ChannelField />
      <details>
        <summary>Advanced: public Client ID</summary>
        <label>
          Public Twitch Client ID
          <input
            key={state.twitchClientId}
            defaultValue={state.twitchClientId}
            onBlur={(event) => {
              if (event.target.value.trim() !== state.twitchClientId)
                void run("twitch-client", { id: event.target.value.trim() });
            }}
            autoComplete="off"
          />
        </label>
      </details>
    </>
  );
}

function TermsStep() {
  const count = useVeil((s) => s.state.vault.length),
    busy = useVeil((s) => s.busy),
    go = useVeil((s) => s.go);
  const [term, setTerm] = useState(""),
    [category, setCategory] = useState("name");
  return (
    <>
      <p>
        Names, addresses, your school, a license plate: anything that must never
        reach the stream. Terms are encrypted on this computer and moderators
        can’t read them.
      </p>
      <form
        className="field-pair"
        onSubmit={async (e) => {
          e.preventDefault();
          const result = await call("vault-add", { text: term, category });
          if (result.ok) setTerm("");
        }}
      >
        <label>
          Term category
          <select
            value={category}
            onChange={(e) => setCategory(e.target.value)}
          >
            {CATEGORIES.map((c) => (
              <option key={c}>{c}</option>
            ))}
          </select>
        </label>
        <label>
          Never Show term
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
          Add term
        </button>
      </form>
      <p className="count-line">
        <strong>{count}</strong> term{count === 1 ? "" : "s"} in your vault.{" "}
        <button className="link" onClick={() => go("Never Show")}>
          Manage vault and PIN ↗
        </button>
      </p>
    </>
  );
}

function PreflightStep() {
  const state = useVeil((s) => s.state),
    checks = useVeil((s) => s.checks),
    busy = useVeil((s) => s.busy),
    go = useVeil((s) => s.go);
  const failing = checks.some((c) => c.status === "fail");
  const finish = async (live: boolean) => {
    const done = await call("onboarding-complete");
    if (!done.ok) return;
    if (live) await call("rehearsal", { enabled: false });
    go("Dashboard");
  };
  return (
    <>
      <p>
        macOS: grant Screen Recording to VEIL in System Settings. Turn on Focus
        or Do Not Disturb. Then resolve every failing check.
      </p>
      <PreflightChecks />
      <div className="finish">
        <button
          className="primary big"
          disabled={busy || checks.length === 0 || failing}
          onClick={() => void finish(true)}
        >
          Finish & turn protection on
        </button>
        <button disabled={busy} onClick={() => void finish(false)}>
          Finish, stay in rehearsal
        </button>
        <p className="fine-print">
          {checks.length === 0
            ? "Run the checks first."
            : failing
              ? "Fix failing checks to turn protection on."
              : state.twitch && state.obs
                ? "Turning protection on leaves rehearsal mode and guards your live chat."
                : "You can finish now; the top banner will list what is still missing."}
        </p>
      </div>
    </>
  );
}

export function Onboarding() {
  const step = useVeil((s) => s.onboardingStep),
    set = useVeil((s) => s.set),
    state = useVeil((s) => s.state),
    checks = useVeil((s) => s.checks);
  const done = [
    state.obs,
    state.twitch,
    state.vault.length > 0,
    checks.length > 0 && !checks.some((c) => c.status === "fail"),
  ];
  const complete = done.filter(Boolean).length;
  const Body = [ObsStep, TwitchStep, TermsStep, PreflightStep][step];
  return (
    <div className="onboarding">
      <div className="progress-head">
        <span className="step-label">
          STEP {step + 1} OF 4 · {complete} DONE
        </span>
        <div
          className="progress"
          role="progressbar"
          aria-label="Setup progress"
          aria-valuemin={0}
          aria-valuemax={4}
          aria-valuenow={complete}
        >
          <i style={{ width: (complete / 4) * 100 + "%" }} />
        </div>
      </div>
      <ol className="stepper">
        {STEPS.map((title, i) => (
          <li key={title} className={done[i] ? "done" : ""}>
            <button
              aria-current={i === step ? "step" : undefined}
              onClick={() => set({ onboardingStep: i })}
            >
              <span className="step-num" aria-hidden="true">
                {done[i] ? "✓" : i + 1}
              </span>
              <span>
                {title}
                <small>
                  {done[i] ? "Done" : i === step ? "Current" : "To do"}
                </small>
              </span>
            </button>
          </li>
        ))}
      </ol>
      <section className="panel pad step-panel" aria-labelledby="step-title">
        <span className="step-label">
          {String(step + 1).padStart(2, "0")} / {STEPS[step].toUpperCase()}
        </span>
        <h2 id="step-title">{STEPS[step]}</h2>
        <Body />
        <div className="step-nav">
          <button
            disabled={step === 0}
            onClick={() => set({ onboardingStep: step - 1 })}
          >
            ← Back
          </button>
          {step < 3 && (
            <button
              className="secondary"
              onClick={() => set({ onboardingStep: step + 1 })}
            >
              {done[step] ? "Next" : "Skip for now"}: {STEPS[step + 1]} →
            </button>
          )}
        </div>
      </section>
    </div>
  );
}
