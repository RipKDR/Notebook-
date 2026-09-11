import { getForm } from "../forms/registry.js";
import type { BatchRequest } from "../llm/batch.js";
import type { BatchLike, LlmLike } from "../llm/interfaces.js";

import type { CostBudget } from "../llm/models.js";
import { renderBible, renderFragments, renderLedger, renderSceneCard } from "../prompts/render.js";
import { sceneKey, tailOf } from "../cache/content-address.js";
import type { Bible } from "../types/bible.js";
import type { Fragment } from "../types/fragment.js";
import type { ContinuityLedger } from "../types/ledger.js";
import { sliceForScene } from "../types/ledger.js";
import { countWords, type DraftedScene } from "../types/manuscript.js";
import type { FragmentId, SceneId } from "../types/ids.js";
import { allScenes, type Outline, type SceneCard } from "../types/outline.js";

/**
 * Stage 5 — scene drafting.
 *
 * This is where the book is actually written, and where the hierarchical design
 * pays off. Each call is bounded and verifiable: produce ~1,250 words that carry
 * the story from state A to state B and incorporate these six fragments. That is
 * a job a model does well. "Write a hundred thousand words" is not.
 *
 * The prompt is split precisely along the caching boundary. The system block —
 * instructions, the Bible, the form's scene guidance — is byte-identical across
 * every scene in the compile, so it is written to cache once and read back ~80
 * times at a tenth of the price. Everything that varies per scene goes in the
 * user block. Getting this split wrong does not break anything; it just silently
 * multiplies the bill, which is the worst kind of bug.
 */

const DRAFT_SYSTEM = [
  "You are writing one scene of a full-length book.",
  "",
  "The author captured the raw material as loose notes over months. Your job is to turn the",
  "assigned fragments into finished prose that belongs in this book — not to summarise them, not to",
  "comment on them, and not to write around them.",
  "",
  "Rules:",
  "",
  "- USE EVERY ASSIGNED FRAGMENT. Each one must be visible in the scene: as rendered action, as",
  "  dialogue, as image, as the narrator's thought. Where a fragment is already a finished sentence",
  "  in the author's voice, prefer using it close to verbatim. This is the author's book; the",
  "  fragments are the parts of it that already exist.",
  "- MATCH THE VOICE. The voice exemplars in the Bible are the author's own sentences. The finished",
  "  book has to sound like the person who wrote them. This outranks every instinct you have about",
  "  what good prose looks like.",
  "- HIT THE TARGET LENGTH, within about 15%. A scene that runs short leaves the book short.",
  "- OPEN AND CLOSE ON THE SPECIFIED STATES. The scenes on either side depend on it.",
  "- DO NOT RESOLVE WHAT IS NOT YOURS TO RESOLVE. This is one scene in the middle of a book. Leave",
  "  the threads that belong to later scenes open.",
  "- PROSE ONLY. No headings, no scene numbers, no commentary, no notes to the author. Output the",
  "  text of the scene and nothing else.",
  "- NEVER write a closing line that signals summation ('And that was the day everything changed').",
  "  It reads as a machine wrapping up and it is the single clearest tell.",
].join("\n");

export interface DraftContext {
  readonly bible: Bible;
  readonly outline: Outline;
  readonly fragments: ReadonlyMap<FragmentId, Fragment>;
  readonly ledger: ContinuityLedger;
  /** Prose tails from already-drafted scenes, keyed by scene id. */
  readonly tails: ReadonlyMap<SceneId, string>;
}

/** The cached prefix. Byte-identical for every scene in a compile — keep it that way. */
export function draftSystemPrompt(bible: Bible): string {
  const form = getForm(bible.formBible.form);
  return [
    DRAFT_SYSTEM,
    "",
    "---",
    "",
    form.sceneGuidance(),
    "",
    "---",
    "",
    "STORY BIBLE",
    "",
    renderBible(bible, { enforceBudget: false }),
  ].join("\n");
}

