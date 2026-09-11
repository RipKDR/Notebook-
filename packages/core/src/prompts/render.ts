import type { Bible } from "../types/bible.js";
import type { Fragment } from "../types/fragment.js";
import type { StateDelta } from "../types/ledger.js";
import type { SceneCard } from "../types/outline.js";
import { estimateTokens } from "../types/fragment.js";
import { renderFormBible } from "../forms/registry.js";

/**
 * Rendering the Bible into a prompt prefix.
 *
 * This text is the cached prefix for every one of a compile's ~80 scene calls,
 * so two properties matter enormously:
 *
 *  1. It must be *small*. Every token here is paid ~80 times, albeit at the 0.1x
 *     cache-read rate. The budget below is not advisory.
 *  2. It must be *byte-stable*. A single changed character invalidates the cache
 *     for the rest of the compile and quietly multiplies the bill. Nothing
 *     volatile — no timestamps, no iteration counters, no unsorted maps — may
 *     appear in this string.
 */

/** Hard ceiling for the rendered Bible. Exceeding it throws rather than silently overspending. */
export const BIBLE_TOKEN_BUDGET = 8_000;

export class BibleTooLargeError extends Error {
  constructor(
    readonly tokens: number,
    readonly budget: number,
  ) {
    super(
      `Rendered Bible is ~${tokens} tokens, over the ${budget}-token budget. ` +
        `It is read once per scene, so overrunning it inflates the cost of the whole compile.`,
    );
    this.name = "BibleTooLargeError";
  }
}

export function renderBible(bible: Bible, opts: { enforceBudget?: boolean } = {}): string {
  const lines: string[] = [
    `TITLE: ${bible.title}`,
    `LOGLINE: ${bible.logline}`,
    "",
    renderFormBible(bible.formBible),
    "",
    "VOICE",
    bible.voice.description,
    `Person: ${bible.voice.person}. Tense: ${bible.voice.tense}.`,
  ];

  if (bible.voice.exemplars.length > 0) {
    lines.push(
      "",
      "The author's own sentences. Match this rhythm, diction and level of abstraction.",
      "This is the single most important instruction in this document: the book must sound",
      "like the person who wrote these, not like a language model.",
      ...bible.voice.exemplars.map((e) => `  > ${e}`),
    );
  }
  if (bible.voice.avoid.length > 0) {
    lines.push("", "NEVER:", ...bible.voice.avoid.map((a) => `  - ${a}`));
  }

  if (bible.entities.length > 0) {
    lines.push("", "CAST AND PLACES");
    for (const e of bible.entities) {
      const aliases = e.aliases.length > 0 ? ` (also: ${e.aliases.join(", ")})` : "";
      lines.push(`  [${e.id}] ${e.name}${aliases} — ${e.kind}`);
      lines.push(`      ${e.description}`);
      lines.push(`      At the start: ${e.initialState}`);
    }
  }

  if (bible.themes.length > 0) {
    lines.push("", "THEMES AND MOTIFS");
    for (const t of bible.themes) {
      lines.push(`  ${t.name}: ${t.statement}`);
      if (t.motifs.length > 0) lines.push(`      Motifs: ${t.motifs.join(", ")}`);
    }
  }

  const text = lines.join("\n");
  const tokens = estimateTokens(text);
  if (opts.enforceBudget !== false && tokens > BIBLE_TOKEN_BUDGET) {
    throw new BibleTooLargeError(tokens, BIBLE_TOKEN_BUDGET);
  }
  return text;
}

/** The user's own fragments, verbatim. Never paraphrase these into the prompt. */
export function renderFragments(fragments: readonly Fragment[]): string {
  if (fragments.length === 0) return "(none assigned)";
  return fragments
    .map((f, i) => {
      const kind = f.enrichment?.kind ?? "fragmentary";
      return `[${i + 1}] (${kind}, id=${f.id})\n${f.text.trim()}`;
    })
    .join("\n\n");
}

export function renderLedger(deltas: readonly StateDelta[]): string {
  if (deltas.length === 0) return "(nothing established yet)";
  return deltas.map((d) => `  - [${d.kind}] ${d.statement}`).join("\n");
}

export function renderSceneCard(card: SceneCard, bible: Bible): string {
  const name = (id: string): string =>
    bible.entities.find((e) => e.id === id)?.name ?? id;

  return [
    `GOAL: ${card.goal}`,
    `SETTING: ${card.setting}`,
    card.pov !== null ? `POINT OF VIEW: ${name(card.pov)}` : "POINT OF VIEW: as established",
    card.present.length > 0 ? `PRESENT: ${card.present.map(name).join(", ")}` : "",
    `OPENS WITH: ${card.enteringState}`,
    `MUST CLOSE WITH: ${card.exitingState}`,
    `TARGET LENGTH: ${card.targetWords} words`,
    card.motifs.length > 0 ? `MOTIFS TO SOUND HERE: ${card.motifs.join(", ")}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}
