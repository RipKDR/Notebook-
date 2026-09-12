import { serve } from "@hono/node-server";
import {
  LocalTrigramEmbeddings,
  Llm,
  VoyageEmbeddings,
  SYNC_PAGE_LIMIT,
  SYNC_PROTOCOL_VERSION,
  asFragmentId,
  enrichFragments,
  type EmbeddingProvider,
  type Fragment,
} from "@loom/core";
import { Hono, type MiddlewareHandler } from "hono";
import { z } from "zod";
import { bearerFrom, verifyToken, type TokenClaims } from "./auth.js";
import { authorise, ENTITLEMENTS } from "./entitlements.js";
import { JobStore } from "./job-store.js";
import { SyncStore } from "./sync-store.js";
import { CompileQueue } from "./jobs.js";
import { UsageStore } from "./usage.js";

/**
 * The compile service.
 *
 * It exists for one structural reason: the Anthropic API key must never reach a
 * phone. An app bundle is not a secret — anyone can pull strings out of an IPA
 * in minutes — so a client-side key is a credential handed to every installer
 * and billed to us.
 *
 * Everything else follows. The worker holds the key, verifies who is calling,
 * enforces a persisted quota, and runs compiles as jobs the client polls.
 */

const apiKey = process.env.ANTHROPIC_API_KEY;
const tokenSecret = process.env.LOOM_TOKEN_SECRET;

const embeddings: EmbeddingProvider =
  process.env.VOYAGE_API_KEY !== undefined
    ? new VoyageEmbeddings(process.env.VOYAGE_API_KEY)
    : new LocalTrigramEmbeddings();

const usage = UsageStore.open(process.env.USAGE_DB ?? "./loom-usage.db");
const jobStore = JobStore.open(process.env.JOBS_DB ?? "./loom-jobs.db");
const syncStore = SyncStore.open(process.env.SYNC_DB ?? "./loom-sync.db");

const queue = new CompileQueue({
  ...(apiKey !== undefined ? { apiKey } : {}),
  ...(process.env.VOYAGE_API_KEY !== undefined
    ? { voyageApiKey: process.env.VOYAGE_API_KEY }
    : {}),
  concurrency: Number(process.env.COMPILE_CONCURRENCY ?? 2),
  store: jobStore,
  /**
   * Settlement is wired here rather than per request because a job resumed after
   * a restart has no request left to carry a closure on. Spend is recorded when
   * a book was produced; the reservation is handed back when one was not.
   */
  onSettled: (account, spentUsd, produced) => {
    if (produced) usage.recordSpend(account, spentUsd);
    else usage.release(account);
  },
});

/**
 * Pick up whatever was in flight when this process last stopped.
 *
 * A deploy used to destroy every running compile and leave the polling client
 * with a 404 for a job it had watched reach 80%. Recovery runs before the
 * listener is bound, so a resumed job is never racing a fresh request for the
 * same account's quota.
 */
const recovered = queue.recover();

const app = new Hono<{ Variables: { claims: TokenClaims } }>();

app.get("/health", (c) =>
  c.json({
    ok: true,
    modelAccess: apiKey !== undefined,
    authConfigured: tokenSecret !== undefined,
    durableJobs: true,
    recovered,
    ...queue.stats(),
  }),
);

app.get("/v1/tiers", (c) => c.json(ENTITLEMENTS));

/**
 * Authentication.
 *
 * Fails closed. A worker started without `LOOM_TOKEN_SECRET` refuses every
 * authenticated route rather than falling back to trusting the caller — an
 * unauthenticated fallback is how a misconfigured deployment quietly becomes an
 * open, billable endpoint.
 */
const authenticate: MiddlewareHandler<{ Variables: { claims: TokenClaims } }> = async (
  c,
  next,
) => {
  if (tokenSecret === undefined) {
    return c.json({ error: "This worker is not configured to accept requests." }, 503);
  }
  const token = bearerFrom(c.req.header("authorization"));
  if (token === null) {
    return c.json({ error: "Missing bearer token." }, 401);
  }
  const result = verifyToken(token, tokenSecret);
  if (!result.ok) {
    return c.json({ error: result.reason }, 401);
  }
  c.set("claims", result.claims);
  await next();
  return undefined;
};

