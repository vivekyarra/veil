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
  run: () => Promise<unknown>;
  resolve: (value: unknown) => void;
  reject: (error: unknown) => void;
}
export class HelixError extends Error {
  constructor(readonly status: number) {
    super(`Twitch action failed (${status})`);
  }
}
type LaneName = "delete" | "moderation" | "eventsub" | "default";
/** Each lane has its own queue and rate-limit state. */
class Lane {
  constructor(
    readonly rank: number,
    readonly background = false,
  ) {}
  queue: Job[] = [];
  running = false;
  reset = 0;
  remaining = 1;
}
const laneFor = (priority: number): LaneName =>
  priority <= 0
    ? "delete"
    : priority === 1
      ? "moderation"
      : priority === 2
        ? "eventsub"
        : "default";

/**
 * Separate lanes keep a 429 on one endpoint from blocking message deletes.
 * Request content is never logged.
 */
export class Helix {
  private lanes: Record<LaneName, Lane> = {
    delete: new Lane(0),
    moderation: new Lane(1),
    eventsub: new Lane(2, true),
    default: new Lane(3, true),
  };
  private globalReset = 0;
  static QUEUE_CAP = 2000;
  static DELETE_CAP = 50000;
  /** Channel being protected; equals userId unless moderating elsewhere. */
  broadcasterId: string;
  broadcasterLogin = "";
  constructor(
    private readonly auth: Pick<TwitchAuth, "access" | "clientId"> &
      Partial<Pick<TwitchAuth, "refresh">>,
    /** The token user; acts as moderator_id and sender_id. */
    readonly userId: string,
    private readonly origin = "https://api.twitch.tv/helix",
    private readonly transport: typeof fetch = fetch,
  ) {
    this.broadcasterId = userId;
  }
  request<T>(
    method: string,
    path: string,
    body?: unknown,
    priority = 10,
  ): Promise<T> {
    const lane = this.lanes[laneFor(priority)];
    if (!this.admit(lane))
      return Promise.reject(new Error("Twitch action queue capacity reached"));
    return new Promise<T>((resolve, reject) => {
      lane.queue.push({
        run: () => this.perform<T>(lane, method, path, body),
        resolve: (value) => resolve(value as T),
        reject,
      });
      void this.drain(lane);
    });
  }
  /**
   * Bounded while offline: past the cap, the oldest job of the lowest-priority
   * non-delete lane is dropped. Deletes are never dropped; they have their own
   * hard cap so memory stays bounded.
   */
  private admit(lane: Lane): boolean {
    const lanes = Object.values(this.lanes);
    if (lane.rank === 0) return lane.queue.length < Helix.DELETE_CAP;
    const queued = lanes
      .filter((l) => l.rank !== 0)
      .reduce((n, l) => n + l.queue.length, 0);
    if (queued < Helix.QUEUE_CAP) return true;
    const victim = lanes
      .filter((l) => l.rank >= lane.rank && l.rank !== 0 && l.queue.length)
      .sort((a, b) => b.rank - a.rank)[0];
    if (!victim) return false;
    victim.queue
      .shift()!
      .reject(new Error("Dropped: Twitch action queue is full"));
    return true;
  }
  private async drain(lane: Lane): Promise<void> {
    if (lane.running) return;
    lane.running = true;
    while (lane.queue.length) {
      const job = lane.queue.shift()!;
      try {
        job.resolve(await job.run());
      } catch (error) {
        job.reject(error);
      }
    }
    lane.running = false;
  }
  private async perform<T>(
    lane: Lane,
    method: string,
    path: string,
    body?: unknown,
  ): Promise<T> {
    if (!path.startsWith("/") || path.startsWith("//"))
      throw new Error("Invalid Helix path");
    let refreshed = false;
    for (let attempt = 0; attempt < 5; attempt++) {
      const holdUntil = Math.max(
        lane.remaining === 0 ? lane.reset : 0,
        lane.background ? this.globalReset : 0,
      );
      if (holdUntil > Date.now())
        await new Promise((r) =>
          setTimeout(r, Math.min(holdUntil - Date.now(), 60000)),
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
      // Garbage or absent headers must not disable backoff (NaN delays are 0).
      const left = remaining === null ? NaN : Number(remaining);
      if (Number.isFinite(left)) lane.remaining = left;
      const until = reset === null ? NaN : Number(reset) * 1000;
      if (Number.isFinite(until))
        lane.reset = Math.min(until, Date.now() + 60000);
      if (response.status === 401 && !refreshed && this.auth.refresh) {
        refreshed = true;
        await this.auth.refresh(token);
        continue;
      }
      if (response.status === 429 || response.status >= 500) {
        if (response.status === 429) {
          lane.remaining = 0;
          // The bucket is per token: background lanes also hold off.
          this.globalReset = Math.max(this.globalReset, lane.reset);
        }
        await new Promise((r) =>
          setTimeout(
            r,
            Math.max(
              100 * 2 ** attempt,
              response.status === 429
                ? Math.min(60000, Math.max(0, lane.reset - Date.now()))
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
      broadcaster_id: this.broadcasterId,
      moderator_id: this.userId,
      ...extra,
    }).toString();
  }
  /**
   * Protect another channel as its moderator. An empty login (or your own)
   * protects your channel. Fails clearly when you are not a moderator.
   */
  async useChannel(raw: string, selfLogin: string): Promise<void> {
    const login = raw
      .trim()
      .replace(/^@/, "")
      .replace(/^https?:\/\/(www\.)?twitch\.tv\//i, "")
      .replace(/\/+$/, "")
      .toLowerCase();
    if (!login || login === selfLogin.toLowerCase()) {
      this.broadcasterId = this.userId;
      this.broadcasterLogin = selfLogin;
      return;
    }
    if (!/^[a-z0-9_]{1,25}$/.test(login))
      throw new Error(`"${raw}" is not a valid Twitch channel name`);
    const users = await this.request<Envelope<{ id: string; login: string }>>(
      "GET",
      "/users?" + new URLSearchParams({ login }),
    );
    const user = users.data[0];
    if (!user) throw new Error(`Twitch channel "${login}" was not found`);
    try {
      await this.request(
        "GET",
        "/moderation/blocked_terms?" +
          new URLSearchParams({
            broadcaster_id: user.id,
            moderator_id: this.userId,
            first: "1",
          }),
      );
    } catch (error) {
      // 403: moderator_id is not one of the broadcaster's moderators.
      if (
        error instanceof HelixError &&
        (error.status === 403 || error.status === 401)
      )
        throw new Error(
          `You are not a moderator of ${login}; ask the broadcaster to mod you`,
        );
      throw error;
    }
    this.broadcasterId = user.id;
    this.broadcasterLogin = user.login;
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
      user_id: this.broadcasterId,
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
      broadcaster_id: this.broadcasterId,
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
        broadcaster_id: this.broadcasterId,
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
        new URLSearchParams({ user_id: this.broadcasterId, type: "archive" }),
    );
  }
  stream(): Promise<
    Envelope<{ id: string; started_at: string; game_id: string }>
  > {
    return this.request(
      "GET",
      "/streams?" + new URLSearchParams({ user_id: this.broadcasterId }),
    );
  }
}
