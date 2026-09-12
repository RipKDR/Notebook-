import { describe, expect, it } from "vitest";
import { SyncStore } from "../src/sync-store.js";
import type { SyncFragment, SyncProject, SyncPush } from "@loom/core";

/**
 * Sync holds someone's only copy of their writing, so the properties worth
 * testing are the destructive ones: can a cursor skip a record, can a push
 * overwrite a paragraph, can one account see another's notes.
 */

const ACCOUNT = "acct-1";

function fragment(id: string, text: string, updatedAt = 1000): SyncFragment {
  return {
    id,
    projectId: null,
    text,
    createdAt: 1000,
    updatedAt,
    source: "quick",
    deletedAt: null,
    pinned: false,
  };
}

function project(id: string, title: string, updatedAt = 1000): SyncProject {
  return {
    id,
    title,
    form: "memoir",
    targetWords: 40_000,
    createdAt: 1000,
    updatedAt,
    archivedAt: null,
  };
}

const push = <T>(record: T, baseRev: number | null = null): SyncPush<T> => ({ record, baseRev });

const empty = { fragments: [], projects: [] } as const;

/** Pushes fragments and returns the whole response. */
function send(
  store: SyncStore,
  opts: {
    account?: string;
    since?: number | null;
    fragments?: SyncPush<SyncFragment>[];
    projects?: SyncPush<SyncProject>[];
    limit?: number;
  } = {},
) {
  return store.sync(opts.account ?? ACCOUNT, {
    since: opts.since ?? null,
    fragments: opts.fragments ?? [],
    projects: opts.projects ?? [],
    ...(opts.limit !== undefined ? { limit: opts.limit } : {}),
  });
}

describe("pushing", () => {
  it("accepts a new fragment and assigns it revision 1", () => {
    const store = SyncStore.open();
    const result = send(store, { fragments: [push(fragment("f1", "a note"))] });

    expect(result.accepted).toEqual({ f1: 1 });
    expect(result.conflicts.fragments).toHaveLength(0);
    store.close();
  });

  it("hands a client its own push back in the same round trip", () => {
    // Push and pull share a transaction so the cursor a client is handed
    // provably includes its own writes. Otherwise a device pushes a note, pulls
    // a cursor that predates it, and the note is never seen again.
    const store = SyncStore.open();
    const result = send(store, { fragments: [push(fragment("f1", "a note"))] });

    expect(result.fragments.map((r) => r.record.id)).toEqual(["f1"]);
    expect(result.cursor).toBeGreaterThanOrEqual(result.fragments[0]!.seq);
    store.close();
  });

  it("accepts an edit made from the revision the server still holds", () => {
    const store = SyncStore.open();
    send(store, { fragments: [push(fragment("f1", "first"))] });

    const second = send(store, { fragments: [push(fragment("f1", "second", 2000), 1)] });
    expect(second.accepted).toEqual({ f1: 2 });
    expect(second.conflicts.fragments).toHaveLength(0);
    expect(second.fragments.at(-1)?.record.text).toBe("second");
    store.close();
  });

  it("carries a tombstone rather than removing the row", () => {
    const store = SyncStore.open();
    send(store, { fragments: [push(fragment("f1", "a note"))] });
    send(store, {
      fragments: [push({ ...fragment("f1", "a note", 2000), deletedAt: 2000 }, 1)],
    });

    const pulled = send(store, { since: 0 });
    expect(pulled.fragments).toHaveLength(1);
    expect(pulled.fragments[0]?.record.deletedAt).toBe(2000);
    store.close();
  });
});