// Every route that spends our money or reads someone's writing. Listed
// explicitly: a route added outside this list is unauthenticated, and the point
// of the list is that adding one has to be a decision rather than an oversight.
app.use("/v1/compile", authenticate);
app.use("/v1/compile/*", authenticate);
app.use("/v1/compiles", authenticate);
app.use("/v1/enrich", authenticate);
app.use("/v1/sync", authenticate);

// ---------------------------------------------------------------------------
// Enrichment
// ---------------------------------------------------------------------------

const enrichSchema = z.object({
  fragments: z
    .array(
      z.object({
        id: z.string().min(1),
        text: z.string().min(1).max(100_000),
        createdAt: z.number().int(),
      }),
    )
    .min(1)
    .max(200),
});

/**
 * Indexes a batch of fragments.
 *
 * The phone cannot do this itself: classification needs the model, and the model
 * needs the key. Without this endpoint nothing ever populates a fragment's
 * digest or embedding, so clustering has nothing to cluster and the Threads
 * screen stays empty forever — which is precisely what was happening.
 *
 * Capped at 200 per request so a first sync of a large notebook arrives in
 * chunks the client can show progress for, rather than one long silence.
 */
app.post("/v1/enrich", async (c) => {
  if (apiKey === undefined) {
    return c.json({ error: "This worker has no model access configured." }, 503);
  }

  const parsed = enrichSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) {
    return c.json({ error: "Invalid request", detail: parsed.error.issues.slice(0, 5) }, 400);
  }

  const fragments: Fragment[] = parsed.data.fragments.map((f) => ({
    id: asFragmentId(f.id),
    projectId: null,
    text: f.text,
    createdAt: f.createdAt,
    updatedAt: f.createdAt,
    source: "quick",
    deletedAt: null,
    pinned: false,
    enrichment: null,
    embedding: null,
  }));

  const llm = new Llm({ apiKey });

  try {
    const patches = await enrichFragments(fragments, { llm, embeddings });

    return c.json({
      embeddingModel: embeddings.id,
      patches: [...patches.entries()].map(([id, patch]) => ({
        id: id as string,
        enrichment: patch.enrichment ?? null,
        // Float32Array does not survive JSON; the client rebuilds it.
        embedding: patch.embedding === undefined ? null : Array.from(patch.embedding),
      })),
    });
  } catch (err: unknown) {
    return c.json(
      { error: err instanceof Error ? err.message : "Enrichment failed" },
      502,
    );
  }
});

// ---------------------------------------------------------------------------
// Sync
// ---------------------------------------------------------------------------

/**
 * What crosses the wire.
 *
 * The source, not the build artifact. Fragments and projects are what the user
 * typed and cannot be regenerated; a Bible, an outline and a manuscript are
 * output the compiler can rebuild on any device that has the notes. Shipping a
 * hundred thousand words of derived prose to a phone on a train to save a
 * recompile is the wrong trade.
 */
const syncFragmentSchema = z.object({
  id: z.string().min(1).max(64),
  projectId: z.string().min(1).max(64).nullable().default(null),
  text: z.string().max(100_000),
  createdAt: z.number().int(),
  updatedAt: z.number().int(),
  source: z.enum(["quick", "widget", "share", "voice", "import", "editor"]).default("quick"),
  deletedAt: z.number().int().nullable().default(null),
  pinned: z.boolean().default(false),
});

const syncProjectSchema = z.object({
  id: z.string().min(1).max(64),
  title: z.string().min(1).max(300),
  form: z.enum(["fiction", "memoir"]),
  targetWords: z.number().int().min(1).max(1_000_000),
  createdAt: z.number().int(),
  updatedAt: z.number().int(),
  archivedAt: z.number().int().nullable().default(null),
});

const pushOf = <T extends z.ZodType>(record: T) =>
  z.object({ record, baseRev: z.number().int().nullable().default(null) });

