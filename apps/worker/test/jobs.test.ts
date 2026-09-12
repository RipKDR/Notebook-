import { describe, expect, it, vi } from "vitest";
import { CompileQueue } from "../src/jobs.js";
import { JobStore } from "../src/job-store.js";
import { ENTITLEMENTS } from "../src/entitlements.js";
import { FakeBatch, FakeLlm } from "../../../packages/core/test/fake-model.js";

/**
 * The queue's contract is that a compile survives the process running it.
 *
 * These tests run real compiles through a deterministic fake model, so
 * "resumed from its checkpoint" is verified by the drafting stage genuinely not
 * being called a second time, not by a flag.
 */

const LINES = [
  "She never once said my name.",
  "The kitchen radio was always on, even when nobody was listening to it.",
  "I have no memory of the drive home, only of arriving.",
  "Every drawer in that house had string in it.",
  "She kept the good scissors in a place nobody was told about.",
  "The biscuit tins never had biscuits in them.",
  "There was a photograph on the stairs I was not allowed to ask about.",
  "My mother stopped speaking when we passed the hospital.",
  "He sent letters for eleven years and she answered none of them.",
  "The house smelled of lavender and gas.",
  "I found a second address in her handwriting, folded very small.",
  "She counted the stairs out loud, every time, until the last year.",
];

const fragments = LINES.map((text, i) => ({
  id: `f${i}`,
  text,
  createdAt: 1_700_000_000_000 + i * 1000,
  pinned: false,
}));

const request = {
  projectId: "p1",
  title: "The Kitchen Radio",
  form: "memoir" as const,
  targetWords: 10_000,
  fragments,
  previousState: null,
  entitlement: ENTITLEMENTS.paid,
  account: "acct-1",
};

const markCrashed = (store: JobStore, id: string): boolean =>
  store.markRunning(id, "crashed-test-worker", 0, store.get(id)?.attempts ?? -1);

/** A queue wired to the fake model, so a compile actually runs without a credential. */
function fakeQueue(opts: Partial<ConstructorParameters<typeof CompileQueue>[0]> = {}) {
  const seen: { llm: FakeLlm; batch: FakeBatch }[] = [];
  const queue = new CompileQueue({
    concurrency: 1,
    models: () => {
      const pair = { llm: new FakeLlm(), batch: new FakeBatch() };
      seen.push(pair);
      return pair;
    },
    ...opts,
  });
  return { queue, seen };
}

