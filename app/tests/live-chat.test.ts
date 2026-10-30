import { expect, it } from "vitest";
import { ChatGuard } from "../electron/guard/chat-guard";
import { liveChatHandler } from "../electron/guard/live-chat";
import { Helix } from "../electron/twitch/helix";
import { EventSub } from "../electron/twitch/eventsub";
import { eventSubMock, twitchMock } from "./mocks";

it("keeps real Twitch chat out of rehearsal and resumes moderation in connected mode", async () => {
  const api = await twitchMock();
  const events = await eventSubMock();
  const helix = new Helix(
    { clientId: "test-client", access: async () => "test-token" },
    "broadcaster",
    api.url + "/helix",
  );
  const guard = new ChatGuard(
    helix,
    () => {},
    () => {},
  );
  guard.setTerms([{ text: "123 Main St", category: "address" }]);
  let connectedMode = false;
  let received = 0;
  const route = liveChatHandler(() => connectedMode, guard);
  const sub = new EventSub(
    helix,
    (message) => {
      route(message);
      received++;
    },
    () => {},
    events.url,
  );
  const send = (id: string) =>
    events.send({
      metadata: {
        message_id: id,
        message_type: "notification",
        message_timestamp: new Date().toISOString(),
        subscription_type: "channel.chat.message",
      },
      payload: {
        event: {
          message_id: id,
          chatter_user_id: id,
          chatter_user_login: "viewer",
          badges: [],
          message: { text: "1 2 3 m4in st" },
        },
      },
    });
  try {
    sub.start();
    await expect.poll(() => sub.connected).toBe(true);
    send("practice-1");
    await expect.poll(() => received).toBe(1);
    expect(api.requests.filter((r) => r.method === "DELETE")).toHaveLength(0);
    expect(guard.ring.messages).toHaveLength(0);

    connectedMode = true;
    send("connected-1");
    await expect.poll(() => guard.removed).toBe(1);
    expect(api.requests.filter((r) => r.method === "DELETE")).toHaveLength(1);

    connectedMode = false;
    send("practice-2");
    await expect.poll(() => received).toBe(3);
    // Rehearsal messages never enter the live ring, even for later incident review.
    expect(guard.ring.messages.map((m) => m.id)).toEqual(["connected-1"]);
    expect(api.requests.filter((r) => r.method === "DELETE")).toHaveLength(1);
  } finally {
    sub.stop();
    await events.close();
    await api.close();
  }
});
