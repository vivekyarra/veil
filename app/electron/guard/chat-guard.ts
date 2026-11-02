import {
  compileTerm,
  matchCompiled,
  normalizeMessage,
  type CompiledTerm,
} from "./normalize.js";
import type { ChatMessage } from "../twitch/eventsub.js";
import { ChatRing } from "../twitch/eventsub.js";
interface GuardTerm {
  text: string;
  category: string;
}
interface Compiled {
  category: string;
  term: CompiledTerm;
}
export interface GuardActions {
  deleteMessage(id: string): Promise<void>;
  timeout(id: string): Promise<void>;
}
export interface GuardEvent {
  /** "retroactive" deletions never count as attempts and never fire spikes. */
  kind: "deleted" | "retroactive" | "warning" | "timeout" | "review" | "error";
  user: string;
  category: string;
  duration_ms: number;
}
interface Recent {
  id: string;
  text: string;
  timestamp: number;
}
const WINDOW_MESSAGES = 5;
const WINDOW_MS = 30000;
const MAX_TRACKED = 50000;

/** Only metadata is emitted. The chat ring and terms are memory-only. */
export class ChatGuard {
  readonly ring = new ChatRing();
  private terms: Compiled[] = [];
  private sessionTerms: Compiled[] = [];
  private attempts = new Map<string, number[]>();
  private spike = new Map<string, number>();
  private recent = new Map<string, Recent[]>();
  private deleted = new Set<string>();
  private scanning = false;
  removed = 0;
  repeatOffender = true;
  constructor(
    private readonly actions: GuardActions,
    private readonly emit: (event: GuardEvent) => void,
    private readonly onSpike: () => void,
  ) {}
  /** Terms are normalized once here, not on every message. */
  setTerms(terms: GuardTerm[]): void {
    this.terms = terms.map((t) => ({
      category: t.category,
      term: compileTerm(t.text),
    }));
  }
  addSessionTerms(terms: string[]): void {
    this.sessionTerms.push(
      ...terms
        .filter(Boolean)
        .map((text) => ({ category: "incident", term: compileTerm(text) })),
    );
  }
  clearSession(): void {
    this.sessionTerms = [];
    this.attempts.clear();
    this.spike.clear();
    this.recent.clear();
    this.ring.clear();
  }
  private find(text: string): Compiled | undefined {
    const normalized = normalizeMessage(text);
    for (const list of [this.terms, this.sessionTerms])
      for (const entry of list)
        if (matchCompiled(entry.term, normalized)) return entry;
    return undefined;
  }
  private markDeleted(id: string): void {
    this.deleted.add(id);
    if (this.deleted.size > MAX_TRACKED)
      this.deleted.delete(this.deleted.values().next().value!);
  }
  private label(login: string): string {
    return this.find(login) ? "private-user" : login;
  }
  /** Shortest suffix of this user's recent messages that leaks a term. */
  private splitLeak(
    message: ChatMessage,
  ): { entry: Compiled; earlier: Recent[] } | undefined {
    const history = (this.recent.get(message.userId) ?? []).filter(
      (r) => message.timestamp - r.timestamp <= WINDOW_MS,
    );
    // A space (not a newline) lets digit runs join across messages, so a
    // phone number typed in fragments is still one run.
    const joined = (earlier: Recent[]) =>
      [...earlier.map((r) => r.text), message.text].join(" ");
    // Matching is monotone in prepended text, so one scan of the whole
    // window rules out every suffix for the common, clean message.
    if (!history.length || !this.find(joined(history))) return undefined;
    for (let k = 1; k <= history.length; k++) {
      const earlier = history.slice(-k);
      const entry = this.find(joined(earlier));
      if (entry) return { entry, earlier };
    }
    return undefined;
  }
  private remember(message: ChatMessage): void {
    const history = (this.recent.get(message.userId) ?? []).filter(
      (r) => message.timestamp - r.timestamp <= WINDOW_MS,
    );
    history.push({
      id: message.id,
      text: message.text,
      timestamp: message.timestamp,
    });
    this.recent.delete(message.userId);
    this.recent.set(message.userId, history.slice(-(WINDOW_MESSAGES - 1)));
    if (this.recent.size > MAX_TRACKED)
      this.recent.delete(this.recent.keys().next().value!);
  }
  async receive(message: ChatMessage): Promise<void> {
    const started = performance.now();
    this.ring.add(message);
    let entry = this.find(message.text),
      earlier: Recent[] = [];
    if (!entry) {
      const split = this.splitLeak(message);
      if (split) ({ entry, earlier } = split);
    }
    if (!entry) {
      this.remember(message);
      return;
    }
    const category = entry.category;
    const event = (kind: GuardEvent["kind"]) =>
      this.emit({
        kind,
        user: this.label(message.login),
        category,
        duration_ms: performance.now() - started,
      });
    if (message.privileged) {
      event("warning");
      return;
    }
    // Earlier fragments of a split leak leave the window with this message.
    const fragments = new Set(earlier.map((r) => r.id));
    this.recent.set(
      message.userId,
      (this.recent.get(message.userId) ?? []).filter(
        (r) => !fragments.has(r.id),
      ),
    );
    for (const id of [...fragments, message.id]) {
      if (this.deleted.has(id)) continue;
      try {
        await this.actions.deleteMessage(id);
        this.markDeleted(id);
        this.removed++;
      } catch {
        event("error");
        return;
      }
    }
    event("deleted");
    const now = Date.now();
    const attempts = (this.attempts.get(message.userId) ?? []).filter(
      (t) => now - t < 600000,
    );
    attempts.push(now);
    this.attempts.set(message.userId, attempts);
    if (this.attempts.size > MAX_TRACKED)
      this.attempts.delete(this.attempts.keys().next().value!);
    if (attempts.length === 2 && this.repeatOffender) {
      try {
        await this.actions.timeout(message.userId);
        event("timeout");
      } catch {
        event("error");
      }
    }
    if (attempts.length >= 3) event("review");
    this.spike.set(message.userId, now);
    for (const [id, time] of this.spike)
      if (now - time > 60000) this.spike.delete(id);
    if (this.spike.size >= 3) {
      this.spike.clear();
      this.onSpike();
    }
  }
  /**
   * Remove earlier messages that match current terms. This never counts
   * attempts, never times anyone out, never fires a spike, skips messages
   * already deleted, and cannot nest.
   */
  async retroactive(): Promise<void> {
    if (this.scanning) return;
    this.scanning = true;
    try {
      this.ring.prune();
      for (const message of [...this.ring.messages]) {
        if (message.privileged || this.deleted.has(message.id)) continue;
        const started = performance.now(),
          entry = this.find(message.text);
        if (!entry) continue;
        const event = (kind: GuardEvent["kind"]) =>
          this.emit({
            kind,
            user: this.label(message.login),
            category: entry.category,
            duration_ms: performance.now() - started,
          });
        try {
          await this.actions.deleteMessage(message.id);
          this.markDeleted(message.id);
          this.removed++;
          event("retroactive");
        } catch {
          event("error");
        }
      }
    } finally {
      this.scanning = false;
    }
  }
}
