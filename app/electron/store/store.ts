import Database from "better-sqlite3";
import { chmodSync } from "node:fs";

/** SQLite holds settings, ciphertext and metadata-only incident records. */
export class Store {
  private readonly db: Database.Database;
  constructor(path: string) {
    this.db = new Database(path);
    this.db.pragma("journal_mode = WAL");
    // Deleted rows are overwritten with zeros instead of lingering in free pages.
    this.db.pragma("secure_delete = ON");
    this.db.exec(
      "CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT NOT NULL)",
    );
    if (path !== ":memory:" && process.platform !== "win32")
      chmodSync(path, 0o600);
  }
  get<T>(key: string, fallback: T): T {
    const row = this.db.prepare("SELECT value FROM kv WHERE key=?").get(key) as
      | { value: string }
      | undefined;
    if (!row) return fallback;
    try {
      return JSON.parse(row.value) as T;
    } catch {
      // Never log the row: it may hold settings or ciphertext metadata.
      console.warn(`VEIL store: ignoring unreadable value for "${key}"`);
      return fallback;
    }
  }
  set(key: string, value: unknown): void {
    this.db
      .prepare(
        "INSERT INTO kv(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
      )
      .run(key, JSON.stringify(value));
  }
  remove(key: string): void {
    this.db.prepare("DELETE FROM kv WHERE key=?").run(key);
  }
  /** Fold the WAL back into the database so removed rows leave no copy. */
  checkpoint(): void {
    this.db.pragma("wal_checkpoint(TRUNCATE)");
  }
  close(): void {
    this.db.close();
  }
}
