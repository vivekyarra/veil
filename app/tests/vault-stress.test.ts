import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../electron/store/store";
import { defaultSettings, loadSettings } from "../electron/store/settings";
import {
  SCRYPT_PARAMS,
  Vault,
  VaultCorruptError,
  lockoutMs,
  type SafeStorage,
} from "../electron/vault/vault";

const fakeOS: SafeStorage = {
  isEncryptionAvailable: () => true,
  encryptString: (v) => Buffer.from("wrapped:" + v),
  decryptString: (v) => v.toString().replace(/^wrapped:/, ""),
};
const PLANTED = "Synthetic Planted Lane 4242";

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("PIN lockout", () => {
  it("survives restarts and backs off exponentially", () => {
    vi.useFakeTimers({ now: 1_000_000, toFake: ["Date"] });
    const store = new Store(":memory:");
    new Vault(store, fakeOS).setPin("123456");
    const fail = (n: number) => {
      for (let i = 0; i < n; i++)
        expect(() => new Vault(store, fakeOS).unlock("000000")).toThrow(
          "Incorrect",
        );
    };
    const lockedFor = () => new Vault(store, fakeOS).lockoutRemaining();
    fail(5);
    expect(lockedFor()).toBe(60_000);
    // Correct PIN is refused while locked, and the attempt is not counted.
    expect(() => new Vault(store, fakeOS).unlock("123456")).toThrow(
      "Too many PIN attempts",
    );
    vi.setSystemTime(Date.now() + 60_001);
    fail(5);
    expect(lockedFor()).toBe(120_000);
    vi.setSystemTime(Date.now() + 120_001);
    fail(5);
    expect(lockedFor()).toBe(240_000);
    vi.setSystemTime(Date.now() + 240_001);
    new Vault(store, fakeOS).unlock("123456");
    fail(5);
    expect(lockedFor()).toBe(60_000);
    store.close();
  });

  it("caps backoff and limits brute force to a slow rate", () => {
    expect(lockoutMs(1)).toBe(60_000);
    expect(lockoutMs(50)).toBe(24 * 60 * 60_000);
    // Guesses possible in 30 days of continuous attack against 10^6 PINs.
    let t = 0,
      guesses = 0,
      strike = 0;
    while (t < 30 * 24 * 3600_000) {
      guesses += 5;
      t += lockoutMs(++strike);
    }
    expect(guesses).toBeLessThanOrEqual(200); // was 216,000 with a flat 1-min lockout
  });

  it("ignores tampered lockout records without unlocking", () => {
    const store = new Store(":memory:");
    const vault = new Vault(store, fakeOS);
    vault.setPin("123456");
    store.set("vaultLockout", { failed: "x", blockedUntil: 1e300 });
    expect(vault.lockoutRemaining()).toBeLessThanOrEqual(24 * 3600_000);
    expect(() => vault.unlock("123456")).toThrow("Too many");
    store.close();
  });

  it("uses reasonable scrypt parameters and verifies legacy records", async () => {
    expect(SCRYPT_PARAMS.N).toBeGreaterThanOrEqual(2 ** 15);
    expect(SCRYPT_PARAMS.r).toBe(8);
    const store = new Store(":memory:");
    const vault = new Vault(store, fakeOS);
    vault.setPin("123456");
    expect(store.get<{ N: number }>("vaultPin", { N: 0 }).N).toBe(
      SCRYPT_PARAMS.N,
    );
    const { scryptSync } = await import("node:crypto");
    store.set("vaultPin", {
      salt: "aa",
      hash: scryptSync("654321", "aa", 32).toString("hex"),
    });
    expect(() => vault.unlock("654321")).not.toThrow();
    // A record demanding absurd cost is rejected, not executed.
    store.set("vaultPin", { salt: "aa", hash: "00".repeat(32), N: 2 ** 30 });
    expect(() => vault.unlock("654321")).toThrow("Incorrect");
    store.close();
  });
});

