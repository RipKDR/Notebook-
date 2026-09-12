import { DatabaseSync } from "node:sqlite";
import type { CompileProgress, CompileState, WorkForm } from "@loom/core";
import type { Entitlement } from "./entitlements.js";

/**
 * Durable job state.
 *
 * A compile runs for minutes and sometimes the better part of an hour. Holding
 * that in a `Map` means a deploy, an OOM kill or a crashed machine silently
 * destroys work the user has already been charged for — and the client, which is
 * polling, gets a 404 for a job it watched reach 80%.
 *
 * So job state lives on disk and the process holds only what cannot be
 * serialised: the `AbortController` of a run that is currently in flight.
 * Everything a restart needs to carry on — the request, the progress, the
 * checkpoint, the finished manuscript — is here.
 *
 * The request is stored in full, fragments included, which for a large notebook
 * is a few megabytes a job. That is the price of being able to resume, and it is
 * the right trade against re-billing someone for a book they already paid for.
 */

export type JobStatus = "queued" | "running" | "complete" | "failed" | "cancelled";

/** Everything needed to run a compile, minus the parts that cannot be serialised. */
export interface PersistedRequest {
  readonly projectId: string;
  readonly title: string;
  readonly form: WorkForm;
  readonly targetWords: number;
  readonly fragments: readonly {
    id: string;
    text: string;
    createdAt: number;
    pinned: boolean;
  }[];
  readonly previousState: CompileState | null;
  readonly entitlement: Entitlement;
}

export interface PersistedJob {
  readonly id: string;
  /** Account that started it. Jobs are readable only by their owner. */
  readonly account: string;
  readonly status: JobStatus;
  /** How many times a worker has begun running this job. Bounds restart loops. */
  readonly attempts: number;
  readonly progress: CompileProgress | null;
  readonly request: PersistedRequest | null;
  /** The furthest stage boundary this job has reached. Null until the Bible is built. */
  readonly checkpoint: CompileState | null;
  readonly result: CompileResultRecord | null;
  readonly error: string | null;
  /**
   * Model spend from attempts that did not finish.
   *
   * A resumed run starts a fresh budget, so without this a job that restarts
   * three times could spend three times the entitlement's ceiling.
   */
  readonly priorSpendUsd: number;
  readonly createdAt: number;
  readonly finishedAt: number | null;
  /** Whether the usage reservation has already been settled. Guards double-release. */
  readonly settled: boolean;
  readonly workerOwner: string | null;
  readonly leaseExpiresAt: number | null;
}

/**
 * The finished compile, as stored.
 *
 * Structurally a `CompileResult`, but typed loosely here because it is read back
 * out of JSON: nothing verifies the shape of a blob written by an earlier
 * version of the worker, so pretending it is branded would be a lie.
 */
export interface CompileResultRecord {
  readonly compileId: string;
  readonly state: CompileState;
  readonly manuscript: { readonly scenes: readonly unknown[] };
  readonly coverage: number;
  readonly reusedScenes: number;
  readonly rebuiltScenes: number;
  readonly continuityIssues: readonly unknown[];
  readonly continuityAssessment: string;
  readonly unusedFragments: readonly { fragmentId: string; reason: string }[];
  readonly costUsd: number;
  readonly words: number;
}

interface JobRow {
  id: string;
  account: string;
  status: string;
  attempts: number;
  progress: string | null;
  request: string;
  checkpoint: string | null;
  result: string | null;
  error: string | null;
  prior_spend_usd: number;
  created_at: number;
  finished_at: number | null;
  settled: number;
  settlement_claimed_at: number | null;
  worker_owner: string | null;
  lease_expires_at: number | null;
}

const TERMINAL: ReadonlySet<JobStatus> = new Set<JobStatus>(["complete", "failed", "cancelled"]);

export function isTerminal(status: JobStatus): boolean {
  return TERMINAL.has(status);
}

