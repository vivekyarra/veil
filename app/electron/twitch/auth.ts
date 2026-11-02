// The manage scopes also grant Get Blocked Terms and the Shield Mode EventSub
// topics, so the separate read scopes add nothing.
export const SCOPES = [
  "user:read:chat",
  "user:write:chat",
  "moderator:manage:chat_messages",
  "moderator:manage:blocked_terms",
  "moderator:manage:shield_mode",
  "moderator:manage:banned_users",
  "channel:manage:broadcast",
] as const;
export interface Tokens {
  access_token: string;
  refresh_token: string;
  expires_in: number;
  obtained_at: number;
  scope?: string[];
}
export interface DeviceCode {
  device_code: string;
  user_code: string;
  verification_uri: string;
  interval: number;
  expires_in: number;
}
interface Validation {
  client_id: string;
  user_id: string;
  login: string;
  scopes: string[];
  expires_in: number;
}
export interface TokenPersistence {
  load(): Tokens | undefined;
  save(tokens: Tokens): void;
  clear(): void;
}
const sleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));
/** Twitch rejected the credentials; stored tokens were cleared. */
export class AuthRevokedError extends Error {}
/** Twitch was unreachable or failing; stored tokens were kept. */
export class AuthUnavailableError extends Error {}
const RETRIES = 3;

/** Device grant only; rotating refresh tokens are persisted before reuse. */
export class TwitchAuth {
  private refreshing: Promise<Tokens> | undefined;
  constructor(
    readonly clientId: string,
    private readonly persistence: TokenPersistence,
    private readonly origin = "https://id.twitch.tv",
    private readonly transport: typeof fetch = fetch,
    private readonly retryBaseMs = 500,
  ) {}
  /** Retry network errors and 5xx with backoff; other responses return. */
  private async withRetry(call: () => Promise<Response>): Promise<Response> {
    for (let attempt = 0; ; attempt++) {
      let response: Response | undefined;
      try {
        response = await call();
      } catch {
        response = undefined;
      }
      if (response && response.status < 500) return response;
      if (attempt + 1 >= RETRIES)
        throw new AuthUnavailableError(
          "Twitch is unavailable; keeping your sign-in and retrying later",
        );
      await sleep(this.retryBaseMs * 2 ** attempt);
    }
  }
  private async form(
    path: string,
    body: Record<string, string>,
  ): Promise<Response> {
    return this.transport(this.origin + path, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(body),
      signal: AbortSignal.timeout(15000),
    });
  }
  async begin(): Promise<DeviceCode> {
    if (!this.clientId)
      throw new Error(
        "Register a Twitch public client and set TWITCH_CLIENT_ID",
      );
    const response = await this.form("/oauth2/device", {
      client_id: this.clientId,
      scopes: SCOPES.join(" "),
    });
    if (!response.ok)
      throw new Error(
        `Twitch device authorization failed (${response.status})`,
      );
    return (await response.json()) as DeviceCode;
  }
  async poll(device: DeviceCode, signal?: AbortSignal): Promise<Tokens> {
    const deadline = Date.now() + device.expires_in * 1000;
    // RFC 8628: default 5s; slow_down adds 5s to every later poll.
    let interval = Math.max(1, Number(device.interval) || 5) * 1000;
    while (Date.now() < deadline && !signal?.aborted) {
      await sleep(Math.min(interval, Math.max(0, deadline - Date.now())));
      if (signal?.aborted || Date.now() >= deadline) break;
      let response: Response;
      try {
        response = await this.form("/oauth2/token", {
          client_id: this.clientId,
          device_code: device.device_code,
          grant_type: "urn:ietf:params:oauth:grant-type:device_code",
        });
      } catch {
        if (signal?.aborted) break;
        continue; // Network blip: keep polling until the code expires.
      }
      if (signal?.aborted) throw new Error("Device authorization cancelled");
      if (response.ok) {
        const tokens = {
          ...((await response.json()) as Omit<Tokens, "obtained_at">),
          obtained_at: Date.now(),
        };
        this.persistence.save(tokens);
        return tokens;
      }
      if (response.status >= 500) continue;
      const body = (await response.json().catch(() => ({}))) as {
        message?: string;
        error?: string;
      };
      const reason = body.message ?? body.error ?? "";
      if (reason.includes("slow_down")) {
        interval += 5000;
        continue;
      }
      if (reason.includes("authorization_pending")) continue;
      if (/expired/i.test(reason)) break;
      throw new Error(
        `Twitch sign-in failed (${response.status}); start again`,
      );
    }
    throw new Error("Twitch device authorization expired or cancelled");
  }
  async validate(): Promise<Validation> {
    const tokens = this.persistence.load();
    if (!tokens) throw new Error("Twitch sign-in required");
    const request = (access: string) =>
      this.withRetry(() =>
        this.transport(this.origin + "/oauth2/validate", {
          headers: { Authorization: "OAuth " + access },
          signal: AbortSignal.timeout(10000),
        }),
      );
    let response = await request(await this.access());
    // An access token can expire early; a valid refresh token recovers it.
    if (response.status === 401)
      response = await request((await this.refresh()).access_token);
    if (response.status === 401) {
      this.persistence.clear();
      throw new AuthRevokedError("Twitch authorization revoked; sign in again");
    }
    if (!response.ok)
      throw new Error(`Twitch validation failed (${response.status})`);
    const value = (await response.json()) as Validation;
    if (
      value.client_id !== this.clientId ||
      SCOPES.some((scope) => !value.scopes.includes(scope))
    )
      throw new Error(
        "Twitch client or granted scopes do not match VEIL requirements",
      );
    return value;
  }
  async access(): Promise<string> {
    const tokens = this.persistence.load();
    if (!tokens) throw new Error("Twitch sign-in required");
    if (Date.now() < tokens.obtained_at + (tokens.expires_in - 120) * 1000)
      return tokens.access_token;
    return (await this.refresh()).access_token;
  }
  /**
   * Single-flight. Pass the access token that was rejected: when another
   * caller already rotated it, the stored tokens are returned without a call.
   */
  refresh(rejected?: string): Promise<Tokens> {
    if (this.refreshing) return this.refreshing;
    const stored = this.persistence.load();
    if (rejected !== undefined && stored && stored.access_token !== rejected)
      return Promise.resolve(stored);
    this.refreshing = (async () => {
      const current = this.persistence.load();
      if (!current) throw new Error("Twitch sign-in required");
      const response = await this.withRetry(() =>
        this.form("/oauth2/token", {
          grant_type: "refresh_token",
          client_id: this.clientId,
          refresh_token: current.refresh_token,
        }),
      );
      if (!response.ok) {
        const body = (await response.json().catch(() => ({}))) as {
          error?: string;
          message?: string;
        };
        const invalidGrant =
          body.error === "invalid_grant" ||
          /invalid[_ ](grant|refresh token)/i.test(body.message ?? "");
        if (
          (response.status === 400 || response.status === 401) &&
          invalidGrant
        ) {
          this.persistence.clear();
          throw new AuthRevokedError("Twitch refresh failed; sign in again");
        }
        throw new Error(`Twitch refresh failed (${response.status})`);
      }
      const rotated = {
        ...((await response.json()) as Omit<Tokens, "obtained_at">),
        obtained_at: Date.now(),
      };
      this.persistence.save(rotated);
      return rotated;
    })().finally(() => {
      this.refreshing = undefined;
    });
    return this.refreshing;
  }
}
