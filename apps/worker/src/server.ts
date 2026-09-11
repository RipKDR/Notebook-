import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { z } from "zod";
import { authorise, ENTITLEMENTS, type Tier, type Usage } from "./entitlements.js";
import { CompileQueue } from "./jobs.js";

/**
 * The compile service.
 *
 * It exists for one structural reason: the Anthropic API key must never reach a
 * phone. An app bundle is not a secret — anyone can pull strings out of an IPA
 * in minutes — so a client-side key is a credential handed to every installer,
 * billed to us.
 *
 * Everything else here follows from that. The worker holds the key, enforces
 * entitlements, and runs jobs the client polls.
 */

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

const apiKey = process.env.ANTHROPIC_API_KEY;
const queue = new CompileQueue({
  ...(apiKey !== undefined ? { apiKey } : {}),
  ...(process.env.VOYAGE_API_KEY !== undefined
    ? { voyageApiKey: process.env.VOYAGE_API_KEY }
    : {}),
  concurrency: Number(process.env.COMPILE_CONCURRENCY ?? 2),
});

const app = new Hono();

app.get("/health", (c) =>
  c.json({
    ok: true,
    modelAccess: apiKey !== undefined,
    ...queue.stats(),
  }),
);

/**
 * Resolves the caller's tier.
 *
 * A real deployment verifies a signed session and reads the subscription from
 * the billing provider. This reads a header, which is correct for local
 * development and obviously insufficient for production — the boundary is
 * marked here deliberately so it cannot be shipped by accident.
 */
function resolveTier(header: string | undefined): Tier {
  return header === "paid" ? "paid" : "free";
}

function resolveUsage(): Usage {
  // Placeholder for the billing-backed counter. Zero here means the quota check
  // is structurally present but not yet enforcing.
  return { compilesThisPeriod: 0, periodResetsAt: Date.now() + 30 * 86_400_000 };
}

app.post("/v1/compile", async (c) => {
  if (apiKey === undefined) {
    return c.json({ error: "This worker has no model access configured." }, 503);
  }

  const parsed = compileRequestSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) {
    return c.json(
      { error: "Invalid request", detail: parsed.error.issues.slice(0, 5) },
      400,
    );
  }

  const tier = resolveTier(c.req.header("x-loom-tier"));
  const decision = authorise(tier, resolveUsage(), parsed.data.targetWords);
  if (!decision.allowed) {
    return c.json({ error: decision.reason, code: decision.code }, 402);
  }

  const job = queue.enqueue({
    projectId: parsed.data.projectId,
    title: parsed.data.title,
    form: parsed.data.form,
    targetWords: decision.targetWords,
    fragments: parsed.data.fragments,
    previousState: (parsed.data.previousState ?? null) as never,
    entitlement: decision.entitlement,
  });

  return c.json(
    {
      jobId: job.id,
      tier,
      budgetUsd: decision.entitlement.budgetUsd,
      targetWords: decision.targetWords,
      clamped: decision.targetWords < parsed.data.targetWords,
    },
    202,
  );
});

app.get("/v1/compile/:id", (c) => {
  const job = queue.get(c.req.param("id"));
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
  const cancelled = queue.cancel(c.req.param("id"));
  return cancelled
    ? c.json({ cancelled: true })
    : c.json({ error: "Job is not cancellable" }, 409);
});

/** The finished manuscript, fetched once and written straight into local SQLite. */
app.get("/v1/compile/:id/manuscript", (c) => {
  const job = queue.get(c.req.param("id"));
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

app.get("/v1/tiers", (c) => c.json(ENTITLEMENTS));

const port = Number(process.env.PORT ?? 8787);

if (process.env.NODE_ENV !== "test") {
  serve({ fetch: app.fetch, port });
  // eslint-disable-next-line no-console
  console.log(
    `loom worker on :${port}` + (apiKey === undefined ? " (no ANTHROPIC_API_KEY — compiles disabled)" : ""),
  );
}

export { app, queue };
