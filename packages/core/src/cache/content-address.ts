import type { Fragment } from "../types/fragment.js";
import type { SceneCard } from "../types/outline.js";
import type { FragmentId } from "../types/ids.js";
import { sha256Hex } from "./sha256.js";

/**
 * Content-addressed build keys.
 *
 * The notebook is source; the book is a build artifact. Adding one note in month
 * seven must not trigger a $7.50, forty-minute rebuild of a hundred-thousand-word
 * manuscript. It should rebuild the three scenes that actually changed.
 *
 * A scene's key folds in everything the drafting call will see. Change any input
 * and the key changes; change nothing and we reuse the prose for free. This is
 * `make` for prose, and it is the difference between "compile as you go" being a
 * real feature and being a marketing line.
 */

/** Bump when a prompt or drafting strategy changes in a way that invalidates prior prose. */
export const DRAFT_STRATEGY_VERSION = 1;

/** Stable JSON: sorted keys, so key order never perturbs a hash. */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(",")}}`;
}

export interface SceneKeyInputs {
  readonly card: SceneCard;
  readonly bibleVersion: number;
  /** Only the fragments this scene is assigned — not the whole corpus. */
  readonly fragments: readonly Fragment[];
  /** Hash of the preceding scene's prose tail. Prose continuity is a real input. */
  readonly prevTailHash: string;
  /** Hash of the ledger slice this scene will receive. */
  readonly ledgerHash: string;
}

/**
 * The build key for one scene.
 *
 * Note what is deliberately *excluded*: the rest of the manuscript. A change in
 * chapter 40 must not dirty chapter 2, or incremental rebuilds degenerate into
 * full rebuilds. The price of that isolation is that cross-book consistency is
 * enforced by the holistic revision passes instead, which is the right trade —
 * those run over the finished text in a single 1M-token context.
 */
export function sceneKey(inputs: SceneKeyInputs): string {
  const fragmentPayload = [...inputs.fragments]
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .map((f) => ({ id: f.id, text: f.text, updatedAt: f.updatedAt }));

  return sha256Hex(
    stableStringify({
      v: DRAFT_STRATEGY_VERSION,
      bible: inputs.bibleVersion,
      card: {
        goal: inputs.card.goal,
        pov: inputs.card.pov,
        setting: inputs.card.setting,
        present: [...inputs.card.present].sort(),
        entering: inputs.card.enteringState,
        exiting: inputs.card.exitingState,
        target: inputs.card.targetWords,
        motifs: [...inputs.card.motifs].sort(),
        fragmentIds: [...inputs.card.fragmentIds].sort(),
      },
      fragments: fragmentPayload,
      prevTail: inputs.prevTailHash,
      ledger: inputs.ledgerHash,
    }),
  );
}

/**
 * The prose tail handed to the next scene for voice and rhythm continuity.
 *
 * Cut on a paragraph boundary rather than a word count: the next scene is being
 * shown this as an example of how the book moves, and a tail that begins
 * mid-sentence with its paragraphing flattened teaches it the wrong lesson.
 * Hashed rather than embedded in the build key so the key stays a fixed size.
 */
export function tailOf(prose: string, words: number = 120): string {
  const paras = prose.trim().split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
  if (paras.length === 0) return "";

  let count = 0;
  let start = paras.length - 1;
  for (let i = paras.length - 1; i >= 0; i--) {
    count += paras[i]!.split(/\s+/).length;
    start = i;
    if (count >= words) break;
  }
  return paras.slice(start).join("\n\n");
}

export function hashString(s: string): string {
  return sha256Hex(s);
}

/**
 * Which scenes need rebuilding, given the previous build's keys.
 *
 * A scene is dirty if its own key changed, or if a scene before it was rebuilt —
 * because the prev-tail input propagates forward. We cap that propagation at
 * `cascadeLimit` scenes: in practice a rewritten scene perturbs its immediate
 * successor's opening and little beyond, and letting the cascade run to the end
 * of the book would make every edit a full rebuild.
 */
export function dirtyScenes(
  current: ReadonlyMap<string, string>,
  previous: ReadonlyMap<string, string>,
  order: readonly string[],
  cascadeLimit: number = 1,
): Set<string> {
  const dirty = new Set<string>();
  let cascade = 0;

  for (const sceneId of order) {
    const now = current.get(sceneId);
    const before = previous.get(sceneId);

    if (now === undefined || now !== before) {
      dirty.add(sceneId);
      cascade = cascadeLimit;
      continue;
    }
    if (cascade > 0) {
      dirty.add(sceneId);
      cascade--;
    }
  }
  return dirty;
}

/** Fragments added or edited since the last compile — the trigger for an incremental rebuild. */
export function changedSince(
  fragments: readonly Fragment[],
  lastCompileAt: number,
): FragmentId[] {
  return fragments
    .filter((f) => f.updatedAt > lastCompileAt || (f.deletedAt ?? 0) > lastCompileAt)
    .map((f) => f.id);
}
