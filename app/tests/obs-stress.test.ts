import { describe, expect, it, vi } from "vitest";
import { ObsClient } from "../electron/obs/client";
import { Store } from "../electron/store/store";
import { obsMock } from "./mocks";

/** In-memory OBS that rejects duplicate names like real obs-websocket. */
function fakeObs(obs: ObsClient) {
  const scenes = new Map<string, string[]>([["Live", []]]);
  const inputs = new Set<string>(["Mic"]);
  const calls: string[] = [];
  let program = "Live";
  const tick = () => new Promise((r) => setTimeout(r, 1));
  const call = async (type: string, data: Record<string, unknown> = {}) => {
    calls.push(type);
    await tick();
    const scene = String(data.sceneName);
    switch (type) {
      case "GetVideoSettings":
        return { baseWidth: 1920, baseHeight: 1080 };
      case "GetSceneList":
        return {
          scenes: [...scenes.keys()].map((sceneName) => ({ sceneName })),
        };
      case "CreateScene":
        if (scenes.has(scene)) throw new Error("scene exists");
        scenes.set(scene, []);
        return {};
      case "GetSceneItemList":
        if (!scenes.has(scene)) throw new Error("no scene");
        return {
          sceneItems: scenes
            .get(scene)!
            .map((sourceName) => ({ sourceName, sceneItemEnabled: true })),
        };
      case "GetInputList":
        return { inputs: [...inputs].map((inputName) => ({ inputName })) };
      case "CreateInput": {
        const name = String(data.inputName);
        if (inputs.has(name)) throw new Error("input exists");
        inputs.add(name);
        scenes.get(scene)!.push(name);
        return {};
      }
      case "CreateSceneItem":
        scenes.get(scene)!.push(String(data.sourceName));
        return {};
      case "SetInputSettings":
        if (!inputs.has(String(data.inputName))) throw new Error("no input");
        return {};
      case "GetCurrentProgramScene":
        return { currentProgramSceneName: program };
      case "SetCurrentProgramScene":
        program = scene;
        return {};
    }
    throw new Error(`unexpected ${type}`);
  };
  (obs.socket as unknown as { call: typeof call }).call = call;
  obs.connected = true;
  return { scenes, inputs, calls };
}

describe("OBS reconnect storm", () => {
  it("caps backoff, never connects in parallel and never double-applies offsets", async () => {
    const mock = await obsMock(),
      store = new Store(":memory:"),
      obs = new ObsClient(store, 120);
    let active = 0,
      peak = 0;
    const real = obs.socket.connect.bind(obs.socket);
    vi.spyOn(obs.socket, "connect").mockImplementation(async (...args) => {
      active++;
      peak = Math.max(peak, active);
      try {
        return await real(...args);
      } finally {
        active--;
      }
    });
    try {
      await obs.connect(mock.url, "");
      await obs.install(["Live"], "token.json", 2500, 1);
      expect(mock.offsets).toEqual({ Mic: 2525, Desktop: 2490 });
      for (let i = 0; i < 25; i++) {
        mock.drop();
        await new Promise((r) => setTimeout(r, 15));
        expect(
          (obs as unknown as { backoff: number }).backoff,
        ).toBeLessThanOrEqual(120);
      }
      await expect.poll(() => obs.connected, { timeout: 5000 }).toBe(true);
      expect(peak).toBe(1);
      // Reconnects leave OBS's own offsets alone: no restore, no re-delay.
      expect(mock.offsets).toEqual({ Mic: 2525, Desktop: 2490 });
      await obs.install(["Live"], "token.json", 2500, 1);
      expect(mock.offsets).toEqual({ Mic: 2525, Desktop: 2490 });
      await obs.disconnect();
      expect(mock.offsets).toEqual({ Mic: 25, Desktop: -10 });
    } finally {
      await mock.close();
      store.close();
    }
  });

  it("a manual connect during a pending reconnect does not race it", async () => {
    const mock = await obsMock(),
      store = new Store(":memory:"),
      obs = new ObsClient(store, 20);
    try {
      await obs.connect(mock.url, "");
      mock.drop();
      await new Promise((r) => setTimeout(r, 30));
      await Promise.all([obs.connect(mock.url, ""), obs.connect(mock.url, "")]);
      expect(obs.connected).toBe(true);
      await obs.disconnect();
      await new Promise((r) => setTimeout(r, 80));
      expect(obs.connected).toBe(false);
    } finally {
      await mock.close();
      store.close();
    }
  });
});

