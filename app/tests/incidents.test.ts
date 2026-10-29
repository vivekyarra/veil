import { it, expect, vi } from "vitest";
import {
  IncidentEngine,
  type IncidentActions,
} from "../electron/incidents/engine";

function actions(): IncidentActions {
  return {
    cover: vi.fn(async () => {}),
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
