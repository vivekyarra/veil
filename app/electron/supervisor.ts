import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  renameSync,
  chmodSync,
} from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

/** Restrict all install credentials to the current OS account. */
function restrictFile(path: string): void {
  if (process.platform === "win32") {
    const account = process.env.USERDOMAIN
      ? `${process.env.USERDOMAIN}\\${process.env.USERNAME}`
      : process.env.USERNAME;
    if (!account) throw new Error("Cannot determine current OS account");
    execFileSync(
      "icacls.exe",
      [path, "/inheritance:r", "/grant:r", `${account}:(F)`],
      { windowsHide: true, stdio: "ignore" },
    );
  } else chmodSync(path, 0o600);
}
export function localCredential(directory: string): {
  token: string;
  path: string;
} {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const path = join(directory, "plugin.json");
  if (existsSync(path)) {
    restrictFile(path);
    const value = JSON.parse(readFileSync(path, "utf8")) as { token: string };
    if (/^[0-9a-f]{64}$/.test(value.token)) return { ...value, path };
    throw new Error("Invalid local install credential");
  }
  const token = randomBytes(32).toString("hex"),
    temporary = path + ".new";
  writeFileSync(temporary, JSON.stringify({ token }), { mode: 0o600 });
  restrictFile(temporary);
  renameSync(temporary, path);
  return { token, path };
}
export class Supervisor {
  private child: ChildProcess | undefined;
  private exitCode: number | null = null;
  diagnostic(): { running: boolean; exitCode: number | null } {
    return { running: Boolean(this.child), exitCode: this.exitCode };
  }
  constructor(
    readonly token: string,
    readonly url = "http://127.0.0.1:47321",
  ) {}
  async request(
    path: string,
    method = "GET",
    body?: unknown,
  ): Promise<Record<string, unknown>> {
    const response = await fetch(this.url + path, {
      method,
      headers: {
        Authorization: `Bearer ${this.token}`,
        "Content-Type": "application/json",
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(30000),
    });
    if (!response.ok)
      throw new Error(`Detector request failed (${response.status})`);
    return (await response.json()) as Record<string, unknown>;
  }
  async start(command: string, args: string[], cwd?: string): Promise<void> {
    if (this.child) return;
    this.child = spawn(command, args, {
      cwd,
      windowsHide: true,
      stdio: "ignore",
      env: { ...process.env, VEIL_LOCAL_TOKEN: this.token },
    });
    this.child.on("error", () => {
      this.child = undefined;
    });
    this.child.on("exit", (code) => {
      this.exitCode = code;
      this.child = undefined;
    });
    // Cold Windows imports and antivirus scanning can exceed twenty seconds.
    for (let attempt = 0; attempt < 480; attempt++) {
      if (!this.child) throw new Error("Local detector exited during startup");
      try {
        await this.request("/v1/health");
        return;
      } catch {
        await new Promise((r) => setTimeout(r, 250));
      }
    }
    throw new Error("Local detector did not become healthy");
  }
  stop(): void {
    if (this.child?.pid && process.platform === "win32") {
      try {
        execFileSync(
          "taskkill.exe",
          ["/pid", String(this.child.pid), "/T", "/F"],
          { windowsHide: true, stdio: "ignore" },
        );
      } catch {
        this.child.kill();
      }
    } else this.child?.kill();
    this.child = undefined;
  }
}
