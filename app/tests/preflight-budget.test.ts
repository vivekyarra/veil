import { expect, it } from "vitest";
import { preflight } from "../electron/preflight/preflight";
import type { ObsClient } from "../electron/obs/client";
import type { Supervisor } from "../electron/supervisor";

async function budget(p99: unknown, delay = 750, sampleFps = 4) {
  const detector = {
    request: async () => ({ model_loaded: true, p99_ms: p99 }),
  } as unknown as Supervisor;
  const checks = await preflight(
    { connected: false } as ObsClient,
    detector,
    delay,
    sampleFps,
    0,
    false,
    false,
  );
  return checks.find((check) => check.id === "latency")!;
}

it("offers an actionable measured budget with sample interval and margin", async () => {
  expect(await budget(2490)).toMatchObject({
    status: "fail",
    recommendedDelay: 2840,
  });
  expect(await budget(2490, 2840)).toMatchObject({ status: "pass" });
  expect((await budget(2490, 2840)).recommendedDelay).toBeUndefined();
  expect((await budget(2490, 750, 10)).recommendedDelay).toBe(2690);
});

it.each([null, undefined, NaN, Infinity, -1, "900"])(
  "keeps invalid or absent measurements out of settings: %s",
  async (measurement) => {
    const check = await budget(measurement);
    expect(check.status).toBe("warn");
    expect(check.recommendedDelay).toBeUndefined();
  },
);

it("does not offer an unsupported or unnecessary delay", async () => {
  expect((await budget(2650)).recommendedDelay).toBe(3000);
  expect((await budget(2651)).recommendedDelay).toBeUndefined();
  expect((await budget(200)).recommendedDelay).toBeUndefined();
});
