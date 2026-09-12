import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { JobStore, isTerminal, type PersistedRequest } from "../src/job-store.js";
import { ENTITLEMENTS } from "../src/entitlements.js";

const request: PersistedRequest = {
  projectId: "p1",
  title: "The Kitchen Radio",
  form: "memoir",
  targetWords: 10_000,
  fragments: [{ id: "f1", text: "She never once said my name.", createdAt: 1, pinned: false }],
  previousState: null,
  entitlement: ENTITLEMENTS.free,
};

const seed = (store: JobStore, id: string, account = "acct-1") =>
  store.create({ id, account, request, createdAt: Date.now() });

const markCrashed = (store: JobStore, id: string): boolean =>
  store.markRunning(id, "crashed-test-worker", 0, store.get(id)?.attempts ?? -1);

let tempDir: string;
let dbPath: string;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "loom-job-store-"));
  dbPath = join(tempDir, "jobs.db");
});

afterEach(() => {
  // Removing the directory also removes SQLite's -wal and -shm sidecars.
  rmSync(tempDir, { recursive: true, force: true });
});

describe("JobStore", () => {
  it("round-trips a job through SQLite", () => {
    const store = JobStore.open();
    const created = seed(store, "j1");

    expect(created.status).toBe("queued");
    expect(created.attempts).toBe(0);
    expect(created.settled).toBe(false);

    const read = store.get("j1");
    expect(read?.request?.title).toBe("The Kitchen Radio");
    expect(read?.request?.fragments[0]?.text).toBe("She never once said my name.");
    store.close();
  });

  it("returns null for an unknown id", () => {
    const store = JobStore.open();
    expect(store.get("nope")).toBeNull();
    store.close();
  });

  it("counts an attempt each time a job starts running", () => {
    const store = JobStore.open();
    seed(store, "j1");
    markCrashed(store, "j1");
    markCrashed(store, "j1");
    expect(store.get("j1")?.attempts).toBe(2);
    expect(store.get("j1")?.status).toBe("running");
    store.close();
  });

  it("claims a run only from the expected attempt count", () => {
    const store = JobStore.open();
    seed(store, "j1");
    const lease = Date.now() + 60_000;
    expect(store.markRunning("j1", "worker-a", lease, 0)).toBe(true);
    expect(store.markRunning("j1", "worker-b", lease, 0)).toBe(false);
    expect(store.get("j1")?.attempts).toBe(1);
    expect(store.get("j1")).toMatchObject({ workerOwner: "worker-a", leaseExpiresAt: lease });
    store.close();
  });

  it("allows only the lease owner to complete a claimed job", () => {
    const store = JobStore.open();
    seed(store, "j1");
    expect(store.markRunning("j1", "worker-a", Date.now() + 60_000, 0)).toBe(true);

    expect(store.finish("j1", "complete", {}, "worker-b")).toBe(false);
    expect(store.get("j1")?.status).toBe("running");
    expect(store.finish("j1", "complete", {}, "worker-a")).toBe(true);
    expect(store.get("j1")?.status).toBe("complete");
    store.close();
  });

  it("persists progress and checkpoints so a restart can read them back", () => {
    const store = JobStore.open();
    seed(store, "j1");

    store.saveProgress("j1", {
      status: "drafting",
      fraction: 0.42,
      detail: "Writing scene 12 of 40",
      spentUsd: 1.5,
    });
    store.saveCheckpoint("j1", {
      bible: null,
      outline: null,
      manuscript: null,
      ledger: { deltas: [] },
      compiledAt: 99,
    });

    const read = store.get("j1");
    expect(read?.progress?.fraction).toBe(0.42);
    expect(read?.checkpoint?.compiledAt).toBe(99);
    store.close();
  });

  it("banks spend from interrupted attempts", () => {
    const store = JobStore.open();
    seed(store, "j1");
    store.addPriorSpend("j1", 1.25);
    store.addPriorSpend("j1", 0.75);
    // A negative or zero figure is not a correction, it is a bug upstream —
    // silently reducing what a job has spent would raise its remaining budget.
    store.addPriorSpend("j1", -5);
    expect(store.get("j1")?.priorSpendUsd).toBeCloseTo(2.0);
    store.close();
  });

  it("banks persisted attempt spend when a run is claimed", () => {
    const store = JobStore.open();
    seed(store, "j1");
    store.saveProgress("j1", {
      status: "drafting",
      fraction: 0.4,
      detail: "Writing",
      spentUsd: 1.75,
    });
    expect(store.markRunning("j1", "worker-a", Date.now() + 60_000, 0)).toBe(true);
    const read = store.get("j1");
    expect(read?.priorSpendUsd).toBeCloseTo(1.75);
    expect(read?.progress?.spentUsd).toBe(0);
    store.close();
  });

  it("settles exactly once", () => {
    const store = JobStore.open();
    seed(store, "j1");
    const claim = store.claimSettlement("j1");
    expect(claim).not.toBeNull();
    expect(store.claimSettlement("j1")).toBeNull();
    store.completeSettlement("j1", claim!);
    expect(store.get("j1")?.settled).toBe(true);
    store.close();
  });

  it("lists only jobs left queued or running as interrupted", () => {
    const store = JobStore.open();
    seed(store, "queued-one");
    seed(store, "running-one");
    seed(store, "done-one");
    markCrashed(store, "running-one");
    store.finish("done-one", "complete");

    expect(store.interrupted().map((j) => j.id).sort()).toEqual(["queued-one", "running-one"]);
    store.close();
  });

  it("keeps a finished result readable after the process that made it is gone", () => {
    const first = JobStore.open(dbPath);
    seed(first, "j1");
    first.finish("j1", "complete", {
      result: {
        compileId: "c1",
        state: { bible: null, outline: null, manuscript: null, ledger: null, compiledAt: 1 },
        manuscript: { scenes: [{ prose: "It was a kitchen." }] },
        coverage: 1,
        reusedScenes: 0,
        rebuiltScenes: 3,
        continuityIssues: [],
        continuityAssessment: "Fine.",
        unusedFragments: [],
        costUsd: 2.5,
        words: 4,
      },
    });
    first.close();

    // A different process, the same disk.
    const second = JobStore.open(dbPath);
    const job = second.get("j1");
    expect(job?.status).toBe("complete");
    expect(job?.result?.manuscript.scenes).toHaveLength(1);
    expect(job?.result?.costUsd).toBe(2.5);
    second.close();
  });

  it("sweeps finished jobs past the retention cutoff and keeps unfinished ones", () => {
    const store = JobStore.open();
    seed(store, "old");
    seed(store, "recent");
    seed(store, "still-running");
    markCrashed(store, "still-running");
    store.finish("old", "complete", { finishedAt: 1_000 });
    store.finish("recent", "complete", { finishedAt: Date.now() });

    expect(store.sweep(500_000)).toBe(1);
    expect(store.get("old")).toBeNull();
    expect(store.get("recent")).not.toBeNull();
    expect(store.get("still-running")).not.toBeNull();
    store.close();
  });

  it("scopes a listing to one account", () => {
    const store = JobStore.open();
    seed(store, "mine", "acct-1");
    seed(store, "theirs", "acct-2");
    expect(store.listForAccount("acct-1").map((j) => j.id)).toEqual(["mine"]);
    store.close();
  });

  it("survives an unreadable JSON blob without losing the job's status", () => {
    // A result written by an older worker may not parse. The status column is a
    // real column precisely so that a polling client still gets an answer.
    const store = JobStore.open();
    seed(store, "j1");
    store.finish("j1", "complete");
    // Corrupt the blob the way a partial write or a format change would.
    (store as unknown as { db: { exec: (sql: string) => void } }).db.exec(
      `UPDATE jobs SET result = '{not json' WHERE id = 'j1'`,
    );

    const job = store.get("j1");
    expect(job?.status).toBe("complete");
    expect(job?.result).toBeNull();
    store.close();
  });

  it("survives an unreadable request blob in get and listings", () => {
    const store = JobStore.open();
    seed(store, "j1");
    (store as unknown as { db: { exec: (sql: string) => void } }).db.exec(
      `UPDATE jobs SET request = '{not json' WHERE id = 'j1'`,
    );

    expect(store.get("j1")?.request).toBeNull();
    expect(store.listForAccount("acct-1")[0]?.request).toBeNull();
    expect(store.interrupted()[0]?.request).toBeNull();
    store.close();
  });

  it("knows which statuses are terminal", () => {
    expect(isTerminal("complete")).toBe(true);
    expect(isTerminal("failed")).toBe(true);
    expect(isTerminal("cancelled")).toBe(true);
    expect(isTerminal("queued")).toBe(false);
    expect(isTerminal("running")).toBe(false);
  });
});
