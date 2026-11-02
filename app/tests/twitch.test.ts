import { describe, expect, it, vi } from "vitest";
import {
  AuthRevokedError,
  AuthUnavailableError,
  SCOPES,
  TwitchAuth,
  type Tokens,
} from "../electron/twitch/auth";
import { Helix, HelixError } from "../electron/twitch/helix";
import { EventSub } from "../electron/twitch/eventsub";
import { eventSubMock } from "./mocks";

function memory(expired = false) {
  const state: { tokens: Tokens | undefined } = {
    tokens: {
      access_token: "synthetic",
      refresh_token: "synthetic-refresh",
      obtained_at: expired ? 0 : Date.now(),
      expires_in: expired ? 1 : 3600,
    },
  };
  return {
    state,
    persistence: {
      load: () => state.tokens,
      save: (t: Tokens) => {
        state.tokens = t;
      },
      clear: () => {
        state.tokens = undefined;
      },
    },
  };
}
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status });
const validation = {
  client_id: "synthetic",
  user_id: "1",
  login: "synthetic",
  scopes: [...SCOPES],
  expires_in: 3600,
};

describe("TwitchAuth transient failures keep the sign-in", () => {
  it("validate retries 5xx and network errors, then succeeds", async () => {
    const { persistence } = memory();
    let calls = 0;
    const auth = new TwitchAuth(
      "synthetic",
      persistence,
      "https://id.twitch.tv",
      async () => {
        calls++;
        if (calls === 1) throw new TypeError("network down");
        if (calls === 2) return json({}, 503);
        return json(validation);
      },
      1,
    );
    expect((await auth.validate()).user_id).toBe("1");
    expect(calls).toBe(3);
  });

  it("validate gives up on persistent 5xx without clearing tokens", async () => {
    const { persistence, state } = memory();
    const auth = new TwitchAuth(
      "synthetic",
      persistence,
      "https://id.twitch.tv",
      async () => json({}, 500),
      1,
    );
    await expect(auth.validate()).rejects.toBeInstanceOf(AuthUnavailableError);
    expect(state.tokens).toBeDefined();
  });

  it("validate 401 refreshes once; a second 401 clears tokens", async () => {
    const { persistence, state } = memory();
    const paths: string[] = [];
    const auth = new TwitchAuth(
      "synthetic",
      persistence,
      "https://id.twitch.tv",
      async (url) => {
        paths.push(new URL(String(url)).pathname);
        return String(url).endsWith("/oauth2/token")
          ? json({
              access_token: "new",
              refresh_token: "new-refresh",
              expires_in: 3600,
            })
          : json({}, 401);
      },
      1,
    );
    await expect(auth.validate()).rejects.toBeInstanceOf(AuthRevokedError);
    expect(paths).toEqual([
      "/oauth2/validate",
      "/oauth2/token",
      "/oauth2/validate",
    ]);
    expect(state.tokens).toBeUndefined();
  });

  it("validate rejects other 4xx without clearing tokens", async () => {
    const { persistence, state } = memory();
    const auth = new TwitchAuth(
      "synthetic",
      persistence,
      "https://id.twitch.tv",
      async () => json({}, 403),
      1,
    );
    await expect(auth.validate()).rejects.toThrow("403");
    expect(state.tokens).toBeDefined();
  });

  it("refresh clears tokens only for invalid_grant", async () => {
    for (const [status, body, cleared] of [
      [400, { error: "invalid_grant" }, true],
      [401, { message: "Invalid refresh token" }, true],
      [400, { message: "missing client id" }, false],
      [503, {}, false],
    ] as const) {
      const { persistence, state } = memory(true);
      const auth = new TwitchAuth(
        "synthetic",
        persistence,
        "https://id.twitch.tv",
        async () => json(body, status),
        1,
      );
      const failure = auth.access();
      await expect(failure).rejects.toThrow();
      if (cleared)
        await expect(failure).rejects.toBeInstanceOf(AuthRevokedError);
      expect(state.tokens === undefined).toBe(cleared);
    }
  });
});

