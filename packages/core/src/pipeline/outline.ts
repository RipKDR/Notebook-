import { z } from "zod";
import { getForm } from "../forms/registry.js";
import type { Llm } from "../llm/client.js";
import { renderBible } from "../prompts/render.js";
import type { Bible } from "../types/bible.js";
import type { Fragment } from "../types/fragment.js";
import {
  asChapterId,
  asEntityId,
  asFragmentId,
  asOutlineId,
  asSceneId,
  newId,
  type FragmentId,
  type ProjectId,
} from "../types/ids.js";
import type { ChapterCard, Outline, SceneCard } from "../types/outline.js";
import { assignedFragments } from "../types/outline.js";

/**
 * Stage 4 — the outline, which is a *consumption plan* rather than a summary.
 *
 * Every scene card names the exact fragments it is obligated to use. That single
 * constraint is what separates this from a tool that writes a book "inspired by"
 * your notes: the plan is accountable for the material, and at the end we can
 * report precisely which fragments made it in and which did not.
 *
 * It runs in two passes, for the same reason the whole system is hierarchical:
 *
 *   Pass 1 allocates the corpus across chapters. One call, whole-corpus view,
 *          most capable model. Structure is decided here.
 *   Pass 2 expands each chapter into scene cards, seeing only that chapter's
 *          allocation. Independent per chapter, so it batches.
 *
 * Asking for a hundred fully-specified scene cards in one call would mean ~25k
 * tokens of structured output, which is where both schema adherence and
 * attention quality start to visibly degrade.
 */

const chapterPlanSchema = z.object({
  chapters: z.array(
    z.object({
      title: z.string(),
      summary: z.string().describe("Two or three sentences on what this chapter accomplishes."),
      part: z.string().describe("Which structural part this belongs to. Use the given names exactly."),
      targetWords: z.number().int().positive(),
      fragmentIds: z
        .array(z.string())
        .describe(
          "Fragment ids allocated to this chapter. Every fragment worth using must appear in " +
            "exactly one chapter.",
        ),
    }),
  ),
  unusedFragments: z.array(
    z.object({
      fragmentId: z.string(),
      reason: z.string().describe("Why this fragment has no place in the book as planned."),
    }),
  ),
});

const sceneExpansionSchema = z.object({
  scenes: z.array(
    z.object({
      goal: z.string().describe("What happens, imperative, one or two sentences."),
      pov: z.string().nullable().describe("Entity id of the viewpoint character, or null."),
      setting: z.string(),
      present: z.array(z.string()).describe("Entity ids present in the scene."),
      enteringState: z.string().describe("How things stand as the scene opens."),
      exitingState: z.string().describe("What must be true when it closes."),
      fragmentIds: z.array(z.string()).describe("Fragments this scene must incorporate."),
      targetWords: z.number().int().positive(),
      valence: z.number().min(-1).max(1),
      motifs: z.array(z.string()),
    }),
  ),
});

const PLAN_SYSTEM = [
  "You are planning the chapter structure of a full-length book from a writer's notebook.",
  "",
  "You are given the Story Bible and every fragment in digest form. Allocate the material across",
  "chapters so that the book has a shape and every fragment worth keeping has a home.",
  "",
  "Rules:",
  "",
  "- ALLOCATE, DO NOT SUMMARISE. Each chapter lists the fragment ids it will consume. A fragment",
  "  belongs to exactly one chapter. This allocation is a contract: the next stage may only work",
  "  with what you give it.",
  "- HIT THE TARGET LENGTH. The per-chapter word targets must sum to approximately the requested",
  "  total. This is a full-length book, not a sketch of one — plan enough chapters to carry it.",
  "- RESPECT THE STRUCTURAL PARTS given below, including their proportions of the whole.",
  "- BE HONEST ABOUT LEFTOVERS. A fragment that genuinely does not fit goes in unusedFragments with",
  "  a real reason. Do not force material in, and do not silently drop it — the author will be",
  "  shown this list and needs it to be truthful.",
  "- DENSITY VARIES. A chapter carrying twenty rich fragments needs more words than one carrying",
  "  four. Let the material set the length rather than dividing evenly.",
].join("\n");

