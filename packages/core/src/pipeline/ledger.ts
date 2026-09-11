import { z } from "zod";
import { getForm } from "../forms/registry.js";
import type { Llm } from "../llm/client.js";
import type { Bible } from "../types/bible.js";
import { DELTA_KINDS, type ContinuityLedger, type StateDelta } from "../types/ledger.js";
import { appendDeltas } from "../types/ledger.js";
import { asEntityId } from "../types/ids.js";
import type { DraftedScene } from "../types/manuscript.js";
import type { SceneCard } from "../types/outline.js";

/**
 * Stage 6 — continuity extraction.
 *
 * Drafting is deliberately myopic: a scene call sees the Bible and its immediate
 * neighbours, never the whole book. That is what keeps a full-length compile
 * affordable, and it is also what would produce a book where a character's eyes
 * change colour in chapter nine.
 *
 * The ledger is the fix. After each scene is drafted we extract what it
 * established, in structured form. A scene sixty pages later receives only the
 * slice of that ledger touching its own cast — typically a dozen lines. Facts
 * travel forward across the whole book without anyone paying to re-read it.
 *
 * Cheap model, small output, one call per scene, all batchable.
 */

const deltaSchema = z.object({
  kind: z.enum(DELTA_KINDS),
  subjects: z.array(z.string()).describe("Entity ids this constrains. Use ids from the Bible only."),
  statement: z
    .string()
    .describe("Present tense, one clause. 'Mara knows her father lied about the money.'"),
});

const extractionSchema = z.object({
  deltas: z.array(deltaSchema),
});

const SYSTEM = [
  "You are the continuity clerk for a book in progress.",
  "",
  "Read the scene and record what it established that a later scene must not contradict. You are",
  "not summarising the scene — you are recording constraints.",
  "",
  "Record only what is DURABLE. 'Mara crossed the room' constrains nothing. 'Mara now knows her",
  "father lied' constrains everything after it.",
  "",
  "Record:",
  "  knowledge    — someone learned something",
  "  location     — someone is now somewhere, or has left somewhere",
  "  condition    — a lasting physical or mental change",
  "  relationship — a bond formed, broken or altered",
  "  possession   — something gained or lost",
  "  time         — elapsed time, or the period this scene occupies",
  "  world        — a fact about the world now fixed",
  "  death        — someone died. Record this whenever it happens, without exception.",
  "",
  "Use entity ids from the Bible exactly. If someone is not in the Bible, omit the delta rather",
  "than inventing an id — a fabricated id corrupts every later slice of the ledger.",
  "",
  "Be terse. Six to twelve deltas for a typical scene. Recording everything is the same as",
  "recording nothing, because the next stage has to read it.",
].join("\n");

export interface ExtractOptions {
  readonly llm: Llm;
  readonly bible: Bible;
  readonly signal?: AbortSignal;
}

/** Extracts deltas for one drafted scene. */
export async function extractDeltas(
  scene: DraftedScene,
  card: SceneCard,
  order: number,
  opts: ExtractOptions,
): Promise<StateDelta[]> {
  const form = getForm(opts.bible.formBible.form);
  const validIds = new Set<string>(opts.bible.entities.map((e) => e.id as string));

  const system = [
    SYSTEM,
    "",
    `This work is a ${form.label.toLowerCase()}. Pay particular attention to: ${form
      .continuityEmphasis()
      .join(", ")}.`,
    "",
    "ENTITIES IN THIS BOOK:",
    opts.bible.entities.map((e) => `  ${e.id} — ${e.name}`).join("\n"),
  ].join("\n");

  const { value } = await opts.llm.structured(
    {
      stage: "ledger",
      role: "clerk",
      system,
      user: [
        `SCENE GOAL: ${card.goal}`,
        `SETTING: ${card.setting}`,
        "",
        "SCENE TEXT:",
        "",
        scene.prose,
      ].join("\n"),
      maxTokens: 4_000,
    },
    extractionSchema,
  );

  return value.deltas
    .map((d) => ({
      kind: d.kind,
      subjects: d.subjects.filter((s) => validIds.has(s)).map(asEntityId),
      statement: d.statement,
      sceneId: scene.sceneId,
      order,
    }))
    // A delta about nobody, in a category that is not about the world, constrains nothing.
    .filter((d) => d.subjects.length > 0 || d.kind === "world" || d.kind === "time");
}

/**
 * Builds the ledger across a manuscript in reading order.
 *
 * Sequential by necessity: `order` is the reading position, and the slice handed
 * to scene N must contain exactly what was true before it. Each call is small and
 * cheap, so the serialisation costs little.
 */
export async function buildLedger(
  scenes: readonly DraftedScene[],
  cards: readonly SceneCard[],
  opts: ExtractOptions,
  onProgress?: (done: number, total: number) => void,
): Promise<ContinuityLedger> {
  const cardById = new Map(cards.map((c) => [c.id as string, c]));
  let ledger: ContinuityLedger = { deltas: [] };

  for (let i = 0; i < scenes.length; i++) {
    if (opts.signal?.aborted === true) break;
    const scene = scenes[i]!;
    const card = cardById.get(scene.sceneId as string);
    if (card === undefined) continue;
    ledger = appendDeltas(ledger, await extractDeltas(scene, card, i, opts));
    onProgress?.(i + 1, scenes.length);
  }
  return ledger;
}
