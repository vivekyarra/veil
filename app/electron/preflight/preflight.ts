import type { ObsClient } from "../obs/client.js";
import type { Supervisor } from "../supervisor.js";
interface Check {
  id: string;
  title: string;
  status: "pass" | "warn" | "fail";
  detail: string;
  recommendedDelay?: number;
}
/** Unknown OS/VOD settings are manual checks, never guessed passes. */
export async function preflight(
  obs: ObsClient,
  detector: Supervisor,
  delay: number,
  sampleFps: number,
  categories: number,
  twitch: boolean,
  eventsub: boolean,
): Promise<Check[]> {
  const checks: Check[] = [];
  const add = (
    id: string,
    title: string,
    status: Check["status"],
    detail: string,
    recommendedDelay?: number,
  ) => checks.push({ id, title, status, detail, recommendedDelay });
  try {
    const health = await detector.request("/v1/health");
    const p99 =
      typeof health.p99_ms === "number" &&
      Number.isFinite(health.p99_ms) &&
      health.p99_ms >= 0
        ? health.p99_ms
        : null;
    const required =
      p99 === null ? null : Math.ceil(1000 / sampleFps + p99 + 100);
    add(
      "detector",
      "Local detector",
      health.model_loaded ? "pass" : "warn",
      health.model_loaded
        ? "OCR model loaded"
        : "Run a rehearsal to load and measure OCR",
    );
    add(
      "latency",
      "Lookahead budget",
      required === null ? "warn" : delay >= required ? "pass" : "fail",
      required === null
        ? "No measured latency yet"
        : `Configured ${delay} ms; measured budget needs at least ${required} ms${required > 3000 ? "; exceeds supported delay; use Paranoid and faster inference hardware" : ""}`,
      required !== null && required > delay && required <= 3000
        ? required
        : undefined,
    );
    add(
      "windows",
      "Window guard",
      health.window_guard_available ? "pass" : "warn",
      health.window_guard_available
        ? `${health.denylisted_windows} denylisted windows visible; verify capture mapping`
        : String(health.window_guard_reason),
    );
  } catch {
    add(
      "detector",
      "Local detector",
      "fail",
      "Detector unavailable; Paranoid must hold the frame",
    );
  }
  if (!obs.connected)
    add("obs", "OBS connection", "fail", "Connect to local OBS WebSocket v5");
  else {
    try {
      const scenes = (await obs.scenes()).filter((s) => s !== "VEIL Cover");
      let missing = 0;
      for (const scene of scenes) {
        const response = await obs.socket.call("GetSourceFilterList", {
          sourceName: scene,
        });
        if (
          !response.filters.some((f) => {
            const value: unknown = f.filterSettings;
            if (
              value === null ||
              typeof value !== "object" ||
              Array.isArray(value)
            )
              return false;
            const config = value as Record<string, unknown>;
            return (
              f.filterKind === "veil_guard" &&
              f.filterEnabled &&
              config.enabled !== false &&
              Number(config.profile ?? 1) > 0
            );
          })
        )
          missing++;
      }
      add(
        "filters",
        "Scene protection",
        scenes.length > 0 && missing === 0 ? "pass" : "fail",
        `${missing} of ${scenes.length} scenes missing an enabled VEIL filter`,
      );
      const inputs = await obs.socket.call("GetInputList");
      let audio = 0;
      for (const input of inputs.inputs)
        try {
          const offset = await obs.socket.call("GetInputAudioSyncOffset", {
            inputName: String(input.inputName),
          });
          if (offset.inputAudioSyncOffset >= delay) audio++;
        } catch {
          continue;
        }
      add(
        "audio",
        "Audio synchronization",
        audio ? "pass" : "warn",
        `${audio} audio inputs have at least the configured delay; original offsets are restored on exit`,
      );
      const current = await obs.socket.call("GetCurrentProgramScene");
      const sources = await obs.socket.call("GetSceneItemList", {
        sceneName: current.currentProgramSceneName,
      });
      add(
        "captures",
        "Capture-source review",
        "warn",
        `${sources.sceneItems.filter((i) => i.sceneItemEnabled).length} visible program items; run source scan and verify display-capture coordinates before streaming`,
      );
    } catch {
      add(
        "obs",
        "OBS source checks",
        "fail",
        "Could not inspect sources; verify OBS configuration",
      );
    }
  }
  add(
    "notifications",
    "Do Not Disturb / Focus",
    "warn",
    "Manual check: turn OS notifications off before streaming. Public APIs do not provide a reliable cross-platform state.",
  );
  add(
    "twitch",
    "Twitch authorization",
    twitch ? "pass" : "warn",
    twitch
      ? "Token and required scopes validated"
      : "Sign in with a registered Twitch public client",
  );
  add(
    "eventsub",
    "Chat connection",
    eventsub ? "pass" : "warn",
    eventsub
      ? "EventSub connected"
      : "Chat cannot be moderated while disconnected; local OCR remains independent",
  );
  add(
    "vod",
    "VOD storage",
    "warn",
    "Manual check: enable Store past broadcasts in Twitch Video settings. A previous archive does not prove current VOD configuration.",
  );
  add(
    "vault",
    "Private vault",
    categories >= 3 ? "pass" : "warn",
    `${categories} categories configured; aim for at least three`,
  );
  return checks;
}