const EXPAND_SYSTEM = [
  "You are breaking one chapter of a planned book into scene cards.",
  "",
  "A scene card is a specification a writer can execute without further context: what happens, who",
  "is there, how things stand when it opens and what must be true when it closes, and exactly which",
  "of the author's own fragments it has to incorporate.",
  "",
  "Rules:",
  "",
  "- USE EVERY FRAGMENT ALLOCATED TO THIS CHAPTER. Distribute them across the scenes. Each belongs",
  "  to exactly one scene. This is the point of the entire system: the author's actual writing must",
  "  end up in the book.",
  "- SCENES RUN 800 TO 2,000 WORDS. Below that a scene cannot breathe; above it, a single drafting",
  "  call loses the thread. The per-scene targets must sum to the chapter's target.",
  "- STATES MUST CHAIN. Each scene's exiting state has to make the next scene's entering state true.",
  "  A break in that chain becomes a continuity error in the finished book.",
  "- VARY THE VALENCE. Consecutive scenes at the same emotional pitch read as flat regardless of how",
  "  good the prose is.",
  "- ENTITY IDS ONLY, exactly as given in the Bible. Never invent one.",
].join("\n");

export interface BuildOutlineOptions {
  readonly llm: Llm;
  readonly projectId: ProjectId;
  readonly bible: Bible;
  readonly fragments: readonly Fragment[];
  readonly targetWords: number;
  readonly previous?: Outline | null;
  readonly onProgress?: (done: number, total: number) => void;
  readonly signal?: AbortSignal;
}

export async function buildOutline(opts: BuildOutlineOptions): Promise<Outline> {
  const form = getForm(opts.bible.formBible.form);
  const bibleText = renderBible(opts.bible, { enforceBudget: false });
  const byId = new Map(opts.fragments.map((f) => [f.id as string, f]));

  const usable = opts.fragments.filter(
    (f) => f.deletedAt === null && f.text.trim().length > 0,
  );

  // --- Pass 1: chapter allocation ---
  const planUser = [
    `TARGET LENGTH: ${opts.targetWords.toLocaleString()} words.`,
    "",
    "STRUCTURAL PARTS:",
    ...form.parts().map(
      (p) =>
        `  ${p.name} — ${Math.round(p.proportion * 100)}% (~${Math.round(
          opts.targetWords * p.proportion,
        ).toLocaleString()} words)\n      ${p.purpose}`,
    ),
    "",
    `FRAGMENTS (${usable.length}):`,
    usable
      .map((f) => {
        const e = f.enrichment;
        return e === null
          ? `- ${f.id} [unclassified] ${f.text.slice(0, 90).trim()}`
          : `- ${f.id} [${e.kind}, standalone ${e.standalone.toFixed(1)}] ${e.digest}`;
      })
      .join("\n"),
  ].join("\n");

  const { value: plan } = await opts.llm.structured(
    {
      stage: "outline:plan",
      role: "architect",
      system: `${PLAN_SYSTEM}\n\n---\n\n${form.outlineGuidance()}\n\n---\n\nSTORY BIBLE\n\n${bibleText}`,
      user: planUser,
      maxTokens: 32_000,
      effort: "max",
    },
    chapterPlanSchema,
  );

  // --- Pass 2: expand each chapter into scenes ---
  const chapters: ChapterCard[] = [];
  const total = plan.chapters.length;

  for (let i = 0; i < plan.chapters.length; i++) {
    if (opts.signal?.aborted === true) break;
    const planned = plan.chapters[i]!;
    const chapterId = asChapterId(newId());

    const chapterFragments = planned.fragmentIds
      .map((id) => byId.get(id))
      .filter((f): f is Fragment => f !== undefined);

    const expandUser = [
      `CHAPTER ${i + 1} OF ${total}: ${planned.title}`,
      `PART: ${planned.part}`,
      `SUMMARY: ${planned.summary}`,
      `TARGET: ${planned.targetWords.toLocaleString()} words`,
      "",
      i > 0 ? `PRECEDED BY: ${plan.chapters[i - 1]!.summary}` : "This is the opening chapter.",
      i < total - 1
        ? `FOLLOWED BY: ${plan.chapters[i + 1]!.summary}`
        : "This is the final chapter.",
      "",
      `FRAGMENTS ALLOCATED TO THIS CHAPTER (${chapterFragments.length}) — all must be used:`,
      "",
      chapterFragments.length > 0
        ? chapterFragments
            .map((f) => `[${f.id}] (${f.enrichment?.kind ?? "fragmentary"})\n${f.text.trim()}`)
            .join("\n\n")
        : "(none — build this chapter from the Bible and the surrounding chapters)",
    ].join("\n");

    const { value: expansion } = await opts.llm.structured(
      {
        stage: "outline:expand",
        role: "architect",
        system: `${EXPAND_SYSTEM}\n\n---\n\n${form.outlineGuidance()}\n\n---\n\nSTORY BIBLE\n\n${bibleText}`,
        user: expandUser,
        maxTokens: 16_000,
        effort: "high",
      },
      sceneExpansionSchema,
    );

    const scenes: SceneCard[] = expansion.scenes.map((s, idx) => ({
      id: asSceneId(newId()),
      chapterId,
      index: idx,
      goal: s.goal,
      pov: s.pov === null || s.pov === "" ? null : asEntityId(s.pov),
      setting: s.setting,
      present: s.present.filter(Boolean).map(asEntityId),
      enteringState: s.enteringState,
      exitingState: s.exitingState,
      fragmentIds: s.fragmentIds.filter((id) => byId.has(id)).map(asFragmentId),
      targetWords: clampSceneLength(s.targetWords),
      valence: Math.max(-1, Math.min(1, s.valence)),
      motifs: s.motifs,
    }));

    chapters.push({
      id: chapterId,
      index: i,
      title: planned.title,
      summary: planned.summary,
      part: planned.part,
      scenes,
    });

    opts.onProgress?.(i + 1, total);
  }

  const outline: Outline = {
    id: asOutlineId(newId()),
    projectId: opts.projectId,
    version: (opts.previous?.version ?? 0) + 1,
    bibleVersion: opts.bible.version,
    chapters,
    targetWords: opts.targetWords,
    unusedFragments: reconcileUnused(usable, chapters, plan.unusedFragments),
    createdAt: Date.now(),
  };

  return outline;
}

