import { DatabaseSync } from "node:sqlite";
import type { CompileProgress, CompileState } from "@loom/core";
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
  readonly form: "fiction" | "memoir";
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
  readonly request: PersistedRequest;
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
        settled         INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS jobs_status   ON jobs(status);
      CREATE INDEX IF NOT EXISTS jobs_finished ON jobs(finished_at);
      CREATE INDEX IF NOT EXISTS jobs_account  ON jobs(account, created_at DESC);
    `);
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
   * Marks a job as running and counts the attempt.
   *
   * The attempt counter is incremented here rather than on enqueue because it
   * exists to bound *restart* loops: a job that crashes the worker on every boot
   * must eventually be given up on rather than crash-looping the service.
   */
  markRunning(id: string): void {
    this.db
      .prepare(`UPDATE jobs SET status = 'running', attempts = attempts + 1 WHERE id = ?`)
      .run(id);
  }

  saveProgress(id: string, progress: CompileProgress): void {
    this.db
      .prepare(`UPDATE jobs SET progress = ? WHERE id = ?`)
      .run(JSON.stringify(progress), id);
  }

  saveCheckpoint(id: string, state: CompileState): void {
    this.db
      .prepare(`UPDATE jobs SET checkpoint = ? WHERE id = ?`)
      .run(JSON.stringify(state), id);
  }

  /**
   * Banks what an attempt spent before it was interrupted.
   *
   * Called when a run ends without completing, so the next attempt's budget is
   * the entitlement minus what has already been spent on this job.
   */
  addPriorSpend(id: string, usd: number): void {
    if (usd <= 0) return;
    this.db
      .prepare(`UPDATE jobs SET prior_spend_usd = prior_spend_usd + ? WHERE id = ?`)
      .run(usd, id);
  }

  finish(
    id: string,
    status: JobStatus,
    outcome: { result?: CompileResultRecord; error?: string; finishedAt?: number } = {},
  ): void {
    this.db
      .prepare(
        `UPDATE jobs SET status = ?, result = COALESCE(?, result), error = ?, finished_at = ?
          WHERE id = ?`,
      )
      .run(
        status,
        outcome.result === undefined ? null : JSON.stringify(outcome.result),
        outcome.error ?? null,
        outcome.finishedAt ?? Date.now(),
        id,
      );
  }

  /**
   * Records that a job's usage reservation has been settled, once.
   *
   * Returns false if it was already settled. A restart mid-settlement must not
   * hand back a second compile, and a cancelled-then-recovered job must not
   * release the same reservation twice.
   */
  claimSettlement(id: string): boolean {
    const result = this.db
      .prepare(`UPDATE jobs SET settled = 1 WHERE id = ? AND settled = 0`)
      .run(id);
    return Number(result.changes) > 0;
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
    request: JSON.parse(row.request) as PersistedRequest,
    checkpoint: parse<CompileState>(row.checkpoint),
    result: parse<CompileResultRecord>(row.result),
    error: row.error,
    priorSpendUsd: Number(row.prior_spend_usd),
    createdAt: Number(row.created_at),
    finishedAt: row.finished_at === null ? null : Number(row.finished_at),
    settled: Number(row.settled) === 1,
  };
}
