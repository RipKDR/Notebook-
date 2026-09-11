import { z } from "zod";
import type { BatchRequest } from "../llm/batch.js";
import type { BatchLike, LlmLike } from "../llm/interfaces.js";

import type { CostBudget } from "../llm/models.js";
import { renderBible } from "../prompts/render.js";
import type { Bible } from "../types/bible.js";
import type { ContinuityLedger } from "../types/ledger.js";
import { countWords, type DraftedScene, type PassName } from "../types/manuscript.js";
import type { SceneId } from "../types/ids.js";
import { allScenes, type Outline, type SceneCard } from "../types/outline.js";
import { stripPreamble } from "./draft.js";

/**
 * Stage 7 — the holistic passes.
 *
 * This is the half of the design that most AI-writing pipelines get wrong. Having
 * correctly chunked *generation*, they go on to chunk *revision* too, and the
 * result reads like forty competent short stories wearing a trenchcoat.
 *
 * We do not have to. A 100,000-word manuscript is about 135,000 tokens and the
 * window is a million. The entire book fits, seven times over. So the audits that
 * genuinely require seeing everything at once — contradictions, unpaid setups,
 * voice drift — get to see everything at once, in a single call.
 *
 * Generate hierarchically. Audit holistically. The asymmetry is the point.
 */

// ---------------------------------------------------------------------------
// Pass A — transitions
// ---------------------------------------------------------------------------

const TRANSITION_SYSTEM = [
  "You are smoothing the seam between two consecutive scenes in a book.",
  "",
  "The scenes were drafted independently, so the join may be abrupt: a repeated image, a jarring",
  "shift of register, a recap of something the reader just read, or an opening that re-establishes",
  "a setting already established.",
  "",
  "Rewrite ONLY the opening paragraphs of the SECOND scene so it follows naturally from the first.",
  "",
  "- Change as little as possible. If the join already works, return the second scene's opening",
  "  unchanged. Restraint is the correct default here.",
  "- Never add new events, dialogue or facts. You are adjusting a join, not writing.",
  "- Preserve the voice exactly.",
  "- Return only the replacement opening paragraphs. No commentary.",
].join("\n");

export interface ReviseContext {
  readonly bible: Bible;
  readonly outline: Outline;
  readonly ledger: ContinuityLedger;
}

/** How many words at each boundary participate in the smoothing. */
const SEAM_WORDS = 180;

export async function smoothTransitions(
  scenes: readonly DraftedScene[],
  ctx: ReviseContext,
  batch: BatchLike,
  opts: { budget?: CostBudget; onProgress?: (d: number, t: number) => void; signal?: AbortSignal } = {},
): Promise<DraftedScene[]> {
  if (scenes.length < 2) return [...scenes];

  const system = `${TRANSITION_SYSTEM}\n\n---\n\nVOICE\n\n${ctx.bible.voice.description}`;
  const requests: BatchRequest[] = [];

  for (let i = 1; i < scenes.length; i++) {
    const prev = scenes[i - 1]!;
    const current = scenes[i]!;
    requests.push({
      customId: current.sceneId as string,
      system,
      user: [
        "## End of the previous scene",
        lastWords(prev.prose, SEAM_WORDS),
        "",
        "## Opening of the scene to adjust",
        firstWords(current.prose, SEAM_WORDS),
        "",
        "Rewrite the opening so it follows naturally. Return only the replacement text, of roughly",
        "the same length. If it already works, return it unchanged.",
      ].join("\n"),
      maxTokens: 2_000,
      effort: "low",
    });
  }

  const results = await batch.run(requests, {
    stage: "revise:transitions",
    role: "writer",
    ...(opts.budget ? { budget: opts.budget } : {}),
    ...(opts.onProgress
      ? { onProgress: (p) => opts.onProgress?.(p.succeeded, requests.length) }
      : {}),
    ...(opts.signal ? { signal: opts.signal } : {}),
  });

  return scenes.map((scene, i) => {
    if (i === 0) return scene;
    const result = results.get(scene.sceneId as string);
    if (result === undefined || !result.ok) return scene;
    const replaced = replaceOpening(scene.prose, stripPreamble(result.text), SEAM_WORDS);
    return withPass(scene, replaced, "transitions", result.costUsd);
  });
}

// ---------------------------------------------------------------------------
// Pass B — continuity audit, whole manuscript, one context
// ---------------------------------------------------------------------------

