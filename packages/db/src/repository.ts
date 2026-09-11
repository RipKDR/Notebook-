import {
  decodeVector,
  encodeVector,
  newId,
  asFragmentId,
  asProjectId,
  asEntityId,
  asChapterId,
  asSceneId,
  type CaptureSource,
  type Fragment,
  type FragmentEnrichment,
  type FragmentId,
  type Project,
  type ProjectId,
  type WorkForm,
  type DraftedScene,
  type PassName,
} from "@loom/core";
import type { SqlAdapter, SqlValue } from "./adapter.js";
import { CONNECTION_PRAGMAS, MIGRATIONS } from "./schema.js";

/**
 * The local database.
 *
 * This is the source of truth. Not a cache of the server — the source. The app
 * is fully functional with the network permanently off, and cloud sync is a
 * feature layered on top rather than a dependency underneath. That ordering is
 * what makes it honest to say a user's writing is theirs.
 */

interface FragmentRow {
  id: string;
  project_id: string | null;
  text: string;
  created_at: number;
  updated_at: number;
  source: string;
  deleted_at: number | null;
  pinned: number;
  kind: string | null;
  digest: string | null;
  themes: string | null;
  valence: number | null;
  standalone: number | null;
  enricher_version: string | null;
  enriched_at: number | null;
  embedding: Uint8Array | null;
}

interface EntityRow {
  fragment_id: string;
  entity_id: string;
  surface: string;
  kind: string;
}

export class LoomDatabase {
  constructor(private readonly db: SqlAdapter) {}

  /** Applies pragmas and any outstanding migrations. Safe to call on every launch. */
  async migrate(): Promise<number> {
    await this.db.exec(CONNECTION_PRAGMAS);

    const row = await this.db.first<{ user_version: number }>("PRAGMA user_version;");
    let version = row?.user_version ?? 0;

    for (const migration of MIGRATIONS) {
      if (migration.version <= version) continue;
      await this.db.transaction(async () => {
        await this.db.exec(migration.sql);
        // PRAGMA does not accept bound parameters; the value is a literal from
        // our own migration list, never user input.
        await this.db.exec(`PRAGMA user_version = ${migration.version};`);
      });
      version = migration.version;
    }
    return version;
  }

  // -------------------------------------------------------------------------
  // Fragments
  // -------------------------------------------------------------------------

  /**
   * Capture. The hottest path in the product.
   *
   * One insert, no joins, no network, no required metadata. If this is not
   * effectively instantaneous the user stops capturing, and with no fragments
   * there is no book.
   */
  async capture(text: string, source: CaptureSource = "quick", projectId: ProjectId | null = null): Promise<Fragment> {
    const now = Date.now();
    const id = asFragmentId(newId(now));

    await this.db.run(
      `INSERT INTO fragments (id, project_id, text, created_at, updated_at, source, dirty)
       VALUES (?, ?, ?, ?, ?, ?, 1)`,
      [id, projectId, text, now, now, source],
    );
    await this.enqueueSync("fragment", id, "upsert");

    return {
      id,
      projectId,
      text,
      createdAt: now,
      updatedAt: now,
      source,
      deletedAt: null,
      pinned: false,
      enrichment: null,
      embedding: null,
    };
  }

  async updateText(id: FragmentId, text: string): Promise<void> {
    const now = Date.now();
    await this.db.transaction(async () => {
      // Editing the text invalidates the enrichment and the embedding derived
      // from it. Clearing them re-queues the fragment for the indexer rather
      // than leaving a stale digest that would mislead the outliner.
      await this.db.run(
        `UPDATE fragments
            SET text = ?, updated_at = ?, dirty = 1,
                kind = NULL, digest = NULL, themes = NULL, valence = NULL,
                standalone = NULL, enricher_version = NULL, enriched_at = NULL,
                embedding = NULL, embedding_model = NULL
          WHERE id = ?`,
        [text, now, id],
      );
      await this.db.run(`DELETE FROM fragment_entities WHERE fragment_id = ?`, [id]);
      await this.enqueueSync("fragment", id, "upsert");
    });
  }

