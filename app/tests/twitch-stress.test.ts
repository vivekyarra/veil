import { afterEach, describe, expect, it, vi } from "vitest";
import { WebSocket, WebSocketServer } from "ws";
import {
  AuthRevokedError,
  AuthUnavailableError,
  TwitchAuth,
  type Tokens,
} from "../electron/twitch/auth";
import { Helix } from "../electron/twitch/helix";
import { EventSub } from "../electron/twitch/eventsub";

const json = (body: unknown, status = 200, headers?: Record<string, string>) =>
  new Response(JSON.stringify(body), { status, headers });

function store(access = "old") {
  const state: { tokens: Tokens | undefined } = {
    tokens: {
      access_token: access,
      refresh_token: "r0",
      obtained_at: Date.now(),
      expires_in: 3600,
    },
  };
  return {
    state,
    persistence: {
      load: () => state.tokens,
      save: (t: Tokens) => void (state.tokens = t),
      clear: () => void (state.tokens = undefined),
    },
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("token refresh under load", () => {
  it("10 concurrent 401s across lanes cause exactly one refresh", async () => {
    const { persistence } = store();
    let refreshes = 0;
    const auth = new TwitchAuth(
      "c",
      persistence,
      "https://id.twitch.tv",
      async () => {
        refreshes++;
        await new Promise((r) => setTimeout(r, 5));
        return json({
          access_token: "new",
          refresh_token: "r1",
          expires_in: 3600,
        });
      },
      1,
    );
    const helix = new Helix(auth, "1", "https://api", async (_url, init) => {
      const header = (init?.headers as Record<string, string>).Authorization;
      // Stagger responses so some 401s land after the refresh completed.
      await new Promise((r) => setTimeout(r, Math.random() * 20));
      return header === "Bearer new" ? json({ data: [] }) : json({}, 401);
    });
    const priorities = [0, 1, 2, 3, 10, 0, 1, 2, 3, 10];
    await Promise.all(
      priorities.map((p) => helix.request("GET", "/x", undefined, p)),
    );
    expect(refreshes).toBe(1);
  });

  it("invalid_grant clears tokens; 5xx keeps them", async () => {
    const a = store();
    const revoked = new TwitchAuth(
      "c",
      a.persistence,
      "https://id.twitch.tv",
      async () => json({ status: 400, message: "Invalid refresh token" }, 400),
      1,
    );
    await expect(revoked.refresh()).rejects.toBeInstanceOf(AuthRevokedError);
    expect(a.state.tokens).toBeUndefined();

    const b = store();
    let calls = 0;
    const down = new TwitchAuth(
      "c",
      b.persistence,
      "https://id.twitch.tv",
      async () => (calls++, json({}, 503)),
      1,
    );
    await expect(down.refresh()).rejects.toBeInstanceOf(AuthUnavailableError);
    expect(calls).toBe(3);
    expect(b.state.tokens?.refresh_token).toBe("r0");
  });
});

describe("device flow", () => {
  it("honors slow_down, survives 5xx and network errors, and stops at expiry", async () => {
    vi.useFakeTimers();
    const { persistence } = store();
    const times: number[] = [];
    let n = 0;
    const auth = new TwitchAuth("c", persistence, "https://id", async () => {
      times.push(Date.now());
      n++;
      if (n === 1) return json({ message: "slow_down" }, 400);
      if (n === 2) throw new TypeError("offline");
      if (n === 3) return json({}, 502);
      return json({ message: "authorization_pending" }, 400);
    });
    const start = Date.now();
    const done = auth
      .poll({
        device_code: "d",
        user_code: "u",
        verification_uri: "v",
        interval: 5,
        expires_in: 60,
      })
      .catch((e: Error) => e);
    await vi.advanceTimersByTimeAsync(70000);
    const error = await done;
    expect((error as Error).message).toMatch(/expired/);
    expect(times[0] - start).toBe(5000);
    expect(times[1] - times[0]).toBe(10000); // slow_down adds 5s
    expect(Math.max(...times)).toBeLessThan(start + 60000);
  });

  it("missing interval does not hot-loop", async () => {
    vi.useFakeTimers();
    const { persistence } = store();
    let n = 0;
    const auth = new TwitchAuth("c", persistence, "https://id", async () => {
      n++;
      return json({ message: "authorization_pending" }, 400);
    });
    const done = auth
      .poll({
        device_code: "d",
        user_code: "u",
        verification_uri: "v",
        interval: undefined as unknown as number,
        expires_in: 20,
      })
      .catch(() => undefined);
    await vi.advanceTimersByTimeAsync(25000);
    await done;
    expect(n).toBeLessThanOrEqual(4);
  });
});

describe("Helix rate limits and queue bounds", () => {
  it("garbage Ratelimit-Reset still backs off on 429", async () => {
    vi.useFakeTimers();
    const times: number[] = [];
    const helix = new Helix(
      { access: async () => "t", clientId: "c" },
      "1",
      "https://api",
      async () => {
        times.push(Date.now());
        return times.length < 3
          ? json({}, 429, {
              "Ratelimit-Reset": "soon",
              "Ratelimit-Remaining": "x",
            })
          : json({ data: [] });
      },
    );
    const done = helix.request("GET", "/x");
    await vi.advanceTimersByTimeAsync(5000);
    await done;
    expect(times[1] - times[0]).toBeGreaterThanOrEqual(100);
    expect(times[2] - times[1]).toBeGreaterThanOrEqual(200);
  });

  it("past Ratelimit-Reset uses exponential backoff, far future is capped", async () => {
    vi.useFakeTimers();
    const times: number[] = [];
    const past = String(Math.floor(Date.now() / 1000) - 100);
    const helix = new Helix(
      { access: async () => "t", clientId: "c" },
      "1",
      "https://api",
      async () => {
        times.push(Date.now());
        if (times.length === 1)
          return json({}, 429, { "Ratelimit-Reset": past });
        if (times.length === 2)
          return json({}, 429, { "Ratelimit-Reset": "99999999999" });
        return json({ data: [] });
      },
    );
    const done = helix.request("GET", "/x");
    await vi.advanceTimersByTimeAsync(200000);
    await done;
    expect(times[1] - times[0]).toBeLessThan(1000);
    expect(times[2] - times[1]).toBeLessThanOrEqual(60000);
  });

  it("a 429 storm does not stall deletes behind background lanes", async () => {
    vi.useFakeTimers();
    const reset = String(Math.floor(Date.now() / 1000) + 30);
    const order: string[] = [];
    const helix = new Helix(
      { access: async () => "t", clientId: "c" },
      "1",
      "https://api",
      async (url) => {
        const path = String(url);
        order.push(path);
        if (path.endsWith("/bg") && order.length === 1)
          return json({}, 429, {
            "Ratelimit-Reset": reset,
            "Ratelimit-Remaining": "0",
          });
        return new Response(null, { status: 204 });
      },
    );
    const bg = helix.request("GET", "/bg", undefined, 10);
    await vi.advanceTimersByTimeAsync(1);
    const del = helix.request("DELETE", "/del", undefined, 0);
    await vi.advanceTimersByTimeAsync(10);
    await del;
    expect(order).toContain("https://api/del");
    await vi.advanceTimersByTimeAsync(40000);
    await bg;
  });

  it("offline queue is bounded and drops lowest priority, never deletes", async () => {
    const previous = Helix.QUEUE_CAP;
    Helix.QUEUE_CAP = 20;
    try {
      let release!: () => void;
      const gate = new Promise<void>((r) => (release = r));
      const helix = new Helix(
        { access: async () => "t", clientId: "c" },
        "1",
        "https://api",
        async () => {
          await gate;
          return new Response(null, { status: 204 });
        },
      );
      const settle = (p: Promise<unknown>) =>
        p.then(
          () => "ok",
          (e: Error) => e.message,
        );
      const low = Array.from({ length: 15 }, () =>
        settle(helix.request("GET", "/l", undefined, 10)),
      );
      const mod = Array.from({ length: 15 }, () =>
        settle(helix.request("POST", "/m", {}, 1)),
      );
      const del = Array.from({ length: 100 }, () =>
        settle(helix.request("DELETE", "/d", undefined, 0)),
      );
      release();
      const lowR = await Promise.all(low);
      const modR = await Promise.all(mod);
      const delR = await Promise.all(del);
      expect(delR.every((r) => r === "ok")).toBe(true);
      expect(modR.every((r) => r === "ok")).toBe(true);
      expect(
        lowR.filter((r) => r.startsWith("Dropped")).length,
      ).toBeGreaterThan(0);
    } finally {
      Helix.QUEUE_CAP = previous;
    }
  });
});

describe("moderator mode", () => {
  const helixFor = (status: number) =>
    new Helix(
      { access: async () => "t", clientId: "c" },
      "1",
      "https://api",
      async (url) =>
        String(url).includes("/users?")
          ? json({ data: [{ id: "9", login: "other" }] })
          : json({}, status),
    );
  it("non-moderator gets a clear error and keeps the own channel", async () => {
    const helix = helixFor(403);
    await expect(helix.useChannel("@Other", "me")).rejects.toThrow(
      /not a moderator of other/,
    );
    expect(helix.broadcasterId).toBe("1");
  });
  it("own login in any case or URL form protects own channel", async () => {
    const helix = helixFor(200);
    await helix.useChannel("https://www.twitch.tv/ME/", "me");
    expect(helix.broadcasterId).toBe("1");
  });
  it("rejects invalid logins before calling Twitch", async () => {
    await expect(helixFor(200).useChannel("a b/c", "me")).rejects.toThrow(
      /not a valid/,
    );
  });
});

describe("EventSub stress", () => {
  const servers: WebSocketServer[] = [];
  afterEach(async () => {
    for (const s of servers.splice(0)) {
      s.clients.forEach((c) => c.terminate());
      await new Promise<void>((r) => s.close(() => r()));
    }
  });
  async function server(onConnect: (ws: WebSocket, n: number) => void) {
    const wss = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    servers.push(wss);
    await new Promise<void>((r) => wss.once("listening", r));
    let n = 0;
    wss.on("connection", (ws) => onConnect(ws, n++));
    const address = wss.address();
    if (typeof address === "string" || !address) throw new Error("no address");
    return { wss, url: `ws://127.0.0.1:${address.port}` };
  }
  const frame = (
    type: string,
    payload: unknown,
    id = Math.random().toString(),
    sub?: string,
  ) =>
    JSON.stringify({
      metadata: {
        message_id: id,
        message_type: type,
        message_timestamp: new Date().toISOString(),
        subscription_type: sub,
      },
      payload,
    });
  const welcome = (id: string, keepalive = 10) =>
    frame("session_welcome", {
      session: { id, keepalive_timeout_seconds: keepalive },
    });
  const chat = (id: string) =>
    frame(
      "notification",
      {
        event: {
          message_id: "m-" + id,
          chatter_user_id: "2",
          chatter_user_login: "x",
          message: { text: "hi" },
        },
      },
      id,
      "channel.chat.message",
    );
  const until = async (check: () => boolean, ms = 4000) => {
    const end = Date.now() + ms;
    while (!check()) {
      if (Date.now() > end) throw new Error("timed out");
      await new Promise((r) => setTimeout(r, 10));
    }
  };
  const fakeHelix = () => {
    const subs: string[] = [];
    return {
      subs,
      helix: {
        broadcasterId: "1",
        userId: "1",
        request: async (
          _m: string,
          _p: string,
          body: { type: string; transport: { session_id: string } },
        ) => {
          subs.push(body.type + "@" + body.transport.session_id);
          return {};
        },
      } as unknown as Helix,
    };
  };

  it("reconnect keeps the old socket until the new welcome, no resubscribe", async () => {
    const { subs, helix } = fakeHelix();
    let oldClosed = false;
    const target = await server((ws) => {
      setTimeout(() => ws.send(welcome("s2")), 100);
    });
    const origin = await server((ws) => {
      ws.on("close", () => (oldClosed = true));
      ws.send(welcome("s1"));
      setTimeout(
        () =>
          ws.send(
            frame("session_reconnect", {
              session: {
                id: "s1",
                keepalive_timeout_seconds: 10,
                reconnect_url: target.url,
              },
            }),
          ),
        150,
      );
      // Events still flow on the old socket until the new welcome.
      setTimeout(() => ws.send(chat("dup")), 200);
    });
    const chats: string[] = [];
    const sub = new EventSub(
      helix,
      (m) => chats.push(m.id),
      () => undefined,
      origin.url,
    );
    sub.start();
    await until(() => sub.connected);
    await until(() => chats.length === 1);
    expect(oldClosed).toBe(false);
    await until(() => oldClosed);
    // Same event redelivered on the new socket is deduped.
    target.wss.clients.forEach((c) => c.send(chat("dup")));
    await new Promise((r) => setTimeout(r, 100));
    expect(chats).toEqual(["m-dup"]);
    expect(subs.every((s) => s.endsWith("@s1"))).toBe(true);
    sub.stop();
  });

  it("malformed and unknown frames are ignored; duplicates delivered once", async () => {
    const { helix } = fakeHelix();
    const statuses: string[] = [];
    const origin = await server((ws) => {
      ws.send(welcome("s1"));
      ws.send("not json");
      ws.send("null");
      ws.send(JSON.stringify({ metadata: {} }));
      ws.send(frame("session_welcome", {}));
      ws.send(frame("mystery", { x: 1 }));
      ws.send(
        frame(
          "notification",
          { event: { message: null } },
          "bad",
          "channel.chat.message",
        ),
      );
      ws.send(chat("a"));
      ws.send(chat("a"));
      ws.send(chat("b"));
    });
    const chats: string[] = [];
    const sub = new EventSub(
      helix,
      (m) => chats.push(m.id),
      (s) => statuses.push(s),
      origin.url,
    );
    sub.start();
    await until(() => chats.length === 2);
    await new Promise((r) => setTimeout(r, 50));
    expect(chats).toEqual(["m-a", "m-b"]);
    expect(statuses.filter((s) => s === "invalid EventSub frame").length).toBe(
      4,
    );
    expect(statuses).not.toContain("subscription error");
    sub.stop();
  });

  it("revocation triggers a resubscribe on the current session", async () => {
    const { subs, helix } = fakeHelix();
    const statuses: string[] = [];
    const origin = await server((ws) => {
      ws.send(welcome("s1"));
      setTimeout(
        () =>
          ws.send(
            frame("revocation", {
              subscription: {
                type: "stream.online",
                status: "authorization_revoked",
              },
            }),
          ),
        100,
      );
    });
    const sub = new EventSub(
      helix,
      () => undefined,
      (s) => statuses.push(s),
      origin.url,
    );
    sub.start();
    await until(() => statuses.includes("resubscribed: stream.online"));
    expect(subs.filter((s) => s === "stream.online@s1").length).toBe(2);
    expect(sub.connected).toBe(true);
    sub.stop();
  });

  it("keepalive timeout terminates and reconnects with fresh subscriptions", async () => {
    const { subs, helix } = fakeHelix();
    const origin = await server((ws, n) => {
      // keepalive below Twitch's minimum is clamped to 10s; use n to vary id.
      ws.send(welcome("s" + n, 10));
    });
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const sub = new EventSub(
      helix,
      () => undefined,
      () => undefined,
      origin.url,
    );
    sub.start();
    await vi.waitFor(() => expect(sub.connected).toBe(true), { timeout: 3000 });
    await vi.advanceTimersByTimeAsync(13000); // silence > keepalive + 2s
    await vi.advanceTimersByTimeAsync(1500); // reconnect backoff
    await vi.waitFor(
      () => expect(subs.some((s) => s.endsWith("@s1"))).toBe(true),
      {
        timeout: 3000,
      },
    );
    sub.stop();
  });

  it("a socket that never welcomes is abandoned", async () => {
    const { subs, helix } = fakeHelix();
    const origin = await server((ws, n) => {
      if (n > 0) ws.send(welcome("late"));
    });
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const sub = new EventSub(
      helix,
      () => undefined,
      () => undefined,
      origin.url,
    );
    sub.start();
    await new Promise((r) => setImmediate(r));
    await vi.advanceTimersByTimeAsync(12000);
    await vi.waitFor(
      () => expect(subs.some((s) => s.endsWith("@late"))).toBe(true),
      {
        timeout: 3000,
      },
    );
    sub.stop();
  });
});