describe("conflicts", () => {
  it("refuses a write from a stale revision and hands the text back", () => {
    const store = SyncStore.open();
    send(store, { fragments: [push(fragment("f1", "original"))] });
    // Device A edits.
    send(store, { fragments: [push(fragment("f1", "A's version", 2000), 1)] });
    // Device B was offline and still thinks it is on revision 1.
    const b = send(store, { fragments: [push(fragment("f1", "B's version", 2500), 1)] });

    expect(b.accepted.f1).toBeUndefined();
    expect(b.conflicts.fragments).toHaveLength(1);

    const conflict = b.conflicts.fragments[0]!;
    // The server's copy stands, so every device converges on one answer...
    expect(conflict.current.record.text).toBe("A's version");
    expect(conflict.current.rev).toBe(2);
    // ...and B's words come back rather than disappearing. This is the whole
    // point: overwriting someone's paragraph in silence is the one failure this
    // product cannot have.
    expect(conflict.rejected.text).toBe("B's version");
    store.close();
  });

  it("does not fork a copy when the words are the same", () => {
    // A retried push whose response was lost, or two devices that captured the
    // same note. Duplicating it would teach the user the sync is unreliable.
    const store = SyncStore.open();
    send(store, { fragments: [push(fragment("f1", "same words"))] });
    send(store, { fragments: [push(fragment("f1", "same words", 2000), 1)] });

    const stale = send(store, { fragments: [push(fragment("f1", "same words", 3000), 1)] });
    expect(stale.conflicts.fragments).toHaveLength(0);
    // It is accepted at the revision the server actually holds, not the stale
    // one the client sent. Echoing the client's base would leave that device
    // permanently behind, conflicting on every subsequent push.
    expect(stale.accepted.f1).toBe(2);
    store.close();
  });

  it("merges stale metadata-only fragment updates without forking a conflict copy", () => {
    const store = SyncStore.open();
    send(store, { fragments: [push(fragment("f1", "same words"))] });
    // Move the revision forward without changing metadata.
    send(store, { fragments: [push(fragment("f1", "same words", 2000), 1)] });

    const stale = send(store, {
      fragments: [push({ ...fragment("f1", "same words", 2500), pinned: true }, 1)],
    });
    expect(stale.conflicts.fragments).toHaveLength(0);
    expect(stale.accepted.f1).toBe(3);

    const latest = send(store, { since: 0 }).fragments.at(-1)!;
    expect(latest.record.projectId).toBeNull();
    expect(latest.record.pinned).toBe(true);
    store.close();
  });

  it("keeps current metadata when a stale retry disagrees on both metadata fields", () => {
    const store = SyncStore.open();
    send(store, { fragments: [push(fragment("f1", "same words"))] });
    send(store, {
      fragments: [push({ ...fragment("f1", "same words", 2000), projectId: "p1" }, 1)],
    });

    const stale = send(store, {
      fragments: [push({ ...fragment("f1", "same words", 2500), pinned: true }, 1)],
    });
    expect(stale.conflicts.fragments).toHaveLength(0);
    expect(stale.accepted.f1).toBe(2);
    const latest = send(store, { since: 0 }).fragments.at(-1)!;
    expect(latest.record.projectId).toBe("p1");
    expect(latest.record.pinned).toBe(false);
    store.close();
  });

  it("treats a differing tombstone as a conflict", () => {
    // One device deleted a note while another kept writing in it. That is a
    // decision only the user can make, so both survive.
    const store = SyncStore.open();
    send(store, { fragments: [push(fragment("f1", "a note"))] });
    send(store, {
      fragments: [push({ ...fragment("f1", "a note", 2000), deletedAt: 2000 }, 1)],
    });

    const keeper = send(store, { fragments: [push(fragment("f1", "a note", 2500), 1)] });
    expect(keeper.conflicts.fragments).toHaveLength(1);
    store.close();
  });

  it("does not conflict a project over a timestamp alone", () => {
    const store = SyncStore.open();
    send(store, { projects: [push(project("p1", "The Kitchen Radio"))] });
    send(store, { projects: [push(project("p1", "The Kitchen Radio", 2000), 1)] });

    const stale = send(store, { projects: [push(project("p1", "The Kitchen Radio", 3000), 1)] });
    expect(stale.conflicts.projects).toHaveLength(0);
    store.close();
  });

  it("conflicts a project when the title genuinely differs", () => {
    const store = SyncStore.open();
    send(store, { projects: [push(project("p1", "Working Title"))] });
    send(store, { projects: [push(project("p1", "The Kitchen Radio", 2000), 1)] });

    const stale = send(store, { projects: [push(project("p1", "Silences", 3000), 1)] });
    expect(stale.conflicts.projects).toHaveLength(1);
    expect(stale.conflicts.projects[0]?.current.record.title).toBe("The Kitchen Radio");
    store.close();
  });

  it("inserts rather than refusing a record the server has never seen", () => {
    // A client with a stale baseRev for a record we do not hold means our copy
    // was lost, not that the client is wrong. Refusing would strand a note the
    // user can see on their phone.
    const store = SyncStore.open();
    const result = send(store, { fragments: [push(fragment("f1", "a note"), 7)] });
    expect(result.accepted).toEqual({ f1: 1 });
    store.close();
  });
});