  /** Soft delete. The pipeline never hard-deletes a user's writing. */
  async softDelete(id: FragmentId): Promise<void> {
    const now = Date.now();
    await this.db.run(
      `UPDATE fragments SET deleted_at = ?, updated_at = ?, dirty = 1 WHERE id = ?`,
      [now, now, id],
    );
    await this.enqueueSync("fragment", id, "delete");
  }

  async restore(id: FragmentId): Promise<void> {
    const now = Date.now();
    await this.db.run(
      `UPDATE fragments SET deleted_at = NULL, updated_at = ?, dirty = 1 WHERE id = ?`,
      [now, id],
    );
    await this.enqueueSync("fragment", id, "upsert");
  }

  async setPinned(id: FragmentId, pinned: boolean): Promise<void> {
    await this.db.run(
      `UPDATE fragments SET pinned = ?, updated_at = ?, dirty = 1 WHERE id = ?`,
      [pinned ? 1 : 0, Date.now(), id],
    );
  }

  async getFragment(id: FragmentId): Promise<Fragment | null> {
    const row = await this.db.first<FragmentRow>(`SELECT * FROM fragments WHERE id = ?`, [id]);
    if (row === null) return null;
    const entities = await this.db.all<EntityRow>(
      `SELECT * FROM fragment_entities WHERE fragment_id = ?`,
      [id],
    );
    return hydrate(row, entities);
  }

  /** Newest first — the reverse-chronological feed the capture screen shows. */
  async listFragments(
    opts: { projectId?: ProjectId | null; limit?: number; offset?: number; includeDeleted?: boolean } = {},
  ): Promise<Fragment[]> {
    const where: string[] = [];
    const params: SqlValue[] = [];

    if (opts.includeDeleted !== true) where.push("deleted_at IS NULL");
    if (opts.projectId !== undefined) {
      if (opts.projectId === null) where.push("project_id IS NULL");
      else {
        where.push("project_id = ?");
        params.push(opts.projectId);
      }
    }

    const clause = where.length > 0 ? `WHERE ${where.join(" AND ")}` : "";
    params.push(opts.limit ?? 200, opts.offset ?? 0);

    const rows = await this.db.all<FragmentRow>(
      `SELECT * FROM fragments ${clause} ORDER BY created_at DESC LIMIT ? OFFSET ?`,
      params,
    );
    return this.hydrateAll(rows);
  }

  /** Every fragment the compiler should consider. Loads embeddings; use sparingly. */
  async allUsableFragments(projectId?: ProjectId | null): Promise<Fragment[]> {
    const scoped = projectId !== undefined && projectId !== null;
    const rows = await this.db.all<FragmentRow>(
      `SELECT * FROM fragments
        WHERE deleted_at IS NULL AND TRIM(text) <> ''
          ${scoped ? "AND project_id = ?" : ""}
        ORDER BY created_at ASC`,
      scoped ? [projectId] : [],
    );
    return this.hydrateAll(rows);
  }

  /**
   * Full-text search over the user's own writing.
   *
   * The query is escaped into a quoted FTS5 phrase. FTS5 has its own expression
   * syntax — a bare apostrophe or a stray `NEAR` from ordinary prose is a syntax
   * error, and passing raw input through would turn "don't" into a crash on a
   * search screen.
   */
  async search(query: string, limit: number = 50): Promise<Fragment[]> {
    const escaped = toFtsPhrase(query);
    if (escaped === null) return [];

    const rows = await this.db.all<FragmentRow>(
      `SELECT f.* FROM fragments_fts
         JOIN fragments f ON f.rowid = fragments_fts.rowid
        WHERE fragments_fts MATCH ?
          AND f.deleted_at IS NULL
        ORDER BY rank
        LIMIT ?`,
      [escaped, limit],
    );
    return this.hydrateAll(rows);
  }

  async fragmentsNeedingEnrichment(limit: number = 100): Promise<Fragment[]> {
    const rows = await this.db.all<FragmentRow>(
      `SELECT * FROM fragments
        WHERE deleted_at IS NULL AND TRIM(text) <> ''
          AND (enriched_at IS NULL OR embedding IS NULL)
        ORDER BY created_at DESC
        LIMIT ?`,
      [limit],
    );
    return this.hydrateAll(rows);
  }