export class JobStore {
  constructor(private readonly db: DatabaseSync) {
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = NORMAL;
      PRAGMA busy_timeout = 5000;
      CREATE TABLE IF NOT EXISTS jobs (
        id              TEXT PRIMARY KEY,
        account         TEXT NOT NULL,
        status          TEXT NOT NULL,
        attempts        INTEGER NOT NULL DEFAULT 0,
        progress        TEXT,
        request         TEXT NOT NULL,
        checkpoint      TEXT,
        result          TEXT,
        error           TEXT,
        prior_spend_usd REAL NOT NULL DEFAULT 0,
        created_at      INTEGER NOT NULL,
        finished_at     INTEGER,
        settled         INTEGER NOT NULL DEFAULT 0,
        settlement_claimed_at INTEGER,
        worker_owner    TEXT,
        lease_expires_at INTEGER
      );
      CREATE INDEX IF NOT EXISTS jobs_status   ON jobs(status);
      CREATE INDEX IF NOT EXISTS jobs_finished ON jobs(finished_at);
      CREATE INDEX IF NOT EXISTS jobs_account  ON jobs(account, created_at DESC);
    `);
    this.ensureColumns();
  }

  static open(path: string = ":memory:"): JobStore {
    return new JobStore(new DatabaseSync(path));
  }

  create(job: {
    id: string;
    account: string;
    request: PersistedRequest;
    createdAt: number;
  }): PersistedJob {
    this.db
      .prepare(
        `INSERT INTO jobs (id, account, status, request, created_at)
         VALUES (?, ?, 'queued', ?, ?)`,
      )
      .run(job.id, job.account, JSON.stringify(job.request), job.createdAt);
    return this.get(job.id)!;
  }

  get(id: string): PersistedJob | null {
    const row = this.db.prepare(`SELECT * FROM jobs WHERE id = ?`).get(id) as
      | JobRow
      | undefined;
    return row === undefined ? null : hydrate(row);
  }

  /** Jobs for one account, newest first. The client uses this to re-attach after reinstalling. */
  listForAccount(account: string, limit: number = 20): readonly PersistedJob[] {
    const rows = this.db
      .prepare(`SELECT * FROM jobs WHERE account = ? ORDER BY created_at DESC LIMIT ?`)
      .all(account, limit) as unknown as JobRow[];
    return rows.map(hydrate);
  }

  /**
   * Atomically claims a job for one worker and counts the attempt.
   *
   * The attempt counter is incremented here rather than on enqueue because it
   * exists to bound *restart* loops: a job that crashes the worker on every boot
   * must eventually be given up on rather than crash-looping the service.
   */
  markRunning(
    id: string,
    owner: string,
    leaseExpiresAt: number,
    expectedAttempts: number,
  ): boolean {
    const now = Date.now();
    const result = this.db
      .prepare(
        `UPDATE jobs
            SET status = 'running',
                attempts = attempts + 1,
                prior_spend_usd = prior_spend_usd +
                  CASE
                    WHEN progress IS NOT NULL AND json_valid(progress)
                    THEN COALESCE(CAST(json_extract(progress, '$.spentUsd') AS REAL), 0)
                    ELSE 0
                  END,
                progress =
                  CASE
                    WHEN progress IS NOT NULL AND json_valid(progress)
                    THEN json_set(progress, '$.spentUsd', 0)
                    ELSE progress
                  END,
                worker_owner = ?,
                lease_expires_at = ?
          WHERE id = ?
            AND attempts = ?
            AND (
              status = 'queued'
              OR (status = 'running' AND COALESCE(lease_expires_at, 0) <= ?)
            )`,
      )
      .run(owner, leaseExpiresAt, id, expectedAttempts, now);
    return Number(result.changes) > 0;
  }

  renewLease(id: string, owner: string, leaseExpiresAt: number): boolean {
    const result = this.db
      .prepare(
        `UPDATE jobs SET lease_expires_at = ?
          WHERE id = ? AND status = 'running' AND worker_owner = ?`,
      )
      .run(leaseExpiresAt, id, owner);
    return Number(result.changes) > 0;
  }

  saveProgress(id: string, progress: CompileProgress, owner?: string): void {
    const ownerGuard = owner === undefined ? "" : " AND worker_owner = ?";
    this.db
      .prepare(`UPDATE jobs SET progress = ? WHERE id = ?${ownerGuard}`)
      .run(
        ...(owner === undefined
          ? [JSON.stringify(progress), id]
          : [JSON.stringify(progress), id, owner]),
      );
  }

  saveCheckpoint(id: string, state: CompileState, owner?: string): void {
    const ownerGuard = owner === undefined ? "" : " AND worker_owner = ?";
    this.db
      .prepare(`UPDATE jobs SET checkpoint = ? WHERE id = ?${ownerGuard}`)
      .run(
        ...(owner === undefined
          ? [JSON.stringify(state), id]
          : [JSON.stringify(state), id, owner]),
      );
  }

  /**
   * Banks what an attempt spent before it was interrupted.
   *
   * Called when a run ends without completing, so the next attempt's budget is
   * the entitlement minus what has already been spent on this job.
   */
  addPriorSpend(id: string, usd: number, owner?: string): void {
    if (usd <= 0) return;
    const ownerGuard = owner === undefined ? "" : " AND worker_owner = ?";
    this.db
      .prepare(`UPDATE jobs SET prior_spend_usd = prior_spend_usd + ? WHERE id = ?${ownerGuard}`)
      .run(...(owner === undefined ? [usd, id] : [usd, id, owner]));
  }

  finish(
    id: string,
    status: JobStatus,
    outcome: { result?: CompileResultRecord; error?: string; finishedAt?: number } = {},
    owner?: string,
  ): boolean {
    const ownerGuard = owner === undefined ? "" : " AND status = 'running' AND worker_owner = ?";
    const result = this.db
      .prepare(
        `UPDATE jobs SET status = ?, result = COALESCE(?, result), error = ?, finished_at = ?,
                         worker_owner = NULL, lease_expires_at = NULL
          WHERE id = ?${ownerGuard}`,
      )
      .run(...[
        status,
        outcome.result === undefined ? null : JSON.stringify(outcome.result),
        outcome.error ?? null,
        outcome.finishedAt ?? Date.now(),
        id,
        ...(owner === undefined ? [] : [owner]),
      ]);
    return Number(result.changes) > 0;
  }

  /**
   * Records that a job's usage reservation has been settled, once.
   *
   * Returns false if it was already settled. A restart mid-settlement must not
   * hand back a second compile, and a cancelled-then-recovered job must not
   * release the same reservation twice.
   */
  claimSettlement(id: string): number | null {
    const token = Date.now() * 1000 + Math.floor(Math.random() * 1000);
    const result = this.db
      .prepare(
        `UPDATE jobs
            SET settlement_claimed_at = ?
          WHERE id = ?
            AND settled = 0
            AND settlement_claimed_at IS NULL`,
      )
      .run(token, id);
    return Number(result.changes) > 0 ? token : null;
  }

  completeSettlement(id: string, token: number): void {
    this.db
      .prepare(
        `UPDATE jobs
            SET settled = 1, settlement_claimed_at = NULL
          WHERE id = ? AND settled = 0 AND settlement_claimed_at = ?`,
      )
      .run(id, token);
  }

  releaseSettlementClaim(id: string, token: number): void {
    this.db
      .prepare(
        `UPDATE jobs
            SET settlement_claimed_at = NULL
          WHERE id = ? AND settled = 0 AND settlement_claimed_at = ?`,
      )
      .run(id, token);
  }

  clearSettlementClaimsOnRecovery(): void {
    this.db
      .prepare(
        `UPDATE jobs
            SET settlement_claimed_at = NULL
          WHERE settled = 0 AND status IN ('complete', 'failed', 'cancelled')`,
      )
      .run();
  }

  unsettledTerminal(): readonly PersistedJob[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM jobs WHERE settled = 0 AND status IN ('complete', 'failed', 'cancelled')`,
      )
      .all() as unknown as JobRow[];
    return rows.map(hydrate);
  }

  /** Jobs that were queued or in flight when the process stopped, oldest first. */
  interrupted(): readonly PersistedJob[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM jobs WHERE status IN ('queued', 'running') ORDER BY created_at ASC`,
      )
      .all() as unknown as JobRow[];
    return rows.map(hydrate);
  }

  /** Drops finished jobs past their retention window so the database does not grow without bound. */
  sweep(cutoff: number): number {
    const result = this.db
      .prepare(`DELETE FROM jobs WHERE finished_at IS NOT NULL AND finished_at < ?`)
      .run(cutoff);
    return Number(result.changes);
  }

  stats(): { queued: number; running: number; total: number } {
    const rows = this.db.prepare(`SELECT status, COUNT(*) AS n FROM jobs GROUP BY status`).all() as {
      status: string;
      n: number;
    }[];
    const by = new Map(rows.map((r) => [r.status, Number(r.n)]));
    return {
      queued: by.get("queued") ?? 0,
      running: by.get("running") ?? 0,
      total: [...by.values()].reduce((a, b) => a + b, 0),
    };
  }

  close(): void {
    this.db.close();
  }

  private ensureColumns(): void {
    const columns = this.db.prepare(`PRAGMA table_info(jobs)`).all() as { name: string }[];
    if (!columns.some((c) => c.name === "settlement_claimed_at")) {
      this.db.exec(`ALTER TABLE jobs ADD COLUMN settlement_claimed_at INTEGER`);
    }
    if (!columns.some((c) => c.name === "worker_owner")) {
      this.db.exec(`ALTER TABLE jobs ADD COLUMN worker_owner TEXT`);
    }
    if (!columns.some((c) => c.name === "lease_expires_at")) {
      this.db.exec(`ALTER TABLE jobs ADD COLUMN lease_expires_at INTEGER`);
    }
  }
}

function parse<T>(json: string | null): T | null {
  if (json === null) return null;
  try {
    return JSON.parse(json) as T;
  } catch {
    // A blob we cannot read is not a reason to fail the whole listing: the job's
    // status, which is what the client is polling for, is in a real column.
    return null;
  }
}

function hydrate(row: JobRow): PersistedJob {
  return {
    id: row.id,
    account: row.account,
    status: row.status as JobStatus,
    attempts: Number(row.attempts),
    progress: parse<CompileProgress>(row.progress),
    request: parse<PersistedRequest>(row.request),
    checkpoint: parse<CompileState>(row.checkpoint),
    result: parse<CompileResultRecord>(row.result),
    error: row.error,
    priorSpendUsd: Number(row.prior_spend_usd),
    createdAt: Number(row.created_at),
    finishedAt: row.finished_at === null ? null : Number(row.finished_at),
    settled: Number(row.settled) === 1,
    workerOwner: row.worker_owner,
    leaseExpiresAt: row.lease_expires_at === null ? null : Number(row.lease_expires_at),
  };
}
