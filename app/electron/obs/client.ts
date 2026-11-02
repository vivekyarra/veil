import OBSWebSocket from "obs-websocket-js/json";
import type { Store } from "../store/store.js";

/** OBS v5 adapter with durable audio-offset rollback before any new writes. */
export class ObsClient {
  readonly socket = new OBSWebSocket();
  connected = false;
  /** Reports reconnect progress; set by the app. */
  onStatus: (status: string) => void = () => {};
  private target: { url: string; password: string } | undefined;
  private retry: ReturnType<typeof setTimeout> | undefined;
  private backoff = 1000;
  /** Resets the backoff only once a reconnect has stayed up for a while. */
  private stable: ReturnType<typeof setTimeout> | undefined;
  /** The single in-flight socket connect; never run two in parallel. */
  private connecting: Promise<void> | undefined;
  /** A panic cover requested while disconnected, applied on reconnect. */
  private pendingCover = false;
  /** Mute rollback from a crashed session is restored once per process. */
  private crashRestoreDone = false;
  /** Serializes scene/input creation so concurrent calls cannot duplicate. */
  private sceneLock: Promise<unknown> = Promise.resolve();
  private connectLock: Promise<unknown> = Promise.resolve();
  constructor(
    private readonly store: Store,
    private readonly maxBackoff = 30000,
  ) {
    this.socket.on("ConnectionClosed", () => {
      const was = this.connected;
      this.connected = false;
      clearTimeout(this.stable);
      if (was && this.target) {
        this.onStatus("OBS connection lost; reconnecting");
        this.scheduleReconnect();
      }
    });
  }
  private scheduleReconnect(): void {
    clearTimeout(this.retry);
    if (!this.target) return;
    this.retry = setTimeout(() => void this.reconnect(), this.backoff);
    this.retry.unref?.();
    this.backoff = Math.min(this.maxBackoff, this.backoff * 2);
  }
  /** OBS keeps its own audio offsets, so a reconnect must not restore them. */
  private async reconnect(): Promise<void> {
    const target = this.target;
    if (!target || this.connected || this.connecting) return;
    const attempt = this.socket.connect(target.url, target.password, {
      rpcVersion: 1,
    });
    this.connecting = attempt.then(
      () => undefined,
      () => undefined,
    );
    try {
      await attempt;
      if (this.target !== target) return;
      this.connected = true;
      // A flapping link must keep backing off: reset only after 10 s up.
      clearTimeout(this.stable);
      this.stable = setTimeout(() => (this.backoff = 1000), 10000);
      this.stable.unref?.();
      this.onStatus("OBS reconnected");
      await this.flushPendingCover();
    } catch {
      if (this.target === target) this.scheduleReconnect();
    } finally {
      this.connecting = undefined;
    }
  }
  private async flushPendingCover(): Promise<void> {
    if (!this.pendingCover || !this.connected) return;
    try {
      await this.socket.call("SetCurrentProgramScene", {
        sceneName: "VEIL Cover",
      });
      this.pendingCover = false;
      this.onStatus("Queued panic cover applied after reconnect");
    } catch {
      this.onStatus("Queued panic cover failed after reconnect");
    }
  }
  private locked<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.sceneLock.then(fn, fn);
    this.sceneLock = run.catch(() => undefined);
    return run;
  }
  /** Manual connects are serialized; a second caller waits for the first. */
  connect(url: string, password: string): Promise<void> {
    const run = this.connectLock.then(
      () => this.connectUnlocked(url, password),
      () => this.connectUnlocked(url, password),
    );
    this.connectLock = run.catch(() => undefined);
    return run;
  }
  private async connectUnlocked(url: string, password: string): Promise<void> {
    const parsed = new URL(url);
    if (
      !["127.0.0.1", "localhost", "[::1]"].includes(parsed.hostname) ||
      parsed.protocol !== "ws:"
    )
      throw new Error("OBS must use a local WebSocket");
    clearTimeout(this.retry);
    clearTimeout(this.stable);
    this.target = undefined;
    // Let an in-flight reconnect settle so two connects never race.
    await this.connecting;
    if (this.connected) await this.socket.disconnect();
    this.connected = false;
    await this.socket.connect(url, password, { rpcVersion: 1 });
    this.connected = true;
    this.backoff = 1000;
    this.target = { url, password };
    await this.restoreAudio();
    if (!this.crashRestoreDone) {
      // Inputs VEIL muted before a crash are unmuted on the next start.
      this.crashRestoreDone = true;
      await this.unmuteInputs();
    }
    await this.flushPendingCover();
  }
  async scenes(): Promise<string[]> {
    const result = await this.socket.call("GetSceneList");
    return result.scenes.map((s) => String(s.sceneName));
  }
  async install(
    scenes: string[],
    tokenFile: string,
    delay: number,
    profile: number,
    sampleFps = 4,
  ): Promise<void> {
    if (scenes.length === 0)
      throw new Error("Select at least one streaming scene");
    if (scenes.includes("VEIL Cover"))
      throw new Error("VEIL Cover is reserved for incident response");
    const kinds = await this.socket.call("GetSourceFilterKindList");
    if (!kinds.sourceFilterKinds.includes("veil_guard"))
      throw new Error("Install VEIL Guard in OBS and restart OBS first");
    for (const scene of scenes) {
      const filters = await this.socket.call("GetSourceFilterList", {
        sourceName: scene,
      });
      const existing = filters.filters.find(
        (f) => f.filterKind === "veil_guard",
      );
      const settings = {
        token_file: tokenFile,
        delay_ms: delay,
        profile,
        sample_fps: sampleFps,
        enabled: true,
      };
      if (existing) {
        await this.socket.call("SetSourceFilterSettings", {
          sourceName: scene,
          filterName: String(existing.filterName),
          filterSettings: settings,
        });
        await this.socket.call("SetSourceFilterEnabled", {
          sourceName: scene,
          filterName: String(existing.filterName),
          filterEnabled: true,
        });
      } else
        await this.socket.call("CreateSourceFilter", {
          sourceName: scene,
          filterName: "VEIL Guard",
          filterKind: "veil_guard",
          filterSettings: settings,
        });
    }
    if (profile === 0) await this.restoreAudio();
    else await this.delayAudio(delay);
  }
  async delayAudio(delay: number): Promise<void> {
    const originals = this.store.get<Record<string, number>>(
      "audioRollback",
      {},
    );
    const inputs = await this.socket.call("GetInputList");
    for (const input of inputs.inputs) {
      const inputName = String(input.inputName);
      let offset: number;
      try {
        offset = (
          await this.socket.call("GetInputAudioSyncOffset", { inputName })
        ).inputAudioSyncOffset;
      } catch {
        continue;
      }
      if (!(inputName in originals)) {
        originals[inputName] = offset;
        this.store.set("audioRollback", originals);
      }
      await this.socket.call("SetInputAudioSyncOffset", {
        inputName,
        inputAudioSyncOffset: originals[inputName] + delay,
      });
    }
  }
  async restoreAudio(): Promise<void> {
    const originals = this.store.get<Record<string, number>>(
      "audioRollback",
      {},
    );
    const entries = Object.entries(originals);
    if (entries.length === 0) return;
    const present = new Set(
      (await this.socket.call("GetInputList")).inputs.map((i) =>
        String(i.inputName),
      ),
    );
    for (const [inputName, inputAudioSyncOffset] of entries) {
      // A removed input must not block every future connect.
      if (present.has(inputName))
        await this.socket.call("SetInputAudioSyncOffset", {
          inputName,
          inputAudioSyncOffset,
        });
      delete originals[inputName];
      this.store.set("audioRollback", originals);
    }
  }
  /** Switch to the cover; while disconnected it queues and throws loudly. */
  async cover(): Promise<void> {
    if (!this.connected) {
      if (this.target) {
        this.pendingCover = true;
        throw new Error(
          "OBS is disconnected; cover queued until OBS reconnects",
        );
      }
      throw new Error("OBS is not connected; cover scene not applied");
    }
    await this.socket.call("SetCurrentProgramScene", {
      sceneName: "VEIL Cover",
    });
  }
  createCover(htmlPath: string): Promise<void> {
    return this.locked(() => this.createCoverUnlocked(htmlPath));
  }
  private async createCoverUnlocked(htmlPath: string): Promise<void> {
    const video = await this.socket.call("GetVideoSettings");
    const inputSettings = {
      is_local_file: true,
      local_file: htmlPath,
      width: video.baseWidth,
      height: video.baseHeight,
    };
    const scenes = await this.scenes();
    if (!scenes.includes("VEIL Cover"))
      await this.socket.call("CreateScene", { sceneName: "VEIL Cover" });
    const items = await this.socket.call("GetSceneItemList", {
      sceneName: "VEIL Cover",
    });
    const inScene = items.sceneItems.some(
      (i) => i.sourceName === "VEIL Cover Card",
    );
    const inputExists =
      inScene ||
      (await this.socket.call("GetInputList")).inputs.some(
        (i) => i.inputName === "VEIL Cover Card",
      );
    if (inputExists)
      await this.socket.call("SetInputSettings", {
        inputName: "VEIL Cover Card",
        inputSettings,
      });
    if (inScene) return;
    if (inputExists)
      await this.socket.call("CreateSceneItem", {
        sceneName: "VEIL Cover",
        sourceName: "VEIL Cover Card",
      });
    else
      await this.socket.call("CreateInput", {
        sceneName: "VEIL Cover",
        inputName: "VEIL Cover Card",
        inputKind: "browser_source",
        inputSettings,
        sceneItemEnabled: true,
      });
  }
  /** Add (or refresh) the VEIL overlay browser source in the program scene. */
  addOverlay(url: string): Promise<string> {
    return this.locked(() => this.addOverlayUnlocked(url));
  }
  private async addOverlayUnlocked(url: string): Promise<string> {
    const sceneName = String(
      (await this.socket.call("GetCurrentProgramScene"))
        .currentProgramSceneName,
    );
    if (sceneName === "VEIL Cover")
      throw new Error("Switch OBS to your streaming scene first");
    const inputName = "VEIL Overlay",
      inputSettings = {
        is_local_file: false,
        url,
        width: 520,
        height: 160,
        shutdown: false,
      };
    const inputs = await this.socket.call("GetInputList");
    if (!inputs.inputs.some((i) => i.inputName === inputName)) {
      await this.socket.call("CreateInput", {
        sceneName,
        inputName,
        inputKind: "browser_source",
        inputSettings,
        sceneItemEnabled: true,
      });
      return sceneName;
    }
    await this.socket.call("SetInputSettings", { inputName, inputSettings });
    const items = await this.socket.call("GetSceneItemList", { sceneName });
    if (!items.sceneItems.some((i) => i.sourceName === inputName))
      await this.socket.call("CreateSceneItem", {
        sceneName,
        sourceName: inputName,
      });
    return sceneName;
  }
  /** Mute every audible input; remembers which ones VEIL muted. */
  async muteInputs(): Promise<void> {
    const muted = this.store.get<string[]>("muteRollback", []);
    const inputs = await this.socket.call("GetInputList");
    for (const input of inputs.inputs) {
      const inputName = String(input.inputName);
      let state: boolean;
      try {
        state = (await this.socket.call("GetInputMute", { inputName }))
          .inputMuted;
      } catch {
        continue;
      }
      if (state) continue;
      // Write-ahead: persist before muting so a crash cannot strand it.
      if (!muted.includes(inputName)) muted.push(inputName);
      this.store.set("muteRollback", muted);
      await this.socket.call("SetInputMute", { inputName, inputMuted: true });
    }
  }
  /** Unmute only the inputs VEIL muted, surviving restarts. */
  async unmuteInputs(): Promise<void> {
    const muted = this.store.get<string[]>("muteRollback", []);
    for (const inputName of [...muted]) {
      try {
        await this.socket.call("SetInputMute", {
          inputName,
          inputMuted: false,
        });
      } catch (error) {
        // Keep the rollback list while OBS is unreachable; the next connect restores it.
        if (!this.connected) throw error;
        // Connected but the call failed: the input was removed from OBS.
      }
      muted.splice(muted.indexOf(inputName), 1);
      this.store.set("muteRollback", muted);
    }
  }
  async disconnect(): Promise<void> {
    this.target = undefined;
    this.pendingCover = false;
    clearTimeout(this.retry);
    clearTimeout(this.stable);
    await this.connecting;
    if (this.connected) await this.restoreAudio();
    await this.socket.disconnect();
    this.connected = false;
  }
}
