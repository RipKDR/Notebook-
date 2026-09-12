import {
  CONFLICT_SUFFIX,
  SYNC_PAGE_LIMIT,
  SYNC_PROTOCOL_VERSION,
  type SyncFragment,
  type SyncProject,
  type SyncRequest,
  type SyncResponse,
} from "./protocol.js";

/**
 * The client half of sync, as an algorithm rather than a screen.
 *
 * It is here, behind two injected ports, for the same reason `compile()` takes
 * an `LlmLike`: the interesting failures are in the merge, not in the HTTP, and
 * a merge that can only be exercised through a phone is a merge nobody tests.
 * The one thing this code must never do is lose a word the user typed, and that
 * is a property you have to be able to assert.
 */

/** What the local database has to provide. Implemented by `@loom/db`. */
export interface SyncLocal {
  dirtyFragments(limit?: number): Promise<
    { fragment: LocalFragment; baseRev: number | null; localRev: number }[]
  >;
  dirtyProjects(limit?: number): Promise<
    { project: LocalProject; baseRev: number | null; localRev: number }[]
  >;
  markSynced(
    entity: "fragments" | "projects",
    acked: readonly { id: string; rev: number; localRev: number }[],
  ): Promise<void>;
  applyRemoteFragments(
    incoming: readonly { record: SyncFragment; rev: number }[],
  ): Promise<{ applied: number; skipped: number }>;
  applyRemoteProjects(
    incoming: readonly { record: SyncProject; rev: number }[],
  ): Promise<{ applied: number; skipped: number }>;
  saveConflictCopy(original: SyncFragment, marker: string): Promise<unknown>;
  syncState(): Promise<{ cursor: number; lastSyncedAt: number | null; lastError: string | null }>;
  setSyncCursor(cursor: number, error?: string | null): Promise<void>;
}

/** The fields of a local fragment that travel. */
export interface LocalFragment {
  readonly id: string;
  readonly projectId: string | null;
  readonly text: string;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly source: SyncFragment["source"];
  readonly deletedAt: number | null;
  readonly pinned: boolean;
}

export interface LocalProject {
  readonly id: string;
  readonly title: string;
  readonly form: SyncProject["form"];
  readonly targetWords: number;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly archivedAt: number | null;
}

/** One round trip to the server. Implemented over `fetch` in the app. */
export type SyncTransport = (request: SyncRequest) => Promise<SyncResponse>;

export interface SyncOutcome {
  readonly pushed: number;
  readonly pulled: number;
  /** Records the server sent that a local unsent edit took precedence over. */
  readonly deferred: number;
  readonly conflicts: number;
  readonly cursor: number;
  readonly hasMore: boolean;
}

export const emptyOutcome: SyncOutcome = {
  pushed: 0,
  pulled: 0,
  deferred: 0,
  conflicts: 0,
  cursor: 0,
  hasMore: false,
};

export interface SyncOptions {
  readonly local: SyncLocal;
  readonly transport: SyncTransport;
  /** Records per round trip. Kept small enough to survive a phone connection. */
  readonly batchSize?: number;
  /** Cap on round trips, so a first sync of a large notebook cannot loop for ever. */
  readonly maxRounds?: number;
  readonly onProgress?: (outcome: SyncOutcome) => void;
  readonly signal?: AbortSignal;
}

/**
 * Runs sync until the device is caught up.
 *
 * Each round pushes what changed here and applies what changed there. It stops
 * when the server reports nothing further and this device has nothing left to
 * send — or when the round cap is hit, which is reported rather than hidden, so
 * a notebook that is not converging is visible instead of silently half-synced.
 */
export async function sync(opts: SyncOptions): Promise<SyncOutcome> {
  const maxRounds = opts.maxRounds ?? 50;
  let total: SyncOutcome = { ...emptyOutcome, cursor: (await opts.local.syncState()).cursor };

  for (let round = 0; round < maxRounds; round++) {
    if (opts.signal?.aborted === true) break;

    const outcome = await syncOnce(opts);
    total = {
      pushed: total.pushed + outcome.pushed,
      pulled: total.pulled + outcome.pulled,
      deferred: total.deferred + outcome.deferred,
      conflicts: total.conflicts + outcome.conflicts,
      cursor: outcome.cursor,
      hasMore: outcome.hasMore,
    };
    opts.onProgress?.(total);

    // Nothing came down, nothing went up, and the server says there is no more.
    // A further round would be an identical empty request.
    const idle = outcome.pushed === 0 && outcome.pulled === 0 && outcome.conflicts === 0;
    if (!outcome.hasMore && idle) return total;
  }

  return total;
}

/**
 * One round trip.
 *
 * The order matters. The cursor is advanced only after everything in the
 * response has been written locally: a cursor saved first, then a crash, means
 * those records are never requested again and the device is permanently missing
 * notes it will never know about.
 */
