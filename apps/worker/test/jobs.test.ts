import { describe, expect, it } from "vitest";
import { CompileQueue } from "../src/jobs.js";
import { ENTITLEMENTS } from "../src/entitlements.js";

const request = {
  projectId: "p1",
  title: "T",
  form: "memoir" as const,
  targetWords: 10_000,
  fragments: [{ id: "f1", text: "a note", createdAt: 1, pinned: false }],
  previousState: null,
  entitlement: ENTITLEMENTS.free,
};

describe("CompileQueue", () => {
  it("assigns an id and starts queued or running", () => {
    const queue = new CompileQueue({ concurrency: 1 });
    const job = queue.enqueue(request);
    expect(job.id).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(["queued", "running"]).toContain(job.status);
  });

  it("retrieves a job by id", () => {
    const queue = new CompileQueue({ concurrency: 1 });
    const job = queue.enqueue(request);
    expect(queue.get(job.id)?.id).toBe(job.id);
  });

  it("returns null for an unknown id", () => {
    expect(new CompileQueue().get("missing")).toBeNull();
  });

  it("cancels a queued job without running it", () => {
    // Concurrency 0 keeps everything pending, so cancellation is observable.
    const queue = new CompileQueue({ concurrency: 0 });
    const job = queue.enqueue(request);
    expect(queue.cancel(job.id)).toBe(true);
    expect(queue.get(job.id)?.status).toBe("cancelled");
  });

  it("reports cancellation of an unknown job as unsuccessful", () => {
    expect(new CompileQueue().cancel("missing")).toBe(false);
  });

  it("respects the concurrency limit", () => {
    const queue = new CompileQueue({ concurrency: 0 });
    queue.enqueue(request);
    queue.enqueue(request);
    const stats = queue.stats();
    expect(stats.running).toBe(0);
    expect(stats.queued).toBe(2);
  });

  it("fails a job cleanly when there is no model credential", async () => {
    const queue = new CompileQueue({ concurrency: 1 });
    const job = queue.enqueue(request);

    // The compile will reject (no API key in the test environment). What matters
    // is that the failure lands on the job rather than becoming an unhandled
    // rejection that takes the worker down.
    const deadline = Date.now() + 15_000;
    while (job.status !== "failed" && job.status !== "complete" && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 50));
    }
    expect(["failed", "complete"]).toContain(job.status);
    if (job.status === "failed") expect(job.error).toBeTruthy();
  }, 20_000);
});
