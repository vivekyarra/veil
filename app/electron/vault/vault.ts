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
  private readonly key: Buffer;
  private unlockedUntil = 0;
  constructor(
    private readonly store: Store,
    private readonly os: SafeStorage,
  ) {
    if (!os.isEncryptionAvailable())
      throw new Error(
        "OS encryption unavailable. Vault is locked until secure storage is available.",
      );
    let wrapped = store.get<string | undefined>("vaultKey", undefined);
    if (!wrapped) {
      wrapped = os
        .encryptString(randomBytes(32).toString("hex"))
        .toString("base64");
      store.set("vaultKey", wrapped);
    }
    this.key = Buffer.from(
      os.decryptString(Buffer.from(wrapped, "base64")),
      "hex",
    );
    if (this.key.length !== 32) throw new Error("Invalid vault encryption key");
  }
  private read(): VaultEntry[] {
    const value = this.store.get<
      { iv: string; tag: string; body: string } | undefined
    >("vault", undefined);
    if (!value) return [];
    const decipher = createDecipheriv(
      "aes-256-gcm",
      this.key,
      Buffer.from(value.iv, "base64"),
    );
    decipher.setAuthTag(Buffer.from(value.tag, "base64"));
    return JSON.parse(
      Buffer.concat([
        decipher.update(Buffer.from(value.body, "base64")),
        decipher.final(),
      ]).toString("utf8"),
    ) as VaultEntry[];
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
    return Boolean(this.store.get("vaultPin", undefined));
  }
  setPin(pin: string): void {
    if (this.hasPin() && Date.now() > this.unlockedUntil)
      throw new Error("Unlock vault before changing PIN");
    if (!/^\d{6,12}$/.test(pin))
      throw new Error("Choose a PIN with 6–12 digits");
    const salt = randomBytes(16).toString("hex");
    this.store.set("vaultPin", {
      salt,
      hash: scryptSync(pin, salt, 32).toString("hex"),
    });
  }
  private failed = 0;
  private blockedUntil = 0;
  unlock(pin: string): void {
    if (Date.now() < this.blockedUntil)
      throw new Error("Too many PIN attempts; wait one minute");
    const record = this.store.get<{ salt: string; hash: string } | undefined>(
      "vaultPin",
      undefined,
    );
    if (
      !record ||
      !timingSafeEqual(
        scryptSync(pin, record.salt, 32),
        Buffer.from(record.hash, "hex"),
      )
    ) {
      this.failed++;
      if (this.failed >= 5) {
        this.blockedUntil = Date.now() + 60000;
        this.failed = 0;
      }
      throw new Error("Incorrect vault PIN");
    }
    this.failed = 0;
    this.unlockedUntil = Date.now() + 30000;
  }
  list(): { id: string; category: Category; optedIn: boolean }[] {
    return this.read().map((e) => ({
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
  remove(id: string): void {
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
  terms(): VaultEntry[] {
    return this.read();
  }
  markOptIn(id: string, blockedTermId: string | undefined): void {
    this.write(
      this.read().map((e) => (e.id === id ? { ...e, blockedTermId } : e)),
    );
  }
  wipe(): void {
    this.store.remove("vault");
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
