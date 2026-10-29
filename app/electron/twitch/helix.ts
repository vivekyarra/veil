import type { TwitchAuth } from "./auth.js";
export interface Clip {
  id: string;
  url: string;
  created_at: string;
  creator_name: string;
  thumbnail_url: string;
  vod_offset: number | null;
  video_id: string;
}
export interface Marker {
  id: string;
  created_at: string;
  position_seconds: number;
  description: string;
}
interface Envelope<T> {
  data: T[];
  pagination?: { cursor?: string };
}
interface Job {
  priority: number;
  run: () => Promise<unknown>;
  resolve: (value: unknown) => void;
  reject: (error: unknown) => void;
}
class HelixError extends Error {
  constructor(readonly status: number) {
    super(`Twitch action failed (${status})`);
  }
}

/** A bounded queue prioritizes deletion and never logs request content. */
export class Helix {
  private queue: Job[] = [];
  private running = false;
  private reset = 0;
  private remaining = 1;
  constructor(
    private readonly auth: Pick<TwitchAuth, "access" | "clientId">,
    readonly userId: string,
    private readonly origin = "https://api.twitch.tv/helix",
    private readonly transport: typeof fetch = fetch,
  ) {}
  request<T>(
    method: string,
    path: string,
    body?: unknown,
    priority = 10,
  ): Promise<T> {
    if (this.queue.length >= 50000)
      return Promise.reject(new Error("Twitch action queue capacity reached"));
    return new Promise<T>((resolve, reject) => {
      this.queue.push({
        priority,
        run: () => this.perform<T>(method, path, body),
        resolve: (value) => resolve(value as T),
        reject,
      });
      this.queue.sort((a, b) => a.priority - b.priority);
      void this.drain();
    });
  }
  private async drain(): Promise<void> {
    if (this.running) return;
    this.running = true;
    while (this.queue.length) {
      const job = this.queue.shift()!;
      try {
        job.resolve(await job.run());
      } catch (error) {
        job.reject(error);
      }
    }
    this.running = false;
  }
  private async perform<T>(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<T> {
    if (!path.startsWith("/") || path.startsWith("//"))
      throw new Error("Invalid Helix path");
    for (let attempt = 0; attempt < 5; attempt++) {
      if (this.remaining === 0 && this.reset > Date.now())
        await new Promise((r) =>
          setTimeout(r, Math.min(this.reset - Date.now(), 60000)),
        );
      const token = await this.auth.access();
      const response = await this.transport(this.origin + path, {
        method,
        headers: {
          Authorization: "Bearer " + token,
          "Client-Id": this.auth.clientId,
          ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(15000),
      });
      const remaining = response.headers.get("Ratelimit-Remaining"),
        reset = response.headers.get("Ratelimit-Reset");
      if (remaining !== null) this.remaining = Number(remaining);
      if (reset !== null) this.reset = Number(reset) * 1000;
      if (response.status === 429 || response.status >= 500) {
        await new Promise((r) =>
          setTimeout(
            r,
            Math.max(
              100 * 2 ** attempt,
              response.status === 429
                ? Math.min(60000, Math.max(0, this.reset - Date.now()))
                : 0,
            ),
          ),
        );
        continue;
      }
      if (!response.ok) throw new HelixError(response.status);
      if (response.status === 204) return undefined as T;
      return (await response.json()) as T;
    }
    throw new Error("Twitch retry budget exhausted");
  }
  private query(extra: Record<string, string> = {}): string {
    return new URLSearchParams({
      broadcaster_id: this.userId,
      moderator_id: this.userId,
      ...extra,
    }).toString();
  }
  deleteMessage(id: string): Promise<void> {
    if (!id)
      throw new Error("Message ID required; clearing all chat is disallowed");
    return this.request(
      "DELETE",
      "/moderation/chat?" + this.query({ message_id: id }),
      undefined,
      0,
    );
  }
  timeout(id: string): Promise<void> {
    return this.request(
      "POST",
      "/moderation/bans?" + this.query(),
      {
        data: {
          user_id: id,
          duration: 600,
          reason: "Posting private information",
        },
      },
      1,
    );
  }
  shield(active: boolean): Promise<unknown> {
    return this.request("PUT", "/moderation/shield_mode?" + this.query(), {
      is_active: active,
    });
  }
  marker(number: number): Promise<Envelope<Marker>> {
    return this.request("POST", "/streams/markers", {
      user_id: this.userId,
      description: `VEIL incident #${number}`,
    });
  }
  blockedTerm(text: string): Promise<Envelope<{ id: string; text: string }>> {
    if (text.length < 2 || text.length > 500)
      throw new Error("Blocked terms must contain 2–500 characters");
    return this.request("POST", "/moderation/blocked_terms?" + this.query(), {
      text,
    });
  }
  removeBlockedTerm(id: string): Promise<void> {
    return this.request(
      "DELETE",
      "/moderation/blocked_terms?" + this.query({ id }),
    );
  }
  notice(): Promise<unknown> {
    return this.request("POST", "/chat/messages", {
      broadcaster_id: this.userId,
      sender_id: this.userId,
      message:
        "Mods: a VEIL privacy incident is open. Please avoid repeating private information.",
    });
  }
  async clips(start: string, end: string): Promise<Clip[]> {
    const clips: Clip[] = [];
    let cursor = "";
    do {
      const query = new URLSearchParams({
        broadcaster_id: this.userId,
        started_at: start,
        ended_at: end,
        first: "100",
        ...(cursor ? { after: cursor } : {}),
      });
      const page = await this.request<Envelope<Clip>>("GET", "/clips?" + query);
      clips.push(...page.data);
      cursor = page.pagination?.cursor ?? "";
    } while (cursor && clips.length < 10000);
    if (cursor)
      throw new Error(
        "Clip listing exceeded the local limit; review Creator Dashboard",
      );
    return clips;
  }
  videos(): Promise<
    Envelope<{ id: string; url: string; created_at: string; duration: string }>
  > {
    return this.request(
      "GET",
      "/videos?" +
        new URLSearchParams({ user_id: this.userId, type: "archive" }),
    );
  }
  stream(): Promise<
    Envelope<{ id: string; started_at: string; game_id: string }>
  > {
    return this.request(
      "GET",
      "/streams?" + new URLSearchParams({ user_id: this.userId }),
    );
  }
}