const continuityIssueSchema = z.object({
  sceneIndex: z
    .number()
    .int()
    .describe("1-based index of the scene that should be corrected — usually the later one."),
  severity: z.enum(["breaking", "noticeable", "minor"]),
  description: z.string().describe("What contradicts what, naming both places concretely."),
  fix: z.string().describe("The specific, minimal change that resolves it."),
});

const continuityAuditSchema = z.object({
  issues: z.array(continuityIssueSchema),
  assessment: z.string().describe("Two or three sentences on the manuscript's overall coherence."),
});

export type ContinuityIssue = z.infer<typeof continuityIssueSchema>;

const AUDIT_SYSTEM = [
  "You are auditing a complete book manuscript for continuity errors.",
  "",
  "You have the entire text. The scenes were drafted semi-independently, so contradictions are",
  "expected — your job is to find them all.",
  "",
  "Look for:",
  "  - Facts that contradict each other across scenes: names, ages, dates, appearances, locations.",
  "  - Knowledge errors, the most common failure: a character acting on something they were never",
  "    told, or being surprised by something they already learned.",
  "  - Timeline impossibilities — journeys, seasons, ages, elapsed time.",
  "  - Physical continuity: an injury that heals unremarked, an object in two places, a character",
  "    present in a scene they could not have reached.",
  "  - The dead appearing without explanation.",
  "  - Setups that are never paid off, and payoffs with no setup.",
  "",
  "For each issue, name the scene to correct (usually the later one), state exactly what",
  "contradicts what, and give the minimal fix.",
  "",
  "Be rigorous and be specific. 'The pacing sags in the middle' is not a continuity issue and does",
  "not belong here. Report only genuine contradictions of fact — and report every one you find,",
  "however small.",
].join("\n");

export async function auditContinuity(
  scenes: readonly DraftedScene[],
  ctx: ReviseContext,
  llm: LlmLike,
): Promise<{ issues: ContinuityIssue[]; assessment: string }> {
  const cards = allScenes(ctx.outline);
  const cardById = new Map(cards.map((c) => [c.id as string, c]));

  const manuscript = scenes
    .map((s, i) => {
      const card = cardById.get(s.sceneId as string);
      const heading = `### Scene ${i + 1}${card ? ` — ${card.goal}` : ""}`;
      return `${heading}\n\n${s.prose}`;
    })
    .join("\n\n");

  const { value } = await llm.structured(
    {
      stage: "revise:audit",
      role: "architect",
      system: `${AUDIT_SYSTEM}\n\n---\n\nSTORY BIBLE\n\n${renderBible(ctx.bible, { enforceBudget: false })}`,
      user: [
        "## Established facts, as recorded during drafting",
        ctx.ledger.deltas.map((d) => `- [${d.kind}] ${d.statement}`).join("\n") || "(none)",
        "",
        "## The complete manuscript",
        "",
        manuscript,
      ].join("\n"),
      maxTokens: 32_000,
      effort: "max",
    },
    continuityAuditSchema,
  );

  return { issues: value.issues, assessment: value.assessment };
}

const FIX_SYSTEM = [
  "You are applying a single, specific continuity correction to one scene of a book.",
  "",
  "- Make the minimal change that resolves the issue. Do not improve anything else.",
  "- Preserve length, voice, structure and every event.",
  "- Return the complete corrected scene. No commentary.",
].join("\n");

export async function applyContinuityFixes(
  scenes: readonly DraftedScene[],
  issues: readonly ContinuityIssue[],
  ctx: ReviseContext,
  batch: BatchLike,
  opts: { budget?: CostBudget; signal?: AbortSignal; minSeverity?: "breaking" | "noticeable" | "minor" } = {},
): Promise<DraftedScene[]> {
  const rank = { breaking: 3, noticeable: 2, minor: 1 } as const;
  const floor = rank[opts.minSeverity ?? "minor"];

  // Several issues can land on one scene; fix them together in a single rewrite
  // rather than serialising rewrites of the same prose.
  const bySceneIndex = new Map<number, ContinuityIssue[]>();
  for (const issue of issues) {
    if (rank[issue.severity] < floor) continue;
    const i = issue.sceneIndex - 1;
    if (i < 0 || i >= scenes.length) continue;
    bySceneIndex.set(i, [...(bySceneIndex.get(i) ?? []), issue]);
  }
  if (bySceneIndex.size === 0) return [...scenes];

  const system = `${FIX_SYSTEM}\n\n---\n\nVOICE\n\n${ctx.bible.voice.description}`;
  const requests: BatchRequest[] = [...bySceneIndex.entries()].map(([i, sceneIssues]) => {
    const scene = scenes[i]!;
    return {
      customId: scene.sceneId as string,
      system,
      user: [
        "## Corrections to apply",
        ...sceneIssues.map((x) => `- ${x.description}\n  FIX: ${x.fix}`),
        "",
        "## The scene",
        "",
        scene.prose,
        "",
        "Return the complete corrected scene.",
      ].join("\n"),
      maxTokens: Math.max(4_000, Math.ceil(scene.wordCount * 2.5)),
      effort: "medium",
    };
  });

  const results = await batch.run(requests, {
    stage: "revise:fix",
    role: "writer",
    ...(opts.budget ? { budget: opts.budget } : {}),
    ...(opts.signal ? { signal: opts.signal } : {}),
  });

  return scenes.map((scene) => {
    const result = results.get(scene.sceneId as string);
    if (result === undefined || !result.ok) return scene;
    return withPass(scene, stripPreamble(result.text), "continuity", result.costUsd);
  });
}

