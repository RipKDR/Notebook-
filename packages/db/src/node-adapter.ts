import { DatabaseSync } from "node:sqlite";
import type { SqlAdapter, SqlValue } from "./adapter.js";

/**
 * Node adapter, backed by the built-in `node:sqlite`.
 *
 * Used by the compile worker and by the test suite, which means the tests
 * exercise the real schema against a real SQLite — triggers, FTS5, foreign keys
 * and all — rather than a hand-rolled fake that would agree with whatever the
 * code happens to do.
 *
 * `node:sqlite` is synchronous. The interface is async because the phone's
 * driver is, and async is the superset; the promises here resolve immediately.
 *
 * Requires Node 22.5+ with `--experimental-sqlite`, or Node 24+ where it is
 * stable.
 */
export class NodeSqliteAdapter implements SqlAdapter {
  private depth = 0;

  constructor(private readonly db: DatabaseSync) {}

  static open(path: string = ":memory:"): NodeSqliteAdapter {
    return new NodeSqliteAdapter(new DatabaseSync(path));
  }

  async exec(sql: string): Promise<void> {
    this.db.exec(sql);
  }

  async run(sql: string, params: readonly SqlValue[] = []): Promise<{ changes: number }> {
    const result = this.db.prepare(sql).run(...(params as SqlValue[]));
    return { changes: Number(result.changes) };
  }

  async all<T>(sql: string, params: readonly SqlValue[] = []): Promise<T[]> {
    return this.db.prepare(sql).all(...(params as SqlValue[])) as T[];
  }

  async first<T>(sql: string, params: readonly SqlValue[] = []): Promise<T | null> {
    const row = this.db.prepare(sql).get(...(params as SqlValue[]));
    return (row as T | undefined) ?? null;
  }

  /**
   * Nested calls join the outer transaction via savepoints rather than opening
   * a second one, which SQLite does not allow. Repository methods call each
   * other freely, so a naive BEGIN here would fail at runtime on exactly the
   * multi-step writes that most need to be atomic.
   */
  async transaction<T>(fn: () => Promise<T>): Promise<T> {
    const nested = this.depth > 0;
    const name = `sp_${this.depth}`;
    this.depth++;

    this.db.exec(nested ? `SAVEPOINT ${name}` : "BEGIN");
    try {
      const result = await fn();
      this.db.exec(nested ? `RELEASE ${name}` : "COMMIT");
      return result;
    } catch (err: unknown) {
      this.db.exec(nested ? `ROLLBACK TO ${name}; RELEASE ${name}` : "ROLLBACK");
      throw err;
    } finally {
      this.depth--;
    }
  }

  close(): void {
    this.db.close();
  }
}
