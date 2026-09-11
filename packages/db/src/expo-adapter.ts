import type { SqlAdapter, SqlValue } from "./adapter.js";

/**
 * The shape of `expo-sqlite`'s async database, declared structurally.
 *
 * Declaring the handful of methods we use, rather than importing the package,
 * keeps `@loom/db` free of a React Native dependency. The worker and the test
 * suite can then import this package on plain Node without pulling in a native
 * module they have no way to build.
 */
export interface ExpoSQLiteDatabase {
  execAsync(sql: string): Promise<void>;
  runAsync(sql: string, params: unknown[]): Promise<{ changes: number; lastInsertRowId: number }>;
  getAllAsync<T>(sql: string, params: unknown[]): Promise<T[]>;
  getFirstAsync<T>(sql: string, params: unknown[]): Promise<T | null>;
  withTransactionAsync(task: () => Promise<void>): Promise<void>;
}

export class ExpoSqliteAdapter implements SqlAdapter {
  private depth = 0;

  constructor(private readonly db: ExpoSQLiteDatabase) {}

  async exec(sql: string): Promise<void> {
    await this.db.execAsync(sql);
  }

  async run(sql: string, params: readonly SqlValue[] = []): Promise<{ changes: number }> {
    const result = await this.db.runAsync(sql, params as unknown[]);
    return { changes: result.changes };
  }

  async all<T>(sql: string, params: readonly SqlValue[] = []): Promise<T[]> {
    return this.db.getAllAsync<T>(sql, params as unknown[]);
  }

  async first<T>(sql: string, params: readonly SqlValue[] = []): Promise<T | null> {
    return this.db.getFirstAsync<T>(sql, params as unknown[]);
  }

  /**
   * `withTransactionAsync` returns void, so the result has to be smuggled out
   * through a closure. Nested calls use savepoints for the same reason as the
   * Node adapter: SQLite has no nested BEGIN.
   */
  async transaction<T>(fn: () => Promise<T>): Promise<T> {
    if (this.depth > 0) {
      const name = `sp_${this.depth}`;
      this.depth++;
      await this.db.execAsync(`SAVEPOINT ${name}`);
      try {
        const result = await fn();
        await this.db.execAsync(`RELEASE ${name}`);
        return result;
      } catch (err: unknown) {
        await this.db.execAsync(`ROLLBACK TO ${name}; RELEASE ${name}`);
        throw err;
      } finally {
        this.depth--;
      }
    }

    this.depth++;
    let captured: T;
    let captureSet = false;
    try {
      await this.db.withTransactionAsync(async () => {
        captured = await fn();
        captureSet = true;
      });
    } finally {
      this.depth--;
    }
    if (!captureSet) {
      throw new Error("Transaction completed without producing a result");
    }
    return captured!;
  }
}