const syncRequestSchema = z.object({
  protocol: z.number().int(),
  since: z.number().int().nonnegative().nullable().default(null),
  fragments: z.array(pushOf(syncFragmentSchema)).max(SYNC_PAGE_LIMIT).default([]),
  projects: z.array(pushOf(syncProjectSchema)).max(SYNC_PAGE_LIMIT).default([]),
  limit: z.number().int().min(1).max(SYNC_PAGE_LIMIT).optional(),
});

/**
 * One round trip: push what changed here, pull what changed there.
 *
 * Both halves share a transaction, so the cursor a client is handed provably
 * includes its own writes. Splitting them lets a device push a note and then
 * pull a cursor that predates it, which silently drops the note.
 */
app.post("/v1/sync", async (c) => {
  const claims = c.get("claims");
  if (!ENTITLEMENTS[claims.tier].cloudSync) {
    return c.json(
      { error: "Cloud sync is part of the paid plan. Your writing stays on your device.", code: "tier" },
      402,
    );
  }

  const parsed = syncRequestSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) {
    return c.json({ error: "Invalid request", detail: parsed.error.issues.slice(0, 5) }, 400);
  }
  if (parsed.data.protocol !== SYNC_PROTOCOL_VERSION) {
    // Refuse rather than guess. A client speaking a protocol we do not know is
    // holding someone's only copy of their writing.
    return c.json(
      {
        error: `This app is too old to sync with this server (protocol ${parsed.data.protocol}, expected ${SYNC_PROTOCOL_VERSION}). Update the app.`,
        code: "protocol",
      },
      409,
    );
  }

  const result = syncStore.sync(claims.sub, {
    since: parsed.data.since,
    fragments: parsed.data.fragments,
    projects: parsed.data.projects,
    ...(parsed.data.limit !== undefined ? { limit: parsed.data.limit } : {}),
  });

  return c.json({ protocol: SYNC_PROTOCOL_VERSION, ...result });
});

/** What the server holds for this account, so a user can see it and delete it. */
app.get("/v1/sync", (c) => {
  const claims = c.get("claims");
  return c.json({
    protocol: SYNC_PROTOCOL_VERSION,
    enabled: ENTITLEMENTS[claims.tier].cloudSync,
    cursor: syncStore.head(claims.sub),
    ...syncStore.counts(claims.sub),
  });
});

/**
 * Stops syncing and removes everything the server holds.
 *
 * A user who turns sync off and finds their notes still on our disk has been
 * lied to. The device keeps its own copy — it was always the source of truth.
 */
app.delete("/v1/sync", (c) => {
  syncStore.forget(c.get("claims").sub);
  return c.json({ deleted: true });
});

// ---------------------------------------------------------------------------
// Compilation
// ---------------------------------------------------------------------------

const compileRequestSchema = z.object({
  projectId: z.string().min(1),
  title: z.string().min(1).max(300),
  form: z.enum(["fiction", "memoir"]),
  targetWords: z.number().int().min(1_000).max(200_000),
  fragments: z
    .array(
      z.object({
        id: z.string().min(1),
        text: z.string().min(1).max(100_000),
        createdAt: z.number().int(),
        pinned: z.boolean().default(false),
      }),
    )
    .min(1)
    .max(20_000),
  previousState: z.unknown().nullable().default(null),
});

