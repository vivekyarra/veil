import type { Clip, Marker } from "../twitch/helix.js";
export type Mode = "auto" | "ask" | "off";
export type Action =
  | "cover"
  | "guard"
  | "retroactive"
  | "marker"
  | "shield"
  | "blocked"
  | "notice"
  | "discord"
  | "clips";
interface ActionResult {
  action: Action;
  time: string;
  status: "success" | "error" | "declined" | "off";
  duration_ms: number;
  reason?: string;
}
export interface Incident {
  id: number;
  trigger: "panic" | "manual" | "late" | "spike";
  state: "open" | "contained" | "closed";
  started: string;
  ended?: string;
  actions: ActionResult[];
  clips: Clip[];
  marker?: Marker;
  attempts: Record<string, number>;
  rehearsal: boolean;
}
export interface IncidentActions {
  cover(): Promise<void>;
  guard(terms: string[]): Promise<void>;
  retroactive(): Promise<void>;
  marker(id: number): Promise<Marker | undefined>;
  shield(): Promise<void>;
  blocked(terms: string[]): Promise<void>;
  notice(): Promise<void>;
  discord(incident: Incident): Promise<void>;
  clips(start: string, end: string): Promise<Clip[]>;
}
export const DEFAULT_MODES: Record<Action, Mode> = {
  cover: "auto",
  guard: "auto",
  retroactive: "auto",
  marker: "auto",
  shield: "ask",
  blocked: "off",
  notice: "off",
  discord: "off",
  clips: "auto",
};

