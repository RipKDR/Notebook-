import type { ChapterId, CompileId, FragmentId, ProjectId, SceneId } from "./ids.js";

/**
 * A drafted scene. `contentHash` is the content-addressed build key: it folds in
 * the Bible version, the scene card, the assigned fragments and the preceding
 * scene's tail. If any of those change, the hash changes and the scene rebuilds.
 * If none change, we reuse the prose and spend nothing.
 */
export interface DraftedScene {
  readonly sceneId: SceneId;
  readonly chapterId: ChapterId;
  readonly prose: string;
  readonly wordCount: number;
  /** Build key. See `src/cache/content-address.ts`. */
  readonly contentHash: string;
  /** Which pipeline passes have been applied to this prose, in order. */
  readonly passes: readonly PassName[];
  /** Fragments the drafter reports it actually used. Checked against the scene card. */
  readonly usedFragments: readonly FragmentId[];
  readonly model: string;
  readonly costUsd: number;
  readonly draftedAt: number;
}

export const PASS_NAMES = [
  "draft",
  "transitions",
  "continuity",
  "voice",
  "payoff",
] as const;
export type PassName = (typeof PASS_NAMES)[number];

export interface Manuscript {
  readonly projectId: ProjectId;
  readonly compileId: CompileId;
  readonly bibleVersion: number;
  readonly outlineVersion: number;
  readonly scenes: readonly DraftedScene[];
  readonly createdAt: number;
}

export function manuscriptWords(m: Manuscript): number {
  return m.scenes.reduce((n, s) => n + s.wordCount, 0);
}

export function manuscriptCost(m: Manuscript): number {
  return m.scenes.reduce((n, s) => n + s.costUsd, 0);
}

export function countWords(prose: string): number {
  const trimmed = prose.trim();
  if (trimmed.length === 0) return 0;
  return trimmed.split(/\s+/).length;
}
