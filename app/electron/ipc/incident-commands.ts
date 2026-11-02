import type { Incident, IncidentEngine } from "../incidents/engine.js";
import { number, text, type Commands } from "./dispatch.js";

interface IncidentContext {
  /** The engine for the current mode (rehearsal or connected). */
  engine(): IncidentEngine | undefined;
  panic(trigger: Incident["trigger"], terms: string[]): Promise<void>;
  /** Answer a pending approval prompt. */
  answer(id: string, yes: boolean): void;
  setRehearsal(enabled: boolean): void;
  completeOnboarding(): void;
  simulateChat(): Promise<void>;
}

export function incidentCommands(ctx: IncidentContext): Commands {
  const find = (id: unknown) =>
    ctx.engine()?.incidents.find((i) => i.id === id);
  return {
    panic: () => ctx.panic("panic", []),
    "incident-open": (data) =>
      ctx.panic(
        "manual",
        typeof data.text === "string" && data.text ? [text(data.text)] : [],
      ),
    "incident-close": async (data) => {
      await ctx.engine()?.close(number(data.id, 1, 1000000));
    },
    "incident-clips": async (data) => {
      const incident = find(number(data.id, 1, 1000000));
      if (incident) await ctx.engine()?.collectClips(incident);
    },
    ask: (data) => ctx.answer(text(data.id, 50), data.yes === true),
    rehearsal: (data) => ctx.setRehearsal(data.enabled === true),
    "onboarding-complete": () => ctx.completeOnboarding(),
    "simulate-chat": () => ctx.simulateChat(),
  };
}
