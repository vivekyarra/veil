import { expect, it } from "vitest";
import { ObsClient } from "../electron/obs/client";
import { Store } from "../electron/store/store";
import { obsMock } from "./mocks";

it.each([
  { scenes: [] },
  { scenes: ["VEIL Cover"] },
  { scenes: ["Live", "VEIL Cover"] },
])(
  "rejects invalid protection selections before changing OBS: $scenes",
  async ({ scenes }) => {
    const mock = await obsMock();
    const store = new Store(":memory:");
    const obs = new ObsClient(store);
    try {
      await obs.connect(mock.url, "");
      const before = mock.requests.length;
      await expect(obs.install(scenes, "local.json", 750, 2)).rejects.toThrow();
      expect(mock.requests.slice(before)).toEqual([]);
      expect(mock.offsets).toEqual({ Mic: 25, Desktop: -10 });
      expect(mock.filters.Live).toEqual([]);
    } finally {
      await obs.disconnect();
      await mock.close();
      store.close();
    }
  },
);

it("applies the selected sample rate and restores audio when protection is off", async () => {
  const mock = await obsMock();
  const store = new Store(":memory:");
  const obs = new ObsClient(store);
  try {
    await obs.connect(mock.url, "");
    await obs.install(["Live"], "local.json", 1500, 2, 10);
    expect(mock.filters.Live[0].filterSettings).toMatchObject({
      delay_ms: 1500,
      profile: 2,
      sample_fps: 10,
    });
    expect(mock.offsets).toEqual({ Mic: 1525, Desktop: 1490 });
    await obs.install(["Live"], "local.json", 1500, 0, 10);
    expect(mock.offsets).toEqual({ Mic: 25, Desktop: -10 });
    expect(store.get("audioRollback", {})).toEqual({});
  } finally {
    await obs.disconnect();
    await mock.close();
    store.close();
  }
});
