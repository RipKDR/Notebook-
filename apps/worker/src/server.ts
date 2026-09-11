import { serve } from "@hono/node-server";
import {
  LocalTrigramEmbeddings,
  Llm,
  VoyageEmbeddings,
  asFragmentId,
  enrichFragments,
  type EmbeddingProvider,
  type Fragment,
} from "@loom/core";
import { Hono } from "hono";
import { z } from "zod";
import { bearerFrom, verifyToken, type TokenClaims } from "./auth.js";
import { authorise, ENTITLEMENTS } from "./entitlements.js";
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

const queue = new CompileQueue({
  ...(apiKey !== undefined ? { apiKey } : {}),
  ...(process.env.VOYAGE_API_KEY !== undefined
    ? { voyageApiKey: process.env.VOYAGE_API_KEY }
    : {}),
  concurrency: Number(process.env.COMPILE_CONCURRENCY ?? 2),
});

const app = new Hono<{ Variables: { claims: TokenClaims } }>();

app.get("/health", (c) =>
  c.json({
    ok: true,
    modelAccess: apiKey !== undefined,
    authConfigured: tokenSecret !== undefined,
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
app.use("/v1/compile/*", async (c, next) => {
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
});
app.use("/v1/enrich", async (c, next) => {
  if (tokenSecret === undefined) {
    return c.json({ error: "This worker is not configured to accept requests." }, 503);
  }
  const token = bearerFrom(c.req.header("authorization"));
  if (token === null) return c.json({ error: "Missing bearer token." }, 401);
  const result = verifyToken(token, tokenSecret);
  if (!result.ok) return c.json({ error: result.reason }, 401);
  c.set("claims", result.claims);
  await next();
  return undefined;
});

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
      onSettled: (spentUsd, ok) => {
        if (ok) usage.recordSpend(claims.sub, spentUsd);
        else usage.release(claims.sub);
      },
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

export { app, queue, usage };
