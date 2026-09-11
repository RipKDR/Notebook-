import type { EntityId, FragmentId, ProjectId } from "./ids.js";

/**
 * What kind of raw material a fragment is. Assigned by the enrichment stage.
 * This drives how the outliner is allowed to spend it: a `scene` can anchor a
 * scene on its own, an `aphorism` can only be woven into one.
 */
export const FRAGMENT_KINDS = [
  "scene", // A concrete moment with action, place, people.
  "dialogue", // Overheard or imagined speech.
  "character", // An observation about a person.
  "setting", // A place, an atmosphere, a sensory impression.
  "premise", // A what-if, a plot seed, a structural idea.
  "theme", // An abstract concern the work keeps circling.
  "aphorism", // A standalone line worth keeping for its own sake.
  "memory", // A remembered real event (dominant kind in memoir).
  "reflection", // Commentary, analysis, the author thinking aloud.
  "fragmentary", // Too short or too oblique to classify. Still usable as texture.
] as const;

export type FragmentKind = (typeof FRAGMENT_KINDS)[number];

/** How a fragment entered the app. Capture friction is the product's life or death, so we measure it. */
export type CaptureSource = "quick" | "widget" | "share" | "voice" | "import" | "editor";

export interface EntityMention {
  readonly entityId: EntityId;
  /** Surface form as it literally appeared, e.g. "my grandmother", "Nan". */
  readonly surface: string;
  readonly kind: "person" | "place" | "object" | "organisation" | "event";
}

/**
 * Enrichment output. Produced asynchronously by a cheap model shortly after
 * capture, so that compile time is never spent on work that could have been
 * done months earlier. Null until the enricher has run.
 */
export interface FragmentEnrichment {
  readonly kind: FragmentKind;
  /** One clause, <= 120 chars. What this fragment *is*, for the outliner to scan. */
  readonly digest: string;
  readonly entities: readonly EntityMention[];
  /** Free-form thematic tags, lowercased. Used as a clustering signal alongside embeddings. */
  readonly themes: readonly string[];
  /** -1 bleak .. 0 neutral .. +1 luminous. Used to pace emotional variety across chapters. */
  readonly valence: number;
  /** 0..1 — how self-contained the fragment is. High = can anchor a scene; low = texture only. */
  readonly standalone: number;
  /** Model + prompt version that produced this, so we can re-enrich selectively when prompts change. */
  readonly enricherVersion: string;
  readonly enrichedAt: number;
}

export interface Fragment {
  readonly id: FragmentId;
  readonly projectId: ProjectId | null;
  readonly text: string;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly source: CaptureSource;
  /** Soft delete — fragments are the user's raw writing and are never hard-deleted by the pipeline. */
  readonly deletedAt: number | null;
  /** User-pinned fragments are guaranteed placement in the outline. */
  readonly pinned: boolean;
  readonly enrichment: FragmentEnrichment | null;
  /** Unit-norm embedding vector. Null until embedded. */
  readonly embedding: Float32Array | null;
}

export function isEnriched(
  f: Fragment,
): f is Fragment & { enrichment: FragmentEnrichment } {
  return f.enrichment !== null;
}

export function isUsable(f: Fragment): boolean {
  return f.deletedAt === null && f.text.trim().length > 0;
}

/** Rough token estimate for budgeting. Deliberately cheap — we never ship a tokenizer to the phone. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 3.6);
}
