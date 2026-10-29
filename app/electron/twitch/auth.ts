export const SCOPES = [
  "user:read:chat",
  "user:write:chat",
  "moderator:manage:chat_messages",
  "moderator:read:blocked_terms",
  "moderator:manage:blocked_terms",
  "moderator:read:shield_mode",
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

/** Device grant only; rotating refresh tokens are persisted before reuse. */
export class TwitchAuth {
  private refreshing: Promise<Tokens> | undefined;
  constructor(
    readonly clientId: string,
    private readonly persistence: TokenPersistence,
    private readonly origin = "https://id.twitch.tv",
    private readonly transport: typeof fetch = fetch,
  ) {}
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
    let interval = device.interval * 1000;
    while (Date.now() < deadline && !signal?.aborted) {
      await sleep(interval);
      if (signal?.aborted) break;
      const response = await this.form("/oauth2/token", {
        client_id: this.clientId,
        device_code: device.device_code,
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
      });
      if (signal?.aborted) throw new Error("Device authorization cancelled");
      if (response.ok) {
        const tokens = {
          ...((await response.json()) as Omit<Tokens, "obtained_at">),
          obtained_at: Date.now(),
        };
        this.persistence.save(tokens);
        return tokens;
      }
      const body = (await response.json()) as {
        message?: string;
        error?: string;
      };
      const reason = body.message ?? body.error ?? "";
      if (reason.includes("slow_down")) {
        interval += 5000;
        continue;
      }
      if (reason.includes("authorization_pending")) continue;
      throw new Error(
        `Twitch sign-in failed (${response.status}); start again`,
      );
    }
    throw new Error("Twitch device authorization expired or cancelled");
  }
  async validate(): Promise<Validation> {
    const tokens = this.persistence.load();
    if (!tokens) throw new Error("Twitch sign-in required");
    const response = await this.transport(this.origin + "/oauth2/validate", {
      headers: { Authorization: "OAuth " + (await this.access()) },
      signal: AbortSignal.timeout(10000),
    });
    if (!response.ok) {
      this.persistence.clear();
      throw new Error("Twitch authorization revoked; sign in again");
    }
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
  refresh(): Promise<Tokens> {
    if (this.refreshing) return this.refreshing;
    this.refreshing = (async () => {
      const current = this.persistence.load();
      if (!current) throw new Error("Twitch sign-in required");
      const response = await this.form("/oauth2/token", {
        grant_type: "refresh_token",
        client_id: this.clientId,
        refresh_token: current.refresh_token,
      });
      if (!response.ok) {
        this.persistence.clear();
        throw new Error("Twitch refresh failed; sign in again");
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
