import { normalise } from "./vector.js";

/**
 * Embeddings are pluggable.
 *
 * Anthropic does not serve an embeddings endpoint, so this is a genuine
 * third-party dependency and the one place the pipeline reaches outside the
 * Claude API. Keeping it behind an interface means the choice of provider is a
 * deployment decision rather than an architectural one, and it lets the free
 * offline tier run against the local fallback with no network at all.
 */
export interface EmbeddingProvider {
  readonly id: string;
  readonly dimensions: number;
  /** Embeds a batch. Implementations must preserve input order. */
  embed(texts: readonly string[]): Promise<Float32Array[]>;
}

/**
 * Voyage AI — Anthropic's recommended embedding partner.
 *
 * `voyage-3.5-lite` is the right default here: fragments are short, we embed
 * thousands of them continuously in the background, and clustering loose notes
 * does not need the largest model. Swap the model id for `voyage-3.5` if
 * constellation quality turns out to be the bottleneck.
 */
export class VoyageEmbeddings implements EmbeddingProvider {
  readonly id: string;
  readonly dimensions = 1024;

  constructor(
    private readonly apiKey: string,
    private readonly model: string = "voyage-3.5-lite",
    private readonly baseUrl: string = "https://api.voyageai.com/v1/embeddings",
  ) {
    this.id = `voyage:${model}`;
  }

  async embed(texts: readonly string[]): Promise<Float32Array[]> {
    if (texts.length === 0) return [];

    const response = await fetch(this.baseUrl, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({
        input: texts,
        model: this.model,
        input_type: "document",
      }),
    });

    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new Error(`Voyage embeddings failed (${response.status}): ${body.slice(0, 300)}`);
    }

    const json = (await response.json()) as {
      data: { index: number; embedding: number[] }[];
    };

    const out = new Array<Float32Array>(texts.length);
    for (const row of json.data) {
      out[row.index] = normalise(Float32Array.from(row.embedding));
    }
    for (let i = 0; i < out.length; i++) {
      if (out[i] === undefined) throw new Error(`Voyage omitted an embedding at index ${i}`);
    }
    return out;
  }
}

/**
 * A deterministic, dependency-free local embedder.
 *
 * This is hashed character-trigram bag-of-features, not a learned model. It has
 * no semantic understanding: it will cluster "the dog barked" with "the dog
 * slept" on shared substrings, and will miss that "my father" and "Dad" are the
 * same subject. That is a real quality ceiling, and it is why the paid tier's
 * constellations are materially better than the free tier's.
 *
 * It earns its place anyway. It runs offline, costs nothing, leaks nothing, and
 * makes the free tier genuinely functional rather than a nag screen — and for
 * near-duplicate detection and coarse topical grouping it is honestly fine.
 */
export class LocalTrigramEmbeddings implements EmbeddingProvider {
  readonly id = "local:trigram-v1";

  constructor(readonly dimensions: number = 512) {}

  async embed(texts: readonly string[]): Promise<Float32Array[]> {
    return texts.map((t) => this.embedOne(t));
  }

  private embedOne(text: string): Float32Array {
    const v = new Float32Array(this.dimensions);
    const clean = text.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, " ").replace(/\s+/g, " ").trim();
    if (clean.length === 0) return v;

    // Word unigrams carry topic; character trigrams carry morphology and
    // survive the typos and shorthand that real captured notes are full of.
    const bump = (token: string, weight: number): void => {
      const at = this.bucket(token);
      v[at] = (v[at] ?? 0) + weight;
    };
    for (const word of clean.split(" ")) bump(`w:${word}`, 1);
    const padded = ` ${clean} `;
    for (let i = 0; i + 3 <= padded.length; i++) bump(`t:${padded.slice(i, i + 3)}`, 0.5);

    // Sublinear scaling stops long fragments dominating short ones.
    for (let i = 0; i < v.length; i++) v[i] = Math.log1p(v[i]!);
    return normalise(v);
  }

  /** FNV-1a, folded into the vector width. */
  private bucket(token: string): number {
    let h = 0x811c9dc5;
    for (let i = 0; i < token.length; i++) {
      h ^= token.charCodeAt(i);
      h = Math.imul(h, 0x01000193) >>> 0;
    }
    return h % this.dimensions;
  }
}
