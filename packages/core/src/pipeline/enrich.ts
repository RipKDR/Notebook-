import { z } from "zod";
import type { Llm } from "../llm/client.js";
import type { EmbeddingProvider } from "../retrieval/embed.js";
import { FRAGMENT_KINDS, type Fragment, type FragmentEnrichment } from "../types/fragment.js";
import { asEntityId, type FragmentId } from "../types/ids.js";

/**
 * Stage 1 — enrichment.
 *
 * This runs continuously in the background as the user writes, not at compile
 * time. That scheduling decision is what makes "write my book" feel instantaneous
 * rather than like a forty-minute cold start: by the time the button is pressed,
 * a corpus of a thousand loose sentences is already classified, entity-linked and
 * embedded.
 *
 * It is also the cheapest stage by a wide margin, because fragments are packed
 * many-to-a-call. The system prompt is the dominant cost for a 30-word note, so
 * amortising it across a batch of twenty cuts the bill by roughly an order of
 * magnitude versus one call per fragment.
 */

/** Bump when the schema or prompt changes in a way that makes old enrichments wrong. */
export const ENRICHER_VERSION = "enrich-v1";

/** Fragments per model call. Large enough to amortise the prompt, small enough to stay accurate. */
const PACK_SIZE = 20;

const entitySchema = z.object({
  surface: z.string().describe("The words as they literally appeared in the fragment."),
  canonical: z
    .string()
    .describe(
      "A normalised name for this entity, consistent across fragments. 'my grandmother', 'Nan' " +
        "and 'Grandma Rose' should all normalise to the same string.",
    ),
  kind: z.enum(["person", "place", "object", "organisation", "event"]),
});

const itemSchema = z.object({
  index: z.number().int().describe("The 1-based index of the fragment this describes."),
  kind: z.enum(FRAGMENT_KINDS),
  digest: z
    .string()
    .describe("One clause, at most 120 characters, saying what this fragment is. For scanning."),
  entities: z.array(entitySchema),
  themes: z.array(z.string()).describe("Lowercase thematic tags. Two to five."),
  valence: z.number().min(-1).max(1).describe("-1 bleak, 0 neutral, +1 luminous."),
  standalone: z
    .number()
    .min(0)
    .max(1)
    .describe(
      "0 = a stray phrase usable only as texture; 1 = a complete moment that could anchor a scene.",
    ),
});

const responseSchema = z.object({
  items: z.array(itemSchema),
});

const SYSTEM = [
  "You are the indexing stage of a writing tool. The user captures loose sentences and paragraphs",
  "as they occur to them, with no structure and no metadata. Your job is to make that raw material",
  "findable and groupable later, when it is assembled into a book.",
  "",
  "For each fragment, classify it, extract entities, tag themes, and judge how self-contained it is.",
  "",
  "Rules that matter:",
  "",
  "- Normalise entities aggressively. The whole system depends on recognising that 'my father',",
  "  'Dad' and 'Robert' are one person. When in doubt about whether two mentions are the same",
  "  entity, prefer merging them — a later stage can split, but it can never discover a link you",
  "  did not record.",
  "- Do not interpret, moralise, or improve. You are indexing, not editing. A fragment that reads",
  "  as cruel or confused is indexed as it stands.",
  "- 'standalone' is the outliner's most important input. A fragment that describes a complete",
  "  moment with people, place and action scores high. A bare aphorism scores low — it is usable,",
  "  but only woven into a scene built from something else.",
  "- Short is not the same as unusable. 'She never once said my name' is a complete emotional",
  "  event; score it accordingly.",
  "- Return exactly one item per input fragment, with matching indices.",
].join("\n");

export interface EnrichOptions {
  readonly llm: Llm;
  readonly embeddings: EmbeddingProvider;
  readonly onProgress?: (done: number, total: number) => void;
  readonly signal?: AbortSignal;
}

/** Fragments needing (re-)enrichment: never enriched, or enriched by a stale prompt version. */
export function needsEnrichment(fragments: readonly Fragment[]): Fragment[] {
  return fragments.filter(
    (f) =>
      f.deletedAt === null &&
      f.text.trim().length > 0 &&
      (f.enrichment === null || f.enrichment.enricherVersion !== ENRICHER_VERSION),
  );
}

export function needsEmbedding(fragments: readonly Fragment[]): Fragment[] {
  return fragments.filter(
    (f) => f.deletedAt === null && f.text.trim().length > 0 && f.embedding === null,
  );
}

/**
 * Enriches and embeds. Returns a patch map rather than mutated fragments so the
 * caller owns persistence — the pipeline never writes to the database directly.
 */
export async function enrichFragments(
  fragments: readonly Fragment[],
  opts: EnrichOptions,
): Promise<Map<FragmentId, { enrichment?: FragmentEnrichment; embedding?: Float32Array }>> {
  const patches = new Map<
    FragmentId,
    { enrichment?: FragmentEnrichment; embedding?: Float32Array }
  >();

  const toEnrich = needsEnrichment(fragments);
  const toEmbed = needsEmbedding(fragments);
  const total = toEnrich.length + Math.ceil(toEmbed.length / 128);
  let done = 0;

  // --- Classification, packed ---
  for (let i = 0; i < toEnrich.length; i += PACK_SIZE) {
    if (opts.signal?.aborted === true) break;
    const pack = toEnrich.slice(i, i + PACK_SIZE);

    const user = pack
      .map((f, n) => `[${n + 1}]\n${f.text.trim()}`)
      .join("\n\n---\n\n");

    const { value } = await opts.llm.structured(
      {
        stage: "enrich",
        role: "clerk",
        system: SYSTEM,
        user,
        maxTokens: 8_000,
      },
      responseSchema,
    );

    const now = Date.now();
    for (const item of value.items) {
      const fragment = pack[item.index - 1];
      if (fragment === undefined) continue; // Model returned an index we did not send.

      const enrichment: FragmentEnrichment = {
        kind: item.kind,
        digest: item.digest.slice(0, 120),
        entities: item.entities.map((e) => ({
          entityId: asEntityId(canonicalKey(e.canonical, e.kind)),
          surface: e.surface,
          kind: e.kind,
        })),
        themes: item.themes.map((t) => t.toLowerCase().trim()).filter(Boolean),
        valence: clamp(item.valence, -1, 1),
        standalone: clamp(item.standalone, 0, 1),
        enricherVersion: ENRICHER_VERSION,
        enrichedAt: now,
      };
      patches.set(fragment.id, { ...patches.get(fragment.id), enrichment });
    }

    done += pack.length;
    opts.onProgress?.(done, total);
  }

  // --- Embedding ---
  const EMBED_BATCH = 128;
  for (let i = 0; i < toEmbed.length; i += EMBED_BATCH) {
    if (opts.signal?.aborted === true) break;
    const pack = toEmbed.slice(i, i + EMBED_BATCH);
    const vectors = await opts.embeddings.embed(pack.map((f) => f.text));
    pack.forEach((f, n) => {
      const v = vectors[n];
      if (v !== undefined) patches.set(f.id, { ...patches.get(f.id), embedding: v });
    });
    done++;
    opts.onProgress?.(done, total);
  }

  return patches;
}

/**
 * A stable id for a canonical entity name.
 *
 * Deriving the id from the normalised name (rather than minting a random one)
 * means the same person mentioned in a fragment written today and one written
 * next March links up automatically, with no cross-fragment resolution pass.
 */
export function canonicalKey(canonical: string, kind: string): string {
  const slug = canonical
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  return `${kind}:${slug || "unnamed"}`;
}

function clamp(n: number, lo: number, hi: number): number {
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : 0;
}