/** The volatile per-scene half of the prompt. */
export function draftUserPrompt(card: SceneCard, ctx: DraftContext): string {
  const scenes = allScenes(ctx.outline);
  const order = scenes.findIndex((s) => s.id === card.id);
  const previous = order > 0 ? scenes[order - 1] : undefined;
  const upcoming = order >= 0 && order < scenes.length - 1 ? scenes[order + 1] : undefined;

  const assigned = card.fragmentIds
    .map((id) => ctx.fragments.get(id))
    .filter((f): f is Fragment => f !== undefined);

  const ledgerSlice = sliceForScene(ctx.ledger, card.present, order < 0 ? 0 : order);
  const tail = previous !== undefined ? ctx.tails.get(previous.id) : undefined;

  return [
    "## Scene specification",
    renderSceneCard(card, ctx.bible),
    "",
    "## Established so far",
    "Facts already true in this book. Contradicting any of them is an error.",
    renderLedger(ledgerSlice),
    "",
    tail !== undefined && tail.length > 0
      ? [
          "## The end of the previous scene",
          "Continue from this in rhythm and register. Do not repeat or recap it.",
          "",
          tail,
          "",
        ].join("\n")
      : "## This is the opening scene of the book.\n",
    upcoming !== undefined
      ? `## What follows\nThe next scene begins: ${upcoming.enteringState}\nLeave room for it; do not pre-empt it.\n`
      : "## This is the final scene of the book.\n",
    "## The author's fragments — use every one",
    renderFragments(assigned),
    "",
    `Write the scene now. Approximately ${card.targetWords} words. Prose only.`,
  ]
    .filter(Boolean)
    .join("\n");
}

export interface DraftOptions {
  readonly context: DraftContext;
  /** Scene ids to draft. Omit to draft everything in the outline. */
  readonly only?: ReadonlySet<SceneId>;
  readonly batch: BatchLike;
  readonly budget?: CostBudget;
  readonly onProgress?: (done: number, total: number) => void;
  readonly signal?: AbortSignal;
}

/**
 * Drafts scenes through the Batch API at half price.
 *
 * Batching is right for a full compile — the user taps "write my book", closes
 * the app, and gets a notification — and wrong for a single-scene preview, which
 * has to feel immediate. `draftSceneNow` below is the synchronous path, using the
 * same prompts.
 */
export async function draftScenes(opts: DraftOptions): Promise<DraftedScene[]> {
  const { context } = opts;
  const cards = allScenes(context.outline).filter(
    (c) => opts.only === undefined || opts.only.has(c.id),
  );
  if (cards.length === 0) return [];

  const system = draftSystemPrompt(context.bible);
  const requests: BatchRequest[] = cards.map((card) => ({
    customId: card.id as string,
    system,
    user: draftUserPrompt(card, context),
    // Generous headroom: a 2,500-word scene is ~3,400 tokens, and truncation
    // mid-sentence costs a full retry.
    maxTokens: Math.max(4_000, Math.ceil(card.targetWords * 2.5)),
    effort: "high",
  }));

  const results = await opts.batch.run(requests, {
    stage: "draft",
    role: "writer",
    ...(opts.budget ? { budget: opts.budget } : {}),
    ...(opts.onProgress
      ? {
          onProgress: (p) =>
            opts.onProgress?.(p.succeeded + p.errored + p.canceled + p.expired, cards.length),
        }
      : {}),
    ...(opts.signal ? { signal: opts.signal } : {}),
  });

  const drafted: DraftedScene[] = [];
  const failures: string[] = [];

  for (const card of cards) {
    const result = results.get(card.id as string);
    if (result === undefined || !result.ok) {
      failures.push(`${card.id}: ${result?.ok === false ? result.detail : "no result returned"}`);
      continue;
    }
    drafted.push(finaliseScene(card, result.text, context, result.costUsd, "claude-sonnet-5"));
  }

  if (failures.length > 0 && drafted.length === 0) {
    throw new Error(`Every scene failed to draft:\n${failures.join("\n")}`);
  }
  return drafted;
}

/**
 * Records each drafted scene's closing paragraphs against its id.
 *
 * Batched drafting is parallel by construction, so a scene cannot be shown the
 * prose of the scene before it — that one is being written at the same moment.
 * Seam repair is the transitions pass's job, and it runs over the finished text
 * precisely because drafting cannot do it.
 *
 * What tails *are* good for is the next compile: on an incremental rebuild the
 * neighbours are already written, so a rebuilt scene genuinely can continue from
 * the prose before it. Populating this after a draft is what makes that work.
 */
