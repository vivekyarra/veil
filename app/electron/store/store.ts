import Database from "better-sqlite3";
import { chmodSync } from "node:fs";

/** SQLite holds settings, ciphertext and metadata-only incident records. */
export class Store {
  private readonly db: Database.Database;
  constructor(path: string) {
    this.db = new Database(path);
    this.db.pragma("journal_mode = WAL");
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
    return row ? (JSON.parse(row.value) as T) : fallback;
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
  close(): void {
    this.db.close();
  }
}
