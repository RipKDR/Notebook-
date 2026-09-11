import { z } from "zod";
import { getForm } from "../forms/registry.js";
import type { LlmLike } from "../llm/interfaces.js";
import { renderBible } from "../prompts/render.js";
import type { Bible, BibleEntity, FormBible, VoiceGuide } from "../types/bible.js";
import { estimateTokens, type Fragment } from "../types/fragment.js";
import { asBibleId, asEntityId, newId, type FragmentId, type ProjectId } from "../types/ids.js";
import type { WorkForm } from "../types/bible.js";

/**
 * Stage 3 — the Story Bible.
 *
 * This is the highest-leverage call in the system. It runs once, and every one of
 * the ~80 scene calls that follow inherits its judgement. A weak premise or a
 * mushy voice guide here cannot be repaired downstream by better prose, which is
 * why this stage routes to the most capable model at maximum effort while the
 * per-scene work routes to a cheaper one. Spending the most on the fewest calls
 * is the whole of the cost strategy.
 *
 * The input is the *whole* corpus in digest form — a thousand fragments compress
 * to roughly 25 tokens each — plus verbatim text for the fragments that carry the
 * most voice. The model needs breadth to find the shape and verbatim samples to
 * hear the author.
 */

const voiceSchema = z.object({
  description: z
    .string()
    .describe("The register, rhythm, diction and characteristic moves of this author's prose."),
  exemplars: z
    .array(z.string())
    .min(3)
    .max(12)
    .describe(
      "Sentences copied EXACTLY AND VERBATIM from the fragments. Do not improve, shorten or " +
        "correct them. These are the ground truth for how the book must sound.",
    ),
  avoid: z
    .array(z.string())
    .describe("Specific moves this voice never makes. Negative constraints, concretely stated."),
  person: z.enum(["first", "second", "third-limited", "third-omniscient"]),
  tense: z.enum(["past", "present"]),
});

const entitySchema = z.object({
  id: z.string().describe("The canonical entity id exactly as it appears in the digests."),
  name: z.string(),
  kind: z.enum(["person", "place", "object", "organisation", "event"]),
  aliases: z.array(z.string()),
  description: z.string().describe("Two to four sentences. Enough to write them consistently."),
  initialState: z.string().describe("What is true about them as the work opens."),
});

const themeSchema = z.object({
  name: z.string(),
  statement: z.string().describe("What the work says about this, as a claim rather than a topic."),
  motifs: z
    .array(z.string())
    .describe("Concrete recurring images, objects or phrases that carry the theme."),
});

function bibleResponseSchema(formSchema: z.ZodType<FormBible>) {
  return z.object({
    title: z.string(),
    logline: z.string().describe("One sentence. The thing you would say at a party."),
    entities: z.array(entitySchema),
    themes: z.array(themeSchema),
    voice: voiceSchema,
    formBible: formSchema,
  });
}

const BASE_SYSTEM = [
  "You are the structural editor for a long-form writing tool.",
  "",
  "A writer has been capturing loose sentences and paragraphs for months without an overall plan.",
  "You are seeing their whole notebook at once — most likely for the first time anyone has. Your",
  "job is to find the book that is already latent in it and write the Bible that will govern its",
  "construction.",
  "",
  "This document will be the sole context for every scene written later. Everything the book needs",
  "to stay consistent must be here, and nothing else may be, because every token is re-read for",
  "every scene.",
  "",
  "Principles:",
  "",
  "- FIND, DO NOT INVENT. The shape is already in the material. If you find yourself adding a",
  "  character or a conflict that no fragment supports, you have stopped reading and started",
  "  writing, and the result will feel alien to the author.",
  "- THE VOICE IS THE PRODUCT. The exemplars you select must be copied verbatim from the",
  "  fragments — exact characters, no tidying. They are the strongest signal we have that the",
  "  finished book sounds like this person rather than like a language model.",
  "- BE SPECIFIC. 'Family' is not a theme. 'That being known is not the same as being forgiven' is.",
  "- ENTITY IDS ARE FIXED. Reuse the ids given in the digests exactly. Downstream stages resolve",
  "  them and an invented id silently breaks continuity tracking.",
  "- BE HONEST ABOUT WEAKNESS. If the material genuinely does not support a full-length book yet,",
  "  build the best Bible you can from what is there — a later stage tells the author what is",
  "  missing. Do not paper over a gap by inventing.",
].join("\n");

export interface BuildBibleOptions {
  readonly llm: LlmLike;
  readonly projectId: ProjectId;
  readonly form: WorkForm;
  readonly fragments: readonly Fragment[];
  /** Previous Bible, when recompiling. Its version is incremented. */
  readonly previous?: Bible | null;
  /** How many high-voice fragments to include verbatim. */
  readonly verbatimSamples?: number;
}

