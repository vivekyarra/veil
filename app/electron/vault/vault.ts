import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  scryptSync,
  timingSafeEqual,
  randomUUID,
} from "node:crypto";
import type { Store } from "../store/store.js";
import type { TokenPersistence, Tokens } from "../twitch/auth.js";
export interface SafeStorage {
  isEncryptionAvailable(): boolean;
  encryptString(value: string): Buffer;
  decryptString(value: Buffer): string;
  /** Linux only in Electron; "basic_text" means no real keyring. */
  getSelectedStorageBackend?(): string;
}
/** Refuse Linux's basic_text backend: it is an obfuscation, not encryption. */
function requireRealKeyring(os: SafeStorage, platform: string): void {
  if (platform === "linux" && os.getSelectedStorageBackend?.() === "basic_text")
    throw new Error(
      "No system keyring found (basic_text). Install or unlock GNOME Keyring or KWallet, then restart VEIL.",
    );
}
interface Lockout {
  failed: number;
  blockedUntil: number;
  /** Lockouts served since the last correct PIN; drives the backoff. */
  strikes: number;
}
/** Wrong PINs allowed before each lockout. */
const ATTEMPTS_PER_LOCKOUT = 5;
const BASE_LOCKOUT_MS = 60_000;
const MAX_LOCKOUT_MS = 24 * 60 * 60_000;
/** Lockout length doubles per strike: 1, 2, 4, 8 ... minutes, capped at 24 h. */
export function lockoutMs(strikes: number): number {
  return Math.min(
    BASE_LOCKOUT_MS * 2 ** Math.max(0, strikes - 1),
    MAX_LOCKOUT_MS,
  );
}
/** scrypt N=2^15, r=8, p=1 (32 MiB per guess), stored with each PIN record. */
export const SCRYPT_PARAMS = { N: 2 ** 15, r: 8, p: 1 };
/** Node defaults, used by PIN records written before params were stored. */
const LEGACY_SCRYPT = { N: 2 ** 14, r: 8, p: 1 };
const SCRYPT_MAXMEM = 64 * 1024 * 1024;
interface PinRecord {
  salt: string;
  hash: string;
  N?: number;
  r?: number;
  p?: number;
}
function pinHash(pin: string, record: PinRecord): Buffer {
  const params =
    record.N === undefined
      ? LEGACY_SCRYPT
      : { N: record.N, r: record.r ?? 8, p: record.p ?? 1 };
  if (
    params.N > SCRYPT_PARAMS.N ||
    params.r > SCRYPT_PARAMS.r ||
    params.p > SCRYPT_PARAMS.p
  )
    throw new Error("Unsupported PIN record");
  return scryptSync(pin, String(record.salt), 32, {
    ...params,
    maxmem: SCRYPT_MAXMEM,
  });
}
/** Stored ciphertext failed to decrypt. Never carries any payload text. */
export class VaultCorruptError extends Error {
  constructor() {
    super(
      "Vault data could not be decrypted (corrupted or from another device). Wipe the vault to start over.",
    );
    this.name = "VaultCorruptError";
  }
}
const CATEGORIES = [
  "name",
  "address",
  "city",
  "phone",
  "email",
  "family",
  "school",
  "plate",
  "custom",
] as const;
export type Category = (typeof CATEGORIES)[number];
interface VaultEntry {
  id: string;
  category: Category;
  text: string;
  blockedTermId?: string;
}

