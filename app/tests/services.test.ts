import { it, expect } from "vitest";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createServer } from "node:http";
import { Supervisor, localCredential } from "../electron/supervisor";
import { preflight } from "../electron/preflight/preflight";
import { ObsClient } from "../electron/obs/client";
import { Store } from "../electron/store/store";
import { obsMock } from "./mocks";
import { TwitchAuth, SCOPES, type Tokens } from "../electron/twitch/auth";
import { Helix } from "../electron/twitch/helix";

it("local install token persists with per-user file access and rejects corruption", () => {
  const path = mkdtempSync(join(tmpdir(), "veil-credential-"));
  const a = localCredential(path),
    b = localCredential(path);
  expect(a.token).toHaveLength(64);
  expect(a.token).toBe(b.token);
  expect(JSON.parse(readFileSync(a.path, "utf8")).token).toBe(a.token);
  writeFileSync(a.path, '{"token":"short"}');
  expect(() => localCredential(path)).toThrow("Invalid");
});
it("supervisor health and pre-flight expose measured failures and manual checks", async () => {
  const token = "a".repeat(64),
    server = createServer((req, res) => {
      if (req.headers.authorization !== "Bearer " + token) {
        res.writeHead(401);
        res.end();
        return;
      }
      res.setHeader("Content-Type", "application/json");
      res.end(
        JSON.stringify({
          status: "ok",
          model_loaded: true,
          p99_ms: 900,
          window_guard_available: false,
          window_guard_reason: "Permission required",
          denylisted_windows: 0,
        }),
      );
    });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("Mock detector missing");
  const detector = new Supervisor(token, `http://127.0.0.1:${address.port}`),
    mock = await obsMock(),
    store = new Store(":memory:"),
    obs = new ObsClient(store);
  try {
    await detector.start(process.execPath, ["-e", "setInterval(()=>{},1000)"]);
    expect((await detector.request("/v1/health")).status).toBe("ok");
    let checks = await preflight(obs, detector, 750, 4, 0, false, false);
    expect(checks.find((c) => c.id === "latency")?.status).toBe("fail");
    expect(checks.find((c) => c.id === "notifications")?.status).toBe("warn");
    await obs.connect(mock.url, "");
    await obs.install(["Live"], "local.json", 750, 1);
    checks = await preflight(obs, detector, 1500, 4, 3, true, true);
    expect(checks.find((c) => c.id === "filters")?.status).toBe("pass");
    expect(checks.find((c) => c.id === "latency")?.status).toBe("pass");
    await obs.install(["Live"], "local.json", 1500, 0);
    checks = await preflight(obs, detector, 1500, 4, 3, true, true);
    expect(checks.find((c) => c.id === "filters")?.status).toBe("fail");
    await obs.disconnect();
  } finally {
    detector.stop();
    await mock.close();
    store.close();
    await new Promise<void>((r) => server.close(() => r()));
  }
});
it("OAuth startup validation verifies client and scopes, refresh failure clears credentials", async () => {
  let tokens: Tokens | undefined = {
    access_token: "synthetic",
    refresh_token: "synthetic-refresh",
    obtained_at: Date.now(),
    expires_in: 3600,
  };
  const persistence = {
    load: () => tokens,
    save: (value: Tokens) => {
      tokens = value;
    },
    clear: () => {
      tokens = undefined;
    },
  };
  const valid = new TwitchAuth(
    "synthetic",
    persistence,
    "https://id.twitch.tv",
    async () =>
      new Response(
        JSON.stringify({
          client_id: "synthetic",
          user_id: "fake",
          login: "synthetic",
          scopes: [...SCOPES],
          expires_in: 3600,
        }),
        { status: 200 },
      ),
  );
  expect((await valid.validate()).user_id).toBe("fake");
  const revoked = new TwitchAuth(
    "synthetic",
    persistence,
    "https://id.twitch.tv",
    async () => new Response("{}", { status: 401 }),
  );
  tokens = { ...tokens!, obtained_at: 0, expires_in: 1 };
  await expect(revoked.access()).rejects.toThrow("refresh failed");
  expect(tokens).toBeUndefined();
  await expect(revoked.validate()).rejects.toThrow("sign-in");
});
it("Helix retries bounded server errors without leaking response bodies", async () => {
  let calls = 0;
  const client = new Helix(
    { clientId: "synthetic", access: async () => "synthetic" },
    "fake",
    "https://api.twitch.tv/helix",
    async () =>
      ++calls === 1
        ? new Response("sensitive response text", { status: 503 })
        : new Response(JSON.stringify({ data: [] }), { status: 200 }),
  );
  expect(await client.stream()).toEqual({ data: [] });
  expect(calls).toBe(2);
  expect(() => client.deleteMessage("")).toThrow();
  expect(() => client.blockedTerm("a")).toThrow();
});