export function collectTails(
  scenes: readonly DraftedScene[],
  into: Map<SceneId, string> = new Map(),
): Map<SceneId, string> {
  for (const scene of scenes) into.set(scene.sceneId, tailOf(scene.prose));
  return into;
}

/** The synchronous path, for previews. Same prompts, full price, immediate. */
export async function draftSceneNow(
  card: SceneCard,
  context: DraftContext,
  llm: LlmLike,
): Promise<DraftedScene> {
  const { text } = await llm.prose({
    stage: "draft:preview",
    role: "writer",
    system: draftSystemPrompt(context.bible),
    user: draftUserPrompt(card, context),
    maxTokens: Math.max(4_000, Math.ceil(card.targetWords * 2.5)),
    effort: "high",
  });
  return finaliseScene(card, text, context, 0, "claude-sonnet-5");
}

function finaliseScene(
  card: SceneCard,
  rawText: string,
  ctx: DraftContext,
  costUsd: number,
  model: string,
): DraftedScene {
  const prose = stripPreamble(rawText);
  const assigned = card.fragmentIds
    .map((id) => ctx.fragments.get(id))
    .filter((f): f is Fragment => f !== undefined);

  return {
    sceneId: card.id,
    chapterId: card.chapterId,
    prose,
    wordCount: countWords(prose),
    contentHash: sceneKey({
      card,
      bibleVersion: ctx.bible.version,
      fragments: assigned,
    }),
    passes: ["draft"],
    usedFragments: detectUsedFragments(prose, assigned),
    model,
    costUsd,
    draftedAt: Date.now(),
  };
}

/**
 * Strips the scaffolding models sometimes emit despite being told not to.
 *
 * Cheap and worth it: a stray "Here is the scene:" survives into the finished
 * book and is exactly the kind of tell that makes a reader stop trusting it.
 */
export function stripPreamble(text: string): string {
  let out = text.trim();
  out = out.replace(/^(?:here(?:'s| is)[^\n]{0,80}:|scene\s*\d*\s*:?)\s*\n+/i, "");
  out = out.replace(/^#{1,6}\s+[^\n]+\n+/, "");
  out = out.replace(/^\s*(?:---|\*\*\*)\s*\n+/, "");
  out = out.replace(/\n+\s*(?:---|\*\*\*)\s*$/, "");
  return out.trim();
}

/**
 * Which assigned fragments visibly made it into the prose.
 *
 * A deliberately conservative signal: it looks for runs of distinctive words
 * rather than trying to judge paraphrase. It under-reports, and that is the right
 * direction — this drives a "some of your notes didn't make it" warning, and a
 * false alarm is cheaper than a false reassurance.
 *
 * Both sides are tokenised and filtered identically. Filtering only the needle
 * would mean its n-grams could never align with the prose: dropping "my" from
 * "said my name" yields "said name", which does not occur in a text that
 * faithfully contains the original line.
 */
const MIN_RUN = 4;

export function detectUsedFragments(
  prose: string,
  assigned: readonly Fragment[],
): FragmentId[] {
  const haystack = distinctiveTokens(prose);
  if (haystack.length === 0) return [];
  const haystackJoined = ` ${haystack.join(" ")} `;
  const haystackSet = new Set(haystack);

  return assigned
    .filter((f) => {
      const needle = distinctiveTokens(f.text);
      if (needle.length === 0) return false;

      if (needle.length >= MIN_RUN) {
        for (let i = 0; i + MIN_RUN <= needle.length; i++) {
          if (haystackJoined.includes(` ${needle.slice(i, i + MIN_RUN).join(" ")} `)) return true;
        }
        return false;
      }
      // Fragments too short to form a run: require every distinctive token.
      return needle.every((w) => haystackSet.has(w));
    })
    .map((f) => f.id);
}

/**
 * Lowercased content words, with quotes and punctuation normalised away.
 * Words of three characters or fewer are dropped: they are mostly function words
 * and they make spurious matches far too easy.
 */
function distinctiveTokens(s: string): string[] {
  return s
    .toLowerCase()
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201C\u201D]/g, '"')
    .replace(/[^a-z0-9' ]+/g, " ")
    .split(/\s+/)
    .map((w) => w.replace(/^'+|'+$/g, ""))
    .filter((w) => w.length > 3);
}

export { tailOf };