  /** Writes back what the indexer produced. */
  async applyEnrichment(
    id: FragmentId,
    patch: { enrichment?: FragmentEnrichment; embedding?: Float32Array; embeddingModel?: string },
  ): Promise<void> {
    await this.db.transaction(async () => {
      if (patch.enrichment !== undefined) {
        const e = patch.enrichment;
        await this.db.run(
          `UPDATE fragments
              SET kind = ?, digest = ?, themes = ?, valence = ?, standalone = ?,
                  enricher_version = ?, enriched_at = ?
            WHERE id = ?`,
          [
            e.kind,
            e.digest,
            JSON.stringify(e.themes),
            e.valence,
            e.standalone,
            e.enricherVersion,
            e.enrichedAt,
            id,
          ],
        );
        await this.db.run(`DELETE FROM fragment_entities WHERE fragment_id = ?`, [id]);
        for (const entity of e.entities) {
          await this.db.run(
            `INSERT OR REPLACE INTO fragment_entities (fragment_id, entity_id, surface, kind)
             VALUES (?, ?, ?, ?)`,
            [id, entity.entityId, entity.surface, entity.kind],
          );
        }
      }
      if (patch.embedding !== undefined) {
        await this.db.run(`UPDATE fragments SET embedding = ?, embedding_model = ? WHERE id = ?`, [
          encodeVector(patch.embedding),
          patch.embeddingModel ?? "unknown",
          id,
        ]);
      }
    });
  }

  async countFragments(): Promise<{ total: number; enriched: number; words: number }> {
    const row = await this.db.first<{ total: number; enriched: number; words: number }>(
      `SELECT COUNT(*) AS total,
              SUM(CASE WHEN enriched_at IS NOT NULL THEN 1 ELSE 0 END) AS enriched,
              COALESCE(SUM(LENGTH(text) - LENGTH(REPLACE(text, ' ', '')) + 1), 0) AS words
         FROM fragments WHERE deleted_at IS NULL AND TRIM(text) <> ''`,
    );
    return { total: row?.total ?? 0, enriched: row?.enriched ?? 0, words: row?.words ?? 0 };
  }

  // -------------------------------------------------------------------------
  // Projects
  // -------------------------------------------------------------------------

