import { DatabaseSync } from "node:sqlite";

/**
 * Persisted usage counters.
 *
 * Quota enforcement that resets whenever the process restarts is not
 * enforcement. This keeps counts on disk, keyed by account and billing period,
 * so a restart — or a crash mid-compile — cannot hand someone an extra
 * full-length book.
 *
 * A compile is reserved *before* it runs and released if it fails to start, so
 * two requests racing cannot both slip under the limit.
 */

export interface PeriodUsage {
  readonly compilesThisPeriod: number;
  readonly periodResetsAt: number;
}

const PERIOD_MS = 30 * 24 * 60 * 60 * 1000;

export class UsageStore {
  constructor(private readonly db: DatabaseSync) {
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS usage (
        account       TEXT NOT NULL,
        period_start  INTEGER NOT NULL,
        compiles      INTEGER NOT NULL DEFAULT 0,
        spent_usd     REAL NOT NULL DEFAULT 0,
        PRIMARY KEY (account, period_start)
      );
    `);
  }

  static open(path: string = ":memory:"): UsageStore {
    return new UsageStore(new DatabaseSync(path));
  }

  /** Fixed 30-day windows anchored to the epoch, so the boundary never drifts. */
  private periodStart(now: number = Date.now()): number {
    return Math.floor(now / PERIOD_MS) * PERIOD_MS;
  }

  read(account: string, now: number = Date.now()): PeriodUsage {
    const start = this.periodStart(now);
    const row = this.db
      .prepare(`SELECT compiles FROM usage WHERE account = ? AND period_start = ?`)
      .get(account, start) as { compiles: number } | undefined;

    return {
      compilesThisPeriod: row?.compiles ?? 0,
      periodResetsAt: start + PERIOD_MS,
    };
  }

  /**
   * Claims one compile against the account's allowance.
   *
   * The check and the increment are one statement, so concurrent requests cannot
   * both read "0 used" and both proceed.
   */
  reserve(account: string, limit: number, now: number = Date.now()): boolean {
    const start = this.periodStart(now);
    const result = this.db
      .prepare(
        `INSERT INTO usage (account, period_start, compiles) VALUES (?, ?, 1)
         ON CONFLICT(account, period_start) DO UPDATE SET compiles = compiles + 1
         WHERE compiles < ?`,
      )
      .run(account, start, limit);
    return Number(result.changes) > 0;
  }

  /** Returns a reservation when a job could not be started. */
  release(account: string, now: number = Date.now()): void {
    const start = this.periodStart(now);
    this.db
      .prepare(
        `UPDATE usage SET compiles = MAX(0, compiles - 1)
          WHERE account = ? AND period_start = ?`,
      )
      .run(account, start);
  }

  /** Records actual model spend, for reconciliation against what we charged. */
  recordSpend(account: string, usd: number, now: number = Date.now()): void {
    const start = this.periodStart(now);
    this.db
      .prepare(
        `INSERT INTO usage (account, period_start, compiles, spent_usd) VALUES (?, ?, 0, ?)
         ON CONFLICT(account, period_start) DO UPDATE SET spent_usd = spent_usd + ?`,
      )
      .run(account, start, usd, usd);
  }

  spentThisPeriod(account: string, now: number = Date.now()): number {
    const row = this.db
      .prepare(`SELECT spent_usd FROM usage WHERE account = ? AND period_start = ?`)
      .get(account, this.periodStart(now)) as { spent_usd: number } | undefined;
    return row?.spent_usd ?? 0;
  }

  close(): void {
    this.db.close();
  }
}
