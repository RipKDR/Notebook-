import type { EntityId, SceneId } from "./ids.js";

/**
 * The continuity ledger is an append-only log of state deltas, one batch per
 * drafted scene. It is what catches "she broke her arm in chapter 3 but is
 * climbing in chapter 7".
 *
 * It exists because the drafting stage is deliberately myopic — each scene call
 * sees the Bible and its immediate neighbours, not the whole book. The ledger is
 * how facts established in scene 4 reach scene 61 without paying to re-read
 * everything in between.
 */

export const DELTA_KINDS = [
  "knowledge", // X now knows Y
  "location", // X is now at Y
  "condition", // X is injured / ill / changed physically
  "relationship", // X and Y's relationship changed
  "possession", // X now has / lost Y
  "time", // Elapsed time since the previous scene
  "world", // A fact about the world was established
  "death", // Terminal state. Checked hardest.
] as const;

export type DeltaKind = (typeof DELTA_KINDS)[number];

export interface StateDelta {
  readonly kind: DeltaKind;
  /** Entities this delta constrains. Used to slice the ledger per scene. */
  readonly subjects: readonly EntityId[];
  /** Present-tense statement of what is now true. "Mara knows her father lied." */
  readonly statement: string;
  /** The scene that established it. */
  readonly sceneId: SceneId;
  /** Reading-order position, so we can ask "what was true *before* scene N". */
  readonly order: number;
}

export interface ContinuityLedger {
  readonly deltas: readonly StateDelta[];
}

export const emptyLedger: ContinuityLedger = { deltas: [] };

export function appendDeltas(
  ledger: ContinuityLedger,
  deltas: readonly StateDelta[],
): ContinuityLedger {
  return { deltas: [...ledger.deltas, ...deltas] };
}

/**
 * Everything established before `order` that touches any of `entities`.
 *
 * This slice is what a scene drafting call actually receives — typically 10-30
 * lines rather than the full ledger, which by the end of a novel runs to
 * hundreds. Slicing is the difference between a 4K and a 40K prompt.
 */
export function sliceForScene(
  ledger: ContinuityLedger,
  entities: readonly EntityId[],
  order: number,
): StateDelta[] {
  const want = new Set(entities);
  return ledger.deltas
    .filter((d) => d.order < order)
    .filter((d) => d.kind === "world" || d.subjects.some((s) => want.has(s)))
    .sort((a, b) => a.order - b.order);
}

/** The most recent statement of each kind per subject — the "current state" view. */
export function currentState(
  ledger: ContinuityLedger,
  order: number = Number.MAX_SAFE_INTEGER,
): StateDelta[] {
  const latest = new Map<string, StateDelta>();
  for (const d of ledger.deltas) {
    if (d.order >= order) continue;
    for (const s of d.subjects) {
      const key = `${s}::${d.kind}`;
      const prev = latest.get(key);
      if (!prev || prev.order < d.order) latest.set(key, d);
    }
  }
  return [...latest.values()].sort((a, b) => a.order - b.order);
}
