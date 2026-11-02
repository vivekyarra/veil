import { it, expect, vi } from "vitest";
import {
  IncidentEngine,
  type IncidentActions,
} from "../electron/incidents/engine";

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

it("panic covers an existing incident and honors guard Off", async () => {
  const adapter = actions();
  const engine = new IncidentEngine(
    adapter,
    async () => false,
    () => {},
    () => {},
  );
  engine.modes.guard = "off";
  try {
    const incident = await engine.open("late");
    expect(adapter.cover).not.toHaveBeenCalled();
    const repeat = await engine.open("panic", ["synthetic term"]);
    expect(repeat.id).toBe(incident.id);
    expect(adapter.cover).toHaveBeenCalledTimes(1);
    expect(adapter.guard).not.toHaveBeenCalled();
    expect(repeat.actions.at(-1)?.status).toBe("success");
  } finally {
    engine.dispose();
  }
});

it("related attempts postpone auto-close and it eventually closes", async () => {
  vi.useFakeTimers();
  const engine = new IncidentEngine(
    actions(),
    async () => false,
    () => {},
    () => {},
  );
  try {
    const incident = await engine.open("manual");
    await vi.advanceTimersByTimeAsync(500000);
    engine.attempt("synthetic-viewer");
    await vi.advanceTimersByTimeAsync(100020);
    expect(incident.state).toBe("contained");
    await vi.advanceTimersByTimeAsync(500020);
    expect(incident.state).toBe("closed");
  } finally {
    engine.dispose();
    vi.useRealTimers();
  }
});

it("does not re-run retroactive for a spike while an incident is open", async () => {
  const adapter = actions();
  const engine = new IncidentEngine(
    adapter,
    async () => false,
    () => {},
    () => {},
  );
  try {
    await engine.open("spike");
    await engine.open("spike");
    await engine.open("spike", ["new term"]);
    expect(adapter.retroactive).toHaveBeenCalledTimes(1);
    await engine.open("manual", ["new term"]);
    expect(adapter.retroactive).toHaveBeenCalledTimes(2);
  } finally {
    engine.dispose();
  }
});

it("panic mutes audio when enabled and restores it when the incident closes", async () => {
  const adapter = actions();
  const engine = new IncidentEngine(
    adapter,
    async () => false,
    () => {},
    () => {},
  );
  engine.modes.mute = "auto";
  try {
    const incident = await engine.open("panic");
    expect(adapter.mute).toHaveBeenCalledTimes(1);
    await engine.open("panic");
    expect(adapter.mute).toHaveBeenCalledTimes(2);
    await engine.close(incident.id);
    expect(adapter.unmute).toHaveBeenCalledTimes(1);
    expect(incident.actions.at(-1)).toMatchObject({
      action: "unmute",
      status: "success",
    });
    await engine.close(incident.id);
    expect(adapter.unmute).toHaveBeenCalledTimes(1);
    const late = await engine.open("late");
    expect(late.actions.some((a) => a.action === "mute")).toBe(false);
  } finally {
    engine.dispose();
  }
});

it("records unmute failures and unknown action errors", async () => {
  const adapter = actions();
  adapter.unmute = vi.fn(async () => {
    throw Object.assign(new Error("gone"), { status: 503 });
  });
  adapter.marker = vi.fn(async () => {
    throw new Error("offline");
  });
  const engine = new IncidentEngine(
    adapter,
    async () => true,
    () => {},
    () => {},
  );
  engine.modes.mute = "ask";
  try {
    const incident = await engine.open("panic");
    expect(incident.actions.find((a) => a.action === "marker")?.reason).toBe(
      "Action unavailable; check connection and permissions",
    );
    expect(incident.actions.find((a) => a.action === "mute")?.status).toBe(
      "success",
    );
    await engine.close(incident.id);
    expect(incident.actions.at(-1)).toMatchObject({
      action: "unmute",
      status: "error",
      reason: "HTTP 503",
    });
  } finally {
    engine.dispose();
  }
});

it("logs an expired Shield Mode approval as declined (timeout); auto runs it", async () => {
  const adapter = actions();
  const engine = new IncidentEngine(
    adapter,
    async () => "timeout",
    () => {},
    () => {},
  );
  engine.modes.clips = "ask";
  try {
    const incident = await engine.open("panic");
    expect(incident.actions.find((a) => a.action === "shield")).toMatchObject({
      status: "declined",
      reason: "timeout",
    });
    expect(adapter.shield).not.toHaveBeenCalled();
    await engine.collectClips(incident);
    expect(incident.actions.at(-1)).toMatchObject({
      action: "clips",
      reason: "timeout",
    });
    expect(adapter.clips).not.toHaveBeenCalled();
    await engine.close(incident.id);
    engine.modes.shield = "auto";
    await engine.open("panic");
    expect(adapter.shield).toHaveBeenCalledTimes(1);
  } finally {
    engine.dispose();
  }
});

it("applies incident retention", () => {
  const persisted: unknown[] = [];
  const engine = new IncidentEngine(
    actions(),
    async () => false,
    (value) => persisted.push(value),
    () => {},
  );
  const base = {
    state: "closed" as const,
    trigger: "manual" as const,
    actions: [],
    clips: [],
    attempts: {},
    rehearsal: false,
  };
  engine.incidents = [
    { ...base, id: 2, started: new Date().toISOString() },
    {
      ...base,
      id: 1,
      started: new Date(Date.now() - 40 * 86400000).toISOString(),
    },
  ];
  engine.retain(30);
  expect(engine.incidents.map((i) => i.id)).toEqual([2]);
  engine.retain(30);
  expect(persisted).toHaveLength(1);
});
