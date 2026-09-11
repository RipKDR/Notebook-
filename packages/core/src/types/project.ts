import type { ProjectId } from "./ids.js";
import type { WorkForm } from "./bible.js";

export type CompileStatus =
  | "idle"
  | "enriching"
  | "clustering"
  | "bible"
  | "outlining"
  | "drafting"
  | "revising"
  | "complete"
  | "failed";

export interface Project {
  readonly id: ProjectId;
  readonly title: string;
  readonly form: WorkForm;
  /** Target length in words. Drives scene count and per-scene budgets. */
  readonly targetWords: number;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly archivedAt: number | null;
}

/** Length presets. The default is a real book, not a pamphlet. */
export const LENGTH_PRESETS = {
  novella: 40_000,
  novel: 100_000,
  epic: 160_000,
} as const;

export type LengthPreset = keyof typeof LENGTH_PRESETS;
