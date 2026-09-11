import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import type { z } from "zod";
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

/**
 * The pipeline's single point of contact with the model API.
 *
 * Everything the stages need — routing, prompt caching, structured output,
 * batching, retries, usage accounting — lives here so that no stage has to think
 * about any of it. A stage says "architect, structured, this schema" and gets a
 * typed object back with the cost already booked against the compile budget.
 */

export interface LlmOptions {
  readonly apiKey?: string;
  readonly budget?: CostBudget;
  /** Called after every request. Used for live progress and for telemetry. */
  readonly onUsage?: (event: UsageEvent) => void;
  readonly maxRetries?: number;
}

export interface UsageEvent {
  readonly stage: string;
  readonly model: ModelId;
  readonly usage: TokenUsage;
  readonly costUsd: number;
  readonly batched: boolean;
  readonly durationMs: number;
}

export type Effort = "low" | "medium" | "high" | "xhigh" | "max";

export interface CallSpec {
  /** Stage name, for budget attribution and logging. */
  readonly stage: string;
  readonly role: ModelRole;
  /**
   * The stable, cacheable prefix. Put the Bible, the style guide and the
   * instructions here and nothing volatile — a single changed byte invalidates
   * the cache for every subsequent call in the compile.
   */
  readonly system: string;
  /** The volatile, per-call content. Never cached. */
  readonly user: string;
  readonly maxTokens?: number;
  readonly effort?: Effort;
  /**
   * Cache TTL. Scene drafting uses "1h" because a batch can take up to an hour
   * between the first and last request sharing the prefix; interactive calls use
   * the cheaper 5-minute default.
   */
  readonly cacheTtl?: "5m" | "1h";
}

export class LlmError extends Error {
  constructor(
    message: string,
    readonly stage: string,
    readonly cause?: unknown,
  ) {
    super(message);
    this.name = "LlmError";
  }
}

/** Haiku 4.5 predates adaptive thinking and still takes an explicit token budget. */
function thinkingFor(model: ModelId): Anthropic.ThinkingConfigParam | undefined {
  if (model === "claude-haiku-4-5") return undefined;
  return { type: "adaptive" };
}

function usageFrom(u: Anthropic.Usage): TokenUsage {
  return {
    inputTokens: u.input_tokens ?? 0,
    outputTokens: u.output_tokens ?? 0,
    cacheReadTokens: u.cache_read_input_tokens ?? 0,
    cacheWriteTokens: u.cache_creation_input_tokens ?? 0,
  };
}

function textOf(content: readonly Anthropic.ContentBlock[]): string {
  return content
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("");
}

const RETRYABLE = new Set([408, 409, 429, 500, 502, 503, 504, 529]);

export class Llm {
  private readonly client: Anthropic;
  private readonly budget: CostBudget | undefined;
  private readonly onUsage: ((e: UsageEvent) => void) | undefined;
  private readonly maxRetries: number;
  private total: TokenUsage = zeroUsage;

  constructor(opts: LlmOptions = {}) {
    this.client = new Anthropic(
      opts.apiKey !== undefined ? { apiKey: opts.apiKey } : {},
    );
    this.budget = opts.budget;
    this.onUsage = opts.onUsage;
    this.maxRetries = opts.maxRetries ?? 3;
  }

  get totalUsage(): TokenUsage {
    return this.total;
  }

  private book(
    stage: string,
    model: ModelId,
    usage: Anthropic.Usage,
    batched: boolean,
    startedAt: number,
    cacheTtl: "5m" | "1h",
  ): void {
    const u = usageFrom(usage);
    this.total = addUsage(this.total, u);
    const cost = costUsd(model, u, { batch: batched, cacheTtl });
    this.budget?.record(stage, cost);
    this.onUsage?.({
      stage,
      model,
      usage: u,
      costUsd: cost,
      batched,
      durationMs: Date.now() - startedAt,
    });
  }

  private systemBlocks(
    system: string,
    cacheTtl: "5m" | "1h",
  ): Anthropic.TextBlockParam[] {
    return [
      {
        type: "text",
        text: system,
        cache_control: cacheTtl === "1h" ? { type: "ephemeral", ttl: "1h" } : { type: "ephemeral" },
      },
    ];
  }

  private async withRetry<T>(stage: string, fn: () => Promise<T>): Promise<T> {
    let lastError: unknown;
    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      try {
        return await fn();
      } catch (err: unknown) {
        lastError = err;
        const status =
          err instanceof Anthropic.APIError ? (err.status ?? 0) : 0;
        const retryable =
          err instanceof Anthropic.APIConnectionError || RETRYABLE.has(status);
        if (!retryable || attempt === this.maxRetries) break;
        // Exponential backoff with jitter: 1s, 2s, 4s (+/- 25%).
        const base = 1000 * 2 ** attempt;
        const jitter = base * 0.25 * (Math.random() * 2 - 1);
        await new Promise((r) => setTimeout(r, base + jitter));
      }
    }
    throw new LlmError(
      `Request failed at stage "${stage}" after ${this.maxRetries + 1} attempts`,
      stage,
      lastError,
    );
  }

  /**
   * A prose call. Streams, because prose calls run to tens of thousands of
   * tokens and a non-streaming request that large trips the HTTP timeout.
   */
  async prose(spec: CallSpec): Promise<{ text: string; usage: TokenUsage }> {
    const model = MODELS[spec.role];
    const cacheTtl = spec.cacheTtl ?? "5m";
    const maxTokens = Math.min(spec.maxTokens ?? 16_000, PRICING[model].maxOutput);
    const startedAt = Date.now();

    return this.withRetry(spec.stage, async () => {
      const stream = this.client.messages.stream({
        model,
        max_tokens: maxTokens,
        system: this.systemBlocks(spec.system, cacheTtl),
        messages: [{ role: "user", content: spec.user }],
        ...(thinkingFor(model) ? { thinking: thinkingFor(model)! } : {}),
        ...(spec.effort ? { output_config: { effort: spec.effort } } : {}),
      });
      const message = await stream.finalMessage();
      this.book(spec.stage, model, message.usage, false, startedAt, cacheTtl);
      return { text: textOf(message.content), usage: usageFrom(message.usage) };
    });
  }

  /**
   * A structured-extraction call. Returns a validated object or throws — we never
   * hand a half-parsed Bible to the outliner.
   */
  async structured<T extends z.ZodType>(
    spec: CallSpec,
    schema: T,
  ): Promise<{ value: z.infer<T>; usage: TokenUsage }> {
    const model = MODELS[spec.role];
    const cacheTtl = spec.cacheTtl ?? "5m";
    const maxTokens = Math.min(spec.maxTokens ?? 16_000, PRICING[model].maxOutput);
    const startedAt = Date.now();

    return this.withRetry(spec.stage, async () => {
      const response = await this.client.messages.parse({
        model,
        max_tokens: maxTokens,
        system: this.systemBlocks(spec.system, cacheTtl),
        messages: [{ role: "user", content: spec.user }],
        output_config: {
          format: zodOutputFormat(schema),
          ...(spec.effort ? { effort: spec.effort } : {}),
        },
        ...(thinkingFor(model) ? { thinking: thinkingFor(model)! } : {}),
      });

      this.book(spec.stage, model, response.usage, false, startedAt, cacheTtl);

      if (response.parsed_output === null || response.parsed_output === undefined) {
        throw new LlmError(
          `Structured output failed to parse at stage "${spec.stage}"`,
          spec.stage,
        );
      }
      return {
        value: response.parsed_output as z.infer<T>,
        usage: usageFrom(response.usage),
      };
    });
  }
}