describe("the cursor", () => {
  it("returns only what the client has not seen", () => {
    const store = SyncStore.open();
    const first = send(store, { fragments: [push(fragment("f1", "one"))] });
    const second = send(store, {
      since: first.cursor,
      fragments: [push(fragment("f2", "two"))],
    });

    expect(second.fragments.map((r) => r.record.id)).toEqual(["f2"]);
    store.close();
  });

  it("returns nothing when the client is caught up", () => {
    const store = SyncStore.open();
    const first = send(store, { fragments: [push(fragment("f1", "one"))] });
    const again = send(store, { since: first.cursor });

    expect(again.fragments).toHaveLength(0);
    expect(again.hasMore).toBe(false);
    expect(again.cursor).toBe(first.cursor);
    store.close();
  });

  it("never advances past what it actually handed over", () => {
    // Moving the cursor to the account's head while truncating a page is how
    // records are skipped and never seen again.
    const store = SyncStore.open();
    for (let i = 0; i < 10; i++) {
      send(store, { fragments: [push(fragment(`f${i}`, `note ${i}`))] });
    }

    const page = send(store, { since: 0, limit: 3 });
    expect(page.fragments).toHaveLength(3);
    expect(page.hasMore).toBe(true);
    expect(page.cursor).toBe(page.fragments.at(-1)!.seq);
    store.close();
  });

  it("pages through everything without gaps or repeats", () => {
    const store = SyncStore.open();
    for (let i = 0; i < 25; i++) {
      send(store, { fragments: [push(fragment(`f${i}`, `note ${i}`))] });
    }

    const seen: string[] = [];
    let cursor: number | null = null;
    for (let round = 0; round < 20; round++) {
      const page = send(store, { since: cursor, limit: 4 });
      seen.push(...page.fragments.map((r) => r.record.id));
      cursor = page.cursor;
      if (!page.hasMore) break;
    }

    expect(new Set(seen).size).toBe(25);
    expect(seen).toHaveLength(25);
    store.close();
  });

  it("moves a record to the end of the queue when it is edited", () => {
    // A device that already pulled f1 must still be told about the edit.
    const store = SyncStore.open();
    send(store, { fragments: [push(fragment("f1", "one")), push(fragment("f2", "two"))] });
    const caughtUp = send(store, { since: 0 }).cursor;

    send(store, { fragments: [push(fragment("f1", "one, revised", 2000), 1)] });

    const delta = send(store, { since: caughtUp });
    expect(delta.fragments.map((r) => r.record.id)).toEqual(["f1"]);
    expect(delta.fragments[0]?.record.text).toBe("one, revised");
    store.close();
  });

  it("starts a fresh device from zero and gives it everything", () => {
    const store = SyncStore.open();
    send(store, {
      fragments: [push(fragment("f1", "one")), push(fragment("f2", "two"))],
      projects: [push(project("p1", "The Kitchen Radio"))],
    });

    const restored = send(store, { since: null });
    expect(restored.fragments).toHaveLength(2);
    expect(restored.projects).toHaveLength(1);
    store.close();
  });

  it("never delivers a fragment before the project it points at", () => {
    // Both lists are cut at one shared sequence boundary. A project always has a
    // lower sequence than any fragment assigned to it, so cutting at one point
    // guarantees the project arrives first — and a fragment that arrives before
    // its project is a foreign key error that stops a device's sync dead.
    const store = SyncStore.open();
    send(store, { projects: [push(project("p1", "A book"))] });
    for (let i = 0; i < 12; i++) {
      send(store, { fragments: [push({ ...fragment(`f${i}`, `note ${i}`), projectId: "p1" })] });
    }

    const seenProjects = new Set<string>();
    let cursor: number | null = null;
    for (let round = 0; round < 20; round++) {
      const page: ReturnType<typeof send> = send(store, { since: cursor, limit: 2 });
      for (const p of page.projects) seenProjects.add(p.record.id);
      for (const f of page.fragments) {
        expect(f.record.projectId === null || seenProjects.has(f.record.projectId)).toBe(true);
      }
      cursor = page.cursor;
      if (!page.hasMore) break;
    }
    store.close();
  });

  it("clamps an oversized page request", () => {
    const store = SyncStore.open();
    expect(() => send(store, { limit: 10_000 })).not.toThrow();
    store.close();
  });

  it("includes a project when the same request pushes over one page of assigned fragments", () => {
    const store = SyncStore.open();
    const result = send(store, {
      limit: 500,
      projects: [push(project("p1", "A book"))],
      fragments: Array.from({ length: 501 }, (_, i) =>
        push({ ...fragment(`f${i}`, `note ${i}`), projectId: "p1" }),
      ),
    });
    expect(result.projects.map((p) => p.record.id)).toEqual(["p1"]);
    expect(result.fragments.length).toBeGreaterThan(0);
    store.close();
  });
});

