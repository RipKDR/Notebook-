import Anthropic from "@anthropic-ai/sdk";
import {
  addUsage,
  costUsd,
  MODELS,
  PRICING,
  zeroUsage,
  type CostBudget,
  type ModelId,
  type ModelRole,
  type TokenUsage,
} from "./models.js";
import type { Effort, UsageEvent } from "./client.js";

/**
 * Batched generation.
 *
 * Scene drafting is ~80 independent calls sharing an identical cached prefix.
 * That is exactly the shape the Batch API is built for, and it halves the price
 * of the single most expensive stage. The cost is latency: most batches finish
 * within an hour, with a 24-hour ceiling.
 *
 * That trade is right for a full compile — the user taps "write my book", closes
 * the app and gets a push notification — and wrong for a single-chapter preview,
 * which must feel instant. So the pipeline batches full compiles and runs
 * previews synchronously through `Llm.prose`. Same prompts, same prefix, two
 * latency profiles.
 *
 * Because a batch can span the full hour, its shared prefix uses the 1-hour cache
 * TTL: the doubled write premium is paid once and read back ~80 times at 0.1x.
 */

export interface BatchRequest {
  /** Caller's key. Results come back in arbitrary order and are matched on this. */
  readonly customId: string;
  readonly system: string;
  readonly user: string;
  readonly maxTokens?: number;
  readonly effort?: Effort;
}

export interface BatchSuccess {
  readonly customId: string;
  readonly ok: true;
  readonly text: string;
  readonly usage: TokenUsage;
  readonly costUsd: number;
}

export interface BatchFailure {
  readonly customId: string;
  readonly ok: false;
  readonly reason: "errored" | "canceled" | "expired" | "empty";
  readonly detail: string;
}

export type BatchResult = BatchSuccess | BatchFailure;

export interface BatchProgress {
  readonly processing: number;
  readonly succeeded: number;
  readonly errored: number;
  readonly canceled: number;
  readonly expired: number;
  readonly total: number;
}

export interface BatchOptions {
  readonly stage: string;
  readonly role: ModelRole;
  readonly budget?: CostBudget;
  readonly onUsage?: (e: UsageEvent) => void;
  readonly onProgress?: (p: BatchProgress) => void;
  /** How often to poll. Batches are slow; polling fast just burns rate limit. */
  readonly pollIntervalMs?: number;
  /** Give up after this long. Defaults to the API's own 24-hour ceiling. */
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
}

/** The Batch API caps a single batch at 100,000 requests; we chunk well below that. */
const MAX_BATCH_SIZE = 10_000;

export class BatchRunner {
  private readonly client: Anthropic;

  constructor(apiKey?: string) {
    this.client = new Anthropic(apiKey !== undefined ? { apiKey } : {});
  }

  async run(
    requests: readonly BatchRequest[],
    opts: BatchOptions,
  ): Promise<Map<string, BatchResult>> {
    const results = new Map<string, BatchResult>();
    if (requests.length === 0) return results;

    for (let i = 0; i < requests.length; i += MAX_BATCH_SIZE) {
      const chunk = requests.slice(i, i + MAX_BATCH_SIZE);
      const chunkResults = await this.runChunk(chunk, opts);
      for (const [k, v] of chunkResults) results.set(k, v);
    }
    return results;
  }

  private async runChunk(
    requests: readonly BatchRequest[],
    opts: BatchOptions,
  ): Promise<Map<string, BatchResult>> {
    const model: ModelId = MODELS[opts.role];
    const maxOutput = PRICING[model].maxOutput;

    const batch = await this.client.messages.batches.create({
      requests: requests.map((r) => ({
        custom_id: r.customId,
        params: {
          model,
          max_tokens: Math.min(r.maxTokens ?? 16_000, maxOutput),
          system: [
            {
              type: "text" as const,
              text: r.system,
              // 1-hour TTL: the batch itself may span that long between the first
              // prefix write and the last read.
              cache_control: { type: "ephemeral" as const, ttl: "1h" as const },
            },
          ],
          messages: [{ role: "user" as const, content: r.user }],
          ...(model === "claude-haiku-4-5"
            ? {}
            : { thinking: { type: "adaptive" as const } }),
          ...(r.effort ? { output_config: { effort: r.effort } } : {}),
        },
      })),
    });

    await this.awaitCompletion(batch.id, requests.length, opts);
    return this.collect(batch.id, model, opts);
  }

  private async awaitCompletion(
    batchId: string,
    total: number,
    opts: BatchOptions,
  ): Promise<void> {
    const interval = opts.pollIntervalMs ?? 15_000;
    const timeout = opts.timeoutMs ?? 24 * 60 * 60 * 1000;
    const deadline = Date.now() + timeout;

    for (;;) {
      if (opts.signal?.aborted === true) {
        await this.client.messages.batches.cancel(batchId).catch(() => undefined);
        throw new Error(`Batch ${batchId} cancelled at stage "${opts.stage}"`);
      }

      const status = await this.client.messages.batches.retrieve(batchId);
      const counts = status.request_counts;
      opts.onProgress?.({
        processing: counts.processing,
        succeeded: counts.succeeded,
        errored: counts.errored,
        canceled: counts.canceled,
        expired: counts.expired,
        total,
      });

      if (status.processing_status === "ended") return;

      if (Date.now() > deadline) {
        await this.client.messages.batches.cancel(batchId).catch(() => undefined);
        throw new Error(
          `Batch ${batchId} exceeded ${Math.round(timeout / 60_000)}min at stage "${opts.stage}"`,
        );
      }
      await new Promise((r) => setTimeout(r, interval));
    }
  }

  private async collect(
    batchId: string,
    model: ModelId,
    opts: BatchOptions,
  ): Promise<Map<string, BatchResult>> {
    const out = new Map<string, BatchResult>();
    let aggregate: TokenUsage = zeroUsage;
    const startedAt = Date.now();

    for await (const entry of await this.client.messages.batches.results(batchId)) {
      const customId = entry.custom_id;

      if (entry.result.type !== "succeeded") {
        out.set(customId, {
          customId,
          ok: false,
          reason: entry.result.type,
          detail:
            entry.result.type === "errored"
              ? JSON.stringify(entry.result.error)
              : `Request ${entry.result.type}`,
        });
        continue;
      }

      const message = entry.result.message;
      const text = message.content
        .filter((b): b is Anthropic.TextBlock => b.type === "text")
        .map((b) => b.text)
        .join("");

      const usage: TokenUsage = {
        inputTokens: message.usage.input_tokens ?? 0,
        outputTokens: message.usage.output_tokens ?? 0,
        cacheReadTokens: message.usage.cache_read_input_tokens ?? 0,
        cacheWriteTokens: message.usage.cache_creation_input_tokens ?? 0,
      };
      aggregate = addUsage(aggregate, usage);

      if (text.trim().length === 0) {
        out.set(customId, {
          customId,
          ok: false,
          reason: "empty",
          detail: `Model returned no text (stop_reason: ${message.stop_reason ?? "unknown"})`,
        });
        continue;
      }

      out.set(customId, {
        customId,
        ok: true,
        text,
        usage,
        costUsd: costUsd(model, usage, { batch: true, cacheTtl: "1h" }),
      });
    }

    const total = costUsd(model, aggregate, { batch: true, cacheTtl: "1h" });
    opts.budget?.record(opts.stage, total);
    opts.onUsage?.({
      stage: opts.stage,
      model,
      usage: aggregate,
      costUsd: total,
      batched: true,
      durationMs: Date.now() - startedAt,
    });

    return out;
  }
}
