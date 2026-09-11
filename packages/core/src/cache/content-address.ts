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
}

/**
 * The build key for one scene.
 *
 * It covers exactly the inputs that are **known before drafting and stable
 * across builds**: the Bible version, the scene card, and the text of the
 * fragments the scene is obliged to use. Recompile with an unchanged notebook
 * and every key is identical, so every scene is free.
 *
 * Two things are deliberately *not* in the key, and both were in it until an
 * end-to-end run proved they made incremental rebuilds impossible:
 *
 *   - **The previous scene's prose.** It is empty on a first compile and
 *     populated on the next, so folding it in changes every key on the second
 *     run and rebuilds the whole book. Propagating "the scene before me changed"
 *     is `dirtyScenes`' cascade, which does it without destabilising the key.
 *
 *   - **The continuity ledger slice.** The ledger is extracted *from* the
 *     drafted manuscript one stage later, so a key containing it depends on its
 *     own output — self-referential, and empty-then-populated across runs for
 *     the same reason as above.
 *
 * The rest of the manuscript is excluded too: a change in chapter 40 must not
 * dirty chapter 2, or incremental rebuilds degenerate into full ones. The price
 * of that isolation is that cross-book consistency is enforced by the holistic
 * revision passes instead — the right trade, since those run over the finished
 * text in a single context anyway.
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
 * Which scenes need building, given the keys of scenes already written.
 *
 * Reuse is matched on the **content key, not the scene id**. That distinction is
 * load-bearing: regenerating an outline mints fresh scene ids, so matching by id
 * would mean any outline change rebuilt the entire book — and the outline has to
 * be regenerated whenever new notes arrive, which is the normal case. Matching on
 * content means a scene whose card, Bible version and assigned fragments are
 * unchanged reuses its prose no matter what it is now called.
 *
 * A scene is dirty if its key was never built, or if a scene shortly before it
 * was rebuilt — the cascade, which is how "the scene before me changed"
 * propagates without destabilising keys. It is capped at `cascadeLimit`: in
 * practice a rewritten scene perturbs its immediate successor's opening and
 * little beyond, and an uncapped cascade would make every edit a full rebuild.
 */
export function dirtyScenes(
  ordered: readonly { readonly id: string; readonly key: string }[],
  availableKeys: ReadonlySet<string>,
  cascadeLimit: number = 1,
): Set<string> {
  const dirty = new Set<string>();
  let cascade = 0;

  for (const scene of ordered) {
    if (!availableKeys.has(scene.key)) {
      dirty.add(scene.id);
      cascade = cascadeLimit;
      continue;
    }
    if (cascade > 0) {
      dirty.add(scene.id);
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
