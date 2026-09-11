/**
 * Model routing and cost accounting.
 *
 * Routing is the single largest cost lever in this system. A full compile makes
 * roughly a thousand model calls, and they are not equally valuable:
 *
 *   - Enrichment runs thousands of times and needs classification, not judgement.
 *   - Scene drafting runs ~80 times and needs good prose.
 *   - The Bible and outline run *once* and every other call inherits their
 *     quality. Structural mistakes there are unrecoverable downstream.
 *
 * So we spend the most on the fewest calls. See `docs/ARCHITECTURE.md` for the
 * full cost table.
 */

export const MODELS = {
  /** Structural work. Runs once per compile; quality compounds across the whole book. */
  architect: "claude-opus-5",
  /** Prose generation. Runs per scene, batched. */
  writer: "claude-sonnet-5",
  /** Bulk classification and extraction. Runs per fragment, continuously. */
  clerk: "claude-haiku-4-5",
} as const;

export type ModelRole = keyof typeof MODELS;
export type ModelId = (typeof MODELS)[ModelRole];

/** USD per million tokens, Anthropic first-party API list price. */
export interface Pricing {
  readonly input: number;
  readonly output: number;
  /** Cache reads are ~0.1x base input. */
  readonly cacheRead: number;
  /** 5-minute-TTL cache writes are 1.25x base input. */
  readonly cacheWrite5m: number;
  /** 1-hour-TTL cache writes are 2x base input. */
  readonly cacheWrite1h: number;
  readonly contextWindow: number;
  readonly maxOutput: number;
}

export const PRICING: Record<ModelId, Pricing> = {
  "claude-opus-5": {
    input: 5.0,
    output: 25.0,
    cacheRead: 0.5,
    cacheWrite5m: 6.25,
    cacheWrite1h: 10.0,
    contextWindow: 1_000_000,
    maxOutput: 128_000,
  },
  "claude-sonnet-5": {
    input: 2.0,
    output: 10.0,
    cacheRead: 0.2,
    cacheWrite5m: 2.5,
    cacheWrite1h: 4.0,
    contextWindow: 1_000_000,
    maxOutput: 128_000,
  },
  "claude-haiku-4-5": {
    input: 1.0,
    output: 5.0,
    cacheRead: 0.1,
    cacheWrite5m: 1.25,
    cacheWrite1h: 2.0,
    contextWindow: 200_000,
    maxOutput: 64_000,
  },
};

/** The Batch API runs asynchronously at 50% of standard price. */
export const BATCH_DISCOUNT = 0.5;

export interface TokenUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens: number;
  readonly cacheWriteTokens: number;
}

export const zeroUsage: TokenUsage = {
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
};

export function addUsage(a: TokenUsage, b: TokenUsage): TokenUsage {
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    cacheReadTokens: a.cacheReadTokens + b.cacheReadTokens,
    cacheWriteTokens: a.cacheWriteTokens + b.cacheWriteTokens,
  };
}

export interface CostOptions {
  readonly batch?: boolean;
  readonly cacheTtl?: "5m" | "1h";
}

export function costUsd(
  model: ModelId,
  usage: TokenUsage,
  opts: CostOptions = {},
): number {
  const p = PRICING[model];
  const write = opts.cacheTtl === "1h" ? p.cacheWrite1h : p.cacheWrite5m;
  const perMillion =
    usage.inputTokens * p.input +
    usage.outputTokens * p.output +
    usage.cacheReadTokens * p.cacheRead +
    usage.cacheWriteTokens * write;
  const gross = perMillion / 1_000_000;
  return opts.batch === true ? gross * BATCH_DISCOUNT : gross;
}

/**
 * A hard spend ceiling for one compile. Exceeding it aborts rather than
 * surprising the user (or us) with a bill. Entitlements convert a subscription
 * or a credit purchase into one of these.
 */
export class CostBudget {
  private spent = 0;
  private readonly byStage = new Map<string, number>();

  constructor(readonly limitUsd: number) {
    if (!(limitUsd > 0)) throw new RangeError(`Budget must be positive, got ${limitUsd}`);
  }

  get spentUsd(): number {
    return this.spent;
  }

  get remainingUsd(): number {
    return Math.max(0, this.limitUsd - this.spent);
  }

  breakdown(): Record<string, number> {
    return Object.fromEntries(this.byStage);
  }

  /** Records spend. Returns false once the budget is exhausted so callers can stop cleanly. */
  record(stage: string, usd: number): boolean {
    this.spent += usd;
    this.byStage.set(stage, (this.byStage.get(stage) ?? 0) + usd);
    return this.spent <= this.limitUsd;
  }

  /** Throws before an expensive call we cannot afford, rather than after. */
  assertCanSpend(stage: string, estimateUsd: number): void {
    if (this.spent + estimateUsd > this.limitUsd) {
      throw new BudgetExceededError(stage, this.spent, estimateUsd, this.limitUsd);
    }
  }
}

export class BudgetExceededError extends Error {
  constructor(
    readonly stage: string,
    readonly spentUsd: number,
    readonly attemptedUsd: number,
    readonly limitUsd: number,
  ) {
    super(
      `Compile budget exhausted at stage "${stage}": spent $${spentUsd.toFixed(2)} ` +
        `+ $${attemptedUsd.toFixed(2)} would exceed the $${limitUsd.toFixed(2)} limit.`,
    );
    this.name = "BudgetExceededError";
  }
}
