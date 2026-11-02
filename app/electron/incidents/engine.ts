import type { Clip, Marker } from "../twitch/helix.js";
export type Mode = "auto" | "ask" | "off";
export type Action =
  | "cover"
  | "mute"
  | "guard"
  | "retroactive"
  | "marker"
  | "shield"
  | "blocked"
  | "notice"
  | "discord"
  | "clips";
/** An approval prompt answers yes, no, or expires unanswered. */
export type Answer = boolean | "timeout";
interface ActionResult {
  /** "unmute" records the restore of a panic mute when the incident closes. */
  action: Action | "unmute";
  time: string;
  status: "success" | "error" | "declined" | "off";
  duration_ms: number;
  /** "timeout" when an Ask prompt expired without an answer. */
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
  /** Set before a mute is sent, so a crash mid-mute still restores audio. */
  muteRequested?: boolean;
}
export interface IncidentActions {
  cover(): Promise<void>;
  mute(): Promise<void>;
  unmute(): Promise<void>;
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
  mute: "off",
  guard: "auto",
  retroactive: "auto",
  marker: "auto",
  shield: "ask",
  blocked: "off",
  notice: "off",
  discord: "off",
  clips: "auto",
};
/** Local OBS actions that only a panic performs. */
const PANIC_ONLY: Action[] = ["cover", "mute"];
const AUTOMATIC: Action[] = [
  "cover",
  "mute",
  "guard",
  "retroactive",
  "marker",
  "shield",
  "blocked",
  "notice",
  "discord",
];
/** Re-reads state after an await, where TS would keep a stale narrowing. */
const resolved = (incident: Incident): boolean => incident.state === "closed";
const reason = (error: unknown): string =>
  typeof error === "object" && error !== null && "status" in error
    ? `HTTP ${String(error.status)}`
    : "Action unavailable; check connection and permissions";

