import { it, expect, vi, afterEach } from "vitest";
import {
  IncidentEngine,
  type Answer,
  type Incident,
  type IncidentActions,
} from "../electron/incidents/engine";
import { RehearsalActions } from "../electron/rehearsal/rehearsal";
import { ChatGuard } from "../electron/guard/chat-guard";
import { obsMock } from "./mocks";
import { ObsClient } from "../electron/obs/client";

const tick = () => new Promise((r) => setTimeout(r, 0));
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}
function actions(): IncidentActions {
  return {
    cover: vi.fn(async () => {}),
    mute: vi.fn(async () => {}),
    unmute: vi.fn(async () => {}),
    guard: vi.fn(async () => {}),
    retroactive: vi.fn(async () => {}),
    marker: vi.fn(async () => undefined),
    shield: vi.fn(async () => {}),
    blocked: vi.fn(async () => {}),
    notice: vi.fn(async () => {}),
    discord: vi.fn(async () => {}),
    clips: vi.fn(async () => []),
  };
}
const engines: IncidentEngine[] = [];
function engine(
  adapter = actions(),
  ask: () => Promise<Answer> = async () => false,
  persist: (i: Incident[]) => void = () => {},
): IncidentEngine {
  const e = new IncidentEngine(adapter, ask, persist, () => {});
  engines.push(e);
  return e;
}
afterEach(() => {
  engines.splice(0).forEach((e) => e.dispose());
  vi.useRealTimers();
});

it("10 concurrent panics open exactly one incident and coalesce mute", async () => {
  const adapter = actions();
  let inFlight = 0,
    peak = 0;
  adapter.mute = vi.fn(async () => {
    peak = Math.max(peak, ++inFlight);
    await tick();
    inFlight--;
  });
  const e = engine(adapter);
  e.modes.mute = "auto";
  const results = await Promise.all(
    Array.from({ length: 10 }, () => e.open("panic")),
  );
  expect(new Set(results.map((i) => i.id)).size).toBe(1);
  expect(e.incidents).toHaveLength(1);
  expect(peak).toBe(1);
  await e.close(results[0].id);
  expect(adapter.unmute).toHaveBeenCalledTimes(1);
});

it("a panic while an incident is open covers again without a new incident", async () => {
  const adapter = actions();
  const e = engine(adapter);
  const first = await e.open("late", ["term"]);
  const again = await e.open("panic");
  expect(again.id).toBe(first.id);
  expect(adapter.cover).toHaveBeenCalledTimes(1);
  expect(e.incidents).toHaveLength(1);
});

it("resolving during a pending approval skips the action and keeps it closed", async () => {
  const adapter = actions();
  const answer = deferred<Answer>();
  const e = engine(adapter, () => answer.promise);
  const opening = e.open("panic");
  await tick();
  const incident = e.incidents[0];
  await e.close(incident.id);
  answer.resolve(true);
  await opening;
  expect(incident.state).toBe("closed");
  expect(adapter.shield).not.toHaveBeenCalled();
  expect(incident.actions.find((a) => a.action === "shield")).toMatchObject({
    status: "declined",
    reason: "resolved",
  });
});

it("resolving mid automatic actions never reverts closed to contained", async () => {
  const adapter = actions();
  const gate = deferred<void>();
  adapter.guard = vi.fn(() => gate.promise);
  const e = engine(adapter);
  e.modes.mute = "auto";
  const opening = e.open("panic", ["t"]);
  await tick();
  const incident = e.incidents[0];
  await e.close(incident.id);
  gate.resolve();
  await opening;
  expect(incident.state).toBe("closed");
  expect(adapter.retroactive).not.toHaveBeenCalled();
});

it("a mute still in flight at resolve is restored", async () => {
  const adapter = actions();
  const gate = deferred<void>();
  adapter.mute = vi.fn(() => gate.promise);
  const e = engine(adapter);
  e.modes.mute = "auto";
  const opening = e.open("panic");
  await tick();
  const closing = e.close(e.incidents[0].id);
  gate.resolve();
  await Promise.all([opening, closing]);
  expect(adapter.unmute).toHaveBeenCalledTimes(1);
});

it("100 spikes in one second keep one incident, one retroactive and one close timer", async () => {
  vi.useFakeTimers();
  const adapter = actions();
  const e = engine(adapter);
  const first = await e.open("spike");
  for (let i = 0; i < 100; i++) {
    await e.open("spike");
    await vi.advanceTimersByTimeAsync(10);
  }
  expect(e.incidents).toHaveLength(1);
  expect(adapter.retroactive).toHaveBeenCalledTimes(1);
  expect(vi.getTimerCount()).toBe(1);
  await vi.advanceTimersByTimeAsync(600100);
  expect(first.state).toBe("closed");
});