/**
 * Scenes shorter than ~600 words cannot establish and turn; longer than ~2,500
 * and a single drafting call starts losing the thread of its own opening.
 */
function clampSceneLength(words: number): number {
  if (!Number.isFinite(words)) return 1200;
  return Math.max(600, Math.min(2500, Math.round(words)));
}

/**
 * Reconciles what the model *said* it left out against what it actually left out.
 *
 * The planner is asked to declare unused fragments, but fragments also fall
 * through the cracks between passes — allocated to a chapter and then not picked
 * up by any scene. Those are the dangerous ones, because nobody reports them. We
 * recompute the truth from the finished outline so the author is shown a list
 * that is actually accurate.
 */
export function reconcileUnused(
  fragments: readonly Fragment[],
  chapters: readonly ChapterCard[],
  declared: readonly { fragmentId: string; reason: string }[],
): { fragmentId: FragmentId; reason: string }[] {
  const used = new Set<FragmentId>();
  for (const chapter of chapters) {
    for (const scene of chapter.scenes) {
      for (const id of scene.fragmentIds) used.add(id);
    }
  }
  const declaredById = new Map(declared.map((d) => [d.fragmentId, d.reason]));

  return fragments
    .filter((f) => !used.has(f.id))
    .map((f) => ({
      fragmentId: f.id,
      reason:
        declaredById.get(f.id as string) ??
        "Allocated to a chapter but not picked up by any scene.",
    }));
}

/** Share of the corpus that made it into the book. The honest headline metric for a compile. */
export function coverage(fragments: readonly Fragment[], outline: Outline): number {
  const usable = fragments.filter((f) => f.deletedAt === null && f.text.trim().length > 0);
  if (usable.length === 0) return 1;
  const used = assignedFragments(outline);
  return usable.filter((f) => used.has(f.id)).length / usable.length;
}
