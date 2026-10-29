import OBSWebSocket from "obs-websocket-js/json";
import type { Store } from "../store/store.js";

/** OBS v5 adapter with durable audio-offset rollback before any new writes. */
export class ObsClient {
  readonly socket = new OBSWebSocket();
  connected = false;
  constructor(private readonly store: Store) {
    this.socket.on("ConnectionClosed", () => {
      this.connected = false;
    });
  }
  async connect(url: string, password: string): Promise<void> {
    const parsed = new URL(url);
    if (
      !["127.0.0.1", "localhost", "[::1]"].includes(parsed.hostname) ||
      parsed.protocol !== "ws:"
    )
      throw new Error("OBS must use a local WebSocket");
    await this.socket.connect(url, password, { rpcVersion: 1 });
    this.connected = true;
    await this.restoreAudio();
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
    await this.delayAudio(delay);
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
    for (const [inputName, inputAudioSyncOffset] of Object.entries(originals)) {
      await this.socket.call("SetInputAudioSyncOffset", {
        inputName,
        inputAudioSyncOffset,
      });
      delete originals[inputName];
      this.store.set("audioRollback", originals);
    }
  }
  async cover(): Promise<void> {
    await this.socket.call("SetCurrentProgramScene", {
      sceneName: "VEIL Cover",
    });
  }
  async createCover(htmlPath: string): Promise<void> {
    const scenes = await this.scenes();
    if (!scenes.includes("VEIL Cover"))
      await this.socket.call("CreateScene", { sceneName: "VEIL Cover" });
    const items = await this.socket.call("GetSceneItemList", {
      sceneName: "VEIL Cover",
    });
    if (!items.sceneItems.some((i) => i.sourceName === "VEIL Cover Card"))
      await this.socket.call("CreateInput", {
        sceneName: "VEIL Cover",
        inputName: "VEIL Cover Card",
        inputKind: "browser_source",
        inputSettings: {
          is_local_file: true,
          local_file: htmlPath,
          width: 1920,
          height: 1080,
        },
        sceneItemEnabled: true,
      });
  }
  async disconnect(): Promise<void> {
    if (this.connected) await this.restoreAudio();
    await this.socket.disconnect();
    this.connected = false;
  }
}