it("no trigger path re-enters retroactive in a loop", async () => {
  const rehearsal = new RehearsalActions();
  const guard = new ChatGuard(
    rehearsal,
    (value) => {
      if (value.kind === "deleted") e.attempt(value.user);
    },
    () => void e.open("spike"),
  );
  guard.setTerms([{ text: "123 Main St", category: "address" }]);
  const adapter = rehearsal.incidentActions(guard);
  const spy = vi.spyOn(adapter, "retroactive");
  const e = engine(adapter);
  for (let i = 0; i < 6; i++)
    await guard.receive({
      id: "m" + i,
      userId: "u" + i,
      login: "viewer" + i,
      text: i % 2 ? "123 main st" : "secret phrase " + i,
      timestamp: Date.now(),
      privileged: false,
    });
  await e.open("spike");
  await e.open("late", ["secret phrase"]);
  await e.open("manual", ["secret phrase"]);
  await e.open("panic", ["secret phrase"]);
  await Promise.all(
    Array.from({ length: 10 }, () => e.open("late", ["secret phrase"])),
  );
  await tick();
  expect(e.incidents).toHaveLength(1);
  // 1 open + 3 sequential re-scans + the coalesced concurrent batch.
  expect(spy.mock.calls.length).toBeLessThanOrEqual(6);
  expect(rehearsal.deleted).toEqual(
    expect.arrayContaining(["m0", "m1", "m2", "m3", "m4", "m5"]),
  );
});

it("a re-scan requested during a running scan is not dropped", async () => {
  const adapter = actions();
  const gate = deferred<void>();
  let calls = 0;
  adapter.retroactive = vi.fn(async () => {
    if (++calls === 1) await gate.promise;
  });
  const e = engine(adapter);
  const opening = e.open("manual", ["a"]);
  await tick();
  const second = e.open("late", ["b"]);
  const third = e.open("late", ["c"]);
  gate.resolve();
  await Promise.all([opening, second, third]);
  expect(calls).toBe(2);
});

it("restores the mute after a crash mid-incident on engine restart", async () => {
  vi.useFakeTimers();
  let stored: Incident[] = [];
  const persist = (i: Incident[]) => (stored = structuredClone(i));
  const crashed = engine(actions(), async () => false, persist);
  crashed.modes.mute = "auto";
  await crashed.open("panic");
  crashed.dispose(); // crash: timers gone, incident still contained
  expect(stored[0].state).not.toBe("closed");
  const adapter = actions();
  const restarted = engine(adapter, async () => false, persist);
  restarted.incidents = stored;
  await vi.advanceTimersByTimeAsync(600100);
  expect(adapter.unmute).toHaveBeenCalledTimes(1);
  expect(restarted.incidents[0].state).toBe("closed");
});

it("restores a mute interrupted before it was recorded", async () => {
  vi.useFakeTimers();
  let stored: Incident[] = [];
  const persist = (i: Incident[]) => (stored = structuredClone(i));
  const adapter = actions();
  adapter.mute = vi.fn(() => new Promise<void>(() => {}));
  const crashed = engine(adapter, async () => false, persist);
  crashed.modes.mute = "auto";
  void crashed.open("panic");
  await vi.advanceTimersByTimeAsync(1);
  crashed.dispose();
  const after = actions();
  const restarted = engine(after, async () => false, persist);
  restarted.incidents = stored;
  await vi.advanceTimersByTimeAsync(600100);
  expect(after.unmute).toHaveBeenCalledTimes(1);
});

it("restores real OBS input mutes through the mock on resolve", async () => {
  const obs = await obsMock();
  const memory = new Map<string, unknown>();
  const store = {
    get: <T>(k: string, d: T) => (memory.has(k) ? (memory.get(k) as T) : d),
    set: (k: string, v: unknown) => void memory.set(k, structuredClone(v)),
  };
  const client = new ObsClient(store as never);
  try {
    await client.connect(obs.url, "");
    const adapter = actions();
    adapter.mute = () => client.muteInputs();
    adapter.unmute = () => client.unmuteInputs();
    const e = engine(adapter);
    e.modes.mute = "auto";
    const results = await Promise.all(
      Array.from({ length: 10 }, () => e.open("panic")),
    );
    expect(obs.mutes).toEqual({ Mic: true, Desktop: true });
    await e.close(results[0].id);
    expect(obs.mutes).toEqual({ Mic: false, Desktop: true });
  } finally {
    await client.disconnect().catch(() => {});
    await obs.close();
  }
});

it("approval timeouts are declined with reason timeout", async () => {
  const e = engine(actions(), async () => "timeout");
  e.modes.blocked = "ask";
  const incident = await e.open("manual", ["t"]);
  for (const action of ["shield", "blocked"])
    expect(incident.actions.find((a) => a.action === action)).toMatchObject({
      status: "declined",
      reason: "timeout",
    });
});

it("retention is reapplied on new incidents and keeps unresolved ones", async () => {
  const e = engine();
  const old = new Date(Date.now() - 40 * 86400000).toISOString();
  const base = {
    trigger: "manual" as const,
    actions: [],
    clips: [],
    attempts: {},
    rehearsal: false,
    started: old,
  };
  e.incidents = [{ ...base, id: 1, state: "closed" }];
  e.retain(30);
  expect(e.incidents).toHaveLength(0);
  e.incidents = [{ ...base, id: 2, state: "closed" }];
  await e.open("manual");
  expect(e.incidents.map((i) => i.id)).toEqual([3]);
  e.retain(0);
  expect(e.incidents.map((i) => i.id)).toEqual([3]);
});