async function settled(queue: CompileQueue, id: string, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const job = queue.get(id);
    if (job !== null && ["complete", "failed", "cancelled"].includes(job.status)) return;
    if (Date.now() > deadline) throw new Error(`job ${id} did not settle: ${job?.status}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

describe("CompileQueue", () => {
  it("assigns an id and starts queued or running", () => {
    const { queue } = fakeQueue({ concurrency: 0 });
    const job = queue.enqueue(request);
    expect(job.id).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(job.status).toBe("queued");
    queue.close();
  });

  it("retrieves a job by id", () => {
    const { queue } = fakeQueue({ concurrency: 0 });
    const job = queue.enqueue(request);
    expect(queue.get(job.id)?.id).toBe(job.id);
    queue.close();
  });

  it("returns null for an unknown id", () => {
    const { queue } = fakeQueue();
    expect(queue.get("missing")).toBeNull();
    queue.close();
  });

  it("cancels a queued job without running it", () => {
    const { queue, seen } = fakeQueue({ concurrency: 0 });
    const job = queue.enqueue(request);
    expect(queue.cancel(job.id)).toBe(true);
    expect(queue.get(job.id)?.status).toBe("cancelled");
    expect(seen).toHaveLength(0);
    queue.close();
  });

  it("reports cancellation of an unknown job as unsuccessful", () => {
    const { queue } = fakeQueue();
    expect(queue.cancel("missing")).toBe(false);
    queue.close();
  });

  it("refuses to cancel a job that has already finished", async () => {
    const { queue } = fakeQueue();
    const job = queue.enqueue(request);
    await settled(queue, job.id);
    expect(queue.cancel(job.id)).toBe(false);
    queue.close();
  });

  it("respects the concurrency limit", () => {
    const { queue } = fakeQueue({ concurrency: 0 });
    queue.enqueue(request);
    queue.enqueue(request);
    const stats = queue.stats();
    expect(stats.running).toBe(0);
    expect(stats.queued).toBe(2);
    expect(stats.total).toBe(2);
    queue.close();
  });

  it("records the job's owner so it cannot be read by another account", () => {
    const { queue } = fakeQueue({ concurrency: 0 });
    const job = queue.enqueue(request);
    expect(job.account).toBe("acct-1");
    expect(queue.listForAccount("acct-1").map((j) => j.id)).toEqual([job.id]);
    expect(queue.listForAccount("someone-else")).toHaveLength(0);
    queue.close();
  });

  it("runs a compile to completion and keeps the manuscript", async () => {
    const { queue } = fakeQueue();
    const job = queue.enqueue(request);
    await settled(queue, job.id);

    const done = queue.get(job.id)!;
    expect(done.status).toBe("complete");
    expect(done.result?.words).toBeGreaterThan(0);
    expect(done.result?.manuscript.scenes.length).toBeGreaterThan(0);
    expect(done.error).toBeNull();
    queue.close();
  }, 40_000);

  it("returns the reserved compile when a job is cancelled before running", () => {
    const settledCalls: { account: string; spent: number; produced: boolean }[] = [];
    const { queue } = fakeQueue({
      concurrency: 0,
      onSettled: (account, spent, produced) => settledCalls.push({ account, spent, produced }),
    });
    const job = queue.enqueue(request);
    queue.cancel(job.id);

    expect(queue.get(job.id)?.status).toBe("cancelled");
    expect(settledCalls).toEqual([{ account: "acct-1", spent: 0, produced: false }]);
    queue.close();
  });

  it("settles a job exactly once", async () => {
    const calls: boolean[] = [];
    const { queue } = fakeQueue({ onSettled: (_a, _s, produced) => calls.push(produced) });
    const job = queue.enqueue(request);
    await settled(queue, job.id);

    // Cancelling an already-settled job must not release a second reservation.
    queue.cancel(job.id);
    expect(calls).toEqual([true]);
    queue.close();
  }, 40_000);

  it("fails a job cleanly when there is no model credential", async () => {
    // No `models` seam and no API key: the compile must reject onto the job
    // rather than becoming an unhandled rejection that takes the worker down.
    vi.stubEnv("ANTHROPIC_API_KEY", "");
    vi.stubEnv("VOYAGE_API_KEY", "");
    try {
      const queue = new CompileQueue({ concurrency: 1 });
      const job = queue.enqueue(request);
      await settled(queue, job.id);

      expect(queue.get(job.id)?.status).toBe("failed");
      expect(queue.get(job.id)?.error).toBeTruthy();
      queue.close();
    } finally {
      vi.unstubAllEnvs();
    }
  }, 40_000);
});

describe("surviving a restart", () => {
  it("hands a finished manuscript to a queue that never ran it", async () => {
    const store = JobStore.open();
    const { queue } = fakeQueue({ store });
    const job = queue.enqueue(request);
    await settled(queue, job.id);

    // The process dies and comes back. Same disk, new everything else.
    const { queue: rebooted } = fakeQueue({ store });
    const recovered = rebooted.get(job.id);
    expect(recovered?.status).toBe("complete");
    expect(recovered?.result?.manuscript.scenes.length).toBeGreaterThan(0);
    expect(recovered?.live).toBe(false);
    store.close();
  }, 40_000);

  it("resumes an interrupted job from its checkpoint without redrafting", async () => {
    const store = JobStore.open();

    // Run one compile to get a genuine, schema-valid checkpoint.
    const { queue: first } = fakeQueue({ store });
    const done = first.enqueue(request);
    await settled(first, done.id);
    const checkpoint = store.get(done.id)!.checkpoint!;
    expect(checkpoint.manuscript?.scenes.length).toBeGreaterThan(0);

    // Now stage the crash: a second job that reached the same checkpoint and
    // was still marked running when the process stopped.
    const crashed = store.create({
      id: "crashed-job",
      account: "acct-1",
      createdAt: Date.now(),
      request: { ...request, previousState: null },
    });
    markCrashed(store, crashed.id);
    store.saveCheckpoint(crashed.id, checkpoint);

    const { queue: rebooted, seen } = fakeQueue({ store });
    expect(rebooted.recover()).toEqual({ resumed: 1, abandoned: 0 });
    await settled(rebooted, crashed.id);

    expect(rebooted.get(crashed.id)?.status).toBe("complete");
    // The expensive stage is not paid for twice.
    expect(rebooted.get(crashed.id)?.result?.rebuiltScenes).toBe(0);
    expect(seen.at(-1)!.batch.stages).not.toContain("draft");
    store.close();
  }, 60_000);

  it("re-runs an interrupted job from scratch when it had no checkpoint yet", async () => {
    const store = JobStore.open();
    const crashed = store.create({
      id: "early-crash",
      account: "acct-1",
      createdAt: Date.now(),
      request,
    });
    markCrashed(store, crashed.id);

    const { queue, seen } = fakeQueue({ store });
    expect(queue.recover().resumed).toBe(1);
    await settled(queue, crashed.id);

    expect(queue.get(crashed.id)?.status).toBe("complete");
    expect(queue.get(crashed.id)?.result?.rebuiltScenes).toBeGreaterThan(0);
    expect(seen.at(-1)!.batch.stages).toContain("draft");
    store.close();
  }, 60_000);

  it("picks up a job that never got to start", async () => {
    const store = JobStore.open();
    const { queue: first } = fakeQueue({ store, concurrency: 0 });
    const job = first.enqueue(request);
    expect(first.get(job.id)?.status).toBe("queued");

    const { queue: rebooted } = fakeQueue({ store });
    expect(rebooted.recover().resumed).toBe(1);
    await settled(rebooted, job.id);
    expect(rebooted.get(job.id)?.status).toBe("complete");
    store.close();
  }, 40_000);

  it("fails an unreadable persisted request without breaking recovery", async () => {
    const store = JobStore.open();
    store.create({ id: "corrupt-request", account: "acct-1", createdAt: Date.now(), request });
    (store as unknown as { db: { exec: (sql: string) => void } }).db.exec(
      `UPDATE jobs SET request = '{not json' WHERE id = 'corrupt-request'`,
    );

    const { queue } = fakeQueue({ store });
    expect(queue.recover().resumed).toBe(1);
    await settled(queue, "corrupt-request");

    expect(queue.get("corrupt-request")).toMatchObject({
      status: "failed",
      error: expect.stringMatching(/request.*unreadable/i),
    });
    store.close();
  });

  it("gives up on a job that has already burned its attempts, and releases the quota", () => {
    const store = JobStore.open();
    const released: { account: string; produced: boolean }[] = [];
    const job = store.create({
      id: "poison",
      account: "acct-1",
      createdAt: Date.now(),
      request,
    });
    markCrashed(store, job.id);
    markCrashed(store, job.id);
    markCrashed(store, job.id);

    const { queue } = fakeQueue({
      store,
      maxAttempts: 3,
      onSettled: (account, _spent, produced) => released.push({ account, produced }),
    });
    expect(queue.recover()).toEqual({ resumed: 0, abandoned: 1 });

    const dead = queue.get(job.id)!;
    expect(dead.status).toBe("failed");
    expect(dead.error).toMatch(/abandoned/i);
    // The account must not be left holding a quota slot for a book it will
    // never receive.
    expect(released).toEqual([{ account: "acct-1", produced: false }]);
    store.close();
  });

  it("does not resume a job that had already finished", () => {
    const store = JobStore.open();
    const job = store.create({ id: "done", account: "a", createdAt: Date.now(), request });
    store.finish(job.id, "complete");

    const { queue } = fakeQueue({ store });
    expect(queue.recover()).toEqual({ resumed: 0, abandoned: 0 });
    store.close();
  });

  it("charges a resumed job only what is left of its budget", async () => {
    const store = JobStore.open();
    const job = store.create({
      id: "half-spent",
      account: "acct-1",
      createdAt: Date.now(),
      // Paid tier's ceiling, all of it already spent on the attempt that died.
      request,
    });
    markCrashed(store, job.id);
    store.addPriorSpend(job.id, ENTITLEMENTS.paid.budgetUsd);

    const { queue } = fakeQueue({ store });
    queue.recover();
    await settled(queue, job.id);

    // Starting a fresh full budget on every restart is how a $14 ceiling
    // quietly becomes $42.
    expect(queue.get(job.id)?.status).toBe("failed");
    expect(queue.get(job.id)?.error).toMatch(/budget/i);
    store.close();
  }, 40_000);

  it("reconciles a terminal unsettled job on reboot", () => {
    const store = JobStore.open();
    const settledCalls: { account: string; spent: number; produced: boolean }[] = [];
    const job = store.create({ id: "settle-me", account: "acct-1", createdAt: Date.now(), request });
    store.addPriorSpend(job.id, 1.25);
    store.finish(job.id, "complete", {
      result: {
        compileId: "c1",
        state: { bible: null, outline: null, manuscript: null, ledger: null, compiledAt: 1 },
        manuscript: { scenes: [{ prose: "x" }] },
        coverage: 1,
        reusedScenes: 0,
        rebuiltScenes: 1,
        continuityIssues: [],
        continuityAssessment: "ok",
        unusedFragments: [],
        costUsd: 2.5,
        words: 1,
      },
    });
    // Simulate a crash after claiming settlement and before touching usage.
    expect(store.claimSettlement(job.id)).not.toBeNull();

    const { queue } = fakeQueue({
      store,
      onSettled: (account, spent, produced) => settledCalls.push({ account, spent, produced }),
    });
    expect(queue.recover()).toEqual({ resumed: 0, abandoned: 0 });
    expect(settledCalls).toEqual([{ account: "acct-1", spent: 3.75, produced: true }]);
    expect(store.get(job.id)?.settled).toBe(true);
    store.close();
  });
});