/** Persist metadata after each action; secret strings are never in an incident. */
export class IncidentEngine {
  private list: Incident[] = [];
  modes = { ...DEFAULT_MODES };
  private timers = new Set<ReturnType<typeof setTimeout>>();
  /** One auto-close timer per incident, however many triggers arrive. */
  private closeTimers = new Map<number, ReturnType<typeof setTimeout>>();
  /** In-flight OBS calls are shared so concurrent panics never race. */
  private inflight = new Map<Action, Promise<void>>();
  private rescan?: Promise<void>;
  private rescanPending = false;
  private retentionDays?: number;
  private restoring = new Set<number>();
  private lastRelated = 0;
  constructor(
    private readonly actions: IncidentActions,
    private readonly ask: (action: Action) => Promise<Answer>,
    private readonly persist: (incidents: Incident[]) => void,
    private readonly changed: () => void,
    readonly rehearsal = false,
  ) {}
  get incidents(): Incident[] {
    return this.list;
  }
  /**
   * Incidents loaded after a restart (or carried over from a previous engine)
   * get their auto-close rescheduled, so a panic mute is always restored.
   */
  set incidents(value: Incident[]) {
    this.list = value;
    for (const incident of value) {
      if (incident.state === "closed") continue;
      const times = [incident.started, ...incident.actions.map((a) => a.time)]
        .map(Date.parse)
        .filter(Number.isFinite);
      this.lastRelated = Math.max(this.lastRelated, ...times);
      this.scheduleClose(incident);
    }
  }
  private save(): void {
    this.persist(this.incidents);
    this.changed();
  }
  private record(
    incident: Incident,
    action: ActionResult["action"],
    status: ActionResult["status"],
    start: number,
    why?: string,
  ): void {
    incident.actions.push({
      action,
      time: new Date().toISOString(),
      status,
      duration_ms: status === "off" ? 0 : performance.now() - start,
      ...(why ? { reason: why } : {}),
    });
    this.save();
  }
  private async invoke(
    incident: Incident,
    action: Action,
    terms: string[],
  ): Promise<void> {
    if (action === "cover")
      await this.shared("cover", () => this.actions.cover());
    else if (action === "mute") {
      incident.muteRequested = true;
      this.save();
      await this.shared("mute", () => this.actions.mute());
    } else if (action === "guard") await this.actions.guard(terms);
    else if (action === "retroactive") await this.retroactive();
    else if (action === "marker")
      incident.marker = await this.actions.marker(incident.id);
    else if (action === "shield") await this.actions.shield();
    else if (action === "blocked") await this.actions.blocked(terms);
    else if (action === "notice") await this.actions.notice();
    else if (action === "discord") await this.actions.discord(incident);
  }
  /** Join an identical call that is already running instead of racing it. */
  private shared(action: Action, call: () => Promise<void>): Promise<void> {
    const running = this.inflight.get(action);
    if (running) return running;
    const next = call().finally(() => this.inflight.delete(action));
    this.inflight.set(action, next);
    return next;
  }
  /**
   * Scans never nest. A request during a scan queues exactly one follow-up
   * scan (so newly added terms are covered); further requests coalesce.
   */
  private retroactive(): Promise<void> {
    if (this.rescan) {
      this.rescanPending = true;
      return this.rescan;
    }
    // Passes repeat only for requests from outside the scan: a scan itself
    // never opens incidents or fires spikes, so this cannot loop.
    const scan = async () => {
      try {
        do {
          this.rescanPending = false;
          await this.actions.retroactive().catch((error: unknown) => {
            if (!this.rescanPending) throw error;
          });
        } while (this.rescanPending);
      } finally {
        this.rescan = undefined;
      }
    };
    this.rescan = scan();
    return this.rescan;
  }
  private async run(
    incident: Incident,
    action: Action,
    terms: string[],
  ): Promise<void> {
    const mode = this.modes[action] ?? DEFAULT_MODES[action],
      start = performance.now();
    if (mode === "off") return this.record(incident, action, "off", start);
    if (incident.state === "closed")
      return this.record(incident, action, "declined", start, "resolved");
    if (mode === "ask") {
      const answer = await this.ask(action);
      if (resolved(incident))
        return this.record(incident, action, "declined", start, "resolved");
      if (answer !== true)
        return this.record(
          incident,
          action,
          "declined",
          start,
          answer === "timeout" ? "timeout" : undefined,
        );
    }
    try {
      await this.invoke(incident, action, terms);
      this.record(incident, action, "success", start);
      // Resolved while the mute was in flight: restore it now.
      if (action === "mute" && resolved(incident))
        await this.restoreAudio(incident);
    } catch (error) {
      this.record(incident, action, "error", start, reason(error));
    }
  }
  async open(
    trigger: Incident["trigger"],
    terms: string[] = [],
  ): Promise<Incident> {
    const active = this.incidents.find((i) => i.state !== "closed");
    this.lastRelated = Date.now();
    if (active) {
      if (trigger === "panic")
        for (const action of PANIC_ONLY)
          if (this.modes[action] !== "off")
            await this.run(active, action, terms);
      if (terms.length && this.modes.guard !== "off")
        await this.run(active, "guard", terms);
      // Retroactive deletion already ran for this incident. Re-scan only for
      // newly supplied terms, and never from a spike, so a scan can't loop.
      if (
        terms.length &&
        trigger !== "spike" &&
        this.modes.retroactive === "auto"
      )
        await this.run(active, "retroactive", terms);
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
    this.list.unshift(incident);
    if (this.retentionDays !== undefined) this.retain(this.retentionDays);
    this.save();
    const applicable = AUTOMATIC.filter(
      (a) => trigger === "panic" || !PANIC_ONLY.includes(a),
    );
    for (const action of applicable.filter((a) => this.modes[a] !== "ask"))
      await this.run(incident, action, terms);
    // A resolve during the automatic actions must never be reverted.
    if (incident.state === "open") {
      incident.state = "contained";
      this.save();
    }
    for (const action of applicable.filter((a) => this.modes[a] === "ask"))
      await this.run(incident, action, terms);
    this.scheduleClose(incident);
    return incident;
  }
  private scheduleClose(incident: Incident): void {
    if (incident.state === "closed") return;
    clearTimeout(this.closeTimers.get(incident.id));
    const timer = setTimeout(
      () => {
        this.closeTimers.delete(incident.id);
        if (incident.state !== "closed") {
          if (Date.now() - this.lastRelated >= 600000)
            void this.close(incident.id);
          else this.scheduleClose(incident);
        }
      },
      Math.max(10, 600000 - (Date.now() - this.lastRelated)) + 10,
    );
    timer.unref?.();
    this.closeTimers.set(incident.id, timer);
  }
  attempt(user: string): void {
    const i = this.incidents.find((v) => v.state !== "closed");
    if (i) {
      i.attempts[user] = (i.attempts[user] ?? 0) + 1;
      this.lastRelated = Date.now();
      this.save();
    }
  }
  /** Drop incidents that started before the retention window. */
  retain(days: number, now = Date.now()): void {
    if (!Number.isFinite(days) || days <= 0) return;
    this.retentionDays = days;
    // Unresolved incidents are kept: closing them restores a panic mute.
    const cutoff = now - days * 86400000,
      kept = this.list.filter(
        (i) => i.state !== "closed" || Date.parse(i.started) >= cutoff,
      );
    if (kept.length === this.list.length) return;
    this.list = kept;
    this.save();
  }
  async close(id: number): Promise<void> {
    const incident = this.incidents.find((i) => i.id === id);
    if (!incident || incident.state === "closed") return;
    incident.state = "closed";
    incident.ended = new Date().toISOString();
    clearTimeout(this.closeTimers.get(id));
    this.closeTimers.delete(id);
    this.save();
    // A mute still in flight finishes first, so its restore isn't overtaken.
    await this.inflight.get("mute")?.catch(() => {});
    await this.restoreAudio(incident);
    if (this.modes.clips !== "off") {
      const timer = setTimeout(() => {
        this.timers.delete(timer);
        void this.collectClips(incident);
      }, 120000);
      timer.unref?.();
      this.timers.add(timer);
    }
  }
  private async restoreAudio(incident: Incident): Promise<void> {
    const muted =
      incident.muteRequested ||
      incident.actions.some(
        (a) => a.action === "mute" && a.status === "success",
      );
    if (
      !muted ||
      this.restoring.has(incident.id) ||
      incident.actions.some((a) => a.action === "unmute")
    )
      return;
    this.restoring.add(incident.id);
    const start = performance.now();
    try {
      await this.actions.unmute();
      this.record(incident, "unmute", "success", start);
    } catch (error) {
      this.record(incident, "unmute", "error", start, reason(error));
    } finally {
      this.restoring.delete(incident.id);
    }
  }
  async collectClips(incident: Incident): Promise<void> {
    const start = performance.now();
    if (this.modes.clips === "ask") {
      const answer = await this.ask("clips");
      if (answer !== true) {
        if (answer === "timeout")
          this.record(incident, "clips", "declined", start, "timeout");
        return;
      }
    }
    try {
      incident.clips = await this.actions.clips(
        incident.started,
        incident.ended ?? new Date().toISOString(),
      );
      this.record(incident, "clips", "success", start);
    } catch {
      this.record(
        incident,
        "clips",
        "error",
        start,
        "Clip listing unavailable",
      );
    }
  }
  dispose(): void {
    for (const timer of this.timers) clearTimeout(timer);
    for (const timer of this.closeTimers.values()) clearTimeout(timer);
    this.timers.clear();
    this.closeTimers.clear();
  }
}
