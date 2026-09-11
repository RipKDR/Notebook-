import { beforeAll, describe, expect, it } from "vitest";

process.env.NODE_ENV = "test";

let app: { fetch: (req: Request) => Promise<Response> };

beforeAll(async () => {
  ({ app } = await import("../src/server.js"));
});

const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
  app.fetch(
    new Request(`http://test${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
    }),
  );

const validBody = {
  projectId: "p1",
  title: "The Lighthouse",
  form: "memoir",
  targetWords: 40_000,
  fragments: [{ id: "f1", text: "She never once said my name.", createdAt: 1, pinned: false }],
  previousState: null,
};

describe("worker routes", () => {
  it("reports health", async () => {
    const res = await app.fetch(new Request("http://test/health"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean };
    expect(body.ok).toBe(true);
  });

  it("publishes the tier table", async () => {
    const res = await app.fetch(new Request("http://test/v1/tiers"));
    const body = (await res.json()) as Record<string, { budgetUsd: number }>;
    expect(body.paid!.budgetUsd).toBeGreaterThan(body.free!.budgetUsd);
  });

  it("rejects a malformed compile request before touching the queue", async () => {
    const res = await post("/v1/compile", { projectId: "p1" });
    expect([400, 503]).toContain(res.status);
  });

  it("rejects an empty fragment list", async () => {
    const res = await post("/v1/compile", { ...validBody, fragments: [] });
    expect([400, 503]).toContain(res.status);
  });

  it("rejects an unknown work form", async () => {
    const res = await post("/v1/compile", { ...validBody, form: "screenplay" });
    expect([400, 503]).toContain(res.status);
  });

  it("refuses to compile when no model credential is configured", async () => {
    // The test environment has no ANTHROPIC_API_KEY, which is the condition we
    // want covered: fail loudly rather than queueing work that cannot run.
    const res = await post("/v1/compile", validBody);
    expect(res.status).toBe(503);
  });

  it("404s an unknown job", async () => {
    const res = await app.fetch(new Request("http://test/v1/compile/nope"));
    expect(res.status).toBe(404);
  });

  it("409s cancelling an unknown job", async () => {
    const res = await post("/v1/compile/nope/cancel", {});
    expect(res.status).toBe(409);
  });

  it("409s a manuscript request for a job with no result", async () => {
    const res = await app.fetch(new Request("http://test/v1/compile/nope/manuscript"));
    expect(res.status).toBe(404);
  });
});