describe("Panic while disconnected", () => {
  it("fails loudly when OBS was never connected", async () => {
    const store = new Store(":memory:"),
      obs = new ObsClient(store);
    await expect(obs.cover()).rejects.toThrow("not connected");
    store.close();
  });

  it("queues the cover during a reconnect and applies it on reconnect", async () => {
    const mock = await obsMock(),
      store = new Store(":memory:"),
      obs = new ObsClient(store);
    const status: string[] = [];
    obs.onStatus = (s) => status.push(s);
    try {
      await obs.connect(mock.url, "");
      mock.drop();
      await expect.poll(() => obs.connected).toBe(false);
      await expect(obs.cover()).rejects.toThrow("queued");
      await expect
        .poll(() => mock.program, { timeout: 5000 })
        .toBe("VEIL Cover");
      expect(status).toContain("Queued panic cover applied after reconnect");
      await obs.disconnect();
    } finally {
      await mock.close();
      store.close();
    }
  });
});

describe("Crash recovery", () => {
  it("unmutes inputs VEIL muted before a crash on the next connect", async () => {
    const mock = await obsMock(),
      store = new Store(":memory:");
    try {
      const crashed = new ObsClient(store);
      await crashed.connect(mock.url, "");
      await crashed.muteInputs();
      expect(mock.mutes).toEqual({ Mic: true, Desktop: true });
      // Simulated crash: no unmute, no disconnect.
      (crashed as unknown as { target: undefined }).target = undefined;
      await crashed.socket.disconnect();
      const restarted = new ObsClient(store);
      await restarted.connect(mock.url, "");
      expect(mock.mutes).toEqual({ Mic: false, Desktop: true });
      expect(store.get("muteRollback", ["x"])).toEqual([]);
      // Within the same process, a later reconnect must not unmute.
      await restarted.muteInputs();
      await restarted.connect(mock.url, "");
      expect(mock.mutes.Mic).toBe(true);
      await restarted.unmuteInputs();
      await restarted.disconnect();
    } finally {
      await mock.close();
      store.close();
    }
  });

  it("restores offsets after a crash and skips inputs removed from OBS", async () => {
    const mock = await obsMock(),
      store = new Store(":memory:");
    try {
      mock.offsets.Mic = 2525;
      store.set("audioRollback", { Mic: 25, "Removed input": 0 });
      const obs = new ObsClient(store);
      await obs.connect(mock.url, "");
      expect(mock.offsets).toEqual({ Mic: 25, Desktop: -10 });
      expect(store.get("audioRollback", { x: 1 })).toEqual({});
      await obs.disconnect();
    } finally {
      await mock.close();
      store.close();
    }
  });
});

describe("Idempotent scene setup", () => {
  it("creates the cover scene once under concurrent and repeated calls", async () => {
    const store = new Store(":memory:"),
      obs = new ObsClient(store),
      fake = fakeObs(obs);
    await Promise.all([1, 2, 3].map(() => obs.createCover("/cover.html")));
    await obs.createCover("/cover.html");
    expect(fake.calls.filter((c) => c === "CreateScene")).toHaveLength(1);
    expect(fake.calls.filter((c) => c === "CreateInput")).toHaveLength(1);
    expect(fake.scenes.get("VEIL Cover")).toEqual(["VEIL Cover Card"]);
    // Scene deleted by the user while the input survives elsewhere.
    fake.scenes.delete("VEIL Cover");
    await obs.createCover("/cover.html");
    expect(fake.scenes.get("VEIL Cover")).toEqual(["VEIL Cover Card"]);
    store.close();
  });

  it("adds the overlay once under concurrent and repeated calls", async () => {
    const store = new Store(":memory:"),
      obs = new ObsClient(store),
      fake = fakeObs(obs);
    const results = await Promise.all(
      [1, 2, 3].map(() => obs.addOverlay("http://127.0.0.1:1/overlay")),
    );
    await obs.addOverlay("http://127.0.0.1:1/overlay");
    expect(results).toEqual(["Live", "Live", "Live"]);
    expect(fake.scenes.get("Live")).toEqual(["VEIL Overlay"]);
    expect(fake.calls.filter((c) => c === "CreateInput")).toHaveLength(1);
    store.close();
  });
});