describe("accounts", () => {
  it("never shows one account another's writing", () => {
    const store = SyncStore.open();
    send(store, { account: "acct-1", fragments: [push(fragment("f1", "mine"))] });
    send(store, { account: "acct-2", fragments: [push(fragment("f2", "theirs"))] });

    const mine = send(store, { account: "acct-1", since: 0 });
    expect(mine.fragments.map((r) => r.record.text)).toEqual(["mine"]);
    store.close();
  });

  it("keeps separate cursors, so one account's writes do not skip another's", () => {
    const store = SyncStore.open();
    send(store, { account: "acct-1", fragments: [push(fragment("f1", "mine"))] });
    for (let i = 0; i < 5; i++) {
      send(store, { account: "acct-2", fragments: [push(fragment(`x${i}`, "theirs"))] });
    }

    // acct-1 was at its own head before acct-2 wrote anything; it must still see
    // nothing new, and must not have been advanced past its own record.
    const mine = send(store, { account: "acct-1", since: 0 });
    expect(mine.fragments).toHaveLength(1);
    store.close();
  });

  it("lets the same id exist independently in two accounts", () => {
    const store = SyncStore.open();
    send(store, { account: "acct-1", fragments: [push(fragment("shared-id", "mine"))] });
    const theirs = send(store, {
      account: "acct-2",
      fragments: [push(fragment("shared-id", "theirs"))],
    });

    expect(theirs.accepted).toEqual({ "shared-id": 1 });
    expect(send(store, { account: "acct-1", since: 0 }).fragments[0]?.record.text).toBe("mine");
    store.close();
  });

  it("forgets an account completely when asked", () => {
    // A user who turns sync off and finds their notes still on our disk has
    // been lied to.
    const store = SyncStore.open();
    send(store, {
      fragments: [push(fragment("f1", "a note"))],
      projects: [push(project("p1", "A book"))],
    });
    expect(store.counts(ACCOUNT)).toEqual({ fragments: 1, projects: 1 });

    store.forget(ACCOUNT);
    expect(store.counts(ACCOUNT)).toEqual({ fragments: 0, projects: 0 });
    expect(store.head(ACCOUNT)).toBe(0);
    store.close();
  });

  it("forgets one account without touching another", () => {
    const store = SyncStore.open();
    send(store, { account: "acct-1", fragments: [push(fragment("f1", "mine"))] });
    send(store, { account: "acct-2", fragments: [push(fragment("f2", "theirs"))] });

    store.forget("acct-1");
    expect(store.counts("acct-2").fragments).toBe(1);
    store.close();
  });
});

describe("durability", () => {
  it("keeps an account's notebook across a process restart", () => {
    const path = `${process.env.TMPDIR ?? "/tmp"}/loom-sync-test-${Date.now()}.db`;
    const first = SyncStore.open(path);
    const pushed = send(first, { fragments: [push(fragment("f1", "a note"))] });
    first.close();

    const second = SyncStore.open(path);
    const pulled = second.sync(ACCOUNT, { since: null, ...empty });
    expect(pulled.fragments[0]?.record.text).toBe("a note");
    // The counter must not restart, or two records would share a sequence and a
    // client would skip one of them forever.
    expect(second.head(ACCOUNT)).toBe(pushed.cursor);
    second.close();
  });
});
