import WebSocket from "ws";
import type { Helix } from "./helix.js";
export interface ChatMessage {
  id: string;
  userId: string;
  login: string;
  text: string;
  timestamp: number;
  privileged: boolean;
}
export class ChatRing {
  messages: ChatMessage[] = [];
  add(message: ChatMessage): void {
    this.messages.push(message);
    this.prune(message.timestamp);
  }
  prune(now = Date.now()): void {
    let expired = 0;
    while (
      expired < this.messages.length &&
      now - this.messages[expired].timestamp > 6 * 3600000
    )
      expired++;
    const remove = Math.max(expired, this.messages.length - 50000);
    if (remove > 0) this.messages.splice(0, remove);
  }
  clear(): void {
    this.messages = [];
  }
}
type Frame = {
  metadata: {
    message_id: string;
    message_type: string;
    message_timestamp: string;
    subscription_type?: string;
  };
  payload: {
    session?: {
      id: string;
      keepalive_timeout_seconds: number;
      reconnect_url?: string;
    };
    event?: Record<string, unknown>;
    subscription?: { type: string; status: string };
  };
};

/** EventSub has no replay. A reconnect handoff reuses subscriptions. */
export class EventSub {
  connected = false;
  private socket: WebSocket | undefined;
  private retired = new Set<WebSocket>();
  private seen = new Set<string>();
  private watchdog: ReturnType<typeof setTimeout> | undefined;
  private retry: ReturnType<typeof setTimeout> | undefined;
  private stopped = true;
  private backoff = 1000;
  private keepalive = 10000;
  constructor(
    private readonly helix: Helix,
    private readonly onChat: (message: ChatMessage) => void,
    private readonly onStatus: (state: string) => void,
    private readonly url = "wss://eventsub.wss.twitch.tv/ws",
  ) {}
  start(): void {
    this.stopped = false;
    this.connect(this.url, false);
  }
  private connect(url: string, handoff: boolean): void {
    const parsed = new URL(url);
    if (
      parsed.protocol !== "wss:" &&
      !(parsed.protocol === "ws:" && parsed.hostname === "127.0.0.1")
    )
      throw new Error(
        "EventSub transport must be secure or a loopback test server",
      );
    if (
      parsed.protocol === "wss:" &&
      !["eventsub.wss.twitch.tv"].includes(parsed.hostname)
    )
      throw new Error("Untrusted EventSub reconnect host");
    const previous = this.socket;
    const socket = new WebSocket(url);
    this.socket = socket;
    socket.on("message", (data) => {
      try {
        void this.receive(
          JSON.parse(data.toString()) as Frame,
          socket,
          handoff,
          previous,
        ).catch(() => this.onStatus("subscription error"));
      } catch {
        this.onStatus("invalid EventSub frame");
      }
    });
    socket.on("error", () => this.onStatus("EventSub connection error"));
    socket.on("close", () => {
      if (this.retired.delete(socket) || socket !== this.socket) return;
      this.connected = false;
      this.onStatus("disconnected; events during outage cannot be replayed");
      clearTimeout(this.watchdog);
      if (!this.stopped) {
        this.retry = setTimeout(
          () => this.connect(this.url, false),
          this.backoff,
        );
        this.backoff = Math.min(30000, this.backoff * 2);
      }
    });
  }
  private async receive(
    frame: Frame,
    socket: WebSocket,
    handoff: boolean,
    previous: WebSocket | undefined,
  ): Promise<void> {
    clearTimeout(this.watchdog);
    this.watchdog = setTimeout(() => socket.close(), this.keepalive + 2000);
    const type = frame.metadata.message_type;
    if (type === "session_welcome") {
      const session = frame.payload.session!;
      this.keepalive = (session.keepalive_timeout_seconds || 10) * 1000;
      clearTimeout(this.watchdog);
      this.watchdog = setTimeout(() => socket.close(), this.keepalive + 2000);
      this.backoff = 1000;
      if (handoff && previous) {
        this.retired.add(previous);
        previous.close();
        return;
      }
      const id = this.helix.userId;
      let complete = true;
      for (const event of [
        "channel.chat.message",
        "stream.online",
        "stream.offline",
        "channel.shield_mode.begin",
        "channel.shield_mode.end",
      ]) {
        const condition: Record<string, string> = { broadcaster_user_id: id };
        if (event === "channel.chat.message") condition.user_id = id;
        if (event.startsWith("channel.shield"))
          condition.moderator_user_id = id;
        try {
          await this.helix.request(
            "POST",
            "/eventsub/subscriptions",
            {
              type: event,
              version: "1",
              condition,
              transport: { method: "websocket", session_id: session.id },
            },
            2,
          );
        } catch {
          complete = false;
          this.onStatus("subscription setup failed: " + event);
        }
      }
      if (socket === this.socket && socket.readyState === WebSocket.OPEN) {
        this.connected = complete;
        this.onStatus(complete ? "connected" : "subscription setup incomplete");
      }
    } else if (type === "session_reconnect") {
      const url = frame.payload.session?.reconnect_url;
      if (url) this.connect(url, true);
    } else if (type === "revocation") {
      this.connected = false;
      this.onStatus("authorization revoked; sign in again");
    } else if (type === "notification") {
      const id = frame.metadata.message_id;
      if (this.seen.has(id)) return;
      this.seen.add(id);
      if (this.seen.size > 1000)
        this.seen.delete(this.seen.values().next().value!);
      if (frame.metadata.subscription_type === "channel.chat.message") {
        const e = frame.payload.event!;
        const badges = e.badges as { set_id: string }[] | undefined;
        this.onChat({
          id: String(e.message_id),
          userId: String(e.chatter_user_id),
          login: String(e.chatter_user_login),
          text: String((e.message as { text: string }).text),
          timestamp: Date.now(),
          privileged:
            badges?.some((b) =>
              ["broadcaster", "moderator"].includes(b.set_id),
            ) ?? false,
        });
      }
    }
  }
  stop(): void {
    this.stopped = true;
    clearTimeout(this.retry);
    clearTimeout(this.watchdog);
    this.socket?.close();
    this.retired.forEach((s) => s.close());
    this.connected = false;
    this.seen.clear();
  }
}