export async function buildBible(opts: BuildBibleOptions): Promise<Bible> {
  const form = getForm(opts.form);
  const usable = opts.fragments.filter(
    (f) => f.deletedAt === null && f.text.trim().length > 0,
  );
  if (usable.length === 0) {
    throw new Error("Cannot build a Bible from zero fragments");
  }

  const system = `${BASE_SYSTEM}\n\n---\n\n${form.bibleGuidance()}`;
  const user = [
    `The notebook contains ${usable.length} fragments.`,
    "",
    "## Entity index",
    renderEntityIndex(usable),
    "",
    "## All fragments, in digest form",
    renderDigests(usable),
    "",
    "## Verbatim samples",
    "These are the author's own words, unedited. Draw the voice exemplars from these or from any",
    "other fragment, but copy exactly.",
    "",
    renderVerbatim(selectVoiceSamples(usable, opts.verbatimSamples ?? 40)),
  ].join("\n");

  const { value } = await opts.llm.structured(
    {
      stage: "bible",
      role: "architect",
      system,
      user,
      maxTokens: 32_000,
      effort: "max",
    },
    bibleResponseSchema(form.bibleSchema),
  );

  const entities: BibleEntity[] = value.entities.map((e) => ({
    id: asEntityId(e.id),
    name: e.name,
    kind: e.kind,
    aliases: e.aliases,
    description: e.description,
    initialState: e.initialState,
    sources: sourcesForEntity(usable, e.id),
  }));

  const voice: VoiceGuide = {
    ...value.voice,
    exemplars: verifyExemplars(value.voice.exemplars, usable),
  };

  const bible: Bible = {
    id: asBibleId(newId()),
    projectId: opts.projectId,
    version: (opts.previous?.version ?? 0) + 1,
    title: value.title,
    logline: value.logline,
    entities,
    themes: value.themes.map((t) => ({
      ...t,
      sources: sourcesForTheme(usable, t.name),
    })),
    voice,
    formBible: value.formBible,
    sources: usable.map((f) => f.id),
    createdAt: Date.now(),
    renderedTokens: 0,
  };

  // Render once to measure and to fail fast if we blew the prefix budget.
  const rendered = renderBible(bible, { enforceBudget: false });
  const tokens = estimateTokens(rendered);
  return { ...bible, renderedTokens: tokens };
}

/**
 * Exemplars must be verbatim. The model is asked for exact copies, but a
 * paraphrase here would quietly teach every scene call the wrong voice, so we
 * verify rather than trust: anything not found in the corpus is dropped, and if
 * that empties the list we substitute real sentences chosen mechanically.
 */
export function verifyExemplars(
  candidates: readonly string[],
  fragments: readonly Fragment[],
): string[] {
  const haystack = fragments.map((f) => normaliseForMatch(f.text));
  const verified = candidates.filter((c) => {
    const needle = normaliseForMatch(c);
    return needle.length > 0 && haystack.some((h) => h.includes(needle));
  });
  if (verified.length >= 3) return verified;

  const fallback = selectVoiceSamples(fragments, 6).map((f) => f.text.trim());
  return [...new Set([...verified, ...fallback])].slice(0, 8);
}

function normaliseForMatch(s: string): string {
  return s
    .toLowerCase()
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[–—]/g, "-")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Fragments that best represent the author's voice.
 *
 * Favours the middle of the length distribution: one-liners carry too little
 * signal and long entries drift into summary. Self-contained fragments are
 * preferred because they show the voice doing complete work.
 */
export function selectVoiceSamples(fragments: readonly Fragment[], count: number): Fragment[] {
  return [...fragments]
    .map((f) => {
      const words = f.text.trim().split(/\s+/).length;
      // Peaks around 45 words and decays either side.
      const lengthScore = Math.exp(-Math.abs(Math.log(Math.max(words, 1) / 45)));
      const standalone = f.enrichment?.standalone ?? 0.5;
      return { f, score: lengthScore * 0.6 + standalone * 0.4 };
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, count)
    .map((x) => x.f);
}

function renderDigests(fragments: readonly Fragment[]): string {
  return fragments
    .map((f) => {
      const e = f.enrichment;
      if (e === null) return `- (${f.id}) [unclassified] ${f.text.slice(0, 100).trim()}`;
      const ents = e.entities.length > 0 ? ` {${e.entities.map((x) => x.entityId).join(",")}}` : "";
      return `- (${f.id}) [${e.kind}] ${e.digest}${ents}`;
    })
    .join("\n");
}

function renderVerbatim(fragments: readonly Fragment[]): string {
  return fragments.map((f) => `(${f.id})\n${f.text.trim()}`).join("\n\n");
}

function renderEntityIndex(fragments: readonly Fragment[]): string {
  const counts = new Map<string, { name: string; kind: string; count: number }>();
  for (const f of fragments) {
    for (const e of f.enrichment?.entities ?? []) {
      const existing = counts.get(e.entityId);
      if (existing) existing.count++;
      else counts.set(e.entityId, { name: e.surface, kind: e.kind, count: 1 });
    }
  }
  if (counts.size === 0) return "(no entities extracted yet)";
  return [...counts.entries()]
    .sort((a, b) => b[1].count - a[1].count)
    .map(([id, v]) => `- ${id} — "${v.name}" (${v.kind}), in ${v.count} fragment(s)`)
    .join("\n");
}

function sourcesForEntity(fragments: readonly Fragment[], entityId: string): FragmentId[] {
  return fragments
    .filter((f) => (f.enrichment?.entities ?? []).some((e) => e.entityId === entityId))
    .map((f) => f.id);
}

function sourcesForTheme(fragments: readonly Fragment[], theme: string): FragmentId[] {
  const needle = theme.toLowerCase();
  return fragments
    .filter((f) => (f.enrichment?.themes ?? []).some((t) => t.includes(needle) || needle.includes(t)))
    .map((f) => f.id);
}
