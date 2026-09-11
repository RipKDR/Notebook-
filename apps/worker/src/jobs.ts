import {
  compile,
  LocalTrigramEmbeddings,
  VoyageEmbeddings,
  asFragmentId,
  asProjectId,
  emptyCompileState,
  newId,
  type CompileProgress,
  type CompileResult,
  type CompileState,
  type EmbeddingProvider,
  type Fragment,
  type WorkForm,
} from "@loom/core";
import type { Entitlement } from "./entitlements.js";

/**
 * The compile job queue.
 *
 * A full compile runs for minutes and sometimes the better part of an hour — the
 * drafting stage goes through the Batch API, which trades latency for half
 * price. That is far too long to hold an HTTP request open across a phone
 * backgrounding or a tunnel, so compiles are jobs: the client starts one, gets
 * an id, and polls.
 *
 * This implementation keeps jobs in memory with a bounded concurrency. That is
 * the right shape for a single worker process and the wrong shape for more than
 * one — a restart loses in-flight jobs. Moving to a durable queue (Postgres
 * SKIP LOCKED, or a hosted queue) is a swap of this file alone; the interface
 * the routes depend on does not change.
 */

export type JobStatus = "queued" | "running" | "complete" | "failed" | "cancelled";

export interface JobRecord {
  readonly id: string;
  /** Account that started it. Jobs are readable only by their owner. */
  readonly account: string;
  status: JobStatus;
  progress: CompileProgress | null;
  result: CompileResult | null;
  error: string | null;
  readonly createdAt: number;
  finishedAt: number | null;
  readonly controller: AbortController;
}

export interface CompileRequest {
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
  readonly account: string;
  /**
   * Called once the job reaches a terminal state, with the model spend and
   * whether it produced a manuscript. This is what returns a reserved compile to
   * an account whose job failed — charging someone for a book they never got is
   * the fastest way to lose them.
   */
  readonly onSettled?: (spentUsd: number, produced: boolean) => void;
}

export interface QueueOptions {
  readonly apiKey?: string;
  readonly voyageApiKey?: string;
  /** Concurrent compiles. Each one is mostly waiting on the API, but each also holds a manuscript in memory. */
  readonly concurrency?: number;
  /** How long a finished job's result is retained for collection. */
  readonly retentionMs?: number;
}

export class CompileQueue {
  private readonly jobs = new Map<string, JobRecord>();
  private readonly pending: { job: JobRecord; request: CompileRequest }[] = [];
  private running = 0;

  private readonly concurrency: number;
  private readonly retentionMs: number;
  private readonly embeddings: EmbeddingProvider;

  constructor(private readonly opts: QueueOptions = {}) {
    this.concurrency = opts.concurrency ?? 2;
    this.retentionMs = opts.retentionMs ?? 6 * 60 * 60 * 1000;
    this.embeddings =
      opts.voyageApiKey !== undefined
        ? new VoyageEmbeddings(opts.voyageApiKey)
        : new LocalTrigramEmbeddings();
  }

  enqueue(request: CompileRequest): JobRecord {
    const job: JobRecord = {
      id: newId(),
      account: request.account,
      status: "queued",
      progress: null,
      result: null,
      error: null,
      createdAt: Date.now(),
      finishedAt: null,
      controller: new AbortController(),
    };
    this.jobs.set(job.id, job);
    this.pending.push({ job, request });
    this.sweep();
    this.pump();
    return job;
  }

  get(id: string): JobRecord | null {
    return this.jobs.get(id) ?? null;
  }

  cancel(id: string): boolean {
    const job = this.jobs.get(id);
    if (job === undefined) return false;
    if (job.status === "complete" || job.status === "failed") return false;

    job.controller.abort();
    if (job.status === "queued") {
      const index = this.pending.findIndex((p) => p.job.id === id);
      if (index >= 0) this.pending.splice(index, 1);
      job.status = "cancelled";
      job.finishedAt = Date.now();
    }
    return true;
  }

  stats(): { queued: number; running: number; total: number } {
    return { queued: this.pending.length, running: this.running, total: this.jobs.size };
  }

  private pump(): void {
    while (this.running < this.concurrency && this.pending.length > 0) {
      const next = this.pending.shift();
      if (next === undefined) break;
      this.running++;
      void this.run(next.job, next.request).finally(() => {
        this.running--;
        this.pump();
      });
    }
  }

  private async run(job: JobRecord, request: CompileRequest): Promise<void> {
    if (job.controller.signal.aborted) {
      job.status = "cancelled";
      job.finishedAt = Date.now();
      request.onSettled?.(0, false);
      return;
    }

    job.status = "running";
    try {
      const result = await compile({
        project: {
          id: asProjectId(request.projectId),
          title: request.title,
          form: request.form,
          targetWords: request.targetWords,
          createdAt: Date.now(),
          updatedAt: Date.now(),
          archivedAt: null,
        },
        fragments: request.fragments.map(toFragment),
        previous: request.previousState ?? emptyCompileState,
        embeddings: this.embeddings,
        budgetUsd: request.entitlement.budgetUsd,
        skipRevision: !request.entitlement.revision,
        ...(this.opts.apiKey !== undefined ? { apiKey: this.opts.apiKey } : {}),
        signal: job.controller.signal,
        onProgress: (progress) => {
          job.progress = progress;
        },
      });

      job.result = result;
      job.status = "complete";
    } catch (err: unknown) {
      job.status = job.controller.signal.aborted ? "cancelled" : "failed";
      job.error = err instanceof Error ? err.message : String(err);
    } finally {
      job.finishedAt = Date.now();
      request.onSettled?.(job.result?.costUsd ?? 0, job.status === "complete");
    }
  }

  /** Drops finished jobs past their retention window so a long-lived process does not grow without bound. */
  private sweep(): void {
    const cutoff = Date.now() - this.retentionMs;
    for (const [id, job] of this.jobs) {
      if (job.finishedAt !== null && job.finishedAt < cutoff) this.jobs.delete(id);
    }
  }
}

/**
 * Rehydrates the minimal fragment shape the client uploads.
 *
 * The client deliberately does not send enrichment or embeddings: they are
 * derived data, they are large (a 1024-dimension vector per fragment), and the
 * worker can recompute anything missing. Sending only the text keeps the upload
 * small on a phone connection and keeps the worker authoritative about
 * derivation.
 */
function toFragment(input: {
  id: string;
  text: string;
  createdAt: number;
  pinned: boolean;
}): Fragment {
  return {
    id: asFragmentId(input.id),
    projectId: null,
    text: input.text,
    createdAt: input.createdAt,
    updatedAt: input.createdAt,
    source: "quick",
    deletedAt: null,
    pinned: input.pinned,
    enrichment: null,
    embedding: null,
  };
}
