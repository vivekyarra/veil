import { useRef, useState } from "react";
import { call, run, saveSettings, useVeil } from "../store";
import { ACTIONS } from "../format";
import type { Action, Mode } from "../types";
import { ChannelField } from "../components/ChannelField";
import { ShieldMark } from "../components/Icon";

const KINDS = [
  "email",
  "phone",
  "card",
  "ip",
  "address",
  "secret",
  "vault",
  "window",
];
/** Panic-critical actions first; Mute and Shield are new and called out. */
const ORDER: Action[] = [
  "cover",
  "mute",
  "shield",
  "guard",
  "retroactive",
  "marker",
  "blocked",
  "notice",
  "discord",
  "clips",
];
const MODE_LABEL: Record<Mode, string> = {
  auto: "Auto",
  ask: "Ask me (10 s)",
  off: "Off",
};

function Automation() {
  const state = useVeil((s) => s.state);
  const [hotkey, setHotkey] = useState("");
  return (
    <section className="panel pad">
      <h2>Panic & incident automation</h2>
      <p className="subtle">
        What VEIL does the moment you press panic or a leak is caught. “Ask me”
        shows a prompt that declines by itself after 10 seconds, and the
        incident log marks it as a timeout.
      </p>
      <label>
        Panic shortcut
        <input
          value={hotkey || state.settings.hotkey}
          onChange={(e) => setHotkey(e.target.value)}
        />
      </label>
      <button disabled={!hotkey} onClick={() => void saveSettings({ hotkey })}>
        Register shortcut
      </button>
      <div className="mode-list">
        {ORDER.map((action) => (
          <label
            className={
              "setting-row mode-row" +
              (action === "mute" || action === "shield" ? " featured" : "")
            }
            key={action}
          >
            <span>
              <strong>{ACTIONS[action].label}</strong>
              <small>{ACTIONS[action].detail}</small>
            </span>
            <select
              value={state.settings.modes[action]}
              onChange={(e) =>
                void saveSettings({ modes: { [action]: e.target.value } })
              }
            >
              {(["auto", "ask", "off"] as const).map((v) => (
                <option key={v} value={v}>
                  {MODE_LABEL[v]}
                </option>
              ))}
            </select>
          </label>
        ))}
      </div>
    </section>
  );
}

function Overlay() {
  const url = useVeil((s) => s.state.overlayUrl),
    obs = useVeil((s) => s.state.obs),
    busy = useVeil((s) => s.busy),
    set = useVeil((s) => s.set);
  const field = useRef<HTMLInputElement>(null);
  return (
    <section className="panel pad">
      <h2>On-stream overlay</h2>
      <p className="subtle">
        A small “shielded by VEIL” badge for your scene: session uptime, a catch
        counter and a quick animation whenever VEIL masks something or removes a
        chat leak. It only ever receives counts and timestamps, never text.
      </p>
      <div className="overlay-preview" aria-hidden="true">
        <div className="overlay-badge">
          <ShieldMark size={30} />
          <span>
            <b>SHIELDED BY VEIL</b>
            <small>● 1:24:07 · 3 caught</small>
          </span>
        </div>
      </div>
      <label>
        Overlay URL (browser source, 520 × 160)
        <input
          ref={field}
          readOnly
          value={url || "Overlay feed unavailable"}
          onFocus={(e) => e.target.select()}
        />
      </label>
      <div className="button-row">
        <button
          className="secondary"
          disabled={!url}
          onClick={async () => {
            try {
              await navigator.clipboard.writeText(url);
              set({ message: "Overlay URL copied" });
            } catch {
              field.current?.select();
              set({ message: "Press Ctrl+C to copy the selected URL" });
            }
          }}
        >
          Copy overlay URL
        </button>
        <button
          className="primary"
          disabled={!url || !obs || busy}
          onClick={() => void call("overlay-add")}
        >
          Add overlay to OBS
        </button>
      </div>
      <p className="fine-print">
        {obs
          ? "Adds a “VEIL Overlay” browser source to your current scene. Drag it where you like."
          : "Connect OBS to add it automatically, or paste the URL into a Browser source."}{" "}
        The feed listens on 127.0.0.1 only and is read-only.
      </p>
    </section>
  );
}