app.post("/v1/compile", async (c) => {
  if (apiKey === undefined) {
    return c.json({ error: "This worker has no model access configured." }, 503);
  }

  const parsed = compileRequestSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) {
    return c.json({ error: "Invalid request", detail: parsed.error.issues.slice(0, 5) }, 400);
  }

  const claims = c.get("claims");
  const decision = authorise(
    claims.tier,
    usage.read(claims.sub),
    parsed.data.targetWords,
  );
  if (!decision.allowed) {
    return c.json({ error: decision.reason, code: decision.code }, 402);
  }

  // Claim the allowance before starting work, so two requests racing cannot both
  // pass the check.
  if (!usage.reserve(claims.sub, decision.entitlement.compilesPerPeriod)) {
    return c.json(
      { error: "That used your last compile for this period.", code: "quota" },
      402,
    );
  }

  try {
    const job = queue.enqueue({
      projectId: parsed.data.projectId,
      title: parsed.data.title,
      form: parsed.data.form,
      targetWords: decision.targetWords,
      fragments: parsed.data.fragments,
      previousState: (parsed.data.previousState ?? null) as never,
      entitlement: decision.entitlement,
      account: claims.sub,
    });

    return c.json(
      {
        jobId: job.id,
        tier: claims.tier,
        budgetUsd: decision.entitlement.budgetUsd,
        targetWords: decision.targetWords,
        clamped: decision.targetWords < parsed.data.targetWords,
      },
      202,
    );
  } catch (err: unknown) {
    usage.release(claims.sub);
    throw err;
  }
});

/** Jobs are readable only by the account that started them. */
function ownedJob(c: { get: (k: "claims") => TokenClaims; req: { param: (k: string) => string } }) {
  const job = queue.get(c.req.param("id"));
  if (job === null) return null;
  return job.account === c.get("claims").sub ? job : null;
}

app.get("/v1/compile/:id", (c) => {
  const job = ownedJob(c);
  if (job === null) return c.json({ error: "No such job" }, 404);

  return c.json({
    id: job.id,
    status: job.status,
    progress: job.progress,
    error: job.error,
    attempts: job.attempts,
    result:
      job.result === null
        ? null
        : {
            words: job.result.words,
            costUsd: job.result.costUsd,
            coverage: job.result.coverage,
            reusedScenes: job.result.reusedScenes,
            rebuiltScenes: job.result.rebuiltScenes,
            continuityIssues: job.result.continuityIssues.length,
            continuityAssessment: job.result.continuityAssessment,
            unusedFragments: job.result.unusedFragments,
          },
  });
});

/**
 * The account's recent jobs.
 *
 * A client that was killed mid-poll — reinstalled, or simply swiped away — has
 * lost the job id it was holding. Without this the compile it already paid for
 * is unreachable even though the worker finished it.
 */
app.get("/v1/compiles", (c) =>
  c.json({
    jobs: queue.listForAccount(c.get("claims").sub, 20).map((job) => ({
      id: job.id,
      status: job.status,
      projectId: job.request.projectId,
      title: job.request.title,
      createdAt: job.createdAt,
      finishedAt: job.finishedAt,
      progress: job.progress,
      error: job.error,
      words: job.result?.words ?? 0,
    })),
  }),
);

app.post("/v1/compile/:id/cancel", (c) => {
  const job = ownedJob(c);
  if (job === null) return c.json({ error: "No such job" }, 404);
  return queue.cancel(job.id)
    ? c.json({ cancelled: true })
    : c.json({ error: "Job is not cancellable" }, 409);
});

/** The finished manuscript, fetched once and written straight into local SQLite. */
app.get("/v1/compile/:id/manuscript", (c) => {
  const job = ownedJob(c);
  if (job === null) return c.json({ error: "No such job" }, 404);
  if (job.result === null) return c.json({ error: "Job has not produced a manuscript" }, 409);

  return c.json({
    state: {
      bible: job.result.state.bible,
      outline: job.result.state.outline,
      ledger: job.result.state.ledger,
      compiledAt: job.result.state.compiledAt,
    },
    scenes: job.result.manuscript.scenes,
  });
});

const port = Number(process.env.PORT ?? 8787);

if (process.env.NODE_ENV !== "test") {
  serve({ fetch: app.fetch, port });
  const warnings = [
    apiKey === undefined ? "no ANTHROPIC_API_KEY — compiles and enrichment disabled" : null,
    tokenSecret === undefined ? "no LOOM_TOKEN_SECRET — all authenticated routes refuse" : null,
  ].filter(Boolean);
  // eslint-disable-next-line no-console
  console.log(`loom worker on :${port}${warnings.length > 0 ? ` (${warnings.join("; ")})` : ""}`);
}

export { app, queue, usage, jobStore, syncStore };