export async function syncOnce(opts: SyncOptions): Promise<SyncOutcome> {
  const { local, transport } = opts;
  const batchSize = Math.min(opts.batchSize ?? SYNC_PAGE_LIMIT, SYNC_PAGE_LIMIT);

  const state = await local.syncState();
  const dirtyFragments = await local.dirtyFragments(batchSize);
  const dirtyProjects = await local.dirtyProjects(batchSize);

  const localRevs = new Map<string, number>();
  for (const d of dirtyFragments) localRevs.set(d.fragment.id, d.localRev);
  for (const d of dirtyProjects) localRevs.set(d.project.id, d.localRev);

  const response = await transport({
    protocol: SYNC_PROTOCOL_VERSION,
    since: state.cursor === 0 ? null : state.cursor,
    fragments: dirtyFragments.map((d) => ({
      record: toSyncFragment(d.fragment),
      baseRev: d.baseRev,
    })),
    projects: dirtyProjects.map((d) => ({
      record: toSyncProject(d.project),
      baseRev: d.baseRev,
    })),
    limit: batchSize,
  });

  // 1. Record what the server accepted, so those rows stop being pushed.
  const ackFragments = dirtyFragments
    .filter((d) => response.accepted[d.fragment.id] !== undefined)
    .map((d) => ({
      id: d.fragment.id,
      rev: response.accepted[d.fragment.id]!,
      localRev: d.localRev,
    }));
  const ackProjects = dirtyProjects
    .filter((d) => response.accepted[d.project.id] !== undefined)
    .map((d) => ({
      id: d.project.id,
      rev: response.accepted[d.project.id]!,
      localRev: d.localRev,
    }));

  await local.markSynced("fragments", ackFragments);
  await local.markSynced("projects", ackProjects);

  // 2. Keep the text the server refused, before anything can overwrite it.
  //
  // This is the step that makes a conflict survivable. The server's copy is
  // about to be written over the local row, so the rejected version has to be
  // somewhere else first — otherwise a paragraph the user wrote disappears
  // between two statements.
  // A rejected project is not treated this way: a title and a target length are
  // not writing, so the server's version simply stands.
  for (const conflict of response.conflicts.fragments) {
    await local.saveConflictCopy(conflict.rejected, CONFLICT_SUFFIX);
  }

  // 3. Adopt the server's version of every conflicted record, so that all
  //    devices converge on one answer rather than arguing indefinitely.
  const conflicted = [
    ...response.conflicts.fragments.map((c) => ({ record: c.current.record, rev: c.current.rev })),
  ];
  const conflictedProjects = response.conflicts.projects.map((c) => ({
    record: c.current.record,
    rev: c.current.rev,
  }));

  // The local rows are still dirty, so `applyRemote*` would skip them. Clearing
  // the flag first is what lets the server's copy land.
  await local.markSynced(
    "fragments",
    response.conflicts.fragments.map((c) => ({
      id: c.id,
      rev: c.current.rev,
      localRev: localRevs.get(c.id) ?? 0,
    })),
  );
  await local.markSynced(
    "projects",
    response.conflicts.projects.map((c) => ({
      id: c.id,
      rev: c.current.rev,
      localRev: localRevs.get(c.id) ?? 0,
    })),
  );

  // 4. Write what the server sent, minus this device's own echo.
  //
  // A push comes back in the same page, because the response is read after the
  // write so the cursor cannot predate it. Applying those records again is not
  // merely wasted work: writing a fragment clears the enrichment derived from
  // its text, so a device would re-index — and pay to re-index — every note it
  // had just uploaded.
  const echoed = (id: string, rev: number): boolean => response.accepted[id] === rev;

  // Projects first: a fragment carries the id of the book it belongs to, and
  // that book has to exist locally before the fragment referencing it can be
  // inserted. Getting this order wrong does not corrupt anything; it raises a
  // foreign key error and stops the sync dead, on the one device that was
  // trying to catch up.
  const projects = await local.applyRemoteProjects([
    ...conflictedProjects,
    ...response.projects
      .filter((r) => !echoed(r.record.id, r.rev))
      .map((r) => ({ record: r.record, rev: r.rev })),
  ]);
  const fragments = await local.applyRemoteFragments([
    ...conflicted,
    ...response.fragments
      .filter((r) => !echoed(r.record.id, r.rev))
      .map((r) => ({ record: r.record, rev: r.rev })),
  ]);

  // 5. Only now is it safe to say this device has seen up to `cursor`.
  await local.setSyncCursor(response.cursor, null);

  return {
    pushed: ackFragments.length + ackProjects.length,
    pulled: fragments.applied + projects.applied,
    deferred: fragments.skipped + projects.skipped,
    conflicts: response.conflicts.fragments.length + response.conflicts.projects.length,
    cursor: response.cursor,
    hasMore: response.hasMore || fragments.skipped + projects.skipped > 0,
  };
}

export function toSyncFragment(f: LocalFragment): SyncFragment {
  return {
    id: f.id,
    projectId: f.projectId,
    text: f.text,
    createdAt: f.createdAt,
    updatedAt: f.updatedAt,
    source: f.source,
    deletedAt: f.deletedAt,
    pinned: f.pinned,
  };
}

export function toSyncProject(p: LocalProject): SyncProject {
  return {
    id: p.id,
    title: p.title,
    form: p.form,
    targetWords: p.targetWords,
    createdAt: p.createdAt,
    updatedAt: p.updatedAt,
    archivedAt: p.archivedAt,
  };
}