/** Persist metadata after each action; secret strings are never in an incident. */
export class IncidentEngine {
  incidents: Incident[] = [];
  modes = { ...DEFAULT_MODES };
  private timers = new Set<ReturnType<typeof setTimeout>>();
  private lastRelated = 0;
  constructor(
    private readonly actions: IncidentActions,
    private readonly ask: (action: Action) => Promise<boolean>,
    private readonly persist: (incidents: Incident[]) => void,
    private readonly changed: () => void,
    readonly rehearsal = false,
  ) {}
  private save(): void {
    this.persist(this.incidents);
    this.changed();
  }
  async open(
    trigger: Incident["trigger"],
    terms: string[] = [],
  ): Promise<Incident> {
    const active = this.incidents.find((i) => i.state !== "closed");
    this.lastRelated = Date.now();
    if (active) {
      if (trigger === "panic" && this.modes.cover !== "off") {
        const started = performance.now();
        let status: ActionResult["status"] = "declined";
        if (this.modes.cover === "auto" || (await this.ask("cover")))
          try {
            await this.actions.cover();
            status = "success";
          } catch {
            status = "error";
          }
        active.actions.push({
          action: "cover",
          time: new Date().toISOString(),
          status,
          duration_ms: performance.now() - started,
        });
      }
      if (
        this.modes.guard === "auto" ||
        (this.modes.guard === "ask" && (await this.ask("guard")))
      ) {
        try {
          await this.actions.guard(terms);
        } catch {
          active.actions.push({
            action: "guard",
            time: new Date().toISOString(),
            status: "error",
            duration_ms: 0,
            reason: "Private guard unavailable",
          });
        }
      }
      if (this.modes.retroactive === "auto")
        try {
          await this.actions.retroactive();
        } catch {
          active.actions.push({
            action: "retroactive",
            time: new Date().toISOString(),
            status: "error",
            duration_ms: 0,
            reason: "Retroactive deletion unavailable",
          });
        }
      this.save();
      this.scheduleClose(active);
      return active;
    }
    const incident: Incident = {
      id: Math.max(0, ...this.incidents.map((i) => i.id)) + 1,
      trigger,
      state: "open",
      started: new Date().toISOString(),
      actions: [],
      clips: [],
      attempts: {},
      rehearsal: this.rehearsal,
    };
    this.incidents.unshift(incident);
    this.save();
    const automatic: Action[] = [
      "cover",
      "guard",
      "retroactive",
      "marker",
      "shield",
      "blocked",
      "notice",
      "discord",
    ];
    const run = async (action: Action): Promise<void> => {
      if (action === "cover" && trigger !== "panic") return;
      const mode = this.modes[action],
        start = performance.now();
      if (mode === "off") {
        incident.actions.push({
          action,
          time: new Date().toISOString(),
          status: "off",
          duration_ms: 0,
        });
        this.save();
        return;
      }
      if (mode === "ask" && !(await this.ask(action))) {
        incident.actions.push({
          action,
          time: new Date().toISOString(),
          status: "declined",
          duration_ms: performance.now() - start,
        });
        this.save();
        return;
      }
      try {
        if (action === "cover") await this.actions.cover();
        else if (action === "guard") await this.actions.guard(terms);
        else if (action === "retroactive") await this.actions.retroactive();
        else if (action === "marker")
          incident.marker = await this.actions.marker(incident.id);
        else if (action === "shield") await this.actions.shield();
        else if (action === "blocked") await this.actions.blocked(terms);
        else if (action === "notice") await this.actions.notice();
        else if (action === "discord") await this.actions.discord(incident);
        incident.actions.push({
          action,
          time: new Date().toISOString(),
          status: "success",
          duration_ms: performance.now() - start,
        });
      } catch (error) {
        incident.actions.push({
          action,
          time: new Date().toISOString(),
          status: "error",
          duration_ms: performance.now() - start,
          reason:
            typeof error === "object" && error !== null && "status" in error
              ? `HTTP ${String(error.status)}`
              : "Action unavailable; check connection and permissions",
        });
      }
      this.save();
    };
    for (const action of automatic.filter((a) => this.modes[a] !== "ask"))
      await run(action);
    incident.state = "contained";
    this.save();
    for (const action of automatic.filter((a) => this.modes[a] === "ask"))
      await run(action);
    this.scheduleClose(incident);
    return incident;
  }
  private scheduleClose(incident: Incident): void {
    const timer = setTimeout(
      () => {
        this.timers.delete(timer);
        if (incident.state !== "closed") {
          if (Date.now() - this.lastRelated >= 600000) this.close(incident.id);
          else this.scheduleClose(incident);
        }
      },
      Math.max(10, 600000 - (Date.now() - this.lastRelated)) + 10,
    );
    timer.unref?.();
    this.timers.add(timer);
  }
  attempt(user: string): void {
    const i = this.incidents.find((v) => v.state !== "closed");
    if (i) {
      i.attempts[user] = (i.attempts[user] ?? 0) + 1;
      this.lastRelated = Date.now();
      this.save();
    }
  }
  close(id: number): void {
    const incident = this.incidents.find((i) => i.id === id);
    if (!incident || incident.state === "closed") return;
    incident.state = "closed";
    incident.ended = new Date().toISOString();
    this.save();
    if (this.modes.clips !== "off") {
      const timer = setTimeout(() => {
        this.timers.delete(timer);
        void this.collectClips(incident);
      }, 120000);
      timer.unref?.();
      this.timers.add(timer);
    }
  }
  async collectClips(incident: Incident): Promise<void> {
    const start = performance.now();
    if (this.modes.clips === "ask" && !(await this.ask("clips"))) return;
    try {
      incident.clips = await this.actions.clips(
        incident.started,
        incident.ended ?? new Date().toISOString(),
      );
      incident.actions.push({
        action: "clips",
        time: new Date().toISOString(),
        status: "success",
        duration_ms: performance.now() - start,
      });
    } catch {
      incident.actions.push({
        action: "clips",
        time: new Date().toISOString(),
        status: "error",
        duration_ms: performance.now() - start,
        reason: "Clip listing unavailable",
      });
    }
    this.save();
  }
  dispose(): void {
    for (const timer of this.timers) clearTimeout(timer);
    this.timers.clear();
  }
}
