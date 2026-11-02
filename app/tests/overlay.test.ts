import { afterEach, describe, expect, it } from "vitest";
import { request } from "node:http";
import { createServer } from "node:net";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { OverlayServer, type OverlayPayload } from "../electron/overlay/server";
import { ObsClient } from "../electron/obs/client";
import { Store } from "../electron/store/store";
import { obsMock } from "./mocks";

const page = readFileSync(
  join(import.meta.dirname, "../electron/overlay/overlay.html"),
  "utf8",
);
let server: OverlayServer | undefined;
afterEach(async () => {
  await server?.close();
  server = undefined;
});

function get(
  port: number,
  path: string,
  options: { method?: string; host?: string; origin?: string } = {},
): Promise<{ status: number; headers: Record<string, unknown>; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request(
      {
        host: "127.0.0.1",
        port,
        path,
        method: options.method ?? "GET",
        headers: {
          Host: options.host ?? `127.0.0.1:${port}`,
          ...(options.origin ? { Origin: options.origin } : {}),
        },
      },
      (res) => {
        let body = "";
        res.on("data", (c) => (body += c));
        res.on("end", () =>
          resolve({ status: res.statusCode ?? 0, headers: res.headers, body }),
        );
      },
    );
    req.on("error", reject);
    req.end();
  });
}
/** Read SSE frames until `count` data payloads arrive. */
function events(
  port: number,
  count: number,
  during: () => void,
): Promise<OverlayPayload[]> {
  return new Promise((resolve, reject) => {
    const frames: OverlayPayload[] = [];
    const req = request(
      { host: "127.0.0.1", port, path: "/overlay/events" },
      (res) => {
        expect(res.headers["content-type"]).toBe("text/event-stream");
        let buffer = "";
        res.on("data", (chunk) => {
          buffer += chunk;
          for (const line of buffer.split("\n"))
            if (line.startsWith("data: "))
              frames.push(JSON.parse(line.slice(6)) as OverlayPayload);
          buffer = buffer.slice(buffer.lastIndexOf("\n") + 1);
          if (frames.length === 1) during();
          if (frames.length >= count) {
            req.destroy();
            resolve(frames);
          }
        });
      },
    );
    req.on("error", reject);
    req.end();
  });
}