function Timing() {
  const state = useVeil((s) => s.state);
  return (
    <section className="panel pad">
      <h2>Protection & timing</h2>
      <label>
        Profile
        <select
          value={state.settings.profile}
          onChange={(e) => void saveSettings({ profile: e.target.value })}
        >
          <option value="balanced">Balanced: smooth video</option>
          <option value="paranoid">Paranoid: never risk a leak</option>
          <option value="off">Off: no screen masking</option>
        </select>
      </label>
      <div className="field-pair">
        <label>
          Safety delay (300–3000 ms)
          <input
            type="number"
            min={300}
            max={3000}
            step={50}
            value={state.settings.delay}
            onChange={(e) =>
              void saveSettings({ delay: Number(e.target.value) })
            }
          />
        </label>
        <label>
          Screen checks per second
          <input
            type="number"
            min={1}
            max={10}
            value={state.settings.sampleFps}
            onChange={(e) =>
              void saveSettings({ sampleFps: Number(e.target.value) })
            }
          />
        </label>
      </div>
      <div className="field-pair">
        <label>
          Theme
          <select
            value={state.settings.theme}
            onChange={(e) => void saveSettings({ theme: e.target.value })}
          >
            <option>dark</option>
            <option>light</option>
          </select>
        </label>
        <label>
          Data retention (days)
          <input
            type="number"
            min={1}
            max={365}
            value={state.settings.retentionDays}
            onChange={(e) =>
              void saveSettings({ retentionDays: Number(e.target.value) })
            }
          />
        </label>
      </div>
      <button onClick={() => void run("logs-export")}>
        Export metadata diagnostics
      </button>
    </section>
  );
}

function Recognizers() {
  const settings = useVeil((s) => s.state.settings);
  return (
    <section className="panel pad">
      <h2>Recognizers & confidence</h2>
      {KINDS.map((kind) => (
        <div className="setting-row" key={kind}>
          <label className="check">
            <input
              type="checkbox"
              checked={settings.recognizers.includes(kind)}
              onChange={(e) =>
                void saveSettings({
                  recognizers: e.target.checked
                    ? [...settings.recognizers, kind]
                    : settings.recognizers.filter((v) => v !== kind),
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
            value={settings.thresholds[kind] ?? 0}
            onChange={(e) =>
              void saveSettings({
                thresholds: { [kind]: Number(e.target.value) },
              })
            }
          />
        </div>
      ))}
    </section>
  );
}

function IgnoreZones() {
  const settings = useVeil((s) => s.state.settings),
    scan = useVeil((s) => s.scan);
  const [start, setStart] = useState<{ x: number; y: number } | null>(null);
  return (
    <section className="panel pad">
      <h2>Ignore zones</h2>
      <label>
        Twitch category ID for ignore zones
        <input
          key={settings.gameId}
          defaultValue={settings.gameId}
          onBlur={(e) => void saveSettings({ gameId: e.target.value })}
        />
      </label>
      <p className="subtle">
        Draw a rectangle on the last practice capture. Zones never exclude
        vault, secret or window detections.
      </p>
      {scan ? (
        <div
          className="zone-editor"
          onPointerDown={(e) => {
            const b = e.currentTarget.getBoundingClientRect();
            setStart({
              x: (e.clientX - b.left) / b.width,
              y: (e.clientY - b.top) / b.height,
            });
            e.currentTarget.setPointerCapture(e.pointerId);
          }}
          onPointerUp={(e) => {
            if (!start) return;
            const b = e.currentTarget.getBoundingClientRect(),
              x = (e.clientX - b.left) / b.width,
              y = (e.clientY - b.top) / b.height;
            void saveSettings({
              ignoreZones: [
                ...settings.ignoreZones,
                {
                  x: Math.min(start.x, x),
                  y: Math.min(start.y, y),
                  w: Math.abs(x - start.x),
                  h: Math.abs(y - start.y),
                },
              ],
            });
            setStart(null);
          }}
        >
          <img
            src={scan.image}
            alt="Practice capture for ignore-zone editing"
          />
          {settings.ignoreZones.map((b, i) => (
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
        <p className="subtle">Run a rehearsal capture first.</p>
      )}
      <button onClick={() => void saveSettings({ ignoreZones: [] })}>
        Clear zones
      </button>
    </section>
  );
}

function Notifications() {
  const settings = useVeil((s) => s.state.settings);
  const [webhook, setWebhook] = useState(""),
    [denylist, setDenylist] = useState("");
  return (
    <section className="panel pad">
      <h2>Notifications & window guard</h2>
      <label>
        Discord webhook (metadata only)
        <input
          type="password"
          value={webhook}
          onChange={(e) => setWebhook(e.target.value)}
          autoComplete="off"
          placeholder={settings.discord ? "configured" : ""}
        />
      </label>
      <button
        onClick={() => {
          void saveSettings({ discord: webhook });
          setWebhook("");
        }}
      >
        Save webhook
      </button>
      <label>
        Window guard denylist (one term per line)
        <textarea
          value={denylist || settings.denylist.join("\n")}
          onChange={(e) => setDenylist(e.target.value)}
        />
      </label>
      <button
        onClick={() =>
          void saveSettings({ denylist: denylist.split("\n").filter(Boolean) })
        }
      >
        Save denylist
      </button>
    </section>
  );
}

export function Settings() {
  return (
    <div className="settings-grid">
      <div className="stack">
        <section className="panel pad">
          <h2>Channel & moderator mode</h2>
          <ChannelField />
        </section>
        <Automation />
        <Overlay />
      </div>
      <div className="stack">
        <Timing />
        <Recognizers />
        <IgnoreZones />
        <Notifications />
      </div>
    </div>
  );
}
