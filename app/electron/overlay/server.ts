import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";

/** What the app reports; the server derives the overlay payload from it. */
interface OverlayInput {
  /** Live protection is armed (not rehearsal, Twitch, chat guard, OBS). */
  armed: boolean;
  /** Detector regions found this session (counts frames, not leaks). */
  masks: number;
  /** Chat messages deleted this session. */
  removed: number;
}
/**
 * Everything an OBS overlay may ever see: counts and timestamps only.
 * Never add strings here: viewers can read anything the overlay receives.
 */
export interface OverlayPayload {
  armed: boolean;
  /** Epoch ms when protection was armed; 0 when not armed. */
  since: number;
  /** Screen catches: bursts of masking separated by a quiet gap. */
  screen: number;
  /** Chat leaks deleted. */
  chat: number;
  /** Epoch ms of the most recent catch; 0 for none. */
  lastCatch: number;
  /** 1 = screen, 2 = chat, 0 = none. Numeric so it can never carry text. */
  lastKind: 0 | 1 | 2;
}
/** Masks closer together than this are the same on-screen leak. */
const SCREEN_BURST_MS = 5000;
const MAX_CLIENTS = 16;
const KEEPALIVE_MS = 15000;
/** Slowloris guard: a client must finish its request headers quickly. */
const HEADERS_TIMEOUT_MS = 5000;
const MAX_CONNECTIONS = MAX_CLIENTS * 2;
/** Only non-negative whole counts / epoch ms may leave this server. */
const count = (value: unknown): number =>
  typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : 0;
const CSP =
  "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; img-src data:; base-uri 'none'; form-action 'none'";

/**
 * Loopback-only, read-only feed for the on-stream overlay. Serves the overlay
 * page and a Server-Sent Events stream of {@link OverlayPayload}.
 */
export class OverlayServer {
  private server: Server | undefined;
  private readonly clients = new Set<ServerResponse>();
  private keepalive: ReturnType<typeof setInterval> | undefined;
  private last: OverlayInput = { armed: false, masks: 0, removed: 0 };
  private lastMaskAt = -Infinity;
  private state: OverlayPayload = {
    armed: false,
    since: 0,
    screen: 0,
    chat: 0,
    lastCatch: 0,
    lastKind: 0,
  };
  private encoded = JSON.stringify(this.state);
  port = 0;
  constructor(
    /** Returns the overlay HTML; read from a real file next to the cover. */
    private readonly page: () => string,
    private readonly now: () => number = Date.now,
  ) {}
  get url(): string {
    return this.port ? `http://127.0.0.1:${this.port}/overlay` : "";
  }
  get payload(): OverlayPayload {
    return { ...this.state };
  }
  /** Listen on 127.0.0.1; falls back to a free port if `port` is taken. */
  async start(port: number): Promise<void> {
    const server = createServer(
      { connectionsCheckingInterval: 1000 },
      (req, res) => this.handle(req, res),
    );
    // Not constructor options in the bundled Node typings; same effect.
    server.headersTimeout = HEADERS_TIMEOUT_MS;
    server.requestTimeout = HEADERS_TIMEOUT_MS * 2;
    server.maxConnections = MAX_CONNECTIONS;
    const listen = (p: number) =>
      new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(p, "127.0.0.1", () => {
          server.off("error", reject);
          resolve();
        });
      });
    try {
      await listen(port);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EADDRINUSE") throw error;
      await listen(0);
    }
    const address = server.address();
    if (!address || typeof address === "string")
      throw new Error("Overlay address unavailable");
    this.port = address.port;
    this.server = server;
    this.keepalive = setInterval(() => {
      for (const client of this.clients) client.write(": keepalive\n\n");
    }, KEEPALIVE_MS);
    this.keepalive.unref();
  }
  /** Fold new app counts into the payload; pushes only when it changes. */
  update(raw: OverlayInput): void {
    const input: OverlayInput = {
        armed: raw.armed === true,
        masks: count(raw.masks),
        removed: count(raw.removed),
      },
      now = count(this.now()),
      next = { ...this.state };
    if (input.armed !== this.last.armed || (input.armed && !next.since))
      next.since = input.armed ? now : 0;
    if (input.masks > this.last.masks) {
      if (now - this.lastMaskAt >= SCREEN_BURST_MS) {
        next.screen += 1;
        next.lastCatch = now;
        next.lastKind = 1;
      }
      this.lastMaskAt = now;
    }
    if (input.removed > this.last.removed) {
      next.chat += input.removed - this.last.removed;
      next.lastCatch = now;
      next.lastKind = 2;
    }
    next.armed = input.armed;
    this.last = { ...input };
    const encoded = JSON.stringify(next);
    if (encoded === this.encoded) return;
    this.state = next;
    this.encoded = encoded;
    for (const client of this.clients) client.write(`data: ${encoded}\n\n`);
  }
  private handle(req: IncomingMessage, res: ServerResponse): void {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Referrer-Policy", "no-referrer");
    // Defeat DNS rebinding: only our own loopback host names are accepted.
    const host = req.headers.host;
    if (host !== `127.0.0.1:${this.port}` && host !== `localhost:${this.port}`)
      return void res.writeHead(403).end();
    // Browsers send Origin on cross-origin requests; only our own is allowed.
    const origin = req.headers.origin;
    if (
      origin !== undefined &&
      origin !== `http://127.0.0.1:${this.port}` &&
      origin !== `http://localhost:${this.port}`
    )
      return void res.writeHead(403).end();
    if (req.method !== "GET" && req.method !== "HEAD")
      return void res.writeHead(405, { Allow: "GET, HEAD" }).end();
    const path = (req.url ?? "/").split("?")[0];
    if (path === "/overlay") {
      res.writeHead(200, {
        "Content-Type": "text/html; charset=utf-8",
        "Content-Security-Policy": CSP,
      });
      return void res.end(req.method === "HEAD" ? undefined : this.page());
    }
    if (path === "/overlay/events") {
      if (req.method !== "GET")
        return void res.writeHead(405, { Allow: "GET" }).end();
      if (this.clients.size >= MAX_CLIENTS)
        return void res.writeHead(503).end();
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        Connection: "keep-alive",
      });
      res.write(`retry: 2000\ndata: ${this.encoded}\n\n`);
      this.clients.add(res);
      req.on("close", () => this.clients.delete(res));
      return;
    }
    res.writeHead(404).end();
  }
  async close(): Promise<void> {
    clearInterval(this.keepalive);
    for (const client of this.clients) client.end();
    this.clients.clear();
    const server = this.server;
    this.server = undefined;
    if (!server) return;
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}
