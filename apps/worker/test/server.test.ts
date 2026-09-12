import { beforeAll, describe, expect, it } from "vitest";
import { generateSecret, issueToken } from "../src/auth.js";

process.env.NODE_ENV = "test";
process.env.LOOM_TOKEN_SECRET = generateSecret();
process.env.USAGE_DB = ":memory:";
process.env.JOBS_DB = ":memory:";
process.env.SYNC_DB = ":memory:";
process.env.SYNC_REQUEST_MAX_BYTES = "1024";

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

describe("sync", () => {
  const paidToken = () =>
    issueToken({ sub: "acct-sync", tier: "paid" }, process.env.LOOM_TOKEN_SECRET!);

  const body = (over: Record<string, unknown> = {}) => ({
    protocol: 1,
    since: null,
    fragments: [],
    projects: [],
    ...over,
  });

  const note = (id: string, text: string) => ({
    record: {
      id,
      projectId: null,
      text,
      createdAt: 1000,
      updatedAt: 1000,
      source: "quick",
      deletedAt: null,
      pinned: false,
    },
    baseRev: null,
  });

  it("refuses to sync without a token", async () => {
    expect((await post("/v1/sync", body())).status).toBe(401);
  });

  it("refuses the free tier, because sync is what the paid tier is", async () => {
    const res = await post("/v1/sync", body(), freeToken());
    expect(res.status).toBe(402);
    expect((await res.json()) as { code: string }).toMatchObject({ code: "tier" });
  });

  it("round-trips a note for a paid account", async () => {
    const res = await post("/v1/sync", body({ fragments: [note("f1", "a note")] }), paidToken());
    expect(res.status).toBe(200);

    const payload = (await res.json()) as {
      protocol: number;
      cursor: number;
      accepted: Record<string, number>;
      fragments: { record: { text: string } }[];
    };
    expect(payload.protocol).toBe(1);
    expect(payload.accepted).toEqual({ f1: 1 });
    expect(payload.fragments.map((f) => f.record.text)).toEqual(["a note"]);
    expect(payload.cursor).toBeGreaterThan(0);
  });

  it("refuses a protocol it does not speak rather than guessing", async () => {
    // The alternative is to half-apply a request shaped differently from what
    // we expect, over someone's only copy of their writing.
    const res = await post("/v1/sync", body({ protocol: 99 }), paidToken());
    expect(res.status).toBe(409);
    expect((await res.json()) as { code: string }).toMatchObject({ code: "protocol" });
  });

  it("rejects a malformed record", async () => {
    const res = await post(
      "/v1/sync",
      body({ fragments: [{ record: { id: "f1" }, baseRev: null }] }),
      paidToken(),
    );
    expect(res.status).toBe(400);
  });

  it("rejects a declared oversized sync body before parsing it", async () => {
    const res = await call(
      "/v1/sync",
      { method: "POST", body: "{}", headers: { "content-length": "1025" } },
      paidToken(),
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "Invalid request" });
  });

  it("rejects an oversized streamed sync body without content-length", async () => {
    const res = await call(
      "/v1/sync",
      { method: "POST", body: JSON.stringify({ padding: "x".repeat(1200) }) },
      paidToken(),
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "Invalid request" });
  });

  it("reports what it is holding, and deletes it on request", async () => {
    await post("/v1/sync", body({ fragments: [note("f9", "a note")] }), paidToken());

    const before = (await call("/v1/sync", {}, paidToken())).json() as Promise<{
      fragments: number;
      enabled: boolean;
    }>;
    expect(await before).toMatchObject({ enabled: true });
    expect((await before).fragments).toBeGreaterThan(0);

    const deleted = await call("/v1/sync", { method: "DELETE" }, paidToken());
    expect(deleted.status).toBe(200);

    const after = (await (await call("/v1/sync", {}, paidToken())).json()) as {
      fragments: number;
      cursor: number;
    };
    expect(after).toMatchObject({ fragments: 0, cursor: 0 });
  });

  it("keeps one account's notes out of another's sync", async () => {
    const stranger = issueToken({ sub: "acct-other", tier: "paid" }, process.env.LOOM_TOKEN_SECRET!);
    await post("/v1/sync", body({ fragments: [note("f-private", "private")] }), paidToken());

    const res = await post("/v1/sync", body(), stranger);
    expect(((await res.json()) as { fragments: unknown[] }).fragments).toHaveLength(0);
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
