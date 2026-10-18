import path from "node:path";
import { mkdirSync, realpathSync } from "node:fs";
import Database from "better-sqlite3";

/** DELETE-journal SQLite supplies crash-released SHARED/EXCLUSIVE OS locks.
 * This file has no semantic state or publication pointer. Index work/readers of
 * mutable staging state share the lease; GC requires exclusive maintenance.
 */
export class IndexLease {
  private readonly db: Database.Database;
  readonly directory: string;
  constructor(directory: string, readonly mode: "work" | "maintenance") {
    this.directory = realpathSync(directory);
    this.db = new Database(path.join(this.directory, ".semantic-maintenance.sqlite"), { timeout: 0 });
    try {
      if (this.db.pragma("journal_mode", { simple: true }) !== "delete") this.db.pragma("journal_mode=DELETE");
      if (this.db.pragma("journal_mode", { simple: true }) !== "delete") throw Error("Maintenance lock requires DELETE journaling");
      if (!this.db.prepare("SELECT 1 FROM sqlite_master WHERE name='lease'").get()) {
        try { this.db.exec("CREATE TABLE IF NOT EXISTS lease(id INTEGER PRIMARY KEY)"); }
        catch (error) { if (!this.db.prepare("SELECT 1 FROM sqlite_master WHERE name='lease'").get()) throw error; }
      }
      if (mode === "maintenance") this.db.exec("BEGIN EXCLUSIVE");
      else { this.db.exec("BEGIN"); this.db.prepare("SELECT id FROM lease LIMIT 1").get(); }
    } catch (error) {
      this.db.close();
      throw Object.assign(Error(`Index maintenance/index work is already active or its lock is unavailable: ${String(error)}`), { code: "INDEX_MAINTENANCE_BUSY" });
    }
  }
  get active(): boolean { return this.db.open && this.db.inTransaction; }
  close(): void { if (this.db.open) { if (this.db.inTransaction) this.db.exec("ROLLBACK"); this.db.close(); } }
}

export async function withIndexWork<T>(directory: string, operation: () => Promise<T>): Promise<T> {
  mkdirSync(directory, { recursive: true });
  await (await import("./authority-migration.js")).prepareAuthorityMigration(directory,{storageOnly:true});
  const lease = new IndexLease(directory, "work");
  try { return await operation(); } finally { lease.close(); }
}
