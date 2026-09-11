import { z } from "zod";
import type { FictionBible } from "../types/bible.js";
import { asEntityId } from "../types/ids.js";
import type { FormDefinition, StructuralPart } from "./types.js";

const schema = z.object({
  form: z.literal("fiction"),
  premise: z.string().describe("The story in one or two sentences, stated as a causal chain."),
  protagonistId: z
    .string()
    .nullable()
    .describe("Entity id of the protagonist, or null if genuinely ensemble."),
  want: z.string().describe("What the protagonist consciously pursues. External, concrete, stateable."),
  need: z
    .string()
    .describe("What they actually require to be whole, which they cannot see at the start."),
  centralConflict: z.string().describe("The opposition that makes the want costly."),
  worldRules: z
    .array(z.string())
    .describe("Constraints the story may never violate. Physical, social, magical or institutional."),
  stakes: z.string().describe("What is lost if the protagonist fails. Specific, not abstract."),
});

const PARTS: readonly StructuralPart[] = [
  {
    name: "Act I",
    proportion: 0.25,
    purpose:
      "Establish the protagonist in their ordinary world, make the want concrete, and end on the " +
      "irreversible choice that commits them. The reader should be unable to imagine going back.",
  },
  {
    name: "Act IIa",
    proportion: 0.25,
    purpose:
      "The protagonist pursues the want with growing competence and escalating cost. Each scene " +
      "should make the next one necessary. Introduce the pressure that will later expose the need.",
  },
  {
    name: "Act IIb",
    proportion: 0.25,
    purpose:
      "The strategy that was working stops working. Drive towards the point where the want and the " +
      "need become visibly incompatible, and the protagonist loses what they were relying on.",
  },
  {
    name: "Act III",
    proportion: 0.25,
    purpose:
      "Force the choice between want and need, pay off every setup that has been planted, and end " +
      "on a changed state that the opening made impossible.",
  },
];

export const fictionForm: FormDefinition<FictionBible> = {
  form: "fiction",
  label: "Novel",
  description: "A story built from causality — characters who want something and pay for it.",
  bibleSchema: schema.transform(
    (v): FictionBible => ({
      form: "fiction",
      premise: v.premise,
      protagonistId: v.protagonistId === null ? null : asEntityId(v.protagonistId),
      want: v.want,
      need: v.need,
      centralConflict: v.centralConflict,
      worldRules: v.worldRules,
      stakes: v.stakes,
    }),
  ) as unknown as z.ZodType<FictionBible>,

  bibleGuidance: () =>
    [
      "This is a work of fiction. Build the Bible around causality.",
      "",
      "- The premise must be a causal chain, not a situation. 'A widower moves to a lighthouse' is a",
      "  situation. 'A widower takes a lighthouse posting to avoid his daughter, and the isolation",
      "  forces the confrontation he moved to escape' is a premise.",
      "- Want and need must be different, and their incompatibility is the engine of the book. If you",
      "  cannot state why pursuing the want prevents meeting the need, keep working.",
      "- Stakes must be specific and losable. 'His family' is not stakes. 'The last person who",
      "  remembers his wife's voice' is.",
      "- World rules are constraints you are forbidding yourself later. Only state rules the",
      "  fragments actually imply — do not invent a magic system nobody wrote.",
    ].join("\n"),

  outlineGuidance: () =>
    [
      "Structure the outline as a chain of consequence. Every scene must be caused by an earlier",
      "scene and must cause a later one. If a scene could be removed without breaking the chain,",
      "it does not belong in the outline.",
      "",
      "Each scene needs a change of state — someone wants something, meets opposition, and ends in a",
      "different position from where they started. A scene where nothing changes is a description.",
      "",
      "Vary valence deliberately across chapters. Four consecutive scenes at the same emotional pitch",
      "read as flat no matter how good the prose is.",
    ].join("\n"),

  sceneGuidance: () =>
    [
      "Write in scene, not in summary. Concrete sensory detail, action in real time, dialogue that",
      "does work. Resist the summarising register that flattens a whole afternoon into a paragraph.",
      "",
      "Enter late and leave early: begin at the last possible moment before the scene's turn, and cut",
      "as soon as it has turned.",
      "",
      "Conflict can be quiet. Two people being polite to each other while one of them is lying is a",
      "scene with conflict.",
    ].join("\n"),

  parts: () => PARTS,

  renderBible: (b) =>
    [
      `PREMISE: ${b.premise}`,
      `WANT (conscious, external): ${b.want}`,
      `NEED (unconscious, internal): ${b.need}`,
      `CENTRAL CONFLICT: ${b.centralConflict}`,
      `STAKES: ${b.stakes}`,
      b.worldRules.length > 0
        ? `WORLD RULES (never violate):\n${b.worldRules.map((r) => `  - ${r}`).join("\n")}`
        : "",
    ]
      .filter(Boolean)
      .join("\n"),

  continuityEmphasis: () => ["knowledge", "location", "condition", "relationship", "possession", "death"],
};
