import type { ChapterId, FragmentId, OutlineId, ProjectId, SceneId, EntityId } from "./ids.js";

/**
 * The outline is not a summary — it is a *consumption plan*.
 *
 * Every scene card names the exact fragments it must incorporate. This is what
 * guarantees the user's actual writing ends up in the book rather than being
 * vaguely "inspired by". It also bounds every drafting call to a verifiable job:
 * "write 1,250 words that get us from state A to state B and use these six notes."
 */

export interface SceneCard {
  readonly id: SceneId;
  readonly chapterId: ChapterId;
  /** Position within the chapter, 0-based. */
  readonly index: number;
  /** Imperative summary of what happens. 1-2 sentences. */
  readonly goal: string;
  readonly pov: EntityId | null;
  readonly setting: string;
  /** Entities present in the scene. Used to slice the continuity ledger for this call. */
  readonly present: readonly EntityId[];
  /** World/character state as the scene opens. */
  readonly enteringState: string;
  /** What must be true when the scene closes. The next scene depends on this. */
  readonly exitingState: string;
  /** The user's own fragments this scene is obligated to use. The whole point. */
  readonly fragmentIds: readonly FragmentId[];
  readonly targetWords: number;
  /** -1..1, planned emotional register. The outliner varies this to avoid tonal flatness. */
  readonly valence: number;
  /** Motifs from the Bible to seed here. Drives resonance across the whole book. */
  readonly motifs: readonly string[];
}

export interface ChapterCard {
  readonly id: ChapterId;
  readonly index: number;
  readonly title: string;
  readonly summary: string;
  /** Which act/part this belongs to. Forms define their own act labels. */
  readonly part: string;
  readonly scenes: readonly SceneCard[];
}

export interface Outline {
  readonly id: OutlineId;
  readonly projectId: ProjectId;
  readonly version: number;
  /** The Bible version this outline was planned against. */
  readonly bibleVersion: number;
  readonly chapters: readonly ChapterCard[];
  readonly targetWords: number;
  /** Fragments deliberately left out, with a reason. Surfaced to the user — never silently dropped. */
  readonly unusedFragments: readonly { fragmentId: FragmentId; reason: string }[];
  readonly createdAt: number;
}

export function allScenes(outline: Outline): SceneCard[] {
  return outline.chapters.flatMap((c) => c.scenes);
}

export function sceneCount(outline: Outline): number {
  return outline.chapters.reduce((n, c) => n + c.scenes.length, 0);
}

export function plannedWords(outline: Outline): number {
  return allScenes(outline).reduce((n, s) => n + s.targetWords, 0);
}

/** Every fragment assigned anywhere in the outline. */
export function assignedFragments(outline: Outline): Set<FragmentId> {
  const out = new Set<FragmentId>();
  for (const s of allScenes(outline)) for (const f of s.fragmentIds) out.add(f);
  return out;
}

export function findScene(outline: Outline, id: SceneId): SceneCard | undefined {
  return allScenes(outline).find((s) => s.id === id);
}

/** Scene immediately before `id` in reading order, across chapter boundaries. */
export function previousScene(outline: Outline, id: SceneId): SceneCard | undefined {
  const scenes = allScenes(outline);
  const i = scenes.findIndex((s) => s.id === id);
  return i > 0 ? scenes[i - 1] : undefined;
}

export function nextScene(outline: Outline, id: SceneId): SceneCard | undefined {
  const scenes = allScenes(outline);
  const i = scenes.findIndex((s) => s.id === id);
  return i >= 0 && i < scenes.length - 1 ? scenes[i + 1] : undefined;
}
