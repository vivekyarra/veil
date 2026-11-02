import { describe, expect, it, vi } from "vitest";
import { ChatGuard, type GuardEvent } from "../electron/guard/chat-guard";
import { matches } from "../electron/guard/normalize";
import type { ChatMessage } from "../electron/twitch/eventsub";

let sequence = 0;
const message = (
  userId: string,
  text: string,
  timestamp = Date.now(),
): ChatMessage => ({
  id: `s${++sequence}`,
  userId,
  login: "viewer_" + userId,
  text,
  timestamp,
  privileged: false,
});
function setup(terms: { text: string; category: string }[]) {
  const actions = {
    deleteMessage: vi.fn(async (_id: string) => {}),
    timeout: vi.fn(async (_id: string) => {}),
  };
  const events: GuardEvent[] = [];
  const guard = new ChatGuard(actions, (e) => events.push(e), vi.fn());
  guard.setTerms(terms);
  return { actions, events, guard };
}
const vault = Array.from({ length: 200 }, (_, i) => ({
  text:
    i % 4 === 0
      ? `+1 202 ${String(100 + i).padStart(3, "0")} ${String(1000 + i)}`
      : i % 4 === 1
        ? `${100 + i} Elmwood Avenue ${i}`
        : i % 4 === 2
          ? `privatename${i}`
          : `secret${i}x`,
  category: "vault",
}));
const chatter = [
  "gg",
  "lol",
  "555",
  "PogChamp KEKW LUL",
  "that was insane 10/10",
  "first time chatter, love the stream!",
  "!uptime",
  "what rank are you? i'm plat 3",
  "😂😂😂😂😂😂",
  "@streamer can you play the next map",
  "a".repeat(500),
  "lmao ".repeat(100),
];

describe("ChatGuard stress", () => {
  it("scans long, repetitive chat against 200 terms within budget", async () => {
    const { guard, actions } = setup(vault);
    const started = performance.now();
    for (let i = 0; i < 600; i++)
      await guard.receive(message(`u${i % 300}`, chatter[i % chatter.length]));
    const perMessage = (performance.now() - started) / 600;
    expect(actions.deleteMessage).not.toHaveBeenCalled();
    expect(perMessage).toBeLessThan(5);
  });

  it("handles pathological inputs in bounded time", () => {
    const zalgo = "ḿ̂̃ā̅ĭn".repeat(60);
    const inputs = [
      "x".repeat(500),
      "<".repeat(500),
      "<a".repeat(250),
      zalgo,
      "مرحبا بالعالم ".repeat(35),
      "‮123 Main St‬",
      "🔥".repeat(250),
      ".*+?^${}()|[]\\".repeat(35),
      "1-".repeat(250),
      "(((((((((((((((((((((((((((((((((((((((((((".repeat(10),
    ];
    for (const text of inputs) {
      const started = performance.now();
      matches("123 Main St", text);
      matches("a.*b(c)+", text);
      matches("2025550100", text);
      expect(performance.now() - started).toBeLessThan(50);
    }
    expect(matches("123 Main St", "‮123 Main St‬")).toBe(true);
    expect(matches("a.*b(c)+", "a.*b(c)+")).toBe(true);
    expect(matches("123 Main St", "<123 Main St>")).toBe(true);
    expect(matches("2025550100", "<2025550100>")).toBe(true);
  });

  it("bounds per-user state across more users than the tracking cap", async () => {
    const { guard } = setup([{ text: "123 Main St", category: "address" }]);
    const now = Date.now();
    for (let i = 0; i < 51_000; i++)
      await guard.receive(message(`u${i}`, "hello", now));
    const recent = (guard as unknown as { recent: Map<string, unknown[]> })
      .recent;
    expect(recent.size).toBeLessThanOrEqual(50_000);
    expect(guard.ring.messages.length).toBeLessThanOrEqual(50_000);
  });

  it("does not act on common chat with short and phone terms", async () => {
    const { guard, actions } = setup([
      { text: "Ali", category: "name" },
      { text: "Jo", category: "name" },
      { text: "Al", category: "name" },
      { text: "202 555 0100", category: "phone" },
      { text: "5550100", category: "phone" },
    ]);
    const benign = [
      "lol",
      "555",
      "ggwp",
      "eggs",
      "jojo",
      "joke",
      "all of them",
      "call 555",
      "0100",
      "202",
      "2020 was 555 days long",
      "LUL LUL LUL",
      "1 2 3 4 5 6 7 8 9",
      "<3 <3 <3",
    ];
    // Separate users: one user typing "555" then "0100" is a split phone leak.
    for (const [i, text] of benign.entries())
      await guard.receive(message(`fp${i}`, text));
    for (const text of ["gg", "lol", "LUL", "gg wp", "555", "lol"])
      await guard.receive(message("chatty", text));
    expect(actions.deleteMessage).toHaveBeenCalledTimes(0);
    expect(actions.timeout).not.toHaveBeenCalled();
    // Many different users each saying part of a number is not a leak.
    for (const [i, part] of ["202", "555", "0100"].entries())
      await guard.receive(message(`other${i}`, part));
    expect(actions.deleteMessage).not.toHaveBeenCalled();
  });

  it("catches a phone number split across three messages", async () => {
    const { guard, actions } = setup([
      { text: "202 555 0100", category: "phone" },
    ]);
    const parts = ["202", "555", "0100"].map((t) => message("p", t));
    for (const part of parts) await guard.receive(part);
    expect(actions.deleteMessage.mock.calls.map((c) => c[0]).sort()).toEqual(
      parts.map((p) => p.id).sort(),
    );
  });

  it("catches an address split across three messages and filler", async () => {
    const { guard, actions } = setup([
      { text: "742 Evergreen Terrace", category: "address" },
    ]);
    const parts = ["742", "Ever green", "Terrace"].map((t) => message("q", t));
    for (const part of parts) await guard.receive(part);
    expect(actions.deleteMessage).toHaveBeenCalledTimes(3);
    expect(matches("742 Evergreen Terrace", "742 evergreen terrace")).toBe(
      true,
    );
  });
});