  async createProject(title: string, form: WorkForm, targetWords: number): Promise<Project> {
    const now = Date.now();
    const id = asProjectId(newId(now));
    await this.db.run(
      `INSERT INTO projects (id, title, form, target_words, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [id, title, form, targetWords, now, now],
    );
    return { id, title, form, targetWords, createdAt: now, updatedAt: now, archivedAt: null };
  }

  async listProjects(): Promise<Project[]> {
    const rows = await this.db.all<{
      id: string;
      title: string;
      form: string;
      target_words: number;
      created_at: number;
      updated_at: number;
      archived_at: number | null;
    }>(`SELECT * FROM projects WHERE archived_at IS NULL ORDER BY updated_at DESC`);

    return rows.map((r) => ({
      id: asProjectId(r.id),
      title: r.title,
      form: r.form as WorkForm,
      targetWords: r.target_words,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
      archivedAt: r.archived_at,
    }));
  }

  async assignFragments(ids: readonly FragmentId[], projectId: ProjectId | null): Promise<void> {
    if (ids.length === 0) return;
    const now = Date.now();
    await this.db.transaction(async () => {
      for (const id of ids) {
        await this.db.run(
          `UPDATE fragments SET project_id = ?, updated_at = ?, dirty = 1 WHERE id = ?`,
          [projectId, now, id],
        );
      }
    });
  }

  // -------------------------------------------------------------------------
  // Compile artifacts
  // -------------------------------------------------------------------------

  async saveCompileState(
    projectId: ProjectId,
    state: { bible: unknown; outline: unknown; ledger: unknown; compiledAt: number },
  ): Promise<void> {
    await this.db.run(
      `INSERT INTO compile_state (project_id, bible, outline, ledger, compiled_at, dirty)
       VALUES (?, ?, ?, ?, ?, 1)
       ON CONFLICT(project_id) DO UPDATE SET
         bible = excluded.bible, outline = excluded.outline,
         ledger = excluded.ledger, compiled_at = excluded.compiled_at, dirty = 1`,
      [
        projectId,
        state.bible === null ? null : JSON.stringify(state.bible),
        state.outline === null ? null : JSON.stringify(state.outline),
        state.ledger === null ? null : JSON.stringify(state.ledger),
        state.compiledAt,
      ],
    );
  }

  async loadCompileState(
    projectId: ProjectId,
  ): Promise<{ bible: unknown; outline: unknown; ledger: unknown; compiledAt: number } | null> {
    const row = await this.db.first<{
      bible: string | null;
      outline: string | null;
      ledger: string | null;
      compiled_at: number;
    }>(`SELECT bible, outline, ledger, compiled_at FROM compile_state WHERE project_id = ?`, [
      projectId,
    ]);
    if (row === null) return null;
    return {
      bible: row.bible === null ? null : JSON.parse(row.bible),
      outline: row.outline === null ? null : JSON.parse(row.outline),
      ledger: row.ledger === null ? null : JSON.parse(row.ledger),
      compiledAt: row.compiled_at,
    };
  }

  /** Upserts scenes. Only the ones actually rebuilt need to be passed. */
  async saveScenes(projectId: ProjectId, scenes: readonly DraftedScene[]): Promise<void> {
    if (scenes.length === 0) return;
    await this.db.transaction(async () => {
      for (let i = 0; i < scenes.length; i++) {
        const s = scenes[i]!;
        await this.db.run(
          `INSERT INTO scenes (scene_id, project_id, chapter_id, reading_order, prose, word_count,
                               content_hash, passes, used_fragments, model, cost_usd, drafted_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(scene_id) DO UPDATE SET
             chapter_id = excluded.chapter_id, reading_order = excluded.reading_order,
             prose = excluded.prose, word_count = excluded.word_count,
             content_hash = excluded.content_hash, passes = excluded.passes,
             used_fragments = excluded.used_fragments, model = excluded.model,
             cost_usd = excluded.cost_usd, drafted_at = excluded.drafted_at`,
          [
            s.sceneId,
            projectId,
            s.chapterId,
            i,
            s.prose,
            s.wordCount,
            s.contentHash,
            JSON.stringify(s.passes),
            JSON.stringify(s.usedFragments),
            s.model,
            s.costUsd,
            s.draftedAt,
          ],
        );
      }
    });
  }

  async loadScenes(projectId: ProjectId): Promise<DraftedScene[]> {
    const rows = await this.db.all<{
      scene_id: string;
      chapter_id: string;
      prose: string;
      word_count: number;
      content_hash: string;
      passes: string;
      used_fragments: string;
      model: string;
      cost_usd: number;
      drafted_at: number;
    }>(`SELECT * FROM scenes WHERE project_id = ? ORDER BY reading_order ASC`, [projectId]);

    return rows.map((r) => ({
      sceneId: asSceneId(r.scene_id),
      chapterId: asChapterId(r.chapter_id),
      prose: r.prose,
      wordCount: r.word_count,
      contentHash: r.content_hash,
      passes: safeParse<PassName[]>(r.passes, []),
      usedFragments: safeParse<FragmentId[]>(r.used_fragments, []),
      model: r.model,
      costUsd: r.cost_usd,
      draftedAt: r.drafted_at,
    }));
  }

  /** Removes scenes no longer present in the outline, so a shorter recompile does not leave orphans. */
  async pruneScenes(projectId: ProjectId, keep: readonly string[]): Promise<number> {
    const existing = await this.db.all<{ scene_id: string }>(
      `SELECT scene_id FROM scenes WHERE project_id = ?`,
      [projectId],
    );
    const keepSet = new Set(keep);
    const doomed = existing.filter((r) => !keepSet.has(r.scene_id));

    await this.db.transaction(async () => {
      for (const row of doomed) {
        await this.db.run(`DELETE FROM scenes WHERE scene_id = ?`, [row.scene_id]);
      }
    });
    return doomed.length;
  }

  // -------------------------------------------------------------------------
  // Sync outbox
  // -------------------------------------------------------------------------

  private async enqueueSync(entity: string, entityId: string, op: string): Promise<void> {
    await this.db.run(
      `INSERT INTO sync_outbox (entity, entity_id, op, created_at) VALUES (?, ?, ?, ?)`,
      [entity, entityId, op, Date.now()],
    );
  }

  async pendingSync(limit: number = 500): Promise<
    { seq: number; entity: string; entityId: string; op: string; createdAt: number }[]
  > {
    const rows = await this.db.all<{
      seq: number;
      entity: string;
      entity_id: string;
      op: string;
      created_at: number;
    }>(`SELECT * FROM sync_outbox ORDER BY seq ASC LIMIT ?`, [limit]);

    return rows.map((r) => ({
      seq: r.seq,
      entity: r.entity,
      entityId: r.entity_id,
      op: r.op,
      createdAt: r.created_at,
    }));
  }

  async clearSynced(upToSeq: number): Promise<void> {
    await this.db.run(`DELETE FROM sync_outbox WHERE seq <= ?`, [upToSeq]);
  }

  // -------------------------------------------------------------------------

  private async hydrateAll(rows: readonly FragmentRow[]): Promise<Fragment[]> {
    if (rows.length === 0) return [];

    // One query for every row's entities rather than N — this runs on the
    // capture feed, which must stay snappy with thousands of fragments.
    const placeholders = rows.map(() => "?").join(",");
    const entities = await this.db.all<EntityRow>(
      `SELECT * FROM fragment_entities WHERE fragment_id IN (${placeholders})`,
      rows.map((r) => r.id),
    );

    const byFragment = new Map<string, EntityRow[]>();
    for (const e of entities) {
      const list = byFragment.get(e.fragment_id);
      if (list) list.push(e);
      else byFragment.set(e.fragment_id, [e]);
    }
    return rows.map((r) => hydrate(r, byFragment.get(r.id) ?? []));
  }
}

function hydrate(row: FragmentRow, entities: readonly EntityRow[]): Fragment {
  const enriched =
    row.enriched_at !== null && row.kind !== null && row.digest !== null
      ? {
          kind: row.kind as FragmentEnrichment["kind"],
          digest: row.digest,
          entities: entities.map((e) => ({
            entityId: asEntityId(e.entity_id),
            surface: e.surface,
            kind: e.kind as "person" | "place" | "object" | "organisation" | "event",
          })),
          themes: safeParse<string[]>(row.themes, []),
          valence: row.valence ?? 0,
          standalone: row.standalone ?? 0.5,
          enricherVersion: row.enricher_version ?? "unknown",
          enrichedAt: row.enriched_at,
        }
      : null;

  return {
    id: asFragmentId(row.id),
    projectId: row.project_id === null ? null : asProjectId(row.project_id),
    text: row.text,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    source: row.source as CaptureSource,
    deletedAt: row.deleted_at,
    pinned: row.pinned === 1,
    enrichment: enriched,
    embedding: row.embedding === null ? null : decodeVector(row.embedding),
  };
}

function safeParse<T>(json: string | null, fallback: T): T {
  if (json === null) return fallback;
  try {
    return JSON.parse(json) as T;
  } catch {
    return fallback;
  }
}

/**
 * Turns free text into a safe FTS5 phrase query.
 *
 * FTS5 `MATCH` takes an expression language, not a string. Apostrophes, quotes
 * and its own operators (`AND`, `OR`, `NOT`, `NEAR`, `*`, `^`, `:`) all appear in
 * ordinary English prose, and passing them through raw turns a search for
 * "don't wait" into a syntax error on the user's search screen. Quoting each
 * token as a phrase and doubling internal quotes makes every input literal.
 */
export function toFtsPhrase(query: string): string | null {
  const tokens = query
    .replace(/[^\p{L}\p{N}\s'-]/gu, " ")
    .split(/\s+/)
    .map((t) => t.trim())
    .filter((t) => t.length > 0);

  if (tokens.length === 0) return null;
  return tokens.map((t) => `"${t.replace(/"/g, '""')}"`).join(" ");
}