/** The encryption key is OS protected; no plaintext fallback is permitted. */
export class Vault {
  private key: Buffer;
  private unlockedUntil = 0;
  /** True when the stored ciphertext failed authentication. */
  corrupted = false;
  constructor(
    private readonly store: Store,
    private readonly os: SafeStorage,
    platform: string = process.platform,
  ) {
    requireRealKeyring(os, platform);
    if (!os.isEncryptionAvailable())
      throw new Error(
        "OS encryption unavailable. Vault is locked until secure storage is available.",
      );
    this.key = this.loadKey();
    // Probe once so a damaged vault is flagged instead of thrown at startup.
    this.terms();
  }
  private loadKey(): Buffer {
    let wrapped = this.store.get<unknown>("vaultKey", undefined);
    if (typeof wrapped !== "string" || !wrapped) {
      wrapped = this.os
        .encryptString(randomBytes(32).toString("hex"))
        .toString("base64");
      this.store.set("vaultKey", wrapped);
    }
    const key = Buffer.from(
      this.os.decryptString(Buffer.from(wrapped as string, "base64")),
      "hex",
    );
    if (key.length !== 32) throw new Error("Invalid vault encryption key");
    return key;
  }
  /** Decrypts the vault; throws VaultCorruptError on any failure. */
  private read(): VaultEntry[] {
    const value = this.store.get<unknown>("vault", undefined);
    if (value === undefined) {
      this.corrupted = false;
      return [];
    }
    try {
      const v = value as { iv: string; tag: string; body: string };
      const iv = Buffer.from(v.iv, "base64"),
        tag = Buffer.from(v.tag, "base64");
      if (iv.length !== 12 || tag.length !== 16) throw new Error("shape");
      const decipher = createDecipheriv("aes-256-gcm", this.key, iv, {
        authTagLength: 16,
      });
      decipher.setAuthTag(tag);
      const entries = JSON.parse(
        Buffer.concat([
          decipher.update(Buffer.from(v.body, "base64")),
          decipher.final(),
        ]).toString("utf8"),
      ) as unknown;
      if (!Array.isArray(entries)) throw new Error("shape");
      this.corrupted = false;
      return entries as VaultEntry[];
    } catch {
      // Swallow the cause: a JSON error message would quote decrypted text.
      this.corrupted = true;
      throw new VaultCorruptError();
    }
  }
  private write(entries: VaultEntry[]): void {
    const iv = randomBytes(12),
      cipher = createCipheriv("aes-256-gcm", this.key, iv);
    const body = Buffer.concat([
      cipher.update(JSON.stringify(entries), "utf8"),
      cipher.final(),
    ]);
    this.store.set("vault", {
      iv: iv.toString("base64"),
      tag: cipher.getAuthTag().toString("base64"),
      body: body.toString("base64"),
    });
  }
  hasPin(): boolean {
    const record = this.store.get<unknown>("vaultPin", undefined);
    return Boolean(record && typeof record === "object");
  }
  setPin(pin: string): void {
    if (this.hasPin() && Date.now() > this.unlockedUntil)
      throw new Error("Unlock vault before changing PIN");
    if (!/^\d{6,12}$/.test(pin))
      throw new Error("Choose a PIN with 6–12 digits");
    const record: PinRecord = {
      salt: randomBytes(16).toString("hex"),
      hash: "",
      ...SCRYPT_PARAMS,
    };
    record.hash = pinHash(pin, record).toString("hex");
    this.store.set("vaultPin", record);
  }
  private lockout(): Lockout {
    const raw = this.store.get<unknown>("vaultLockout", undefined) as
      | Record<string, unknown>
      | undefined;
    const num = (v: unknown) =>
      typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : 0;
    const lockout = {
      failed: num(raw?.failed),
      blockedUntil: num(raw?.blockedUntil),
      strikes: num(raw?.strikes),
    };
    // A clock moved backwards must not stretch a lockout past its maximum.
    lockout.blockedUntil = Math.min(
      lockout.blockedUntil,
      Date.now() + MAX_LOCKOUT_MS,
    );
    return lockout;
  }
  /** Milliseconds until another PIN attempt is accepted. */
  lockoutRemaining(): number {
    return Math.max(0, this.lockout().blockedUntil - Date.now());
  }
  /** Failures and backoff strikes persist, so restarting cannot reset them. */
  unlock(pin: string): void {
    const lockout = this.lockout();
    const wait = lockout.blockedUntil - Date.now();
    if (wait > 0)
      throw new Error(
        `Too many PIN attempts; try again in ${Math.ceil(wait / 60000)} min`,
      );
    const record = this.store.get<unknown>("vaultPin", undefined) as
      | PinRecord
      | undefined;
    let ok = false;
    try {
      const expected = Buffer.from(String(record?.hash ?? ""), "hex");
      ok =
        Boolean(record) &&
        expected.length === 32 &&
        timingSafeEqual(pinHash(String(pin), record!), expected);
    } catch {
      ok = false;
    }
    if (!ok) {
      lockout.failed++;
      if (lockout.failed >= ATTEMPTS_PER_LOCKOUT) {
        lockout.strikes++;
        lockout.blockedUntil = Date.now() + lockoutMs(lockout.strikes);
        lockout.failed = 0;
      }
      this.store.set("vaultLockout", lockout);
      throw new Error("Incorrect vault PIN");
    }
    this.store.set("vaultLockout", { failed: 0, blockedUntil: 0, strikes: 0 });
    this.unlockedUntil = Date.now() + 30000;
  }
  /** Destructive changes need the PIN, or a vault unlocked moments ago. */
  authorize(pin: string | undefined, action: string): void {
    if (!this.hasPin()) return;
    if (pin) this.unlock(pin);
    else if (Date.now() > this.unlockedUntil)
      throw new Error(`Enter your vault PIN to ${action}`);
  }
  list(): { id: string; category: Category; optedIn: boolean }[] {
    return this.terms().map((e) => ({
      id: e.id,
      category: e.category,
      optedIn: Boolean(e.blockedTermId),
    }));
  }
  reveal(id: string): string {
    if (Date.now() > this.unlockedUntil)
      throw new Error("Unlock with your app PIN first");
    const entry = this.read().find((e) => e.id === id);
    if (!entry) throw new Error("Vault entry not found");
    return entry.text;
  }
  add(text: string, category: Category): string {
    if (!CATEGORIES.includes(category) || !text.trim() || text.length > 500)
      throw new Error("Choose a category and a term of 1–500 characters");
    const entries = this.read(),
      id = randomUUID();
    if (entries.length >= 1000)
      throw new Error("Vault capacity is 1000 entries");
    entries.push({ id, text: text.trim(), category });
    this.write(entries);
    return id;
  }
  remove(id: string, pin?: string): void {
    this.authorize(pin, "delete a term");
    this.write(this.read().filter((e) => e.id !== id));
  }
  edit(id: string, text: string, category: Category): void {
    if (Date.now() > this.unlockedUntil)
      throw new Error("Unlock before editing");
    if (!CATEGORIES.includes(category) || !text.trim() || text.length > 500)
      throw new Error("Invalid private term");
    const entries = this.read(),
      entry = entries.find((e) => e.id === id);
    if (!entry) throw new Error("Vault entry not found");
    if (entry.blockedTermId)
      throw new Error("Remove the Twitch blocked-term opt-in before editing");
    entry.text = text.trim();
    entry.category = category;
    this.write(entries);
  }
  /** Readers degrade to an empty vault on corruption instead of crashing. */
  terms(): VaultEntry[] {
    try {
      return this.read();
    } catch (error) {
      if (!(error instanceof VaultCorruptError)) throw error;
      console.warn("VEIL vault: stored ciphertext failed authentication");
      return [];
    }
  }
  markOptIn(id: string, blockedTermId: string | undefined): void {
    this.write(
      this.read().map((e) => (e.id === id ? { ...e, blockedTermId } : e)),
    );
  }
  wipe(pin?: string): void {
    this.authorize(pin, "wipe the vault");
    // Rotate the key as well: any ciphertext copy left in a backup, a free
    // page or the WAL becomes permanently undecryptable.
    this.store.remove("vault");
    this.store.remove("vaultKey");
    this.key.fill(0);
    this.key = this.loadKey();
    this.store.checkpoint();
    this.corrupted = false;
    this.unlockedUntil = 0;
  }
  dispose(): void {
    this.key.fill(0);
    this.unlockedUntil = 0;
  }
}
export function tokenPersistence(
  store: Store,
  os: SafeStorage,
  platform: string = process.platform,
): TokenPersistence {
  return {
    load() {
      const encrypted = store.get<string | undefined>(
        "twitchTokens",
        undefined,
      );
      return encrypted
        ? (JSON.parse(
            os.decryptString(Buffer.from(encrypted, "base64")),
          ) as Tokens)
        : undefined;
    },
    save(tokens) {
      requireRealKeyring(os, platform);
      if (!os.isEncryptionAvailable())
        throw new Error("OS encryption required for tokens");
      store.set(
        "twitchTokens",
        os.encryptString(JSON.stringify(tokens)).toString("base64"),
      );
    },
    clear() {
      store.remove("twitchTokens");
    },
  };
}