describe("vault integrity", () => {
  it("serializes interleaved writes and deletes without losing entries", async () => {
    const store = new Store(":memory:");
    const a = new Vault(store, fakeOS),
      b = new Vault(store, fakeOS);
    const ids = await Promise.all(
      Array.from({ length: 200 }, (_, i) =>
        Promise.resolve().then(() =>
          (i % 2 ? a : b).add(`term ${i}`, "custom"),
        ),
      ),
    );
    await Promise.all(
      ids
        .filter((_, i) => i % 3 === 0)
        .map((id, i) =>
          Promise.resolve().then(() => (i % 2 ? b : a).remove(id)),
        ),
    );
    const left = a.list().map((e) => e.id);
    expect(left).toHaveLength(200 - Math.ceil(200 / 3));
    expect(new Set(left).size).toBe(left.length);
    expect(b.list()).toEqual(a.list());
    store.close();
  });

  it("handles GCM auth failure and corrupt rows without crashing or leaking", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const store = new Store(":memory:");
    const vault = new Vault(store, fakeOS);
    vault.add(PLANTED, "address");
    const row = store.get<{ iv: string; tag: string; body: string }>("vault", {
      iv: "",
      tag: "",
      body: "",
    });
    const body = Buffer.from(row.body, "base64");
    body[0] ^= 0xff;
    store.set("vault", { ...row, body: body.toString("base64") });
    const reopened = new Vault(store, fakeOS);
    expect(reopened.corrupted).toBe(true);
    expect(reopened.list()).toEqual([]);
    expect(reopened.terms()).toEqual([]);
    expect(() => reopened.add("x", "custom")).toThrow(VaultCorruptError);
    for (const bad of [null, "junk", 7, { iv: 1 }, []]) {
      store.set("vault", bad);
      expect(() => new Vault(store, fakeOS)).not.toThrow();
    }
    // Unparseable JSON in the row itself.
    (
      store as unknown as {
        db: { prepare(s: string): { run(...a: unknown[]): void } };
      }
    ).db
      .prepare("UPDATE kv SET value=? WHERE key='vault'")
      .run(`{"body":"${PLANTED}`);
    expect(new Vault(store, fakeOS).list()).toEqual([]);
    reopened.wipe();
    expect(reopened.corrupted).toBe(false);
    reopened.add("fresh", "custom");
    expect(reopened.list()).toHaveLength(1);
    const logged = JSON.stringify([...warn.mock.calls, ...error.mock.calls]);
    expect(logged).not.toContain(PLANTED);
    store.close();
  });

  it("decrypt errors never include plaintext in their message", () => {
    const store = new Store(":memory:");
    const vault = new Vault(store, fakeOS);
    vault.setPin("123456");
    vault.unlock("123456");
    const id = vault.add(PLANTED, "address");
    store.set("vault", {
      iv: "AAAAAAAAAAAAAAAA",
      tag: "AAAAAAAAAAAAAAAAAAAAAA==",
      body: "AA",
    });
    try {
      vault.reveal(id);
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(VaultCorruptError);
      expect(String((e as Error).message)).not.toContain(PLANTED);
    }
    store.close();
  });

  it("wipe removes the ciphertext from disk and rotates the key", () => {
    const dir = mkdtempSync(join(tmpdir(), "veil-wipe-"));
    const path = join(dir, "veil.sqlite");
    const store = new Store(path);
    const vault = new Vault(store, fakeOS);
    vault.add(PLANTED, "address");
    const oldRow = store.get<unknown>("vault", undefined);
    const oldKey = store.get<string>("vaultKey", "");
    const ciphertext = (oldRow as { body: string }).body;
    vault.wipe();
    expect(store.get("vault", undefined)).toBeUndefined();
    expect(store.get<string>("vaultKey", "")).not.toBe(oldKey);
    // A restored copy of the old ciphertext no longer decrypts.
    store.set("vault", oldRow);
    expect(new Vault(store, fakeOS).list()).toEqual([]);
    store.remove("vault");
    store.checkpoint();
    const bytes = readdirSync(dir)
      .map((f) => readFileSync(join(dir, f)).toString("latin1"))
      .join("");
    expect(bytes).not.toContain(ciphertext.slice(0, 16));
    expect(bytes).not.toContain(oldKey.slice(0, 24));
    store.close();
  });
});

describe("settings migration", () => {
  it("fills fields missing from an older settings file", () => {
    const old = {
      profile: "balanced",
      delay: 900,
      modes: { shield: "ask" },
    } as Record<string, unknown>;
    const s = loadSettings(old);
    expect(s.profile).toBe("balanced");
    expect(s.delay).toBe(900);
    expect(s.protectedChannel).toBe("");
    expect(s.rehearsal).toBe(true);
    expect(s.onboardingComplete).toBe(false);
    expect(s.modes.mute).toBe(defaultSettings().modes.mute);
    expect(s.modes.shield).toBe("ask");
  });

  it("drops wrong-typed and unknown values instead of trusting them", () => {
    const s = loadSettings({
      profile: "nope",
      theme: 3,
      delay: "fast",
      denylist: "gmail",
      modes: "auto",
      onboardingComplete: "yes",
      protectedChannel: null,
    });
    expect(s).toEqual(defaultSettings());
    expect(
      loadSettings({ modes: { mute: "bogus", hacked: "auto" } }).modes,
    ).toEqual(defaultSettings().modes);
    for (const bad of [null, undefined, 1, "x", []])
      expect(loadSettings(bad)).toEqual(defaultSettings());
  });

  it("an invalid settings JSON row does not brick startup", () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const store = new Store(":memory:");
    (
      store as unknown as {
        db: { prepare(s: string): { run(...a: unknown[]): void } };
      }
    ).db
      .prepare("INSERT INTO kv(key,value) VALUES('settings', ?)")
      .run('{"profile": "balanced", secret-ish');
    expect(() => loadSettings(store.get("settings", {}))).not.toThrow();
    expect(loadSettings(store.get("settings", {}))).toEqual(defaultSettings());
    store.close();
  });
});
