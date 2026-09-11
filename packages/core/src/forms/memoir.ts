import { z } from "zod";
import type { MemoirBible } from "../types/bible.js";
import { asEntityId } from "../types/ids.js";
import type { FormDefinition, StructuralPart } from "./types.js";

const schema = z.object({
  form: z.literal("memoir"),
  governingQuestion: z
    .string()
    .describe(
      "The question the book is asking of the author's own life. Must be genuinely open — a " +
        "question the author does not already know the answer to.",
    ),
  retrospectiveStance: z
    .string()
    .describe(
      "How the narrating self, now, regards the experiencing self, then. The gap between them is " +
        "where memoir generates meaning.",
    ),
  timeSpan: z.object({
    earliest: z.string().describe("Earliest period covered, however the fragments express it."),
    latest: z.string().describe("Latest period covered."),
  }),
  sensitiveEntityIds: z
    .array(z.string())
    .describe("Entity ids of real living people who should be handled with particular care."),
  throughLine: z
    .string()
    .describe("The thread connecting otherwise unrelated episodes. Not a plot — a preoccupation."),
});

/**
 * Memoir is not organised in acts, because the events are not negotiable and
 * cannot be reordered for dramatic convenience. What creates structure is the
 * narrator's inquiry: circling a question, approaching it from new angles, and
 * arriving somewhere that is not an answer but is not where they started either.
 */
const PARTS: readonly StructuralPart[] = [
  {
    name: "Part One: The Question",
    proportion: 0.3,
    purpose:
      "Establish the governing question through concrete scene rather than statement. Show the " +
      "reader the world that produced the question. Earn the right to the inquiry before making it.",
  },
  {
    name: "Part Two: The Evidence",
    proportion: 0.4,
    purpose:
      "Circle the question from multiple angles and periods. Let episodes contradict one another — " +
      "memoir is strengthened, not weakened, by evidence that resists the thesis. The retrospective " +
      "narrator may comment, but must not resolve.",
  },
  {
    name: "Part Three: The Reckoning",
    proportion: 0.3,
    purpose:
      "Arrive somewhere honest. Not a resolution and not a moral: a changed relationship to the " +
      "question. The reader should feel the narrator has stopped performing and started admitting.",
  },
];

export const memoirForm: FormDefinition<MemoirBible> = {
  form: "memoir",
  label: "Memoir",
  description: "A life examined through a question — built from what you actually remember.",
  bibleSchema: schema.transform(
    (v): MemoirBible => ({
      form: "memoir",
      governingQuestion: v.governingQuestion,
      retrospectiveStance: v.retrospectiveStance,
      timeSpan: v.timeSpan,
      sensitiveEntityIds: v.sensitiveEntityIds.map(asEntityId),
      throughLine: v.throughLine,
    }),
  ) as unknown as z.ZodType<MemoirBible>,

  bibleGuidance: () =>
    [
      "This is a memoir, assembled from things that actually happened to the author.",
      "",
      "- Find the governing question, do not invent it. It is already latent in what the author kept",
      "  returning to. If the fragments circle a dead parent, the question is not 'what was my father",
      "  like' but something harder that the author has been approaching sideways for months.",
      "- The question must be genuinely open. If it has an answer the author clearly already holds,",
      "  it is a thesis, and a memoir built on a thesis becomes an argument.",
      "- Never invent events, people, places or dialogue. You may only arrange, connect and render",
      "  what the fragments contain. Where a connection is inferred rather than stated, the prose",
      "  must mark it as inference — 'I think', 'it must have been', 'I have no memory of'.",
      "- Real people deserve care. For anyone flagged sensitive, render them with interiority and",
      "  complexity rather than as instruments of the narrator's argument.",
      "- Uncertainty is material, not a defect. 'I do not remember whether she was crying' is often",
      "  the truest and most powerful line available.",
    ].join("\n"),

  outlineGuidance: () =>
    [
      "Do not impose a plot. Order episodes by the logic of inquiry, not chronology — memoir earns",
      "its shape by juxtaposition, placing a childhood scene beside one from thirty years later",
      "because they illuminate each other.",
      "",
      "Every episode must be anchored in remembered specifics from the fragments. An episode with no",
      "concrete source material is one you are about to fabricate: leave it out.",
      "",
      "Alternate register. Scene, then reflection, then scene. Sustained reflection without the",
      "grounding of lived moment becomes an essay; sustained scene without reflection becomes a",
      "diary. The book lives in the movement between them.",
      "",
      "Mark explicitly, in each scene's entering state, which time period it occupies. Memoir moves",
      "between periods constantly and the reader must never be lost.",
    ].join("\n"),

  sceneGuidance: () =>
    [
      "Two voices are at work: the experiencing self who did not yet know how things turned out, and",
      "the narrating self who does. Let both speak. The distance between them is where meaning lives.",
      "",
      "Stay inside what the source fragments support. Sensory texture may be rendered vividly, but",
      "you may not invent an event, a person, or a line of dialogue that is not in the material.",
      "Where the record is thin, say so in the narrator's voice rather than filling the gap.",
      "",
      "Resist retrospective tidiness. The author did not understand it at the time, and pretending",
      "otherwise is the most common way memoir goes false.",
    ].join("\n"),

  parts: () => PARTS,

  renderBible: (b) =>
    [
      `GOVERNING QUESTION: ${b.governingQuestion}`,
      `THROUGH-LINE: ${b.throughLine}`,
      `RETROSPECTIVE STANCE: ${b.retrospectiveStance}`,
      `TIME SPAN: ${b.timeSpan.earliest} → ${b.timeSpan.latest}`,
      b.sensitiveEntityIds.length > 0
        ? `SENSITIVE (render with care and interiority): ${b.sensitiveEntityIds.join(", ")}`
        : "",
      "",
      "FACTUAL CONSTRAINT: Invent nothing. Arrange, connect and render only what the source",
      "fragments contain. Mark inference as inference.",
    ]
      .filter(Boolean)
      .join("\n"),

  continuityEmphasis: () => ["time", "knowledge", "relationship", "location", "death"],
};
