import { it, expect } from "vitest";
import { defaultSettings, patchSettings } from "../electron/store/settings";
it("settings validation is atomic and category profiles stay isolated", () => {
  const original = defaultSettings();
  expect(() =>
    patchSettings(original, { profile: "paranoid", delay: 200 }),
  ).toThrow();
  expect(original.profile).toBe("paranoid");
  const a = patchSettings(original, {
    gameId: "123",
    ignoreZones: [{ x: 0.1, y: 0.1, w: 0.2, h: 0.2 }],
    thresholds: { email: 0.9 },
    recognizers: ["email", "vault"],
    modes: { shield: "off" },
  });
  const b = patchSettings(a, { gameId: "456" });
  expect(b.ignoreZones).toEqual([]);
  expect(patchSettings(b, { gameId: "123" }).ignoreZones).toHaveLength(1);
  expect(() =>
    patchSettings(a, { ignoreZones: [{ x: 0.9, y: 0, w: 0.2, h: 0.1 }] }),
  ).toThrow();
  expect(
    patchSettings(original, {
      discord: "https://discord.com/api/webhooks/123/synthetic-token",
    }).modes.discord,
  ).toBe("auto");
});
for (const patch of [
  { delay: NaN },
  { sampleFps: 11 },
  { theme: "unknown" },
  { profile: "invalid" },
  { discord: "http://example.com" },
  { gameId: "invalid" },
  { recognizers: ["unknown"] },
  { thresholds: { secret: 2 } },
  { modes: { unknown: "auto" } },
  { extra: "invalid" },
])
  it("rejects unsupported patch " + Object.keys(patch)[0], () =>
    expect(() => patchSettings(defaultSettings(), patch)).toThrow(),
  );
