import type { LoomDatabase } from "@loom/db";
import { asEntityId, type FragmentEnrichment } from "@loom/core";
import { enrich, type ApiConfig } from "./api";

/**
 * The indexer.
 *
 * Fragments arrive raw: no classification, no entities, no embedding. Until
 * something fills those in, clustering has nothing to work with and the Threads
 * screen — the moment a user discovers what they have been writing — stays
 * permanently empty.
 *
 * It runs opportunistically rather than on a schedule: when the app comes to the
 * foreground and shortly after a capture. That is deliberate. Enrichment is
 * cheap but not free, and a note written thirty seconds ago does not need to be
 * indexed within thirty seconds — it needs to be indexed before the user next
 * opens Threads.
 *
 * Every failure mode here is non-fatal. A fragment that fails to index stays in
 * the queue and is retried next time; the user's writing is never at risk,
 * because the text was committed to SQLite before any of this ran.
 */

/** Matches the worker's per-request cap. */
const CHUNK = 100;

export interface EnrichmentProgress {
  readonly done: number;
  readonly total: number;
}

export interface EnrichmentResult {
  readonly indexed: number;
  readonly remaining: number;
  readonly error: string | null;
}

export class Indexer {
  private running = false;

  constructor(
    private readonly db: LoomDatabase,
    private readonly config: () => ApiConfig | null,
  ) {}

  get isRunning(): boolean {
    return this.running;
  }

  /**
   * Indexes everything outstanding, oldest batch first.
   *
   * Re-entrant calls are dropped rather than queued: two passes over the same
   * backlog would pay twice for the same fragments.
   */
  async run(
    opts: { onProgress?: (p: EnrichmentProgress) => void; signal?: AbortSignal } = {},
  ): Promise<EnrichmentResult> {
    if (this.running) return { indexed: 0, remaining: 0, error: null };

    const config = this.config();
    if (config === null) {
      const pending = await this.db.fragmentsNeedingEnrichment(1);
      return {
        indexed: 0,
        remaining: pending.length,
        error: pending.length > 0 ? "No compile service configured." : null,
      };
    }

    this.running = true;
    let indexed = 0;

    try {
      for (;;) {
        if (opts.signal?.aborted === true) break;

        const pending = await this.db.fragmentsNeedingEnrichment(CHUNK);
        if (pending.length === 0) break;

        const { patches, embeddingModel } = await enrich(
          config,
          pending.map((f) => ({ id: f.id as string, text: f.text, createdAt: f.createdAt })),
        );

        let applied = 0;
        for (const patch of patches) {
          const fragment = pending.find((f) => (f.id as string) === patch.id);
          if (fragment === undefined) continue;

          await this.db.applyEnrichment(fragment.id, {
            ...(patch.enrichment !== null
              ? { enrichment: toEnrichment(patch.enrichment) }
              : {}),
            ...(patch.embedding !== null
              ? {
                  embedding: Float32Array.from(patch.embedding),
                  embeddingModel,
                }
              : {}),
          });
          applied++;
        }

        indexed += applied;
        opts.onProgress?.({ done: indexed, total: indexed + pending.length - applied });

        // Nothing was applied, so the same batch would come back forever.
        // Stop rather than spin against a worker that cannot index this input.
        if (applied === 0) {
          return {
            indexed,
            remaining: pending.length,
            error: "The service returned nothing for these notes.",
          };
        }
        if (pending.length < CHUNK) break;
      }

      const left = await this.db.fragmentsNeedingEnrichment(1);
      return { indexed, remaining: left.length, error: null };
    } catch (err: unknown) {
      const left = await this.db.fragmentsNeedingEnrichment(1).catch(() => []);
      return {
        indexed,
        remaining: left.length,
        error: err instanceof Error ? err.message : "Indexing failed.",
      };
    } finally {
      this.running = false;
    }
  }
}

/** Widens the worker's JSON into the branded type the rest of the app uses. */
function toEnrichment(raw: NonNullable<
  Awaited<ReturnType<typeof enrich>>["patches"][number]["enrichment"]
>): FragmentEnrichment {
  return {
    kind: raw.kind as FragmentEnrichment["kind"],
    digest: raw.digest,
    entities: raw.entities.map((e) => ({
      entityId: asEntityId(e.entityId),
      surface: e.surface,
      kind: e.kind as "person" | "place" | "object" | "organisation" | "event",
    })),
    themes: raw.themes,
    valence: raw.valence,
    standalone: raw.standalone,
    enricherVersion: raw.enricherVersion,
    enrichedAt: raw.enrichedAt,
  };
}