describe("Helix", () => {
  it("refreshes once on 401 and retries", async () => {
    const refresh = vi.fn(async () => ({}) as Tokens);
    let calls = 0;
    const helix = new Helix(
      { clientId: "c", access: async () => "t", refresh },
      "1",
      "https://api.twitch.tv/helix",
      async () => (++calls === 1 ? json({}, 401) : json({ data: [] })),
    );
    expect(await helix.stream()).toEqual({ data: [] });
    expect(refresh).toHaveBeenCalledTimes(1);
    const always = new Helix(
      { clientId: "c", access: async () => "t", refresh },
      "1",
      "https://api.twitch.tv/helix",
      async () => json({}, 401),
    );
    await expect(always.stream()).rejects.toBeInstanceOf(HelixError);
    expect(refresh).toHaveBeenCalledTimes(2);
  });

  it("a 429 on one lane does not block message deletes", async () => {
    let limited = 0;
    const helix = new Helix(
      { clientId: "c", access: async () => "t" },
      "1",
      "https://api.twitch.tv/helix",
      async (url, init) => {
        if (init?.method === "DELETE")
          return new Response(null, { status: 204 });
        if (String(url).includes("/streams") && limited++ === 0)
          return new Response("{}", {
            status: 429,
            headers: {
              "Ratelimit-Remaining": "0",
              "Ratelimit-Reset": String(Math.ceil(Date.now() / 1000) + 2),
            },
          });
        return json({ data: [] });
      },
    );
    const slow = helix.stream().catch(() => undefined);
    await new Promise((r) => setTimeout(r, 20));
    const started = Date.now();
    await helix.deleteMessage("m1");
    expect(Date.now() - started).toBeLessThan(1000);
    expect(await slow).toEqual({ data: [] });
  });

  it("resolves a protected channel and requires moderator access", async () => {
    const requests: string[] = [];
    const helix = new Helix(
      { clientId: "c", access: async () => "t" },
      "me",
      "https://api.twitch.tv/helix",
      async (url) => {
        const path = String(url).replace("https://api.twitch.tv/helix", "");
        requests.push(path);
        if (path.startsWith("/users?login=friend"))
          return json({ data: [{ id: "42", login: "friend" }] });
        if (path.startsWith("/users?login=stranger"))
          return json({ data: [{ id: "77", login: "stranger" }] });
        if (path.startsWith("/users")) return json({ data: [] });
        if (path.includes("broadcaster_id=77")) return json({}, 403);
        return json({ data: [] });
      },
    );
    await helix.useChannel("", "Me");
    expect(helix.broadcasterId).toBe("me");
    await helix.useChannel("friend", "me");
    expect(helix.broadcasterId).toBe("42");
    await helix.deleteMessage("m");
    expect(requests.at(-1)).toContain("broadcaster_id=42&moderator_id=me");
    await helix.notice();
    await expect(helix.useChannel("stranger", "me")).rejects.toThrow(
      "not a moderator of stranger",
    );
    await expect(helix.useChannel("nobody", "me")).rejects.toThrow(
      "was not found",
    );
    expect(helix.broadcasterId).toBe("42");
    await helix.useChannel("me", "me");
    expect(helix.broadcasterId).toBe("me");
  });
});

describe("EventSub", () => {
  it("uses moderator conditions, message timestamps and resubscribes after revocation", async () => {
    const server = await eventSubMock();
    const bodies: Record<string, unknown>[] = [];
    const status: string[] = [];
    const chats: number[] = [];
    let fail = false;
    const helix = new Helix(
      { clientId: "c", access: async () => "t" },
      "mod-user",
      "https://api.twitch.tv/helix",
      async (_url, init) => {
        bodies.push(JSON.parse(String(init?.body)));
        return json({ data: [] }, fail ? 403 : 202);
      },
    );
    helix.broadcasterId = "channel";
    const client = new EventSub(
      helix,
      (m) => chats.push(m.timestamp),
      (s) => status.push(s),
      server.url,
    );
    try {
      client.start();
      await expect.poll(() => client.connected).toBe(true);
      expect(bodies[0].condition).toEqual({
        broadcaster_user_id: "channel",
        user_id: "mod-user",
      });
      expect(bodies[3].condition).toEqual({
        broadcaster_user_id: "channel",
        moderator_user_id: "mod-user",
      });
      const sent = "2024-01-02T03:04:05.123456789Z";
      server.send({
        metadata: {
          message_id: "n1",
          message_type: "notification",
          message_timestamp: sent,
          subscription_type: "channel.chat.message",
        },
        payload: {
          event: {
            message_id: "c1",
            chatter_user_id: "u",
            chatter_user_login: "u",
            message: { text: "hi" },
          },
        },
      });
      await expect.poll(() => chats.length).toBe(1);
      expect(chats[0]).toBe(Date.parse("2024-01-02T03:04:05.123Z"));
      const revoke = (id: string) =>
        server.send({
          metadata: {
            message_id: id,
            message_type: "revocation",
            message_timestamp: new Date().toISOString(),
          },
          payload: {
            subscription: { type: "channel.chat.message", status: "x" },
          },
        });
      revoke("r1");
      await expect
        .poll(() => status)
        .toContain("resubscribed: channel.chat.message");
      expect(client.connected).toBe(true);
      expect(bodies).toHaveLength(6);
      fail = true;
      revoke("r2");
      await expect
        .poll(() => status)
        .toContain("authorization revoked; sign in again");
      expect(client.connected).toBe(false);
    } finally {
      client.stop();
      await server.close();
    }
  });
});
