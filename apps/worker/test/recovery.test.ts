import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { generateSecret, issueToken } from "../src/auth.js";
import { JobStore } from "../src/job-store.js";
import { ENTITLEMENTS } from "../src/entitlements.js";

/**
 * Boot-time recovery, through the real server module.
 *
 * The queue's own tests prove resumption in isolation. This one proves the wiring
 * that actually matters in production: a worker process starting up against a
 * database that already contains a compile someone was watching, and picking it
 * up before it binds a port.
 */

const dir = mkdtempSync(join(tmpdir(), "loom-recovery-"));
const dbPath = join(dir, "jobs.db");
const secret = generateSecret();

const request = {
  projectId: "p1",
  title: "The Kitchen Radio",
  form: "memoir" as const,
  targetWords: 10_000,
  fragments: [{ id: "f1", text: "She never once said my name.", createdAt: 1, pinned: false }],
  previousState: null,
  entitlement: ENTITLEMENTS.paid,
};

let app: { fetch: (req: Request) => Promise<Response> };

beforeAll(async () => {
  // Write the state a crashed worker would have left behind: one compile still
  // marked running, one finished and waiting to be collected, one long past its
  // retention window.
  const store = JobStore.open(dbPath);
  store.create({ id: "in-flight", account: "acct-1", createdAt: Date.now(), request });
  store.markRunning("in-flight");
  store.saveProgress("in-flight", {
    status: "drafting",
    fraction: 0.61,
    detail: "Writing scene 20 of 33",
    spentUsd: 1.1,
  });

  store.create({ id: "collected", account: "acct-1", createdAt: Date.now(), request });
  store.finish("collected", "complete", {
    result: {
      compileId: "c1",
      state: { bible: null, outline: null, manuscript: null, ledger: null, compiledAt: 1 },
      manuscript: { scenes: [{ prose: "The radio was on." }] },
      coverage: 1,
      reusedScenes: 0,
      rebuiltScenes: 1,
      continuityIssues: [],
      continuityAssessment: "Fine.",
      unusedFragments: [],
      costUsd: 3.2,
      words: 4,
    },
  });
  store.close();

  process.env.NODE_ENV = "test";
  process.env.LOOM_TOKEN_SECRET = secret;
  process.env.USAGE_DB = ":memory:";
  process.env.JOBS_DB = dbPath;

  ({ app } = await import("../src/server.js"));
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

const token = () => issueToken({ sub: "acct-1", tier: "paid" }, secret);

const call = (path: string) =>
  app.fetch(
    new Request(`http://test${path}`, { headers: { authorization: `Bearer ${token()}` } }),
  );

describe("a worker booting onto an existing job database", () => {
  it("reports the in-flight compile as picked up", async () => {
    const res = await app.fetch(new Request("http://test/health"));
    const body = (await res.json()) as { recovered: { resumed: number; abandoned: number } };
    expect(body.recovered.resumed).toBe(1);
    expect(body.recovered.abandoned).toBe(0);
  });

  it("still answers the client that was polling the interrupted job", async () => {
    // Before this was durable, the poll returned 404 for a job the user had
    // watched reach 61% — and the compile they were charged for was simply gone.
    const res = await call("/v1/compile/in-flight");
    expect(res.status).toBe(200);

    const body = (await res.json()) as {
      status: string;
      attempts: number;
      progress: { fraction: number } | null;
    };
    // It has no model credential in this environment, so it will fail — but it
    // was tried again, which is the property under test.
    expect(["queued", "running", "failed"]).toContain(body.status);
    expect(body.attempts).toBeGreaterThanOrEqual(1);
  });

  it("hands over a manuscript compiled by the process that died", async () => {
    const res = await call("/v1/compile/collected/manuscript");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { scenes: { prose: string }[] };
    expect(body.scenes[0]?.prose).toBe("The radio was on.");
  });

  it("lists both jobs for the account that owns them", async () => {
    const res = await call("/v1/compiles");
    const body = (await res.json()) as { jobs: { id: string }[] };
    expect(body.jobs.map((j) => j.id).sort()).toEqual(["collected", "in-flight"]);
  });

  it("keeps another account out of them", async () => {
    const stranger = issueToken({ sub: "acct-2", tier: "paid" }, secret);
    const res = await app.fetch(
      new Request("http://test/v1/compile/collected", {
        headers: { authorization: `Bearer ${stranger}` },
      }),
    );
    expect(res.status).toBe(404);
  });
});
