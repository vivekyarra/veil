import { it, expect } from "vitest";
import { eventSubMock } from "./mocks";
import { Helix } from "../electron/twitch/helix";
import { EventSub } from "../electron/twitch/eventsub";
import { TwitchAuth } from "../electron/twitch/auth";

it("partial EventSub subscription failure never reports chat protection connected", async () => {
  const server = await eventSubMock();
  const attempts: string[] = [],
    status: string[] = [];
  const helix = new Helix(
    { clientId: "synthetic", access: async () => "synthetic" },
    "123",
    "http://127.0.0.1",
    async (_url, options) => {
      const type = JSON.parse(String(options?.body)).type;
      attempts.push(type);
      return new Response(JSON.stringify({ data: [] }), {
        status: type === "channel.chat.message" ? 400 : 202,
      });
    },
  );
  const client = new EventSub(
    helix,
    () => {},
    (s) => status.push(s),
    server.url,
  );
  try {
    client.start();
    const deadline = Date.now() + 5000;
    while (
      !status.includes("subscription setup incomplete") &&
      Date.now() < deadline
    )
      await new Promise((r) => setTimeout(r, 25));
    expect(attempts).toHaveLength(5);
    expect(status).toContain("subscription setup incomplete");
    expect(client.connected).toBe(false);
  } finally {
    client.stop();
    await server.close();
  }
});

it("cancelling device authorization cannot persist a late token response", async () => {
  const controller = new AbortController();
  let saved = false;
  const auth = new TwitchAuth(
    "synthetic",
    {
      load: () => undefined,
      save: () => {
        saved = true;
      },
      clear: () => {},
    },
    "http://127.0.0.1",
    async () => {
      controller.abort();
      return new Response(
        JSON.stringify({
          access_token: "synthetic",
          refresh_token: "synthetic",
          expires_in: 3600,
        }),
      );
    },
  );
  await expect(
    auth.poll(
      {
        device_code: "synthetic",
        user_code: "synthetic",
        verification_uri: "https://www.twitch.tv/activate",
        interval: 0,
        expires_in: 20,
      },
      controller.signal,
    ),
  ).rejects.toThrow("cancelled");
  expect(saved).toBe(false);
});