// ---------------------------------------------------------------------------
// Pass C — voice unification
// ---------------------------------------------------------------------------

const VOICE_SYSTEM = [
  "You are performing a line edit on one scene, to bring it into the author's own voice.",
  "",
  "The scene was drafted from the author's notes but drifts towards generic literary prose. Your",
  "job is to pull it back. The exemplars below are sentences the author actually wrote. They are",
  "the target.",
  "",
  "- Match their rhythm, sentence length, diction and level of abstraction.",
  "- Cut ornament the author would not have written. If they write plainly, write plainly; do not",
  "  'elevate' them.",
  "- Change no events, no dialogue content, no facts. This is a line edit, not a rewrite.",
  "- Preserve length within about 10%.",
  "- Strike the tells of machine-written prose wherever you find them: tricolons used for rhythm",
  "  alone, 'a testament to', 'in that moment', paragraphs that end by restating their own point,",
  "  and sentences that summarise the emotional content of the scene the reader just read.",
  "- Return the complete edited scene. No commentary.",
].join("\n");

export async function unifyVoice(
  scenes: readonly DraftedScene[],
  ctx: ReviseContext,
  batch: BatchLike,
  opts: { budget?: CostBudget; onProgress?: (d: number, t: number) => void; signal?: AbortSignal } = {},
): Promise<DraftedScene[]> {
  const voice = ctx.bible.voice;
  const system = [
    VOICE_SYSTEM,
    "",
    "---",
    "",
    "THE AUTHOR'S VOICE",
    voice.description,
    `Person: ${voice.person}. Tense: ${voice.tense}.`,
    "",
    "THE AUTHOR'S OWN SENTENCES — this is the target:",
    ...voice.exemplars.map((e) => `  > ${e}`),
    voice.avoid.length > 0 ? `\nNEVER:\n${voice.avoid.map((a) => `  - ${a}`).join("\n")}` : "",
  ].join("\n");

  const requests: BatchRequest[] = scenes.map((scene) => ({
    customId: scene.sceneId as string,
    system,
    user: `## The scene\n\n${scene.prose}\n\nReturn the complete edited scene.`,
    maxTokens: Math.max(4_000, Math.ceil(scene.wordCount * 2.5)),
    effort: "medium",
  }));

  const results = await batch.run(requests, {
    stage: "revise:voice",
    role: "writer",
    ...(opts.budget ? { budget: opts.budget } : {}),
    ...(opts.onProgress
      ? { onProgress: (p) => opts.onProgress?.(p.succeeded, requests.length) }
      : {}),
    ...(opts.signal ? { signal: opts.signal } : {}),
  });

  return scenes.map((scene) => {
    const result = results.get(scene.sceneId as string);
    if (result === undefined || !result.ok) return scene;
    const edited = stripPreamble(result.text);
    // Guard against a "line edit" that silently halves the book.
    const ratio = countWords(edited) / Math.max(1, scene.wordCount);
    if (ratio < 0.6 || ratio > 1.6) return scene;
    return withPass(scene, edited, "voice", result.costUsd);
  });
}

// ---------------------------------------------------------------------------
// Pass D — setup and payoff
// ---------------------------------------------------------------------------

const payoffSchema = z.object({
  unpaidSetups: z.array(
    z.object({
      setup: z.string().describe("What was planted, and roughly where."),
      suggestion: z.string().describe("Where and how it could pay off."),
    }),
  ),
  unpreparedPayoffs: z.array(
    z.object({
      payoff: z.string(),
      suggestion: z.string().describe("Where a setup could be planted earlier."),
    }),
  ),
  assessment: z.string(),
});

export type PayoffReport = z.infer<typeof payoffSchema>;

