import { describe, expect, it, vi } from "vitest";
import { ChatGuard, type GuardEvent } from "../electron/guard/chat-guard";
import { IncidentEngine } from "../electron/incidents/engine";
import { RehearsalActions } from "../electron/rehearsal/rehearsal";
import type { ChatMessage } from "../electron/twitch/eventsub";

let sequence = 0;
const message = (
  userId: string,
  text: string,
  timestamp = Date.now(),
): ChatMessage => ({
  id: `m${++sequence}`,
  userId,
  login: "viewer_" + userId,
  text,
  timestamp,
  privileged: false,
});
function setup() {
  const actions = {
    deleteMessage: vi.fn(async (_id: string) => {}),
    timeout: vi.fn(async (_id: string) => {}),
  };
  const events: GuardEvent[] = [];
  const spikes = vi.fn();
  const guard = new ChatGuard(actions, (e) => events.push(e), spikes);
  guard.setTerms([{ text: "123 Main St", category: "address" }]);
  return { actions, events, spikes, guard };
}

describe("ChatGuard", () => {
  it("catches a leak split across one user's messages", async () => {
    const { actions, guard, events } = setup();
    const first = message("a", "123"),
      second = message("a", "Main St");
    await guard.receive(first);
    expect(actions.deleteMessage).not.toHaveBeenCalled();
    await guard.receive(second);
    expect(actions.deleteMessage.mock.calls.map((c) => c[0])).toEqual([
      first.id,
      second.id,
    ]);
    expect(events.map((e) => e.kind)).toEqual(["deleted"]);
    expect(guard.removed).toBe(2);
  });

  it("deletes only the fragments that form the leak", async () => {
    const { actions, guard } = setup();
    const hello = message("a", "hello"),
      first = message("a", "123"),
      second = message("a", "Main St");
    for (const m of [hello, first, second]) await guard.receive(m);
    expect(actions.deleteMessage.mock.calls.map((c) => c[0])).toEqual([
      first.id,
      second.id,
    ]);
  });

  it("does not join messages from different users or outside 30 s", async () => {
    const { actions, guard } = setup();
    await guard.receive(message("a", "123"));
    await guard.receive(message("b", "Main St"));
    const old = Date.now() - 31000;
    await guard.receive(message("c", "123", old));
    await guard.receive(message("c", "Main St"));
    expect(actions.deleteMessage).not.toHaveBeenCalled();
  });

  it("keeps the per-user window to the last five messages", async () => {
    const { actions, guard } = setup();
    await guard.receive(message("a", "123"));
    for (let i = 0; i < 4; i++) await guard.receive(message("a", "filler"));
    await guard.receive(message("a", "Main St"));
    expect(actions.deleteMessage).not.toHaveBeenCalled();
  });

  it("short terms need word boundaries", async () => {
    const { actions, guard } = setup();
    guard.setTerms([{ text: "Ann", category: "name" }]);
    await guard.receive(message("a", "this is annoying"));
    expect(actions.deleteMessage).not.toHaveBeenCalled();
    await guard.receive(message("b", "hi Ann"));
    expect(actions.deleteMessage).toHaveBeenCalledTimes(1);
  });

  it("warns instead of deleting privileged split leaks", async () => {
    const { actions, guard, events } = setup();
    await guard.receive({ ...message("mod", "123"), privileged: true });
    await guard.receive({ ...message("mod", "Main St"), privileged: true });
    expect(actions.deleteMessage).not.toHaveBeenCalled();
    expect(events.map((e) => e.kind)).toEqual(["warning"]);
  });

  it("anonymizes users whose login contains a private term", async () => {
    const { guard, events } = setup();
    await guard.receive({
      ...message("x", "123 Main St"),
      login: "123mainst",
    });
    expect(events[0].user).toBe("private-user");
  });

  it("reports delete failures as errors", async () => {
    const { actions, guard, events } = setup();
    actions.deleteMessage.mockRejectedValueOnce(new Error("offline"));
    await guard.receive(message("a", "123 Main St"));
    expect(events.map((e) => e.kind)).toEqual(["error"]);
    expect(guard.removed).toBe(0);
  });

  it("retroactive scan skips deleted messages and never counts or spikes", async () => {
    const { actions, guard, events, spikes } = setup();
    guard.setTerms([]);
    for (const user of ["a", "b", "c", "d"])
      await guard.receive(message(user, "I went to Maple Academy"));
    guard.setTerms([{ text: "123 Main St", category: "address" }]);
    await guard.receive(message("e", "123 Main St"));
    expect(actions.deleteMessage).toHaveBeenCalledTimes(1);
    guard.addSessionTerms(["Maple Academy", ""]);
    await guard.retroactive();
    await guard.retroactive();
    expect(actions.deleteMessage).toHaveBeenCalledTimes(5);
    expect(spikes).not.toHaveBeenCalled();
    expect(actions.timeout).not.toHaveBeenCalled();
    expect(events.filter((e) => e.kind === "retroactive")).toHaveLength(4);
    guard.clearSession();
    expect(guard.ring.messages).toHaveLength(0);
  });

  it("retroactive delete failures are reported and retried next scan", async () => {
    const { actions, guard, events } = setup();
    guard.setTerms([]);
    await guard.receive(message("a", "123 Main St"));
    guard.setTerms([{ text: "123 Main St", category: "address" }]);
    actions.deleteMessage.mockRejectedValueOnce(new Error("offline"));
    await guard.retroactive();
    expect(events.at(-1)?.kind).toBe("error");
    await guard.retroactive();
    expect(events.at(-1)?.kind).toBe("retroactive");
  });

  it("regression: a spike incident cannot loop through retroactive deletion", async () => {
    const adapter = new RehearsalActions();
    const opened = vi.fn();
    const deletes = vi.spyOn(adapter, "deleteMessage");
    const guard = new ChatGuard(
      adapter,
      (e) => {
        if (e.kind === "deleted") engine.attempt(e.user);
      },
      () => {
        opened();
        void engine.open("spike");
      },
    );
    const engine: IncidentEngine = new IncidentEngine(
      adapter.incidentActions(guard),
      async () => false,
      () => {},
      () => {},
      true,
    );
    try {
      guard.setTerms([{ text: "Maple Academy", category: "school" }]);
      // Three users trip the spike; the spike incident runs retroactive.
      for (const user of ["a", "b", "c"])
        await guard.receive(message(user, "Maple Academy"));
      await new Promise((r) => setTimeout(r, 50));
      expect(opened).toHaveBeenCalledTimes(1);
      // A panic with new terms re-scans history once; still no loop.
      guard.setTerms([]);
      await guard.receive(message("d", "Synthetic Lane"));
      await guard.receive(message("e", "Synthetic Lane"));
      await guard.receive(message("f", "Synthetic Lane"));
      await engine.open("panic", ["Synthetic Lane"]);
      await new Promise((r) => setTimeout(r, 50));
      expect(deletes).toHaveBeenCalledTimes(6);
      expect(opened).toHaveBeenCalledTimes(1);
      expect(engine.incidents).toHaveLength(1);
    } finally {
      engine.dispose();
    }
  });
});