describe("overlay server", () => {
  it("serves the page and a counts-only event stream on loopback", async () => {
    let clock = 1_000_000;
    server = new OverlayServer(
      () => page,
      () => clock,
    );
    await server.start(0);
    expect(server.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/overlay$/);
    const html = await get(server.port, "/overlay");
    expect(html.status).toBe(200);
    expect(html.headers["content-security-policy"]).toContain(
      "default-src 'none'",
    );
    expect(html.body).toContain("Shielded by");
    const head = await get(server.port, "/overlay", { method: "HEAD" });
    expect(head.body).toBe("");

    const frames = await events(server.port, 3, () => {
      server!.update({ armed: true, masks: 0, removed: 0 });
      clock += 1000;
      server!.update({ armed: true, masks: 3, removed: 2 });
    });
    expect(frames[0]).toEqual({
      armed: false,
      since: 0,
      screen: 0,
      chat: 0,
      lastCatch: 0,
      lastKind: 0,
    });
    expect(frames[1]).toMatchObject({ armed: true, since: 1_000_000 });
    expect(frames[2]).toEqual({
      armed: true,
      since: 1_000_000,
      screen: 1,
      chat: 2,
      lastCatch: 1_001_000,
      lastKind: 2,
    });
    // Nothing but numbers and booleans can ever reach a viewer.
    for (const frame of frames)
      for (const value of Object.values(frame))
        expect(["number", "boolean"]).toContain(typeof value);
  });

  it("groups mask bursts into one catch and ignores counter resets", async () => {
    let clock = 0;
    server = new OverlayServer(
      () => page,
      () => clock,
    );
    server.update({ armed: true, masks: 1, removed: 0 });
    clock += 1000;
    server.update({ armed: true, masks: 9, removed: 0 });
    expect(server.payload.screen).toBe(1);
    clock += 6000;
    server.update({ armed: true, masks: 12, removed: 0 });
    expect(server.payload.screen).toBe(2);
    server.update({ armed: false, masks: 0, removed: 0 });
    expect(server.payload).toMatchObject({ armed: false, since: 0, chat: 0 });
    expect(server.payload.screen).toBe(2);
  });

  it("rejects writes, foreign hosts and unknown paths", async () => {
    server = new OverlayServer(() => page);
    await server.start(0);
    const { port } = server;
    expect((await get(port, "/overlay", { method: "POST" })).status).toBe(405);
    expect(
      (await get(port, "/overlay", { host: "evil.example:" + port })).status,
    ).toBe(403);
    expect((await get(port, "/", {})).status).toBe(404);
    expect(
      (await get(port, "/overlay", { host: "localhost:" + port })).status,
    ).toBe(200);
  });

  it("rejects rebinding hosts, foreign origins, traversal and odd methods", async () => {
    server = new OverlayServer(() => page);
    await server.start(0);
    const { port } = server;
    for (const host of [
      "attacker.example",
      `127.0.0.1.nip.io:${port}`,
      `127.0.0.1:${port + 1}`,
      `127.0.0.1`,
    ])
      expect((await get(port, "/overlay", { host })).status).toBe(403);
    expect(
      (await get(port, "/overlay", { origin: "http://evil.example" })).status,
    ).toBe(403);
    expect(
      (await get(port, "/overlay/events", { origin: "null" })).status,
    ).toBe(403);
    expect(
      (await get(port, "/overlay", { origin: `http://127.0.0.1:${port}` }))
        .status,
    ).toBe(200);
    for (const path of [
      "/overlay/../overlay.html",
      "/overlay/..%2f..%2fpackage.json",
      "/../../etc/passwd",
      "//overlay",
    ])
      expect((await get(port, path)).status).toBe(404);
    for (const method of ["PUT", "DELETE", "OPTIONS", "PATCH"])
      expect((await get(port, "/overlay", { method })).status).toBe(405);
    expect(
      (await get(port, "/overlay/events", { method: "HEAD" })).status,
    ).toBe(405);
  });

  it("caps SSE clients and drops clients that stall on headers", async () => {
    server = new OverlayServer(() => page);
    await server.start(0);
    const { port } = server;
    const open = await Promise.all(
      Array.from(
        { length: 16 },
        () =>
          new Promise<import("node:http").ClientRequest>((resolve) => {
            const req = request(
              { host: "127.0.0.1", port, path: "/overlay/events" },
              () => resolve(req),
            );
            req.on("error", () => {});
            req.end();
          }),
      ),
    );
    expect((await get(port, "/overlay/events")).status).toBe(503);
    for (const req of open) req.destroy();
    const { connect } = await import("node:net");
    const socket = connect(port, "127.0.0.1");
    socket.on("error", () => {});
    socket.resume();
    socket.write("GET /overlay HTTP/1.1\r\nHost: 127.0.0.1\r\n");
    const closed = await new Promise<boolean>((resolve) => {
      socket.on("close", () => resolve(true));
      setTimeout(() => resolve(false), 12000);
    });
    expect(closed).toBe(true);
  }, 15000);

  it("only ever emits whole counts, timestamps and booleans", () => {
    server = new OverlayServer(
      () => page,
      () => 1000,
    );
    server.update({
      armed: "yes" as unknown as boolean,
      masks: "<script>" as unknown as number,
      removed: NaN,
    });
    server.update({ armed: true, masks: 2.7, removed: Infinity });
    const payload = server.payload;
    expect(Object.keys(payload).sort()).toEqual(
      ["armed", "chat", "lastCatch", "lastKind", "screen", "since"].sort(),
    );
    for (const [key, value] of Object.entries(payload))
      expect(
        key === "armed" ? typeof value === "boolean" : Number.isInteger(value),
      ).toBe(true);
    expect(payload).toMatchObject({ armed: true, screen: 1, chat: 0 });
  });

  it("falls back to a free port when the preferred one is taken", async () => {
    const blocker = createServer();
    await new Promise<void>((r) => blocker.listen(0, "127.0.0.1", r));
    const taken = (blocker.address() as { port: number }).port;
    try {
      server = new OverlayServer(() => page);
      await server.start(taken);
      expect(server.port).not.toBe(taken);
      expect(server.port).toBeGreaterThan(0);
    } finally {
      await new Promise<void>((r) => blocker.close(() => r()));
    }
  });
});

it("adds the overlay browser source to the current program scene", async () => {
  const mock = await obsMock(),
    store = new Store(":memory:"),
    obs = new ObsClient(store);
  try {
    await obs.connect(mock.url, "");
    expect(await obs.addOverlay("http://127.0.0.1:47322/overlay")).toBe("Live");
    expect(mock.browserInputs["VEIL Overlay"]).toMatchObject({
      is_local_file: false,
      url: "http://127.0.0.1:47322/overlay",
    });
    await obs.cover();
    await expect(obs.addOverlay("http://x")).rejects.toThrow("streaming scene");
    await obs.disconnect();
  } finally {
    await mock.close();
    store.close();
  }
});
