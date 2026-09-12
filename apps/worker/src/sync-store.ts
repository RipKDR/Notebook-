import { DatabaseSync } from "node:sqlite";
import {
  SYNC_PAGE_LIMIT,
  fragmentsDiffer,
  type SyncConflict,
  type SyncFragment,
  type SyncProject,
  type SyncPush,
  type SyncRecord,
} from "@loom/core";

/**
 * The server side of sync.
 *
 * It holds the notebook, not the book. Fragments and projects are the source the
 * user typed and cannot be regenerated; Bibles, outlines and manuscripts are
 * build output and are left on the device that compiled them.
 *
 * Records carry a per-account `seq` from a single monotonic counter, which is
 * what a client pages through. A timestamp cursor would be wrong under clock
 * skew, wrong when two writes share a millisecond, and unrecoverable once a
 * device had skipped a record.
 *
 * The counter is per account and allocated inside the same transaction as the
 * write, so no client can observe a gap or a record out of order.
 */

interface Row {
  id: string;
  payload: string;
  rev: number;
  seq: number;
  updated_at: number;
}

export interface ApplyResult<T> {
  readonly accepted: Record<string, number>;
  readonly conflicts: SyncConflict<T>[];
}

export class SyncStore {
  constructor(private readonly db: DatabaseSync) {
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = NORMAL;
      PRAGMA busy_timeout = 5000;

      CREATE TABLE IF NOT EXISTS sync_fragments (
        account    TEXT NOT NULL,
        id         TEXT NOT NULL,
        payload    TEXT NOT NULL,
        rev        INTEGER NOT NULL DEFAULT 1,
        seq        INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (account, id)
      );
      CREATE INDEX IF NOT EXISTS sync_fragments_seq ON sync_fragments(account, seq);

      CREATE TABLE IF NOT EXISTS sync_projects (
        account    TEXT NOT NULL,
        id         TEXT NOT NULL,
        payload    TEXT NOT NULL,
        rev        INTEGER NOT NULL DEFAULT 1,
        seq        INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (account, id)
      );
      CREATE INDEX IF NOT EXISTS sync_projects_seq ON sync_projects(account, seq);

      -- One counter per account. Sequence numbers are the client's cursor, so
      -- they must never repeat and never go backwards.
      CREATE TABLE IF NOT EXISTS sync_cursor (
        account TEXT PRIMARY KEY,
        seq     INTEGER NOT NULL DEFAULT 0
      );
    `);
  }

  static open(path: string = ":memory:"): SyncStore {
    return new SyncStore(new DatabaseSync(path));
  }

  /**
   * Applies a batch of pushes and returns everything the client has not seen,
   * as one transaction.
   *
   * Push and pull share a transaction so the cursor a client is handed provably
   * includes its own writes. Splitting them lets a device push a note and then
   * pull a cursor that predates it, which silently drops the note on the next
   * round trip.
   */
  sync(
    account: string,
    request: {
      since: number | null;
      fragments: readonly SyncPush<SyncFragment>[];
      projects: readonly SyncPush<SyncProject>[];
      limit?: number;
    },
  ): {
    cursor: number;
    hasMore: boolean;
    fragments: SyncRecord<SyncFragment>[];
    projects: SyncRecord<SyncProject>[];
    accepted: Record<string, number>;
    conflicts: {
      fragments: SyncConflict<SyncFragment>[];
      projects: SyncConflict<SyncProject>[];
    };
  } {
    const limit = Math.min(Math.max(1, request.limit ?? SYNC_PAGE_LIMIT), SYNC_PAGE_LIMIT);
    const since = request.since ?? 0;

    this.db.exec("BEGIN IMMEDIATE");
    try {
      const projectResult = this.applyPushes(
        account,
        "sync_projects",
        request.projects,
        projectsDiffer,
      );
      const fragmentResult = this.applyPushes(
        account,
        "sync_fragments",
        request.fragments,
        fragmentsDiffer,
      );

      // Read back after writing, so a client's own pushes are inside the page it
      // is handed and its cursor is never behind its own work.
      const fragments = this.read<SyncFragment>(account, "sync_fragments", since, limit + 1);
      const projects = this.read<SyncProject>(account, "sync_projects", since, limit + 1);

      const hasMore = fragments.length > limit || projects.length > limit;

      // Both lists are cut at one shared sequence boundary rather than each at
      // its own count.
      //
      // Sequence numbers come from a single per-account counter, and a project
      // necessarily exists before a fragment can be assigned to it — so the
      // project's sequence is always lower. Cutting at one boundary therefore
      // guarantees that a fragment never arrives on a device before the project
      // it points at, which is otherwise a foreign key violation on the
      // receiving end and a sync that stops dead.
      const boundary = hasMore
        ? Math.min(
            ...[
              fragments.length > limit ? fragments[limit - 1]!.seq : Number.POSITIVE_INFINITY,
              projects.length > limit ? projects[limit - 1]!.seq : Number.POSITIVE_INFINITY,
            ],
          )
        : Number.POSITIVE_INFINITY;

      const page = {
        fragments: fragments.filter((r) => r.seq <= boundary).slice(0, limit),
        projects: projects.filter((r) => r.seq <= boundary).slice(0, limit),
      };

      // The cursor advances only as far as what was actually handed over. Moving
      // it to the account's head while truncating a page is how records are
      // skipped and never seen again.
      const cursor = hasMore ? Math.max(since, boundary) : this.head(account);

      this.db.exec("COMMIT");

      return {
        cursor,
        hasMore,
        ...page,
        accepted: { ...fragmentResult.accepted, ...projectResult.accepted },
        conflicts: { fragments: fragmentResult.conflicts, projects: projectResult.conflicts },
      };
    } catch (err: unknown) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }

  /** The account's current head. A client at this cursor is fully caught up. */
  head(account: string): number {
    const row = this.db.prepare(`SELECT seq FROM sync_cursor WHERE account = ?`).get(account) as
      | { seq: number }
      | undefined;
    return Number(row?.seq ?? 0);
  }

  counts(account: string): { fragments: number; projects: number } {
    const count = (table: string): number => {
      const row = this.db
        .prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE account = ?`)
        .get(account) as { n: number } | undefined;
      return Number(row?.n ?? 0);
    };
    return { fragments: count("sync_fragments"), projects: count("sync_projects") };
  }

  /** Removes everything an account holds. Used when a user asks to stop syncing. */
  forget(account: string): void {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      for (const table of ["sync_fragments", "sync_projects", "sync_cursor"]) {
        this.db.prepare(`DELETE FROM ${table} WHERE account = ?`).run(account);
      }
      this.db.exec("COMMIT");
    } catch (err: unknown) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }

  close(): void {
    this.db.close();
  }

  // -------------------------------------------------------------------------

  private nextSeq(account: string): number {
    this.db
      .prepare(
        `INSERT INTO sync_cursor (account, seq) VALUES (?, 1)
         ON CONFLICT(account) DO UPDATE SET seq = seq + 1`,
      )
      .run(account);
    return this.head(account);
  }

  private applyPushes<T extends { id: string; updatedAt: number }>(
    account: string,
    table: string,
    pushes: readonly SyncPush<T>[],
    differs: (a: T, b: T) => boolean,
  ): ApplyResult<T> {
    const accepted: Record<string, number> = {};
    const conflicts: SyncConflict<T>[] = [];

    for (const push of pushes) {
      const existing = this.db
        .prepare(`SELECT * FROM ${table} WHERE account = ? AND id = ?`)
        .get(account, push.record.id) as Row | undefined;

      if (existing === undefined) {
        // New to the server. A stale baseRev here means the record was deleted
        // server-side, which we do not do — so treat it as an insert either way
        // rather than refusing a note the user can see on their phone.
        const seq = this.nextSeq(account);
        this.db
          .prepare(
            `INSERT INTO ${table} (account, id, payload, rev, seq, updated_at)
             VALUES (?, ?, ?, 1, ?, ?)`,
          )
          .run(account, push.record.id, JSON.stringify(push.record), seq, push.record.updatedAt);
        accepted[push.record.id] = 1;
        continue;
      }

      const current = JSON.parse(existing.payload) as T;
      const rev = Number(existing.rev);

      if (push.baseRev === rev) {
        // The client edited the version the server still holds. No contest.
        this.write(account, table, push.record, rev + 1);
        accepted[push.record.id] = rev + 1;
        continue;
      }

      // The record moved underneath this client.
      if (!differs(push.record, current)) {
        // Same words. A retried push, or two devices that captured the same
        // note. Forking a copy here would leave the user with duplicates of
        // their own writing and teach them the sync is unreliable.
        if (table === "sync_fragments") {
          const merged = mergeFragmentMetadata(current as SyncFragment, push.record as SyncFragment);
          if (
            merged.projectId !== (current as SyncFragment).projectId ||
            merged.pinned !== (current as SyncFragment).pinned
          ) {
            this.write(account, table, merged as T, rev + 1);
            accepted[push.record.id] = rev + 1;
          } else {
            accepted[push.record.id] = rev;
          }
        } else {
          accepted[push.record.id] = rev;
        }
        continue;
      }

      // A genuine conflict. The server's copy stands so that every device
      // converges, and the rejected text goes back to its author to keep. The
      // one thing we will not do is overwrite a paragraph in silence.
      conflicts.push({
        id: push.record.id,
        rejected: push.record,
        current: { record: current, rev, seq: Number(existing.seq) },
      });
    }

    function mergeFragmentMetadata(current: SyncFragment, pushed: SyncFragment): SyncFragment {
      if (pushed.updatedAt <= current.updatedAt) return current;
      if (current.projectId !== pushed.projectId && current.pinned !== pushed.pinned) return current;
      const projectId =
        current.projectId === pushed.projectId ? current.projectId : pushed.projectId;
      const pinned = current.pinned === pushed.pinned ? current.pinned : pushed.pinned;
      if (projectId === current.projectId && pinned === current.pinned) return current;
      return {
        ...current,
        projectId,
        pinned,
        updatedAt: Math.max(current.updatedAt, pushed.updatedAt),
      };
    }

    return { accepted, conflicts };
  }

  private write<T extends { id: string; updatedAt: number }>(
    account: string,
    table: string,
    record: T,
    rev: number,
  ): void {
    const seq = this.nextSeq(account);
    this.db
      .prepare(
        `UPDATE ${table} SET payload = ?, rev = ?, seq = ?, updated_at = ?
          WHERE account = ? AND id = ?`,
      )
      .run(JSON.stringify(record), rev, seq, record.updatedAt, account, record.id);
  }

  private read<T>(
    account: string,
    table: string,
    since: number,
    limit: number,
  ): SyncRecord<T>[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM ${table} WHERE account = ? AND seq > ? ORDER BY seq ASC LIMIT ?`,
      )
      .all(account, since, limit) as unknown as Row[];

    return rows.map((row) => ({
      record: JSON.parse(row.payload) as T,
      rev: Number(row.rev),
      seq: Number(row.seq),
    }));
  }
}

/**
 * Projects conflict only on the things a person chose.
 *
 * A title or a target length is worth asking about; `updatedAt` moving is not,
 * and neither is an archive flag that both devices agree on.
 */
function projectsDiffer(a: SyncProject, b: SyncProject): boolean {
  return (
    a.title !== b.title ||
    a.form !== b.form ||
    a.targetWords !== b.targetWords ||
    (a.archivedAt === null) !== (b.archivedAt === null)
  );
}
