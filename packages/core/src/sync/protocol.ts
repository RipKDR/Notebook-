import type { CaptureSource } from "../types/fragment.js";
import type { WorkForm } from "../types/bible.js";

/**
 * The sync wire protocol.
 *
 * It lives in core because the phone and the worker have to agree about it
 * exactly, and a protocol defined twice is a protocol that will disagree at the
 * worst possible moment — over someone's only copy of their writing.
 *
 * Three decisions shape it.
 *
 * **The source syncs; the build artifact does not.** The notebook is source code
 * and the book is what the compiler produced from it. Fragments and projects go
 * over the wire; Bibles, outlines and manuscripts do not, because they can be
 * rebuilt from the source on any device that has it — and shipping a hundred
 * thousand words of derived prose to a phone on a train to save a recompile is
 * the wrong trade.
 *
 * **The cursor is a sequence number, not a timestamp.** "Everything since
 * 14:32" is wrong under clock skew, wrong when two writes share a millisecond,
 * and unfixable once a device has skipped a record. A server-assigned monotonic
 * integer is exact.
 *
 * **A conflict never destroys text.** Writes are optimistically concurrent: the
 * client sends the revision it last saw, and the server rejects a write whose
 * base is stale. The losing text is handed back rather than dropped, so the
 * client can keep it. For a product whose whole claim is that the user's writing
 * is theirs, silently overwriting a paragraph is the one unacceptable failure.
 */

export const SYNC_PROTOCOL_VERSION = 1;

/** The maximum records a client may push, or the server return, in one round trip. */
export const SYNC_PAGE_LIMIT = 500;

/**
 * A fragment, as it travels.
 *
 * Enrichment and embeddings are deliberately absent. They are derived, an
 * embedding is 4KB per fragment, and the worker can regenerate anything missing.
 * A restored device re-indexes through `/v1/enrich` rather than downloading
 * megabytes of vectors it could recompute.
 */
export interface SyncFragment {
  readonly id: string;
  readonly projectId: string | null;
  readonly text: string;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly source: CaptureSource;
  /** Soft deletes travel as tombstones. The pipeline never hard-deletes writing. */
  readonly deletedAt: number | null;
  readonly pinned: boolean;
}

export interface SyncProject {
  readonly id: string;
  readonly title: string;
  readonly form: WorkForm;
  readonly targetWords: number;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly archivedAt: number | null;
}

/** One record the client is pushing, with the revision it is editing from. */
export interface SyncPush<T> {
  readonly record: T;
  /**
   * The `rev` this device last received for this record, or null if it has never
   * seen a server copy. The server rejects a write whose base is stale, which is
   * what turns "last writer wins" into "nobody's paragraph disappears".
   */
  readonly baseRev: number | null;
}

export interface SyncRequest {
  readonly protocol: number;
  /** Server sequence this device has already applied. Null on a first sync. */
  readonly since: number | null;
  readonly fragments: readonly SyncPush<SyncFragment>[];
  readonly projects: readonly SyncPush<SyncProject>[];
  /** How many records to return. Clamped server-side. */
  readonly limit?: number;
}

/** A record as the server holds it. */
export interface SyncRecord<T> {
  readonly record: T;
  readonly rev: number;
  readonly seq: number;
}

/**
 * A push the server refused because the record moved underneath it.
 *
 * `current` is what the server holds and the client must adopt. `rejected` is
 * what the client tried to write and must not lose: where the two texts differ,
 * the client keeps its own as a new fragment rather than throwing it away.
 */
export interface SyncConflict<T> {
  readonly id: string;
  readonly rejected: T;
  readonly current: SyncRecord<T>;
}

export interface SyncResponse {
  readonly protocol: number;
  /** Feed this back as `since` next time. */
  readonly cursor: number;
  /** True when more records are waiting past `cursor`; call again immediately. */
  readonly hasMore: boolean;
  readonly fragments: readonly SyncRecord<SyncFragment>[];
  readonly projects: readonly SyncRecord<SyncProject>[];
  /** Revisions assigned to the pushes that were accepted, keyed by record id. */
  readonly accepted: Readonly<Record<string, number>>;
  readonly conflicts: {
    readonly fragments: readonly SyncConflict<SyncFragment>[];
    readonly projects: readonly SyncConflict<SyncProject>[];
  };
}

/**
 * Whether two versions of a fragment differ in a way worth preserving.
 *
 * A stale base revision is not by itself a conflict: two devices that captured
 * the same note, or one that retried a push whose response was lost, produce
 * identical text. Forking a copy in that case leaves the user with duplicates of
 * their own notes and teaches them the sync is unreliable. Only the words and
 * the tombstone matter for conflict copies; metadata such as pinned/project can
 * be merged server-side without forking a duplicate note.
 */
export function fragmentsDiffer(a: SyncFragment, b: SyncFragment): boolean {
  return a.text !== b.text || (a.deletedAt === null) !== (b.deletedAt === null);
}

/**
 * Picks the winner between two versions of a record.
 *
 * Last write wins on `updatedAt`, with the id as a tiebreak so that two devices
 * resolving the same tie independently reach the same answer. Without the
 * tiebreak, two phones can each decide they won and push forever.
 */
export function laterOf<T extends { id: string; updatedAt: number }>(a: T, b: T): T {
  if (a.updatedAt !== b.updatedAt) return a.updatedAt > b.updatedAt ? a : b;
  return a.id >= b.id ? a : b;
}

/** The marker a conflict copy carries, so the user can see why they have two. */
export const CONFLICT_SUFFIX = "\n\n---\nConflicting version from another device.";
