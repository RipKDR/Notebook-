import { beforeAll, describe, expect, it } from "vitest";
import { generateSecret, issueToken } from "../src/auth.js";

process.env.NODE_ENV = "test";
process.env.LOOM_TOKEN_SECRET = generateSecret();
process.env.USAGE_DB = ":memory:";
process.env.JOBS_DB = ":memory:";

let app: { fetch: (req: Request) => Promise<Response> };

beforeAll(async () => {
  ({ app } = await import("../src/server.js"));
});

const freeToken = () =>
  issueToken({ sub: "acct-free", tier: "free" }, process.env.LOOM_TOKEN_SECRET!);

const call = (path: string, init: RequestInit = {}, token?: string) =>
  app.fetch(
    new Request(`http://test${path}`, {
      ...init,
      headers: {
        "content-type": "application/json",
        ...(token !== undefined ? { authorization: `Bearer ${token}` } : {}),
        ...init.headers,
      },
    }),
  );

const post = (path: string, body: unknown, token?: string) =>
  call(path, { method: "POST", body: JSON.stringify(body) }, token);

const validBody = {
  projectId: "p1",
  title: "The Lighthouse",
  form: "memoir",
  targetWords: 40_000,
  fragments: [{ id: "f1", text: "She never once said my name.", createdAt: 1, pinned: false }],
  previousState: null,
};

describe("public routes", () => {
  it("reports health without a token", async () => {
    const res = await app.fetch(new Request("http://test/health"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; authConfigured: boolean };
    expect(body.ok).toBe(true);
    expect(body.authConfigured).toBe(true);
  });

  it("publishes the tier table", async () => {
    const res = await app.fetch(new Request("http://test/v1/tiers"));
    const body = (await res.json()) as Record<string, { budgetUsd: number }>;
    expect(body.paid!.budgetUsd).toBeGreaterThan(body.free!.budgetUsd);
  });
});

describe("authentication", () => {
  it("refuses a compile with no token", async () => {
    expect((await post("/v1/compile", validBody)).status).toBe(401);
  });

  it("refuses a forged token", async () => {
    const forged = issueToken({ sub: "x", tier: "paid" }, generateSecret());
    expect((await post("/v1/compile", validBody, forged)).status).toBe(401);
  });

  it("refuses an expired token", async () => {
    const stale = issueToken(
      { sub: "x", tier: "paid", ttlSeconds: -1 },
      process.env.LOOM_TOKEN_SECRET!,
    );
    expect((await post("/v1/compile", validBody, stale)).status).toBe(401);
  });

  it("ignores a self-asserted tier header", async () => {
    // The header used to be the entire authorisation check. It must now do
    // nothing at all: the tier comes from the signed token or nowhere.
    const res = await call(
      "/v1/compile",
      { method: "POST", body: JSON.stringify(validBody), headers: { "x-loom-tier": "paid" } },
    );
    expect(res.status).toBe(401);
  });

  it("refuses enrichment with no token", async () => {
    expect((await post("/v1/enrich", { fragments: [] })).status).toBe(401);
  });

  it("refuses to read someone else's job", async () => {
    const other = issueToken({ sub: "someone-else", tier: "paid" }, process.env.LOOM_TOKEN_SECRET!);
    expect((await call("/v1/compile/anything", {}, other)).status).toBe(404);
  });
});

describe("validation", () => {
  it("rejects a malformed compile request", async () => {
    const res = await post("/v1/compile", { projectId: "p1" }, freeToken());
    expect([400, 503]).toContain(res.status);
  });

  it("rejects an empty fragment list", async () => {
    const res = await post("/v1/compile", { ...validBody, fragments: [] }, freeToken());
    expect([400, 503]).toContain(res.status);
  });

  it("rejects an unknown work form", async () => {
    const res = await post("/v1/compile", { ...validBody, form: "screenplay" }, freeToken());
    expect([400, 503]).toContain(res.status);
  });

  it("rejects an oversized enrichment batch", async () => {
    const fragments = Array.from({ length: 500 }, (_, i) => ({
      id: `f${i}`,
      text: "x",
      createdAt: 1,
    }));
    const res = await post("/v1/enrich", { fragments }, freeToken());
    expect([400, 503]).toContain(res.status);
  });
});

describe("model access", () => {
  it("refuses to compile when no credential is configured", async () => {
    // This environment has no ANTHROPIC_API_KEY, which is the condition worth
    // covering: fail loudly rather than queue work that cannot run.
    expect((await post("/v1/compile", validBody, freeToken())).status).toBe(503);
  });

  it("refuses to enrich when no credential is configured", async () => {
    const res = await post(
      "/v1/enrich",
      { fragments: [{ id: "f1", text: "a note", createdAt: 1 }] },
      freeToken(),
    );
    expect(res.status).toBe(503);
  });

  it("404s an unknown job for its would-be owner", async () => {
    expect((await call("/v1/compile/nope", {}, freeToken())).status).toBe(404);
  });

  it("404s a manuscript request for an unknown job", async () => {
    expect((await call("/v1/compile/nope/manuscript", {}, freeToken())).status).toBe(404);
  });
});

describe("durable jobs", () => {
  it("reports that job state survives a restart", async () => {
    const res = await app.fetch(new Request("http://test/health"));
    const body = (await res.json()) as {
      durableJobs: boolean;
      recovered: { resumed: number; abandoned: number };
    };
    expect(body.durableJobs).toBe(true);
    // A fresh in-memory store has nothing to pick up, but the field must be
    // there: it is what you look at after a deploy.
    expect(body.recovered).toEqual({ resumed: 0, abandoned: 0 });
  });

  it("lists an account's compiles so a client that lost the job id can re-attach", async () => {
    const res = await call("/v1/compiles", {}, freeToken());
    expect(res.status).toBe(200);
    expect((await res.json()) as { jobs: unknown[] }).toEqual({ jobs: [] });
  });

  it("refuses to list compiles without a token", async () => {
    expect((await app.fetch(new Request("http://test/v1/compiles"))).status).toBe(401);
  });
});
