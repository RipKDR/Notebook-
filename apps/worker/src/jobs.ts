import {
  compile,
  LocalTrigramEmbeddings,
  VoyageEmbeddings,
  asFragmentId,
  asProjectId,
  emptyCompileState,
  newId,
  type BatchLike,
  type CompileProgress,
  type CompileResult,
  type CompileState,
  type EmbeddingProvider,
  type Fragment,
  type LlmLike,
  type WorkForm,
} from "@loom/core";
import type { Entitlement } from "./entitlements.js";
import {
  JobStore,
  isTerminal,
  type CompileResultRecord,
  type JobStatus,
  type PersistedJob,
  type PersistedRequest,
} from "./job-store.js";

/**
 * The compile job queue.
 *
 * A full compile runs for minutes and sometimes the better part of an hour — the
 * drafting stage goes through the Batch API, which trades latency for half
 * price. That is far too long to hold an HTTP request open across a phone
 * backgrounding or a tunnel, so compiles are jobs: the client starts one, gets
 * an id, and polls.
 *
 * State lives in SQLite rather than in this process. A deploy in the middle of a
 * compile used to destroy work the user had already been charged for and leave
 * the polling client with a 404; now the job is picked up on the next boot and
 * resumed from its last stage boundary, so the restart costs the stage in flight
 * rather than the book.
 *
 * What is still in memory is only what cannot be serialised: the
 * `AbortController` for a run currently in flight.
 */

export type { JobStatus } from "./job-store.js";

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
}

/**
 * Called once a job reaches a terminal state, with the model spend and whether
 * it produced a manuscript.
 *
 * This is what returns a reserved compile to an account whose job failed —
 * charging someone for a book they never got is the fastest way to lose them. It
 * belongs to the queue rather than to a request because a job recovered after a
 * restart has no request object left to carry a closure on.
 */
export type SettleHook = (account: string, spentUsd: number, produced: boolean) => void;

export interface QueueOptions {
  readonly apiKey?: string;
  readonly voyageApiKey?: string;
  /** Concurrent compiles. Each one is mostly waiting on the API, but each also holds a manuscript in memory. */
  readonly concurrency?: number;
  /** How long a finished job's result is retained for collection. */
  readonly retentionMs?: number;
  /** Where job state is persisted. Defaults to an in-memory store, which is what tests want. */
  readonly store?: JobStore;
  readonly onSettled?: SettleHook;
  /**
   * How many times a job may be started before we give up on it.
   *
   * A job that kills the worker mid-compile would otherwise be picked up again
   * on every boot, taking the service down in a loop and spending the account's
   * budget on each pass.
   */
  readonly maxAttempts?: number;
  /**
   * Model clients, injectable for testing, mirroring the same seam on
   * `compile()`. A factory rather than an instance because each job gets its own
   * pair — sharing them across concurrent compiles would interleave their call
   * logs and their budgets.
   *
   * Production callers omit this and get real clients built from `apiKey`.
   */
  readonly models?: () => { llm: LlmLike; batch: BatchLike };
}

/** The queue's view of a job: what is on disk, plus whether it is live in this process. */
export interface JobView extends PersistedJob {
  readonly live: boolean;
}

export class CompileQueue {
  private readonly store: JobStore;
  private readonly pending: string[] = [];
  private readonly live = new Map<string, AbortController>();
  private running = 0;

  private readonly concurrency: number;
  private readonly retentionMs: number;
  private readonly maxAttempts: number;
  private readonly embeddings: EmbeddingProvider;

  constructor(private readonly opts: QueueOptions = {}) {
    this.concurrency = opts.concurrency ?? 2;
    this.retentionMs = opts.retentionMs ?? 6 * 60 * 60 * 1000;
    this.maxAttempts = opts.maxAttempts ?? 3;
    this.store = opts.store ?? JobStore.open(":memory:");
    this.embeddings =
      opts.voyageApiKey !== undefined
        ? new VoyageEmbeddings(opts.voyageApiKey)
        : new LocalTrigramEmbeddings();
  }

  enqueue(request: CompileRequest): JobView {
    const id = newId();
    this.store.create({
      id,
      account: request.account,
      createdAt: Date.now(),
      request: toPersisted(request),
    });
    this.pending.push(id);
    this.sweep();
    this.pump();
    return this.get(id)!;
  }

  /**
   * Picks up jobs that were queued or in flight when the process stopped.
   *
   * Called once at boot, before the server accepts traffic. A job that has
   * already burned its attempts is failed here rather than retried, and its
   * reservation released, so the account is not left holding a quota slot for a
   * compile that will never run.
   */
  recover(): { resumed: number; abandoned: number } {
    let resumed = 0;
    let abandoned = 0;

    for (const job of this.store.interrupted()) {
      if (job.attempts >= this.maxAttempts) {
        this.settle(job.id, "failed", {
          error: `Abandoned after ${job.attempts} interrupted attempts.`,
        });
        abandoned++;
        continue;
      }
      this.pending.push(job.id);
      resumed++;
    }

    this.pump();
    return { resumed, abandoned };
  }

  get(id: string): JobView | null {
    const job = this.store.get(id);
    return job === null ? null : { ...job, live: this.live.has(id) };
  }

  listForAccount(account: string, limit?: number): readonly JobView[] {
    return this.store
      .listForAccount(account, limit)
      .map((job) => ({ ...job, live: this.live.has(job.id) }));
  }

