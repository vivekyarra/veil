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

const TOPICS = [
  "channel.chat.message",
  "stream.online",
  "stream.offline",
  "channel.shield_mode.begin",
  "channel.shield_mode.end",
];

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
  private session = "";
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
    // A fresh connect supersedes any half-finished handoff socket.
    if (!handoff && previous && previous.readyState !== WebSocket.CLOSED) {
      this.retired.add(previous);
      previous.terminate();
    }
    const socket = new WebSocket(url);
    this.socket = socket;
    // A socket that never sends session_welcome must not hang forever.
    this.arm(socket, 10000);
    socket.on("message", (data) => {
      let frame: Frame;
      try {
        frame = JSON.parse(data.toString()) as Frame;
        if (
          typeof frame?.metadata?.message_type !== "string" ||
          typeof frame.payload !== "object" ||
          frame.payload === null
        )
          throw new Error("malformed");
      } catch {
        this.onStatus("invalid EventSub frame");
        return;
      }
      void this.receive(frame, socket, handoff, previous).catch(() =>
        this.onStatus("subscription error"),
      );
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
    // Frames on a socket being handed off must not move the live watchdog.
    if (socket === this.socket) this.arm(socket, this.keepalive + 2000);
    const type = frame.metadata.message_type;
    // Twitch may resend events; control frames are per connection.
    const id = frame.metadata.message_id;
    if (id && (type === "notification" || type === "revocation")) {
      if (this.seen.has(id)) return;
      this.seen.add(id);
      if (this.seen.size > 1000)
        this.seen.delete(this.seen.values().next().value!);
    }
    if (type === "session_welcome") {
      const session = frame.payload.session;
      if (!session || typeof session.id !== "string") {
        this.onStatus("invalid EventSub frame");
        return;
      }
      this.keepalive =
        Math.min(600, Math.max(10, session.keepalive_timeout_seconds || 10)) *
        1000;
      if (socket === this.socket) this.arm(socket, this.keepalive + 2000);
      this.backoff = 1000;
      this.session = session.id;
      if (handoff && previous) {
        this.retired.add(previous);
        previous.close();
        return;
      }
      let complete = true;
      for (const event of TOPICS)
        try {
          await this.subscribe(event, session.id);
        } catch {
          complete = false;
          this.onStatus("subscription setup failed: " + event);
        }
      if (socket === this.socket && socket.readyState === WebSocket.OPEN) {
        this.connected = complete;
        this.onStatus(complete ? "connected" : "subscription setup incomplete");
      }
    } else if (type === "session_reconnect") {
      const url = frame.payload.session?.reconnect_url;
      if (url) this.connect(url, true);
    } else if (type === "revocation") {
      // Try to restore the topic; a real revocation fails and is reported.
      const topic = frame.payload.subscription?.type ?? "";
      this.connected = false;
      this.onStatus("subscription revoked: " + topic + "; resubscribing");
      try {
        if (!TOPICS.includes(topic) || !this.session)
          throw new Error("Unknown topic");
        await this.subscribe(topic, this.session);
        if (socket === this.socket) this.connected = true;
        this.onStatus("resubscribed: " + topic);
      } catch {
        this.onStatus("authorization revoked; sign in again");
      }
    } else if (type === "notification") {
      const e = frame.payload.event;
      if (
        frame.metadata.subscription_type === "channel.chat.message" &&
        e &&
        typeof (e.message as { text?: unknown } | undefined)?.text === "string"
      ) {
        const badges = e.badges as { set_id: string }[] | undefined;
        this.onChat({
          id: String(e.message_id),
          userId: String(e.chatter_user_id),
          login: String(e.chatter_user_login),
          text: String((e.message as { text: string }).text),
          timestamp: Date.parse(frame.metadata.message_timestamp) || Date.now(),
          privileged:
            badges?.some((b) =>
              ["broadcaster", "moderator"].includes(b.set_id),
            ) ?? false,
        });
      }
    }
  }
  /** Keepalive watchdog for the live socket; terminate skips the close handshake. */
  private arm(socket: WebSocket, ms: number): void {
    clearTimeout(this.watchdog);
    this.watchdog = setTimeout(() => {
      if (socket === this.socket) socket.terminate();
    }, ms);
  }
  private subscribe(event: string, session: string): Promise<unknown> {
    const condition: Record<string, string> = {
      broadcaster_user_id: this.helix.broadcasterId,
    };
    if (event === "channel.chat.message") condition.user_id = this.helix.userId;
    if (event.startsWith("channel.shield"))
      condition.moderator_user_id = this.helix.userId;
    return this.helix.request(
      "POST",
      "/eventsub/subscriptions",
      {
        type: event,
        version: "1",
        condition,
        transport: { method: "websocket", session_id: session },
      },
      2,
    );
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