const PAYOFF_SYSTEM = [
  "You are auditing a book's structure for setups and payoffs.",
  "",
  "You have the outline, the chapter summaries and the ledger of established facts — not the full",
  "prose, which you do not need for this.",
  "",
  "Find:",
  "  - Setups that never pay off. An object, a threat, a promise or a question introduced with",
  "    weight and then dropped.",
  "  - Payoffs with no setup. A resolution that lands unearned because nothing prepared it.",
  "",
  "Report only things a reader would actually notice. Not every mentioned object is a Chekhov's",
  "gun, and flagging ordinary scenery as an unpaid setup makes the whole report worthless.",
].join("\n");

export async function auditPayoffs(
  ctx: ReviseContext,
  llm: LlmLike,
): Promise<PayoffReport> {
  const { value } = await llm.structured(
    {
      stage: "revise:payoff",
      role: "architect",
      system: `${PAYOFF_SYSTEM}\n\n---\n\nSTORY BIBLE\n\n${renderBible(ctx.bible, { enforceBudget: false })}`,
      user: [
        "## Outline",
        ...ctx.outline.chapters.map(
          (c) =>
            `### ${c.index + 1}. ${c.title} (${c.part})\n${c.summary}\n` +
            c.scenes.map((s) => `  - ${s.goal}`).join("\n"),
        ),
        "",
        "## Established facts in reading order",
        ctx.ledger.deltas.map((d) => `- [${d.kind}] ${d.statement}`).join("\n") || "(none)",
      ].join("\n"),
      maxTokens: 16_000,
      effort: "high",
    },
    payoffSchema,
  );
  return value;
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function withPass(
  scene: DraftedScene,
  prose: string,
  pass: PassName,
  costUsd: number,
): DraftedScene {
  return {
    ...scene,
    prose,
    wordCount: countWords(prose),
    passes: [...scene.passes, pass],
    costUsd: scene.costUsd + costUsd,
  };
}

/**
 * Prose excerpting, on paragraph boundaries.
 *
 * The obvious implementation — split on whitespace, take N words, join with
 * spaces — silently destroys every paragraph break. That matters twice over:
 * the model is being shown this text as an example of the book's rhythm, and
 * `replaceOpening` writes the result back into the manuscript. Collapsing a
 * scene's paragraphing into one block would be an invisible, unrecoverable
 * corruption of the finished book.
 *
 * So we cut at paragraph boundaries, overshooting the word count rather than
 * splitting a paragraph in half.
 */

const PARAGRAPH_SPLIT = /\n\s*\n/;

function paragraphs(prose: string): string[] {
  return prose.trim().split(PARAGRAPH_SPLIT).map((p) => p.trim()).filter(Boolean);
}

function wordsIn(s: string): number {
  const t = s.trim();
  return t.length === 0 ? 0 : t.split(/\s+/).length;
}

/** How many leading paragraphs it takes to reach roughly `n` words. At least one. */
function leadingParagraphCount(paras: readonly string[], n: number): number {
  let words = 0;
  for (let i = 0; i < paras.length; i++) {
    words += wordsIn(paras[i]!);
    if (words >= n) return i + 1;
  }
  return paras.length;
}

export function firstWords(prose: string, n: number): string {
  const paras = paragraphs(prose);
  if (paras.length === 0) return "";
  return paras.slice(0, leadingParagraphCount(paras, n)).join("\n\n");
}

export function lastWords(prose: string, n: number): string {
  const paras = paragraphs(prose);
  if (paras.length === 0) return "";
  let words = 0;
  let start = paras.length;
  for (let i = paras.length - 1; i >= 0; i--) {
    words += wordsIn(paras[i]!);
    start = i;
    if (words >= n) break;
  }
  return paras.slice(start).join("\n\n");
}

/**
 * Swaps the opening paragraphs of `prose` for `replacement`, keeping the rest
 * intact. The boundary is the same one `firstWords` used to build the prompt, so
 * the model's replacement lines up with exactly what it was shown.
 */
export function replaceOpening(prose: string, replacement: string, n: number): string {
  const paras = paragraphs(prose);
  const clean = replacement.trim();
  if (paras.length === 0) return clean;
  if (clean.length === 0) return prose.trim();

  const remainder = paras.slice(leadingParagraphCount(paras, n));
  return remainder.length === 0 ? clean : [clean, ...remainder].join("\n\n");
}

/** Scene cards in reading order, for callers that need to pair scenes with their plans. */
export function orderedCards(outline: Outline): SceneCard[] {
  return allScenes(outline);
}

export type { SceneId };
