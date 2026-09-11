import type { z } from "zod";
import type { BatchOptions, BatchRequest, BatchResult } from "./batch.js";
import type { CallSpec } from "./client.js";
import type { TokenUsage } from "./models.js";

/**
 * The model surface the pipeline actually depends on.
 *
 * Three methods. Extracting them as interfaces — rather than having every stage
 * name the concrete `Llm` and `BatchRunner` classes — exists so the compiler can
 * be run end-to-end without a network or a credential.
 *
 * That is not a hypothetical nicety. `compile()` threads eight stages together,
 * and every stage was unit-tested in isolation while the wiring between them had
 * never once executed. Unit tests do not catch a stage returning a shape the
 * next stage cannot read; only running the whole thing does.
 */

export interface LlmLike {
  prose(spec: CallSpec): Promise<{ text: string; usage: TokenUsage }>;
  structured<T extends z.ZodType>(
    spec: CallSpec,
    schema: T,
  ): Promise<{ value: z.infer<T>; usage: TokenUsage }>;
}

export interface BatchLike {
  run(
    requests: readonly BatchRequest[],
    opts: BatchOptions,
  ): Promise<Map<string, BatchResult>>;
}
