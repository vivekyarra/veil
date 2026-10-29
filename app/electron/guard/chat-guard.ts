import { matches } from "./normalize.js";
import type { ChatMessage } from "../twitch/eventsub.js";
import { ChatRing } from "../twitch/eventsub.js";
interface GuardTerm {
  text: string;
  category: string;
}
export interface GuardActions {
  deleteMessage(id: string): Promise<void>;
  timeout(id: string): Promise<void>;
}
export interface GuardEvent {
  kind: "deleted" | "warning" | "timeout" | "review" | "error";
  user: string;
  category: string;
  duration_ms: number;
}

/** Only metadata is emitted. The chat ring and terms are memory-only. */
export class ChatGuard {
  readonly ring = new ChatRing();
  private terms: GuardTerm[] = [];
  private sessionTerms: GuardTerm[] = [];
  private attempts = new Map<string, number[]>();
  private spike = new Map<string, number>();
  removed = 0;
  repeatOffender = true;
  constructor(
    private readonly actions: GuardActions,
    private readonly emit: (event: GuardEvent) => void,
    private readonly onSpike: () => void,
  ) {}
  setTerms(terms: GuardTerm[]): void {
    this.terms = terms;
  }
  addSessionTerms(terms: string[]): void {
    this.sessionTerms.push(
      ...terms.filter(Boolean).map((text) => ({ text, category: "incident" })),
    );
  }
  clearSession(): void {
    this.sessionTerms = [];
    this.attempts.clear();
    this.spike.clear();
    this.ring.clear();
  }
  async receive(message: ChatMessage, retroactive = false): Promise<void> {
    const started = performance.now();
    if (!retroactive) this.ring.add(message);
    const term = [...this.terms, ...this.sessionTerms].find((t) =>
      matches(t.text, message.text),
    );
    if (!term) return;
    const event = (kind: GuardEvent["kind"]) =>
      this.emit({
        kind,
        user: [...this.terms, ...this.sessionTerms].some((t) =>
          matches(t.text, message.login),
        )
          ? "private-user"
          : message.login,
        category: term.category,
        duration_ms: performance.now() - started,
      });
    if (message.privileged) {
      event("warning");
      return;
    }
    try {
      await this.actions.deleteMessage(message.id);
      this.removed++;
      event("deleted");
    } catch {
      event("error");
      return;
    }
    const now = Date.now();
    const attempts = (this.attempts.get(message.userId) ?? []).filter(
      (t) => now - t < 600000,
    );
    attempts.push(now);
    this.attempts.set(message.userId, attempts);
    if (this.attempts.size > 50000)
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
  async retroactive(): Promise<void> {
    this.ring.prune();
    for (const message of this.ring.messages) await this.receive(message, true);
  }
}