  cancel(id: string): boolean {
    const job = this.store.get(id);
    if (job === null) return false;
    if (isTerminal(job.status)) return false;

    const controller = this.live.get(id);
    if (controller !== undefined) {
      // A running compile aborts at its next stage boundary and settles there.
      controller.abort();
      return true;
    }

    // Still queued: drop it before it ever starts.
    const index = this.pending.indexOf(id);
    if (index >= 0) this.pending.splice(index, 1);
    this.settle(id, "cancelled", {});
    return true;
  }

  stats(): { queued: number; running: number; total: number } {
    return { ...this.store.stats(), queued: this.pending.length, running: this.running };
  }

  close(): void {
    if (this.opts.store === undefined) this.store.close();
  }

  private pump(): void {
    while (this.running < this.concurrency && this.pending.length > 0) {
      const id = this.pending.shift();
      if (id === undefined) break;
      this.running++;
      void this.run(id).finally(() => {
        this.running--;
        this.pump();
      });
    }
  }

  private async run(id: string): Promise<void> {
    const job = this.store.get(id);
    if (job === null) return;
    if (isTerminal(job.status)) return;

    const controller = new AbortController();
    this.live.set(id, controller);

    // Resume from the furthest stage boundary this job reached, falling back to
    // whatever the client uploaded. Resumption is not a special path in the
    // compiler: a checkpoint is a `CompileState`, so the incremental build
    // reuses the Bible, the outline and every drafted scene by content key.
    const previous = job.checkpoint ?? job.request.previousState;
    const budgetUsd = job.request.entitlement.budgetUsd - job.priorSpendUsd;

    if (budgetUsd <= 0) {
      this.live.delete(id);
      this.settle(id, "failed", {
        error: "This compile has already spent its budget across earlier attempts.",
      });
      return;
    }

    this.store.markRunning(id);
    let spent = 0;

    try {
      const result = await compile({
        project: {
          id: asProjectId(job.request.projectId),
          title: job.request.title,
          form: job.request.form,
          targetWords: job.request.targetWords,
          createdAt: job.createdAt,
          updatedAt: job.createdAt,
          archivedAt: null,
        },
        fragments: job.request.fragments.map(toFragment),
        previous: previous ?? emptyCompileState,
        embeddings: this.embeddings,
        budgetUsd,
        skipRevision: !job.request.entitlement.revision,
        ...(this.opts.apiKey !== undefined ? { apiKey: this.opts.apiKey } : {}),
        ...(this.opts.models !== undefined ? this.opts.models() : {}),
        signal: controller.signal,
        onProgress: (progress: CompileProgress) => {
          spent = progress.spentUsd;
          this.store.saveProgress(id, progress);
        },
        onCheckpoint: (state: CompileState) => {
          this.store.saveCheckpoint(id, state);
        },
      });

      spent = result.costUsd;
      this.live.delete(id);
      this.settle(id, "complete", { result: toRecord(result), spentUsd: job.priorSpendUsd + spent });
    } catch (err: unknown) {
      this.live.delete(id);
      const cancelled = controller.signal.aborted;

      // Bank what this attempt spent so a resumed run cannot exceed the
      // entitlement's ceiling by starting a fresh budget each time.
      this.store.addPriorSpend(id, spent);

      this.settle(id, cancelled ? "cancelled" : "failed", {
        error: err instanceof Error ? err.message : String(err),
        spentUsd: job.priorSpendUsd + spent,
      });
    }
  }

  /**
   * Moves a job to a terminal state and settles its reservation exactly once.
   *
   * The settlement claim is a conditional UPDATE, so two paths racing to finish
   * the same job — a cancellation and the compile's own rejection, say — cannot
   * both release the account's quota.
   */
  private settle(
    id: string,
    status: JobStatus,
    outcome: { result?: CompileResultRecord; error?: string; spentUsd?: number },
  ): void {
    const job = this.store.get(id);
    if (job === null) return;

    this.store.finish(id, status, {
      ...(outcome.result !== undefined ? { result: outcome.result } : {}),
      ...(outcome.error !== undefined ? { error: outcome.error } : {}),
    });

    if (this.store.claimSettlement(id)) {
      this.opts.onSettled?.(job.account, outcome.spentUsd ?? 0, status === "complete");
    }
  }

  private sweep(): void {
    this.store.sweep(Date.now() - this.retentionMs);
  }
}

function toPersisted(request: CompileRequest): PersistedRequest {
  return {
    projectId: request.projectId,
    title: request.title,
    form: request.form,
    targetWords: request.targetWords,
    fragments: request.fragments,
    previousState: request.previousState,
    entitlement: request.entitlement,
  };
}

/** Trims the compile result to what a client ever reads back. */
function toRecord(result: CompileResult): CompileResultRecord {
  return {
    compileId: result.compileId,
    state: result.state,
    manuscript: { scenes: result.manuscript.scenes },
    coverage: result.coverage,
    reusedScenes: result.reusedScenes,
    rebuiltScenes: result.rebuiltScenes,
    continuityIssues: result.continuityIssues,
    continuityAssessment: result.continuityAssessment,
    unusedFragments: result.unusedFragments.map((u) => ({
      fragmentId: u.fragmentId as string,
      reason: u.reason,
    })),
    costUsd: result.costUsd,
    words: result.words,
  };
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
